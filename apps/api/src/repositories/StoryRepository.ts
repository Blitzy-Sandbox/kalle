/**
 * @module apps/api/src/repositories/StoryRepository
 *
 * Prisma-backed implementation of the {@link IStoryRepository} interface.
 *
 * Handles persistence of stories (text, image, video) with 24-hour expiration,
 * view tracking, feed aggregation, and support for the hourly story-cleanup
 * BullMQ job. Stories are NOT encrypted — only messages use E2E encryption
 * per AAP R12.
 *
 * Architecture rules enforced:
 * - **R11** (Story Expiration): Stories hidden after 24h. `findFeed` and
 *   `findByAuthor` filter by `expiresAt > now`.
 * - **R35** (Data Retention): `findExpired` + `deleteExpired` support the
 *   hourly cleanup BullMQ job that purges expired stories and associated media.
 * - **R17** (Interface-Driven Dependencies): Implements `IStoryRepository`.
 *   `PrismaClient` injected via constructor — no hard-coded instantiation.
 * - **R16** (OOD Layering): Zero business logic — persistence and data mapping
 *   only. Expiration computation, ownership checks, and access control happen
 *   in StoryService.
 * - **R7**  (Zero Warnings Build): TypeScript strict mode, zero warnings.
 * - **R28** (Structured Logging): Zero `console.log` — structured Pino logging
 *   is handled at the service layer.
 *
 * Field mapping (Prisma Story → Shared StoryResponse):
 * | Prisma column       | Shared field     | Transformation          |
 * |---------------------|------------------|-------------------------|
 * | `textContent`       | `content`        | Rename, null→undefined  |
 * | `author.displayName`| `authorName`     | Join via include        |
 * | `author.avatarUrl`  | `authorAvatar`   | Join, null→undefined    |
 * | `media[0].encryptedUrl` | `mediaUrl`   | First media record      |
 * | `media[0].thumbnailUrl` | `thumbnailUrl`| First media record     |
 * | `_count.views`      | `viewCount`      | Prisma count aggregate  |
 * | `expiresAt` (Date)  | `expiresAt` (str)| `.toISOString()`        |
 * | `expiresAt < now`   | `isExpired`      | Computed boolean        |
 * | `createdAt` (Date)  | `createdAt` (str)| `.toISOString()`        |
 *
 * @see {@link IStoryRepository} for the persistence contract
 * @see {@link StoryService} for business logic orchestrating this repository
 * @see workers/queue/src/jobs/story-cleanup.ts — Hourly cleanup job consumer
 */

import type { PrismaClient } from '@prisma/client';
import type {
  IStoryRepository,
  CreateStoryData,
  ExpiredStoryInfo,
} from '../domain/interfaces/IStoryRepository.js';
import type {
  StoryResponse,
  StoryFeedItem,
  StoryView,
} from '@kalle/shared';

// =============================================================================
// StoryRepository — Prisma-backed implementation
// =============================================================================

export class StoryRepository implements IStoryRepository {
  /**
   * Reusable author select clause for include objects.
   * Fetches only the fields needed for StoryResponse author metadata.
   */
  private static readonly AUTHOR_SELECT = {
    id: true,
    displayName: true,
    avatarUrl: true,
  } as const;

  /**
   * Reusable media select clause for include objects.
   * Fetches the first media record's URLs for the story response.
   * Stories typically have at most one media attachment.
   */
  private static readonly MEDIA_SELECT = {
    select: { encryptedUrl: true, thumbnailUrl: true } as const,
    take: 1 as const,
  };

  constructor(private readonly prisma: PrismaClient) {}

  // ─── Create ──────────────────────────────────────────────────────────

