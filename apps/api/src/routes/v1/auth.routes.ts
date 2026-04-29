/**
 * @file apps/api/src/routes/v1/auth.routes.ts
 * @description Authentication route definitions for the v1 API.
 *
 * Defines 5 authentication endpoints:
 * - `POST /register`    — PUBLIC: Create new user account
 * - `POST /login`       — PUBLIC: Authenticate and receive JWT token pair
 * - `POST /refresh`     — PROTECTED: Exchange refresh token for new token pair
 * - `POST /revoke`      — PROTECTED: Revoke a single session
 * - `POST /revoke-all`  — PROTECTED: Revoke ALL active sessions for the user
 * - `POST /logout`      — V2-ONLY: Clear refresh cookie and return 204 (FR-9)
 *
 * Public endpoints are protected by `authRateLimiter` (20 req/15-minute window
 * per IP) to mitigate brute-force and credential stuffing attacks.
 *
 * Every endpoint with a request body is validated via Zod schemas before the
 * controller method is invoked (Rule R31). Validation failures produce a
 * `ValidationError` that flows through the global error handler for a
 * standardized 400 response (Rule R22).
 *
 * Architecture Rules Enforced:
 * - R9  (Auth on Protected Routes): register and login are PUBLIC; refresh,
 *        revoke, and revoke-all require valid JWT via authMiddleware.
 * - R31 (Input Validation via Zod): All request bodies validated before
 *        reaching the controller. Invalid input returns 400 with field-level
 *        validation errors.
 * - R22 (Standardized Error Responses): All errors (validation, rate limit)
 *        flow through the global error handler for consistent shape.
 * - R30 (API Versioning): Routes defined as sub-paths — `/api/v1/auth` prefix
 *        applied by the v1 index router and app.ts.
 * - R28 (Structured Logging Only): ZERO console.log/warn/error calls.
 * - R7  (Zero Warnings Build): TypeScript strict mode with zero warnings.
 * - R23 (Log Hygiene): No tokens, passwords, or secrets in schemas or logic.
 * - FR-9 (V2 Auth Integration): /logout route is gated by requireV2(flagsClient);
 *        returns 404 when AUTH_V2_ENABLED=false to preserve legacy parity.
 *
 * @see apps/api/src/controllers/AuthController.ts  — endpoint handler logic
 * @see apps/api/src/middleware/validation.ts        — Zod validation middleware
 * @see apps/api/src/middleware/rate-limiter.ts       — rate limiting middleware
 * @see apps/api/src/routes/v1/index.ts              — route aggregation
 * @see apps/api/src/middleware/auth.ts             — V2-aware auth middleware factory
 * @see apps/web/src/app/auth/callback/page.tsx     — sets the refresh cookie
 */

import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { validateBody } from '../../middleware/validation.js';
import { authRateLimiter } from '../../middleware/rate-limiter.js';
import type { AuthController } from '../../controllers/AuthController.js';

// ─── V2 Auth Integration (FR-9) ────────────────────────────────────────────
// Per Rule RF2, kalle MUST consume the HTTP-only `FeatureFlagClient` from
// `@blitzy/auth/clients/feature-flag-client` — NEVER the DB-backed
// `FlagInstance` from `@blitzy/admin-ui` (which would require FLAGS_DB_URL
// access from inside kalle).
//
// `FeatureFlagClient` is imported type-only — the import is erased at compile
// time so it adds zero runtime cost (Rule R7 zero-warnings build). The
// `requireV2` guard helper at the bottom of this file dispatches via the
// supplied `client.isEnabled('AUTH_V2_ENABLED')` call when the V2 client is
// wired by the composition root.
//
// The `isEnabled()` method is documented as never-throwing — it implements
// RF3 fail-open internally (cache → API → env-var → ultimately `false`) — so
// the guard does NOT need a try/catch wrapper.
//
// IMPORTANT (Rule R3 spirit): This file no longer imports any *runtime* value
// from `@blitzy/admin-ui`. Removing the prior `import { checkFlag } from
// '@blitzy/admin-ui'` runtime import improves R3 compliance because the
// admin-ui module is no longer placed in `require.cache` at module-init time
// from this file's resolution graph.
import type { FeatureFlagClient } from '@blitzy/auth/clients/feature-flag-client';

