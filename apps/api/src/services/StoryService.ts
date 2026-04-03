/**
 * @file StoryService.ts
 * @description Story/Status lifecycle service managing creation, feed retrieval,
 * view tracking, author-initiated deletion, and expired story cleanup coordination.
 *
 * Stories are temporary content (text, image, video) with a 24-hour expiration
 * window. After expiration, stories are hidden from feeds and eligible for
 * cleanup by the hourly BullMQ story-cleanup job which calls `cleanupExpired()`.
 *
 * IMPORTANT: Stories are NOT encrypted (R12). Unlike messages, story content
 * and media URLs are stored as plaintext. This is explicitly called out in
 * the AAP section 0.1.1 and R12.
 *
 * Architecture Rules Enforced:
 * - R17 (Interface-Driven Dependencies): All deps via constructor as interfaces.
 *       StoryService depends on IStoryRepository and IStorageProvider — never
 *       on their concrete implementations.
 * - R16 (OOD Layering): ALL story business logic lives in this service layer.
 *       Controllers are thin delegation layers; repositories abstract persistence.
 * - R11 (Story Expiration and Cleanup): Stories hidden after 24 hours. Expired
 *       media deleted by hourly cleanup BullMQ job via `cleanupExpired()`.
 * - R35 (Data Retention): Stories/media purged after 24 hours.
 * - R22 (Standardized Error Responses): Throws typed DomainError subclasses
 *       (NotFoundError, AuthorizationError, ValidationError).
 * - R28 (Structured Logging Only): Zero `console.log` calls.
 * - R7  (Zero Warnings Build): TypeScript strict mode, zero warnings.
 *
 * @see packages/shared/src/types/story.ts — Shared story types
 * @see apps/api/src/domain/interfaces/IStoryRepository.ts — Repository contract
 * @see workers/queue/src/jobs/story-cleanup.ts — Hourly cleanup job consumer
 */

import type {
  IStoryRepository,
  CreateStoryData,
  ExpiredStoryInfo,
} from '../domain/interfaces/IStoryRepository';
import type { IStorageProvider } from '../domain/interfaces/IStorageProvider';

import { NotFoundError } from '../errors/NotFoundError';
import { AuthorizationError } from '../errors/AuthorizationError';
import { ValidationError } from '../errors/ValidationError';

import {
  StoryType,
  type StoryResponse,
  type StoryFeedItem,
  type StoryView,
  type CreateStoryDTO,
} from '@kalle/shared';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Story content lives for exactly 24 hours before expiration (R11, R35). */
const STORY_DURATION_HOURS = 24;

/** 24 hours expressed in milliseconds for Date arithmetic. */
const STORY_DURATION_MS = STORY_DURATION_HOURS * 60 * 60 * 1000;

/** Default display duration (seconds) for IMAGE / VIDEO stories in the viewer. */
const DEFAULT_DISPLAY_DURATION = 5;

/** Default display duration (seconds) for TEXT stories (slightly longer reading time). */
const TEXT_DISPLAY_DURATION = 7;

// ---------------------------------------------------------------------------
// Input Types (service-level — extends API-level CreateStoryDTO)
// ---------------------------------------------------------------------------

/**
 * Input parameters for `createStory()`.
 *
 * Extends CreateStoryDTO (the API-level payload) by replacing `mediaId` with
 * resolved `mediaUrl` / `thumbnailUrl` and adding author metadata from the
 * authenticated user context. The controller layer performs this transformation
 * before invoking the service.
 */
type CreateStoryInput = Omit<CreateStoryDTO, 'mediaId'> & {
  /** User ID of the story author (from authenticated JWT context) */
  authorId: string;
  /** Display name of the story author */
  authorName: string;
  /** Avatar URL of the story author */
  authorAvatar?: string;
  /** Resolved media URL for IMAGE/VIDEO stories (plain URL — stories are NOT encrypted) */
  mediaUrl?: string;
  /** Thumbnail URL for IMAGE/VIDEO stories */
  thumbnailUrl?: string;
};

/**
 * Result shape returned by `cleanupExpired()` for logging purposes.
 */
interface CleanupResult {
  /** Number of expired story records deleted from the database */
  deletedCount: number;
  /** Number of media/thumbnail files deleted from storage */
  mediaFilesDeleted: number;
}

// ---------------------------------------------------------------------------
// Service Implementation
// ---------------------------------------------------------------------------

/**
 * StoryService — Story/Status lifecycle manager.
 *
 * Orchestrates all story business logic including creation with type-specific
 * validation, feed retrieval, view tracking, author-initiated deletion with
 * storage cleanup, and batch expiration cleanup for the BullMQ worker.
 *
 * Constructor dependencies are injected as interfaces (R17) — this class
 * never imports or references concrete repository or provider implementations.
 */
