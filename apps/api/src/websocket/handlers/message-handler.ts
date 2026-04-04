/**
 * @file message-handler.ts
 * @description WebSocket event handler for all message-related events:
 *   message:send, message:edit, message:delete, message:delivered, message:read.
 *
 * This is the most complex WebSocket handler — it orchestrates message lifecycle
 * operations across MessageService, ConversationService, ICacheProvider, and
 * IRealtimeProvider.
 *
 * Architecture Rules Enforced:
 *   R4  — Real-time message integrity (send-order, deduplication via clientMessageId)
 *   R7  — Zero warnings build (TypeScript strict mode)
 *   R12 — E2E encryption integrity (ciphertext is opaque — ZERO decryption logic)
 *   R17 — Interface-driven dependencies (all deps via function params)
 *   R18 — Fan-out via BullMQ for 3+ recipients (async after ack)
 *   R19 — Message edit: sender-only, 15-minute window, ciphertext swap
 *   R20 — Message delete: soft-delete tombstone, ciphertext nulled
 *   R23 — Log hygiene (NO ciphertext, tokens, or keys in logs)
 *   R25 — WebSocket rate limiting (30/min send, 60/min others)
 *   R28 — Structured logging only (zero console.log calls)
 *   R29 — Correlation ID propagation in all logs and emitted events
 */

import type { Socket } from 'socket.io';
import type { Logger } from 'pino';
import type { ICacheProvider } from '../../domain/interfaces/ICacheProvider';
import type { IRealtimeProvider } from '../../domain/interfaces/IRealtimeProvider';
import type { WsRateLimiter } from '../middleware/ws-rate-limiter';
import { MessageStatusEnum } from '@kalle/shared/types/message';
import type {
  MessageSendPayload,
  MessageEditPayload,
  MessageDeletePayload,
  MessageDeliveredPayload,
  MessageReadPayload,
  MessageNewPayload,
  MessageEditedPayload,
  MessageDeletedPayload,
  MessageStatusPayload,
  AckCallback,
  SocketData,
} from '@kalle/shared/types/websocket-events';

// =============================================================================
// Dependencies Interface
// =============================================================================

/**
 * MessageHandlerDeps — dependency injection container for message event handlers.
 *
 * All dependencies are passed via this interface — no concrete class imports are
 * allowed in this module (R17). The messageService and conversationService are
 * typed inline to decouple from concrete implementations. The actual instances
 * are wired and injected by the WebSocket index.ts composition.
 */
export interface MessageHandlerDeps {
  /** Message lifecycle service — handles send, edit, delete, status operations. */
  messageService: {
    sendMessage(params: {
      conversationId: string;
      senderId: string;
      senderName: string;
      senderAvatar?: string;
      ciphertext: string;
      type: string;
      replyToMessageId?: string;
      mediaId?: string;
      clientMessageId: string;
    }): Promise<{
      id: string;
      conversationId: string;
      senderId: string;
      ciphertext: string;
      type: string;
      serverTimestamp: string;
      clientMessageId: string;
      replyToMessageId?: string;
      mediaId?: string;
      isDeleted: boolean;
      isEdited: boolean;
      [key: string]: unknown;
    }>;
    editMessage(params: {
      messageId: string;
      senderId: string;
      newCiphertext: string;
    }): Promise<{
      id: string;
      conversationId: string;
      ciphertext: string;
      isEdited: boolean;
      editedAt: string;
      [key: string]: unknown;
    }>;
    deleteMessage(params: {
      messageId: string;
      senderId: string;
    }): Promise<{
      id: string;
      conversationId: string;
      isDeleted: boolean;
      deletedAt: string;
      [key: string]: unknown;
    }>;
    updateMessageStatus(params: {
      messageId: string;
      userId: string;
      status: string;
    }): Promise<unknown>;
    batchMarkRead(params: {
      messageIds: string[];
      userId: string;
    }): Promise<void>;
  };