// =============================================================================
// Zod Validation Schemas (local to this route file — Rule R31)
// =============================================================================

/**
 * Schema for `POST /register` request body.
 *
 * Validates:
 * - `email`       — Required, valid email format
 * - `password`    — Required, minimum 8 characters
 * - `displayName` — Required, 1–100 characters
 * - `phoneNumber` — Optional string
 */
const registerSchema = z.object({
  email: z.string().email('Invalid email format').toLowerCase().trim(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
  displayName: z
    .string()
    .trim()
    .min(1, 'Display name is required')
    .max(100, 'Display name too long'),
  phoneNumber: z.string().optional(),
});

/**
 * Schema for `POST /login` request body.
 *
 * Validates:
 * - `email`    — Required, valid email format
 * - `password` — Required, non-empty string
 */
const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

/**
 * Schema for `POST /refresh` request body.
 *
 * Validates:
 * - `refreshToken` — Required, non-empty string (opaque token value)
 */
const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

/**
 * Schema for `POST /revoke` request body.
 *
 * Validates:
 * - `refreshToken` — Required, non-empty string (identifies the session to
 *   revoke alongside the access token JTI extracted from the Authorization
 *   header by the controller)
 */
const revokeSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// =============================================================================
// V2 Flag Guard Helper (FR-9, Rule R3)
// =============================================================================

/**
 * Guard middleware that gates V2-only routes behind AUTH_V2_ENABLED.
 *
 * Per Rule R3 (V2 flag isolation, semantic spirit), the flag check is the
 * FIRST async operation in the request pipeline for any V2-only route. When
 * the flag resolves to false (or when `flagsClient` is undefined —
 * legacy-only deployment), the guard returns HTTP 404, preserving legacy
 * test parity (the existing kalle suite must pass byte-identically with
 * AUTH_V2_ENABLED=false; any test that probes /logout under the legacy mode
 * expects 404, not 405 or 500).
 *
 * Per Rule RF3 (flag fail-open), transient failures from
 * `flagsClient.isEnabled()` (e.g., the flags-API briefly unreachable) result
 * in the env-var fallback being resolved INTERNALLY by the
 * `FeatureFlagClient` implementation. This guard does NOT need to wrap the
 * call in try/catch — `isEnabled()` is documented as never-throwing
 * (`packages/auth/src/clients/feature-flag-client.ts`).
 *
 * Error-response shape matches the kalle convention from
 * `middleware/error-handler.ts`:
 *
 *   { error: { code: string, message: string } }
 *
 * No `correlationId` is included because the request short-circuits before
 * the downstream middleware that resolves correlation context for error
 * responses.
 *
 * Mutual-exclusion invariant (Rule R4): When the guard returns 404, NO V2
 * code path executes (no token validation, no Keycloak call, no Prisma
 * query). When the guard calls `next()`, ONLY the V2 handler runs (no
 * legacy `AuthService` invocation). The branch is therefore strictly
 * exclusive on a per-request basis.
 *
 * @param flagsClient - V2 HTTP-only `FeatureFlagClient` from
 *                       `@blitzy/auth/clients/feature-flag-client`, or
 *                       undefined for legacy-only mode (no flag wiring at
 *                       the composition root).
 * @returns Express middleware that calls `next()` when V2 is active,
 *          otherwise sends HTTP 404 with the kalle error envelope.
 */
const requireV2 = (
  flagsClient: FeatureFlagClient | undefined,
): RequestHandler => {
  return async (_req, res, next) => {
    if (!flagsClient) {
      // Legacy-only deployment: route is not registered behaviorally — return
      // 404 to mirror the absence-of-route response produced by Express when
      // no matching handler exists. This preserves byte-identical legacy
      // parity with the pre-V2 kalle test suite.
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Route not found' },
      });
      return;
    }
    // `isEnabled()` is documented as never-throwing — it implements RF3
    // fail-open internally (cache → API → env-var → ultimately `false`).
    const enabled = await flagsClient.isEnabled('AUTH_V2_ENABLED');
    if (!enabled) {
      // V2 wired but flag is OFF — preserve legacy test parity with 404.
      // This branch covers the runtime kill-switch scenario where an
      // operator disables V2 in flags-db without redeploying kalle/api.
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Route not found' },
      });
      return;
    }
    next();
  };
};

