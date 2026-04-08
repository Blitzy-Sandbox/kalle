/**
 * @module @kalle/shared/types/message
 *
 * Message domain types and DTOs for the Kalle WhatsApp clone.
 *
 * Messages are the core domain entity — they support text, image, video,
 * document, and voice note content. All message content is stored as
 * ciphertext (R12: E2E encryption). The server MUST NOT have access to
 * plaintext message content at any point.
 *
 * Key design decisions:
 * - All message content is stored/transmitted as ciphertext only (R12)
 * - Messages support editing within a 15-minute sender-only window (R19)
 * - Deleted messages become tombstones — ciphertext nulled, row retained (R20)
 * - Client-generated `clientMessageId` enables idempotency and deduplication (R4)
 * - Server-assigned `serverTimestamp` provides total ordering for messages (R4)
 * - Message search operates exclusively client-side against IndexedDB (R21)
 * - All date/time fields use ISO 8601 string format for cross-platform compatibility
 * - Link previews are populated asynchronously via BullMQ after message send
 *
 * This file contains ZERO runtime code beyond enum declarations.
 * It has ZERO imports from other type files to prevent circular dependencies.
 */

// =============================================================================
// Enums
// =============================================================================

/**
 * MessageType — classifies the content type of a message.
 *
 * Determines how the message is rendered in the UI and which media
 * processing pipeline is invoked. Voice notes include waveform data;
 * images include thumbnail metadata; documents show file icon and size.
 *
 * String-valued enum ensures safe JSON serialization between frontend and backend.
 */
export enum MessageType {
  /** Plain text message content (encrypted as ciphertext) */
  TEXT = 'TEXT',

  /** Image attachment — supports JPEG, PNG, GIF, WebP */
  IMAGE = 'IMAGE',

  /** Video attachment — supports MP4, WebM, QuickTime */
  VIDEO = 'VIDEO',

  /** Document attachment — supports PDF, DOC, DOCX, XLS, XLSX, TXT, CSV */
  DOCUMENT = 'DOCUMENT',

  /** Voice note recording with waveform visualization and playback controls */
  VOICE_NOTE = 'VOICE_NOTE',
}

/**
 * MessageStatusEnum — tracks the delivery and read state of a message.
 *
 * Progresses linearly: SENT → DELIVERED → READ. In group conversations,
 * the aggregate status represents the highest state among all recipients
 * (e.g., READ if at least one recipient has read; DELIVERED if at least
 * one confirmed delivery but none have read yet).
 *
 * UI rendering:
 * - SENT: single gray checkmark
 * - DELIVERED: double gray checkmarks
 * - READ: double blue checkmarks (#007AFF)
 *
 * String-valued enum ensures safe JSON serialization between frontend and backend.
 */
export enum MessageStatusEnum {
  /** Server has received and stored the ciphertext */
  SENT = 'SENT',

  /** At least one recipient client has confirmed message delivery */
  DELIVERED = 'DELIVERED',

  /** At least one recipient has opened and viewed the message */
  READ = 'READ',
}

// =============================================================================
// DTOs (Data Transfer Objects) — Inbound payloads
// =============================================================================

/**
 * SendMessageDTO — payload for sending a new encrypted message.
 *
 * Submitted by the client after encrypting the message content using the
 * Signal Protocol. The server stores only the ciphertext and never
 * performs any decryption (R12).
 *
 * The `clientMessageId` is a client-generated UUID used for:
 * - Idempotency: prevents duplicate message creation on retry
 * - Optimistic UI: client renders the message immediately using this ID
 * - Deduplication: server rejects messages with duplicate clientMessageId (R4)
 */
export interface SendMessageDTO {
  /** Target conversation ID (UUID) */
  conversationId: string;

  /** Encrypted message content — Base64-encoded Signal Protocol ciphertext (R12) */
  ciphertext: string;

  /** Type of message content — determines rendering and media handling */
  type: MessageType;

  /** Optional: ID of the message being replied to (for inline reply/quote) */
  replyToMessageId?: string;

  /** Optional: ID of an already-uploaded encrypted media attachment */
  mediaId?: string;

  /** Client-generated UUID v4 for idempotency and deduplication (R4) */
  clientMessageId: string;
}

/**
 * EditMessageDTO — payload for editing an existing message (R19).
 *
 * Editing replaces the stored ciphertext with new encrypted content.
 * The original ciphertext is NOT retained — it is overwritten server-side.
 *
 * Constraints enforced by the backend:
 * - Only the message sender can edit (403 for non-sender)
 * - Must be within 15-minute window from original serverTimestamp (400 if expired)
 * - Deleted messages cannot be edited (400 if tombstone)
 */
export interface EditMessageDTO {
  /** New encrypted message content replacing the original ciphertext */
  ciphertext: string;
}

// =============================================================================
// Supporting Types — Referenced by response interfaces
// =============================================================================

/**
 * ReplyToMessage — minimal information about the message being replied to.
 *
 * Embedded in MessageResponse.replyTo to render the inline quoted message
 * preview in the chat UI. Contains just enough data to display the quote
 * without requiring a separate API call.
 *
 * If the original message was deleted (tombstone, R20), ciphertext is null
 * and the UI renders "This message was deleted" in the quote preview.
 */
export interface ReplyToMessage {
  /** ID of the original message being replied to */
  id: string;

  /** User ID of the original message sender */
  senderId: string;

  /** Display name of the original message sender */
  senderName: string;

  /** Encrypted content of the original message; null if deleted (R20 tombstone) */
  ciphertext: string | null;

  /** Content type of the original message */
  type: MessageType;
}

