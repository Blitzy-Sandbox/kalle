/**
 * @module @kalle/shared/types/story
 * @description Story/Status domain types and DTOs for the Kalle WhatsApp clone.
 *
 * Stories are temporary content (text, image, video) with 24-hour expiration,
 * view tracking, and automated cleanup via hourly BullMQ job.
 *
 * IMPORTANT: Stories are NOT encrypted (unlike messages) per AAP R12.
 * Media URLs are plain URLs — no ciphertext involved.
 *
 * Key AAP Rules:
 * - R11: Stories hidden after 24h; expired media deleted by hourly cleanup job
 * - R12: Stories are explicitly NOT encrypted
 * - R35: Stories/media purged after 24h
 *
 * @see AAP Section 0.1.1 — Stories/Status Feature
 * @see AAP Section 0.4.5 — Story model relationships
 * @see Figma Screen 8 — Status feed view
 * @see Figma Screen 10 — Text status composer (colored background)
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * StoryType — Discriminator for the type of story content.
 *
 * - TEXT: Plain-text story displayed on a colored background (Figma Screen 10)
 * - IMAGE: Image story with an optional thumbnail
 * - VIDEO: Video story with an optional thumbnail and duration
 */
export enum StoryType {
  /** Plain-text story rendered on a colored background */
  TEXT = 'TEXT',

  /** Image-based story with media attachment */
  IMAGE = 'IMAGE',

  /** Video-based story with media attachment and playback duration */
  VIDEO = 'VIDEO',
}

// ---------------------------------------------------------------------------
// DTOs (Data Transfer Objects)
// ---------------------------------------------------------------------------

/**
 * CreateStoryDTO — Payload for creating a new story via POST /api/v1/stories.
 *
 * For TEXT stories, `content` and `backgroundColor` are typically provided.
 * For IMAGE/VIDEO stories, `mediaId` references a previously-uploaded media asset.
 * Stories are NOT encrypted; `mediaId` links to an unencrypted media resource.
 *
 * @see Figma Screen 10 — Status composer with colored background
 */
export interface CreateStoryDTO {
  /** Type of story content: TEXT, IMAGE, or VIDEO */
  type: StoryType;

  /**
   * Text content for TEXT stories. Rendered as large centered text
   * on the colored background (Figma Screen 10).
   * Optional for IMAGE/VIDEO stories (used as caption).
   */
  content?: string;

  /**
   * Media attachment ID for IMAGE/VIDEO stories.
   * References a media record uploaded via POST /api/v1/media.
   * Not applicable for TEXT stories.
   */
  mediaId?: string;

  /**
   * Hex color code for TEXT story background.
   * Corresponds to the colored background in Figma Screen 10
   * (e.g., coral/salmon pink "#FF6B6B").
   */
  backgroundColor?: string;

  /**
   * Optional font style identifier for TEXT stories.
   * Controls the font rendering on the colored background.
   */
  fontStyle?: string;

  /**
   * Display duration in seconds.
   * Default: 5 seconds for images, video duration for video stories.
   * Determines how long the story is shown in the full-screen viewer.
   */
  duration?: number;
}

// ---------------------------------------------------------------------------
// Response Types
// ---------------------------------------------------------------------------

/**
 * StoryResponse — Full story representation returned from the API.
 *
 * Contains all metadata required to render a story in the viewer,
 * including author info, expiration state, and view count.
 *
 * Key invariants:
 * - `expiresAt` is always 24 hours after creation (R11, R35)
 * - `isExpired` is a server-derived boolean: `expiresAt < now`
 * - `mediaUrl` is a plain URL (stories are NOT encrypted per R12)
 * - `viewCount` is the total unique views
 *
 * @see Figma Screen 8 — Status feed (shows story avatars)
 * @see Figma Screen 10 — Status viewer (shows full story)
 */
export interface StoryResponse {
  /** Unique story identifier (UUID) */
  id: string;

  /** User ID of the story author */
  authorId: string;

  /** Display name of the story author */
  authorName: string;

  /** Avatar URL of the story author (optional if no avatar set) */
  authorAvatar?: string;

