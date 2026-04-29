/**
 * @file apps/api/src/app.ts
 * @description Express application factory with ordered middleware chain.
 *
 * Creates and configures the Express app instance with the complete middleware
 * pipeline. This is NOT the composition root — it receives pre-constructed
 * dependencies from server.ts and assembles the Express middleware chain in
 * the correct order.
 *
 * **Middleware ordering is critical.** Steps are numbered 1–13 and must remain
 * in the documented order for correct behavior (correlation IDs available to
 * the logger, metrics measured around routes, error handler is the final
 * catch-all, etc.).
 *
 * **V2 Auth Awareness (FR-9):** This factory is V2-flag-agnostic. The V2-aware
 * auth middleware swap (legacy JWT/blacklist ↔ @blitzy/auth's createExpressMiddleware)
 * is handled INSIDE the v1Router constructed by routes/v1/index.ts. By the time
 * v1Router reaches this factory in `deps.v1Router`, the per-request flag check
 * (AUTH_V2_ENABLED) and mutual-exclusion branching have already been bound to
 * each protected route. This factory simply mounts v1Router at `/api/v1` —
 * the V2 flag is invisible at this layer (Rule R4 mutual exclusion is enforced
 * at the middleware level, not the factory level).
 *
 * The `authInstance` and `flagsClient` properties on `AppDependencies` are
 * therefore documentary: they exist so `server.ts` can route the pre-built
 * V2 dependency container through to `routes/v1/index.ts`'s factory. This
 * file consumes neither at runtime — the only references are at the TypeScript
 * type level via `import type` (which emits zero runtime code).
 *
 * **HTTP-only flag client (Rule RF2):** The kalle composition root constructs
 * a `FeatureFlagClient` (HTTP-only, from `@blitzy/auth/clients/feature-flag-client`)
 * — NOT a DB-backed `FlagInstance` from `@blitzy/admin-ui`. This enforces
 * Rule RF2 (kalle MUST NOT reference `FLAGS_DB_URL` or import from `@blitzy/admin-ui`
 * at runtime). The HTTP client reads `AUTH_V2_ENABLED` via `GET ${FLAGS_API_URL}/flags/...`,
 * caches with TTL `FLAGS_CACHE_TTL_MS`, and falls back to `process.env.AUTH_V2_ENABLED`
 * on API failure (Rule RF3 fail-open). The client is created in `server.ts` via
 * `createFeatureFlagClient(...)` and injected through `flagsClient` here.
 *
 * Architecture Rules Enforced:
 * - R3  (V2 Flag Isolation): V2-aware mounting happens in v1Router; this factory
 *       is V2-agnostic. With AUTH_V2_ENABLED=false, no @blitzy/auth code executes.
 * - R4  (Mutual Exclusion): Enforced inside middleware/auth.ts; this factory only
 *       mounts the pre-built v1Router which contains the resolved branch.
 * - R8  (Media Upload Validation): Body parser limit set to 26 MB (25 MB + overhead)
 * - R16 (OOD Layering): Pure factory — zero service/repository/provider instantiation
 * - R17 (Interface-Driven): Receives pre-wired dependencies, never imports concretes
 * - R22 (Standardized Error Responses): Error handler last; 404 uses standard shape
 * - R28 (Structured Logging Only): Zero console.log calls; all logging via Pino
 * - R29 (Correlation ID): Middleware applied before logger and routes
 * - R30 (API Versioning): All routes mounted under /api/v1/ prefix
 * - R31 (Input Validation): Applied at route level, not globally here
 * - R37 (Metrics Endpoint): Metrics middleware instruments HTTP request cycles
 */

