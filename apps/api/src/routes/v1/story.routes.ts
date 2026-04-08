/**
 * @file apps/api/src/routes/v1/story.routes.ts
 * @description Story/Status lifecycle route definitions for the WhatsApp clone API.
 *
 * Defines all story/status-related Express routes mounted at `/api/v1/stories`:
 * - GET  /feed            — Get story feed (contacts' stories grouped by user)
 * - GET  /me              — Get current user's active stories
 * - POST /                — Create a new story (text/image/video)
 * - POST /:storyId/view   — Record a story view
 * - DELETE /:storyId      — Delete a story (owner only)
 *
 * ALL endpoints require authentication (Rule R9). Rate limited at 100 req/min
 * via apiRateLimiter. Input validation on all request bodies and path params
 * via Zod schemas (Rule R31).
 *
 * Stories are explicitly NOT encrypted (Rule R12) — unlike messages, story
 * content and media URLs are stored and transmitted as plaintext. The route
 * layer is unaware of story expiration logic (Rule R11) — that is handled
 * entirely by StoryService and the hourly BullMQ cleanup job.
 *
 * Architecture Rules Enforced:
 * - R9  (Auth Required):         All endpoints require valid JWT
 * - R11 (Story Expiration):      24h expiry handled by StoryService, not routes
 * - R12 (Stories NOT Encrypted): Media URLs are plain URLs — no ciphertext
 * - R16 (Thin Controllers):      Route delegates to controller; zero logic here
 * - R22 (Standardized Errors):   Validation errors flow through global handler
 * - R28 (Structured Logging):    ZERO console.log/warn/error calls
 * - R30 (API Versioning):        Sub-paths only; /api/v1/stories prefix from index router
 * - R31 (Zod Validation):        All inputs validated before reaching service layer
 * - R7  (Zero Warnings Build):   TypeScript strict mode compatible
 *
 * @see apps/api/src/controllers/StoryController.ts — Thin delegation controller
 * @see apps/api/src/services/StoryService.ts — Business logic implementation
 * @see packages/shared/src/types/story.ts — Shared story types and DTOs
 */

import { Router, RequestHandler } from 'express';
import { z } from 'zod';

import { validateBody, validateParams } from '../../middleware/validation';
import { apiRateLimiter } from '../../middleware/rate-limiter';
import type { StoryController } from '../../controllers/StoryController';

// ---------------------------------------------------------------------------
// Zod Validation Schemas
// ---------------------------------------------------------------------------

/**
 * Zod schema for the POST / (create story) request body.
 *
 * Validates story creation payload with type-specific conditional requirements:
 * - TEXT stories must provide `content` (the text body)
 * - IMAGE/VIDEO stories must provide `mediaId` (reference to uploaded media)
 *
 * Optional fields:
 * - `backgroundColor`: 6-digit hex color for text story backgrounds
 *   (e.g. Figma Screen 10 coral/salmon pink "#E8594F")
 * - `fontStyle`: Font style identifier (max 50 chars)
 * - `duration`: Display duration in seconds (1–30, defaults handled by service)
 */
const createStorySchema = z.object({
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO']),
  content: z.string().max(1000).optional(),
  mediaId: z.string().uuid().optional(),
  backgroundColor: z.string().regex(
    /^#[0-9A-Fa-f]{6}$/,
    'Must be a valid hex color (e.g. #FF5733)',
  ).optional(),
  fontStyle: z.string().max(50).optional(),
  duration: z.number().int().min(1).max(30).optional(),
}).refine(
  (data) => {
    // TEXT stories must have content; IMAGE/VIDEO stories must have mediaId
    if (data.type === 'TEXT' && !data.content) {
      return false;
    }
    if ((data.type === 'IMAGE' || data.type === 'VIDEO') && !data.mediaId) {
      return false;
    }
    return true;
  },
  {
    message: 'TEXT stories require content; IMAGE/VIDEO stories require mediaId',
    path: ['content'],
  },
);

/**
 * Zod schema for path parameters on story-specific routes.
 *
 * Validates that `:storyId` is a valid UUID string, preventing malformed
 * identifiers from reaching the controller/service layer.
 */
const storyIdParamSchema = z.object({
  storyId: z.string().uuid('Invalid story ID format'),
});

// ---------------------------------------------------------------------------
// Route Factory
// ---------------------------------------------------------------------------

