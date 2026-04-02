import { Request, Response, NextFunction } from 'express';
import { metrics } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// OpenTelemetry Meter & Metric Instruments
// ---------------------------------------------------------------------------
// Obtain a Meter from the global MeterProvider registered by the OTel SDK.
//
// When the full OpenTelemetry SDK is configured (via @opentelemetry/sdk-node
// with a Prometheus exporter in MetricsService), this meter produces real
// metric data that is automatically scraped by Prometheus.
//
// When no SDK has been registered, @opentelemetry/api returns a safe no-op
// meter — all add() and record() calls become no-ops with zero overhead.
// This allows the middleware to be loaded unconditionally during boot without
// requiring the OTel SDK to be initialised first.
// ---------------------------------------------------------------------------
const meter = metrics.getMeter('kalle-api-http');

/**
 * Counter tracking the total number of completed HTTP requests.
 *
 * Prometheus metric name: `http_requests_total`
 * Labels: method, route, status_code
 */
const httpRequestCounter = meter.createCounter('http_requests_total', {
  description: 'Total number of HTTP requests',
});

/**
 * Histogram tracking HTTP request duration in seconds.
 *
 * Prometheus metric name: `http_request_duration_seconds`
 * Labels: method, route, status_code
 *
 * Duration is recorded with nanosecond precision via `process.hrtime.bigint()`
 * and converted to seconds (Prometheus convention for duration metrics).
 */
const httpRequestDuration = meter.createHistogram('http_request_duration_seconds', {
  description: 'HTTP request duration in seconds',
  unit: 's',
});

/**
 * UpDownCounter tracking the number of currently active (in-flight) HTTP
 * requests. Incremented when a request enters the middleware chain and
 * decremented when the response `finish` event fires.
 *
 * Prometheus metric name: `http_active_requests`
 * Labels: method
 */
const httpActiveRequests = meter.createUpDownCounter('http_active_requests', {
  description: 'Number of currently active HTTP requests',
});

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
// Express Middleware — metricsMiddleware
// ---------------------------------------------------------------------------

/**
 * Express middleware that instruments HTTP request/response cycles for
 * Prometheus-compatible metrics via the OpenTelemetry Metrics API (Rule R37).
 *
 * **Metric instruments:**
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
 * - When the OpenTelemetry SDK is not registered, all metric operations are
 *   safe no-ops with negligible overhead.
 *
 * @param req  - Express request; used for `method`, `path`, and `route`.
 * @param res  - Express response; used for `statusCode` and `finish` event.
 * @param next - Express next function; always invoked immediately to avoid
 *               blocking the middleware chain.
 */
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // -----------------------------------------------------------------------
  // Step 1: Record high-resolution start time for duration measurement
  // -----------------------------------------------------------------------
  const startTime = process.hrtime.bigint();

  // -----------------------------------------------------------------------
  // Step 2: Increment active request gauge
  // -----------------------------------------------------------------------
  activeRequestCount += 1;
  httpActiveRequests.add(1, { method: req.method });

  // -----------------------------------------------------------------------
  // Step 3: Hook into the response `finish` event
  //
  // The `finish` event fires when the response has been fully written to
  // the underlying socket. This captures the complete request lifecycle,
  // including controller processing, service calls, database queries, and
  // response serialisation — not just the time until `next()` returns.
  // -----------------------------------------------------------------------
  res.on('finish', () => {
    // Compute duration in seconds (Prometheus convention)
    const endTime = process.hrtime.bigint();
    const durationNs = Number(endTime - startTime);
    const durationSeconds = durationNs / 1e9;

    // Build metric labels with normalised route pattern
    const route = getRoutePattern(req.path, req.route as { path?: string } | undefined);
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };

    // Record request count (counter — monotonically increasing)
    httpRequestCounter.add(1, labels);

    // Record request duration (histogram — distribution of latencies)
    httpRequestDuration.record(durationSeconds, labels);

    // Decrement active request gauge
    activeRequestCount -= 1;
    httpActiveRequests.add(-1, { method: req.method });
  });

  // -----------------------------------------------------------------------
  // Step 4: Continue the middleware chain immediately — metrics recording
  // happens asynchronously via the `finish` event listener above.
  // -----------------------------------------------------------------------
  next();
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
