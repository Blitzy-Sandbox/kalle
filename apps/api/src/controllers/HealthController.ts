/**
 * @file apps/api/src/controllers/HealthController.ts
 * @description Thin delegation controller for health check (GET /api/v1/health)
 * and Prometheus metrics (GET /api/v1/metrics) endpoints. These are PUBLIC
 * endpoints — no JWT authentication required (R9 exception).
 *
 * Architecture rules enforced:
 * - R16 (OOD Layering / Thin Delegation): Zero business logic — delegates
 *        entirely to HealthService and MetricsService. The only inline work
 *        is thin DTO mapping between internal service types and the shared
 *        API contract, which is standard controller-boundary formatting.
 * - R17 (Constructor Injection): Receives HealthService and MetricsService
 *        via constructor parameters. Wired in the server.ts composition root
 *        as `new HealthController(healthService, metricsService)`.
 * - R22 (Standardized Error Responses): Errors are NOT formatted here — they
 *        propagate to the global error-handler middleware via `next(error)`.
 * - R28 (Structured Logging Only): Zero `console.log`, `console.warn`, or
 *        `console.error` calls in this file.
 * - R7  (Zero Warnings Build): Compiles under `tsc --noEmit --strict` with
 *        zero warnings. All method signatures fully typed.
 * - R29 (Correlation ID): Accessible via `req.correlationId` from middleware.
 * - R30 (API Versioning): Routes under /api/v1/health and /api/v1/metrics
 *        (routing handled by route files, not by this controller).
 * - R37 (Metrics Endpoint): /api/v1/metrics exposes Prometheus-compatible
 *        metrics in text exposition format (text/plain).
 *
 * @module HealthController
 */

import type { Request, Response, NextFunction } from 'express';
import type { HealthService } from '../services/HealthService';
import type { MetricsService } from '../services/MetricsService';
import type {
  HealthCheckResponse,
  ComponentHealth,
} from '@kalle/shared';

// ---------------------------------------------------------------------------
// Helper — Internal-to-API component health mapping
// ---------------------------------------------------------------------------

/**
 * Shape of a single component health entry returned by HealthService.
 * Inlined here to avoid importing `ComponentHealth` from HealthService
 * (which would collide with the identically-named but differently-shaped
 * type from `@kalle/shared`).
 */
interface InternalComponentHealth {
  /** Internal status uses 'healthy' | 'unhealthy' | 'degraded'. */
  status: 'healthy' | 'unhealthy' | 'degraded';
  /** Response time in milliseconds for the component check. */
  responseTimeMs: number;
  /** Optional human-readable message about the check result. */
  message?: string;
  /** Optional additional details about the component state. */
  details?: Record<string, unknown>;
}

/**
 * Maps an internal component health entry (HealthService shape) to the
 * public API contract shape (HealthCheckResponse / ComponentHealth).
 *
 * Mapping rules:
 * - Internal `'healthy'` or `'degraded'` → API `'up'`
 * - Internal `'unhealthy'` → API `'down'`
 * - Internal `responseTimeMs` → API `latency`
 * - Internal `details` forwarded as-is when present
 *
 * @param component - Internal component health from HealthService
 * @returns Public API ComponentHealth for the response contract
 */
function toApiComponentHealth(component: InternalComponentHealth): ComponentHealth {
  const mapped: ComponentHealth = {
    status: component.status === 'unhealthy' ? 'down' : 'up',
    latency: component.responseTimeMs,
  };

  if (component.details !== undefined && component.details !== null) {
    mapped.details = component.details;
  }

  return mapped;
}

// ---------------------------------------------------------------------------
// HealthController
// ---------------------------------------------------------------------------

/**
 * Controller for health check and Prometheus metrics endpoints.
 *
 * Both endpoints are public (no auth middleware applied). The controller
 * receives its dependencies via constructor injection (R17) and delegates
 * all substantive work to the injected services (R16).
 *
 * @example
 * ```typescript
 * // In server.ts composition root:
 * const healthController = new HealthController(healthService, metricsService);
 *
 * // In health.routes.ts:
 * router.get('/health', healthController.check);
 * router.get('/metrics', healthController.metrics);
 * ```
 */
