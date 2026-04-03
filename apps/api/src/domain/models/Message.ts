/**
 * @module Message Domain Model
 *
 * Core domain model for messages in the Kalle WhatsApp clone.
 * Implements encapsulated business logic following OOD principles (R16).
 *
 * Key invariants enforced:
 * - Messages can only be edited by the original sender within 15 minutes (R19)
 * - Deleted messages become tombstones with nulled ciphertext (R20)
 * - Server stores only ciphertext — zero decryption logic (R12)
 *
 * Architecture constraints:
 * - Zero Prisma imports — ORM-agnostic pure TypeScript (R17)
 * - Zero console.log calls — structured logging only (R28)
 * - Zero I/O operations — no database, no HTTP, no filesystem
 * - TypeScript strict mode compatible with zero warnings (R7)
 * - Imports ONLY from @kalle/shared
 */

import {
  MessageType,
  MessageStatusEnum,
  type MessageResponse,
  type LinkPreviewData,
  TTL,
} from '@kalle/shared';

// =============================================================================
// Interfaces
// =============================================================================

/**
 * MessageProps — constructor properties interface for the Message domain model.
 *
 * Represents the complete persistent state of a message. All date fields use
 * native Date objects internally; serialization to ISO 8601 strings is handled
 * by toResponse(). The ciphertext field is null when the message has been
 * soft-deleted as a tombstone (R20).
 */
export interface MessageProps {
  /** Unique message identifier (UUID) */
  id: string;

  /** ID of the conversation this message belongs to */
  conversationId: string;

  /** ID of the user who sent this message */
  senderId: string;

  /** Display name of the sender for UI rendering */
  senderName: string;

  /** Avatar URL of the sender; undefined if no avatar is set */
  senderAvatar?: string;

  /**
   * Encrypted message content (Base64-encoded Signal Protocol ciphertext).
   * Null when the message has been soft-deleted as a tombstone (R20).
   * The server MUST NOT decrypt this value at any point (R12).
   */
  ciphertext: string | null;

  /** Content type classification determining UI rendering and media handling */
  type: MessageType;

  /** ID of the message being replied to; undefined for non-reply messages */
  replyToMessageId?: string;

  /** ID of the attached encrypted media asset; undefined for text-only messages */
  mediaId?: string;

  /** Extracted Open Graph metadata for link preview cards; populated async via BullMQ */
  linkPreview?: LinkPreviewData;

  /** Whether this message has been edited (R19); false for unedited messages */
  isEdited: boolean;

  /** Whether this message has been soft-deleted as a tombstone (R20) */
  isDeleted: boolean;

  /** Timestamp of the most recent edit; undefined if never edited */
  editedAt?: Date;

  /** Timestamp when the message was deleted; undefined if not deleted */
  deletedAt?: Date;

  /** Client-generated UUID for idempotency and deduplication (R4) */
  clientMessageId: string;

  /** Server-assigned authoritative timestamp for message ordering (R4) */
  serverTimestamp: Date;

  /** Record creation timestamp */
  createdAt: Date;

  /** Record last-modification timestamp */
  updatedAt: Date;
}

/**
 * Internal representation of a per-recipient message delivery/read status.
 * Used by getStatus() to compute the aggregate delivery status across
 * all recipients in both 1:1 and group conversations.
 */
interface RecipientStatus {
  /** ID of the recipient user */
  userId: string;

  /** Current delivery/read status for this recipient */
  status: MessageStatusEnum;
}

// =============================================================================
// Message Domain Model
// =============================================================================

/**
 * Message — core domain model with encapsulated business logic.
 *
 * This is NOT an anemic data bag. It contains validation, state transition logic,
 * and invariant enforcement for the message lifecycle:
 *
 * - **create()**: Static factory with comprehensive input validation
 * - **canEdit() / edit()**: Enforce sender-only 15-minute edit window (R19)
 * - **markDeleted()**: Creates tombstones by nulling ciphertext (R20)
 * - **getStatus()**: Computes aggregate delivery status across recipients
 * - **Type guards**: isText(), isImage(), isVideo(), isDocument(), isVoiceNote()
 * - **State queries**: isTombstone(), hasMedia(), hasLinkPreview(), hasReply()
 * - **toResponse()**: Serializes to the shared API response contract
 *
 * Zero Prisma imports (R17). Zero I/O. Pure TypeScript domain logic.
 */