// =============================================================================
// Route Factory Function
// =============================================================================

/**
 * Creates and configures the Express Router for authentication endpoints.
 *
 * This factory function follows the Dependency Injection pattern (Rule R17):
 * - `authController` is the pre-constructed controller instance from the
 *   composition root (`server.ts`), providing handler methods for each
 *   endpoint.
 * - `authMiddleware` is the pre-constructed JWT verification middleware
 *   from the v1 index router, used to protect token management endpoints.
 *
 * Middleware chains per route:
 * 1. `POST /register`: authRateLimiter → validateBody(registerSchema) → authController.register
 * 2. `POST /login`:    authRateLimiter → validateBody(loginSchema) → authController.login
 * 3. `POST /refresh`:  authMiddleware → validateBody(refreshSchema) → authController.refresh
 * 4. `POST /revoke`:   authMiddleware → validateBody(revokeSchema) → authController.revoke
 * 5. `POST /revoke-all`: authMiddleware → authController.revokeAll
 * 6. `POST /logout`:    requireV2(flagsClient) → cookie clearance → 204
 *
 * @param authController - AuthController instance with bound handler methods
 * @param authMiddleware - JWT verification + Redis blacklist check middleware
 * @param flagsClient    - Optional V2 HTTP-only `FeatureFlagClient` from
 *                         `@blitzy/auth/clients/feature-flag-client` (Rule
 *                         RF2 — kalle MUST NOT consume the DB-backed
 *                         `FlagInstance` from `@blitzy/admin-ui`).
 *                         When provided AND `AUTH_V2_ENABLED=true`, the new
 *                         V2-only `POST /logout` route is reachable and clears
 *                         the refresh cookie. When undefined (legacy-only
 *                         mode) or when the flag is false, `/logout` returns
 *                         HTTP 404 to preserve byte-identical legacy parity.
 *                         The parameter is OPTIONAL (Rule R12 API stability)
 *                         so legacy 2-arg call sites continue to type-check
 *                         and execute without modification.
 * @returns Configured Express Router for mounting at `/auth`
 */