export class HealthController {
  /**
   * Creates a new HealthController instance.
   *
   * @param healthService - Service for component-level health probes
   *        (PostgreSQL, Redis, storage) — delegates from check() endpoint
   * @param metricsService - Service for Prometheus metrics collection and
   *        serialization — delegates from metrics() endpoint
   */
  constructor(
    private readonly healthService: HealthService,
    private readonly metricsService: MetricsService
  ) {
    // Bind methods to preserve `this` context when used as Express route
    // handlers. Without this, `this.healthService` and `this.metricsService`
    // would be `undefined` at runtime when Express invokes the handler.
    this.check = this.check.bind(this);
    this.metrics = this.metrics.bind(this);
  }

  // ─── GET /api/v1/health ─────────────────────────────────────────────

  /**
   * Health check endpoint handler.
   *
   * Delegates to `HealthService.getHealth()` which probes PostgreSQL, Redis,
   * and local filesystem storage. Maps the internal health result to the
   * shared API contract (`HealthCheckResponse`) and derives the `queue`
   * component status from Redis (since BullMQ depends on Redis connectivity).
   *
   * HTTP status codes:
   * - **200 OK** — overall status is `'healthy'` or `'degraded'`
   * - **503 Service Unavailable** — overall status is `'unhealthy'`
   *
   * @param _req  - Express request (unused — health check has no request input)
   * @param res   - Express response used to send the JSON health status
   * @param next  - Express next function for error propagation to error-handler
   */
  async check(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await this.healthService.getHealth();

      // Derive queue component health from Redis — BullMQ uses Redis as
      // its backing store, so Redis connectivity implies queue availability.
      const queueComponent: ComponentHealth = {
        status: result.components.redis.status === 'unhealthy' ? 'down' : 'up',
        latency: result.components.redis.responseTimeMs,
      };

      if (
        result.components.redis.details !== undefined &&
        result.components.redis.details !== null
      ) {
        queueComponent.details = result.components.redis.details;
      }

      // Assemble the API-contract-compliant response
      const response: HealthCheckResponse = {
        data: {
          status: result.status,
          version: result.version,
          uptime: result.uptime,
          components: {
            database: toApiComponentHealth(result.components.database),
            redis: toApiComponentHealth(result.components.redis),
            queue: queueComponent,
            storage: toApiComponentHealth(result.components.storage),
          },
        },
      };

      // Return 200 for healthy/degraded, 503 for unhealthy
      const httpStatus = result.status === 'unhealthy' ? 503 : 200;

      res.status(httpStatus).json(response);
    } catch (error) {
      next(error);
    }
  }

  // ─── GET /api/v1/metrics ────────────────────────────────────────────

  /**
   * Prometheus metrics endpoint handler.
   *
   * Delegates to `MetricsService.getMetrics()` which collects all registered
   * OpenTelemetry meter instruments and serializes them to Prometheus text
   * exposition format. Returns `text/plain` as required by the Prometheus
   * scrape protocol — NOT JSON.
   *
   * The response includes (per R37):
   * - HTTP request count and latency histograms
   * - WebSocket connection counts
   * - BullMQ queue depth and job processing metrics
   * - Database query latency percentiles
   *
   * @param _req  - Express request (unused — metrics have no request input)
   * @param res   - Express response used to send the plaintext metrics
   * @param next  - Express next function for error propagation to error-handler
   */
  async metrics(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const metricsOutput = await this.metricsService.getMetrics();

      // Prometheus expects text/plain with version=0.0.4 content type
      res
        .set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
        .status(200)
        .send(metricsOutput);
    } catch (error) {
      next(error);
    }
  }
}

// Default export for module consumers that prefer default imports
export default HealthController;