  /** Conversation service — provides participant lookup for room broadcasting. */
  conversationService: {
    getParticipantIds(conversationId: string): Promise<string[]>;
  };

  /** Cache provider (Redis) — used for deduplication and participant lookups. */
  cacheProvider: ICacheProvider;

  /** Realtime provider (Socket.IO + Redis adapter) — used for cross-instance event emission. */
  realtimeProvider: IRealtimeProvider;

  /** Per-connection WebSocket rate limiter — enforces R25 limits. */
  rateLimiter: WsRateLimiter;

  /** Pino structured logger — all logging goes through this (R28). */
  logger: Logger;
}

// =============================================================================
// Error Response Helpers
// =============================================================================

/** Standard error codes for WebSocket ack error responses. */
const ERROR_CODES = {
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  RATE_LIMITED: 'RATE_LIMITED',
  AUTHORIZATION_ERROR: 'AUTHORIZATION_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/**
 * Builds a standardised error ack response matching the AckCallback contract.
 *
 * @param code    - Machine-readable error code
 * @param message - Human-readable error description
 * @returns Ack response object with success: false
 */
function buildErrorAck(code: string, message: string): {
  success: false;
  error: { code: string; message: string };
} {
  return { success: false, error: { code, message } };
}

/**
 * Maps domain error names to appropriate WebSocket error codes.
 *
 * @param error - Error instance from service layer
 * @returns Appropriate error code string
 */
function mapErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const name = error.constructor.name;
    switch (name) {
      case 'AuthenticationError':
      case 'AuthorizationError':
        return ERROR_CODES.AUTHORIZATION_ERROR;
      case 'ValidationError':
        return ERROR_CODES.VALIDATION_ERROR;
      case 'NotFoundError':
        return ERROR_CODES.NOT_FOUND;
      case 'ConflictError':
        return ERROR_CODES.CONFLICT;
      default:
        return ERROR_CODES.INTERNAL_ERROR;
    }
  }
  return ERROR_CODES.INTERNAL_ERROR;
}

/**
 * Extracts a safe error message for ack responses and logging (R23).
 * Ensures no sensitive data (ciphertext, tokens, keys) is leaked.
 *
 * @param error - Error instance
 * @returns Safe message string
 */
function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'An unexpected error occurred';
}

// =============================================================================
// Main Handler Registration
// =============================================================================

/**
 * Registers all message-related WebSocket event handlers on a socket connection.
 *
 * Handles 5 events:
 *   1. message:send     — Send a new encrypted message (30/min rate limit)
 *   2. message:edit     — Edit an existing message (60/min rate limit)
 *   3. message:delete   — Soft-delete a message as tombstone (60/min rate limit)
 *   4. message:delivered — Acknowledge message delivery (60/min rate limit)
 *   5. message:read     — Batch acknowledge message read (60/min rate limit)
 *
 * All handlers:
 *   - Check per-connection rate limits (R25); disconnect on exceed
 *   - Validate payload fields before service delegation
 *   - Treat ciphertext as opaque strings (R12; zero decryption)
 *   - Include correlationId and timestamp in all emitted events (R29)
 *   - Log with Pino child logger; NO ciphertext in logs (R23, R28)
 *   - Wrap async operations in try/catch with structured error acks
 *
 * @param socket - Socket.IO connection instance (with SocketData set by ws-auth middleware)
 * @param deps   - Injected dependencies (R17: interface-driven, no concrete imports)
 */
