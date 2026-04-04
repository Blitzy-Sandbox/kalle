/**
 * @file apps/api/src/routes/v1/user.routes.ts
 * @description User profile and management route definitions.
 *
 * Defines all user-related Express routes:
 * - `GET    /me`              — Get current user's profile
 * - `PATCH  /me`              — Update current user's profile (partial update)
 * - `GET    /search`          — Search users (cursor-paginated)
 * - `GET    /blocked`         — List blocked users
 * - `GET    /:userId`         — Get user by ID
 * - `POST   /:userId/block`   — Block a user
 * - `DELETE /:userId/block`   — Unblock a user
 *
 * ALL endpoints require authentication (Rule R9). Rate limiting applied at
 * router level via `apiRateLimiter` (100 req/min per IP). Input validation
 * enforced via Zod schemas per Rule R31.
 *
 * Architecture Rules Enforced:
 * - R9  (Auth Required): All user endpoints require authentication via
 *       `authMiddleware` applied at router level.
 * - R31 (Input Validation via Zod): Every endpoint with user input validates
 *       request body, query params, or path params via Zod schemas before
 *       invoking the controller method.
 * - R30 (API Versioning): Sub-paths only — `/api/v1/users` prefix applied
 *       by the v1 index router.
 * - R28 (Structured Logging Only): ZERO `console.log`, `console.warn`, or
 *       `console.error` calls.
 * - R7  (Zero Warnings Build): Compiles under `tsc --noEmit --strict` with
 *       zero warnings.
 *
 * Route Ordering — CRITICAL:
 * Static routes (`/me`, `/search`, `/blocked`) MUST be defined BEFORE the
 * dynamic `/:userId` route to prevent Express from matching "me", "search",
 * or "blocked" as a `userId` path parameter.
 *
 * @example
 * ```typescript
 * // Mounted in v1/index.ts:
 * import { createUserRoutes } from './user.routes';
 * router.use('/users', createUserRoutes(userController, authMiddleware));
 *
 * // Resulting endpoint paths:
 * // GET    /api/v1/users/me
 * // PATCH  /api/v1/users/me
 * // GET    /api/v1/users/search?q=...&cursor=...&limit=...
 * // GET    /api/v1/users/blocked
 * // GET    /api/v1/users/:userId
 * // POST   /api/v1/users/:userId/block
 * // DELETE /api/v1/users/:userId/block
 * ```
 */

import { Router, RequestHandler } from 'express';
import { z } from 'zod';

import { validateBody, validateParams, validateQuery } from '../../middleware/validation';
import { apiRateLimiter } from '../../middleware/rate-limiter';
import type { UserController } from '../../controllers/UserController';

// =============================================================================
// Zod Validation Schemas (Rule R31)
// =============================================================================

/**
 * Zod schema for the PATCH /me request body (profile update).
 *
 * All fields are optional, but at least one must be provided (enforced
 * via `.refine()`). Validates:
 * - `displayName` — 1–100 characters when provided
 * - `avatar`      — Valid URL or `null` (to remove avatar)
 * - `about`       — Max 500 characters (status text, e.g., Figma Screen 15)
 * - `phoneNumber` — Free-form string when provided
 *
 * The `.refine()` check ensures the client cannot send an empty `{}` body,
 * which would be a no-op update and waste a database round-trip.
 */
const updateProfileSchema = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    avatar: z.string().url().nullable().optional(),
    about: z.string().max(500).optional(),
    phoneNumber: z.string().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

/**
 * Zod schema for the GET /search query parameters.
 *
 * Query parameters arrive as strings from the HTTP layer, so numeric values
 * use `z.coerce.number()` to parse string → number automatically.
 *
 * - `q`      — Search query string (1–100 characters, required)
 * - `cursor` — Optional UUID cursor for pagination (last user ID from prev page)
 * - `limit`  — Results per page; defaults to 20, clamped between 1 and 100
 */
