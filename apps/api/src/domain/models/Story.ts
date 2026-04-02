/**
 * @module apps/api/src/domain/models/Story
 *
 * Story domain model implementing business logic for the Stories/Status feature
 * with encapsulated behavior. Handles 24-hour expiration, unique view tracking,
 * cleanup eligibility, type validation, and duration defaults.
 *
 * IMPORTANT: Stories are NOT encrypted (unlike messages) per AAP R12.
 * Media URLs are plain URLs — no ciphertext involved.
 *
 * Architecture rules enforced:
 * - R16 (OOD Layering): Business logic encapsulated in methods, not anemic data bags
 * - R17 (Interface-Driven): Zero Prisma imports — ORM-agnostic pure TypeScript
 * - R11 (Story Expiration): Stories hidden after 24h; expired media deleted by hourly job
 * - R35 (Data Retention): Stories/media purged after 24 hours
 * - R12 (E2E Encryption): Stories are explicitly NOT encrypted
 * - R7 (Zero Warnings): TypeScript strict mode compatible with zero warnings
 * - R28 (Structured Logging): Zero direct stdout/stderr logging calls
 */

import { randomUUID } from 'node:crypto';

import { StoryType } from '@kalle/shared/types/story';
import type { StoryResponse } from '@kalle/shared/types/story';
import { TTL } from '@kalle/shared/constants/index';

// =============================================================================
// Constants
// =============================================================================

/** Default display duration in seconds for TEXT stories */
const DEFAULT_TEXT_DURATION_SECONDS = 5;

/** Default display duration in seconds for IMAGE stories */
const DEFAULT_IMAGE_DURATION_SECONDS = 5;

/** Default display duration in seconds for VIDEO stories when none provided */
const DEFAULT_VIDEO_DURATION_SECONDS = 10;

/** Default background color for TEXT stories (coral pink — Figma Screen 10) */
const DEFAULT_TEXT_BACKGROUND_COLOR = '#FF6B6B';

/** Set of valid StoryType enum values for validation */
const VALID_STORY_TYPES: ReadonlySet<string> = new Set([
  StoryType.TEXT,
  StoryType.IMAGE,
  StoryType.VIDEO,
]);

// =============================================================================
// Interfaces
// =============================================================================

/**
 * StoryViewRecord — tracks a single unique view of a story by a user.
 *
 * Each view is unique per (storyId, userId) pair — duplicate views are rejected
 * by the addView() method. The author of the story can view their own story
 * (for tracking), but duplicate views from any user are not counted.
 */
export interface StoryViewRecord {
  /** User ID of the viewer */
  userId: string;

  /** Timestamp when the story was viewed */
  viewedAt: Date;
}

/**
 * StoryProps — constructor input shape for creating a Story domain model instance.
 *
 * This interface is used when reconstituting a Story from persistence (repository
 * layer) and when constructing new Story instances via the static create() factory.
 *
 * Stories are NOT encrypted (R12). The content and mediaUrl fields contain
 * plaintext data — no ciphertext involved.
 */
export interface StoryProps {
  /** Unique story identifier (UUID v4) */
  id: string;

  /** User ID of the story author */
  authorId: string;

  /** Display name of the story author */
  authorName: string;

  /** Avatar URL of the story author (optional if no avatar set) */
  authorAvatar?: string;

  /** Type of story content: TEXT, IMAGE, or VIDEO */
  type: StoryType;

  /**
   * Text content for TEXT stories. Rendered as large centered text
   * on the colored background (Figma Screen 10).
   * Optional for IMAGE/VIDEO stories (used as caption).
   */
  content?: string;

  /**
   * Media URL for IMAGE/VIDEO stories.
   * This is a plain URL — stories are NOT encrypted (R12).
   */
  mediaUrl?: string;

  /** Thumbnail URL for IMAGE/VIDEO stories (smaller preview image) */
  thumbnailUrl?: string;

