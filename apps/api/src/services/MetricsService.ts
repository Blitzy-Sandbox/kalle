/**
 * MetricsService — Prometheus-compatible metrics collection using OpenTelemetry SDK.
 *
 * Collects and exports application-level metric instrumentation for:
 * - HTTP request count, latency histograms, and active request gauges
 * - WebSocket connection counts and message throughput
 * - BullMQ job processing counts, duration, and queue depth
 * - Database query latency percentiles and active connections
 *
 * Metrics are exposed in Prometheus text exposition format via the
 * /api/v1/metrics endpoint (per R37).
 *
 * Architecture constraints:
 * - R37: Prometheus-compatible metrics endpoint
 * - R28: Zero console.log — structured logging only
 * - R7:  Zero warnings build under strict TypeScript
 *
 * @module MetricsService
 */

import { MeterProvider } from '@opentelemetry/sdk-metrics';
import {
  PrometheusExporter,
  PrometheusSerializer,
} from '@opentelemetry/exporter-prometheus';
import { metrics } from '@opentelemetry/api';
import type {
  Meter,
  Counter,
  Histogram,
  UpDownCounter,
} from '@opentelemetry/api';

/**
 * Parameter shape for recording an HTTP request metric.
 */
interface HttpRequestParams {
  /** HTTP method (GET, POST, PUT, DELETE, etc.) */
  method: string;
  /** Matched route pattern (e.g., /api/v1/users/:id) */
  route: string;
  /** HTTP response status code */
  statusCode: number;
  /** Request duration in milliseconds */
  durationMs: number;
}

/**
 * Parameter shape for recording a BullMQ job metric.
 */
interface BullmqJobParams {
  /** Job processor name (e.g., message-fanout, link-preview) */
  jobName: string;
  /** Terminal job status (completed or failed) */
  status: string;
  /** Job processing duration in milliseconds */
  durationMs: number;
}

/**
 * Parameter shape for recording a database query metric.
 */
interface DbQueryParams {
  /** Prisma operation type (findMany, create, update, delete) */
  operation: string;
  /** Query execution duration in milliseconds */
  durationMs: number;
}

/**
 * MetricsService collects and exports Prometheus-compatible metrics
 * using the OpenTelemetry SDK.
 *
 * This service self-initializes on construction with no external dependencies.
 * It creates a MeterProvider with a PrometheusExporter as the metric reader,
 * then registers all application-level metric instruments. Recording methods
 * accept typed parameter objects and delegate to the appropriate instruments.
 *
 * The getMetrics() method serializes all collected metrics into Prometheus
 * text exposition format for the /api/v1/metrics endpoint.
 *
 * The getExporter() method returns the PrometheusExporter instance so the
 * Express app can mount its built-in request handler if needed.
 *
 * @example
 * ```typescript
 * const metrics = new MetricsService();
 *
 * // Record an HTTP request
 * metrics.recordHttpRequest({
 *   method: 'GET',
 *   route: '/api/v1/users',
 *   statusCode: 200,
 *   durationMs: 42.5,
 * });
 *
 * // Get Prometheus-format metrics
 * const text = await metrics.getMetrics();
 * ```
 */
export class MetricsService {
  /**
   * OpenTelemetry Meter instance used to create all metric instruments.
   * Obtained from the MeterProvider scoped to the kalle-api application.
   */
  private readonly meter: Meter;

  /**
   * PrometheusExporter instance serving as the MetricReader for the
   * MeterProvider. Configured with preventServerStart=true so it does
   * not open its own HTTP server — we integrate it into the Express app.
   */
  private readonly exporter: PrometheusExporter;

  /**
   * PrometheusSerializer converts collected ResourceMetrics into
   * Prometheus text exposition format strings.
   */
  private readonly serializer: PrometheusSerializer;

  // ── HTTP Metrics ────────────────────────────────────────────────

  /**
   * Total number of HTTP requests processed.
   * Labels: method, route, status_code
   */
  public readonly httpRequestsTotal: Counter;

  /**
   * HTTP request duration in seconds.
   * Labels: method, route, status_code
   * Buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
   */
  public readonly httpRequestDuration: Histogram;

  /**
   * Number of currently active (in-flight) HTTP requests.
   * Incremented on request start, decremented on response finish.
   */
  public readonly httpActiveRequests: UpDownCounter;

  // ── WebSocket Metrics ───────────────────────────────────────────