const searchQuerySchema = z.object({
  q: z.string().min(1, 'Search query is required').max(100),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Zod schema for the `:userId` path parameter.
 *
 * Validates that the `userId` segment is a valid UUID v4. Applied to:
 * - `GET    /:userId`
 * - `POST   /:userId/block`
 * - `DELETE /:userId/block`
 */
const userIdParamSchema = z.object({
  userId: z.string().uuid('Invalid user ID format'),
});

// =============================================================================
// Route Factory Function
// =============================================================================

/**
 * Creates and returns an Express Router configured with all user-related
 * routes, authentication middleware, rate limiting, and Zod validation.
 *
 * This is a factory function following the Dependency Injection pattern
 * (Rule R17). The `UserController` instance and auth middleware are injected
 * from the composition root (`server.ts`) via `v1/index.ts`.
 *
 * Middleware chain (applied in order):
 * 1. `authMiddleware` — JWT verification + Redis blacklist check (router-level)
 * 2. `apiRateLimiter` — 100 requests/minute per IP (router-level)
 * 3. Per-route validation — Zod schema validation on body/query/params
 * 4. Controller handler — Thin delegation to UserService
 *
 * @param userController - UserController instance with bound handler methods
 *   (getProfile, updateProfile, search, getUserById, block, unblock, getBlockedUsers)
 * @param authMiddleware - Express middleware for JWT authentication (Rule R9).
 *   Created by `createAuthMiddleware(jwtSecret, cacheProvider)` in v1/index.ts.
 * @returns Configured Express Router with all user routes
 */
export function createUserRoutes(
  userController: UserController,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  // ---------------------------------------------------------------------------
  // Router-Level Middleware (applies to ALL routes in this router)
  // ---------------------------------------------------------------------------

  // Rule R9: All user endpoints require authentication
  router.use(authMiddleware);

  // 100 requests per minute per IP for all user routes
  router.use(apiRateLimiter);

  // ---------------------------------------------------------------------------
  // Static Routes (MUST be defined BEFORE /:userId to avoid conflicts)
  // ---------------------------------------------------------------------------

  /**
   * GET /me — Get the authenticated user's own profile.
   *
   * No additional validation needed — userId extracted from JWT in controller.
   * Returns: 200 { data: UserResponse }
   */
  router.get('/me', userController.getProfile);

  /**
   * PATCH /me — Update the authenticated user's profile (partial update).
   *
   * Validates request body against `updateProfileSchema`:
   * - At least one field must be provided
   * - `displayName`: 1–100 chars (optional)
   * - `avatar`: valid URL or null (optional)
   * - `about`: max 500 chars (optional)
   * - `phoneNumber`: string (optional)
   *
   * Returns: 200 { data: UserResponse }
   */
  router.patch('/me', validateBody(updateProfileSchema), userController.updateProfile);

  /**
   * GET /search — Search users by query string with cursor-based pagination.
   *
   * Validates query parameters against `searchQuerySchema`:
   * - `q`: 1–100 chars (required)
   * - `cursor`: UUID (optional, pagination token)
   * - `limit`: 1–100, defaults to 20
   *
   * Returns: 200 { data: UserSearchResult[], pagination: { cursor?, hasMore } }
   */
  router.get('/search', validateQuery(searchQuerySchema), userController.search);

  /**
   * GET /blocked — List all users blocked by the authenticated user.
   *
   * No additional validation needed — userId extracted from JWT in controller.
   * Returns: 200 { data: BlockedUserInfo[] }
   */
  router.get('/blocked', userController.getBlockedUsers);

  // ---------------------------------------------------------------------------
  // Dynamic Routes (/:userId — declared AFTER static routes)
  // ---------------------------------------------------------------------------

  /**
   * GET /:userId — Get a user's public profile by their ID.
   *
   * Validates path parameter against `userIdParamSchema`:
   * - `userId`: valid UUID format
   *
   * Returns: 200 { data: UserResponse }
   * Errors: 404 NotFoundError if user does not exist
   */
  router.get('/:userId', validateParams(userIdParamSchema), userController.getUserById);

  /**
   * POST /:userId/block — Block another user.
   *
   * Validates path parameter against `userIdParamSchema`:
   * - `userId`: valid UUID format
   *
   * Returns: 200 { data: { message, blockedUser: BlockedUserInfo } }
   * Errors: 404 NotFoundError, 400 ValidationError (self-block)
   */
  router.post('/:userId/block', validateParams(userIdParamSchema), userController.block);

  /**
   * DELETE /:userId/block — Unblock a previously blocked user.
   *
   * Validates path parameter against `userIdParamSchema`:
   * - `userId`: valid UUID format
   *
   * Returns: 200 { data: { message } }
   * Errors: 404 NotFoundError (block relationship does not exist)
   */
  router.delete('/:userId/block', validateParams(userIdParamSchema), userController.unblock);

  return router;
}
