/**
 * @file MessageService.ts
 * @description Message lifecycle service handling encrypted message send, edit,
 * delete (tombstone), cursor-paginated history, delivery/read status tracking,
 * and offline sync support for the Kalle WhatsApp clone.
 *
 * The server stores ONLY opaque ciphertext — zero decryption or plaintext
 * access logic exists anywhere in this file or the broader server codebase.
 *
 * Architecture Rules Enforced:
 * - R12: E2E Encryption Integrity — ciphertext is opaque; zero decryption.
 * - R16: OOD Layering — ALL message business logic lives here; controllers
 *        are thin delegation layers.
 * - R17: Interface-Driven Dependencies — all deps via constructor as interfaces.
 * - R18: Fan-Out via Queue — delivery to 3+ recipients goes through BullMQ.
 *        Group message API returns BEFORE all deliveries complete.
 * - R19: Message Edit Integrity — sender-only, 15-minute window, ciphertext swap.
 * - R20: Message Delete as Tombstone — soft-delete: ciphertext nulled, row retained.
 * - R4:  Real-Time Message Integrity — clientMessageId deduplication,
 *        serverTimestamp ordering.
 * - R13: Offline Reconciliation — syncMessages retrieves missed messages.
 * - R22: Standardized Error Responses — typed DomainError subclasses.
 * - R28: Structured Logging Only — zero console.log calls.
 * - R7:  Zero Warnings Build — TypeScript strict mode, zero warnings.
 * - R23: Log Hygiene — never log ciphertext, keys, or tokens.
 */

// ---------------------------------------------------------------------------
// Internal dependency imports (type-only for interfaces and data types)
// ---------------------------------------------------------------------------

import type {
  IMessageRepository,
  CreateMessageData,
  UpdateMessageData,
  SoftDeleteMessageData,
  MessageQueryOptions,
} from '../domain/interfaces/IMessageRepository';

import type { IConversationRepository } from '../domain/interfaces/IConversationRepository';

import type { ICacheProvider } from '../domain/interfaces/ICacheProvider';

import type { IQueueProvider } from '../domain/interfaces/IQueueProvider';

// ---------------------------------------------------------------------------
// Error class imports (concrete classes for throwing)
// ---------------------------------------------------------------------------

import { NotFoundError } from '../errors/NotFoundError';
import { AuthorizationError } from '../errors/AuthorizationError';
import { ValidationError } from '../errors/ValidationError';

// ---------------------------------------------------------------------------
// Shared type imports from @kalle/shared
// ---------------------------------------------------------------------------

// Value import: MessageStatusEnum is used at runtime in batchMarkRead()
import { MessageStatusEnum } from '@kalle/shared';

// Type imports: all used — MessageResponse as return type, SendMessageDTO as
// base interface for SendMessageParams, EditMessageDTO for EditMessageParams
// field type, MessageStatusUpdate as return type for updateMessageStatus.
import type {
  MessageResponse,
  SendMessageDTO,
  EditMessageDTO,
  MessageStatusUpdate,
} from '@kalle/shared';

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum elapsed time (in milliseconds) from message creation during which
 * the sender may edit the message ciphertext. After this window, edit requests
 * are rejected with a ValidationError.
 *
 * Per R19: 15-minute edit window enforced server-side.
 */
const EDIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Minimum number of conversation participants that triggers asynchronous
 * message delivery via BullMQ fan-out rather than direct WebSocket emission.
 *
 * Per R18: 3+ recipients → BullMQ; < 3 → handled directly by WS handler.
 */
const FAN_OUT_THRESHOLD = 3;

/**
 * Basic URL detection regex used to determine whether a link-preview
 * extraction job should be enqueued after message creation. Applied to the
 * raw ciphertext for pattern matching only — no decryption involved.
 *
 * Note: Because the message payload is encrypted ciphertext, URL detection
 * on the raw string is a best-effort heuristic. The link-preview worker
 * handles cases where the payload does not actually contain a URL gracefully.
 */
const URL_REGEX = /https?:\/\/[^\s]+/i;

// =============================================================================
// Input Parameter Interfaces
// =============================================================================

