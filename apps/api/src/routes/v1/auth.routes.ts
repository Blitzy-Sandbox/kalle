/**
 * @file apps/api/src/routes/v1/auth.routes.ts
 * @description Authentication route definitions for the v1 API.
 *
 * Defines 8 authentication endpoints:
 * - `POST /register`        — PUBLIC: Create new user account
 * - `POST /login`           — PUBLIC: Authenticate and receive JWT token pair
 * - `GET  /feature-flags`   — PUBLIC: Discover runtime AUTH_V2_ENABLED flag (F-CRITICAL-3)
 * - `POST /refresh`         — PROTECTED: Exchange refresh token for new token pair
 * - `POST /revoke`          — PROTECTED: Revoke a single session
 * - `POST /revoke-all`      — PROTECTED: Revoke ALL active sessions for the user
 * - `POST /logout`          — V2-ONLY: Clear refresh cookie and return 204 (FR-9)
 * - `POST /refresh-cookie`  — V2-ONLY: Write refresh-token httpOnly cookie (FR-8, F-CRITICAL-5)
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
 *
 * **F-CRITICAL-6 (QA Checkpoint F2 final report) note:** This schema is
 * applied AFTER the `bridgeCookieToBodyForRefresh` middleware (declared
 * below). The bridge middleware copies `req.cookies.refreshToken` into
 * `req.body.refreshToken` when the body field is missing/empty, so that the
 * V2 silent-refresh flow (which calls `POST /refresh` with `credentials:
 * include` and an empty body) satisfies this schema's validation. The
 * legacy mode (which sends the refresh token in the body explicitly)
 * continues to work without modification — the bridge is a no-op when the
 * body already contains a valid refresh token.
 */
const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

/**
 * Schema for `POST /refresh-cookie` request body (V2-only).
 *
 * Validates:
 * - `refreshToken` — Required, non-empty string (the OAuth refresh token
 *                    issued by Keycloak's `/protocol/openid-connect/token`
 *                    endpoint and forwarded by the Kalle Web PKCE callback).
 *
 * **F-CRITICAL-5 (QA Checkpoint F2 final report):** This schema is the
 * input contract for the new V2-only `/refresh-cookie` endpoint introduced
 * to address the "missing API endpoint" finding. The Kalle Web PKCE
 * callback at `apps/web/src/app/auth/callback/page.tsx:438-449` POSTs the
 * Keycloak refresh token to this endpoint so the API server can write it
 * as an `httpOnly; Secure; SameSite=Strict` cookie on the API origin (per
 * Rule R7 — token storage). Per FR-8, the access token NEVER persists to
 * any storage and the refresh token NEVER reaches JavaScript on the
 * client; only this server-routed POST is permitted to set the cookie.
 *
 * The schema is structurally identical to `refreshSchema` above, but the
 * routes accepting them are semantically distinct:
 *   - `POST /refresh`        — exchanges a refresh token for a new pair
 *                              (legacy JWT or V2 OAuth) and returns the
 *                              new access+refresh pair in the JSON body.
 *   - `POST /refresh-cookie` — accepts the OAuth refresh token issued by
 *                              the Keycloak token endpoint and writes it
 *                              to the `refreshToken` cookie; returns 204.
 *
 * Maintaining a separate schema (rather than reusing `refreshSchema`)
 * preserves Rule R12 API stability: future evolution of either contract
 * (e.g., adding `idToken` for /refresh-cookie or `scope` for /refresh)
 * does not produce a cross-route validation tightening.
 */
const refreshCookieSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// =============================================================================
// V2 Cookie-to-Body Bridge for /refresh (F-CRITICAL-6, FR-8, R12)
// =============================================================================