  /** Type of story content */
  type: StoryType;

  /**
   * Text content for TEXT stories.
   * For IMAGE/VIDEO stories, may contain a caption.
   */
  content?: string;

  /**
   * Media URL for IMAGE/VIDEO stories.
   * This is a plain URL — stories are NOT encrypted (R12).
   */
  mediaUrl?: string;

  /** Thumbnail URL for IMAGE/VIDEO stories (smaller preview image) */
  thumbnailUrl?: string;

  /** Background color hex for TEXT stories (Figma Screen 10) */
  backgroundColor?: string;

  /** Font style identifier for TEXT stories */
  fontStyle?: string;

  /** Display duration in seconds for the story viewer */
  duration: number;

  /** Total number of unique views on this story */
  viewCount: number;

  /**
   * ISO 8601 timestamp when this story expires.
   * Set to exactly 24 hours after creation (R11, R35).
   * After this time, the story is hidden from feeds and
   * eligible for cleanup by the hourly BullMQ job.
   */
  expiresAt: string;

  /**
   * Server-derived expiration flag.
   * `true` when `expiresAt` is in the past.
   * Expired stories should not be displayed in the feed.
   */
  isExpired: boolean;

  /** ISO 8601 timestamp when the story was created */
  createdAt: string;
}

/**
 * StoryFeedItem — Grouped stories per user for the status feed.
 *
 * The status feed (Figma Screen 8) groups all active stories by user,
 * showing a single avatar per user with a ring indicator for unviewed stories.
 * Stories within each group are sorted chronologically.
 *
 * @see Figma Screen 8 — Status feed with "My Status" at top
 */
export interface StoryFeedItem {
  /** User ID of the story author */
  userId: string;

  /** Display name of the story author */
  userName: string;

  /** Avatar URL of the story author (optional if no avatar set) */
  userAvatar?: string;

  /**
   * All active (non-expired) stories from this user,
   * sorted chronologically (oldest first for sequential viewing).
   */
  stories: StoryResponse[];

  /**
   * Indicates whether the current viewing user has not yet seen
   * all stories in this group. Used to render the unviewed ring
   * indicator around the avatar in the feed.
   */
  hasUnviewed: boolean;

  /**
   * ISO 8601 timestamp of the most recent story in this group.
   * Used for sorting feed items (most recently updated first).
   */
  latestStoryAt: string;
}

/**
 * StoryView — Individual story view record.
 *
 * Tracks a single user's viewing of a specific story.
 * The author can see a list of viewers with timestamps.
 * Each view is unique per (storyId, viewerId) pair — duplicate
 * views do not create additional records.
 *
 * @see POST /api/v1/stories/:storyId/view
 */
export interface StoryView {
  /** Unique view record identifier (UUID) */
  id: string;

  /** ID of the story that was viewed */
  storyId: string;

  /** User ID of the viewer */
  viewerId: string;

  /** Display name of the viewer */
  viewerName: string;

  /** Avatar URL of the viewer (optional if no avatar set) */
  viewerAvatar?: string;

  /** ISO 8601 timestamp when the story was viewed */
  viewedAt: string;
}

/**
 * MyStatusInfo — Current user's own status summary.
 *
 * Displayed in the "My Status" row at the top of the status feed
 * (Figma Screen 8), showing the user's avatar with a "+" overlay
 * if no active status exists, or a ring indicator if they have stories.
 *
 * @see Figma Screen 8 — "My Status" row with avatar and "Add to my status"
 */
export interface MyStatusInfo {
  /**
   * Whether the current user has at least one active (non-expired) story.
   * When `false`, the UI shows "Add to my status" prompt.
   * When `true`, the UI shows the story ring and view count.
   */
  hasStatus: boolean;

  /**
   * The current user's active (non-expired) stories,
   * sorted chronologically (oldest first).
   */
  stories: StoryResponse[];

  /**
   * ISO 8601 timestamp of the most recently created story.
   * Used to display relative time ("2h ago") in the feed.
   * Undefined when `hasStatus` is `false`.
   */
  lastUpdated?: string;
}