  /**
   * Persist a new story record in the database.
   *
   * Maps `CreateStoryData` domain fields to Prisma schema columns:
   * - `content` → `textContent`
   * - `type` (shared StoryType) → Prisma StoryType (identical string values)
   *
   * If `data.id` is provided, uses it as the record PK; otherwise Prisma
   * generates a UUID v4. Includes author and media relations in the response.
   *
   * For newly created stories, the media relation may be empty if the service
   * hasn't linked the media record yet. In that case, `data.mediaUrl` and
   * `data.thumbnailUrl` are used as fallback values in the response.
   *
   * @param data - Story creation data with all fields computed by StoryService
   * @returns Complete StoryResponse with author info and server-generated fields
   */
  async create(data: CreateStoryData): Promise<StoryResponse> {
    const record = await this.prisma.story.create({
      data: {
        // Use pre-generated ID if provided; otherwise Prisma generates UUID v4
        ...(data.id !== undefined ? { id: data.id } : {}),
        authorId: data.authorId,
        // Both shared and Prisma StoryType enums use identical string values
        // ('TEXT', 'IMAGE', 'VIDEO'), making the assignment safe at runtime.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: data.type as any,
        textContent: data.content ?? null,
        backgroundColor: data.backgroundColor ?? null,
        fontStyle: data.fontStyle ?? null,
        duration: data.duration,
        expiresAt: data.expiresAt,
      },
      include: {
        author: { select: StoryRepository.AUTHOR_SELECT },
        media: StoryRepository.MEDIA_SELECT,
        _count: { select: { views: true } },
      },
    });

    // For create, media may not yet be linked — fall back to input URLs
    return this.mapToStoryResponse(record, data.mediaUrl, data.thumbnailUrl);
  }

  // ─── Read (Single) ───────────────────────────────────────────────────

  /**
   * Find a single story by its unique identifier.
   *
   * Does NOT filter by expiration — returns the record regardless of whether
   * it has expired. The caller (service layer) must check `isExpired` if
   * visibility enforcement is needed.
   *
   * @param id - UUID of the story
   * @returns StoryResponse if found, null otherwise
   */
  async findById(id: string): Promise<StoryResponse | null> {
    const record = await this.prisma.story.findUnique({
      where: { id },
      include: {
        author: { select: StoryRepository.AUTHOR_SELECT },
        media: StoryRepository.MEDIA_SELECT,
        _count: { select: { views: true } },
      },
    });

    return record !== null ? this.mapToStoryResponse(record) : null;
  }

  // ─── Feed (Grouped by Author) ────────────────────────────────────────