/**
 * Server-side extension of the shared SendMessageDTO contract. Inherits all
 * client-provided fields (conversationId, ciphertext, type, replyToMessageId,
 * mediaId, clientMessageId) and adds server-side identity fields that the
 * controller injects from the authenticated user context.
 */
interface SendMessageParams extends SendMessageDTO {
  /** Authenticated user's identifier */
  readonly senderId: string;
  /** Display name of the sender (stored alongside message for denormalization) */
  readonly senderName: string;
  /** Optional avatar URL of the sender */
  readonly senderAvatar?: string;
}

/**
 * Parameters for the editMessage method. The `newCiphertext` field type is
 * derived from the shared EditMessageDTO contract to ensure contract alignment.
 */
interface EditMessageParams {
  /** Identifier of the message to edit */
  readonly messageId: string;
  /** Authenticated user's identifier — must match original sender (R19) */
  readonly senderId: string;
  /** Replacement opaque ciphertext (R12, R19) — type derived from EditMessageDTO */
  readonly newCiphertext: EditMessageDTO['ciphertext'];
}

/**
 * Parameters for the deleteMessage method.
 */
interface DeleteMessageParams {
  /** Identifier of the message to soft-delete */
  readonly messageId: string;
  /** Authenticated user's identifier — must match original sender (R20) */
  readonly senderId: string;
}

/**
 * Parameters for the getMessageHistory method.
 */
interface GetMessageHistoryParams {
  /** Conversation whose history to fetch */
  readonly conversationId: string;
  /** Authenticated user requesting history — must be participant */
  readonly userId: string;
  /** Optional cursor for pagination (serverTimestamp or message ID) */
  readonly cursor?: string;
  /** Page size (defaults to 50) */
  readonly limit?: number;
}

/**
 * Parameters for the syncMessages method (R13: offline reconciliation).
 */
interface SyncMessagesParams {
  /** Authenticated user performing sync */
  readonly userId: string;
  /** Conversation IDs to sync across */
  readonly conversationIds: string[];
  /** Timestamp boundary — fetch all messages after this point */
  readonly afterTimestamp: Date;
  /** Optional limit on returned messages */
  readonly limit?: number;
}

/**
 * Parameters for the updateMessageStatus method.
 */
interface UpdateMessageStatusParams {
  /** Message whose status to update */
  readonly messageId: string;
  /** User whose status entry is being updated */
  readonly userId: string;
  /** New status value (SENT → DELIVERED → READ) */
  readonly status: MessageStatusEnum;
}

/**
 * Parameters for the batchMarkRead method.
 */
interface BatchMarkReadParams {
  /** Message IDs to mark as read */
  readonly messageIds: string[];
  /** User marking messages as read */
  readonly userId: string;
  /** Conversation ID for resetting unread count */
  readonly conversationId: string;
}

// =============================================================================
// MessageService Class
// =============================================================================

/**
 * Service class encapsulating all message lifecycle business logic.
 *
 * Dependencies are received via constructor injection typed as interfaces
 * per R17. The composition root in `server.ts` wires concrete implementations.
 *
 * @example
 * ```typescript
 * // In server.ts composition root:
 * const messageService = new MessageService(
 *   messageRepository,
 *   conversationRepository,
 *   cacheProvider,
 *   queueProvider,
 * );
 * ```
 */
export class MessageService {
  /**
   * Creates a new MessageService instance with all required dependencies.
   *
   * @param messageRepository      - Persistence contract for message CRUD and queries
   * @param conversationRepository - Participant verification and unread count management
   * @param cacheProvider          - Redis abstraction for caching (participant lists, etc.)
   * @param queueProvider          - BullMQ abstraction for async job enqueuing
   */
  constructor(
    private readonly messageRepository: IMessageRepository,
    private readonly conversationRepository: IConversationRepository,
    private readonly cacheProvider: ICacheProvider,
    private readonly queueProvider: IQueueProvider,
  ) {}

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Retrieves participant IDs for a conversation, leveraging the cache
   * provider for frequently accessed conversations (e.g., during burst
   * message sends). Falls back to the conversation repository on cache miss
   * and stores the result with a short TTL.
   *
   * @param conversationId - Conversation to look up participants for
   * @returns Array of participant user IDs
   */
  private async getCachedParticipantIds(
    conversationId: string,
  ): Promise<string[]> {
    const cacheKey = `conv:${conversationId}:participants`;
    const cached = await this.cacheProvider.get<string[]>(cacheKey);
    if (cached) {
      return cached;
    }
    const participantIds =
      await this.conversationRepository.getParticipantIds(conversationId);
    // Cache for 5 minutes — ConversationService invalidates on membership changes
    await this.cacheProvider.set(cacheKey, participantIds, 300);
    return participantIds;
  }

