/**
 * @file apps/api/src/routes/v1/index.ts
 * @description Central v1 router aggregation file.
 *
 * Imports all route module factory functions and mounts them on a single
 * Express Router. The resulting router is mounted at `/api/v1/` in `app.ts`.
 *
 * This file receives a dependency object from the composition root
 * (`server.ts`) containing all controllers, `authService`, `cacheProvider`,
 * and `jwtSecret`. It creates a single `authMiddleware` instance internally
 * via `createAuthMiddleware` and passes it to protected route modules.
 *
 * Architecture Rules Enforced:
 * - R30 (API Versioning): All routes under `/api/v1/` prefix (applied in
 *       `app.ts`: `app.use('/api/v1', v1Router)`). Route files define
 *       sub-paths only (e.g., `/auth`, `/users`).
 * - R9  (Auth on Protected Routes): Auth middleware applied per-route-group.
 *       Public routes (`/health`, `/metrics`) skip auth middleware.
 *       Auth routes receive the middleware because some endpoints (refresh,
 *       revoke, revoke-all) ARE protected.
 * - R17 (Interface-Driven Dependencies): Receives `ICacheProvider` interface
 *       for auth middleware construction — never the concrete class.
 * - R33 (Session Revocation): Auth middleware checks Redis-backed JWT
 *       blacklist via `ICacheProvider` on every protected request.
 * - R28 (Structured Logging Only): ZERO `console.log`, `console.warn`, or
 *       `console.error` calls.
 * - R7  (Zero Warnings Build): Compiles under `tsc --noEmit --strict` with
 *       zero warnings.
 *
 * V2 Auth Integration (FR-9):
 * - Detects V2-aware auth wiring by checking deps.authInstance && deps.flagsInstance.
 *   When both are present (V2 mode wired in server.ts), the auth-middleware factory
 *   dispatches per-request based on AUTH_V2_ENABLED (Rule R3, R4).
 * - When EITHER is absent (legacy-only mode or test fixture), the factory falls back
 *   to the legacy 2-arg form (jwtSecret, cacheProvider). This preserves the existing
 *   1,814-test kalle suite under AUTH_V2_ENABLED=false.
 * - The new POST /api/v1/auth/logout route is V2-only and is gated by deps.flagsInstance
 *   inside auth.routes.ts (returns 404 in legacy mode).
 *
 * Route Mount Summary:
 * ```
 * /api/v1/auth/*            — Auth (register, login, refresh, revoke)
 * /api/v1/health            — Health check (public)
 * /api/v1/metrics           — Prometheus metrics (public)
 * /api/v1/users/*           — User profile, search, block/unblock
 * /api/v1/conversations/*                          — Conversation CRUD, membership
 * /api/v1/conversations/:id/messages               — Message history and send
 * /api/v1/messages/*                               — Message edit and delete
 * /api/v1/media/*           — Media upload and retrieval
 * /api/v1/stories/*         — Story lifecycle (create, feed, view, delete)
 * /api/v1/keys/*            — E2E encryption key bundle management
 * ```
 *
 * @example
 * ```typescript
 * // In server.ts (composition root):
 * import { createV1Router } from './routes/v1/index.js';
 *
 * const v1Router = createV1Router({
 *   authController,
 *   userController,
 *   conversationController,
 *   messageController,
 *   mediaController,
 *   storyController,
 *   keyController,
 *   healthController,
 *   authService,
 *   cacheProvider,
 *   jwtSecret: env.JWT_SECRET,
 * });
 *
 * // In app.ts:
 * app.use('/api/v1', v1Router);
 * ```
 */

// =============================================================================
// External imports
// =============================================================================

import { Router } from 'express';

// =============================================================================
// Internal imports — middleware
// =============================================================================

import { createAuthMiddleware } from '../../middleware/auth.js';

// =============================================================================
// Internal imports — route factory functions
// =============================================================================