export class Message {
  // --- Private mutable fields ---
  // Some fields must be mutable to support state transitions (edit, delete)

  private _id: string;
  private readonly _conversationId: string;
  private readonly _senderId: string;
  private readonly _senderName: string;
  private readonly _senderAvatar: string | undefined;
  private _ciphertext: string | null;
  private readonly _type: MessageType;
  private readonly _replyToMessageId: string | undefined;
  private readonly _mediaId: string | undefined;
  private readonly _linkPreview: LinkPreviewData | undefined;
  private _isEdited: boolean;
  private _isDeleted: boolean;
  private _editedAt: Date | undefined;
  private _deletedAt: Date | undefined;
  private readonly _clientMessageId: string;
  private readonly _serverTimestamp: Date;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  /** Internal per-recipient status updates for aggregate status computation */
  private readonly _statusUpdates: RecipientStatus[];

  // =========================================================================
  // Constructor
  // =========================================================================

  /**
   * Constructs a Message domain model from persisted properties.
   *
   * For creating NEW messages with validation, use the static factory
   * method `Message.create()` instead.
   *
   * @param props - The message properties to hydrate from
   * @param statusUpdates - Optional per-recipient delivery/read status entries
   *                        for aggregate status computation via getStatus()
   */
  constructor(props: MessageProps, statusUpdates?: RecipientStatus[]) {
    this._id = props.id;
    this._conversationId = props.conversationId;
    this._senderId = props.senderId;
    this._senderName = props.senderName;
    this._senderAvatar = props.senderAvatar;
    this._ciphertext = props.ciphertext;
    this._type = props.type;
    this._replyToMessageId = props.replyToMessageId;
    this._mediaId = props.mediaId;
    this._linkPreview = props.linkPreview;
    this._isEdited = props.isEdited;
    this._isDeleted = props.isDeleted;
    this._editedAt = props.editedAt;
    this._deletedAt = props.deletedAt;
    this._clientMessageId = props.clientMessageId;
    this._serverTimestamp = props.serverTimestamp;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
    this._statusUpdates = statusUpdates ?? [];
  }

  // =========================================================================
  // Public Getter Accessors (Encapsulation)
  // =========================================================================

  /** Unique message identifier (UUID) */
  get id(): string {
    return this._id;
  }

  /** ID of the conversation this message belongs to */
  get conversationId(): string {
    return this._conversationId;
  }

  /** ID of the user who sent this message */
  get senderId(): string {
    return this._senderId;
  }

  /** Display name of the sender */
  get senderName(): string {
    return this._senderName;
  }

  /** Avatar URL of the sender; undefined if no avatar set */
  get senderAvatar(): string | undefined {
    return this._senderAvatar;
  }

  /** Encrypted content; null when deleted as tombstone (R20) */
  get ciphertext(): string | null {
    return this._ciphertext;
  }

  /** Content type classification */
  get type(): MessageType {
    return this._type;
  }

  /** ID of the message being replied to; undefined for non-replies */
  get replyToMessageId(): string | undefined {
    return this._replyToMessageId;
  }

  /** ID of attached encrypted media; undefined for text-only messages */
  get mediaId(): string | undefined {
    return this._mediaId;
  }

  /** Extracted Open Graph link preview metadata; undefined if not available */
  get linkPreview(): LinkPreviewData | undefined {
    return this._linkPreview;
  }

  /** Whether this message has been edited (R19) */
  get isEdited(): boolean {
    return this._isEdited;
  }

  /** Whether this message has been soft-deleted as tombstone (R20) */
  get isDeleted(): boolean {
    return this._isDeleted;
  }

  /** Timestamp of the most recent edit; undefined if never edited */
  get editedAt(): Date | undefined {
    return this._editedAt;
  }

  /** Timestamp when the message was deleted; undefined if not deleted */
  get deletedAt(): Date | undefined {
    return this._deletedAt;
  }

  /** Client-generated UUID for idempotency and deduplication (R4) */
  get clientMessageId(): string {
    return this._clientMessageId;
  }