  /**
   * Background color hex for TEXT story background.
   * Corresponds to the colored background in Figma Screen 10
   * (e.g., coral/salmon pink "#FF6B6B").
   */
  backgroundColor?: string;

  /** Optional font style identifier for TEXT stories */
  fontStyle?: string;

  /** Display duration in seconds for the story viewer */
  duration: number;

  /** Array of unique view records tracking who viewed this story */
  views: StoryViewRecord[];

  /**
   * ISO 8601 date when this story expires.
   * Set to exactly 24 hours after creation (R11, R35).
   * After this time, the story is hidden from feeds and
   * eligible for cleanup by the hourly BullMQ job.
   */
  expiresAt: Date;

  /** Timestamp of story creation */
  createdAt: Date;

  /** Timestamp of last modification */
  updatedAt: Date;
}

// =============================================================================
// Create DTO
// =============================================================================

/**
 * Input shape accepted by the static Story.create() factory method.
 *
 * Not all fields are required — sensible defaults are applied based on
 * the story type. Duration defaults: 5s for TEXT, 5s for IMAGE,
 * actual duration for VIDEO.
 */
interface CreateStoryInput {
  /** Optional external ID; if omitted, a UUID v4 is generated */
  id?: string;

  /** User ID of the story author (required) */
  authorId: string;

  /** Display name of the story author (required) */
  authorName: string;

  /** Avatar URL of the story author (optional) */
  authorAvatar?: string;

  /** Type of story content: TEXT, IMAGE, or VIDEO (required) */
  type: StoryType;

  /** Text content for TEXT stories, or caption for IMAGE/VIDEO stories */
  content?: string;

  /** Media URL for IMAGE/VIDEO stories (plain URL, NOT encrypted per R12) */
  mediaUrl?: string;

  /** Thumbnail URL for IMAGE/VIDEO stories */
  thumbnailUrl?: string;

  /** Background color hex for TEXT story background (defaults to '#FF6B6B') */
  backgroundColor?: string;

  /** Font style identifier for TEXT stories */
  fontStyle?: string;

  /** Display duration in seconds (defaults vary by type) */
  duration?: number;
}

// =============================================================================
// Domain Model
// =============================================================================

/**
 * Story domain model — encapsulates Stories/Status feature business logic.
 *
 * Responsibilities:
 * - 24-hour expiration enforcement via TTL.STORY_EXPIRATION_MS (R11, R35)
 * - Unique view tracking with duplicate prevention
 * - Cleanup eligibility determination for the hourly BullMQ job
 * - Type validation (TEXT requires content, IMAGE/VIDEO requires mediaUrl)
 * - Duration defaults based on story type
 * - Serialization to StoryResponse for API responses
 *
 * Stories are NOT encrypted (R12). All content and media URLs are plaintext.
 *
 * No I/O — no database calls, no HTTP, no filesystem operations.
 * Zero Prisma imports (R17). Zero console logging calls (R28).
 */
export class Story {
  // ---------------------------------------------------------------------------
  // Private Fields
  // ---------------------------------------------------------------------------

