/**
 * @module IMessageRepository
 *
 * Message repository interface — defines the persistence contract for
 * encrypted messages in the Kalle WhatsApp clone.
 *
 * Architecture context:
 * - Services code against this interface, never the concrete Prisma-backed
 *   implementation (R17: Interface-Driven Dependencies).
 * - The repository stores and returns opaque ciphertext strings — zero
 *   decryption logic exists anywhere in the server codebase (R12: E2E Encryption).
 * - Editing replaces ciphertext server-side without retaining the original (R19).
 * - Deletion produces a tombstone — ciphertext is nulled, row retained (R20).
 * - Cursor-based pagination uses serverTimestamp for total message ordering (R4).
 * - `findAfterTimestamp` supports offline-to-online reconciliation (R13).
 * - This file contains zero business logic — pure contract definition (R16).
 * - TypeScript strict mode compatible; zero warnings (R7).
 * - Zero console.log calls (R28: Structured Logging).
 *
 * Expected database indexes (enforced at schema/migration layer):
 * - conversationId + serverTimestamp (for findByConversation, findAfterTimestamp)
 * - conversationId + senderId (for sender-scoped queries)
 * - clientMessageId (for deduplication via findByClientMessageId)
 */

import type {
  MessageResponse,
  MessageType,
  MessageStatusEnum,
  MessageStatusUpdate,
  LinkPreviewData,
} from '@kalle/shared';

// =============================================================================
// Repository-Level Data Types
// =============================================================================

/**
 * Data required to create a new message record.
 *
 * All fields are validated and assembled by the service layer before being
 * passed to the repository. The repository is responsible only for persisting
 * the data and returning the resulting `MessageResponse`.
 *
 * The `serverTimestamp` is optional — when omitted, the repository implementation
 * must assign the current server time (ensuring total ordering per R4).
 */
export interface CreateMessageData {
  /** Optional pre-generated message ID (UUID). If omitted, the repository generates one. */
  id?: string;

  /** Target conversation ID (UUID) */
  conversationId: string;

  /** User ID of the message sender */
  senderId: string;

  /** Display name of the sender for denormalized UI rendering */
  senderName: string;

  /** Avatar URL of the sender; undefined if no avatar is set */
  senderAvatar?: string;

  /** Encrypted message content — Base64-encoded Signal Protocol ciphertext (R12) */
  ciphertext: string;

  /** Content type classification of the message */
  type: MessageType;

  /** Optional: ID of the message being replied to (for inline quote/reply) */
  replyToMessageId?: string;

  /** Optional: ID of an already-uploaded encrypted media attachment */
  mediaId?: string;

  /** Client-generated UUID v4 for idempotency and deduplication (R4) */
  clientMessageId: string;

  /** Server-assigned timestamp for total ordering; repository assigns current time if omitted (R4) */
  serverTimestamp?: Date;
}

/**
 * Data for updating a message (edit operation — R19).
 *
 * The service layer enforces the 15-minute edit window and sender-only
 * authorization. The repository simply performs the ciphertext swap.
 * The original ciphertext is NOT retained — it is overwritten (R19).
 */
export interface UpdateMessageData {
  /** New ciphertext replacing the original — Base64-encoded Signal Protocol ciphertext */
  ciphertext: string;

  /** Must be set to `true` to mark the message as edited */
  isEdited: boolean;

  /** Timestamp of the edit operation */
  editedAt: Date;
}

/**
 * Data for soft-deleting a message (tombstone — R20).
 *
 * The ciphertext is explicitly set to `null`, the row is retained, and
 * all conversation participants render "This message was deleted."
 * The service layer enforces sender-only authorization.
 */
export interface SoftDeleteMessageData {
  /** Ciphertext is nulled — always `null` for a soft-delete (R20) */
  ciphertext: null;

  /** Must be set to `true` to mark the message as deleted */
  isDeleted: boolean;

  /** Timestamp of the deletion operation */
  deletedAt: Date;
}

/**
 * Options for querying paginated message history within a conversation.
 *
 * Cursor-based pagination uses the `serverTimestamp` of the last message in
 * the previous page as the cursor value. Messages are returned in reverse
 * chronological order (newest first) to support bottom-anchored chat scroll.
 */
export interface MessageQueryOptions {
  /** Conversation ID to fetch messages for */
  conversationId: string;

  /** Cursor for pagination — serverTimestamp ISO string of the last fetched message */
  cursor?: string;

  /** Maximum number of messages to return per page (default: 50) */
  limit?: number;

  /** Fetch only messages created before this timestamp */
  before?: Date;
}

// =============================================================================
// IMessageRepository — Message Repository Interface Contract
// =============================================================================

/**
 * IMessageRepository — persistence contract for encrypted message storage.
 *
 * Concrete implementations (e.g., Prisma-backed `MessageRepository`) must
 * implement all methods. Services depend only on this interface — never on
 * the concrete class (R17).
 *
 * Method categories:
 * - **CRUD**: create, findById, update, softDelete
 * - **Query**: findByConversation, findAfterTimestamp, findByClientMessageId
 * - **Status**: updateStatus, batchUpdateStatus
 * - **Enrichment**: setLinkPreview
 */
export interface IMessageRepository {
  /**
   * Create a new message record with server-assigned timestamp.
   *
   * The repository persists the ciphertext and metadata, assigns a
   * `serverTimestamp` if not provided, and returns the full `MessageResponse`.
   * Relies on the conversationId + serverTimestamp index for efficient ordering.
   *
   * @param data - CreateMessageData containing ciphertext and metadata
   * @returns The created MessageResponse with server-assigned fields
   */
  create(data: CreateMessageData): Promise<MessageResponse>;