  /**
   * Get the story feed for a user — non-expired stories from given contacts.
   *
   * CRITICAL (R11): Only returns stories where `expiresAt > now`. Expired
   * stories are excluded even if not yet cleaned up by the hourly job.
   *
   * Results are grouped by author as `StoryFeedItem[]`. Each item contains:
   * - All active stories from that author, sorted chronologically (oldest first)
   * - `hasUnviewed` flag: true if any story in the group is unseen by the viewer
   * - `latestStoryAt` timestamp for sorting the feed (most recent first)
   *
   * Uses the composite index on `(authorId, expiresAt)` for efficient querying.
   *
   * @param userId - The viewing user's ID (used to compute `hasUnviewed`)
   * @param contactIds - Array of user IDs whose stories to include.
   *   Empty array returns empty feed immediately (no DB query).
   * @returns Feed items sorted by most recently updated (descending)
   */
  async findFeed(userId: string, contactIds: string[]): Promise<StoryFeedItem[]> {
    if (contactIds.length === 0) {
      return [];
    }

    const now = new Date();

    // Fetch all active stories from the given contacts, with view check
    const records = await this.prisma.story.findMany({
      where: {
        authorId: { in: contactIds },
        expiresAt: { gt: now }, // R11: Only active (non-expired) stories
      },
      include: {
        author: { select: StoryRepository.AUTHOR_SELECT },
        media: StoryRepository.MEDIA_SELECT,
        // Include ONLY the current viewer's view record for hasUnviewed check
        views: {
          where: { viewerId: userId },
          select: { id: true },
        },
        _count: { select: { views: true } },
      },
      orderBy: { createdAt: 'asc' }, // Oldest first within groups
    });

    // Group stories by author ID
    const groupedMap = new Map<
      string,
      {
        author: { id: string; displayName: string; avatarUrl: string | null };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stories: any[];
      }
    >();

    for (const record of records) {
      const existing = groupedMap.get(record.authorId);
      if (existing) {
        existing.stories.push(record);
      } else {
        groupedMap.set(record.authorId, {
          author: record.author,
          stories: [record],
        });
      }
    }

    // Convert grouped map to StoryFeedItem array
    const feedItems: StoryFeedItem[] = [];

    for (const [authorId, group] of groupedMap) {
      const stories = group.stories.map((r) => this.mapToStoryResponse(r));

      // hasUnviewed: true if any story in the group was NOT viewed by this user
      const hasUnviewed = group.stories.some(
        (r) => Array.isArray(r.views) && r.views.length === 0,
      );

      // latestStoryAt: the most recent story's creation time (last in asc order)
      const latestRecord = group.stories[group.stories.length - 1];
      const latestStoryAt =
        latestRecord.createdAt instanceof Date
          ? latestRecord.createdAt.toISOString()
          : String(latestRecord.createdAt);

      feedItems.push({
        userId: authorId,
        userName: group.author.displayName,
        userAvatar: group.author.avatarUrl ?? undefined,
        stories,
        hasUnviewed,
        latestStoryAt,
      });
    }

    // Sort feed items by most recently updated author (descending)
    feedItems.sort((a, b) => b.latestStoryAt.localeCompare(a.latestStoryAt));

    return feedItems;
  }

  // ─── Read (By Author) ────────────────────────────────────────────────

  /**
   * Find all active (non-expired) stories by a specific author.
   *
   * Returns stories sorted chronologically (oldest first) for sequential
   * viewing in the status viewer. Uses the composite index on
   * `(authorId, expiresAt)` for efficient querying.
   *
   * @param authorId - Author user ID to look up
   * @returns Array of StoryResponse sorted by createdAt ascending
   */
  async findByAuthor(authorId: string): Promise<StoryResponse[]> {
    const now = new Date();

    const records = await this.prisma.story.findMany({
      where: {
        authorId,
        expiresAt: { gt: now }, // R11: Only active stories
      },
      include: {
        author: { select: StoryRepository.AUTHOR_SELECT },
        media: StoryRepository.MEDIA_SELECT,
        _count: { select: { views: true } },
      },
      orderBy: { createdAt: 'asc' }, // Oldest first for sequential viewing
    });

    return records.map((r) => this.mapToStoryResponse(r));
  }

  // ─── View Tracking ───────────────────────────────────────────────────

  /**
   * Record a story view by a user. Prevents duplicates.
   *
   * Checks for an existing view record first. If found, returns `null`
   * (duplicate prevention per interface contract). If not found, creates
   * a new StoryView record.
   *
   * Handles the race condition where two concurrent requests attempt
   * to create the same view: if the `findUnique` check passes but a
   * concurrent insert beats us, the unique constraint violation (P2002)
   * is caught and `null` is returned.
   *
   * @param storyId - ID of the story being viewed
   * @param viewerId - User ID of the viewer
   * @returns The created StoryView, or null if already viewed
   */
  async addView(storyId: string, viewerId: string): Promise<StoryView | null> {
    // Check for existing view (fast path — avoids unnecessary create attempt)
    const existing = await this.prisma.storyView.findUnique({
      where: {
        storyId_viewerId: { storyId, viewerId },
      },
    });

    if (existing !== null) {
      return null; // Already viewed — duplicate prevention
    }

    try {
      const record = await this.prisma.storyView.create({
        data: {
          storyId,
          viewerId,
        },
        include: {
          viewer: { select: StoryRepository.AUTHOR_SELECT },
        },
      });

      return this.mapToStoryView(record);
    } catch (error: unknown) {
      // Race condition: concurrent request created the view between
      // our findUnique check and this create attempt.
      // P2002 = Prisma unique constraint violation
      if (StoryRepository.isUniqueConstraintError(error)) {
        return null;
      }
      throw error; // Propagate unexpected errors
    }
  }