import { createAuthRoutes } from './auth.routes.js';
import { createUserRoutes } from './user.routes.js';
import { createConversationRoutes } from './conversation.routes.js';
import { createConversationMessageRoutes, createMessageRoutes } from './message.routes.js';
import { createMediaRoutes } from './media.routes.js';
import { createStoryRoutes } from './story.routes.js';
import { createKeyRoutes } from './key.routes.js';
import { createHealthRoutes, createMetricsRoute } from './health.routes.js';

// =============================================================================
// Internal imports — type-only (Rule R17: interface-driven dependencies)
// =============================================================================

import type { ICacheProvider } from '../../domain/interfaces/ICacheProvider.js';
import type { AuthController } from '../../controllers/AuthController.js';
import type { UserController } from '../../controllers/UserController.js';
import type { ConversationController } from '../../controllers/ConversationController.js';
import type { MessageController } from '../../controllers/MessageController.js';
import type { MediaController } from '../../controllers/MediaController.js';
import type { StoryController } from '../../controllers/StoryController.js';
import type { KeyController } from '../../controllers/KeyController.js';
import type { HealthController } from '../../controllers/HealthController.js';
import type { AuthService } from '../../services/AuthService.js';

// =============================================================================
// V2 type-only imports — interface-level forward-declarations for the V2
// auth/flags instances injected by `server.ts` (composition root). These
// imports are TYPE-ONLY and tree-shake to nothing at runtime — they exist
// solely so the V1RouterDependencies interface can declare the optional
// `authInstance?` and `flagsInstance?` slots that `server.ts` populates
// (FR-1, FR-4, FR-9, R3, R4 — V2 wiring at composition root).
// =============================================================================
import type { AuthInstance } from '@blitzy/auth';
import type { FlagInstance } from '@blitzy/admin-ui';

// =============================================================================
// V1RouterDependencies Interface
// =============================================================================

/**
 * Dependency injection object required by {@link createV1Router} to wire
 * all v1 API route groups.
 *
 * Provided by the composition root (`server.ts`) after constructing all
 * controllers, services, and providers. This interface enforces Rule R17
 * (interface-driven dependencies) by typing the cache provider as
 * `ICacheProvider` rather than its concrete implementation.
 *
 * @property authController         - Handles auth endpoints (register, login, refresh, revoke)
 * @property userController         - Handles user endpoints (profile, search, block/unblock)
 * @property conversationController - Handles conversation endpoints (list, create, members)
 * @property messageController      - Handles message endpoints (send, edit, delete, history)
 * @property mediaController        - Handles media upload and retrieval endpoints
 * @property storyController        - Handles story endpoints (create, feed, view, delete)
 * @property keyController          - Handles encryption key endpoints (upload, fetch bundle)
 * @property healthController       - Handles health check and Prometheus metrics endpoints
 * @property authService            - Auth service instance (type reference for DI container)
 * @property cacheProvider          - Redis-backed cache provider for JWT blacklist checking (R33)
 * @property jwtSecret              - JWT signing/verification secret from environment config
 */
export interface V1RouterDependencies {
  /** Controller handling auth endpoints: register, login, refresh, revoke, revoke-all */
  authController: AuthController;

  /** Controller handling user endpoints: profile CRUD, search, block/unblock */
  userController: UserController;

  /** Controller handling conversation endpoints: list, create, update, membership */
  conversationController: ConversationController;

  /** Controller handling message endpoints: send, edit, delete, history */
  messageController: MessageController;

  /** Controller handling media endpoints: upload (multipart), retrieve metadata */
  mediaController: MediaController;

  /** Controller handling story/status endpoints: create, feed, view tracking, delete */
  storyController: StoryController;

  /** Controller handling E2E encryption key endpoints: upload bundle, fetch bundle */
  keyController: KeyController;

  /** Controller handling health check and Prometheus metrics endpoints */
  healthController: HealthController;