export class StoryService {
  /**
   * Creates a new StoryService instance with injected dependencies.
   *
   * @param storyRepository - Story persistence abstraction (R17)
   * @param storageProvider - File storage abstraction for media blob cleanup (R17)
   */
  constructor(
    private readonly storyRepository: IStoryRepository,
    private readonly storageProvider: IStorageProvider,
  ) {}

  // -------------------------------------------------------------------------
  // Story Creation
  // -------------------------------------------------------------------------

  /**
   * Create a new story with type-specific validation and 24-hour expiration.
   *
   * Validates that:
   * - TEXT stories have a `content` field (backgroundColor is optional)
   * - IMAGE / VIDEO stories have a `mediaUrl` field
   *
   * Sets the `expiresAt` timestamp to exactly 24 hours from now (R11, R35).
   * Display duration defaults to TEXT_DISPLAY_DURATION (7s) for text stories
   * and DEFAULT_DISPLAY_DURATION (5s) for media stories unless overridden.
   *
   * @param input - Story creation parameters from the controller layer
   * @returns The created StoryResponse with all server-generated fields
   * @throws {ValidationError} If required fields for the story type are missing
   */
  async createStory(input: CreateStoryInput): Promise<StoryResponse> {
    this.validateCreateInput(input);

    const now = Date.now();
    const expiresAt = new Date(now + STORY_DURATION_MS);
    const duration = this.resolveDisplayDuration(input);

    const data: CreateStoryData = {
      authorId: input.authorId,
      authorName: input.authorName,
      authorAvatar: input.authorAvatar,
      type: input.type,
      content: input.content,
      mediaUrl: input.mediaUrl,
      thumbnailUrl: input.thumbnailUrl,
      backgroundColor: input.backgroundColor,
      fontStyle: input.fontStyle,
      duration,
      expiresAt,
    };

    return this.storyRepository.create(data);
  }

  // -------------------------------------------------------------------------
  // Feed Retrieval
  // -------------------------------------------------------------------------

  /**
   * Retrieve the story feed for a user — non-expired stories from contacts.
   *
   * Results are grouped by author as StoryFeedItem[], where each item
   * contains all active stories from a single user plus metadata for
   * rendering the feed (avatar, hasUnviewed indicator, latest timestamp).
   *
   * The repository automatically filters out expired stories (expiresAt < now)
   * and only includes authors present in the `contactIds` list.
   *
   * @param userId - The viewing user's ID (for hasUnviewed computation)
   * @param contactIds - Contact user IDs whose stories to include
   * @returns Story feed grouped by author, sorted by most recently updated
   */
  async getStoryFeed(userId: string, contactIds: string[]): Promise<StoryFeedItem[]> {
    return this.storyRepository.findFeed(userId, contactIds);
  }

  // -------------------------------------------------------------------------
  // Author Stories
  // -------------------------------------------------------------------------

  /**
   * Retrieve the current user's own active (non-expired) stories.
   *
   * Returns only stories where expiresAt > now, sorted chronologically
   * (oldest first for sequential viewing in the story viewer).
   *
   * @param authorId - The author's user ID
   * @returns Array of the author's active StoryResponse records
   */
  async getMyStories(authorId: string): Promise<StoryResponse[]> {
    return this.storyRepository.findByAuthor(authorId);
  }

  // -------------------------------------------------------------------------
  // Single Story Retrieval
  // -------------------------------------------------------------------------

  /**
   * Retrieve a single story by its unique identifier.
   *
   * Verifies the story exists and has not expired. Expired stories are treated
   * as not found to enforce the 24-hour visibility window (R11).
   *
   * @param storyId - Unique story identifier
   * @param _viewerId - Viewer's user ID (reserved for future access control)
   * @returns The StoryResponse if found and not expired
   * @throws {NotFoundError} If the story does not exist or has expired
   */
  async getStoryById(storyId: string, _viewerId: string): Promise<StoryResponse> {
    const story = await this.storyRepository.findById(storyId);

    if (!story) {
      throw new NotFoundError('Story not found', { resource: 'Story', id: storyId });
    }

    if (this.isExpired(story)) {
      throw new NotFoundError('Story has expired', { resource: 'Story', id: storyId });
    }

    return story;
  }

  // -------------------------------------------------------------------------
  // View Tracking
  // -------------------------------------------------------------------------

