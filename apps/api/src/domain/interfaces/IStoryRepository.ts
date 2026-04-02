/**
 * @module IStoryRepository
 * @description Story repository contract for persisting stories/status updates
 * with 24-hour expiration, view tracking, feed retrieval, and expired story cleanup.
 *
 * This interface abstracts all story persistence operations. The concrete
 * implementation (`StoryRepository`) uses Prisma ORM against PostgreSQL.
 * Services code ONLY against this interface (Rule R17).
 *
 * Key architectural rules:
 * - R17 (Interface-Driven Dependencies): Services never import concrete repositories.
 * - R16 (OOD Layering): Repository abstracts persistence — zero business logic.
 * - R11 (Story Expiration): Stories hidden after 24h; expired media deleted by
 *   hourly cleanup BullMQ job via findExpired() + deleteExpired().
 * - R35 (Data Retention): Stories/media purged after 24h.
 * - R12 (E2E Encryption): Stories are NOT encrypted — mediaUrl is a plain URL,
 *   content is plaintext. Only messages use Signal Protocol encryption.
 * - R7 (Zero Warnings Build): TypeScript strict mode, zero warnings.
 * - R28 (Structured Logging): Zero console.log calls.
 *
 * Database index: authorId + expiresAt (per AAP Section 0.4.5) used by
 * findByAuthor() and findFeed() for efficient querying.
 *
 * @see packages/shared/src/types/story.ts — Shared story types
 * @see apps/api/src/repositories/StoryRepository.ts — Concrete implementation
 * @see workers/queue/src/jobs/story-cleanup.ts — Hourly cleanup job consumer
 */

import type {
  StoryResponse,
  StoryFeedItem,
  StoryView,
  StoryType,
} from '@kalle/shared';

/**
 * Re-export CreateStoryDTO from the shared package for API contract alignment.
 * Consumers of this interface module may need the DTO type to transform
 * API-level requests into repository-level CreateStoryData.
 */
export type { CreateStoryDTO } from '@kalle/shared';

// ---------------------------------------------------------------------------
// Repository-Level Types
// ---------------------------------------------------------------------------

/**
 * Data required to create a new story record in the persistence layer.
 *
 * This is the repository-level input type — distinct from the API-level
 * `CreateStoryDTO` which is the client request payload. The service layer
 * transforms `CreateStoryDTO` into `CreateStoryData` by resolving the
 * media reference, computing the expiration timestamp, and attaching
 * author metadata from the authenticated user context.
 *
 * All fields map directly to database columns. Optional fields are nullable
 * in the database schema.
 */
export interface CreateStoryData {
  /**
   * Optional pre-generated UUID for the story.
   * If omitted, the repository implementation generates one.
   */
  id?: string;

  /** User ID of the story author (foreign key to User table) */
  authorId: string;

  /** Display name of the story author at time of creation */
  authorName: string;

  /**
   * Avatar URL of the story author at time of creation.
   * Stored denormalized for efficient feed rendering without joins.
   */
  authorAvatar?: string;

  /** Type of story content: TEXT, IMAGE, or VIDEO */
  type: StoryType;

  /**
   * Text content for TEXT stories, rendered as large centered text
   * on the colored background. For IMAGE/VIDEO stories, may contain
   * a caption. Optional — not required for media-only stories.
   */
  content?: string;

  /**
   * Media URL for IMAGE/VIDEO stories.
   * This is a plain URL — stories are NOT encrypted (R12).
   * Not applicable for TEXT-only stories.
   */
  mediaUrl?: string;

  /**
   * Thumbnail URL for IMAGE/VIDEO stories (smaller preview image).
   * Used in the status feed list for faster rendering.
   */
  thumbnailUrl?: string;

  /**
   * Hex color code for TEXT story background (e.g., "#FF6B6B").
   * Corresponds to the colored background in Figma Screen 10.
   * Not applicable for IMAGE/VIDEO stories.
   */
  backgroundColor?: string;