  // ---------------------------------------------------------------------------
  // sendMessage (R12, R18, R4)
  // ---------------------------------------------------------------------------

  /**
   * Creates and persists a new encrypted message.
   *
   * Business rules applied:
   * 1. Sender must be a participant in the conversation (AuthorizationError).
   * 2. Deduplication via `clientMessageId` — if a message with the same ID
   *    already exists, return the existing one idempotently (R4).
   * 3. Increment unread counts for all participants except the sender.
   * 4. Fan-out decision (R18): if the conversation has 3+ participants, enqueue
   *    a `message-fanout` BullMQ job; for 1:1 chats, the WebSocket handler
   *    delivers directly.
   * 5. If the ciphertext matches the URL regex, enqueue a `link-preview` job.
   *
   * @param params - Send message parameters
   * @returns The created MessageResponse
   * @throws AuthorizationError if sender is not a conversation participant
   */
  public async sendMessage(params: SendMessageParams): Promise<MessageResponse> {
    const {
      conversationId,
      senderId,
      senderName,
      senderAvatar,
      ciphertext,
      type,
      replyToMessageId,
      mediaId,
      clientMessageId,
    } = params;

    // Step 1: Verify sender is a conversation participant
    const isParticipant = await this.conversationRepository.isParticipant(
      conversationId,
      senderId,
    );
    if (!isParticipant) {
      throw new AuthorizationError(
        'Sender is not a participant in this conversation',
        { conversationId, senderId },
      );
    }

    // Step 2: Deduplication check via clientMessageId (R4)
    const existingMessage = await this.messageRepository.findByClientMessageId(
      clientMessageId,
    );
    if (existingMessage) {
      // Idempotent: return the already-persisted message
      return existingMessage;
    }

    // Step 3: Persist the new message (ciphertext stored as opaque blob — R12)
    const createData: CreateMessageData = {
      conversationId,
      senderId,
      senderName,
      senderAvatar,
      ciphertext,
      type,
      replyToMessageId,
      mediaId,
      clientMessageId,
    };
    const message = await this.messageRepository.create(createData);

    // Step 4: Increment unread counts for all participants except sender
    await this.conversationRepository.incrementUnreadCount(
      conversationId,
      senderId,
    );

    // Step 5: Fan-out decision (R18)
    const participantIds = await this.getCachedParticipantIds(conversationId);
    if (participantIds.length >= FAN_OUT_THRESHOLD) {
      // Group chat: enqueue BullMQ job; API returns before deliveries complete
      const recipientIds = participantIds.filter((id) => id !== senderId);
      await this.queueProvider.enqueue('message-fanout', {
        messageId: message.id,
        conversationId,
        senderId,
        recipientIds,
      });
    }
    // For 1:1 (< 3 participants): WebSocket handler delivers directly — no queue

    // Step 6: Enqueue link-preview extraction if ciphertext matches URL pattern
    if (URL_REGEX.test(ciphertext)) {
      await this.queueProvider.enqueue('link-preview', {
        messageId: message.id,
        conversationId,
      });
    }

    return message;
  }

  // ---------------------------------------------------------------------------
  // editMessage (R19)
  // ---------------------------------------------------------------------------