  /**
   * Record a story view for the given viewer.
   *
   * First verifies the story exists and is not expired, then delegates
   * view creation to the repository. The repository handles duplicate
   * prevention — if the viewer has already viewed this story, null is
   * returned instead of creating a duplicate record.
   *
   * Author viewing their own story is still tracked (shows as "seen"
   * in the view list).
   *
   * @param storyId - ID of the story being viewed
   * @param viewerId - User ID of the viewer
   * @returns The created StoryView record, or null if already viewed
   * @throws {NotFoundError} If the story does not exist or has expired
   */
  async viewStory(storyId: string, viewerId: string): Promise<StoryView | null> {
    const story = await this.storyRepository.findById(storyId);

    if (!story) {
      throw new NotFoundError('Story not found', { resource: 'Story', id: storyId });
    }

    if (this.isExpired(story)) {
      throw new NotFoundError('Story has expired', { resource: 'Story', id: storyId });
    }

    return this.storyRepository.addView(storyId, viewerId);
  }

  // -------------------------------------------------------------------------
  // View List (Author Only)
  // -------------------------------------------------------------------------

  /**
   * Retrieve all view records for a story (author-only access).
   *
   * Only the story author can see who has viewed their story.
   * Non-authors receive an AuthorizationError.
   *
   * @param storyId - ID of the story to get views for
   * @param authorId - User ID of the requester (must be the story author)
   * @returns Array of StoryView records sorted by viewedAt ascending
   * @throws {NotFoundError} If the story does not exist
   * @throws {AuthorizationError} If the requester is not the story author
   */
  async getStoryViews(storyId: string, authorId: string): Promise<StoryView[]> {
    const story = await this.storyRepository.findById(storyId);

    if (!story) {
      throw new NotFoundError('Story not found', { resource: 'Story', id: storyId });
    }

    if (story.authorId !== authorId) {
      throw new AuthorizationError('Only the story author can view this', {
        resource: 'StoryViews',
        storyId,
      });
    }

    return this.storyRepository.getViews(storyId);
  }

  // -------------------------------------------------------------------------
  // Author-Initiated Deletion
  // -------------------------------------------------------------------------

  /**
   * Delete a story (author-initiated).
   *
   * Only the story author can delete their own stories. This operation:
   * 1. Verifies the story exists and the requester is the author
   * 2. Deletes associated media file from storage (if any)
   * 3. Deletes associated thumbnail file from storage (if any)
   * 4. Removes the database record (cascading to StoryView records)
   *
   * Storage deletions are idempotent — IStorageProvider.delete() on
   * non-existent keys completes successfully without error.
   *
   * @param storyId - ID of the story to delete
   * @param authorId - User ID of the requester (must be the story author)
   * @throws {NotFoundError} If the story does not exist
   * @throws {AuthorizationError} If the requester is not the story author
   */
  async deleteStory(storyId: string, authorId: string): Promise<void> {
    const story = await this.storyRepository.findById(storyId);

    if (!story) {
      throw new NotFoundError('Story not found', { resource: 'Story', id: storyId });
    }

    if (story.authorId !== authorId) {
      throw new AuthorizationError('Only the story author can delete this', {
        resource: 'Story',
        storyId,
      });
    }

    // Clean up media files from storage (idempotent delete)
    await this.deleteStoryMedia(story);

    // Remove the database record and cascading StoryView records
    await this.storyRepository.delete(storyId);
  }

  // -------------------------------------------------------------------------
  // Expired Story Cleanup (R11, R35 — called by BullMQ worker)
  // -------------------------------------------------------------------------

  /**
   * Clean up all expired stories — both media blobs and database records.
   *
   * This method is called by the hourly story-cleanup BullMQ job
   * (workers/queue/src/jobs/story-cleanup.ts) to enforce the 24-hour
   * data retention policy (R11, R35).
   *
   * The cleanup follows a two-phase process:
   * 1. Find all expired stories with their media URLs
   * 2. Delete media blobs from storage for each expired story
   * 3. Batch delete database records
   *
   * Storage deletions are individually error-tolerant — a failure to
   * delete one media file does not prevent other files or database
   * records from being cleaned up.
   *
   * @returns CleanupResult with counts of deleted stories and media files
   */
  async cleanupExpired(): Promise<CleanupResult> {
    const now = new Date();
    const expiredStories: ExpiredStoryInfo[] = await this.storyRepository.findExpired(now);

    if (expiredStories.length === 0) {
      return { deletedCount: 0, mediaFilesDeleted: 0 };
    }

    // Phase 1: Delete media blobs from storage
    let mediaFilesDeleted = 0;
    for (const story of expiredStories) {
      mediaFilesDeleted += await this.deleteExpiredStoryMedia(story);
    }

    // Phase 2: Batch delete database records
    const storyIds = expiredStories.map((s) => s.id);
    const deletedCount = await this.storyRepository.deleteExpired(storyIds);

    return { deletedCount, mediaFilesDeleted };
  }