/**
 * LinkPreviewData — Open Graph metadata extracted from URLs in messages.
 *
 * Populated asynchronously by the link-preview BullMQ job after message send.
 * The server extracts OG metadata from the first URL detected in the
 * (server-side detected) message payload metadata, then emits a `link:preview`
 * WebSocket event to update the message in real-time.
 *
 * All fields except `url` are optional because OG metadata may be partially
 * available or completely absent for a given URL.
 */
export interface LinkPreviewData {
  /** The URL that was scraped for OG metadata */
  url: string;

  /** OG title tag content */
  title?: string;

  /** OG description tag content */
  description?: string;

  /** OG image URL for the preview thumbnail */
  imageUrl?: string;

  /** OG site_name tag content (e.g., "GitHub", "YouTube") */
  siteName?: string;
}

// =============================================================================
// Response Types — Outbound API responses
// =============================================================================

/**
 * MessageResponse — full message representation returned from the API.
 *
 * This is the canonical message shape used throughout the application:
 * - Returned by GET /api/v1/conversations/:id/messages (paginated history)
 * - Returned by POST /api/v1/conversations/:id/messages (send)
 * - Returned by PATCH /api/v1/messages/:id (edit)
 * - Embedded in WebSocket `message:new` events
 * - Used in offline sync response payloads
 *
 * Key invariants:
 * - `ciphertext` is null when `isDeleted` is true (tombstone, R20)
 * - `isEdited` is true and `editedAt` is set after a successful edit (R19)
 * - `serverTimestamp` is the authoritative ordering timestamp (R4)
 * - `clientMessageId` matches the sender's original idempotency key
 */
export interface MessageResponse {
  /** Unique message identifier (UUID) */
  id: string;

  /** ID of the conversation this message belongs to */
  conversationId: string;

  /** ID of the user who sent this message */
  senderId: string;

  /** Display name of the sender for UI rendering */
  senderName: string;

  /** Avatar URL of the sender for UI rendering; undefined if no avatar set */
  senderAvatar?: string;

  /**
   * Encrypted message content (Base64-encoded ciphertext).
   * Null when the message has been deleted — renders as tombstone (R20).
   */
  ciphertext: string | null;

  /** Content type of this message */
  type: MessageType;

  /**
   * Aggregate delivery/read status across all recipients.
   * In group conversations, represents the highest status among all participants.
   */
  status: MessageStatusEnum;

  /** Inline reply reference — present when this message is a reply to another */
  replyTo?: ReplyToMessage;

  /** ID of the attached encrypted media asset; undefined for text-only messages */
  mediaId?: string;

  /** Extracted OG metadata for URL messages; populated async via BullMQ job */
  linkPreview?: LinkPreviewData;

  /** True if the message has been edited (R19); false for unedited messages */
  isEdited: boolean;

  /** True if the message has been soft-deleted as a tombstone (R20) */
  isDeleted: boolean;

  /** ISO 8601 timestamp of the most recent edit; undefined if never edited */
  editedAt?: string;

  /** ISO 8601 timestamp when the message was deleted; undefined if not deleted */
  deletedAt?: string;

  /** Client-generated UUID for idempotency and deduplication (R4) */
  clientMessageId: string;

  /** ISO 8601 server-assigned timestamp — authoritative ordering for messages (R4) */
  serverTimestamp: string;

  /** ISO 8601 record creation timestamp */
  createdAt: string;

  /** ISO 8601 record last-modification timestamp */
  updatedAt: string;
}

/**
 * DeleteMessageResponse — response payload after soft-deleting a message (R20).
 *
 * Returns the tombstone state of the deleted message. The ciphertext has been
 * nulled server-side and all participants receive a `message:deleted` WebSocket
 * event to update their local state.
 *
 * Only the message sender can delete their own messages. Deleted messages
 * render as "This message was deleted" in the chat UI for all participants.
 */
export interface DeleteMessageResponse {
  /** ID of the deleted message */
  id: string;

  /** ID of the conversation containing the deleted message */
  conversationId: string;

  /** Always true — confirms deletion was applied */
  isDeleted: boolean;

  /** ISO 8601 timestamp when the deletion occurred */
  deletedAt: string;
}

/**
 * MessageStatusUpdate — per-user delivery/read status change notification.
 *
 * Emitted via the `message:status` WebSocket event when a recipient confirms
 * delivery or marks a message as read. The sender's UI updates the checkmark
 * indicators in real-time:
 * - SENT → single gray check
 * - DELIVERED → double gray checks
 * - READ → double blue checks (#007AFF)
 */
export interface MessageStatusUpdate {
  /** ID of the message whose status changed */
  messageId: string;

  /** ID of the user whose status changed (the recipient) */
  userId: string;

  /** New delivery/read status for this user */
  status: MessageStatusEnum;

  /** ISO 8601 timestamp when the status was updated */
  updatedAt: string;
}

// =============================================================================
// Query Types — Inbound query parameters
// =============================================================================

/**
 * GetMessagesQuery — query parameters for fetching paginated message history.
 *
 * Supports cursor-based pagination using `serverTimestamp` as the cursor value.
 * Messages are returned in reverse chronological order (newest first) to support
 * the chat UI's bottom-anchored scroll behavior.
 *
 * The `before` parameter allows fetching messages before a specific timestamp,
 * useful for "load older messages" functionality in the chat view.
 */
export interface GetMessagesQuery {
  /** Conversation ID to fetch messages for */
  conversationId: string;

  /** Cursor for pagination — serverTimestamp of the last fetched message */
  cursor?: string;

  /** Maximum number of messages to return per page (default: 50) */
  limit?: number;

  /** ISO 8601 timestamp — fetch only messages created before this time */
  before?: string;
}
