/**
 * @file sync-handler.ts
 * @module apps/api/src/websocket/handlers/sync-handler
 *
 * WebSocket handler for offline-to-online message synchronization (R13).
 *
 * When a client reconnects after being offline, it sends a `message:sync` event
 * with `lastMessageIds` — a map of `{ conversationId: lastKnownMessageId }`.
 * The server returns all missed messages per conversation, ordered by
 * serverTimestamp ascending (R4), within a 3-second target window (R13).
 *
 * Architecture rules applied:
 *   R4  — Real-Time Message Integrity: messages in serverTimestamp order, zero duplicates
 *   R7  — Zero Warnings Build: TypeScript strict mode, zero warnings
 *   R12 — E2E Encryption Integrity: ciphertext is opaque, zero decryption logic
 *   R13 — Offline Reconciliation: sync within 3 seconds, all missed messages in order
 *   R17 — Interface-Driven Dependencies: all deps via function parameters
 *   R23 — Log Hygiene: no ciphertext, keys, or tokens in logs
 *   R25 — WebSocket Rate Limiting: message:sync under "all others" 60/min
 *   R28 — Structured Logging Only: zero console.log calls, Pino JSON only
 *   R29 — Correlation ID Propagation: every log entry includes correlationId
 */

import type { Socket } from 'socket.io';
import type { Logger } from 'pino';
import type {
  MessageSyncRequestPayload,
  MessageSyncResponsePayload,
  AckCallback,
  SocketData,
} from '@kalle/shared/types/websocket-events';
import type { WsRateLimiter } from '../middleware/ws-rate-limiter';

// =============================================================================
// Constants
// =============================================================================

/** R13: All missed messages must arrive within 3 seconds of the sync request */
const SYNC_TIMEOUT_MS = 3000;

/** Safety limit to prevent unbounded queries per conversation */
const MAX_SYNC_MESSAGES_PER_CONVERSATION = 500;

/** Safety limit on the number of conversations processed in a single sync */
const MAX_SYNC_CONVERSATIONS = 100;

// =============================================================================
// SyncHandlerDeps Interface
// =============================================================================

/**
 * Dependencies required by the sync handler.
 *
 * All service dependencies are typed inline with only the methods the sync
 * handler uses. This follows R17 — no import of concrete service classes.
 * The actual service instances are injected by index.ts at runtime from the
 * composition root (apps/api/src/server.ts).
 */
