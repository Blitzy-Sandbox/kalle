import { Request, Response, NextFunction, RequestHandler } from 'express';
import type { MetricsService } from '../services/MetricsService';

// ---------------------------------------------------------------------------
// In-Memory Active Request Tracking
// ---------------------------------------------------------------------------
// The OpenTelemetry Metrics API does not expose the current value of an
// UpDownCounter synchronously. We maintain a simple in-memory counter so
// that `getMetricsData()` can return the live active request count for use
// by MetricsService (e.g. for health check responses or custom aggregation).
// ---------------------------------------------------------------------------
let activeRequestCount = 0;

// ---------------------------------------------------------------------------
// Route Normalisation Patterns
// ---------------------------------------------------------------------------
// Path segments matching these patterns are replaced with `:id` to prevent
// high-cardinality metric labels. Without normalisation, every unique UUID
// or numeric ID in a URL would generate a distinct time series in Prometheus,
// leading to excessive memory usage and slow queries.
//
// Examples:
//   /api/v1/conversations/a1b2c3d4-e5f6-7890-abcd-ef1234567890/messages
//     → /api/v1/conversations/:id/messages
//   /api/v1/users/42
//     → /api/v1/users/:id
// ---------------------------------------------------------------------------
const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMERIC_ID_REGEX = /\/\d+(?=\/|$)/g;

/**
 * Returns a normalised route pattern suitable for use as a low-cardinality
 * Prometheus metric label.
 *
 * **Strategy:**
 * 1. If Express has matched a route (i.e. `req.route?.path` is available
 *    after route matching), use the route pattern directly — this gives the
 *    cleanest label (e.g. `/api/v1/conversations/:id/messages`).
 * 2. Otherwise, fall back to regex-based normalisation of `req.path`, which
 *    replaces UUIDs and pure-numeric path segments with `:id`.
 *
 * The `finish` event handler calls this function *after* route matching has
 * occurred, so `req.route?.path` is populated for all successfully matched
 * requests. The regex fallback handles 404s and middleware-terminated paths
 * where no route was matched.
 *
 * @param reqPath  - The raw `req.path` value (decoded URL pathname).
 * @param route    - The matched Express route object (`req.route`), if any.
 * @returns A normalised route string safe for use as a metric label.
 */
function getRoutePattern(
  reqPath: string,
  route: { path?: string } | undefined,
): string {
  if (route?.path) {
    return route.path as string;
  }
  // Reset lastIndex on the global regex before each use to guarantee
  // correct behaviour when the function is invoked repeatedly.
  UUID_REGEX.lastIndex = 0;
  return reqPath
    .replace(UUID_REGEX, ':id')
    .replace(NUMERIC_ID_REGEX, '/:id');
}

// ---------------------------------------------------------------------------
// Express Middleware Factory — createMetricsMiddleware
// ---------------------------------------------------------------------------

/**
 * Creates an Express middleware that instruments HTTP request/response cycles
 * for Prometheus-compatible metrics via the MetricsService (Rule R37).
 *
 * This factory pattern connects the middleware directly to MetricsService's
 * instruments (backed by the PrometheusExporter), ensuring all HTTP metrics
 * flow through a single MeterProvider and reach the /api/v1/metrics endpoint.
 *
 * **Metric instruments (owned by MetricsService):**
 * | Metric Name                      | Type           | Labels                       |
 * |----------------------------------|----------------|------------------------------|
 * | `http_requests_total`            | Counter        | method, route, status_code   |
 * | `http_request_duration_seconds`  | Histogram      | method, route, status_code   |
 * | `http_active_requests`           | UpDownCounter  | method                       |
 *
 * **Ordering requirement:**
 * Register this middleware after `correlationIdMiddleware` and
 * `loggerMiddleware` but *before* any route handlers:
 *
 * ```
 * app.use(correlationIdMiddleware);   // Step 7
 * app.use(pinoHttpMiddleware);        // Step 8
 * app.use(metricsMiddleware);         // Step 9  ← this middleware
 * app.use('/api/v1', v1Router);       // Step 10
 * ```
 *
 * **Implementation notes:**
 * - Uses `process.hrtime.bigint()` for nanosecond-precision timing, converted
 *   to seconds for the Prometheus histogram.
 * - Hooks into the response `finish` event to capture the complete request
 *   lifecycle duration, including all downstream middleware and route handler
 *   processing time.
 * - Route labels are normalised (UUIDs → `:id`, numeric IDs → `:id`) to
 *   prevent high-cardinality label explosion in Prometheus.
 * - All instruments are owned by MetricsService (single source of truth),
 *   eliminating duplicate instrument registration and ensuring all data
 *   reaches the PrometheusExporter.
 *
 * @param metricsService - The MetricsService instance owning all metric instruments.
 * @returns Express middleware function that instruments each HTTP request.
 */
export function createMetricsMiddleware(
  metricsService: MetricsService,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // -----------------------------------------------------------------------
    // Step 1: Record high-resolution start time for duration measurement
    // -----------------------------------------------------------------------
    const startTime = process.hrtime.bigint();

    // -----------------------------------------------------------------------
    // Step 2: Increment active request gauge
    // -----------------------------------------------------------------------
    activeRequestCount += 1;
    metricsService.httpActiveRequests.add(1, { method: req.method });

    // -----------------------------------------------------------------------
    // Step 3: Hook into the response `finish` event
    //
    // The `finish` event fires when the response has been fully written to
    // the underlying socket. This captures the complete request lifecycle,
    // including controller processing, service calls, database queries, and
    // response serialisation — not just the time until `next()` returns.
    // -----------------------------------------------------------------------
    res.on('finish', () => {
      // Compute duration in milliseconds for MetricsService
      const endTime = process.hrtime.bigint();
      const durationNs = Number(endTime - startTime);
      const durationMs = durationNs / 1e6;

      // Build normalised route pattern for low-cardinality labels
      const route = getRoutePattern(
        req.path,
        req.route as { path?: string } | undefined,
      );

      // Delegate recording to MetricsService — single source of truth
      // for all metric instruments. MetricsService handles counter increment,
      // histogram recording, and ms→s conversion internally.
      metricsService.recordHttpRequest({
        method: req.method,
        route,
        statusCode: res.statusCode,
        durationMs,
      });

      // Decrement active request gauge
      activeRequestCount -= 1;
      metricsService.httpActiveRequests.add(-1, { method: req.method });
    });

    // -----------------------------------------------------------------------
    // Step 4: Continue the middleware chain immediately — metrics recording
    // happens asynchronously via the `finish` event listener above.
    // -----------------------------------------------------------------------
    next();
  };
}

// ---------------------------------------------------------------------------
// Metrics Data Export
// ---------------------------------------------------------------------------

/**
 * Returns current runtime metrics data for consumption by `MetricsService`.
 *
 * The OpenTelemetry SDK handles full metric export to the Prometheus scrape
 * endpoint automatically. This function supplements that by providing
 * additional runtime information that `MetricsService` may need for
 * health-check responses or composite metrics aggregation.
 *
 * @returns An object containing the current count of in-flight HTTP requests.
 */
export function getMetricsData(): { activeRequests: number } {
  return {
    activeRequests: activeRequestCount,
  };
}