  private readonly _id: string;
  private readonly _authorId: string;
  private readonly _authorName: string;
  private readonly _authorAvatar: string | undefined;
  private readonly _type: StoryType;
  private readonly _content: string | undefined;
  private readonly _mediaUrl: string | undefined;
  private readonly _thumbnailUrl: string | undefined;
  private readonly _backgroundColor: string | undefined;
  private readonly _fontStyle: string | undefined;
  private readonly _duration: number;
  private _views: StoryViewRecord[];
  private readonly _expiresAt: Date;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * Constructs a Story instance from fully-resolved props.
   *
   * For creating NEW stories, prefer the static `Story.create()` factory
   * which applies validation and defaults. The constructor is used when
   * reconstituting a Story from persistence (e.g., from repository layer).
   *
   * @param props - Complete story properties including all required fields
   */
  constructor(props: StoryProps) {
    this._id = props.id;
    this._authorId = props.authorId;
    this._authorName = props.authorName;
    this._authorAvatar = props.authorAvatar;
    this._type = props.type;
    this._content = props.content;
    this._mediaUrl = props.mediaUrl;
    this._thumbnailUrl = props.thumbnailUrl;
    this._backgroundColor = props.backgroundColor;
    this._fontStyle = props.fontStyle;
    this._duration = props.duration;
    this._views = [...props.views]; // Defensive copy on construction
    this._expiresAt = props.expiresAt;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  // ---------------------------------------------------------------------------
  // Getters (Public Accessors)
  // ---------------------------------------------------------------------------

  /** Unique story identifier (UUID v4) */
  get id(): string {
    return this._id;
  }

  /** User ID of the story author */
  get authorId(): string {
    return this._authorId;
  }

  /** Display name of the story author */
  get authorName(): string {
    return this._authorName;
  }

  /** Avatar URL of the story author */
  get authorAvatar(): string | undefined {
    return this._authorAvatar;
  }

  /** Type of story content: TEXT, IMAGE, or VIDEO */
  get type(): StoryType {
    return this._type;
  }

  /** Text content for TEXT stories, or caption for IMAGE/VIDEO */
  get content(): string | undefined {
    return this._content;
  }

  /** Media URL for IMAGE/VIDEO stories (plain URL, NOT encrypted per R12) */
  get mediaUrl(): string | undefined {
    return this._mediaUrl;
  }

  /** Thumbnail URL for IMAGE/VIDEO stories */
  get thumbnailUrl(): string | undefined {
    return this._thumbnailUrl;
  }

  /** Background color hex for TEXT story background */
  get backgroundColor(): string | undefined {
    return this._backgroundColor;
  }

  /** Font style identifier for TEXT stories */
  get fontStyle(): string | undefined {
    return this._fontStyle;
  }

  /** Display duration in seconds */
  get duration(): number {
    return this._duration;
  }

  /** Array of unique view records (returns the internal mutable array) */
  get views(): StoryViewRecord[] {
    return this._views;
  }

  /** Date when this story expires (24h after creation per R11) */
  get expiresAt(): Date {
    return this._expiresAt;
  }

  /** Timestamp of story creation */
  get createdAt(): Date {
    return this._createdAt;
  }

  /** Timestamp of last modification */
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---------------------------------------------------------------------------
  // Static Factory Method
  // ---------------------------------------------------------------------------

  /**
   * Creates a new Story instance with validation and sensible defaults.
   *
   * Validates:
   * - Type is a valid StoryType enum value (TEXT, IMAGE, VIDEO)
   * - TEXT stories must have non-empty content; backgroundColor defaults to '#FF6B6B'
   * - IMAGE/VIDEO stories must have non-empty mediaUrl
   * - authorId and authorName are non-empty
   *
   * Defaults:
   * - Duration: 5s for TEXT, 5s for IMAGE, 10s for VIDEO (overridable)
   * - expiresAt: Date.now() + TTL.STORY_EXPIRATION_MS (24 hours from creation)
   * - views: empty array
   * - id: UUID v4 if not provided
   *
   * @param dto - Story creation parameters
   * @returns A fully validated Story instance
   * @throws Error if validation fails (invalid type, missing content/media, etc.)
   */
  static create(dto: CreateStoryInput): Story {
    // ---- Author Validation ----
    if (!dto.authorId || dto.authorId.trim().length === 0) {
      throw new Error('Story authorId is required and cannot be empty');
    }

    if (!dto.authorName || dto.authorName.trim().length === 0) {
      throw new Error('Story authorName is required and cannot be empty');
    }

    // ---- Type Validation ----
    if (!VALID_STORY_TYPES.has(dto.type)) {
      throw new Error(
        `Invalid story type '${String(dto.type)}'. Must be one of: ${Array.from(VALID_STORY_TYPES).join(', ')}`
      );
    }

    // ---- Type-Specific Validation and Defaults ----
    let resolvedDuration: number;
    let resolvedBackgroundColor: string | undefined;

    switch (dto.type) {
      case StoryType.TEXT: {
        if (!dto.content || dto.content.trim().length === 0) {
          throw new Error(
            'TEXT stories require non-empty content'
          );
        }
        resolvedDuration = dto.duration ?? DEFAULT_TEXT_DURATION_SECONDS;
        resolvedBackgroundColor =
          dto.backgroundColor ?? DEFAULT_TEXT_BACKGROUND_COLOR;
        break;
      }

      case StoryType.IMAGE: {
        if (!dto.mediaUrl || dto.mediaUrl.trim().length === 0) {
          throw new Error(
            'IMAGE stories require a non-empty mediaUrl'
          );
        }
        resolvedDuration = dto.duration ?? DEFAULT_IMAGE_DURATION_SECONDS;
        resolvedBackgroundColor = dto.backgroundColor;
        break;
      }

      case StoryType.VIDEO: {
        if (!dto.mediaUrl || dto.mediaUrl.trim().length === 0) {
          throw new Error(
            'VIDEO stories require a non-empty mediaUrl'
          );
        }
        resolvedDuration = dto.duration ?? DEFAULT_VIDEO_DURATION_SECONDS;
        resolvedBackgroundColor = dto.backgroundColor;
        break;
      }

      default: {
        // Exhaustive check — unreachable when VALID_STORY_TYPES guard passes
        const _exhaustive: never = dto.type;
        throw new Error(`Unhandled story type: ${String(_exhaustive)}`);
      }
    }

    // ---- Duration Validation ----
    if (resolvedDuration <= 0) {
      throw new Error(
        `Story duration must be a positive number, received: ${resolvedDuration}`
      );
    }

    // ---- Construct Instance ----
    const now = new Date();

    return new Story({
      id: dto.id ?? randomUUID(),
      authorId: dto.authorId.trim(),
      authorName: dto.authorName.trim(),
      authorAvatar: dto.authorAvatar,
      type: dto.type,
      content: dto.content,
      mediaUrl: dto.mediaUrl,
      thumbnailUrl: dto.thumbnailUrl,
      backgroundColor: resolvedBackgroundColor,
      fontStyle: dto.fontStyle,
      duration: resolvedDuration,
      views: [],
      expiresAt: new Date(now.getTime() + TTL.STORY_EXPIRATION_MS),
      createdAt: now,
      updatedAt: now,
    });
  }

  // ---------------------------------------------------------------------------
  // Expiration Logic (R11, R35)
  // ---------------------------------------------------------------------------

  /**
   * Checks whether this story has expired based on the 24-hour lifecycle.
   *
   * A story is considered expired when the current time is at or past the
   * expiresAt timestamp. The boundary is inclusive (>= not >), meaning
   * a story whose expiresAt is exactly the current time IS expired.
   *
   * @param now - Optional timestamp for testability; defaults to Date.now()
   * @returns true if the story has expired, false otherwise
   */
  isExpired(now?: Date): boolean {
    const currentTime = (now ?? new Date()).getTime();
    return currentTime >= this._expiresAt.getTime();
  }

  /**
   * Returns the remaining time in milliseconds until this story expires.
   *
   * If the story is already expired, returns 0 (never returns negative).
   * Useful for UI countdown display and scheduling cleanup.
   *
   * @param now - Optional timestamp for testability; defaults to Date.now()
   * @returns Remaining milliseconds until expiration, or 0 if expired
   */
  getTimeRemaining(now?: Date): number {
    const currentTime = (now ?? new Date()).getTime();
    const remaining = this._expiresAt.getTime() - currentTime;
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Determines whether this story's media should be cleaned up.
   *
   * Returns true only for expired stories that have a mediaUrl (IMAGE/VIDEO).
   * Text-only stories (no mediaUrl) don't need media cleanup, though their
   * database records may still need purging.
   *
   * Used by the hourly story-cleanup BullMQ job (R11, R35).
   *
   * @param now - Optional timestamp for testability; defaults to Date.now()
   * @returns true if the story is expired AND has media to clean up
   */
  shouldCleanup(now?: Date): boolean {
    return (
      this.isExpired(now) &&
      this._mediaUrl !== undefined &&
      this._mediaUrl !== null &&
      this._mediaUrl.length > 0
    );
  }

  // ---------------------------------------------------------------------------
  // View Tracking
  // ---------------------------------------------------------------------------

  /**
   * Records a new view of this story by a specific user.
   *
   * View rules:
   * - Expired stories cannot be viewed (returns false)
   * - Each user can only view a story once (duplicate prevention)
   * - Authors CAN view their own story (for tracking), but duplicates
   *   are still prevented
   *
   * @param userId - User ID of the viewer
   * @param now - Optional timestamp for testability; defaults to Date.now()
   * @returns true if the view was recorded, false if rejected (expired/duplicate)
   */
  addView(userId: string, now?: Date): boolean {
    // Expired stories cannot be viewed
    if (this.isExpired(now)) {
      return false;
    }

    // Prevent duplicate views from the same user (idempotent)
    if (this._views.some((view) => view.userId === userId)) {
      return false;
    }

    // Record the new view
    this._views.push({
      userId,
      viewedAt: now ?? new Date(),
    });

    this._updatedAt = now ?? new Date();
    return true;
  }

  /**
   * Returns the total number of unique views on this story.
   *
   * @returns Count of unique viewers
   */
  getViewCount(): number {
    return this._views.length;
  }

  /**
   * Returns a defensive copy of the views array to prevent external mutation.
   *
   * The returned array contains copies of the view records. Modifications to
   * the returned array do not affect the Story's internal state.
   *
   * @returns A shallow copy of the views array
   */
  getViews(): StoryViewRecord[] {
    return [...this._views];
  }

  /**
   * Checks whether a specific user has already viewed this story.
   *
   * Used to determine the hasUnviewed flag in the story feed UI
   * (Figma Screen 8 — ring indicator for unviewed stories).
   *
   * @param userId - User ID to check
   * @returns true if the user has viewed this story
   */
  hasBeenViewedBy(userId: string): boolean {
    return this._views.some((view) => view.userId === userId);
  }

  // ---------------------------------------------------------------------------
  // Type Guards
  // ---------------------------------------------------------------------------

  /**
   * Checks if this is a TEXT story (displayed on colored background).
   * @see Figma Screen 10 — Status View (colored background text composer)
   */
  isText(): boolean {
    return this._type === StoryType.TEXT;
  }

  /**
   * Checks if this is an IMAGE story (full-screen image with optional caption).
   */
  isImage(): boolean {
    return this._type === StoryType.IMAGE;
  }

  /**
   * Checks if this is a VIDEO story (video with playback duration).
   */
  isVideo(): boolean {
    return this._type === StoryType.VIDEO;
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /**
   * Converts this Story domain model to a plain object matching the
   * StoryResponse interface from @kalle/shared.
   *
   * - Date fields are converted to ISO 8601 strings
   * - isExpired is computed dynamically based on current time
   * - viewCount is derived from getViewCount()
   *
   * @returns A plain object conforming to StoryResponse
   */
  toResponse(): StoryResponse {
    return {
      id: this._id,
      authorId: this._authorId,
      authorName: this._authorName,
      authorAvatar: this._authorAvatar,
      type: this._type,
      content: this._content,
      mediaUrl: this._mediaUrl,
      thumbnailUrl: this._thumbnailUrl,
      backgroundColor: this._backgroundColor,
      fontStyle: this._fontStyle,
      duration: this._duration,
      viewCount: this.getViewCount(),
      expiresAt: this._expiresAt.toISOString(),
      isExpired: this.isExpired(),
      createdAt: this._createdAt.toISOString(),
    };
  }
}