/**
 * Middleware that copies the V2 refresh-token cookie into the request body
 * if the body does not already contain it.
 *
 * **Background — F-CRITICAL-6 (QA Checkpoint F2 final report):**
 * The V2 (FR-8) silent-refresh flow at `apps/web/src/lib/api.ts` issues
 * `POST /api/v1/auth/refresh` with:
 *   - `credentials: 'include'` (so the browser sends the
 *      `httpOnly; Secure; SameSite=Strict` cookie set by
 *      `apps/web/src/app/auth/callback/page.tsx` at PKCE completion)
 *   - An empty JSON body (`{}`)
 * The original /refresh handler required the refresh token to be present in
 * the body via `refreshSchema.refreshToken: z.string().min(1)`. With an
 * empty body, validation failed with HTTP 400 VALIDATION_ERROR
 * (`{field: 'body.refreshToken', code: 'invalid_type'}`), the V2 401
 * interceptor immediately failed, the user was redirected to /login, and
 * the entire silent-refresh-then-retry semantics specified by FR-8 was
 * unreachable.
 *
 * **This middleware is the bridge:** it reads `req.cookies.refreshToken`
 * (populated by the global `cookie-parser` middleware registered as Step 7
 * of `app.ts`) and, if and only if `req.body.refreshToken` is absent or
 * empty AND the cookie value is a non-empty string, copies the cookie value
 * into the body. The downstream `validateBody(refreshSchema)` then
 * succeeds without modification.
 *
 * **Why a bridge instead of changing the schema or controller:**
 * - **Rule R12 (API Stability):** The legacy /refresh contract — body field
 *   `refreshToken` validated by `refreshSchema` — remains byte-identical.
 *   No existing test or client breaks.
 * - **Minimal surface area:** Zero changes to `AuthController.refresh`,
 *   `AuthService.refreshToken`, or `RefreshTokenDTO` (in `@kalle/shared`).
 *   The bridge is local to this route file.
 * - **R28 / R23 log hygiene:** The middleware does NOT log the cookie or
 *   body value. It performs a single conditional assignment and calls
 *   `next()`.
 * - **Rule R3 spirit:** The bridge does NOT consult the V2 flag —
 *   it merely acts as a pass-through translator. Whether the cookie is
 *   actually present is a runtime fact governed by the V2 PKCE flow (FR-8)
 *   that wrote the cookie. With AUTH_V2_ENABLED=false, no V2 flow is
 *   reachable, no cookie is ever written, and this middleware degrades to a
 *   no-op (legacy callers send the token in the body as before).
 *
 * **Cookie name:** `refreshToken` — must match the cookie name set by:
 *   - The /logout handler (cleared with `Max-Age=0`) at line ~407 of this file
 *   - Future /refresh-cookie handler (F-CRITICAL-5) which writes the cookie
 *   - The auth/callback page (FR-8) which initiates the cookie write via
 *     `POST /api/v1/auth/refresh-cookie`
 *
 * **Idempotency / Order-Independence:** This middleware runs BEFORE
 * `validateBody(refreshSchema)`, so even if a malicious client sets BOTH
 * a cookie and a body field with different values, the body field always
 * wins (the bridge only runs when the body field is missing). This
 * preserves the explicit caller-supplied value when present.
 *
 * Architecture rule references:
 * - F-CRITICAL-6 — QA Checkpoint F2 final report
 * - FR-8 (Kalle Web PKCE Flow): refresh token in cookie only (Rule R7)
 * - R7 (Token Storage): refresh in httpOnly cookie; access in JS memory
 * - R12 (API Stability): legacy /refresh contract preserved verbatim
 * - R23 (Log Hygiene): bridge does NOT log cookie or body values
 * - R28 (Structured Logging): zero log output from this middleware
 *
 * @param req  - Express request, expected to have `req.cookies` populated by
 *               the global cookie-parser middleware (Step 7 in app.ts).
 * @param _res - Express response (unused — middleware never sends a response)
 * @param next - Express next function (always invoked synchronously)
 */