  /**
   * Replaces the ciphertext of an existing message (edit operation).
   *
   * Business rules applied:
   * 1. Message must exist (NotFoundError).
   * 2. Only the original sender may edit (AuthorizationError — R19).
   * 3. Edit must occur within 15 minutes of message creation (ValidationError — R19).
   * 4. Cannot edit a tombstoned (deleted) message (ValidationError — R20).
   * 5. Original ciphertext is NOT retained (R19).
   *
   * @param params - Edit message parameters
   * @returns The updated MessageResponse with new ciphertext
   * @throws NotFoundError if message does not exist
   * @throws AuthorizationError if requester is not the original sender
   * @throws ValidationError if edit window has expired or message is deleted
   */
  public async editMessage(params: EditMessageParams): Promise<MessageResponse> {
    const { messageId, senderId, newCiphertext } = params;

    // Step 1: Retrieve the existing message
    const message = await this.messageRepository.findById(messageId);
    if (!message) {
      throw new NotFoundError('Message not found', {
        resource: 'Message',
        id: messageId,
      });
    }

    // Step 2: Authorization — sender-only (R19)
    if (message.senderId !== senderId) {
      throw new AuthorizationError('Only the sender can edit this message', {
        messageId,
        requesterId: senderId,
      });
    }

    // Step 3: Tombstone guard — cannot edit a deleted message (R20)
    if (message.isDeleted) {
      throw new ValidationError('Cannot edit a deleted message', {
        fields: [
          {
            field: 'messageId',
            message: 'Message has been deleted',
            code: 'message_deleted',
          },
        ],
      });
    }

    // Step 4: 15-minute edit window enforcement (R19)
    const elapsedMs = Date.now() - new Date(message.serverTimestamp).getTime();
    if (elapsedMs > EDIT_WINDOW_MS) {
      throw new ValidationError('Message edit window expired (15 minutes)', {
        fields: [
          {
            field: 'messageId',
            message: 'Edit window expired',
            code: 'edit_window_expired',
          },
        ],
      });
    }

    // Step 5: Replace ciphertext — original NOT retained (R19)
    const updateData: UpdateMessageData = {
      ciphertext: newCiphertext,
      isEdited: true,
      editedAt: new Date(),
    };
    const updatedMessage = await this.messageRepository.update(
      messageId,
      updateData,
    );

    return updatedMessage;
  }

  // ---------------------------------------------------------------------------
  // deleteMessage (R20)
  // ---------------------------------------------------------------------------

  /**
   * Soft-deletes a message by nulling its ciphertext and marking as deleted.
   *
   * Business rules applied:
   * 1. Message must exist (NotFoundError).
   * 2. Only the original sender may delete (AuthorizationError — R20).
   * 3. If already deleted, return as-is (idempotent).
   * 4. Ciphertext is nulled, row retained, isDeleted set to true (R20).
   *
   * @param params - Delete message parameters
   * @returns The tombstone MessageResponse
   * @throws NotFoundError if message does not exist
   * @throws AuthorizationError if requester is not the original sender
   */
  public async deleteMessage(params: DeleteMessageParams): Promise<MessageResponse> {
    const { messageId, senderId } = params;

    // Step 1: Retrieve the existing message
    const message = await this.messageRepository.findById(messageId);
    if (!message) {
      throw new NotFoundError('Message not found', {
        resource: 'Message',
        id: messageId,
      });
    }

    // Step 2: Authorization — sender-only (R20)
    if (message.senderId !== senderId) {
      throw new AuthorizationError('Only the sender can delete this message', {
        messageId,
        requesterId: senderId,
      });
    }

    // Step 3: Idempotent — if already deleted, return as-is
    if (message.isDeleted) {
      return message;
    }

    // Step 4: Soft-delete tombstone — ciphertext nulled, row retained (R20)
    const deleteData: SoftDeleteMessageData = {
      ciphertext: null,
      isDeleted: true,
      deletedAt: new Date(),
    };
    const tombstone = await this.messageRepository.softDelete(
      messageId,
      deleteData,
    );

    return tombstone;
  }

  // ---------------------------------------------------------------------------
  // getMessageHistory
  // ---------------------------------------------------------------------------