  /** Server-assigned authoritative timestamp for ordering (R4) */
  get serverTimestamp(): Date {
    return this._serverTimestamp;
  }

  /** Record creation timestamp */
  get createdAt(): Date {
    return this._createdAt;
  }

  /** Record last-modification timestamp */
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // =========================================================================
  // Static Factory Method
  // =========================================================================

  /**
   * Creates a new Message instance with comprehensive input validation.
   *
   * Validates all required fields and initializes default state:
   * - isEdited = false (new message, never edited)
   * - isDeleted = false (new message, not deleted)
   * - serverTimestamp, createdAt, updatedAt = current time
   * - id = newly generated UUID v4
   *
   * @param dto - The creation DTO containing validated message data
   * @returns A fully initialized Message domain model instance
   *
   * @throws Error if ciphertext is empty or null
   * @throws Error if conversationId is empty
   * @throws Error if senderId is empty
   * @throws Error if clientMessageId is empty
   * @throws Error if type is not a valid MessageType enum value
   */
  static create(dto: {
    conversationId: string;
    senderId: string;
    senderName: string;
    senderAvatar?: string;
    ciphertext: string;
    type: MessageType;
    replyToMessageId?: string;
    mediaId?: string;
    clientMessageId: string;
  }): Message {
    // Validate ciphertext is not empty or null (R12: server stores ciphertext)
    if (!dto.ciphertext || dto.ciphertext.trim().length === 0) {
      throw new Error('Message ciphertext must not be empty');
    }

    // Validate conversationId is not empty
    if (!dto.conversationId || dto.conversationId.trim().length === 0) {
      throw new Error('Message conversationId must not be empty');
    }

    // Validate senderId is not empty
    if (!dto.senderId || dto.senderId.trim().length === 0) {
      throw new Error('Message senderId must not be empty');
    }

    // Validate senderName is not empty
    if (!dto.senderName || dto.senderName.trim().length === 0) {
      throw new Error('Message senderName must not be empty');
    }

    // Validate clientMessageId is not empty (R4: idempotency key)
    if (!dto.clientMessageId || dto.clientMessageId.trim().length === 0) {
      throw new Error('Message clientMessageId must not be empty');
    }

    // Validate type is a valid MessageType enum value
    const validTypes: string[] = Object.values(MessageType);
    if (!validTypes.includes(dto.type as string)) {
      throw new Error(
        `Invalid message type: ${String(dto.type)}. Must be one of: ${validTypes.join(', ')}`
      );
    }

    const now = new Date();

    // Generate a unique identifier for the new message
    const id = crypto.randomUUID();

    return new Message({
      id,
      conversationId: dto.conversationId,
      senderId: dto.senderId,
      senderName: dto.senderName,
      senderAvatar: dto.senderAvatar,
      ciphertext: dto.ciphertext,
      type: dto.type,
      replyToMessageId: dto.replyToMessageId,
      mediaId: dto.mediaId,
      linkPreview: undefined,
      isEdited: false,
      isDeleted: false,
      editedAt: undefined,
      deletedAt: undefined,
      clientMessageId: dto.clientMessageId,
      serverTimestamp: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  // =========================================================================
  // Business Logic Methods
  // =========================================================================

  /**
   * Determines if this message can be edited by the specified user at the given time.
   *
   * Edit constraints enforced (R19):
   * 1. Message must not be deleted (tombstone — cannot edit deleted messages)
   * 2. User must be the original sender (sender-only restriction)
   * 3. Ciphertext must not be null (tombstone state)
   * 4. Current time must be within 15-minute window of serverTimestamp
   *
   * The 15-minute boundary is inclusive: exactly 15 minutes elapsed still allows edit.
   *
   * @param userId - The ID of the user attempting to edit
   * @param now - Optional current time for testability; defaults to new Date()
   * @returns true if the edit is permitted; false otherwise
   */
  canEdit(userId: string, now?: Date): boolean {
    // Cannot edit deleted messages
    if (this._isDeleted) {
      return false;
    }

    // Sender-only restriction (R19)
    if (userId !== this._senderId) {
      return false;
    }

    // Cannot edit if ciphertext is already null (tombstone state)
    if (this._ciphertext === null) {
      return false;
    }

    // 15-minute edit window check (R19)
    // Uses TTL.MESSAGE_EDIT_WINDOW_MS = 900,000 ms = 15 minutes
    const currentTime = now ?? new Date();
    const elapsedMs = currentTime.getTime() - this._serverTimestamp.getTime();

    // Boundary: exactly 15 minutes elapsed still permits edit (inclusive window)
    if (elapsedMs > TTL.MESSAGE_EDIT_WINDOW_MS) {
      return false;
    }

    return true;
  }

  /**
   * Edits the message by replacing its ciphertext with new encrypted content (R19).
   *
   * The original ciphertext is NOT retained — it is overwritten server-side.
   * After a successful edit:
   * - ciphertext is replaced with newCiphertext
   * - isEdited is set to true
   * - editedAt is set to the current time
   * - updatedAt is set to the current time
   *
   * @param newCiphertext - New encrypted content replacing the current ciphertext
   * @param userId - The ID of the user attempting to edit
   * @param now - Optional current time for testability; defaults to new Date()
   *
   * @throws Error if the message is deleted (tombstone)
   * @throws Error if the user is not the original sender
   * @throws Error if the ciphertext is null
   * @throws Error if the 15-minute edit window has expired
   * @throws Error if the new ciphertext is empty
   */
  edit(newCiphertext: string, userId: string, now?: Date): void {
    // Check edit permissions using canEdit() — R19
    if (!this.canEdit(userId, now)) {
      // Provide specific error message based on the failure reason
      if (this._isDeleted) {
        throw new Error('Cannot edit a deleted message');
      }
      if (userId !== this._senderId) {
        throw new Error('Only the message sender can edit this message');
      }
      if (this._ciphertext === null) {
        throw new Error('Cannot edit a tombstone message');
      }
      // If none of the above, it must be the time window expiration
      throw new Error(
        'Message edit window has expired. Messages can only be edited within 15 minutes of sending.'
      );
    }

    // Validate new ciphertext is not empty or null
    if (!newCiphertext || newCiphertext.trim().length === 0) {
      throw new Error('New ciphertext must not be empty');
    }

    // Apply the edit — original ciphertext NOT retained (R19)
    const currentTime = now ?? new Date();
    this._ciphertext = newCiphertext;
    this._isEdited = true;
    this._editedAt = currentTime;
    this._updatedAt = currentTime;
  }

  /**
   * Soft-deletes the message by creating a tombstone (R20).
   *
   * Sets the ciphertext to null and marks the message as deleted.
   * The database row is retained — all participants render
   * "This message was deleted" in the chat UI.
   *
   * This operation is idempotent: calling markDeleted() on an already-deleted
   * message does not throw an error and does not change state.
   *
   * @param userId - The ID of the user attempting to delete
   * @throws Error if the user is not the original message sender
   */
  markDeleted(userId: string): void {
    // Sender-only deletion constraint
    if (userId !== this._senderId) {
      throw new Error('Only the message sender can delete this message');
    }

    // Idempotent: if already deleted, return without error or state change
    if (this._isDeleted) {
      return;
    }

    // Apply tombstone — null ciphertext, set deletion flags (R20)
    const now = new Date();
    this._ciphertext = null;
    this._isDeleted = true;
    this._deletedAt = now;
    this._updatedAt = now;
  }

  /**
   * Computes the aggregate delivery/read status across all recipients.
   *
   * Status computation rules:
   * - If ALL recipients have status READ → return READ
   * - If ALL recipients have status DELIVERED or higher → return DELIVERED
   * - Otherwise → return SENT
   * - If no status updates exist (default) → return SENT
   *
   * In group conversations, this returns the minimum status achieved
   * across all participants.
   *
   * @returns The aggregate MessageStatusEnum value
   */
  getStatus(): MessageStatusEnum {
    // Default: SENT if no per-recipient status updates exist
    if (this._statusUpdates.length === 0) {
      return MessageStatusEnum.SENT;
    }

    // Check if ALL recipients have READ status
    const allRead = this._statusUpdates.every(
      (recipientStatus) => recipientStatus.status === MessageStatusEnum.READ
    );
    if (allRead) {
      return MessageStatusEnum.READ;
    }

    // Check if ALL recipients have at least DELIVERED status
    const allDeliveredOrHigher = this._statusUpdates.every(
      (recipientStatus) =>
        recipientStatus.status === MessageStatusEnum.DELIVERED ||
        recipientStatus.status === MessageStatusEnum.READ
    );
    if (allDeliveredOrHigher) {
      return MessageStatusEnum.DELIVERED;
    }

    // Some recipients still at SENT status
    return MessageStatusEnum.SENT;
  }

  // =========================================================================
  // Type Guard Methods
  // =========================================================================

  /**
   * Returns true if this message contains plain text content.
   * Type guards are mutually exclusive for any given message instance.
   */
  isText(): boolean {
    return this._type === MessageType.TEXT;
  }

  /**
   * Returns true if this message contains an image attachment.
   * Supported formats: JPEG, PNG, GIF, WebP.
   */
  isImage(): boolean {
    return this._type === MessageType.IMAGE;
  }

  /**
   * Returns true if this message contains a video attachment.
   * Supported formats: MP4, WebM, QuickTime.
   */
  isVideo(): boolean {
    return this._type === MessageType.VIDEO;
  }

  /**
   * Returns true if this message contains a document attachment.
   * Supported formats: PDF, DOC, DOCX, XLS, XLSX, TXT, CSV.
   */
  isDocument(): boolean {
    return this._type === MessageType.DOCUMENT;
  }

  /**
   * Returns true if this message contains a voice note recording.
   * Voice notes include waveform visualization data and playback controls.
   */
  isVoiceNote(): boolean {
    return this._type === MessageType.VOICE_NOTE;
  }

  // =========================================================================
  // State Query Methods
  // =========================================================================

  /**
   * Returns true if the message is a tombstone — soft-deleted with nulled
   * ciphertext (R20). Tombstone messages render as "This message was deleted"
   * in the chat UI for all participants.
   */
  isTombstone(): boolean {
    return this._isDeleted === true && this._ciphertext === null;
  }

  /**
   * Returns true if the message has an attached encrypted media asset.
   * Media includes images, videos, documents, and voice notes.
   */
  hasMedia(): boolean {
    return this._mediaId !== undefined && this._mediaId !== null;
  }

  /**
   * Returns true if link preview metadata has been extracted and is available.
   * Link previews are populated asynchronously by the link-preview BullMQ job.
   */
  hasLinkPreview(): boolean {
    return this._linkPreview !== undefined && this._linkPreview !== null;
  }

  /**
   * Returns true if this message is a reply to another message.
   * Reply messages display an inline quoted preview of the original message.
   */
  hasReply(): boolean {
    return this._replyToMessageId !== undefined && this._replyToMessageId !== null;
  }

  // =========================================================================
  // Serialization
  // =========================================================================

  /**
   * Serializes the Message domain model to the shared API response contract.
   *
   * Converts all Date fields to ISO 8601 strings for cross-platform compatibility.
   * Computes the aggregate delivery status via getStatus().
   *
   * Note: The `replyTo` field is not populated here because the domain model
   * only stores the replyToMessageId reference. The service layer is responsible
   * for hydrating the full ReplyToMessage data before sending the response.
   *
   * @returns A plain object conforming to the MessageResponse interface
   */
  toResponse(): MessageResponse {
    const response: MessageResponse = {
      id: this._id,
      conversationId: this._conversationId,
      senderId: this._senderId,
      senderName: this._senderName,
      senderAvatar: this._senderAvatar,
      ciphertext: this._ciphertext,
      type: this._type,
      status: this.getStatus(),
      replyTo: undefined,
      mediaId: this._mediaId,
      linkPreview: this._linkPreview,
      isEdited: this._isEdited,
      isDeleted: this._isDeleted,
      editedAt: this._editedAt ? this._editedAt.toISOString() : undefined,
      deletedAt: this._deletedAt ? this._deletedAt.toISOString() : undefined,
      clientMessageId: this._clientMessageId,
      serverTimestamp: this._serverTimestamp.toISOString(),
      createdAt: this._createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
    };

    return response;
  }
}