  /**
   * Auth service instance. Referenced as a dependency type in the DI
   * container. The service provides JWT-related configuration access
   * and session management logic used by the composition root.
   */
  authService: AuthService;

  /**
   * Cache provider interface for Redis-backed operations.
   * Used by `createAuthMiddleware` to check the JWT token blacklist
   * on every authenticated request (Rule R33: Session Revocation).
   *
   * Rule R17: Typed as `ICacheProvider` interface — NEVER the concrete
   * `CacheProvider` class.
   */
  cacheProvider: ICacheProvider;

  /**
   * JWT signing and verification secret obtained from validated
   * environment configuration (`env.JWT_SECRET`).
   * Passed to `createAuthMiddleware` for token signature verification.
   */
  jwtSecret: string;

  /**
   * V2 auth instance constructed by `server.ts` via `initAuth(...)` from
   * `@blitzy/auth`. Optional — only populated when V2 env vars are set
   * (KEYCLOAK_BASE_URL, AUTH_SERVICE_URL, AUTH_SIDECAR_SECRET). When
   * `undefined`, the middleware factory uses the legacy JWT path
   * exclusively (Rule R3 — zero V2 code executes when AUTH_V2_ENABLED=false
   * AND in legacy-only deployments where V2 env vars are absent).
   *
   * In sidecar mode (kalle), this instance was constructed WITHOUT a
   * `dbUrl` — token-to-user resolution is delegated via HTTP to
   * ${AUTH_SERVICE_URL}/validate (Rule R2 — auth DB boundary).
   *
   * Used by the V2-aware `createAuthMiddleware` factory in
   * `middleware/auth.ts` to dispatch to @blitzy/auth's
   * `createExpressMiddleware` when AUTH_V2_ENABLED=true.
   *
   * @see ../../middleware/auth.ts — V2-aware createAuthMiddleware factory
   * @see ../../../../packages/auth/README.md — initAuth() public API contract
   */
  authInstance?: AuthInstance;

  /**
   * V2 flags instance slot. Optional — declared on this interface for
   * forward-compatibility with `@blitzy/admin-ui`'s planned HTTP-only mode
   * (apiUrl + apiSecret). For kalle, this is currently `undefined` because
   * the actual runtime flag-reading mechanism is `createFeatureFlagClient`
   * from `@blitzy/auth/clients/feature-flag-client` (HTTP-only, fail-open
   * per Rule RF3), constructed inside `middleware/auth.ts`. The slot is
   * preserved here so that:
   *   1) `server.ts` can forward the instance once HTTP-only mode lands
   *      in `@blitzy/admin-ui`, and
   *   2) The interface contract documented in `app.ts` AppDependencies is
   *      consistent across the kalle composition graph.
   *
   * Rule RF2 (flags DB boundary): kalle MUST NEVER reference FLAGS_DB_URL,
   * so this instance is NEVER constructed via the current DB-only
   * `initFlags(dbUrl)` path in kalle. Verified by:
   *   grep "FLAGS_DB_URL" kalle/apps/api/src/  → zero matches
   *
   * @see ../../middleware/auth.ts — HTTP-only flag client construction site
   * @see ../../../../packages/auth/src/clients/feature-flag-client.ts — actual flag client
   */
  flagsInstance?: FlagInstance;
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Creates and configures the v1 API router with all route groups mounted.
 *
 * This factory function:
 * 1. Creates a single `authMiddleware` instance from `createAuthMiddleware`
 *    using the provided `jwtSecret` and `cacheProvider` (Rule R9, R33)
 * 2. Mounts all route groups on an Express Router
 * 3. Returns the configured router for mounting at `/api/v1/` in `app.ts`
 *
 * The auth middleware is created ONCE and shared across all protected route
 * groups to ensure consistent JWT verification and blacklist checking.
 *
 * Route Groups:
 * - `/auth`          — Auth routes (some public, some protected)
 * - `/health`        — Health check (public, Rule R9)
 * - `/metrics`       — Prometheus metrics (public, Rule R37)
 * - `/users`         — User routes (all protected)
 * - `/conversations` — Conversation routes (all protected)
 * - `/messages`      — Message routes (all protected)
 * - `/media`         — Media routes (all protected)
 * - `/stories`       — Story routes (all protected)
 * - `/keys`          — Encryption key routes (all protected)
 *
 * @param deps - Dependency injection object containing all controllers,
 *               services, and configuration needed to wire the router.
 * @returns Configured Express Router with all v1 route groups mounted.
 *
 * @example
 * ```typescript
 * const v1Router = createV1Router({
 *   authController,
 *   userController,
 *   conversationController,
 *   messageController,
 *   mediaController,
 *   storyController,
 *   keyController,
 *   healthController,
 *   authService,
 *   cacheProvider,
 *   jwtSecret: env.JWT_SECRET,
 * });
 * ```
 */
export function createV1Router(deps: V1RouterDependencies): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Step 1: Create auth middleware instance (Rule R9, R33)
  //
  // `createAuthMiddleware` returns Express middleware that:
  // 1. Extracts Bearer token from Authorization header
  // 2. Verifies JWT signature and expiration
  // 3. Checks Redis blacklist for revoked tokens (Rule R33)
  // 4. Attaches authenticated user payload to `req.user`
  //
  // Created ONCE here and passed to all route factories that need it.
  // -------------------------------------------------------------------------