  /**
   * Retrieves cursor-paginated message history for a conversation.
   *
   * Business rules applied:
   * 1. Requester must be a conversation participant (AuthorizationError).
   * 2. Default page size is 50 messages.
   * 3. Results ordered by serverTimestamp descending (newest first).
   *
   * @param params - History retrieval parameters
   * @returns Paginated result with items, cursor, and hasMore flag
   * @throws AuthorizationError if requester is not a participant
   */
  public async getMessageHistory(
    params: GetMessageHistoryParams,
  ): Promise<{ items: MessageResponse[]; cursor?: string; hasMore: boolean }> {
    const { conversationId, userId, cursor, limit } = params;

    // Verify requester is a participant
    const isParticipant = await this.conversationRepository.isParticipant(
      conversationId,
      userId,
    );
    if (!isParticipant) {
      throw new AuthorizationError(
        'User is not a participant in this conversation',
        { conversationId, userId },
      );
    }

    // Delegate to repository with default page size
    const queryOptions: MessageQueryOptions = {
      conversationId,
      cursor,
      limit: limit ?? 50,
    };

    const result = await this.messageRepository.findByConversation(queryOptions);
    return result;
  }

  // ---------------------------------------------------------------------------
  // syncMessages (R13 — Offline Reconciliation)
  // ---------------------------------------------------------------------------

  /**
   * Retrieves all messages across one or more conversations that were created
   * after a specified timestamp. Used for offline-to-online reconciliation.
   *
   * Business rules applied:
   * 1. User must be a participant in EVERY requested conversation.
   *    Non-participant conversations are silently filtered out.
   * 2. Results sorted by serverTimestamp ascending (oldest first) so the
   *    client can replay in order.
   *
   * @param params - Sync parameters with conversation IDs and cutoff timestamp
   * @returns Array of missed messages ordered by serverTimestamp ascending
   */
  public async syncMessages(
    params: SyncMessagesParams,
  ): Promise<MessageResponse[]> {
    const { userId, conversationIds, afterTimestamp, limit } = params;

    // Filter to only conversations where the user is a participant
    const authorizedConversationIds: string[] = [];
    for (const conversationId of conversationIds) {
      const isParticipant = await this.conversationRepository.isParticipant(
        conversationId,
        userId,
      );
      if (isParticipant) {
        authorizedConversationIds.push(conversationId);
      }
    }

    // If no authorized conversations, return empty array
    if (authorizedConversationIds.length === 0) {
      return [];
    }

    // Delegate to repository — returns messages sorted by serverTimestamp ASC
    const messages = await this.messageRepository.findAfterTimestamp(
      authorizedConversationIds,
      afterTimestamp,
      limit,
    );

    return messages;
  }

  // ---------------------------------------------------------------------------
  // updateMessageStatus
  // ---------------------------------------------------------------------------

  /**
   * Updates the delivery/read status of a message for a specific user.
   *
   * Status flow: SENT → DELIVERED → READ (monotonic progression).
   * The repository enforces that status can only advance forward.
   *
   * @param params - Status update parameters
   * @returns The updated MessageStatusUpdate record
   */
  public async updateMessageStatus(
    params: UpdateMessageStatusParams,
  ): Promise<MessageStatusUpdate> {
    const { messageId, userId, status } = params;

    const result = await this.messageRepository.updateStatus(
      messageId,
      userId,
      status,
    );

    return result;
  }

  // ---------------------------------------------------------------------------
  // batchMarkRead
  // ---------------------------------------------------------------------------

  /**
   * Marks multiple messages as read for a user and resets the conversation's
   * unread count.
   *
   * Business rules applied:
   * 1. All specified messages are marked as READ status.
   * 2. The conversation's unread count for the user is reset to zero.
   *
   * @param params - Batch read parameters including conversationId for unread reset
   */
  public async batchMarkRead(params: BatchMarkReadParams): Promise<void> {
    const { messageIds, userId, conversationId } = params;

    // Batch update all message statuses to READ
    await this.messageRepository.batchUpdateStatus(
      messageIds,
      userId,
      MessageStatusEnum.READ,
    );

    // Reset the unread count for this user in the conversation
    await this.conversationRepository.resetUnreadCount(conversationId, userId);
  }
}