export interface SyncHandlerDeps {
  /**
   * Message service — provides sync and history retrieval operations.
   * Only the methods used by this handler are declared here (R17).
   */
  messageService: {
    /**
     * Retrieve messages after a given timestamp for the specified conversations.
     * Returns messages sorted by serverTimestamp ascending (R4).
     */
    syncMessages(params: {
      userId: string;
      conversationIds: string[];
      afterTimestamp: string;
      limit?: number;
    }): Promise<Array<{
      id: string;
      conversationId: string;
      senderId: string;
      ciphertext: string | null;
      type: string;
      serverTimestamp: string;
      isDeleted: boolean;
      isEdited: boolean;
      [key: string]: unknown;
    }>>;

    /**
     * Retrieve paginated message history for a conversation.
     * Available for potential future use in pagination-based sync strategies.
     */
    getMessageHistory(params: {
      conversationId: string;
      userId: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      messages: Array<Record<string, unknown>>;
      cursor?: string;
      hasMore: boolean;
    }>;
  };

  /**
   * Conversation service — provides participant verification.
   * Only the methods used by this handler are declared here (R17).
   */
  conversationService: {
    /**
     * Retrieve conversations the user is a participant in.
     * Used for authorization: verify user belongs to each requested conversation.
     */
    getConversations(params: {
      userId: string;
      limit?: number;
    }): Promise<Array<{ id: string; [key: string]: unknown }>>;
  };

  /**
   * Per-connection WebSocket rate limiter (R25).
   * message:sync falls under the "all others" 60/min tier.
   */
  rateLimiter: WsRateLimiter;

  /**
   * Structured JSON logger (R28) with correlation ID propagation (R29).
   * A child logger is created with handler-scoped bindings.
   */
  logger: Logger;
}

// =============================================================================
// Sync Message Result Type
// =============================================================================

/**
 * Internal type alias for the message objects returned by syncMessages.
 * At runtime these are full MessageResponse objects from the service layer;
 * the handler types only the subset it inspects directly (R17).
 */
type SyncMessageResult = {
  id: string;
  conversationId: string;
  senderId: string;
  ciphertext: string | null;
  type: string;
  serverTimestamp: string;
  isDeleted: boolean;
  isEdited: boolean;
  [key: string]: unknown;
};

// =============================================================================
// Handler Registration
// =============================================================================

/**
 * Registers the `message:sync` WebSocket event handler on the given socket.
 *
 * This function is called once per authenticated socket connection by the
 * WebSocket index.ts module. It registers a single event handler that
 * processes offline-to-online sync requests.
 *
 * @param socket - Authenticated Socket.IO connection with userId and correlationId
 *                 populated in socket.data by the ws-auth middleware
 * @param deps   - Injected dependencies (R17: interface-driven, no concrete imports)
 */
export function registerSyncHandlers(
  socket: Socket,
  deps: SyncHandlerDeps,
): void {
  const { messageService, conversationService, rateLimiter, logger } = deps;

  // Extract authenticated user context from socket.data (set by ws-auth middleware)
  const socketData = socket.data as SocketData;
  const userId: string = socketData.userId;
  const correlationId: string = socketData.correlationId;

  // Create child logger with handler-scoped bindings (R29: correlationId in every log)
  const childLogger: Logger = logger.child({
    handler: 'sync',
    userId,
    correlationId,
  });

  /**
   * `message:sync` event handler — offline reconciliation (R13).
   *
   * Uses the Socket.IO acknowledgement callback pattern for request-response:
   * the client emits `message:sync` with lastMessageIds and receives the
   * response (missed messages) via the ack callback.
   *
   * Flow:
   * 1. Rate limit check (R25)
   * 2. Payload validation
   * 3. Conversation count safety limit
   * 4. Participant authorization check
   * 5. Parallel fetch of missed messages per conversation
   * 6. Flatten, sort (R4), deduplicate
   * 7. Send response via ack
   * 8. Performance logging (warn if > 3s per R13)
   */
  socket.on(
    'message:sync',
    async (
      payload: MessageSyncRequestPayload,
      ack?: AckCallback<MessageSyncResponsePayload>,
    ): Promise<void> => {
      const startTime: number = Date.now();

      try {
        // ---------------------------------------------------------------
        // Step 1: Rate limit check (R25 — "all others" 60/min)
        // ---------------------------------------------------------------
        const withinLimit: boolean = await rateLimiter.checkLimit('message:sync');
        if (!withinLimit) {
          childLogger.warn(
            { event: 'message:sync' },
            'Rate limit exceeded for message:sync — disconnecting client',
          );
          socket.disconnect(true);
          return;
        }

        // ---------------------------------------------------------------
        // Step 2: Validate payload
        // ---------------------------------------------------------------
        if (
          !payload ||
          typeof payload !== 'object' ||
          !payload.lastMessageIds ||
          typeof payload.lastMessageIds !== 'object' ||
          Array.isArray(payload.lastMessageIds)
        ) {
          ack?.({
            success: false,
            error: {
              code: 'INVALID_PAYLOAD',
              message: 'lastMessageIds is required and must be a non-null object',
            },
          });
          return;
        }

        const requestedConversationIds: string[] = Object.keys(payload.lastMessageIds);

        // ---------------------------------------------------------------
        // Step 3: Handle empty sync request
        // ---------------------------------------------------------------
        if (requestedConversationIds.length === 0) {
          const emptyResponse: MessageSyncResponsePayload = {
            messages: [],
            hasMore: false,
            correlationId,
            timestamp: new Date().toISOString(),
          };
          ack?.({ success: true, data: emptyResponse });

          const duration: number = Date.now() - startTime;
          childLogger.info(
            {
              conversationCount: 0,
              totalMessages: 0,
              durationMs: duration,
              event: 'message:sync',
            },
            'Sync completed (empty request)',
          );
          return;
        }

        // ---------------------------------------------------------------
        // Step 4: Limit conversation count (safety)
        // ---------------------------------------------------------------
        let conversationIds: string[] = requestedConversationIds;
        if (conversationIds.length > MAX_SYNC_CONVERSATIONS) {
          childLogger.warn(
            {
              requestedCount: conversationIds.length,
              maxAllowed: MAX_SYNC_CONVERSATIONS,
              event: 'message:sync',
            },
            'Sync request exceeds max conversation limit — truncating',
          );
          conversationIds = conversationIds.slice(0, MAX_SYNC_CONVERSATIONS);
        }

        // ---------------------------------------------------------------
        // Step 5: Verify user is a participant (authorization)
        // ---------------------------------------------------------------
        const userConversations = await conversationService.getConversations({
          userId,
          limit: 1000,
        });
        const validConversationIds: Set<string> = new Set(
          userConversations.map((c) => c.id),
        );

        const filteredConversationIds: string[] = conversationIds.filter(
          (convId: string): boolean => {
            if (!validConversationIds.has(convId)) {
              childLogger.debug(
                { conversationId: convId, event: 'message:sync' },
                'Filtered out conversation — user is not a participant',
              );
              return false;
            }
            return true;
          },
        );

        // All requested conversations were filtered out
        if (filteredConversationIds.length === 0) {
          const emptyResponse: MessageSyncResponsePayload = {
            messages: [],
            hasMore: false,
            correlationId,
            timestamp: new Date().toISOString(),
          };
          ack?.({ success: true, data: emptyResponse });

          const duration: number = Date.now() - startTime;
          childLogger.info(
            {
              conversationCount: 0,
              totalMessages: 0,
              durationMs: duration,
              event: 'message:sync',
            },
            'Sync completed (no valid conversations after authorization check)',
          );
          return;
        }

        // ---------------------------------------------------------------
        // Step 6: Fetch missed messages in parallel per conversation
        // ---------------------------------------------------------------
        const syncPromises: Array<Promise<SyncMessageResult[]>> =
          filteredConversationIds.map(
            (convId: string): Promise<SyncMessageResult[]> =>
              messageService.syncMessages({
                userId,
                conversationIds: [convId],
                afterTimestamp: payload.lastMessageIds[convId],
                limit: MAX_SYNC_MESSAGES_PER_CONVERSATION,
              }),
          );

        const syncResults: SyncMessageResult[][] = await Promise.all(syncPromises);

        // ---------------------------------------------------------------
        // Step 7: Flatten, sort, and deduplicate (R4)
        // ---------------------------------------------------------------
        const allMessages: SyncMessageResult[] = [];
        let hasMore = false;

        for (let i = 0; i < syncResults.length; i++) {
          const conversationMessages: SyncMessageResult[] = syncResults[i];

          // If a conversation returned the max limit, there may be more
          if (conversationMessages.length >= MAX_SYNC_MESSAGES_PER_CONVERSATION) {
            hasMore = true;
          }

          for (const msg of conversationMessages) {
            allMessages.push(msg);
          }
        }

        // Sort by serverTimestamp ascending — strict chronological order (R4)
        allMessages.sort(
          (a: SyncMessageResult, b: SyncMessageResult): number => {
            if (a.serverTimestamp < b.serverTimestamp) return -1;
            if (a.serverTimestamp > b.serverTimestamp) return 1;
            return 0;
          },
        );

        // Deduplicate by message ID — zero duplicates (R4)
        const seenMessageIds: Set<string> = new Set();
        const uniqueMessages: SyncMessageResult[] = allMessages.filter(
          (msg: SyncMessageResult): boolean => {
            if (seenMessageIds.has(msg.id)) {
              return false;
            }
            seenMessageIds.add(msg.id);
            return true;
          },
        );

        const totalMessages: number = uniqueMessages.length;

        // ---------------------------------------------------------------
        // Step 8: Build and send response via ack callback (R13)
        // ---------------------------------------------------------------
        // The service returns full MessageResponse objects at runtime.
        // Our inline type captures the subset we inspect; the cast bridges
        // the gap between the minimal handler type and the shared response type.
        const responsePayload: MessageSyncResponsePayload = {
          messages: uniqueMessages as unknown as MessageSyncResponsePayload['messages'],
          hasMore,
          correlationId,
          timestamp: new Date().toISOString(),
        };

        ack?.({ success: true, data: responsePayload });

        // ---------------------------------------------------------------
        // Step 9: Performance logging
        // ---------------------------------------------------------------
        const duration: number = Date.now() - startTime;

        childLogger.info(
          {
            conversationCount: filteredConversationIds.length,
            totalMessages,
            durationMs: duration,
            hasMore,
            event: 'message:sync',
          },
          'Sync completed',
        );

        // Warn if sync exceeded the 3-second target (R13)
        if (duration > SYNC_TIMEOUT_MS) {
          childLogger.warn(
            {
              durationMs: duration,
              conversationCount: filteredConversationIds.length,
              totalMessages,
              event: 'message:sync',
            },
            'Sync exceeded 3-second target',
          );
        }
      } catch (err: unknown) {
        // ---------------------------------------------------------------
        // Error handling — sync errors are recoverable (do NOT disconnect)
        // ---------------------------------------------------------------
        childLogger.error(
          { err, event: 'message:sync' },
          'Error processing message sync',
        );

        ack?.({
          success: false,
          error: {
            code: 'SYNC_ERROR',
            message: 'Failed to sync messages',
          },
        });
      }
    },
  );
}