  // ─── V2-aware auth middleware (FR-9, R3, R4) ────────────────────────────
  // When BOTH authInstance and flagsInstance are provided (V2 mode wired in
  // server.ts), use the V2-aware overload of createAuthMiddleware that
  // dispatches per-request based on AUTH_V2_ENABLED. Legacy handler is built
  // FIRST and passed in so the V2-aware middleware can fall through to it
  // when the flag is false.
  //
  // When EITHER instance is absent (legacy-only mode or test fixture), the
  // legacy 2-arg overload is used directly — full byte-identical behavior
  // with the pre-V2 implementation. This branch preserves the existing
  // 1,814-test suite under AUTH_V2_ENABLED=false (DB or env var).
  const legacyAuthHandler = createAuthMiddleware(deps.jwtSecret, deps.cacheProvider);
  const authMiddleware = deps.authInstance && deps.flagsInstance
    ? createAuthMiddleware({
        authInstance: deps.authInstance,
        flagsInstance: deps.flagsInstance,
        legacyAuthHandler,
      })
    : legacyAuthHandler;

  // -------------------------------------------------------------------------
  // Step 2: Mount PUBLIC routes (no auth middleware — Rule R9)
  //
  // Health and metrics endpoints are intentionally public to support
  // external monitoring, load balancer health probes, and Prometheus
  // scraping without requiring authentication credentials.
  //
  // Auth routes receive the middleware because some auth endpoints
  // (refresh, revoke, revoke-all) ARE authenticated — the route
  // factory applies it selectively to those specific endpoints.
  // -------------------------------------------------------------------------

  /**
   * Auth routes: POST /register, POST /login (public),
   * POST /refresh, POST /revoke, POST /revoke-all (protected).
   * The auth route factory selectively applies authMiddleware
   * to protected endpoints internally.
   *
   * Pass deps.flagsInstance as a third argument so auth.routes.ts can gate
   * the new V2-only POST /logout route via requireV2(flagsInstance). When
   * flagsInstance is undefined (legacy-only mode), POST /logout returns 404,
   * preserving legacy test parity.
   */
  router.use('/auth', createAuthRoutes(deps.authController, authMiddleware, deps.flagsInstance));

  /**
   * Health check endpoint: GET /api/v1/health
   * Returns component-level health status (DB, Redis, BullMQ, storage).
   * Public — no authentication required (Rule R9).
   */
  router.use('/health', createHealthRoutes(deps.healthController));