  /**
   * Get all view records for a specific story.
   *
   * Returns viewer metadata (name, avatar, timestamp) for the story
   * author's viewer list. Sorted by viewedAt ascending (earliest first).
   *
   * @param storyId - ID of the story to get views for
   * @returns Array of StoryView records with viewer profiles
   */
  async getViews(storyId: string): Promise<StoryView[]> {
    const records = await this.prisma.storyView.findMany({
      where: { storyId },
      include: {
        viewer: { select: StoryRepository.AUTHOR_SELECT },
      },
      orderBy: { viewedAt: 'asc' },
    });

    return records.map((r) => this.mapToStoryView(r));
  }

  // ─── Cleanup (R11, R35) ──────────────────────────────────────────────

  /**
   * Find all expired stories eligible for cleanup.
   *
   * Returns story IDs and their media URLs so the hourly cleanup job can:
   * 1. Delete media blobs from storage (using mediaUrl/thumbnailUrl)
   * 2. Remove database records via `deleteExpired(storyIds)`
   *
   * @param now - Reference timestamp for expiration check.
   *   Defaults to current time. Explicit parameter enables testing.
   * @returns Array of ExpiredStoryInfo with IDs and media URLs
   */
  async findExpired(now?: Date): Promise<ExpiredStoryInfo[]> {
    const referenceDate = now ?? new Date();

    const records = await this.prisma.story.findMany({
      where: {
        expiresAt: { lte: referenceDate },
      },
      select: {
        id: true,
        media: {
          select: { encryptedUrl: true, thumbnailUrl: true },
          take: 1, // Primary media record
        },
      },
    });

    return records.map((r) => ({
      id: r.id,
      mediaUrl: r.media[0]?.encryptedUrl,
      thumbnailUrl: r.media[0]?.thumbnailUrl ?? undefined,
    }));
  }

  /**
   * Bulk delete expired stories and their associated view records.
   *
   * Explicitly deletes StoryView records before Story records for clarity,
   * even though the database FK cascade (`onDelete: Cascade` on StoryView.story)
   * would handle this automatically.
   *
   * Empty `storyIds` array is a no-op returning 0.
   *
   * @param storyIds - Array of story IDs to delete
   * @returns Number of stories actually deleted
   */
  async deleteExpired(storyIds: string[]): Promise<number> {
    if (storyIds.length === 0) {
      return 0;
    }

    // Explicitly delete views first for clarity (DB cascade would also handle this)
    await this.prisma.storyView.deleteMany({
      where: { storyId: { in: storyIds } },
    });

    // Delete the expired story records
    const result = await this.prisma.story.deleteMany({
      where: { id: { in: storyIds } },
    });

    return result.count;
  }

  // ─── Delete (Author-Initiated) ───────────────────────────────────────

  /**
   * Delete a specific story by ID (author-initiated deletion).
   *
   * Removes the story and all associated StoryView records. Propagates
   * database errors (e.g., Prisma P2025 if record not found) to the caller.
   * The service layer is responsible for verifying ownership before calling.
   *
   * @param id - Story ID to delete
   * @throws Prisma error if the story does not exist
   */
  async delete(id: string): Promise<void> {
    // Explicitly delete views first for clarity (DB cascade would also handle this)
    await this.prisma.storyView.deleteMany({
      where: { storyId: id },
    });

    await this.prisma.story.delete({
      where: { id },
    });
  }

  // ─── Status Check ────────────────────────────────────────────────────

