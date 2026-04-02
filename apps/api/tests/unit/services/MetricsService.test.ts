/**
 * Unit tests for MetricsService — Prometheus-compatible metrics collection
 * using the OpenTelemetry SDK.
 *
 * MetricsService has zero constructor dependencies (self-initializes).
 * We mock the OpenTelemetry SDK modules at the module level to prevent
 * real MeterProvider / PrometheusExporter initialisation during tests.
 *
 * Architecture rules validated:
 *  - R37: All 4 metric categories (HTTP, WebSocket, BullMQ, Database) are instrumented
 *  - R28: Zero console.log in service and tests (structured logging only)
 *  - R7:  TypeScript strict mode, zero warnings
 *
 * @module MetricsService.test
 */

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Module-level mocks — MUST appear before the import of the subject under
 *    test so that Jest's module registry intercepts the requires inside
 *    MetricsService's constructor.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Mock counter — records `add` invocations so we can assert the service
 * delegates to the correct instruments with correct attributes.
 */
const mockCounterAdd = jest.fn();
const mockCounter = { add: mockCounterAdd };

/**
 * Mock histogram — records `record` invocations.
 */
const mockHistogramRecord = jest.fn();
const mockHistogram = { record: mockHistogramRecord };

/**
 * Mock up-down counter — records `add` invocations (positive & negative).
 */
const mockUpDownCounterAdd = jest.fn();
const mockUpDownCounter = { add: mockUpDownCounterAdd };

/**
 * Mock Meter — factory returned by MeterProvider.getMeter().
 * Returns the appropriate mock instrument for each creation method.
 */
const mockCreateCounter = jest.fn().mockReturnValue(mockCounter);
const mockCreateHistogram = jest.fn().mockReturnValue(mockHistogram);
const mockCreateUpDownCounter = jest.fn().mockReturnValue(mockUpDownCounter);
const mockGetMeter = jest.fn().mockReturnValue({
  createCounter: mockCreateCounter,
  createHistogram: mockCreateHistogram,
  createUpDownCounter: mockCreateUpDownCounter,
});

/**
 * Mock MeterProvider.
 * - Constructor captures the config for verification.
 * - getMeter() returns the mock meter.
 */
const MockMeterProvider = jest.fn().mockImplementation(() => ({
  getMeter: mockGetMeter,
}));

jest.mock('@opentelemetry/sdk-metrics', () => ({
  MeterProvider: MockMeterProvider,
}));

/**
 * Mock PrometheusExporter whose `collect()` returns a minimal
 * ResourceMetrics structure that the serializer can consume.
 */
const mockCollect = jest.fn().mockResolvedValue({
  resourceMetrics: {
    resource: {},
    scopeMetrics: [],
  },
});

const MockPrometheusExporter = jest.fn().mockImplementation(() => ({
  collect: mockCollect,
}));

/**
 * Mock PrometheusSerializer whose `serialize()` returns a deterministic
 * Prometheus-text string.
 */
const mockSerialize = jest.fn().mockReturnValue(
  '# HELP http_requests_total Total number of HTTP requests processed\n' +
    '# TYPE http_requests_total counter\n',
);
const MockPrometheusSerializer = jest.fn().mockImplementation(() => ({
  serialize: mockSerialize,
}));

jest.mock('@opentelemetry/exporter-prometheus', () => ({
  PrometheusExporter: MockPrometheusExporter,
  PrometheusSerializer: MockPrometheusSerializer,
}));

/**
 * Mock the OpenTelemetry global API to intercept `metrics.setGlobalMeterProvider`.
 * The service calls this during construction — we just need to ensure it does
 * not throw, and we can verify it was called.
 */
const mockSetGlobalMeterProvider = jest.fn();
jest.mock('@opentelemetry/api', () => ({
  metrics: {
    setGlobalMeterProvider: mockSetGlobalMeterProvider,
  },
}));

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Import the subject under test — AFTER all mocks are in place.
 * ──────────────────────────────────────────────────────────────────────────── */

