/**
 * @file apps/api/src/routes/v1/health.routes.ts
 * @description Health check and Prometheus metrics route definitions.
 *
 * Both endpoints are PUBLIC — no authentication middleware (Rule R9 exception).
 * No rate limiting is applied to prevent false-positive monitoring alerts.
 * No request body/query validation needed (stateless GET endpoints).
 *
 * Architecture rules enforced:
 * - R9  (Auth Exception):       Health and metrics are the only public GET endpoints.
 * - R37 (Metrics Endpoint):     /api/v1/metrics exposes Prometheus-compatible text metrics.
 * - R30 (API Versioning):       Sub-paths only — mounted by v1 index router.
 * - R28 (Structured Logging):   Zero console.log / console.warn / console.error calls.
 * - R7  (Zero Warnings Build):  Compiles under tsc --noEmit --strict with zero warnings.
 *
 * @module health.routes
 */

import { Router } from 'express';
import type { HealthController } from '../../controllers/HealthController';

// ---------------------------------------------------------------------------
// createHealthRoutes — Health check router factory
// ---------------------------------------------------------------------------

/**
 * Creates an Express Router for the component-level health check endpoint.
 *
 * The returned router exposes a single route:
 *   **GET /** → `/api/v1/health` (when mounted by `index.ts`)
 *
 * Response semantics (handled by {@link HealthController.check}):
 * - HTTP 200 — overall status is `'healthy'` or `'degraded'`
 * - HTTP 503 — overall status is `'unhealthy'`
 *
 * **No auth middleware** — Docker health checks, Kubernetes probes,
 * load balancers, and monitoring systems must reach this endpoint
 * without a valid JWT (Rule R9).
 *
 * **No rate limiter** — Health endpoints must always respond to prevent
 * false-positive alerts from orchestration tooling.
 *
 * @param healthController - Injected HealthController instance from the
 *   composition root (`server.ts`). Provides the `check` handler method.
 * @returns Configured Express Router with one GET endpoint.
 *
 * @example
 * ```typescript
 * // In apps/api/src/routes/v1/index.ts:
 * router.use('/health', createHealthRoutes(deps.healthController));
 * ```
 */
export function createHealthRoutes(
  healthController: HealthController,
): Router {
  const router = Router();

  // GET / — Component-level health check (→ /api/v1/health)
  // Returns: { data: { status, version, uptime, components: { database, redis, queue, storage } } }
  // HTTP 200 for healthy/degraded, HTTP 503 for unhealthy
  router.get('/', healthController.check);

  return router;
}

// ---------------------------------------------------------------------------
// createMetricsRoute — Prometheus metrics router factory
// ---------------------------------------------------------------------------

/**
 * Creates an Express Router for the Prometheus-compatible metrics endpoint.
 *
 * The returned router exposes a single route:
 *   **GET /** → `/api/v1/metrics` (when mounted by `index.ts`)
 *
 * Response semantics (handled by {@link HealthController.metrics}):
 * - HTTP 200 with `Content-Type: text/plain; version=0.0.4; charset=utf-8`
 * - Body contains Prometheus text exposition format (Rule R37)
 *
 * Metrics include (per R37):
 * - HTTP request count and latency histograms
 * - WebSocket connection counts
 * - BullMQ queue depth and job processing metrics
 * - Database query latency percentiles
 *
 * **No auth middleware** — Prometheus scrape targets must be reachable
 * without bearer tokens (Rule R9).
 *
 * **No rate limiter** — Monitoring scrape intervals must not be throttled.
 *
 * @param healthController - Injected HealthController instance from the
 *   composition root (`server.ts`). Provides the `metrics` handler method.
 * @returns Configured Express Router with one GET endpoint.
 *
 * @example
 * ```typescript
 * // In apps/api/src/routes/v1/index.ts:
 * router.use('/metrics', createMetricsRoute(deps.healthController));
 * ```
 */
export function createMetricsRoute(
  healthController: HealthController,
): Router {
  const router = Router();

  // GET / — Prometheus-compatible metrics (→ /api/v1/metrics)
  // Content-Type: text/plain; version=0.0.4; charset=utf-8
  router.get('/', healthController.metrics);

  return router;
}