  /**
   * Font style identifier for TEXT stories.
   * Controls the text rendering style on the colored background.
   */
  fontStyle?: string;

  /**
   * Display duration in seconds for the story viewer.
   * Determines how long the story is shown before auto-advancing
   * to the next story in the sequence.
   */
  duration: number;

  /**
   * Expiration timestamp — exactly 24 hours after creation (R11, R35).
   * After this time, the story is hidden from feeds and eligible
   * for cleanup by the hourly BullMQ story-cleanup job.
   */
  expiresAt: Date;
}

/**
 * Expired story record for cleanup purposes.
 *
 * Returned by `findExpired()` to provide the hourly story-cleanup
 * BullMQ job with the information needed to:
 * 1. Delete media blobs from storage (via mediaUrl and thumbnailUrl)
 * 2. Remove database records via `deleteExpired(storyIds)`
 *
 * Only includes the fields necessary for cleanup — no author info
 * or content since those are no longer needed after expiration.
 *
 * @see workers/queue/src/jobs/story-cleanup.ts — Consumer of this data
 */
export interface ExpiredStoryInfo {
  /** Unique story identifier used for bulk deletion */
  id: string;

  /**
   * Media URL to delete from storage.
   * Undefined for TEXT-only stories (no media to clean up).
   */
  mediaUrl?: string;

  /**
   * Thumbnail URL to delete from storage.
   * Undefined for TEXT-only stories or stories without thumbnails.
   */
  thumbnailUrl?: string;
}

// ---------------------------------------------------------------------------
// Repository Interface
// ---------------------------------------------------------------------------

/**
 * IStoryRepository — Story persistence contract.
 *
 * Defines all data access operations for the Story aggregate. The concrete
 * implementation backs this with Prisma against PostgreSQL. Services code
 * against this interface — never against the concrete class (R17).
 *
 * Operations are grouped into:
 * - **CRUD**: create, findById, findByAuthor, delete
 * - **Feed**: findFeed (grouped by author for status feed view)
 * - **View tracking**: addView (with duplicate prevention), getViews
 * - **Cleanup**: findExpired, deleteExpired (for hourly BullMQ job)
 * - **Status check**: hasActiveStories (for UI status indicator)
 *
 * All methods return Promises for async database operations.
 * Return types use shared DTOs from `@kalle/shared` to maintain
 * type consistency across the API boundary.
 */
export interface IStoryRepository {
  /**
   * Create a new story record in the database.
   *
   * Persists the story with all provided metadata and returns the
   * complete `StoryResponse` representation including generated fields
   * (id, createdAt, viewCount=0, isExpired=false).
   *
   * @param data - CreateStoryData containing story content and metadata.
   *   The service layer is responsible for computing `expiresAt` (24h from now)
   *   and resolving author metadata before calling this method.
   * @returns The created StoryResponse with all server-generated fields populated
   */
  create(data: CreateStoryData): Promise<StoryResponse>;

  /**
   * Find a single story by its unique identifier.
   *
   * Returns the full StoryResponse or null if no story exists with the
   * given ID. Does NOT filter by expiration — callers must check
   * `isExpired` if they need to enforce visibility rules.
   *
   * @param id - Unique story identifier (UUID)
   * @returns StoryResponse if found, null otherwise
   */
  findById(id: string): Promise<StoryResponse | null>;

  /**
   * Get the story feed for a user — non-expired stories from their contacts.
   *
   * Results are grouped by author as `StoryFeedItem[]`, where each item
   * contains all active stories from a single user plus metadata for
   * rendering the feed (avatar, hasUnviewed indicator, latest timestamp).
   *
   * Uses the composite index on (authorId, expiresAt) for efficient querying.
   * Only returns stories where `expiresAt > now` and the author is in
   * the provided `contactIds` list.
   *
   * @param userId - The viewing user's ID, used to compute `hasUnviewed`
   *   status by checking if the user has viewed each story
   * @param contactIds - Array of contact user IDs whose stories to include
   *   in the feed. Empty array returns empty feed.
   * @returns Array of StoryFeedItem grouped by author, sorted by most
   *   recently updated (latest story timestamp descending)
   */
  findFeed(userId: string, contactIds: string[]): Promise<StoryFeedItem[]>;