  /**
   * Total number of WebSocket connection events.
   * Labels: event (connect | disconnect)
   */
  public readonly wsConnectionsTotal: Counter;

  /**
   * Number of currently active WebSocket connections.
   * Incremented on connect, decremented on disconnect.
   */
  public readonly wsActiveConnections: UpDownCounter;

  /**
   * Total number of WebSocket messages processed.
   * Labels: event_type (message:send, typing:start, etc.)
   */
  public readonly wsMessagesTotal: Counter;

  // ── BullMQ Metrics ──────────────────────────────────────────────

  /**
   * Total number of BullMQ jobs processed.
   * Labels: job_name, status (completed | failed)
   */
  public readonly bullmqJobsTotal: Counter;

  /**
   * BullMQ job processing duration in seconds.
   * Labels: job_name
   * Buckets: [0.1, 0.5, 1, 5, 10, 30, 60]
   */
  public readonly bullmqJobDuration: Histogram;

  /**
   * Current depth of BullMQ queues (number of waiting jobs).
   * Labels: job_name
   */
  public readonly bullmqQueueDepth: UpDownCounter;

  // ── Database Metrics ────────────────────────────────────────────

  /**
   * Database query duration in seconds.
   * Labels: operation (findMany, create, update, delete)
   * Buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]
   */
  public readonly dbQueryDuration: Histogram;

  /**
   * Number of currently active database connections in the pool.
   */
  public readonly dbActiveConnections: UpDownCounter;

  /**
   * Construct a new MetricsService.
   *
   * Self-initializes the OpenTelemetry MeterProvider with a PrometheusExporter
   * and registers all application metric instruments. No external dependencies
   * are required — the service is fully operational after construction.
   */
  constructor() {
    // Initialize PrometheusExporter configured to NOT start its own HTTP server.
    // The Express application mounts the exporter's request handler on /api/v1/metrics.
    this.exporter = new PrometheusExporter({
      preventServerStart: true,
    });

    // Initialize the Prometheus text serializer for getMetrics().
    this.serializer = new PrometheusSerializer();

    // Create the MeterProvider with the exporter registered as a metric reader.
    // Using the `readers` constructor option (NOT the deprecated addMetricReader method).
    const meterProvider = new MeterProvider({
      readers: [this.exporter],
    });

    // Register this MeterProvider as the global provider so that any code using
    // the OpenTelemetry Metrics API (e.g., `metrics.getMeter()`) connects to the
    // same PrometheusExporter. This ensures all instruments — whether created here
    // or in middleware/handlers — export data to the Prometheus scrape endpoint.
    metrics.setGlobalMeterProvider(meterProvider);

    // Obtain a Meter scoped to this application for creating instruments.
    this.meter = meterProvider.getMeter('kalle-api', '1.0.0');

    // ── Register HTTP Metric Instruments ─────────────────────────

    this.httpRequestsTotal = this.meter.createCounter('http_requests_total', {
      description: 'Total number of HTTP requests processed',
      unit: '1',
    });

    this.httpRequestDuration = this.meter.createHistogram(
      'http_request_duration_seconds',
      {
        description: 'HTTP request duration in seconds',
        unit: 's',
        advice: {
          explicitBucketBoundaries: [
            0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
          ],
        },
      },
    );

    this.httpActiveRequests = this.meter.createUpDownCounter(
      'http_active_requests',
      {
        description: 'Number of currently active HTTP requests',
        unit: '1',
      },
    );

    // ── Register WebSocket Metric Instruments ────────────────────

    this.wsConnectionsTotal = this.meter.createCounter('ws_connections_total', {
      description: 'Total number of WebSocket connection events',
      unit: '1',
    });

    this.wsActiveConnections = this.meter.createUpDownCounter(
      'ws_active_connections',
      {
        description: 'Number of currently active WebSocket connections',
        unit: '1',
      },
    );

    this.wsMessagesTotal = this.meter.createCounter('ws_messages_total', {
      description: 'Total number of WebSocket messages processed',
      unit: '1',
    });

    // ── Register BullMQ Metric Instruments ───────────────────────

    this.bullmqJobsTotal = this.meter.createCounter('bullmq_jobs_total', {
      description: 'Total number of BullMQ jobs processed',
      unit: '1',
    });

    this.bullmqJobDuration = this.meter.createHistogram(
      'bullmq_job_duration_seconds',
      {
        description: 'BullMQ job processing duration in seconds',
        unit: 's',
        advice: {
          explicitBucketBoundaries: [0.1, 0.5, 1, 5, 10, 30, 60],
        },
      },
    );

    this.bullmqQueueDepth = this.meter.createUpDownCounter(
      'bullmq_queue_depth',
      {
        description: 'Current depth of BullMQ queues',
        unit: '1',
      },
    );

    // ── Register Database Metric Instruments ─────────────────────

    this.dbQueryDuration = this.meter.createHistogram(
      'db_query_duration_seconds',
      {
        description: 'Database query duration in seconds',
        unit: 's',
        advice: {
          explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
        },
      },
    );

    this.dbActiveConnections = this.meter.createUpDownCounter(
      'db_active_connections',
      {
        description: 'Number of currently active database connections',
        unit: '1',
      },
    );
  }

