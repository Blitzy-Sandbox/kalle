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
 *
 * @see apps/api/src/controllers/AuthController.ts  — endpoint handler logic
 * @see apps/api/src/middleware/validation.ts        — Zod validation middleware
 * @see apps/api/src/middleware/rate-limiter.ts       — rate limiting middleware
 * @see apps/api/src/routes/v1/index.ts              — route aggregation
 */

import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { validateBody } from '../../middleware/validation.js';
import { authRateLimiter } from '../../middleware/rate-limiter.js';
import type { AuthController } from '../../controllers/AuthController.js';

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
 *
 * @param authController - AuthController instance with bound handler methods
 * @param authMiddleware - JWT verification + Redis blacklist check middleware
 * @returns Configured Express Router for mounting at `/auth`
 */
export function createAuthRoutes(
  authController: AuthController,
  authMiddleware: RequestHandler,
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

  return router;
}
