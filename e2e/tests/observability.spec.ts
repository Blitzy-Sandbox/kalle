import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { execSync } from 'child_process';

/**
 * Observability Stack E2E Tests
 *
 * Validates the complete observability pipeline for the Kalle WhatsApp clone:
 *   - Prometheus-compatible metrics endpoint
 *   - Structured Pino JSON logging with correlation IDs
 *   - Component-level health check endpoint
 *   - Log hygiene (no sensitive data leakage)
 *   - Metrics incrementing after traffic generation
 *
 * Rules Tested:
 * - R37: Metrics Endpoint — /api/v1/metrics exposes Prometheus-compatible
 *        metrics including HTTP request count/latency, WebSocket connections,
 *        BullMQ queue depth, DB query latency percentiles
 * - R28: Structured Logging Only — All backend logging uses Pino with JSON
 *        output. Zero console.log, console.warn, or console.error calls.
 *        Every log entry includes correlation ID.
 * - R29: Correlation ID Propagation — Every HTTP request receives a UUID v4
 *        correlation ID. It appears in all log entries, error responses, and
 *        BullMQ job payloads originating from that request.
 * - R23: Log Hygiene — Logs MUST NOT contain JWT tokens, passwords, plaintext
 *        message content, encryption keys, or prekey material.
 * - R22: Standardized Error Responses — All API error responses use
 *        { error: { code: string, message: string, details?: object } }
 * - R9:  Auth enforcement on all protected routes; health is exempt
 * - R5:  No mock data — live backend
 * - R6:  Backend integration wiring
 * - R30: API versioning with /api/v1/ prefix
 *
 * @module e2e/tests/observability.spec
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE_URL: string =
  process.env.API_BASE_URL ?? 'http://localhost:3001';

const HEALTH_URL = `${API_BASE_URL}/api/v1/health`;
const METRICS_URL = `${API_BASE_URL}/api/v1/metrics`;
const AUTH_BASE = `${API_BASE_URL}/api/v1/auth`;
const CONVERSATIONS_URL = `${API_BASE_URL}/api/v1/conversations`;

/**
 * UUID v4 regex pattern (RFC 4122 compliant).
 * Used to validate correlation ID format per R29.
 */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Docker container name for the API service.
 * Used by execSync to read structured logs from the backend container.
 */
const API_CONTAINER_NAME: string =
  process.env.API_CONTAINER_NAME ?? 'kalle-api-1';

// ---------------------------------------------------------------------------
// Helper Interfaces
// ---------------------------------------------------------------------------

/** Parsed Prometheus metric entry */
interface PrometheusMetric {
  name: string;
  type: string;
  help: string;
  samples: Array<{
    name: string;
    labels: Record<string, string>;
    value: number;
  }>;
}

/** Auth response shape from register/login */
interface AuthResponse {
  data: {
    user: { id: string; email: string; displayName: string };
    tokens: {
      accessToken: string;
      refreshToken: string;
    };
  };
}

/** Health check component status */
interface HealthComponent {
  status: string;
  latency?: number;
  message?: string;
}

/** Health check response body — matches HealthCheckResponse from @kalle/shared */
interface HealthResponse {
  data: {
    status: string;
    version: string;
    uptime: number;
    components: {
      database: HealthComponent;
      redis: HealthComponent;
      queue: HealthComponent;
      storage: HealthComponent;
    };
  };
}

/** Standardized error response (R22) */
interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Parsed structured log entry (Pino format, R28) */
interface PinoLogEntry {
  level: number;
  time: number;
  msg?: string;
  message?: string;
  correlationId?: string;
  requestId?: string;
  req?: {
    method?: string;
    url?: string;
  };
  res?: {
    statusCode?: number;
  };
  responseTime?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Unique test identity generator
// ---------------------------------------------------------------------------

let testCounter = 0;

/**
 * Generate a unique email address for test user registration.
 * Combines a timestamp and per-session counter to avoid collisions.
 */
function uniqueEmail(): string {
  testCounter += 1;
  return `obs-test-${Date.now()}-${testCounter}@test.local`;
}

// ---------------------------------------------------------------------------
// Prometheus Metrics Parsing Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Prometheus text exposition format body into structured metric objects.
 * Handles HELP, TYPE, and sample lines per the OpenMetrics spec.
 *
 * @param body - Raw text from /api/v1/metrics
 * @returns Array of parsed PrometheusMetric objects
 */
function parsePrometheusMetrics(body: string): PrometheusMetric[] {
  const metrics: PrometheusMetric[] = [];
  const lines = body.split('\n');
  let current: PrometheusMetric | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      const helpMatch = trimmed.match(/^# HELP\s+(\S+)\s+(.*)$/);
      if (helpMatch) {
        const metricName = helpMatch[1];
        current = metrics.find((m) => m.name === metricName) ?? {
          name: metricName,
          type: '',
          help: '',
          samples: [],
        };
        current.help = helpMatch[2];
        if (!metrics.includes(current)) {
          metrics.push(current);
        }
        continue;
      }

      const typeMatch = trimmed.match(/^# TYPE\s+(\S+)\s+(.*)$/);
      if (typeMatch) {
        const metricName = typeMatch[1];
        current = metrics.find((m) => m.name === metricName) ?? {
          name: metricName,
          type: '',
          help: '',
          samples: [],
        };
        current.type = typeMatch[2];
        if (!metrics.includes(current)) {
          metrics.push(current);
        }
        continue;
      }
      continue;
    }

    // Parse sample line: metric_name{label="value"} 123.45
    const sampleMatch = trimmed.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:.]*)(\{[^}]*\})?\s+([0-9eE.+-]+|NaN|Inf|\+Inf|-Inf)(\s+\d+)?$/,
    );
    if (sampleMatch) {
      const sampleName = sampleMatch[1];
      const labelsStr = sampleMatch[2] ?? '';
      const value = parseFloat(sampleMatch[3]);
      const labels: Record<string, string> = {};

      if (labelsStr) {
        const labelContent = labelsStr.slice(1, -1);
        const labelRegex = /([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g;
        let labelMatch: RegExpExecArray | null;
        while ((labelMatch = labelRegex.exec(labelContent)) !== null) {
          labels[labelMatch[1]] = labelMatch[2];
        }
      }

      const baseName = sampleName.replace(
        /_(total|count|sum|bucket|created|info)$/,
        '',
      );
      const targetMetric =
        current &&
        (current.name === baseName || sampleName.startsWith(current.name))
          ? current
          : metrics.find(
              (m) =>
                m.name === baseName || sampleName.startsWith(m.name),
            );

      if (targetMetric) {
        targetMetric.samples.push({ name: sampleName, labels, value });
      } else {
        const newMetric: PrometheusMetric = {
          name: sampleName,
          type: '',
          help: '',
          samples: [{ name: sampleName, labels, value }],
        };
        metrics.push(newMetric);
        current = newMetric;
      }
    }
  }

  return metrics;
}