/**
 * Factory function that creates and configures the Express Router for all
 * story/status endpoints.
 *
 * Receives a {@link StoryController} instance (created in the composition root
 * `server.ts`) and an auth middleware (created by `createAuthMiddleware` in
 * `routes/v1/index.ts`). Both are injected by the v1 index router — this
 * file does not instantiate any dependencies (Rule R17).
 *
 * **Route Ordering — CRITICAL:**
 * Static path segments `/feed` and `/me` are defined BEFORE any dynamic
 * `/:storyId` routes. Without this ordering, Express would match the
 * literal strings "feed" and "me" as `storyId` parameter values, causing
 * incorrect routing.
 *
 * **Middleware Chain (applied in order):**
 * 1. `authMiddleware` — JWT verification + Redis blacklist check (router-level)
 * 2. `apiRateLimiter` — 100 requests/minute per IP address (router-level)
 * 3. Per-route validation middleware (validateBody or validateParams)
 * 4. Controller handler method
 *
 * @param storyController - StoryController instance with bound handler methods
 * @param authMiddleware  - Express middleware for JWT authentication (Rule R9)
 * @returns Configured Express Router for mounting at `/stories`
 *
 * @example
 * ```typescript
 * // In routes/v1/index.ts:
 * import { createStoryRoutes } from './story.routes';
 *
 * router.use('/stories', createStoryRoutes(storyController, authMiddleware));
 * // Produces:
 * //   GET    /api/v1/stories/feed
 * //   GET    /api/v1/stories/me
 * //   POST   /api/v1/stories
 * //   POST   /api/v1/stories/:storyId/view
 * //   DELETE /api/v1/stories/:storyId
 * ```
 */
export function createStoryRoutes(
  storyController: StoryController,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  // ---------------------------------------------------------------------------
  // Router-level middleware: auth + rate limiting applied to ALL story routes
  // ---------------------------------------------------------------------------
  router.use(authMiddleware);
  router.use(apiRateLimiter);

  // ---------------------------------------------------------------------------
  // Static routes — MUST be declared before dynamic /:storyId routes
  // ---------------------------------------------------------------------------

  /**
   * GET /feed — Get story feed (contacts' stories grouped by user)
   *
   * Returns non-expired stories from the authenticated user's contacts,
   * grouped by author with metadata for rendering the feed UI (avatar,
   * hasUnviewed indicator, latest timestamp).
   *
   * Middleware chain: authMiddleware → apiRateLimiter → storyController.getFeed
   * Response: 200 { data: StoryFeedItem[] }
   */
  router.get(
    '/feed',
    storyController.getFeed,
  );

  /**
   * GET /me — Get current user's active (non-expired) stories
   *
   * Returns stories where expiresAt > now, sorted chronologically for
   * sequential viewing in the story viewer UI (Figma Screen 8 — "My Status").
   *
   * Middleware chain: authMiddleware → apiRateLimiter → storyController.getMyStories
   * Response: 200 { data: StoryResponse[] }
   */
  router.get(
    '/me',
    storyController.getMyStories,
  );

  // ---------------------------------------------------------------------------
  // Root route — POST / (create)
  // ---------------------------------------------------------------------------

  /**
   * POST / — Create a new story (text/image/video)
   *
   * Accepts a story creation payload validated by createStorySchema:
   * - type: TEXT | IMAGE | VIDEO (required)
   * - content: story text body (required for TEXT, max 1000 chars)
   * - mediaId: uploaded media reference (required for IMAGE/VIDEO, UUID)
   * - backgroundColor: hex color for text story backgrounds (optional)
   * - fontStyle: font style identifier (optional, max 50 chars)
   * - duration: display duration 1–30 seconds (optional, default set by service)
   *
   * Middleware chain: authMiddleware → apiRateLimiter → validateBody → storyController.create
   * Response: 201 { data: StoryResponse }
   */
  router.post(
    '/',
    validateBody(createStorySchema),
    storyController.create,
  );

  // ---------------------------------------------------------------------------
  // Dynamic routes — /:storyId patterns
  // ---------------------------------------------------------------------------

  /**
   * POST /:storyId/view — Record a story view
   *
   * Records that the authenticated user has viewed the specified story.
   * Duplicate views are handled gracefully by the service (returns null).
   * The service throws NotFoundError if the story does not exist or has
   * expired (Rule R11).
   *
   * Middleware chain: authMiddleware → apiRateLimiter → validateParams → storyController.view
   * Response: 200 { data: StoryView | null }
   */
  router.post(
    '/:storyId/view',
    validateParams(storyIdParamSchema),
    storyController.view,
  );

  /**
   * DELETE /:storyId — Delete a story (owner only)
   *
   * Only the story author can delete their own stories. The service handles
   * ownership verification, media blob cleanup from storage, and cascading
   * deletion of StoryView records.
   *
   * The service throws:
   * - NotFoundError if the story does not exist
   * - AuthorizationError if the authenticated user is not the author
   *
   * Middleware chain: authMiddleware → apiRateLimiter → validateParams → storyController.delete
   * Response: 200 { data: { message: string } }
   */
  router.delete(
    '/:storyId',
    validateParams(storyIdParamSchema),
    storyController.delete,
  );

  return router;
}