import express from 'express';
import type { Application, Router, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';

import { correlationIdMiddleware } from './middleware/correlation-id';
import { createMetricsMiddleware } from './middleware/metrics';
import { errorHandler } from './middleware/error-handler';
import type { MetricsService } from './services/MetricsService';

// ─── V2 Library Type Imports (FR-1, FR-9, Rule RF2) ──────────────────────────────
// Type-only imports for the V2 auth library instance type and the HTTP-only
// feature flag client type. These are referenced by the optional `authInstance`
// and `flagsClient` props on AppDependencies. Although `app.ts` does NOT directly
// use these libraries (the V2-aware auth middleware is bound INSIDE v1Router by
// routes/v1/index.ts), the type definitions are surfaced here so that server.ts
// can pass the instances through AppDependencies for forward-compatibility and to
// make the V2 integration self-documenting at the type system level.
//
// **Rule RF2 mandate:** kalle MUST NOT import from `@blitzy/admin-ui` (which is
// DB-backed and requires `FLAGS_DB_URL`). Instead, kalle uses the HTTP-only
// `FeatureFlagClient` from the `@blitzy/auth/clients/feature-flag-client` subpath
// export, which talks to the flags API over HTTP and never opens a Postgres
// connection. This enforces the dual-database boundary (Rule RF2): only the
// `admin-ui` server process holds `FLAGS_DB_URL`; kalle and Odoo only see HTTP.
//
// The `import type` syntax guarantees these emit zero runtime code (Rule R7
// zero-warnings build): the resulting JavaScript contains no `require`/`import`
// statement for `@blitzy/auth` from this file. This preserves Rule R3 (V2 flag
// isolation) — with AUTH_V2_ENABLED=false, no V2 library code is loaded into
// the require.cache when this module is evaluated, because TypeScript erases
// type-only imports at emit time.
import type { AuthInstance } from '@blitzy/auth';
import type { FeatureFlagClient } from '@blitzy/auth/clients/feature-flag-client';

// ---------------------------------------------------------------------------
// AppDependencies Interface
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into the Express application factory by the
 * composition root (`server.ts`).
 *
 * This interface enforces the dependency inversion principle — the factory
 * receives pre-configured middleware instances and a fully assembled router
 * rather than constructing them internally. This keeps the factory pure and
 * testable: in unit tests, every dependency can be replaced with a test double.
 *
 * **Why these three?**
 * - `corsOptions`: Derived from the `CORS_ORIGIN` environment variable via
 *   `config/cors.ts`. Varies per deployment (dev vs staging vs prod).
 * - `v1Router`: Fully assembled by `routes/v1/index.ts` with all controllers,
 *   auth middleware, and route-level validation already bound. The factory
 *   merely mounts it under the `/api/v1` prefix.
 * - `pinoHttpMiddleware`: Created by `server.ts` with a Pino logger instance
 *   configured for JSON output, authorization header redaction (Rule R23),
 *   and correlation-ID-based request identification.
 */
export interface AppDependencies {
  /**
   * CORS configuration options derived from the `CORS_ORIGIN` environment
   * variable via `config/cors.ts`. Applied as middleware step 2 to control
   * which origins may access the API.
   */
  corsOptions: cors.CorsOptions;

  /**
   * Fully assembled v1 API router with all controllers and route handlers
   * bound. Created by `routes/v1/index.ts` with controller dependencies
   * injected by `server.ts`. Mounted under the `/api/v1` prefix (Rule R30).
   *
   * Auth middleware and rate limiter are applied at individual route level
   * within this router — NOT globally in this factory.
   */
  v1Router: Router;

  /**
   * Pre-configured pino-http middleware instance for structured HTTP request
   * logging (Rule R28). Created by `server.ts` with a Pino logger configured
   * for JSON output and authorization header redaction (Rule R23).
   *
   * Placed AFTER the correlation ID middleware (step 7) so that
   * `req.correlationId` is available when the logger generates the log
   * entry's request identifier.
   */
  pinoHttpMiddleware: express.RequestHandler;

  /**
   * MetricsService instance for Prometheus-compatible HTTP request
   * instrumentation (Rule R37). Used by createMetricsMiddleware() to record
   * request counts, duration histograms, and active request gauges.
   *
   * Created by `server.ts` and passed here to wire the Prometheus exporter
   * into the HTTP middleware chain at step 9.
   */
  metricsService: MetricsService;

  /**
   * Absolute or relative path to the directory containing uploaded files.
   * Served as static files at the `/uploads` prefix with Cross-Origin-Resource-Policy
   * set to 'cross-origin' for cross-origin image loading from the frontend.
   */
  uploadDir: string;

  /**
   * V2 auth library instance constructed by `server.ts` via `initAuth(...)` from
   * `@blitzy/auth`. Optional: only set when V2 OAuth integration is wired (FR-1, FR-9).
   *
   * **Note:** This factory does NOT use this property directly. It is surfaced on
   * `AppDependencies` for forward-compatibility and documentation. The V2-aware
   * auth middleware is bound INSIDE `v1Router` (constructed in `routes/v1/index.ts`
   * by `server.ts` BEFORE being passed to this factory). The actual mount site is
   * the `routes/v1/index.ts` factory, NOT this `app.ts` factory.
   *
   * In sidecar mode (kalle), this instance was constructed WITHOUT a `dbUrl` —
   * token-to-user resolution is delegated via HTTP to ${AUTH_SERVICE_URL}/validate
   * (Rule R2 — auth DB boundary).
   *
   * Set by `server.ts` and forwarded to `createV1Router` for use by the V2-aware
   * `createAuthMiddleware` factory in `middleware/auth.ts`.
   *
   * @see ./middleware/auth.ts — V2-aware createAuthMiddleware factory
   * @see ./routes/v1/index.ts — actual V2 auth-middleware mount site
   * @see ../../../packages/auth/README.md — initAuth() public API contract
   */
  authInstance?: AuthInstance;

  /**
   * HTTP-only feature flag client constructed by `server.ts` via
   * `createFeatureFlagClient(...)` from `@blitzy/auth/clients/feature-flag-client`.
   * Optional: only set when V2 feature flag integration is wired
   * (FR-4, FR-9, Rule RF2).
   *
   * **Note:** This factory does NOT use this property directly. It is surfaced
   * for forward-compatibility and documentation. The flag check (`AUTH_V2_ENABLED`)
   * happens INSIDE the v1Router's per-route auth middleware (in `middleware/auth.ts`
   * via the V2-aware `createAuthMiddleware({ authInstance, flagsClient, legacyAuthHandler })`
   * factory) and inside the V2-only `requireV2(flagsClient)` guard in `auth.routes.ts`.
   *
   * **Rule RF2 (Flags DB Boundary):** kalle MUST NOT reference `FLAGS_DB_URL`
   * or import the DB-backed `FlagInstance` from `@blitzy/admin-ui`. Instead,
   * the HTTP-only `FeatureFlagClient` is used, which:
   *   - Calls `GET ${FLAGS_API_URL}/flags/:name` over HTTP (never opens Postgres).
   *   - Caches results in-process with TTL `FLAGS_CACHE_TTL_MS` (default 5000 ms).
   *   - Falls back to `process.env.AUTH_V2_ENABLED` on API failure
   *     (Rule RF3 — flag fail-open).
   *   - Exposes async `isEnabled()`, sync `isEnabledSync()`, `invalidate()`, and
   *     `close()` methods (the latter for graceful shutdown).
   *
   * **Mode behavior:**
   *   - When `FLAGS_API_URL`/`FLAGS_API_SECRET` env vars are set at boot, server.ts
   *     constructs a real `FeatureFlagClient` and injects it here.
   *   - When V2 env vars are absent (legacy-only deployment), this is `undefined`
   *     and the V2-aware middleware factory falls back to legacy mode immediately.
   *
   * @see ./middleware/auth.ts — V2-aware createAuthMiddleware factory + flag check
   * @see ./routes/v1/auth.routes.ts — requireV2(flagsClient) guard for /logout
   * @see ../../../packages/auth/src/clients/feature-flag-client.ts — public API
   */
  flagsClient?: FeatureFlagClient;
}

// ---------------------------------------------------------------------------
// createApp — Express Application Factory
// ---------------------------------------------------------------------------

/**
 * Creates and configures the Express application with the complete ordered
 * middleware chain.
 *
 * **Middleware chain (13 steps — order is CRITICAL):**
 *
 * | # | Middleware              | Purpose                                    |
 * |---|------------------------|--------------------------------------------|
 * | 1 | Trust proxy            | Correct IP behind Docker / reverse proxy   |
 * | 2 | CORS                   | Cross-origin access control                |
 * | 3 | Helmet                 | Security headers                           |
 * | 4 | Compression            | gzip / deflate response compression        |
 * | 5 | JSON body parsing      | Parse JSON bodies (26 MB limit, Rule R8)   |
 * | 6 | URL-encoded parsing    | Parse URL-encoded bodies (same limit)      |
 * | 7 | Correlation ID         | UUID v4 per request (Rule R29)             |
 * | 8 | Pino HTTP logger       | Structured request logging (Rule R28)      |
 * | 9 | Metrics                | HTTP instrumentation (Rule R37)            |
 * |10 | Static uploads         | Serve /uploads with CORP header            |
 * |11 | API v1 routes          | All versioned endpoints (Rule R30)         |
 * |12 | 404 catch-all          | Unmatched routes (Rule R22)                |
 * |13 | Error handler          | Global error handler — MUST be last (R22)  |
 *
 * @param deps - Pre-configured dependencies from the composition root
 * @returns Fully configured Express Application instance ready for
 *          `http.createServer(app)` in `server.ts`.
 */
export function createApp(deps: AppDependencies): Application {
  const app = express();

  // -------------------------------------------------------------------------
  // Step 1: Trust proxy
  //
  // Required when running behind Docker's bridge network or a reverse proxy
  // (e.g. nginx). Ensures `req.ip`, `req.protocol`, and `req.hostname`
  // reflect the original client values via X-Forwarded-* headers.
  // The value `1` trusts exactly one proxy hop.
  // -------------------------------------------------------------------------
  app.set('trust proxy', 1);

  // -------------------------------------------------------------------------
  // Step 2: CORS — Cross-Origin Resource Sharing
  //
  // Applied before any route handlers so preflight OPTIONS requests are
  // handled correctly. Configuration derived from the CORS_ORIGIN env var
  // via config/cors.ts (e.g. http://localhost:3000 for Docker dev).
  // -------------------------------------------------------------------------
  app.use(cors(deps.corsOptions));

  // -------------------------------------------------------------------------
  // Step 3: Helmet — Security Headers
  //
  // Sets HTTP security headers with sensible defaults:
  // - X-Content-Type-Options: nosniff
  // - Strict-Transport-Security (HSTS)
  // - X-Frame-Options: SAMEORIGIN
  // - X-XSS-Protection (legacy header)
  // - Content-Security-Policy defaults
  // -------------------------------------------------------------------------
  app.use(helmet());

  // -------------------------------------------------------------------------
  // Step 4: Compression — Response Compression
  //
  // Compresses HTTP responses using gzip/deflate. Applied before routes so
  // all API responses benefit from reduced bandwidth. Automatically skips
  // compression for responses where it's not beneficial (e.g. small payloads,
  // already-compressed formats).
  // -------------------------------------------------------------------------
  app.use(compression());

  // -------------------------------------------------------------------------
  // Step 5: JSON Body Parsing
  //
  // Parses incoming JSON request bodies. The limit is set to 26 MB to
  // accommodate the 25 MB encrypted media upload size limit (Rule R8) plus
  // protocol overhead (base64 encoding, metadata envelope).
  //
  // Express body-parser returns 413 (Payload Too Large) when the limit is
  // exceeded. The global error handler (step 13) translates this into the
  // standardized error response shape.
  // -------------------------------------------------------------------------
  app.use(express.json({ limit: '26mb' }));

  // -------------------------------------------------------------------------
  // Step 6: URL-Encoded Body Parsing
  //
  // Parses URL-encoded form data with the same size limit as JSON. The
  // `extended: true` option enables rich objects and arrays (qs library
  // parsing) rather than simple key-value pairs.
  // -------------------------------------------------------------------------
  app.use(express.urlencoded({ extended: true, limit: '26mb' }));

  // -------------------------------------------------------------------------
  // Step 7: Correlation ID — UUID v4 Per Request (Rule R29)
  //
  // Assigns a unique UUID v4 correlation ID to every request, sets the
  // X-Correlation-ID response header, and attaches `req.correlationId` for
  // downstream consumers. If the client sends an X-Correlation-ID header,
  // it is reused for cross-service tracing.
  //
  // MUST be registered BEFORE the logger (step 8) so that the Pino HTTP
  // middleware can use `req.correlationId` as the log request identifier.
  // -------------------------------------------------------------------------
  app.use(correlationIdMiddleware);

  // -------------------------------------------------------------------------
  // Step 8: Pino HTTP Logger — Structured Request Logging (Rule R28)
  //
  // Logs every HTTP request/response cycle as structured JSON. Uses the
  // correlation ID set by step 7 as the log entry's request identifier.
  // Configured by server.ts with authorization header redaction (Rule R23)
  // and custom log levels (5xx → error, 4xx → warn, 2xx/3xx → info).
  // -------------------------------------------------------------------------
  app.use(deps.pinoHttpMiddleware);

  // -------------------------------------------------------------------------
  // Step 9: HTTP Metrics Instrumentation (Rule R37)
  //
  // Instruments HTTP request/response cycles for Prometheus-compatible
  // metrics using the injected MetricsService instance. The factory
  // createMetricsMiddleware() wires the middleware directly to MetricsService's
  // OpenTelemetry instruments (counters, histograms, gauges), ensuring all
  // HTTP metrics flow through a single MeterProvider and reach the
  // /api/v1/metrics Prometheus scrape endpoint.
  //
  // Tracks: http_requests_total (counter), http_request_duration_seconds
  // (histogram), http_active_requests (gauge) — all with normalised
  // route labels to prevent high-cardinality label explosion.
  //
  // Placed after the logger so that logging occurs even if metrics recording
  // fails, and before routes so the duration measurement captures the full
  // route handler execution time.
  // -------------------------------------------------------------------------
  app.use(createMetricsMiddleware(deps.metricsService));

  // -------------------------------------------------------------------------
  // Step 10: Static File Serving — Uploaded Media Assets
  //
  // Serves the uploads directory as static files at the /uploads prefix.
  // An inline middleware sets Cross-Origin-Resource-Policy: cross-origin on
  // EVERY response (including 404s) so the frontend at a different origin
  // can load images and media without CORS blocks.
  // -------------------------------------------------------------------------
  app.use('/uploads', (_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  }, express.static(deps.uploadDir));

  // -------------------------------------------------------------------------
  // Step 11: API Routes — All Versioned Endpoints (Rule R30)
  //
  // Mounts the fully assembled v1 router under the /api/v1 prefix. The
  // router contains all route handlers with auth middleware, rate limiting,
  // and Zod validation middleware applied at individual route level.
  //
  // Auth middleware (./middleware/auth) and rate limiter (./middleware/rate-
  // limiter) are NOT applied globally — they are bound per-route inside
  // the v1Router to allow unauthenticated endpoints (e.g. /auth/register,
  // /auth/login, /health) and per-endpoint rate limit tuning.
  //
  // V2 OAuth Dispatch (FR-9, R3, R4, RF2): The auth middleware bound inside
  // v1Router uses the V2-aware createAuthMiddleware({ authInstance,
  // flagsClient, legacyAuthHandler }) factory from middleware/auth.ts.
  // Per-request, the factory reads AUTH_V2_ENABLED via the HTTP-only
  // FeatureFlagClient (cache → flags-API → process.env fallback per Rule RF3)
  // and dispatches to either the legacy JWT/blacklist handler (V1) or
  // @blitzy/auth's createExpressMiddleware (V2). Rule R4 guarantees the
  // two paths are mutually exclusive on a per-request basis. Rule RF2
  // ensures kalle never opens a Postgres connection to FLAGS_DB — only
  // HTTP to the flags API. This factory mounts v1Router OPAQUELY — the
  // flag is invisible at this layer.
  // -------------------------------------------------------------------------
  app.use('/api/v1', deps.v1Router);

  // -------------------------------------------------------------------------
  // Step 12: 404 Catch-All Handler
  //
  // Catches all requests that did not match any route in step 11. Returns
  // the standardized error response shape (Rule R22) so clients receive
  // consistent error payloads regardless of the error type.
  // -------------------------------------------------------------------------
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
        ...(req.correlationId !== undefined && { correlationId: req.correlationId }),
      },
    });
  });

  // -------------------------------------------------------------------------
  // Step 13: Global Error Handler — MUST BE LAST (Rule R22)
  //
  // Express identifies error-handling middleware by its 4-argument signature
  // (err, req, res, next). This middleware catches all errors thrown by
  // upstream middleware and route handlers, maps DomainError subclasses to
  // their corresponding HTTP status codes, and returns the standardized
  // error response shape with correlation ID.
  //
  // Error categories handled:
  // - DomainError hierarchy → mapped HTTP status (400, 401, 403, 404, etc.)
  // - Uncaught ZodError → 400 with field-level details
  // - Express body-parser errors → 400 (malformed JSON) or 413 (too large)
  // - Unknown errors → 500 (generic message, never expose internals)
  //
  // CRITICAL: This MUST be the LAST app.use() call. Middleware registered
  // after the error handler will never execute for error cases.
  // -------------------------------------------------------------------------
  app.use(errorHandler);

  return app;
}