  /**
   * Collect and return all registered metrics in Prometheus text exposition format.
   *
   * This method triggers a collection cycle on the PrometheusExporter, gathers
   * all metric data points, and serializes them using the PrometheusSerializer
   * into the standard text-based format expected by Prometheus scrapers.
   *
   * Called by HealthController for the GET /api/v1/metrics endpoint.
   * Response content-type should be: text/plain; version=0.0.4; charset=utf-8
   *
   * @returns Prometheus text exposition format string containing all metrics.
   */
  public async getMetrics(): Promise<string> {
    const collectionResult = await this.exporter.collect();
    return this.serializer.serialize(collectionResult.resourceMetrics);
  }

  /**
   * Return the PrometheusExporter instance.
   *
   * Provides access to the exporter so the Express application can mount
   * the built-in getMetricsRequestHandler() on the /api/v1/metrics route
   * as an alternative to using getMetrics() directly.
   *
   * @returns The PrometheusExporter used by this service.
   */
  public getExporter(): PrometheusExporter {
    return this.exporter;
  }

  /**
   * Record metrics for a completed HTTP request.
   *
   * Increments the total request counter with method/route/status labels
   * and records the request duration in the histogram (converting from
   * milliseconds to seconds for Prometheus conventions).
   *
   * @param params - HTTP request parameters including method, route, statusCode, and durationMs.
   */
  public recordHttpRequest(params: HttpRequestParams): void {
    const attributes = {
      method: params.method,
      route: params.route,
      status_code: String(params.statusCode),
    };

    this.httpRequestsTotal.add(1, attributes);
    this.httpRequestDuration.record(params.durationMs / 1000, attributes);
  }

  /**
   * Record a new WebSocket connection.
   *
   * Increments the total connection counter with event=connect label
   * and increases the active connections gauge by 1.
   */
  public recordWsConnection(): void {
    this.wsConnectionsTotal.add(1, { event: 'connect' });
    this.wsActiveConnections.add(1);
  }

  /**
   * Record a WebSocket disconnection.
   *
   * Increments the total connection counter with event=disconnect label
   * and decreases the active connections gauge by 1.
   */
  public recordWsDisconnection(): void {
    this.wsConnectionsTotal.add(1, { event: 'disconnect' });
    this.wsActiveConnections.add(-1);
  }

  /**
   * Record a WebSocket message event.
   *
   * Increments the total messages counter with the given event type label,
   * tracking throughput per event type (message:send, typing:start, etc.).
   *
   * @param eventType - The WebSocket event type identifier.
   */
  public recordWsMessage(eventType: string): void {
    this.wsMessagesTotal.add(1, { event_type: eventType });
  }

  /**
   * Record a completed BullMQ job.
   *
   * Increments the total jobs counter with job_name/status labels and
   * records the job processing duration in the histogram (converting
   * from milliseconds to seconds).
   *
   * @param params - BullMQ job parameters including jobName, status, and durationMs.
   */
  public recordBullmqJob(params: BullmqJobParams): void {
    const attributes = {
      job_name: params.jobName,
      status: params.status,
    };

    this.bullmqJobsTotal.add(1, attributes);
    this.bullmqJobDuration.record(params.durationMs / 1000, {
      job_name: params.jobName,
    });
  }

  /**
   * Record a database query execution.
   *
   * Records the query duration in the histogram with the operation label,
   * converting from milliseconds to seconds for Prometheus conventions.
   *
   * @param params - Database query parameters including operation and durationMs.
   */
  public recordDbQuery(params: DbQueryParams): void {
    this.dbQueryDuration.record(params.durationMs / 1000, {
      operation: params.operation,
    });
  }
}