  /**
   * Prometheus metrics endpoint: GET /api/v1/metrics
   * Exposes HTTP request count/latency, WebSocket connections,
   * BullMQ queue depth, DB query latency percentiles (Rule R37).
   * Public — no authentication required for metrics scraping.
   */
  router.use('/metrics', createMetricsRoute(deps.healthController));

  // -------------------------------------------------------------------------
  // Step 3: Mount PROTECTED routes
  //
  // All endpoints in these route groups require a valid JWT token.
  // Each route factory receives the authMiddleware instance and
  // applies it at the router level (router.use(authMiddleware)).
  // -------------------------------------------------------------------------

  /**
   * User routes: GET /me, PATCH /me, GET /search, GET /blocked,
   * GET /:userId, POST /:userId/block, DELETE /:userId/block.
   * All endpoints require authentication.
   */
  router.use('/users', createUserRoutes(deps.userController, authMiddleware));

  /**
   * Conversation routes: GET /, POST /, GET /:conversationId,
   * PATCH /:conversationId, POST /:conversationId/members,
   * DELETE /:conversationId/members/:userId.
   * All endpoints require authentication.
   */
  router.use('/conversations', createConversationRoutes(deps.conversationController, authMiddleware));

  /**
   * Conversation-scoped message routes:
   * GET  /conversations/:conversationId/messages — message history
   * POST /conversations/:conversationId/messages — send message
   * Mounted at the conversation sub-path so E2E clients hit the natural
   * resource hierarchy:  /api/v1/conversations/:id/messages
   * All endpoints require authentication. Server stores only ciphertext (R12).
   */
  router.use(
    '/conversations/:conversationId/messages',
    createConversationMessageRoutes(deps.messageController, authMiddleware),
  );

  /**
   * Message-level routes: PATCH /:messageId, DELETE /:messageId.
   * Mounted at /messages because edit/delete operate on individual messages
   * regardless of their conversation.
   * All endpoints require authentication. Server stores only ciphertext (R12).
   */
  router.use('/messages', createMessageRoutes(deps.messageController, authMiddleware));

  /**
   * Media routes: POST / (upload), GET /:mediaId (metadata).
   * All endpoints require authentication. Server handles encrypted
   * blobs — zero decryption logic (Rule R12, R27).
   */
  router.use('/media', createMediaRoutes(deps.mediaController, authMiddleware));

  /**
   * Story routes: GET /feed, GET /me, POST /, POST /:storyId/view,
   * DELETE /:storyId.
   * All endpoints require authentication. Stories are NOT encrypted (R12).
   */
  router.use('/stories', createStoryRoutes(deps.storyController, authMiddleware));

  /**
   * Encryption key routes: POST /bundle, GET /bundle/:userId.
   * All endpoints require authentication. Server relays key material
   * only — zero encryption/decryption logic (Rule R12, R23).
   */
  router.use('/keys', createKeyRoutes(deps.keyController, authMiddleware));

  // -------------------------------------------------------------------------
  // Step 4: Mount STUB routes for out-of-scope features
  //
  // The Calls UI screen exists per Figma but WebRTC calling functionality
  // is explicitly out of scope (AAP §0.8.2).  These stub endpoints return
  // empty data so the frontend renders a graceful empty state instead of
  // a "Route not found" 404 error.
  // -------------------------------------------------------------------------

  const callsRouter = Router();
  callsRouter.use(authMiddleware);

  /** GET /api/v1/calls — returns empty call history */
  callsRouter.get('/', (_req, res) => {
    res.json({ data: [], hasMore: false });
  });

  /** DELETE /api/v1/calls/:callId — no-op, returns 204 */
  callsRouter.delete('/:callId', (_req, res) => {
    res.status(204).send();
  });

  /** DELETE /api/v1/calls — clear all (no-op), returns 204 */
  callsRouter.delete('/', (_req, res) => {
    res.status(204).send();
  });

  router.use('/calls', callsRouter);

  return router;
}