  /**
   * Find all active (non-expired) stories by a specific author.
   *
   * Returns stories where `expiresAt > now` and `authorId` matches,
   * sorted chronologically (oldest first for sequential viewing).
   * Uses the composite index on (authorId, expiresAt).
   *
   * @param authorId - Author user ID to look up
   * @returns Array of StoryResponse records sorted by createdAt ascending
   */
  findByAuthor(authorId: string): Promise<StoryResponse[]>;

  /**
   * Record a story view (viewer tracked per story).
   *
   * Creates a StoryView record linking the viewer to the story.
   * Implements duplicate prevention: if the same viewer has already
   * viewed this story, returns null instead of creating a duplicate
   * record. This ensures `viewCount` remains accurate.
   *
   * @param storyId - ID of the story being viewed
   * @param viewerId - User ID of the viewer
   * @returns The created StoryView record, or null if this viewer has
   *   already viewed this story (duplicate prevention)
   */
  addView(storyId: string, viewerId: string): Promise<StoryView | null>;

  /**
   * Get all view records for a specific story.
   *
   * Returns the full list of StoryView records including viewer
   * metadata (name, avatar, timestamp). Used by the story author
   * to see who has viewed their story.
   *
   * @param storyId - ID of the story to get views for
   * @returns Array of StoryView records sorted by viewedAt ascending
   */
  getViews(storyId: string): Promise<StoryView[]>;

  /**
   * Find all expired stories eligible for cleanup (R11, R35).
   *
   * Returns stories where `expiresAt < now`, including their media
   * URLs so the cleanup job can delete associated blobs from storage
   * before removing database records.
   *
   * Called by the hourly story-cleanup BullMQ job as the first step
   * in the two-phase cleanup process:
   * 1. `findExpired()` — get expired story IDs and media URLs
   * 2. Delete media blobs from storage using the URLs
   * 3. `deleteExpired(storyIds)` — remove database records
   *
   * @param now - Reference timestamp for expiration check. Defaults to
   *   current time when omitted. Explicit parameter enables testing.
   * @returns Array of ExpiredStoryInfo with IDs and media URLs
   */
  findExpired(now?: Date): Promise<ExpiredStoryInfo[]>;

  /**
   * Bulk delete expired stories and their associated view records (R11, R35).
   *
   * Removes story records and cascading StoryView records for the
   * given IDs. Called by the hourly story-cleanup BullMQ job after
   * media blobs have been deleted from storage.
   *
   * This is a hard delete (not soft delete) since expired stories
   * have no business value after the 24-hour window.
   *
   * @param storyIds - Array of story IDs to delete. Empty array is a no-op.
   * @returns Number of stories actually deleted (may be less than
   *   storyIds.length if some were already deleted)
   */
  deleteExpired(storyIds: string[]): Promise<number>;

  /**
   * Delete a specific story by ID (author-initiated deletion).
   *
   * Removes the story record and all associated StoryView records.
   * Used when the author explicitly deletes their own story before
   * the 24-hour expiration window. The caller (service layer) is
   * responsible for verifying ownership before invoking this method.
   *
   * @param id - Story ID to delete
   * @throws Should propagate database errors (e.g., record not found)
   */
  delete(id: string): Promise<void>;

  /**
   * Check if a user has any active (non-expired) stories.
   *
   * Performs an existence check (COUNT or EXISTS query) rather than
   * fetching full records, for efficiency. Used by the UI to render
   * the story ring indicator around avatars in the status feed and
   * contact list.
   *
   * @param authorId - Author user ID to check
   * @returns true if the user has at least one story where
   *   `expiresAt > now`, false otherwise
   */
  hasActiveStories(authorId: string): Promise<boolean>;
}