  /**
   * Check if a user has any active (non-expired) stories.
   *
   * Uses `count()` rather than `findMany()` for efficiency — avoids
   * fetching full records. Used by the UI to render the story ring
   * indicator around avatars.
   *
   * @param authorId - Author user ID to check
   * @returns true if the user has at least one active story
   */
  async hasActiveStories(authorId: string): Promise<boolean> {
    const count = await this.prisma.story.count({
      where: {
        authorId,
        expiresAt: { gt: new Date() },
      },
    });

    return count > 0;
  }

  // ─── Private Mappers ─────────────────────────────────────────────────

  /**
   * Maps a raw Prisma Story record (with includes) to the shared
   * {@link StoryResponse} DTO.
   *
   * Performs the following transformations:
   * - Extracts author metadata from the `author` include
   * - Extracts media URLs from the first `media` include record
   * - Falls back to provided `fallbackMediaUrl`/`fallbackThumbnailUrl` when
   *   no media is linked yet (e.g., immediately after create)
   * - Converts nullable fields to `undefined` for JSON compatibility
   * - Computes `isExpired` boolean from `expiresAt`
   * - Converts `Date` fields to ISO 8601 strings
   *
   * @param record - Raw Prisma record with author, media, and _count includes
   * @param fallbackMediaUrl - URL to use if no media record is linked
   * @param fallbackThumbnailUrl - Thumbnail URL to use if no media record is linked
   * @returns Domain-typed {@link StoryResponse}
   */
  private mapToStoryResponse(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    record: any,
    fallbackMediaUrl?: string,
    fallbackThumbnailUrl?: string,
  ): StoryResponse {
    const firstMedia = Array.isArray(record.media) ? record.media[0] : undefined;
    const expiresAt =
      record.expiresAt instanceof Date
        ? record.expiresAt
        : new Date(record.expiresAt as string);
    const now = new Date();

    return {
      id: record.id as string,
      authorId: record.authorId as string,
      authorName: (record.author?.displayName as string) ?? '',
      authorAvatar: (record.author?.avatarUrl as string | null) ?? undefined,
      type: record.type as StoryResponse['type'],
      content: (record.textContent as string | null) ?? undefined,
      mediaUrl:
        (firstMedia?.encryptedUrl as string | undefined) ??
        fallbackMediaUrl,
      thumbnailUrl:
        (firstMedia?.thumbnailUrl as string | null | undefined) ??
        fallbackThumbnailUrl,
      backgroundColor: (record.backgroundColor as string | null) ?? undefined,
      fontStyle: (record.fontStyle as string | null) ?? undefined,
      duration: (record.duration as number | null) ?? 5,
      viewCount: (record._count?.views as number) ?? 0,
      expiresAt: expiresAt.toISOString(),
      isExpired: expiresAt < now,
      createdAt:
        record.createdAt instanceof Date
          ? record.createdAt.toISOString()
          : String(record.createdAt),
    };
  }

  /**
   * Maps a raw Prisma StoryView record (with viewer include) to the shared
   * {@link StoryView} DTO.
   *
   * @param record - Raw Prisma StoryView record with viewer include
   * @returns Domain-typed {@link StoryView}
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapToStoryView(record: any): StoryView {
    return {
      id: record.id as string,
      storyId: record.storyId as string,
      viewerId: record.viewerId as string,
      viewerName: (record.viewer?.displayName as string) ?? '',
      viewerAvatar: (record.viewer?.avatarUrl as string | null) ?? undefined,
      viewedAt:
        record.viewedAt instanceof Date
          ? record.viewedAt.toISOString()
          : String(record.viewedAt),
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────

  /**
   * Checks whether an error is a Prisma unique constraint violation (P2002).
   *
   * Used by `addView()` to handle the race condition where a concurrent
   * request creates the same view between our existence check and create.
   *
   * @param error - Error to inspect
   * @returns true if the error is a P2002 unique constraint violation
   */
  private static isUniqueConstraintError(error: unknown): boolean {
    return (
      error !== null &&
      error !== undefined &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: string }).code === 'P2002'
    );
  }
}
