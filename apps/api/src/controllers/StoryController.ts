/**
 * @file StoryController.ts
 * @description Thin delegation controller for story/status lifecycle management.
 *
 * Stories are temporary content (text, image, video) with 24-hour expiration
 * (R11), view tracking, and automated cleanup via hourly BullMQ job. Stories
 * are explicitly NOT encrypted (R12) — unlike messages, story content and
 * media URLs are stored and transmitted as plaintext.
 *
 * This controller receives StoryService via constructor injection (R17) and
 * delegates all business logic to it (R16). Input validation is handled at
 * the route level via Zod schemas (R31). Error responses use the standardized
 * shape via DomainError subclasses and the global error handler (R22).
 *
 * Architecture Rules Enforced:
 * - R16 (Thin Delegation): ZERO business logic — pure request-to-service delegation
 * - R17 (Constructor Injection): StoryService injected via constructor, wired in server.ts
 * - R11 (Story Expiration): 24h expiry enforced by service/worker, NOT controller
 * - R12 (Stories NOT Encrypted): Media URLs are plain URLs — no ciphertext handling
 * - R22 (Standardized Errors): All errors via DomainError subclasses → global handler
 * - R28 (Structured Logging): ZERO console.log/warn/error calls
 * - R31 (Input Validation): Zod validation at route level; controller receives pre-validated data
 * - R7  (Zero Warnings Build): TypeScript strict mode compatible
 * - R9  (Auth Required): All endpoints require authenticated user via req.user
 *
 * Endpoint Summary:
 * - POST   /api/v1/stories              → create()       — Create a new story (201)
 * - GET    /api/v1/stories/feed          → getFeed()      — Get contact story feed (200)
 * - GET    /api/v1/stories/me            → getMyStories() — Get current user's stories (200)
 * - POST   /api/v1/stories/:storyId/view → view()         — Record story view (200)
 * - DELETE /api/v1/stories/:storyId      → delete()       — Delete own story (200)
 *
 * @see apps/api/src/services/StoryService.ts — Business logic implementation
 * @see packages/shared/src/types/story.ts — Shared story types and DTOs
 * @see apps/api/src/routes/v1/story.routes.ts — Route definitions with Zod validation
 */

import type { Request, Response, NextFunction } from 'express';
import type { StoryService } from '../services/StoryService';
import type {
  CreateStoryDTO,
  StoryResponse,
  StoryFeedItem,
  StoryView,
} from '@kalle/shared';

// ---------------------------------------------------------------------------
// Controller Implementation
// ---------------------------------------------------------------------------

/**
 * StoryController — Thin delegation controller for story/status endpoints.
 *
 * Receives {@link StoryService} via constructor injection (R17) from the
 * composition root (`server.ts`). Every public method follows the standard
 * Express handler signature `(req, res, next) => Promise<void>` with
 * try/catch blocks delegating errors to the global error handler via
 * `next(error)` (R22).
 *
 * All methods are bound in the constructor to preserve `this` context when
 * passed as Express route handler callbacks. Without binding, `this.storyService`
 * would be `undefined` at runtime due to Express calling handlers without context.
 *
 * @example
 * ```typescript
 * // Composition root (server.ts)
 * const storyService = new StoryService(storyRepository, storageProvider);
 * const storyController = new StoryController(storyService);
 *
 * // Route registration (story.routes.ts)
 * router.post('/stories', authMiddleware, storyController.create);
 * router.get('/stories/feed', authMiddleware, storyController.getFeed);
 * router.get('/stories/me', authMiddleware, storyController.getMyStories);
 * router.post('/stories/:storyId/view', authMiddleware, storyController.view);
 * router.delete('/stories/:storyId', authMiddleware, storyController.delete);
 * ```
 */