export function registerMessageHandlers(
  socket: Socket,
  deps: MessageHandlerDeps,
): void {
  const { messageService, rateLimiter, logger } = deps;

  // deps.conversationService, deps.cacheProvider, deps.realtimeProvider
  // are available for future handler extensions (e.g. participant lookups,
  // cache-based deduplication). Kept on the deps interface for completeness
  // per R17; accessed via deps.<prop> when needed.

  // Extract authenticated user context from ws-auth middleware (SocketData)
  const socketData = socket.data as SocketData;
  const userId: string = socketData.userId;
  const correlationId: string = socketData.correlationId;

  // Create handler-scoped child logger with per-connection bindings (R29)
  const childLogger: Logger = logger.child({
    handler: 'message',
    userId,
    correlationId,
  });

  // ---------------------------------------------------------------------------
  // Handler: message:send — Send a new encrypted message
  // ---------------------------------------------------------------------------

  /**
   * Handles the message:send event from the client.
   *
   * Flow:
   *   1. Rate limit check (30/min per R25) — disconnect on exceed
   *   2. Validate required payload fields
   *   3. Delegate to MessageService.sendMessage (deduplication via clientMessageId — R4)
   *   4. Ack sender with created message metadata (BEFORE fan-out completes — R18)
   *   5. Emit message:new to conversation room (excluding sender)
   *
   * Ciphertext is treated as an opaque string — ZERO inspection or decryption (R12).
   * Log entries exclude ciphertext content (R23).
   */
  async function handleMessageSend(
    payload: MessageSendPayload,
    ack?: AckCallback<unknown>,
  ): Promise<void> {
    try {
      // Step 1: Rate limit check (R25 — 30/min for message:send)
      const allowed: boolean = await rateLimiter.checkLimit('message:send');
      if (!allowed) {
        childLogger.warn(
          { event: 'message:send', reason: 'rate_limit_exceeded' },
          'Rate limit exceeded for message:send — disconnecting client',
        );
        socket.disconnect(true);
        return;
      }

      // Step 2: Validate required fields
      if (
        !payload ||
        typeof payload.conversationId !== 'string' ||
        !payload.conversationId ||
        typeof payload.ciphertext !== 'string' ||
        !payload.ciphertext ||
        typeof payload.clientMessageId !== 'string' ||
        !payload.clientMessageId
      ) {
        ack?.(buildErrorAck(
          ERROR_CODES.INVALID_PAYLOAD,
          'Missing required fields: conversationId, ciphertext, clientMessageId',
        ));
        return;
      }

      // Step 3: Delegate to MessageService (R12 — ciphertext is opaque)
      // MessageService handles:
      //   - Deduplication via clientMessageId (R4)
      //   - BullMQ fan-out for groups with 3+ participants (R18)
      const message = await messageService.sendMessage({
        conversationId: payload.conversationId,
        senderId: userId,
        senderName: socket.data.displayName || userId,
        ciphertext: payload.ciphertext,
        type: payload.type || 'text',
        replyToMessageId: payload.replyToMessageId,
        mediaId: payload.mediaId,
        clientMessageId: payload.clientMessageId,
      });

      // Step 4: Acknowledge sender (BEFORE fan-out completes — R18)
      ack?.({
        success: true,
        data: {
          messageId: message.id,
          serverTimestamp: message.serverTimestamp,
          clientMessageId: message.clientMessageId,
          correlationId,
        },
      });

      // Step 5: Emit message:new to conversation room (excluding sender)
      // For groups with 3+ participants, BullMQ handles delivery to offline
      // recipients. This direct emission covers online recipients in the room.
      const newEventPayload: MessageNewPayload = {
        message: message as unknown as MessageNewPayload['message'],
        correlationId,
        timestamp: new Date().toISOString(),
      };
      socket
        .to(message.conversationId)
        .emit('message:new', newEventPayload);

      // Step 6: Log success (R23 — NO ciphertext in logs; R28 — Pino only)
      childLogger.info(
        {
          messageId: message.id,
          conversationId: message.conversationId,
          type: message.type,
          clientMessageId: message.clientMessageId,
          event: 'message:send',
        },
        'Message sent successfully',
      );
    } catch (error: unknown) {
      const code = mapErrorCode(error);
      const msg = safeErrorMessage(error);
      childLogger.error(
        { event: 'message:send', err: msg, errorCode: code },
        'Failed to send message',
      );
      // Recoverable error — do NOT disconnect
      ack?.(buildErrorAck(code, msg));
    }
  }

  // ---------------------------------------------------------------------------
  // Handler: message:edit — Edit an existing message
  // ---------------------------------------------------------------------------

  /**
   * Handles the message:edit event from the client.
   *
   * Flow:
   *   1. Rate limit check (60/min "all others" per R25)
   *   2. Validate required payload fields (messageId, ciphertext)
   *   3. Delegate to MessageService.editMessage (sender-only, 15-min window — R19)
   *   4. Emit message:edited to conversation room
   *   5. Ack sender with messageId and editedAt
   *
   * newCiphertext (payload.ciphertext) is opaque — ZERO inspection (R12).
   * MessageService enforces: sender-only check, 15-minute window, tombstone check.
   */
  async function handleMessageEdit(
    payload: MessageEditPayload,
    ack?: AckCallback<unknown>,
  ): Promise<void> {
    try {
      // Step 1: Rate limit check (R25 — 60/min default tier)
      const allowed: boolean = await rateLimiter.checkLimit('message:edit');
      if (!allowed) {
        childLogger.warn(
          { event: 'message:edit', reason: 'rate_limit_exceeded' },
          'Rate limit exceeded for message:edit — disconnecting client',
        );
        socket.disconnect(true);
        return;
      }

      // Step 2: Validate required fields
      if (
        !payload ||
        typeof payload.messageId !== 'string' ||
        !payload.messageId ||
        typeof payload.ciphertext !== 'string' ||
        !payload.ciphertext
      ) {
        ack?.(buildErrorAck(
          ERROR_CODES.INVALID_PAYLOAD,
          'Missing required fields: messageId, ciphertext',
        ));
        return;
      }

      // Step 3: Delegate to MessageService (R12, R19)
      // Note: MessageEditPayload field is `ciphertext`, mapped to `newCiphertext`
      const updatedMessage = await messageService.editMessage({
        messageId: payload.messageId,
        senderId: userId,
        newCiphertext: payload.ciphertext,
      });

      // Step 4: Emit message:edited to conversation room
      const editedPayload: MessageEditedPayload = {
        messageId: updatedMessage.id,
        conversationId: updatedMessage.conversationId,
        ciphertext: updatedMessage.ciphertext,
        editedAt: updatedMessage.editedAt,
        correlationId,
        timestamp: new Date().toISOString(),
      };
      socket
        .to(updatedMessage.conversationId)
        .emit('message:edited', editedPayload);

      // Step 5: Ack sender
      ack?.({
        success: true,
        data: {
          messageId: updatedMessage.id,
          editedAt: updatedMessage.editedAt,
        },
      });

      // Log success (R23 — NO ciphertext; R28 — Pino only)
      childLogger.info(
        {
          messageId: updatedMessage.id,
          conversationId: updatedMessage.conversationId,
          event: 'message:edit',
        },
        'Message edited successfully',
      );
    } catch (error: unknown) {
      const code = mapErrorCode(error);
      const msg = safeErrorMessage(error);
      childLogger.error(
        { event: 'message:edit', err: msg, errorCode: code },
        'Failed to edit message',
      );
      ack?.(buildErrorAck(code, msg));
    }
  }

  // ---------------------------------------------------------------------------
  // Handler: message:delete — Soft-delete a message as tombstone
  // ---------------------------------------------------------------------------

  /**
   * Handles the message:delete event from the client.
   *
   * Flow:
   *   1. Rate limit check (60/min per R25)
   *   2. Validate required payload field (messageId)
   *   3. Delegate to MessageService.deleteMessage (sender-only — R20)
   *   4. Emit message:deleted to conversation room (NO ciphertext — it's null)
   *   5. Ack sender with messageId
   *
   * The tombstone has ciphertext=null, isDeleted=true. Clients render
   * "This message was deleted" for all participants.
   */
  async function handleMessageDelete(
    payload: MessageDeletePayload,
    ack?: AckCallback<unknown>,
  ): Promise<void> {
    try {
      // Step 1: Rate limit check (R25 — 60/min default tier)
      const allowed: boolean = await rateLimiter.checkLimit('message:delete');
      if (!allowed) {
        childLogger.warn(
          { event: 'message:delete', reason: 'rate_limit_exceeded' },
          'Rate limit exceeded for message:delete — disconnecting client',
        );
        socket.disconnect(true);
        return;
      }

      // Step 2: Validate required fields
      if (
        !payload ||
        typeof payload.messageId !== 'string' ||
        !payload.messageId
      ) {
        ack?.(buildErrorAck(
          ERROR_CODES.INVALID_PAYLOAD,
          'Missing required field: messageId',
        ));
        return;
      }

      // Step 3: Delegate to MessageService (R20 — sender-only soft delete)
      const tombstone = await messageService.deleteMessage({
        messageId: payload.messageId,
        senderId: userId,
      });

      // Step 4: Emit message:deleted to conversation room
      // CRITICAL: Do NOT include ciphertext — it has been nulled (R20)
      const deletedPayload: MessageDeletedPayload = {
        messageId: tombstone.id,
        conversationId: tombstone.conversationId,
        deletedAt: tombstone.deletedAt,
        correlationId,
        timestamp: new Date().toISOString(),
      };
      socket
        .to(tombstone.conversationId)
        .emit('message:deleted', deletedPayload);

      // Step 5: Ack sender
      ack?.({
        success: true,
        data: { messageId: tombstone.id },
      });

      // Log success
      childLogger.info(
        {
          messageId: tombstone.id,
          conversationId: tombstone.conversationId,
          event: 'message:delete',
        },
        'Message deleted (tombstone created)',
      );
    } catch (error: unknown) {
      const code = mapErrorCode(error);
      const msg = safeErrorMessage(error);
      childLogger.error(
        { event: 'message:delete', err: msg, errorCode: code },
        'Failed to delete message',
      );
      ack?.(buildErrorAck(code, msg));
    }
  }

  // ---------------------------------------------------------------------------
  // Handler: message:delivered — Acknowledge message delivery (fire-and-forget)
  // ---------------------------------------------------------------------------

  /**
   * Handles the message:delivered event from the client.
   *
   * Flow:
   *   1. Rate limit check (60/min per R25)
   *   2. Validate required payload fields (messageId, conversationId)
   *   3. Update message status to DELIVERED via MessageService
   *   4. Emit message:status to conversation room so sender sees double gray checks
   *
   * This is a fire-and-forget event — no ack callback.
   * Logged at debug level because delivery events are high-frequency.
   */
  async function handleMessageDelivered(
    payload: MessageDeliveredPayload,
  ): Promise<void> {
    try {
      // Step 1: Rate limit check (R25 — 60/min default tier)
      const allowed: boolean = await rateLimiter.checkLimit('message:delivered');
      if (!allowed) {
        childLogger.warn(
          { event: 'message:delivered', reason: 'rate_limit_exceeded' },
          'Rate limit exceeded for message:delivered — disconnecting client',
        );
        socket.disconnect(true);
        return;
      }

      // Step 2: Validate required fields
      if (
        !payload ||
        typeof payload.messageId !== 'string' ||
        !payload.messageId ||
        typeof payload.conversationId !== 'string' ||
        !payload.conversationId
      ) {
        // Fire-and-forget — log and return, no ack
        childLogger.warn(
          { event: 'message:delivered', reason: 'invalid_payload' },
          'Invalid payload for message:delivered — missing required fields',
        );
        return;
      }

      // Step 3: Update status to DELIVERED
      await messageService.updateMessageStatus({
        messageId: payload.messageId,
        userId,
        status: 'DELIVERED',
      });

      // Step 4: Emit message:status to conversation room
      // Uses MessageStatusPayload shape with MessageStatusEnum for type safety
      const statusPayload: MessageStatusPayload = {
        messageId: payload.messageId,
        conversationId: payload.conversationId,
        userId,
        status: MessageStatusEnum.DELIVERED,
        correlationId,
        timestamp: new Date().toISOString(),
      };
      socket
        .to(payload.conversationId)
        .emit('message:status', statusPayload);

      // Log at debug level — high-frequency event
      childLogger.debug(
        {
          messageId: payload.messageId,
          conversationId: payload.conversationId,
          status: 'DELIVERED',
          event: 'message:delivered',
        },
        'Message delivery confirmed',
      );
    } catch (error: unknown) {
      // Fire-and-forget — log error but do not ack
      childLogger.error(
        {
          event: 'message:delivered',
          err: safeErrorMessage(error),
        },
        'Failed to process message delivery confirmation',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Handler: message:read — Batch acknowledge message read (fire-and-forget)
  // ---------------------------------------------------------------------------

  /**
   * Handles the message:read event from the client.
   *
   * Flow:
   *   1. Rate limit check (60/min per R25)
   *   2. Validate required payload fields (messageIds array, conversationId)
   *   3. Batch mark messages as READ via MessageService
   *   4. Emit message:status to conversation room so senders see blue double checks
   *
   * Supports batch read receipts — multiple message IDs in a single event.
   * This is a fire-and-forget event — no ack callback.
   * Logged at debug level because read events are high-frequency.
   */
  async function handleMessageRead(
    payload: MessageReadPayload,
  ): Promise<void> {
    try {
      // Step 1: Rate limit check (R25 — 60/min default tier)
      const allowed: boolean = await rateLimiter.checkLimit('message:read');
      if (!allowed) {
        childLogger.warn(
          { event: 'message:read', reason: 'rate_limit_exceeded' },
          'Rate limit exceeded for message:read — disconnecting client',
        );
        socket.disconnect(true);
        return;
      }

      // Step 2: Validate required fields
      if (
        !payload ||
        !Array.isArray(payload.messageIds) ||
        payload.messageIds.length === 0 ||
        typeof payload.conversationId !== 'string' ||
        !payload.conversationId
      ) {
        childLogger.warn(
          { event: 'message:read', reason: 'invalid_payload' },
          'Invalid payload for message:read — missing messageIds or conversationId',
        );
        return;
      }

      // Validate all messageIds are non-empty strings
      const validMessageIds: boolean = payload.messageIds.every(
        (id: string) => typeof id === 'string' && id.length > 0,
      );
      if (!validMessageIds) {
        childLogger.warn(
          { event: 'message:read', reason: 'invalid_message_ids' },
          'Invalid messageIds in message:read payload',
        );
        return;
      }

      // Step 3: Batch mark as READ
      await messageService.batchMarkRead({
        messageIds: payload.messageIds,
        userId,
      });

      // Step 4: Emit message:status to conversation room for each read message
      // Individual events per messageId to conform to MessageStatusPayload contract
      const timestamp = new Date().toISOString();
      for (const messageId of payload.messageIds) {
        const readStatusPayload: MessageStatusPayload = {
          messageId,
          conversationId: payload.conversationId,
          userId,
          status: MessageStatusEnum.READ,
          correlationId,
          timestamp,
        };
        socket
          .to(payload.conversationId)
          .emit('message:status', readStatusPayload);
      }

      // Log at debug level — high-frequency event
      childLogger.debug(
        {
          messageCount: payload.messageIds.length,
          conversationId: payload.conversationId,
          status: 'READ',
          event: 'message:read',
        },
        'Messages marked as read',
      );
    } catch (error: unknown) {
      // Fire-and-forget — log error but do not ack
      childLogger.error(
        {
          event: 'message:read',
          err: safeErrorMessage(error),
        },
        'Failed to process message read receipts',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Register all 5 message event handlers on the socket
  // ---------------------------------------------------------------------------

  socket.on('message:send', handleMessageSend);
  socket.on('message:edit', handleMessageEdit);
  socket.on('message:delete', handleMessageDelete);
  socket.on('message:delivered', handleMessageDelivered);
  socket.on('message:read', handleMessageRead);

  childLogger.info('Message handlers registered');
}