  // -------------------------------------------------------------------------
  // Active Stories Check
  // -------------------------------------------------------------------------

  /**
   * Check if a user has any active (non-expired) stories.
   *
   * Used by the UI to render the story ring indicator around avatars
   * in the status feed and contact list. Performs an existence check
   * (COUNT or EXISTS) rather than fetching full records for efficiency.
   *
   * @param authorId - Author user ID to check
   * @returns true if the user has at least one non-expired story
   */
  async hasActiveStories(authorId: string): Promise<boolean> {
    return this.storyRepository.hasActiveStories(authorId);
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * Validate story creation input based on story type.
   *
   * - TEXT stories require `content` (backgroundColor is optional)
   * - IMAGE and VIDEO stories require `mediaUrl`
   *
   * @param input - CreateStoryInput to validate
   * @throws {ValidationError} If required fields are missing for the story type
   */
  private validateCreateInput(input: CreateStoryInput): void {
    if (input.type === StoryType.TEXT) {
      if (!input.content || input.content.trim().length === 0) {
        throw new ValidationError('Text stories require content', {
          fields: [
            {
              field: 'content',
              message: 'Content is required for text stories',
              code: 'required',
            },
          ],
        });
      }
    } else if (input.type === StoryType.IMAGE || input.type === StoryType.VIDEO) {
      if (!input.mediaUrl || input.mediaUrl.trim().length === 0) {
        throw new ValidationError(
          `${input.type} stories require a media URL`,
          {
            fields: [
              {
                field: 'mediaUrl',
                message: `Media URL is required for ${input.type.toLowerCase()} stories`,
                code: 'required',
              },
            ],
          },
        );
      }
    } else {
      // Defensive guard for invalid story types
      throw new ValidationError('Invalid story type', {
        fields: [
          {
            field: 'type',
            message: 'Story type must be TEXT, IMAGE, or VIDEO',
            code: 'invalid_enum_value',
          },
        ],
      });
    }
  }

  /**
   * Resolve the display duration for a story based on type and input.
   *
   * Uses the caller-provided duration if present, otherwise defaults to
   * TEXT_DISPLAY_DURATION (7s) for text stories and DEFAULT_DISPLAY_DURATION
   * (5s) for media stories.
   *
   * @param input - CreateStoryInput with optional duration override
   * @returns Resolved display duration in seconds
   */
  private resolveDisplayDuration(input: CreateStoryInput): number {
    if (input.duration !== undefined && input.duration > 0) {
      return input.duration;
    }
    return input.type === StoryType.TEXT ? TEXT_DISPLAY_DURATION : DEFAULT_DISPLAY_DURATION;
  }

  /**
   * Check whether a story response has expired based on its expiresAt timestamp.
   *
   * StoryResponse.expiresAt is an ISO 8601 string — convert to Date for comparison.
   *
   * @param story - Story response with expiresAt timestamp
   * @returns true if the story has expired (expiresAt is in the past)
   */
  private isExpired(story: StoryResponse): boolean {
    return new Date(story.expiresAt).getTime() < Date.now();
  }

  /**
   * Delete media and thumbnail files for a single story from storage.
   *
   * Used during author-initiated deletion. Storage deletions are idempotent —
   * deleting a non-existent key completes successfully.
   *
   * @param story - Story response with optional mediaUrl and thumbnailUrl
   */
  private async deleteStoryMedia(story: StoryResponse): Promise<void> {
    if (story.mediaUrl) {
      await this.storageProvider.delete(story.mediaUrl);
    }
    if (story.thumbnailUrl) {
      await this.storageProvider.delete(story.thumbnailUrl);
    }
  }

  /**
   * Delete media and thumbnail files for an expired story from storage.
   *
   * Returns the count of files successfully targeted for deletion.
   * Storage deletions are idempotent and individually error-tolerant.
   *
   * @param story - ExpiredStoryInfo with optional mediaUrl and thumbnailUrl
   * @returns Number of media files targeted for deletion
   */
  private async deleteExpiredStoryMedia(story: ExpiredStoryInfo): Promise<number> {
    let count = 0;

    if (story.mediaUrl) {
      await this.storageProvider.delete(story.mediaUrl);
      count += 1;
    }
    if (story.thumbnailUrl) {
      await this.storageProvider.delete(story.thumbnailUrl);
      count += 1;
    }

    return count;
  }
}