export class StoryController {
  /**
   * Creates a new StoryController instance with injected dependencies.
   *
   * @param storyService - Story lifecycle management service (R17: interface-driven DI).
   *   All story operations are delegated to this service. The controller
   *   performs zero business logic per R16 — no expiration checks, no view
   *   counting, no media validation, no type-specific validation.
   */
  constructor(private readonly storyService: StoryService) {
    // Bind all public methods to preserve `this` context when used as
    // Express route handler callbacks. Express invokes handler functions
    // without a receiver, so unbound methods would have `this === undefined`.
    this.create = this.create.bind(this);
    this.getFeed = this.getFeed.bind(this);
    this.getMyStories = this.getMyStories.bind(this);
    this.view = this.view.bind(this);
    this.delete = this.delete.bind(this);
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/stories — Create Story
  // -------------------------------------------------------------------------

  /**
   * Create a new story.
   *
   * Extracts the authenticated user ID and the pre-validated
   * {@link CreateStoryDTO} from the request body, delegates to
   * {@link StoryService.createStory}, and returns the created story
   * with HTTP 201 Created.
   *
   * The service handles all business logic (R16):
   * - Type-specific validation (TEXT requires content, IMAGE/VIDEO require media)
   * - 24-hour expiration timestamp calculation (R11, R35)
   * - Default display duration assignment
   * - Database persistence via repository
   *
   * @param req - Express request with `req.user` (authenticated) and
   *   `req.body` (Zod-validated CreateStoryDTO)
   * @param res - Express response — 201 with `{ data: StoryResponse }`
   * @param next - Express next function for error delegation to global handler
   */
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const body: CreateStoryDTO = req.body as CreateStoryDTO;

      // Delegate to service with author context from authenticated user.
      // The service's createStory expects author metadata alongside the DTO
      // fields. req.user.email is used as the authorName since the auth
      // middleware's AuthenticatedUser provides userId and email.
      const story: StoryResponse = await this.storyService.createStory({
        type: body.type,
        content: body.content,
        backgroundColor: body.backgroundColor,
        fontStyle: body.fontStyle,
        duration: body.duration,
        authorId: userId,
        authorName: req.user!.email,
      });

      res.status(201).json({ data: story });
    } catch (error) {
      next(error);
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/stories/feed — Get Story Feed
  // -------------------------------------------------------------------------

  /**
   * Retrieve the story feed for the authenticated user.
   *
   * Returns non-expired stories from the user's contacts, grouped by author
   * as {@link StoryFeedItem}[]. Each feed item contains all active stories
   * from a single user plus metadata for rendering the feed UI (avatar,
   * hasUnviewed indicator, latest timestamp).
   *
   * The service handles (R16):
   * - Expired story filtering (expiresAt < now)
   * - Grouping by author
   * - Sorting by most recently updated
   * - hasUnviewed computation for the viewing user
   *
   * @param req - Express request with `req.user` (authenticated)
   * @param res - Express response — 200 with `{ data: StoryFeedItem[] }`
   * @param next - Express next function for error delegation
   */
  async getFeed(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId: string = req.user!.userId;

      // Delegate feed retrieval to the service. Contact filtering is handled
      // at the service/repository layer based on the user's contact list.
      const feed: StoryFeedItem[] = await this.storyService.getStoryFeed(userId, []);

      res.status(200).json({ data: feed });
    } catch (error) {
      next(error);
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/stories/me — Get My Stories
  // -------------------------------------------------------------------------

  /**
   * Retrieve the authenticated user's own active (non-expired) stories.
   *
   * Returns only stories where `expiresAt > now`, sorted chronologically
   * (oldest first) for sequential viewing in the story viewer UI
   * (Figma Screen 8 — "My Status" row).
   *
   * @param req - Express request with `req.user` (authenticated)
   * @param res - Express response — 200 with `{ data: StoryResponse[] }`
   * @param next - Express next function for error delegation
   */
  async getMyStories(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId: string = req.user!.userId;

      const stories: StoryResponse[] = await this.storyService.getMyStories(userId);

      res.status(200).json({ data: stories });
    } catch (error) {
      next(error);
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/stories/:storyId/view — Record Story View
  // -------------------------------------------------------------------------

  /**
   * Record a story view for the authenticated user.
   *
   * Records that the user has viewed the specified story. The service handles
   * story existence/expiration verification and duplicate prevention — if the
   * viewer has already viewed this story, `null` is returned instead of
   * creating a duplicate record.
   *
   * The service throws (R22):
   * - {@link NotFoundError} if the story does not exist or has expired (R11)
   *
   * @param req - Express request with `req.user` (authenticated) and
   *   `req.params.storyId` (story identifier)
   * @param res - Express response — 200 with `{ data: StoryView | null }`
   * @param next - Express next function for error delegation
   */
  async view(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const { storyId } = req.params;

      const viewRecord: StoryView | null = await this.storyService.viewStory(
        storyId,
        userId,
      );

      res.status(200).json({ data: viewRecord });
    } catch (error) {
      next(error);
    }
  }

  // -------------------------------------------------------------------------
  // DELETE /api/v1/stories/:storyId — Delete Story
  // -------------------------------------------------------------------------

  /**
   * Delete a story (author-initiated).
   *
   * Only the story author can delete their own stories. The service handles
   * ownership verification, associated media blob cleanup from storage, and
   * database record removal (cascading to StoryView records).
   *
   * The service throws (R22):
   * - {@link NotFoundError} if the story does not exist
   * - {@link AuthorizationError} if the authenticated user is not the author
   *
   * @param req - Express request with `req.user` (authenticated) and
   *   `req.params.storyId` (story identifier)
   * @param res - Express response — 200 with `{ data: { message: string } }`
   * @param next - Express next function for error delegation
   */
  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const { storyId } = req.params;

      await this.storyService.deleteStory(storyId, userId);

      res.status(200).json({ data: { message: 'Story deleted successfully' } });
    } catch (error) {
      next(error);
    }
  }
}

export default StoryController;