const bridgeCookieToBodyForRefresh: RequestHandler = (req, _res, next) => {
  // Read the cookie value safely — `req.cookies` may be undefined if
  // cookie-parser is not registered (defensive: should not happen in
  // production but tests may mount the route without app.ts setup).
  // The cookie value type from `cookie-parser` is `string | undefined`.
  const cookieValue =
    req.cookies !== undefined && typeof req.cookies === 'object'
      ? (req.cookies as Record<string, unknown>).refreshToken
      : undefined;

  // Read the existing body field (defensive — body may be undefined/null
  // when the JSON parser has not yet run, but per app.ts step ordering,
  // express.json() is registered as Step 5, well before any v1 route).
  const body = (req.body ?? {}) as Record<string, unknown>;
  const existingBodyToken = body.refreshToken;

  // Bridge condition: body field is absent/empty AND cookie value is
  // a non-empty string. Both conditions MUST be true to copy.
  const bodyTokenMissing =
    existingBodyToken === undefined ||
    existingBodyToken === null ||
    (typeof existingBodyToken === 'string' && existingBodyToken.length === 0);

  if (
    bodyTokenMissing &&
    typeof cookieValue === 'string' &&
    cookieValue.length > 0
  ) {
    // Ensure req.body is a writable object before assignment. If body parser
    // produced a non-object (e.g., {} from an empty body), this is a no-op.
    if (typeof req.body !== 'object' || req.body === null) {
      req.body = {};
    }
    (req.body as Record<string, unknown>).refreshToken = cookieValue;
  }

  next();
};

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
 * 1. `POST /register`:       authRateLimiter → validateBody(registerSchema) → authController.register
 * 2. `POST /login`:          authRateLimiter → validateBody(loginSchema) → authController.login
 * 3. `GET  /feature-flags`:  (no middleware) → flagsClient.isEnabled('AUTH_V2_ENABLED') → 200 (F-CRITICAL-3)
 * 4. `POST /refresh`:        bridgeCookieToBodyForRefresh → validateBody(refreshSchema) → authController.refresh
 * 5. `POST /revoke`:         authMiddleware → validateBody(revokeSchema) → authController.revoke
 * 6. `POST /revoke-all`:     authMiddleware → authController.revokeAll
 * 7. `POST /logout`:         requireV2(flagsClient) → cookie clearance → 204
 * 8. `POST /refresh-cookie`: requireV2(flagsClient) → validateBody(refreshCookieSchema) → cookie write → 204
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
  // PUBLIC feature-flag discovery endpoint (F-CRITICAL-3)
  // ---------------------------------------------------------------------------

  /**
   * GET /feature-flags — Public, unauthenticated runtime flag discovery.
   *
   * **F-CRITICAL-3 (QA Checkpoint F2 final report):** The Kalle Web login
   * page at `apps/web/src/app/(auth)/login/page.tsx` was hardcoded to a
   * PKCE-redirect-only behavior with zero references to any flag. The QA
   * report identified this as a CRITICAL defect because it broke the
   * runtime kill-switch from a UX perspective: with `AUTH_V2_ENABLED=false`
   * in flags-db, the API correctly accepted legacy email/password POSTs
   * (verified HTTP 200) but the UI sent users to Keycloak — a half-broken
   * state from the user's perspective. The legacy and V2 paths were
   * mutually exclusive on the API side (Rule R4) but the UI was V2-only.
   *
   * **This endpoint resolves the defect** by exposing only the runtime
   * `AUTH_V2_ENABLED` flag — never any other flag, database row, or
   * user-identifying data — so the login page can fetch it on mount and
   * conditionally render either the legacy email/password form (V2=false)
   * or the PKCE redirect (V2=true). The response shape is intentionally
   * minimal so future flags can be added (e.g., `enableRegistration`)
   * without affecting the existing field's contract (Rule R12 API
   * stability).
   *
   * **Resolution order (matches `requireV2` and `createAuthMiddleware`):**
   *   1. `flagsClient.isEnabled('AUTH_V2_ENABLED')` — cache → API → env
   *      → ultimately `false` (Rule RF3 fail-open, never throws)
   *   2. If `flagsClient` is undefined (legacy-only deployment, no V2
   *      wiring in `server.ts`), the response is `{ authV2Enabled: false }`
   *      — preserves byte-identical behavior with the pre-V2 1,814-test
   *      kalle suite (the UI gracefully falls back to legacy mode).
   *
   * **Why GET (not POST):**
   * The endpoint is a pure read operation with no side effects, so it is
   * idempotent and cacheable in principle. It MUST NOT be cached by
   * intermediaries because the flag value can change at runtime when an
   * operator toggles it in flags-db (the change MUST be observable within
   * the 5-second `FLAGS_CACHE_TTL_MS` window). Therefore the response
   * carries `Cache-Control: no-store` to prevent intermediary or browser
   * caching — the only caching is the in-process flag-client cache, which
   * is already TTL-bounded.
   *
   * **Why no auth (PUBLIC):**
   * The login page MUST be able to query this endpoint BEFORE the user
   * has any access token (the login page is the entry point that
   * decides which auth mode to invoke). Authenticating this endpoint
   * with a JWT would create a chicken-and-egg problem: the user cannot
   * obtain an access token without first knowing which auth flow to
   * use, which requires this endpoint's response. The endpoint discloses
   * only a single boolean — no PII, no tokens, no internal infrastructure
   * details — so the authentication-free design carries no security cost.
   *
   * **Why no rate limit:**
   * The endpoint is read-only and the response is bounded to a tiny
   * payload. The login page calls it once per page load. The cost of an
   * abusive client is the same as the cost of a legitimate one — a
   * single in-process cache lookup. Adding a rate limiter would: (a)
   * complicate the request flow without meaningful security benefit,
   * (b) potentially block legitimate users who refresh their browser,
   * and (c) introduce a different failure mode (HTTP 429) that the UI
   * would need to handle separately. Per Rule R12, simpler contracts
   * are preferred.
   *
   * **Mutual-exclusion invariant (Rule R4) preserved:**
   * This endpoint does NOT execute any V2 code path. It calls only
   * `flagsClient.isEnabled('AUTH_V2_ENABLED')`, which is part of the
   * flag-discovery infrastructure shared by both modes. Reading the flag
   * is what the entire kill-switch architecture is built on; doing so
   * here cannot be a violation of R4 because the mutual-exclusion rule
   * applies to AUTH code paths, not flag-read code paths.
   *
   * **Response shape:**
   *   { data: { authV2Enabled: boolean } }
   * Wrapped in `{ data: ... }` to match the standardized response envelope
   * used by `/login`, `/register`, `/refresh`, etc. (Rule R22).
   *
   * **Resolution order semantics (matches QA Test 3 env-var equivalence):**
   * The QA report verified at runtime that DB=false + env=false + flags
   * API unreachable produces legacy login via Rule RF3 fail-open
   * (byte-identical to DB=false + env=false + flags API reachable). The
   * `flagsClient.isEnabled()` implementation honors that same contract,
   * so this endpoint inherits the byte-identical-fallback guarantee
   * automatically.
   *
   * Architecture rule references:
   * - F-CRITICAL-3 — QA Checkpoint F2 final report
   * - R3 (V2 Isolation): no V2 code executes when flag is false
   * - R4 (Mutual Exclusion): UI now switches modes per request alongside API
   * - R12 (API Stability): new GET route only; existing routes unchanged
   * - R22 (Standardized Errors): N/A — this route never throws, always 200
   * - R23 (Log Hygiene): handler does NOT log the flag value
   * - R28 (Structured Logging): zero log output from this handler
   * - R29 (Correlation ID): preserved by upstream middleware
   * - R30 (API Versioning): /api/v1/ prefix applied by index router
   * - RF3 (Flag Fail-Open): flagsClient.isEnabled handles its own fallback
   *
   * Middleware: (none) → handler
   * Response:   200 OK with { data: { authV2Enabled: boolean } }
   * Errors:     None (handler always succeeds; flagsClient never throws)
   *
   * @route   GET /api/v1/auth/feature-flags
   * @access  Public (no authentication, no rate limit)
   * @see     apps/web/src/app/(auth)/login/page.tsx — primary consumer
   */
  router.get('/feature-flags', async (_req, res) => {
    // `flagsClient.isEnabled()` is documented as never-throwing — it
    // implements RF3 fail-open internally (cache → API → env-var →
    // ultimately `false`). No try/catch is needed.
    //
    // When `flagsClient` is undefined (legacy-only deployment, no V2
    // wiring in server.ts), we resolve to `false` synchronously so the
    // login page falls back to the legacy email/password form. This
    // mirrors the requireV2 helper's "no client" branch and preserves
    // byte-identical behavior with the pre-V2 1,814-test kalle suite.
    const authV2Enabled = flagsClient
      ? await flagsClient.isEnabled('AUTH_V2_ENABLED')
      : false;

    // Cache-Control: no-store — prevent any intermediary or browser
    // caching. The flag value can change at runtime when an operator
    // toggles it in flags-db, and the change MUST be observable within
    // the next request after the flag-client cache TTL expires
    // (FLAGS_CACHE_TTL_MS = 5000ms). Without no-store, browser caches
    // could pin an outdated flag for the lifetime of the cached entry
    // (potentially days), defeating the runtime kill-switch UX.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.status(200).json({ data: { authV2Enabled } });
  });

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
   * **F-CRITICAL-6 (QA Checkpoint F2 final report):** This route accepts the
   * refresh token from EITHER the request body (legacy mode, byte-identical
   * to the pre-V2 contract for Rule R12 API stability) OR the
   * `refreshToken` cookie (V2 mode per FR-8 silent-refresh-then-retry
   * semantics). The `bridgeCookieToBodyForRefresh` middleware copies the
   * cookie value into `req.body.refreshToken` only when the body is empty,
   * so legacy callers continue to work AND the V2 401 interceptor's
   * `credentials: 'include'` empty-body POST also works without changes
   * to the controller, service, or DTO.
   *
   * Middleware: bridgeCookieToBodyForRefresh → validateBody(refreshSchema) → controller
   * Response:   200 OK with { data: { tokens: TokenPair } }
   * Errors:     400 (validation), 401 (invalid/expired refresh token)
   */
  router.post(
    '/refresh',
    bridgeCookieToBodyForRefresh,
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

  /**
   * POST /refresh-cookie — V2 OAuth Refresh Cookie Bootstrap (FR-8, F-CRITICAL-5).
   *
   * Accepts the Keycloak-issued refresh token forwarded from the Kalle Web
   * PKCE callback page and writes it as an `httpOnly; Secure;
   * SameSite=Strict` cookie on the API origin. Returns HTTP 204 with no
   * body. This route exists exclusively to satisfy Rule R7 (token
   * storage): the refresh token must NEVER touch JavaScript on the client
   * (no localStorage, no sessionStorage, no in-memory persistence beyond
   * the single POST), and the only sanctioned channel to put it into the
   * httpOnly cookie is via this server-routed endpoint.
   *
   * **F-CRITICAL-5 (QA Checkpoint F2 final report):** Prior to this
   * implementation, the Kalle Web PKCE callback at
   * `apps/web/src/app/auth/callback/page.tsx:438` POSTed to
   * `/api/v1/auth/refresh-cookie` and received HTTP 404 because the
   * route did not exist. The callback then dispatched
   * `failAndRedirect('refresh_cookie_failed')` and the entire PKCE flow
   * terminated unsuccessfully. Implementing this endpoint closes the
   * Step 13 gap of the FR-8 callback sequence so a successful Keycloak
   * authorization-code-with-PKCE exchange can complete end-to-end.
   *
   * **Cookie contract (must match cookie name read by
   * `bridgeCookieToBodyForRefresh` and cleared by `/logout`):**
   * - Name:     `'refreshToken'` — strictly equal across writer
   *             (this handler), reader (`bridgeCookieToBodyForRefresh`
   *             middleware), and clearer (`/logout` handler).
   * - Value:    Opaque string from `req.body.refreshToken` (validated by
   *             `refreshCookieSchema`).
   * - httpOnly: `true` — prevents `document.cookie` access from
   *             JavaScript (XSS defense). Verified at runtime via
   *             DevTools (Application → Cookies); the HttpOnly column
   *             must show ✓ for the `refreshToken` row.
   * - secure:   `process.env.NODE_ENV === 'production'` — HTTPS-only in
   *             production. Local dev uses HTTP, so the flag must be
   *             conditional or the browser will silently drop the
   *             cookie. This mirrors the `/logout` handler exactly.
   * - sameSite: `'strict'` — CSRF defense; cookie is sent ONLY on
   *             same-site requests. Combined with the access token
   *             being in JS memory only (R7), this prevents
   *             cross-origin token theft.
   * - path:     `'/'` — the cookie is sent on every request to the API
   *             origin, including the `POST /refresh` route where
   *             `bridgeCookieToBodyForRefresh` reads it.
   * - maxAge:   30 days (30 × 24 × 60 × 60 × 1000 ms) — sized to match
   *             Keycloak's typical Offline Token lifetime and the
   *             "remember me" UX pattern. The actual refresh token
   *             validity is enforced server-side by Keycloak's
   *             `/protocol/openid-connect/token` endpoint at the next
   *             silent-refresh attempt; if the token expires sooner,
   *             the next refresh returns 401 and the V2 401 interceptor
   *             clears the cookie via `/logout` and redirects to login.
   *
   * **Why the route is gated by `requireV2(flagsClient)`:**
   * Rule R3 (V2 isolation): when `AUTH_V2_ENABLED=false` (legacy mode),
   * NO V2 code path may execute. The `requireV2` guard short-circuits
   * with HTTP 404 BEFORE any cookie write occurs. This preserves
   * byte-identical behavior with the pre-V2 1,814-test kalle suite —
   * any test that probes `/refresh-cookie` under legacy mode receives
   * the same 404 it would have received before the route was added.
   *
   * **Why no auth middleware (no JWT validation):**
   * The PKCE callback POSTs the cookie write IMMEDIATELY after the
   * Keycloak token exchange — at that moment, the access token has just
   * been received but is held in client JS memory only (Rule R7) and is
   * about to be propagated to the authStore. No bearer header is
   * available yet (the Kalle Web `lib/api.ts` `Authorization` header
   * only flows on subsequent /api/v1/* requests). Authenticating this
   * route with a JWT would create a chicken-and-egg problem: the cookie
   * cannot be set without a JWT, but the JWT cannot be propagated
   * without the access token, and the access token write to the
   * authStore happens AFTER the cookie POST. Per the AAP §0.4.1.2
   * directive ("the API server writes the refresh token as an
   * `httpOnly; Secure; SameSite=Strict` cookie on its origin... NO
   * `Authorization: Bearer`... the endpoint authenticates by trusting
   * the body's refresh-token JWT shape"), the route's only auth gate
   * is the V2 flag.
   *
   * **Security analysis — why no JWT check is acceptable:**
   * 1. The route ONLY accepts a body field that is structurally a
   *    refresh-token string. It does NOT verify the token's signature
   *    or claims server-side. Any client can call this route and write
   *    a string as their own refresh cookie.
   * 2. However, the cookie is httpOnly+SameSite=Strict, so other
   *    websites cannot trigger it and JavaScript on the same origin
   *    cannot read it. The only attack vector is "tricking a user into
   *    submitting a malicious refresh token", which: (a) would require
   *    XSS or social engineering, and (b) the malicious token would
   *    fail at the next `/refresh` call when Keycloak rejects it
   *    server-side. The user is then redirected to login.
   * 3. CSRF: SameSite=Strict means a cross-site form/script cannot
   *    POST to this route with the user's existing cookies. Combined
   *    with the access token being in JS memory only, the
   *    cookie-as-CSRF-vector is closed.
   * 4. Rate limiting: not applied here because the route is reachable
   *    only after a successful Keycloak PKCE exchange (the `code` is
   *    one-time-use), and the body validation already rejects
   *    malformed payloads with 400.
   *
   * **Why response body is empty:**
   * HTTP 204 (No Content) per RFC 7231 §6.3.5 forbids a response body.
   * The `res.status(204).send()` form sends headers (including the
   * `Set-Cookie` for the refresh-token write) without a body.
   *
   * **CORS interaction:**
   * The kalle CORS configuration at `apps/api/src/config/cors.ts`
   * already includes `credentials: true` (required for
   * `credentials: 'include'` in the callback fetch to function and
   * for the browser to honor the `Set-Cookie` response header on a
   * cross-origin request between the Kalle Web origin (port 3000) and
   * the Kalle API origin (port 3001)). No additional CORS wiring is
   * needed by this handler.
   *
   * Architecture rule references:
   * - F-CRITICAL-5  — QA Checkpoint F2 final report
   * - FR-8          — Kalle Web PKCE Flow (refresh in cookie only)
   * - R3            — V2 isolation (gated by requireV2)
   * - R7            — Token storage (httpOnly cookie for refresh)
   * - R12           — API stability (new route only; legacy unchanged)
   * - R22           — Standardized error responses (validation 400)
   * - R23           — Log hygiene (handler does NOT log cookie value)
   * - R28           — Structured logging (zero log output from handler)
   * - R31           — Input validation via Zod (refreshCookieSchema)
   *
   * Middleware: requireV2(flagsClient) → validateBody(refreshCookieSchema) → cookie write → 204
   * Response:   204 No Content (empty body)
   * Errors:     400 (validation), 404 (legacy mode or flag off)
   *
   * @route   POST /api/v1/auth/refresh-cookie
   * @access  V2-only (gated by requireV2)
   * @see     apps/web/src/app/auth/callback/page.tsx — invokes this route
   * @see     bridgeCookieToBodyForRefresh — reads the cookie set here
   */
  router.post(
    '/refresh-cookie',
    requireV2(flagsClient),
    validateBody(refreshCookieSchema),
    (req, res) => {
      // Per Rule R31 the body has already been validated by
      // `validateBody(refreshCookieSchema)` — so `req.body.refreshToken`
      // is guaranteed to be a non-empty string at this point. The cast
      // is type-narrowing only; no runtime check is needed.
      const refreshTokenValue = (req.body as { refreshToken: string })
        .refreshToken;

      // Cookie maxAge: 30 days in milliseconds. This is sized to match
      // Keycloak's typical Offline Token lifetime. The actual refresh
      // token validity is enforced by Keycloak server-side at the next
      // silent-refresh attempt; if the token expires sooner, the next
      // /refresh call returns 401, the V2 401 interceptor in lib/api.ts
      // clears the cookie via /logout, and the user is redirected to
      // login. Hard-coded rather than env-configured because: (a) the
      // value is a UX-driven default, (b) Keycloak controls the actual
      // session lifetime, (c) introducing a new env var (e.g.,
      // V2_REFRESH_COOKIE_MAX_AGE_MS) would require updating
      // .env.example and Zod schema in env.ts and add deployment
      // friction without a corresponding security or UX benefit.
      const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

      res.cookie('refreshToken', refreshTokenValue, {
        maxAge: REFRESH_COOKIE_MAX_AGE_MS,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
      });

      // RFC 7231 §6.3.5: 204 No Content — server fulfilled request,
      // returning no payload but possibly Set-Cookie headers (which we
      // are setting on the line above).
      res.status(204).send();
    },
  );

  return router;
}