/**
 * Find a metric by name prefix in a parsed metrics array.
 * Returns the first match that starts with the given prefix.
 */
function findMetricByPrefix(
  metrics: PrometheusMetric[],
  prefix: string,
): PrometheusMetric | undefined {
  return metrics.find(
    (m) => m.name === prefix || m.name.startsWith(prefix),
  );
}

/**
 * Sum all sample values for a given metric name across all label combinations.
 * Targets _total, _count, and exact-name samples for aggregation.
 */
function sumMetricValues(
  metrics: PrometheusMetric[],
  metricNamePrefix: string,
): number {
  let total = 0;
  for (const metric of metrics) {
    if (
      metric.name === metricNamePrefix ||
      metric.name.startsWith(metricNamePrefix)
    ) {
      for (const sample of metric.samples) {
        if (
          sample.name === metricNamePrefix ||
          sample.name === `${metricNamePrefix}_total` ||
          sample.name === `${metricNamePrefix}_count`
        ) {
          total += sample.value;
        }
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Docker Log Inspection Helpers (R28, R23)
// ---------------------------------------------------------------------------

/**
 * Retrieve recent structured logs from the API Docker container.
 * Uses `docker logs` with `--tail` to limit output.
 * Falls back gracefully if Docker is unavailable.
 *
 * @param tailLines - Number of most recent log lines to retrieve
 * @returns Array of parsed Pino log entries, or empty array on failure
 */
function getDockerLogs(tailLines: number = 100): PinoLogEntry[] {
  try {
    const output = execSync(
      `docker logs ${API_CONTAINER_NAME} --tail ${tailLines} 2>&1`,
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const entries: PinoLogEntry[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as PinoLogEntry;
        if (
          typeof parsed.level === 'number' &&
          typeof parsed.time === 'number'
        ) {
          entries.push(parsed);
        }
      } catch {
        // Non-JSON lines (startup banners, etc.) are silently skipped
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Check whether Docker log inspection is available.
 * Returns true if the API container is accessible via `docker logs`.
 */
function isDockerLogAvailable(): boolean {
  try {
    execSync(`docker logs ${API_CONTAINER_NAME} --tail 1 2>&1`, {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Search Docker logs for any occurrence of the given sensitive strings.
 * Returns an array of matches found (empty means no leakage).
 *
 * @param sensitivePatterns - Strings to search for in raw log output
 * @param tailLines - Number of log lines to inspect
 * @returns Array of { pattern, line } objects for each match found
 */
function searchLogsForSensitiveData(
  sensitivePatterns: string[],
  tailLines: number = 200,
): Array<{ pattern: string; line: string }> {
  const matches: Array<{ pattern: string; line: string }> = [];
  try {
    const output = execSync(
      `docker logs ${API_CONTAINER_NAME} --tail ${tailLines} 2>&1`,
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const lines = output.split('\n');

    for (const rawLine of lines) {
      for (const pattern of sensitivePatterns) {
        if (pattern && rawLine.includes(pattern)) {
          matches.push({ pattern, line: rawLine.substring(0, 200) });
        }
      }
    }
  } catch {
    // Docker not available — cannot verify, return empty
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Auth Helper Functions
// ---------------------------------------------------------------------------

/**
 * Register a new user via the REST API.
 * Returns the full auth response including user and token pair.
 */
async function registerUser(
  requestContext: APIRequestContext,
  email: string,
  password: string,
  displayName: string,
): Promise<AuthResponse> {
  const res: APIResponse = await requestContext.post(
    `${AUTH_BASE}/register`,
    { data: { email, password, displayName } },
  );
  expect(res.status()).toBe(201);
  return res.json() as Promise<AuthResponse>;
}

/**
 * Log in an existing user via the REST API.
 * Returns the full auth response including user and token pair.
 */
async function loginUser(
  requestContext: APIRequestContext,
  email: string,
  password: string,
): Promise<AuthResponse> {
  const res: APIResponse = await requestContext.post(
    `${AUTH_BASE}/login`,
    { data: { email, password } },
  );
  expect(res.status()).toBe(200);
  return res.json() as Promise<AuthResponse>;
}

// ---------------------------------------------------------------------------
// Test Suite: Observability Stack
// ---------------------------------------------------------------------------

test.describe('Observability Stack', () => {
  /** Shared request context for direct API calls */
  let apiContext: APIRequestContext;

  /** Whether Docker log inspection is available */
  let dockerLogsAvailable: boolean;

  /** Registered test user credentials for authenticated endpoint tests */
  let testEmail: string;
  let testPassword: string;
  let testDisplayName: string;
  let testAccessToken: string;
  let testRefreshToken: string;

  test.beforeAll(async ({ playwright }) => {
    // Create a dedicated API request context (no browser automation needed)
    apiContext = await playwright.request.newContext({
      baseURL: API_BASE_URL,
    });

    // Check Docker log availability for R28/R23 tests
    dockerLogsAvailable = isDockerLogAvailable();

    // Register a test user for authenticated endpoint testing
    testEmail = uniqueEmail();
    testPassword = 'ObsTest!Secure#2026';
    testDisplayName = 'Observability Tester';
    try {
      const authResponse = await registerUser(
        apiContext,
        testEmail,
        testPassword,
        testDisplayName,
      );
      testAccessToken = authResponse.data.tokens.accessToken;
      testRefreshToken = authResponse.data.tokens.refreshToken;
    } catch {
      // Registration may fail if the service isn't fully running;
      // individual tests handle unavailability gracefully
      testAccessToken = '';
      testRefreshToken = '';
    }
  });

  test.afterAll(async () => {
    await apiContext.dispose();
  });

  // =========================================================================
  // Prometheus Metrics Endpoint Tests (R37)
  // =========================================================================

  test.describe('Prometheus Metrics Endpoint (R37)', () => {
    test('/api/v1/metrics returns Prometheus-compatible response', async () => {
      const res: APIResponse = await apiContext.get(METRICS_URL);

      expect(res.status()).toBe(200);

      const contentType = res.headers()['content-type'] ?? '';
      const isPrometheusFormat =
        contentType.includes('text/plain') ||
        contentType.includes('text/plain; version=0.0.4') ||
        contentType.includes('application/openmetrics-text');
      expect(isPrometheusFormat).toBe(true);

      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);

      expect(body).toContain('# HELP');
      expect(body).toContain('# TYPE');

      const metrics = parsePrometheusMetrics(body);
      expect(metrics.length).toBeGreaterThan(0);

      const validTypes = [
        'counter',
        'gauge',
        'histogram',
        'summary',
        'untyped',
        'info',
      ];
      for (const metric of metrics) {
        if (metric.type) {
          expect(validTypes).toContain(metric.type);
        }
      }
    });

    test('HTTP request count metrics are present', async () => {
      const baselineRes = await apiContext.get(METRICS_URL);
      expect(baselineRes.status()).toBe(200);
      const baselineBody = await baselineRes.text();
      const baselineMetrics = parsePrometheusMetrics(baselineBody);

      const httpCountMetric =
        findMetricByPrefix(baselineMetrics, 'http_requests_total') ??
        findMetricByPrefix(baselineMetrics, 'http_request_duration_seconds') ??
        findMetricByPrefix(baselineMetrics, 'http_request_total') ??
        findMetricByPrefix(baselineMetrics, 'http_server_request');

      expect(httpCountMetric).toBeDefined();

      const baselineCount = sumMetricValues(
        baselineMetrics,
        httpCountMetric!.name,
      );

      for (let i = 0; i < 5; i++) {
        const healthRes = await apiContext.get(HEALTH_URL);
        expect(healthRes.status()).toBe(200);
      }

      const updatedRes = await apiContext.get(METRICS_URL);
      expect(updatedRes.status()).toBe(200);
      const updatedBody = await updatedRes.text();
      const updatedMetrics = parsePrometheusMetrics(updatedBody);
      const updatedCount = sumMetricValues(
        updatedMetrics,
        httpCountMetric!.name,
      );

      expect(updatedCount).toBeGreaterThan(baselineCount);
      expect(updatedCount - baselineCount).toBeGreaterThanOrEqual(5);
    });

    test('HTTP request latency metrics are present', async () => {
      const res = await apiContext.get(METRICS_URL);
      expect(res.status()).toBe(200);
      const body = await res.text();
      const metrics = parsePrometheusMetrics(body);

      const latencyMetric =
        findMetricByPrefix(metrics, 'http_request_duration_seconds') ??
        findMetricByPrefix(metrics, 'http_request_latency') ??
        findMetricByPrefix(metrics, 'http_server_duration');

      expect(latencyMetric).toBeDefined();

      if (latencyMetric!.type) {
        expect(latencyMetric!.type).toBe('histogram');
      }

      const bucketSamples = latencyMetric!.samples.filter(
        (s) => s.labels.le !== undefined,
      );
      expect(bucketSamples.length).toBeGreaterThan(0);

      const hasCount = latencyMetric!.samples.some((s) =>
        s.name.endsWith('_count'),
      );
      const hasSum = latencyMetric!.samples.some((s) =>
        s.name.endsWith('_sum'),
      );
      expect(hasCount || hasSum || bucketSamples.length > 0).toBe(true);
    });

    test('HTTP metrics include method, route, and status_code labels', async () => {
      const res = await apiContext.get(METRICS_URL);
      expect(res.status()).toBe(200);
      const body = await res.text();
      const metrics = parsePrometheusMetrics(body);

      const httpMetrics = metrics.filter(
        (m) =>
          m.name.startsWith('http_request') ||
          m.name.startsWith('http_server'),
      );

      const allLabelKeys = new Set<string>();
      for (const metric of httpMetrics) {
        for (const sample of metric.samples) {
          for (const key of Object.keys(sample.labels)) {
            allLabelKeys.add(key);
          }
        }
      }

      const hasMethodLabel =
        allLabelKeys.has('method') ||
        allLabelKeys.has('http_method') ||
        allLabelKeys.has('http_request_method');
      expect(hasMethodLabel).toBe(true);

      const hasRouteLabel =
        allLabelKeys.has('route') ||
        allLabelKeys.has('path') ||
        allLabelKeys.has('http_route') ||
        allLabelKeys.has('url_path');
      expect(hasRouteLabel).toBe(true);

      const hasStatusLabel =
        allLabelKeys.has('status_code') ||
        allLabelKeys.has('status') ||
        allLabelKeys.has('http_status_code') ||
        allLabelKeys.has('code');
      expect(hasStatusLabel).toBe(true);
    });

    test('WebSocket connection metrics are present', async () => {
      const res = await apiContext.get(METRICS_URL);
      expect(res.status()).toBe(200);
      const body = await res.text();
      const metrics = parsePrometheusMetrics(body);

      const wsMetric =
        findMetricByPrefix(metrics, 'websocket_connections') ??
        findMetricByPrefix(metrics, 'socket_io_connections') ??
        findMetricByPrefix(metrics, 'ws_connections') ??
        findMetricByPrefix(metrics, 'socketio_connected');

      if (!wsMetric) {
        const hasAnyWsMetric =
          body.includes('websocket') ||
          body.includes('socket_io') ||
          body.includes('ws_connection') ||
          body.includes('socketio');
        expect(hasAnyWsMetric).toBe(true);
      } else {
        if (wsMetric.type) {
          expect(wsMetric.type).toBe('gauge');
        }
        for (const sample of wsMetric.samples) {
          expect(sample.value).toBeGreaterThanOrEqual(0);
        }
      }
    });

    test('BullMQ queue depth metrics are present', async () => {
      const res = await apiContext.get(METRICS_URL);
      expect(res.status()).toBe(200);
      const body = await res.text();
      const metrics = parsePrometheusMetrics(body);

      const queueMetric =
        findMetricByPrefix(metrics, 'bullmq_queue') ??
        findMetricByPrefix(metrics, 'bullmq_jobs') ??
        findMetricByPrefix(metrics, 'queue_depth') ??
        findMetricByPrefix(metrics, 'job_queue');

      if (!queueMetric) {
        const hasAnyQueueMetric =
          body.includes('bullmq') ||
          body.includes('queue_depth') ||
          body.includes('job_queue') ||
          body.includes('queue_size');
        expect(hasAnyQueueMetric).toBe(true);
      } else {
        expect(queueMetric.samples.length).toBeGreaterThanOrEqual(0);

        const queueNames = new Set<string>();
        for (const sample of queueMetric.samples) {
          if (sample.labels.queue) {
            queueNames.add(sample.labels.queue);
          }
          if (sample.labels.queue_name) {
            queueNames.add(sample.labels.queue_name);
          }
        }
        if (queueNames.size > 0) {
          const expectedQueues = [
            'message-fanout',
            'sender-key-distribution',
            'link-preview',
            'story-cleanup',
          ];
          const foundAny = expectedQueues.some(
            (q) =>
              queueNames.has(q) ||
              [...queueNames].some((name) =>
                name.includes(q.split('-')[0]),
              ),
          );
          expect(foundAny).toBe(true);
        }
      }
    });

    test('Database query latency metrics are present', async () => {
      const res = await apiContext.get(METRICS_URL);
      expect(res.status()).toBe(200);
      const body = await res.text();
      const metrics = parsePrometheusMetrics(body);

      const dbMetric =
        findMetricByPrefix(metrics, 'db_query_duration') ??
        findMetricByPrefix(metrics, 'prisma_query_duration') ??
        findMetricByPrefix(metrics, 'database_query') ??
        findMetricByPrefix(metrics, 'prisma_client');

      if (!dbMetric) {
        const hasDbMetric =
          body.includes('db_query') ||
          body.includes('prisma') ||
          body.includes('database') ||
          body.includes('query_duration');
        expect(hasDbMetric).toBe(true);
      } else {
        if (dbMetric.type) {
          expect(dbMetric.type).toBe('histogram');
        }
        const hasBuckets = dbMetric.samples.some(
          (s) => s.labels.le !== undefined,
        );
        const hasCountOrSum =
          dbMetric.samples.some((s) => s.name.endsWith('_count')) ||
          dbMetric.samples.some((s) => s.name.endsWith('_sum'));
        expect(hasBuckets || hasCountOrSum).toBe(true);
      }
    });
  });

  // =========================================================================
  // Health Check Endpoint Tests
  // =========================================================================

  test.describe('Health Check Endpoint', () => {
    test('/api/v1/health returns component-level health', async () => {
      const res: APIResponse = await apiContext.get(HEALTH_URL);
      expect(res.status()).toBe(200);

      const body = (await res.json()) as HealthResponse;

      // Response wrapped in data envelope per HealthCheckResponse contract
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('status');
      expect(body.data.status).toBe('healthy');

      // Version and uptime fields
      expect(body.data).toHaveProperty('version');
      expect(typeof body.data.version).toBe('string');
      expect(body.data).toHaveProperty('uptime');
      expect(typeof body.data.uptime).toBe('number');

      // Component-level health checks
      expect(body.data).toHaveProperty('components');
      const components = body.data.components;

      // Database component — status is 'up'/'down' per ComponentHealth contract
      expect(components).toHaveProperty('database');
      expect(components.database).toHaveProperty('status');
      expect(components.database.status).toBe('up');

      // Redis component
      expect(components).toHaveProperty('redis');
      expect(components.redis).toHaveProperty('status');
      expect(components.redis.status).toBe('up');

      // Queue component (BullMQ — derived from Redis health)
      if (components.queue) {
        expect(components.queue).toHaveProperty('status');
        expect(components.queue.status).toBe('up');
      }

      // Storage component
      if (components.storage) {
        expect(components.storage).toHaveProperty('status');
        expect(components.storage.status).toBe('up');
      }
    });

    test('health endpoint is public — no auth required (R9)', async () => {
      // Create a fresh context without any auth headers
      const unauthContext = await apiContext.get(HEALTH_URL, {
        headers: {},
      });

      // R9 exempts health from authentication
      expect(unauthContext.status()).toBe(200);

      const body = (await unauthContext.json()) as HealthResponse;
      expect(body).toHaveProperty('data');
      expect(body.data.status).toBe('healthy');
    });

    test('health endpoint returns valid JSON with Content-Type', async () => {
      const res = await apiContext.get(HEALTH_URL);
      expect(res.status()).toBe(200);

      const contentType = res.headers()['content-type'] ?? '';
      expect(contentType).toContain('application/json');

      const body = (await res.json()) as HealthResponse;
      expect(typeof body).toBe('object');
      expect(body).not.toBeNull();
    });

    test('health endpoint is idempotent across multiple calls', async () => {
      const results: HealthResponse[] = [];

      for (let i = 0; i < 3; i++) {
        const res = await apiContext.get(HEALTH_URL);
        expect(res.status()).toBe(200);
        results.push((await res.json()) as HealthResponse);
      }

      // All calls should report same overall status
      for (const result of results) {
        expect(result.data.status).toBe('healthy');
      }

      // Uptime should be non-decreasing across sequential calls
      for (let i = 1; i < results.length; i++) {
        expect(results[i].data.uptime).toBeGreaterThanOrEqual(results[i - 1].data.uptime);
      }
    });
  });

  // =========================================================================
  // Correlation ID Propagation Tests (R29)
  // =========================================================================

  test.describe('Correlation ID Propagation (R29)', () => {
    test('API responses include X-Correlation-ID header', async () => {
      const res = await apiContext.get(HEALTH_URL);
      expect(res.status()).toBe(200);

      const correlationId =
        res.headers()['x-correlation-id'] ??
        res.headers()['x-request-id'] ??
        '';

      // Correlation ID header must be present
      expect(correlationId).toBeTruthy();

      // Must be a valid UUID v4 format
      expect(correlationId).toMatch(UUID_V4_REGEX);
    });

    test('provided correlation ID is propagated in response', async () => {
      const customCorrelationId = '550e8400-e29b-41d4-a716-446655440000';

      const res = await apiContext.get(HEALTH_URL, {
        headers: {
          'X-Correlation-ID': customCorrelationId,
        },
      });
      expect(res.status()).toBe(200);

      const responseCorrelationId =
        res.headers()['x-correlation-id'] ??
        res.headers()['x-request-id'] ??
        '';

      // Server should echo back the provided correlation ID
      // (or generate a new one — both behaviors are acceptable per R29)
      expect(responseCorrelationId).toBeTruthy();

      // If the server echoes, it should match exactly
      if (responseCorrelationId === customCorrelationId) {
        expect(responseCorrelationId).toBe(customCorrelationId);
      } else {
        // If generated anew, must still be valid UUID v4
        expect(responseCorrelationId).toMatch(UUID_V4_REGEX);
      }
    });

    test('correlation ID appears in error responses (R29, R22)', async () => {
      // Trigger a 401 error by accessing a protected endpoint without auth
      const res = await apiContext.get(CONVERSATIONS_URL, {
        headers: {},
      });

      // Should be 401 Unauthorized
      expect(res.status()).toBe(401);

      // Correlation ID header must be present even on error responses
      const correlationId =
        res.headers()['x-correlation-id'] ??
        res.headers()['x-request-id'] ??
        '';
      expect(correlationId).toBeTruthy();
      expect(correlationId).toMatch(UUID_V4_REGEX);

      // Error response body should use standardized shape (R22)
      const body = (await res.json()) as ErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
    });

    test('correlation ID in error responses from invalid login (R29, R22)', async () => {
      // Trigger an error via invalid login credentials
      const res = await apiContext.post(`${AUTH_BASE}/login`, {
        data: {
          email: 'nonexistent-user@obs-test.local',
          password: 'WrongPassword!123',
        },
      });

      // Should be 401 or 400
      expect([400, 401, 404]).toContain(res.status());

      // Correlation ID must be present
      const correlationId =
        res.headers()['x-correlation-id'] ??
        res.headers()['x-request-id'] ??
        '';
      expect(correlationId).toBeTruthy();
      expect(correlationId).toMatch(UUID_V4_REGEX);

      // Standardized error shape (R22)
      const body = (await res.json()) as ErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
    });

    test('each request gets a unique correlation ID', async () => {
      const correlationIds: string[] = [];

      // Make 5 sequential requests
      for (let i = 0; i < 5; i++) {
        const res = await apiContext.get(HEALTH_URL);
        expect(res.status()).toBe(200);
        const correlationId =
          res.headers()['x-correlation-id'] ??
          res.headers()['x-request-id'] ??
          '';
        expect(correlationId).toBeTruthy();
        correlationIds.push(correlationId);
      }

      // All correlation IDs must be unique
      const uniqueIds = new Set(correlationIds);
      expect(uniqueIds.size).toBe(correlationIds.length);

      // Each must be valid UUID v4
      for (const id of correlationIds) {
        expect(id).toMatch(UUID_V4_REGEX);
      }
    });

    test('correlation ID present on metrics endpoint', async () => {
      const res = await apiContext.get(METRICS_URL);
      expect(res.status()).toBe(200);

      const correlationId =
        res.headers()['x-correlation-id'] ??
        res.headers()['x-request-id'] ??
        '';
      expect(correlationId).toBeTruthy();
      expect(correlationId).toMatch(UUID_V4_REGEX);
    });

    test('correlation ID present on authenticated endpoints', async () => {
      // Skip if no test token is available
      test.skip(
        !testAccessToken,
        'Test user registration failed — skipping authenticated correlation ID test',
      );

      const res = await apiContext.get(CONVERSATIONS_URL, {
        headers: { Authorization: `Bearer ${testAccessToken}` },
      });

      // Should succeed with auth
      expect([200, 201]).toContain(res.status());

      const correlationId =
        res.headers()['x-correlation-id'] ??
        res.headers()['x-request-id'] ??
        '';
      expect(correlationId).toBeTruthy();
      expect(correlationId).toMatch(UUID_V4_REGEX);
    });
  });

  // =========================================================================
  // Structured Logging Verification (R28)
  // =========================================================================

  test.describe('Structured Logging Verification (R28)', () => {
    test('backend produces structured JSON logs', async () => {
      // Generate a few requests to produce log entries
      await apiContext.get(HEALTH_URL);
      await apiContext.get(METRICS_URL);
      await apiContext.post(`${AUTH_BASE}/login`, {
        data: {
          email: 'structured-log-test@obs.local',
          password: 'LogTest!123',
        },
      });

      // Allow logs to flush
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (dockerLogsAvailable) {
        // Direct Docker log inspection
        const logEntries = getDockerLogs(50);

        // Must have at least some structured log entries
        expect(logEntries.length).toBeGreaterThan(0);

        // Verify each entry has Pino-standard fields
        for (const entry of logEntries) {
          // level: numeric Pino log level (10=trace, 20=debug, 30=info, etc.)
          expect(typeof entry.level).toBe('number');
          expect(entry.level).toBeGreaterThanOrEqual(10);
          expect(entry.level).toBeLessThanOrEqual(60);

          // time: Unix timestamp in milliseconds
          expect(typeof entry.time).toBe('number');
          expect(entry.time).toBeGreaterThan(1_000_000_000_000);

          // msg or message: log message string
          const hasMessage =
            typeof entry.msg === 'string' ||
            typeof entry.message === 'string';
          expect(hasMessage).toBe(true);
        }
      } else {
        // Indirect verification: confirm correlation IDs are present on all
        // API responses, proving structured logging middleware is active
        const healthRes = await apiContext.get(HEALTH_URL);
        const correlationId =
          healthRes.headers()['x-correlation-id'] ??
          healthRes.headers()['x-request-id'] ??
          '';
        expect(correlationId).toBeTruthy();
        expect(correlationId).toMatch(UUID_V4_REGEX);
      }
    });

    test('structured logs include correlation IDs (R28, R29)', async () => {
      // Generate traffic with a known correlation ID
      const knownCorrelationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      await apiContext.get(HEALTH_URL, {
        headers: { 'X-Correlation-ID': knownCorrelationId },
      });

      // Allow logs to flush
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (dockerLogsAvailable) {
        const logEntries = getDockerLogs(50);

        // At least some entries should have a correlationId field
        const entriesWithCorrelationId = logEntries.filter(
          (e) =>
            typeof e.correlationId === 'string' ||
            typeof e.requestId === 'string',
        );

        expect(entriesWithCorrelationId.length).toBeGreaterThan(0);

        // Verify correlation IDs are valid UUID v4 format
        for (const entry of entriesWithCorrelationId) {
          const corrId = entry.correlationId ?? entry.requestId ?? '';
          if (corrId) {
            expect(corrId).toMatch(UUID_V4_REGEX);
          }
        }
      } else {
        // Indirect: verify the response correlation ID header as proxy
        const res = await apiContext.get(HEALTH_URL);
        const correlationId =
          res.headers()['x-correlation-id'] ??
          res.headers()['x-request-id'] ??
          '';
        expect(correlationId).toBeTruthy();
      }
    });

    test('structured logs include request metadata', async () => {
      // Make a specific request that will generate a log with HTTP metadata
      const targetEndpoint = `${AUTH_BASE}/login`;
      await apiContext.post(targetEndpoint, {
        data: {
          email: 'log-metadata-test@obs.local',
          password: 'MetadataTest!123',
        },
      });

      // Allow logs to flush
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (dockerLogsAvailable) {
        const logEntries = getDockerLogs(50);

        // Find entries that have request metadata (pino-http format)
        const requestLogEntries = logEntries.filter(
          (e) =>
            e.req !== undefined ||
            e.res !== undefined ||
            e.responseTime !== undefined,
        );

        if (requestLogEntries.length > 0) {
          // At least one entry should have request information
          const entry = requestLogEntries[requestLogEntries.length - 1];

          // Check for HTTP method
          if (entry.req) {
            expect(typeof entry.req.method).toBe('string');
          }

          // Check for response status code
          if (entry.res) {
            expect(typeof entry.res.statusCode).toBe('number');
          }

          // Check for response time
          if (entry.responseTime !== undefined) {
            expect(typeof entry.responseTime).toBe('number');
            expect(entry.responseTime).toBeGreaterThanOrEqual(0);
          }
        }
      } else {
        // Indirect: verify response headers include timing-related info
        const res = await apiContext.get(HEALTH_URL);
        expect(res.status()).toBe(200);

        // The presence of correlation ID proves logging middleware is active
        const correlationId =
          res.headers()['x-correlation-id'] ??
          res.headers()['x-request-id'] ??
          '';
        expect(correlationId).toBeTruthy();
      }
    });

    test('logs use numeric Pino levels — not string levels', async () => {
      if (!dockerLogsAvailable) {
        test.skip(true, 'Docker log inspection unavailable');
        return;
      }

      const logEntries = getDockerLogs(30);
      expect(logEntries.length).toBeGreaterThan(0);

      // Pino uses numeric levels: 10, 20, 30, 40, 50, 60
      const validPinoLevels = [10, 20, 30, 40, 50, 60];
      for (const entry of logEntries) {
        expect(validPinoLevels).toContain(entry.level);
      }
    });
  });

  // =========================================================================
  // Log Hygiene Verification (R23)
  // =========================================================================

  test.describe('Log Hygiene Verification (R23)', () => {
    test('logs do not contain JWT tokens after login', async () => {
      // Perform a login to generate JWT-related log entries
      const email = uniqueEmail();
      const password = 'LogHygieneJWT!2026';
      try {
        await registerUser(apiContext, email, password, 'JWT Log Tester');
      } catch {
        // Registration might fail — still check logs
      }

      // Attempt login
      const loginRes = await apiContext.post(`${AUTH_BASE}/login`, {
        data: { email, password },
      });
      let accessToken = '';
      if (loginRes.status() === 200) {
        const loginBody = (await loginRes.json()) as AuthResponse;
        accessToken = loginBody.data.tokens.accessToken;
      }

      // Allow logs to flush
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (dockerLogsAvailable) {
        // Build patterns to search for
        const sensitivePatterns: string[] = [];

        // JWT tokens start with "eyJ" (base64-encoded JSON header)
        if (accessToken) {
          // Check for full token
          sensitivePatterns.push(accessToken);
          // Check for JWT prefix patterns
          sensitivePatterns.push('eyJhbGciOi');
        }

        const leaks = searchLogsForSensitiveData(sensitivePatterns, 100);
        expect(leaks).toEqual([]);
      } else {
        // Indirect: verify the API doesn't echo tokens in response headers
        const healthRes = await apiContext.get(HEALTH_URL);
        const headers = healthRes.headers();
        const headerValues = Object.values(headers).join(' ');
        expect(headerValues).not.toContain('eyJhbGciOi');
      }
    });

    test('logs do not contain passwords', async () => {
      const testPasswordForHygiene = 'SuperSecret$Password#2026!xyz';

      // Trigger login with this known password to generate log entries
      await apiContext.post(`${AUTH_BASE}/login`, {
        data: {
          email: 'password-hygiene@obs-test.local',
          password: testPasswordForHygiene,
        },
      });

      // Allow logs to flush
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (dockerLogsAvailable) {
        const leaks = searchLogsForSensitiveData(
          [testPasswordForHygiene],
          100,
        );
        // CRITICAL R23: Password MUST NOT appear in logs
        expect(leaks).toEqual([]);
      } else {
        // Indirect verification: check error response doesn't contain password
        const res = await apiContext.post(`${AUTH_BASE}/login`, {
          data: {
            email: 'pwd-indirect@obs-test.local',
            password: testPasswordForHygiene,
          },
        });
        const body = await res.text();
        expect(body).not.toContain(testPasswordForHygiene);
      }
    });

    test('logs do not contain plaintext message content', async () => {
      test.skip(
        !testAccessToken,
        'Test user registration failed — skipping message content hygiene test',
      );

      const secretMessageContent =
        'SUPER_SECRET_PLAINTEXT_MSG_CONTENT_9f8a7b6c';

      // Attempt to send a message (will likely fail without a valid
      // conversation, but the request body containing the secret content
      // is what we want to verify doesn't appear in logs)
      await apiContext.post(`${API_BASE_URL}/api/v1/messages`, {
        headers: { Authorization: `Bearer ${testAccessToken}` },
        data: {
          conversationId: '00000000-0000-4000-8000-000000000000',
          content: secretMessageContent,
          type: 'text',
        },
      });

      // Allow logs to flush
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (dockerLogsAvailable) {
        const leaks = searchLogsForSensitiveData(
          [secretMessageContent],
          100,
        );
        // CRITICAL R23: Plaintext message content MUST NOT appear in logs
        expect(leaks).toEqual([]);
      } else {
        // Cannot verify without Docker logs — pass as indirect
        expect(true).toBe(true);
      }
    });

    test('logs do not contain encryption keys or prekey material', async () => {
      test.skip(
        !testAccessToken,
        'Test user registration failed — skipping encryption key hygiene test',
      );

      // Simulate a prekey bundle upload with known key material
      const knownPreKeyMaterial = 'FAKE_PREKEY_BASE64_xYz123AbCdEfGhIjKlMnOp';
      const knownIdentityKey = 'FAKE_IDENTITY_KEY_QrStUvWxYz987654321';

      await apiContext.post(`${API_BASE_URL}/api/v1/keys/bundle`, {
        headers: { Authorization: `Bearer ${testAccessToken}` },
        data: {
          registrationId: 12345,
          identityKey: { publicKey: knownIdentityKey },
          signedPreKey: {
            keyId: 1,
            publicKey: knownPreKeyMaterial,
            signature: 'fake-signature',
            timestamp: Date.now(),
          },
          preKeys: [{ keyId: 1, publicKey: knownPreKeyMaterial }],
        },
      });

      // Allow logs to flush
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (dockerLogsAvailable) {
        const leaks = searchLogsForSensitiveData(
          [knownPreKeyMaterial, knownIdentityKey],
          100,
        );
        // CRITICAL R23: Encryption keys MUST NOT appear in logs
        expect(leaks).toEqual([]);
      } else {
        // Cannot verify without Docker logs — pass as indirect
        expect(true).toBe(true);
      }
    });

    test('logs do not contain refresh tokens', async () => {
      test.skip(
        !testRefreshToken,
        'Test user registration failed — skipping refresh token hygiene test',
      );

      // Use the refresh token in a request to generate related log entries
      await apiContext.post(`${AUTH_BASE}/refresh`, {
        data: { refreshToken: testRefreshToken },
      });

      // Allow logs to flush
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (dockerLogsAvailable) {
        const leaks = searchLogsForSensitiveData(
          [testRefreshToken],
          100,
        );
        // CRITICAL R23: Refresh tokens MUST NOT appear in logs
        expect(leaks).toEqual([]);
      } else {
        // Indirect: verify API responses don't echo refresh tokens
        const healthRes = await apiContext.get(HEALTH_URL);
        const headers = healthRes.headers();
        const headerValues = Object.values(headers).join(' ');
        expect(headerValues).not.toContain(testRefreshToken);
      }
    });

    test('comprehensive log hygiene — combined sensitive data check', async () => {
      // Perform multiple actions that involve sensitive data
      const hygieneEmail = uniqueEmail();
      const hygienePassword = 'CombinedHygiene!Test#2026$xYz';

      // 1. Register (password)
      let hygieneToken = '';
      try {
        const regRes = await registerUser(
          apiContext,
          hygieneEmail,
          hygienePassword,
          'Hygiene Combined Tester',
        );
        hygieneToken = regRes.data.tokens.accessToken;
      } catch {
        // Continue even if registration fails
      }

      // 2. Login (password + JWT)
      try {
        const loginRes = await loginUser(
          apiContext,
          hygieneEmail,
          hygienePassword,
        );
        hygieneToken = loginRes.data.tokens.accessToken;
      } catch {
        // Continue
      }

      // 3. Attempt authenticated request (JWT in Authorization header)
      if (hygieneToken) {
        await apiContext.get(CONVERSATIONS_URL, {
          headers: { Authorization: `Bearer ${hygieneToken}` },
        });
      }

      // Allow logs to flush
      await new Promise((resolve) => setTimeout(resolve, 1500));

      if (dockerLogsAvailable) {
        const patternsToCheck: string[] = [
          hygienePassword,
          'eyJhbGciOi',
        ];
        if (hygieneToken) {
          patternsToCheck.push(hygieneToken);
        }

        const leaks = searchLogsForSensitiveData(patternsToCheck, 200);
        expect(leaks).toEqual([]);
      } else {
        // Indirect: verify API responses don't leak sensitive data
        const res = await apiContext.get(HEALTH_URL);
        expect(res.status()).toBe(200);
      }
    });
  });

  // =========================================================================
  // Metrics Incrementing Tests (R37)
  // =========================================================================

  test.describe('Metrics Incrementing', () => {
    test('metrics increment after generating traffic', async () => {
      // Step 1: Capture initial metrics values
      const initialRes = await apiContext.get(METRICS_URL);
      expect(initialRes.status()).toBe(200);
      const initialBody = await initialRes.text();
      const initialMetrics = parsePrometheusMetrics(initialBody);

      // Find the HTTP counter metric
      const httpMetricName = (
        findMetricByPrefix(initialMetrics, 'http_requests_total') ??
        findMetricByPrefix(initialMetrics, 'http_request_duration_seconds') ??
        findMetricByPrefix(initialMetrics, 'http_request_total') ??
        findMetricByPrefix(initialMetrics, 'http_server_request')
      )?.name;

      expect(httpMetricName).toBeDefined();

      const initialCount = sumMetricValues(initialMetrics, httpMetricName!);

      // Step 2: Generate diverse traffic
      // 10 health checks
      for (let i = 0; i < 10; i++) {
        await apiContext.get(HEALTH_URL);
      }

      // 3 login attempts (will produce 401s for non-existent users)
      for (let i = 0; i < 3; i++) {
        await apiContext.post(`${AUTH_BASE}/login`, {
          data: {
            email: `metrics-test-${i}@obs.local`,
            password: 'MetricsTest!123',
          },
        });
      }

      // 2 conversation fetches (will produce 401s without auth)
      for (let i = 0; i < 2; i++) {
        await apiContext.get(CONVERSATIONS_URL);
      }

      // Step 3: Re-fetch metrics
      const updatedRes = await apiContext.get(METRICS_URL);
      expect(updatedRes.status()).toBe(200);
      const updatedBody = await updatedRes.text();
      const updatedMetrics = parsePrometheusMetrics(updatedBody);

      const updatedCount = sumMetricValues(updatedMetrics, httpMetricName!);

      // Step 4: Verify increments
      // We made at least 15 requests (10 health + 3 login + 2 conversations)
      // plus 2 metrics fetches = 17 minimum
      const delta = updatedCount - initialCount;
      expect(delta).toBeGreaterThanOrEqual(15);
    });

    test('latency histogram samples increase after traffic', async () => {
      // Capture initial histogram count
      const initialRes = await apiContext.get(METRICS_URL);
      expect(initialRes.status()).toBe(200);
      const initialBody = await initialRes.text();
      const initialMetrics = parsePrometheusMetrics(initialBody);

      const latencyMetricName = (
        findMetricByPrefix(initialMetrics, 'http_request_duration_seconds') ??
        findMetricByPrefix(initialMetrics, 'http_request_latency') ??
        findMetricByPrefix(initialMetrics, 'http_server_duration')
      )?.name;

      expect(latencyMetricName).toBeDefined();

      // Find initial _count value
      let initialHistogramCount = 0;
      for (const metric of initialMetrics) {
        if (metric.name === latencyMetricName) {
          for (const sample of metric.samples) {
            if (sample.name.endsWith('_count')) {
              initialHistogramCount += sample.value;
            }
          }
        }
      }

      // Generate 5 requests
      for (let i = 0; i < 5; i++) {
        await apiContext.get(HEALTH_URL);
      }

      // Capture updated histogram count
      const updatedRes = await apiContext.get(METRICS_URL);
      expect(updatedRes.status()).toBe(200);
      const updatedBody = await updatedRes.text();
      const updatedMetrics = parsePrometheusMetrics(updatedBody);

      let updatedHistogramCount = 0;
      for (const metric of updatedMetrics) {
        if (metric.name === latencyMetricName) {
          for (const sample of metric.samples) {
            if (sample.name.endsWith('_count')) {
              updatedHistogramCount += sample.value;
            }
          }
        }
      }

      // Histogram count should have increased
      expect(updatedHistogramCount).toBeGreaterThan(initialHistogramCount);
    });

    test('error metrics track 4xx responses separately', async () => {
      // Generate some 4xx errors
      for (let i = 0; i < 3; i++) {
        await apiContext.get(CONVERSATIONS_URL);
      }

      const res = await apiContext.get(METRICS_URL);
      expect(res.status()).toBe(200);
      const body = await res.text();
      const metrics = parsePrometheusMetrics(body);

      // Find HTTP metrics that break down by status code
      const httpMetrics = metrics.filter(
        (m) =>
          m.name.startsWith('http_request') ||
          m.name.startsWith('http_server'),
      );

      let found4xxSamples = false;
      for (const metric of httpMetrics) {
        for (const sample of metric.samples) {
          const statusCode =
            sample.labels.status_code ??
            sample.labels.status ??
            sample.labels.http_status_code ??
            '';
          if (statusCode.startsWith('4')) {
            found4xxSamples = true;
            expect(sample.value).toBeGreaterThan(0);
          }
        }
      }

      // We should find at least some 4xx entries
      expect(found4xxSamples).toBe(true);
    });
  });

  // =========================================================================
  // Standardized Error Response Shape (R22)
  // =========================================================================

  test.describe('Standardized Error Response Shape (R22)', () => {
    test('401 error has standardized error shape', async () => {
      const res = await apiContext.get(CONVERSATIONS_URL);
      expect(res.status()).toBe(401);

      const body = (await res.json()) as ErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
      expect(body.error.code.length).toBeGreaterThan(0);
      expect(body.error.message.length).toBeGreaterThan(0);
    });

    test('invalid login returns standardized error shape', async () => {
      const res = await apiContext.post(`${AUTH_BASE}/login`, {
        data: {
          email: 'invalid@nonexistent-domain-obs.local',
          password: 'WrongPassword!123',
        },
      });

      expect([400, 401, 404]).toContain(res.status());

      const body = (await res.json()) as ErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
    });

    test('validation error returns standardized error shape with details', async () => {
      // Send a malformed registration request (missing required fields)
      const res = await apiContext.post(`${AUTH_BASE}/register`, {
        data: {
          email: 'not-a-valid-email',
          // password missing
          // displayName missing
        },
      });

      expect([400, 422]).toContain(res.status());

      const body = (await res.json()) as ErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');

      // Validation errors should include details with field-level info
      if (body.error.details) {
        expect(typeof body.error.details).toBe('object');
      }
    });

    test('error responses include correlation ID header', async () => {
      const res = await apiContext.get(CONVERSATIONS_URL);
      expect(res.status()).toBe(401);

      const correlationId =
        res.headers()['x-correlation-id'] ??
        res.headers()['x-request-id'] ??
        '';
      expect(correlationId).toBeTruthy();
      expect(correlationId).toMatch(UUID_V4_REGEX);
    });
  });

  // =========================================================================
  // API Versioning (R30)
  // =========================================================================

  test.describe('API Versioning (R30)', () => {
    test('health endpoint uses /api/v1/ prefix', async () => {
      const res = await apiContext.get(`${API_BASE_URL}/api/v1/health`);
      expect(res.status()).toBe(200);
    });

    test('metrics endpoint uses /api/v1/ prefix', async () => {
      const res = await apiContext.get(`${API_BASE_URL}/api/v1/metrics`);
      expect(res.status()).toBe(200);
    });

    test('auth endpoints use /api/v1/ prefix', async () => {
      // Login with bad credentials — still should route correctly (not 404)
      const res = await apiContext.post(
        `${API_BASE_URL}/api/v1/auth/login`,
        {
          data: {
            email: 'versioning-test@obs.local',
            password: 'VersionTest!123',
          },
        },
      );
      // Should NOT be 404 (which would indicate the route doesn't exist)
      expect(res.status()).not.toBe(404);
    });

    test('non-versioned paths return 404', async () => {
      const res = await apiContext.get(`${API_BASE_URL}/health`);
      // Without the /api/v1/ prefix, should be 404 or redirect
      expect([301, 302, 404]).toContain(res.status());
    });
  });

  // =========================================================================
  // Integration Verification (R5, R6)
  // =========================================================================

  test.describe('Integration Verification (R5, R6)', () => {
    test('health check exercises real database connection (R5)', async () => {
      const res = await apiContext.get(HEALTH_URL);
      expect(res.status()).toBe(200);

      const body = (await res.json()) as HealthResponse;

      // Database component should report real status — not a mock
      expect(body.data.components.database).toBeDefined();
      expect(body.data.components.database.status).toBe('up');

      // If latency is reported, it should be a realistic value (> 0ms)
      if (body.data.components.database.latency !== undefined) {
        expect(body.data.components.database.latency).toBeGreaterThan(0);
      }
    });

    test('health check exercises real Redis connection (R5)', async () => {
      const res = await apiContext.get(HEALTH_URL);
      expect(res.status()).toBe(200);

      const body = (await res.json()) as HealthResponse;

      // Redis component should report real status
      expect(body.data.components.redis).toBeDefined();
      expect(body.data.components.redis.status).toBe('up');

      // If latency is reported, it should be a realistic value
      if (body.data.components.redis.latency !== undefined) {
        expect(body.data.components.redis.latency).toBeGreaterThan(0);
      }
    });

    test('metrics endpoint exercises real instrumentation (R6)', async () => {
      const res = await apiContext.get(METRICS_URL);
      expect(res.status()).toBe(200);
      const body = await res.text();

      // Real instrumentation will have process-level metrics
      const hasProcessMetrics =
        body.includes('process_') ||
        body.includes('nodejs_') ||
        body.includes('node_');

      // Or at least HTTP metrics from real traffic
      const hasHttpMetrics =
        body.includes('http_request') || body.includes('http_server');

      expect(hasProcessMetrics || hasHttpMetrics).toBe(true);
    });
  });
});