  /**
   * Find a message by its unique identifier.
   *
   * Returns the full message representation including status, edit state,
   * and reply-to information. Returns `null` if no message exists with the
   * given ID.
   *
   * @param id - Message UUID
   * @returns MessageResponse or null if not found
   */
  findById(id: string): Promise<MessageResponse | null>;

  /**
   * Update a message — edit operation with ciphertext swap (R19).
   *
   * Replaces the stored ciphertext with the new encrypted content, sets
   * `isEdited` to `true`, and records the `editedAt` timestamp. The original
   * ciphertext is NOT retained — it is permanently overwritten.
   *
   * The 15-minute edit window and sender-only authorization are enforced at
   * the service layer, not here (R16: zero business logic in repository).
   *
   * @param id - Message ID to update
   * @param data - UpdateMessageData with new ciphertext and edit metadata
   * @returns The updated MessageResponse reflecting the edit
   */
  update(id: string, data: UpdateMessageData): Promise<MessageResponse>;

  /**
   * Soft-delete a message — tombstone with ciphertext nulled (R20).
   *
   * Sets the ciphertext to `null`, marks `isDeleted` as `true`, and records
   * the `deletedAt` timestamp. The message row is retained — it is never
   * physically deleted. All conversation participants render
   * "This message was deleted" when encountering this tombstone state.
   *
   * Sender-only authorization is enforced at the service layer.
   *
   * @param id - Message ID to soft-delete
   * @param data - SoftDeleteMessageData with null ciphertext and deletion metadata
   * @returns The updated MessageResponse in tombstone state
   */
  softDelete(id: string, data: SoftDeleteMessageData): Promise<MessageResponse>;

  /**
   * Find messages in a conversation with cursor-based pagination.
   *
   * Returns messages ordered by `serverTimestamp` descending (newest first).
   * Uses the conversationId + serverTimestamp composite index for efficient
   * queries. The cursor is the serverTimestamp of the last message from the
   * previous page.
   *
   * @param options - MessageQueryOptions with conversationId, optional cursor, limit, and before filter
   * @returns Paginated result containing items array, optional cursor for next page, and hasMore flag
   */
  findByConversation(options: MessageQueryOptions): Promise<{
    items: MessageResponse[];
    cursor?: string;
    hasMore: boolean;
  }>;

  /**
   * Find messages after a specific timestamp for offline sync (R13).
   *
   * Returns all messages across the specified conversations that have a
   * `serverTimestamp` later than `afterTimestamp`. Messages are sorted by
   * `serverTimestamp` ascending (oldest first) so the client can replay
   * them in chronological order during reconnection.
   *
   * Used by the `message:sync` WebSocket handler to reconcile missed
   * messages after a client disconnection/reconnection cycle.
   *
   * @param conversationIds - Array of conversation IDs to sync
   * @param afterTimestamp - Only return messages after this server timestamp
   * @param limit - Maximum number of messages to return (optional, for safety)
   * @returns Array of MessageResponse sorted by serverTimestamp ascending
   */
  findAfterTimestamp(
    conversationIds: string[],
    afterTimestamp: Date,
    limit?: number,
  ): Promise<MessageResponse[]>;

  /**
   * Find a message by its client-generated message ID for deduplication.
   *
   * Prevents duplicate message creation when a client retries a send
   * operation (R4: zero duplicates). If a message with the given
   * `clientMessageId` already exists, the existing message is returned
   * instead of creating a new one.
   *
   * @param clientMessageId - Client-generated UUID v4
   * @returns MessageResponse or null if no matching message exists
   */
  findByClientMessageId(clientMessageId: string): Promise<MessageResponse | null>;

  /**
   * Update message delivery/read status for a specific recipient.
   *
   * Tracks the progression of a message through sent → delivered → read
   * for a single recipient. Used to update the per-user MessageStatus
   * record and return the updated status.
   *
   * @param messageId - Message UUID
   * @param userId - Recipient user UUID whose status is being updated
   * @param status - New status value (DELIVERED or READ)
   * @returns The updated MessageStatusUpdate reflecting the new status
   */
  updateStatus(
    messageId: string,
    userId: string,
    status: MessageStatusEnum,
  ): Promise<MessageStatusUpdate>;

  /**
   * Batch update message status (mark multiple messages as delivered/read).
   *
   * Efficiently updates the delivery/read status for a batch of messages
   * in a single operation. Used when a user opens a conversation and reads
   * all unread messages at once — avoids N individual updateStatus calls.
   *
   * @param messageIds - Array of message UUIDs to update
   * @param userId - Recipient user UUID whose status is being updated
   * @param status - New status value (DELIVERED or READ)
   */
  batchUpdateStatus(
    messageIds: string[],
    userId: string,
    status: MessageStatusEnum,
  ): Promise<void>;

  /**
   * Add or update link preview (Open Graph metadata) on a message.
   *
   * Called asynchronously by the link-preview BullMQ job after it extracts
   * OG metadata from URLs detected in the message. The updated message is
   * then emitted via `link:preview` WebSocket event to all conversation
   * participants.
   *
   * @param messageId - Message UUID to enrich with link preview data
   * @param linkPreview - Extracted OG metadata (url, title, description, imageUrl, siteName)
   * @returns The updated MessageResponse with populated linkPreview field
   */
  setLinkPreview(
    messageId: string,
    linkPreview: LinkPreviewData,
  ): Promise<MessageResponse>;
}