import { MetricsService } from '../../../src/services/MetricsService';

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Test Suite
 * ──────────────────────────────────────────────────────────────────────────── */

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MetricsService();
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Constructor Tests                                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  describe('constructor', () => {
    it('should initialize without errors', () => {
      expect(() => new MetricsService()).not.toThrow();
    });

    it('should create a PrometheusExporter with preventServerStart=true', () => {
      expect(MockPrometheusExporter).toHaveBeenCalledWith(
        expect.objectContaining({ preventServerStart: true }),
      );
    });

    it('should create a PrometheusSerializer', () => {
      expect(MockPrometheusSerializer).toHaveBeenCalled();
    });

    it('should create a MeterProvider with the exporter as a reader', () => {
      expect(MockMeterProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          readers: expect.arrayContaining([expect.any(Object)]),
        }),
      );
    });

    it('should register the MeterProvider as global meter provider', () => {
      expect(mockSetGlobalMeterProvider).toHaveBeenCalledTimes(1);
    });

    it('should obtain a Meter scoped to kalle-api', () => {
      expect(mockGetMeter).toHaveBeenCalledWith('kalle-api', '1.0.0');
    });

    it('should create all metric instruments', () => {
      // Verify the exact set of instruments created corresponds to 4 categories

      // HTTP: 1 counter, 1 histogram, 1 up-down counter
      // WS:   2 counters, 1 up-down counter
      // Bull: 1 counter, 1 histogram, 1 up-down counter
      // DB:   1 histogram, 1 up-down counter
      // Totals: 4 counters, 3 histograms, 4 up-down counters

      expect(mockCreateCounter).toHaveBeenCalledTimes(4);
      expect(mockCreateHistogram).toHaveBeenCalledTimes(3);
      expect(mockCreateUpDownCounter).toHaveBeenCalledTimes(4);
    });

    it('should expose all HTTP metric instrument properties', () => {
      expect(service.httpRequestsTotal).toBeDefined();
      expect(service.httpRequestDuration).toBeDefined();
      expect(service.httpActiveRequests).toBeDefined();
    });

    it('should expose all WebSocket metric instrument properties', () => {
      expect(service.wsConnectionsTotal).toBeDefined();
      expect(service.wsActiveConnections).toBeDefined();
      expect(service.wsMessagesTotal).toBeDefined();
    });

    it('should expose all BullMQ metric instrument properties', () => {
      expect(service.bullmqJobsTotal).toBeDefined();
      expect(service.bullmqJobDuration).toBeDefined();
      expect(service.bullmqQueueDepth).toBeDefined();
    });

    it('should expose all Database metric instrument properties', () => {
      expect(service.dbQueryDuration).toBeDefined();
      expect(service.dbActiveConnections).toBeDefined();
    });
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Metric Name Conventions (R37)                                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  describe('metric name conventions (R37)', () => {
    it('should name HTTP counter with _total suffix', () => {
      expect(mockCreateCounter).toHaveBeenCalledWith(
        'http_requests_total',
        expect.any(Object),
      );
    });

    it('should name HTTP duration histogram with _seconds suffix', () => {
      expect(mockCreateHistogram).toHaveBeenCalledWith(
        'http_request_duration_seconds',
        expect.any(Object),
      );
    });

    it('should name HTTP active requests gauge in snake_case', () => {
      expect(mockCreateUpDownCounter).toHaveBeenCalledWith(
        'http_active_requests',
        expect.any(Object),
      );
    });

    it('should name WebSocket counters with _total suffix', () => {
      expect(mockCreateCounter).toHaveBeenCalledWith(
        'ws_connections_total',
        expect.any(Object),
      );
      expect(mockCreateCounter).toHaveBeenCalledWith(
        'ws_messages_total',
        expect.any(Object),
      );
    });

    it('should name BullMQ counter with _total suffix', () => {
      expect(mockCreateCounter).toHaveBeenCalledWith(
        'bullmq_jobs_total',
        expect.any(Object),
      );
    });

    it('should name BullMQ duration histogram with _seconds suffix', () => {
      expect(mockCreateHistogram).toHaveBeenCalledWith(
        'bullmq_job_duration_seconds',
        expect.any(Object),
      );
    });

    it('should name database duration histogram with _seconds suffix', () => {
      expect(mockCreateHistogram).toHaveBeenCalledWith(
        'db_query_duration_seconds',
        expect.any(Object),
      );
    });

    it('should name database active connections gauge in snake_case', () => {
      expect(mockCreateUpDownCounter).toHaveBeenCalledWith(
        'db_active_connections',
        expect.any(Object),
      );
    });
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  recordHttpRequest                                                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  describe('recordHttpRequest', () => {
    it('should record an HTTP request metric without error', () => {
      expect(() =>
        service.recordHttpRequest({
          method: 'GET',
          route: '/api/v1/health',
          statusCode: 200,
          durationMs: 15,
        }),
      ).not.toThrow();
    });

    it('should increment the total counter with correct attributes', () => {
      service.recordHttpRequest({
        method: 'GET',
        route: '/api/v1/health',
        statusCode: 200,
        durationMs: 15,
      });

      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        method: 'GET',
        route: '/api/v1/health',
        status_code: '200',
      });
    });

    it('should record duration in seconds (converting from milliseconds)', () => {
      service.recordHttpRequest({
        method: 'POST',
        route: '/api/v1/messages',
        statusCode: 201,
        durationMs: 250,
      });

      expect(mockHistogramRecord).toHaveBeenCalledWith(0.25, {
        method: 'POST',
        route: '/api/v1/messages',
        status_code: '201',
      });
    });

    it('should accept various HTTP methods and status codes', () => {
      const testCases = [
        { method: 'POST', route: '/api/v1/auth/register', statusCode: 201, durationMs: 100 },
        { method: 'PUT', route: '/api/v1/users/profile', statusCode: 200, durationMs: 50 },
        { method: 'DELETE', route: '/api/v1/messages/123', statusCode: 200, durationMs: 30 },
        { method: 'GET', route: '/api/v1/conversations', statusCode: 400, durationMs: 5 },
        { method: 'GET', route: '/api/v1/users/999', statusCode: 404, durationMs: 8 },
        { method: 'POST', route: '/api/v1/media', statusCode: 500, durationMs: 1200 },
      ];

      for (const params of testCases) {
        expect(() => service.recordHttpRequest(params)).not.toThrow();
      }

      // All invocations: 6 counter.add + 6 histogram.record (plus the beforeEach reset counts)
      expect(mockCounterAdd).toHaveBeenCalledTimes(6);
      expect(mockHistogramRecord).toHaveBeenCalledTimes(6);
    });

    it('should convert statusCode to a string label', () => {
      service.recordHttpRequest({
        method: 'GET',
        route: '/api/v1/health',
        statusCode: 404,
        durationMs: 3,
      });

      expect(mockCounterAdd).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ status_code: '404' }),
      );
    });

    it('should handle zero-duration requests', () => {
      expect(() =>
        service.recordHttpRequest({
          method: 'GET',
          route: '/api/v1/health',
          statusCode: 200,
          durationMs: 0,
        }),
      ).not.toThrow();

      expect(mockHistogramRecord).toHaveBeenCalledWith(0, expect.any(Object));
    });

    it('should handle very large durations', () => {
      expect(() =>
        service.recordHttpRequest({
          method: 'POST',
          route: '/api/v1/upload',
          statusCode: 200,
          durationMs: 60000,
        }),
      ).not.toThrow();

      expect(mockHistogramRecord).toHaveBeenCalledWith(60, expect.any(Object));
    });
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  recordWsConnection / recordWsDisconnection                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  describe('recordWsConnection', () => {
    it('should record WebSocket connection without error', () => {
      expect(() => service.recordWsConnection()).not.toThrow();
    });

    it('should increment connections counter with event=connect', () => {
      service.recordWsConnection();

      expect(mockCounterAdd).toHaveBeenCalledWith(1, { event: 'connect' });
    });

    it('should increment the active connections gauge', () => {
      service.recordWsConnection();

      expect(mockUpDownCounterAdd).toHaveBeenCalledWith(1);
    });

    it('should handle multiple connections', () => {
      service.recordWsConnection();
      service.recordWsConnection();
      service.recordWsConnection();

      expect(mockCounterAdd).toHaveBeenCalledTimes(3);
      expect(mockUpDownCounterAdd).toHaveBeenCalledTimes(3);
    });
  });

  describe('recordWsDisconnection', () => {
    it('should record WebSocket disconnection without error', () => {
      expect(() => service.recordWsDisconnection()).not.toThrow();
    });

    it('should increment connections counter with event=disconnect', () => {
      service.recordWsDisconnection();

      expect(mockCounterAdd).toHaveBeenCalledWith(1, { event: 'disconnect' });
    });

    it('should decrement the active connections gauge', () => {
      service.recordWsDisconnection();

      expect(mockUpDownCounterAdd).toHaveBeenCalledWith(-1);
    });

    it('should handle multiple disconnections', () => {
      service.recordWsDisconnection();
      service.recordWsDisconnection();

      // 2 counter.add calls (disconnect events) + 2 updown.add calls (decrements)
      expect(mockCounterAdd).toHaveBeenCalledTimes(2);
      expect(mockUpDownCounterAdd).toHaveBeenCalledTimes(2);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  recordWsMessage                                                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  describe('recordWsMessage', () => {
    it('should record a WebSocket message metric without error', () => {
      expect(() => service.recordWsMessage('message:send')).not.toThrow();
    });

    it('should increment the messages counter with correct event_type', () => {
      service.recordWsMessage('message:send');

      expect(mockCounterAdd).toHaveBeenCalledWith(1, { event_type: 'message:send' });
    });

    it('should accept various event types', () => {
      const eventTypes = [
        'typing:start',
        'typing:stop',
        'user:presence',
        'message:sync',
        'message:delivered',
        'message:read',
        'message:edited',
        'message:deleted',
      ];

      for (const eventType of eventTypes) {
        service.recordWsMessage(eventType);
      }

      expect(mockCounterAdd).toHaveBeenCalledTimes(eventTypes.length);

      for (const eventType of eventTypes) {
        expect(mockCounterAdd).toHaveBeenCalledWith(1, { event_type: eventType });
      }
    });
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  recordBullmqJob                                                         */
  /* ──────────────────────────────────────────────────────────────────────── */

  describe('recordBullmqJob', () => {
    it('should record a BullMQ job metric without error', () => {
      expect(() =>
        service.recordBullmqJob({
          jobName: 'message-fanout',
          status: 'completed',
          durationMs: 150,
        }),
      ).not.toThrow();
    });

    it('should increment jobs counter with correct attributes', () => {
      service.recordBullmqJob({
        jobName: 'message-fanout',
        status: 'completed',
        durationMs: 150,
      });

      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        job_name: 'message-fanout',
        status: 'completed',
      });
    });

    it('should record duration in seconds (converting from milliseconds)', () => {
      service.recordBullmqJob({
        jobName: 'link-preview',
        status: 'completed',
        durationMs: 3200,
      });

      expect(mockHistogramRecord).toHaveBeenCalledWith(3.2, {
        job_name: 'link-preview',
      });
    });

    it('should record failed job metrics', () => {
      service.recordBullmqJob({
        jobName: 'sender-key-distribution',
        status: 'failed',
        durationMs: 500,
      });

      expect(mockCounterAdd).toHaveBeenCalledWith(1, {
        job_name: 'sender-key-distribution',
        status: 'failed',
      });

      expect(mockHistogramRecord).toHaveBeenCalledWith(0.5, {
        job_name: 'sender-key-distribution',
      });
    });

    it('should accept various job names', () => {
      const jobNames = [
        'message-fanout',
        'sender-key-distribution',
        'link-preview',
        'story-cleanup',
        'audit-log-cleanup',
        'prekey-replenish-notification',
      ];

      for (const jobName of jobNames) {
        service.recordBullmqJob({
          jobName,
          status: 'completed',
          durationMs: 100,
        });
      }

      expect(mockCounterAdd).toHaveBeenCalledTimes(jobNames.length);
      expect(mockHistogramRecord).toHaveBeenCalledTimes(jobNames.length);
    });

    it('should handle zero-duration jobs', () => {
      expect(() =>
        service.recordBullmqJob({
          jobName: 'message-fanout',
          status: 'completed',
          durationMs: 0,
        }),
      ).not.toThrow();

      expect(mockHistogramRecord).toHaveBeenCalledWith(0, expect.any(Object));
    });
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  recordDbQuery                                                           */
  /* ──────────────────────────────────────────────────────────────────────── */

  describe('recordDbQuery', () => {
    it('should record a database query metric without error', () => {
      expect(() =>
        service.recordDbQuery({ operation: 'findMany', durationMs: 5 }),
      ).not.toThrow();
    });

    it('should record duration in seconds with correct operation label', () => {
      service.recordDbQuery({ operation: 'findMany', durationMs: 50 });

      expect(mockHistogramRecord).toHaveBeenCalledWith(0.05, {
        operation: 'findMany',
      });
    });

    it('should accept various operations', () => {
      const operations = ['create', 'update', 'delete', 'findUnique', 'findFirst', 'count'];

      for (const operation of operations) {
        service.recordDbQuery({ operation, durationMs: 10 });
      }

      expect(mockHistogramRecord).toHaveBeenCalledTimes(operations.length);

      for (const operation of operations) {
        expect(mockHistogramRecord).toHaveBeenCalledWith(0.01, { operation });
      }
    });

    it('should handle sub-millisecond durations', () => {
      service.recordDbQuery({ operation: 'findUnique', durationMs: 0.5 });

      expect(mockHistogramRecord).toHaveBeenCalledWith(0.0005, {
        operation: 'findUnique',
      });
    });

    it('should handle large durations for slow queries', () => {
      expect(() =>
        service.recordDbQuery({ operation: 'findMany', durationMs: 30000 }),
      ).not.toThrow();

      expect(mockHistogramRecord).toHaveBeenCalledWith(30, {
        operation: 'findMany',
      });
    });
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  getMetrics                                                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  describe('getMetrics', () => {
    it('should return metrics as a string', async () => {
      const result = await service.getMetrics();

      expect(typeof result).toBe('string');
    });

    it('should call exporter.collect() to gather metric data', async () => {
      await service.getMetrics();

      expect(mockCollect).toHaveBeenCalledTimes(1);
    });

    it('should call serializer.serialize() with the collected resource metrics', async () => {
      await service.getMetrics();

      expect(mockSerialize).toHaveBeenCalledTimes(1);
      expect(mockSerialize).toHaveBeenCalledWith({
        resource: {},
        scopeMetrics: [],
      });
    });

    it('should return Prometheus-compatible format string', async () => {
      const result = await service.getMetrics();

      expect(result).toContain('# HELP');
      expect(result).toContain('# TYPE');
      expect(result).toContain('http_requests_total');
    });

    it('should return a promise that resolves to a string', () => {
      const result = service.getMetrics();

      expect(result).toBeInstanceOf(Promise);
    });

    it('should propagate collection errors', async () => {
      const collectionError = new Error('Collection failed');
      mockCollect.mockRejectedValueOnce(collectionError);

      await expect(service.getMetrics()).rejects.toThrow('Collection failed');
    });
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  getExporter                                                             */
  /* ──────────────────────────────────────────────────────────────────────── */

  describe('getExporter', () => {
    it('should return the PrometheusExporter instance', () => {
      const exporter = service.getExporter();

      expect(exporter).toBeDefined();
      expect(exporter).not.toBeNull();
    });

    it('should return an object with a collect method', () => {
      const exporter = service.getExporter();

      expect(typeof exporter.collect).toBe('function');
    });

    it('should return the same exporter instance on multiple calls', () => {
      const exporter1 = service.getExporter();
      const exporter2 = service.getExporter();

      expect(exporter1).toBe(exporter2);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  R37 — Four Metric Categories Coverage Verification                     */
  /* ──────────────────────────────────────────────────────────────────────── */

  describe('R37 — metric categories coverage', () => {
    it('should register HTTP metric instruments', () => {
      expect(mockCreateCounter).toHaveBeenCalledWith(
        'http_requests_total',
        expect.any(Object),
      );
      expect(mockCreateHistogram).toHaveBeenCalledWith(
        'http_request_duration_seconds',
        expect.any(Object),
      );
      expect(mockCreateUpDownCounter).toHaveBeenCalledWith(
        'http_active_requests',
        expect.any(Object),
      );
    });

    it('should register WebSocket metric instruments', () => {
      expect(mockCreateCounter).toHaveBeenCalledWith(
        'ws_connections_total',
        expect.any(Object),
      );
      expect(mockCreateUpDownCounter).toHaveBeenCalledWith(
        'ws_active_connections',
        expect.any(Object),
      );
      expect(mockCreateCounter).toHaveBeenCalledWith(
        'ws_messages_total',
        expect.any(Object),
      );
    });

    it('should register BullMQ metric instruments', () => {
      expect(mockCreateCounter).toHaveBeenCalledWith(
        'bullmq_jobs_total',
        expect.any(Object),
      );
      expect(mockCreateHistogram).toHaveBeenCalledWith(
        'bullmq_job_duration_seconds',
        expect.any(Object),
      );
      expect(mockCreateUpDownCounter).toHaveBeenCalledWith(
        'bullmq_queue_depth',
        expect.any(Object),
      );
    });

    it('should register Database metric instruments', () => {
      expect(mockCreateHistogram).toHaveBeenCalledWith(
        'db_query_duration_seconds',
        expect.any(Object),
      );
      expect(mockCreateUpDownCounter).toHaveBeenCalledWith(
        'db_active_connections',
        expect.any(Object),
      );
    });

    it('should cover all 11 required metric instruments', () => {
      // Per R37 the service must expose:
      //  HTTP:  httpRequestsTotal, httpRequestDuration, httpActiveRequests  (3)
      //  WS:    wsConnectionsTotal, wsActiveConnections, wsMessagesTotal    (3)
      //  Bull:  bullmqJobsTotal, bullmqJobDuration, bullmqQueueDepth       (3)
      //  DB:    dbQueryDuration, dbActiveConnections                        (2)
      //  Total: 11 instruments
      const totalInstruments =
        mockCreateCounter.mock.calls.length +
        mockCreateHistogram.mock.calls.length +
        mockCreateUpDownCounter.mock.calls.length;

      expect(totalInstruments).toBe(11);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Integration: connection + disconnection lifecycle                       */
  /* ──────────────────────────────────────────────────────────────────────── */

  describe('WebSocket lifecycle', () => {
    it('should handle connect then disconnect sequence', () => {
      service.recordWsConnection();
      service.recordWsDisconnection();

      // Counter: 2 calls (connect + disconnect)
      expect(mockCounterAdd).toHaveBeenCalledTimes(2);

      // UpDownCounter: 2 calls (+1 for connect, -1 for disconnect)
      expect(mockUpDownCounterAdd).toHaveBeenCalledTimes(2);
      expect(mockUpDownCounterAdd).toHaveBeenCalledWith(1);
      expect(mockUpDownCounterAdd).toHaveBeenCalledWith(-1);
    });

    it('should handle multiple connect/disconnect cycles', () => {
      for (let i = 0; i < 5; i++) {
        service.recordWsConnection();
        service.recordWsMessage('message:send');
        service.recordWsDisconnection();
      }

      // 5 connect + 5 disconnect + 5 message = 15 counter add calls
      expect(mockCounterAdd).toHaveBeenCalledTimes(15);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Integration: mixed metric recording                                    */
  /* ──────────────────────────────────────────────────────────────────────── */

  describe('mixed metric recording', () => {
    it('should handle recording across all 4 categories in sequence', () => {
      // HTTP
      service.recordHttpRequest({
        method: 'GET',
        route: '/api/v1/conversations',
        statusCode: 200,
        durationMs: 45,
      });

      // WebSocket
      service.recordWsConnection();
      service.recordWsMessage('message:send');
      service.recordWsDisconnection();

      // BullMQ
      service.recordBullmqJob({
        jobName: 'message-fanout',
        status: 'completed',
        durationMs: 200,
      });

      // Database
      service.recordDbQuery({ operation: 'findMany', durationMs: 12 });

      // No errors thrown — all instruments operational
      // Counter calls: HTTP(1) + WS-connect(1) + WS-message(1) + WS-disconnect(1) + BullMQ(1) = 5
      expect(mockCounterAdd).toHaveBeenCalledTimes(5);

      // Histogram calls: HTTP-duration(1) + BullMQ-duration(1) + DB-duration(1) = 3
      expect(mockHistogramRecord).toHaveBeenCalledTimes(3);

      // UpDownCounter calls: WS-connect(+1) + WS-disconnect(-1) = 2
      expect(mockUpDownCounterAdd).toHaveBeenCalledTimes(2);
    });
  });
});