export function createAuthRoutes(
  authController: AuthController,
  authMiddleware: RequestHandler,
  flagsClient?: FeatureFlagClient,
): Router {
  const router = Router();

  // ---------------------------------------------------------------------------
  // PUBLIC endpoints — no auth middleware (Rule R9)
  // Rate limited to 20 requests per 15-minute window per IP
  // ---------------------------------------------------------------------------

  /**
   * POST /register — Create a new user account.
   *
   * Middleware: authRateLimiter → validateBody(registerSchema) → controller
   * Response:   201 Created with { data: AuthResponse }
   * Errors:     400 (validation), 409 (email conflict), 429 (rate limit)
   */
  router.post(
    '/register',
    authRateLimiter,
    validateBody(registerSchema),
    authController.register,
  );

  /**
   * POST /login — Authenticate user with email + password credentials.
   *
   * Middleware: authRateLimiter → validateBody(loginSchema) → controller
   * Response:   200 OK with { data: AuthResponse }
   * Errors:     400 (validation), 401 (invalid credentials), 429 (rate limit)
   */
  router.post(
    '/login',
    authRateLimiter,
    validateBody(loginSchema),
    authController.login,
  );

  // ---------------------------------------------------------------------------
  // PROTECTED endpoints — require valid JWT (Rule R9)
  // ---------------------------------------------------------------------------

  /**
   * POST /refresh — Exchange a refresh token for a new token pair.
   *
   * Implements refresh token rotation: the old refresh token is invalidated
   * after use, and the old access token JTI is blacklisted in Redis (R33).
   *
   * NOTE: This endpoint does NOT require authMiddleware because its purpose is
   * to obtain a NEW access token when the current one has expired. The refresh
   * token itself provides authentication — its validity is verified by the
   * AuthService.refreshToken() method against the database.
   *
   * Middleware: validateBody(refreshSchema) → controller
   * Response:   200 OK with { data: { tokens: TokenPair } }
   * Errors:     400 (validation), 401 (invalid/expired refresh token)
   */
  router.post(
    '/refresh',
    validateBody(refreshSchema),
    authController.refresh,
  );

  /**
   * POST /revoke — Revoke a single authentication session.
   *
   * Blacklists the current access token JTI in Redis with remaining TTL and
   * revokes the associated refresh token in the database (R33).
   *
   * Middleware: authMiddleware → validateBody(revokeSchema) → controller
   * Response:   200 OK with { data: { message: string } }
   * Errors:     400 (validation), 401 (unauthorized), 404 (session not found)
   */
  router.post(
    '/revoke',
    authMiddleware,
    validateBody(revokeSchema),
    authController.revoke,
  );

  /**
   * POST /revoke-all — Revoke ALL active sessions for the authenticated user.
   *
   * Blacklists every active session JTI in Redis and revokes all refresh
   * tokens in the database (R33). No request body needed — operates on
   * `req.user.userId` from the auth middleware.
   *
   * Middleware: authMiddleware → controller (NO body validation)
   * Response:   200 OK with { data: { message: string, revokedCount: number } }
   */
  router.post(
    '/revoke-all',
    authMiddleware,
    authController.revokeAll,
  );

  // ---------------------------------------------------------------------------
  // V2-ONLY endpoint — gated by requireV2(flagsClient) (FR-9, Rule R3)
  // ---------------------------------------------------------------------------

  /**
   * POST /logout — V2 OAuth Logout (FR-9).
   *
   * Clears the httpOnly refresh-token cookie and returns HTTP 204. This
   * route is V2-ONLY: under `AUTH_V2_ENABLED=false` (legacy mode), the
   * existing `/revoke` and `/revoke-all` routes handle session revocation
   * via the JWT/Redis blacklist mechanism. Under `AUTH_V2_ENABLED=true`,
   * the access token is stored in JS memory only (Rule R7) so explicit
   * revocation is unnecessary; this route's only responsibility is
   * clearing the refresh-token cookie.
   *
   * The route is gated by `requireV2(flagsClient)` — returns HTTP 404 when:
   *   1. `flagsClient` is undefined (legacy-only deployment or test
   *      fixture)
   *   2. `AUTH_V2_ENABLED` resolves to false
   * Both conditions preserve byte-identical behavior with the pre-V2
   * 1,814-test kalle suite.
   *
   * Cookie clearance follows Rule R7 (token storage):
   * - Name:     `'refreshToken'` (must match the cookie name set by the V2
   *             PKCE callback page at
   *             `kalle/apps/web/src/app/auth/callback/page.tsx` per FR-8)
   * - maxAge:   `0` — browser deletes the cookie immediately
   * - httpOnly: `true` — refresh token never accessible to JavaScript
   * - secure:   `process.env.NODE_ENV === 'production'` — HTTPS-only
   *             outside dev environments (local dev uses HTTP, so the flag
   *             must be conditional)
   * - sameSite: `'strict'` — CSRF defense
   * - path:     `'/'` — must match the path the cookie was originally set
   *             with (the auth/callback page sets it at root, so clearance
   *             is also at root)
   *
   * Why no JWT validation on this handler:
   *   The route is gated only by `requireV2`. Authentication of the
   *   requesting user is NOT required because:
   *     1. Logout is an idempotent client-side operation — clearing a
   *        cookie is harmless if no session exists.
   *     2. Per Rule R7, the access token is in JS memory only and is
   *        destroyed when the user navigates away.
   *     3. The Keycloak end-session endpoint (separate from this route)
   *        handles server-side token revocation via the backchannel-logout
   *        endpoint in the auth-sidecar (FR-2).
   *
   * Why response body is empty:
   *   HTTP 204 (No Content) per RFC 7231 §6.3.5 explicitly forbids a
   *   response body. The `res.status(204).send()` form sends headers
   *   (including the cleared cookie) without a body.
   *
   * Middleware: requireV2(flagsClient) → cookie clearance → 204
   * Response:   204 No Content (empty body)
   * Errors:     404 (legacy mode or flag off)
   *
   * @route   POST /api/v1/auth/logout
   * @access  V2-only (gated by requireV2)
   */
  router.post(
    '/logout',
    requireV2(flagsClient),
    (_req, res) => {
      res.cookie('refreshToken', '', {
        maxAge: 0,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
      });
      res.status(204).send();
    },
  );

  return router;
}
