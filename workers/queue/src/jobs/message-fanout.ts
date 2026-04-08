// =============================================================================
// Kalle — WhatsApp Clone · BullMQ Message Fan-Out Job
// =============================================================================
//
// Group message delivery fan-out processor (Rule R18).
//
// When a message is sent to a group conversation with 3+ participants, the
// API server enqueues a `message-fanout` job instead of delivering
// synchronously. This processor:
//
//   1. Extracts the correlation ID for distributed tracing (Rule R29).
//   2. Queries all conversation participants via Prisma.
//   3. Filters out the original sender (they already have the message).
//   4. Publishes a `message:new` event to each recipient's Redis channel
//      so the Socket.IO Redis adapter routes it to the correct socket.
//   5. Tracks delivery success/failure counts and logs a summary.
//
// On transient failures (database, Redis) the function re-throws so that
// BullMQ applies its retry policy (3 attempts, exponential backoff
// 1 s → 4 s → 16 s).
//
// Critical Rules:
//   R4  — Messages arrive in send-order with zero drops or duplicates.
//   R7  — Zero warnings build; strict TypeScript; no `any` types.
//   R12 — Server stores only ciphertext. Zero decryption logic here.
//   R18 — Delivery to 3+ recipients goes through BullMQ.
//   R23 — Logs must NOT contain ciphertext, encryption keys, tokens, or
//          plaintext message content.
//   R28 — ALL logging via Pino JSON output. Zero console.log.
//   R29 — Correlation ID in every log entry via Pino child logger.
//
// =============================================================================

import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';

// =============================================================================
// Interfaces
// =============================================================================

/**
 * Payload carried by the `message-fanout` BullMQ job.
 *
 * Published by the API server's message service when a group conversation
 * has 3+ participants. The `message` field contains the full
 * {@link MessageNewPayloadMessage} shape needed by the client (minus any
 * plaintext — only ciphertext is present per Rule R12).
 */
interface MessageFanoutPayload {
  /** UUID v4 for end-to-end request tracing (Rule R29). */
  correlationId: string;

  /** Primary key of the persisted message record. */
  messageId: string;

  /** Conversation this message belongs to. */
  conversationId: string;

  /** User ID of the message sender (excluded from delivery targets). */
  senderId: string;

  /**
   * Full message shape for the `message:new` WebSocket event.
   *
   * The API server constructs this from the persisted message entity so
   * the worker does not need to re-query the message from the database.
   * The `ciphertext` field is present but MUST NOT be logged (Rule R23).
   */
  message: MessageNewPayloadMessage;
}

/**
 * Shape of the message object embedded in the fan-out payload.
 *
 * Mirrors the `MessageResponse` interface from `@kalle/shared` — defined
 * locally to avoid runtime coupling to the shared package within the
 * worker process (the shared package may not be resolvable at runtime
 * depending on the Docker build path).
 */
interface MessageNewPayloadMessage {
  /** UUID of the message record. */
  id: string;

  /** Conversation this message belongs to. */
  conversationId: string;

  /** User ID of the sender. */
  senderId: string;

  /** Display name of the sender (for notification rendering). */
  senderName: string;

  /** Avatar URL of the sender; may be absent. */
  senderAvatar?: string;

  /** Base64-encoded Signal Protocol ciphertext (R12). NEVER logged. */
  ciphertext: string;

  /** Content type discriminator (TEXT, IMAGE, VIDEO, DOCUMENT, VOICE_NOTE). */
  type: string;

  /** ID of the message being replied to; absent for non-reply messages. */
  replyToMessageId?: string;

  /** ID of the attached encrypted media; absent for text-only messages. */
  mediaId?: string;

  /** Client-generated UUID for idempotency (Rule R4). */
  clientMessageId: string;

  /** ISO 8601 server-assigned timestamp — authoritative message ordering. */
  serverTimestamp: string;

  /** ISO 8601 creation timestamp. */
  createdAt: string;

  /** ISO 8601 last-modification timestamp. */
  updatedAt: string;

  /** Whether the message has been edited (Rule R19). */
  isEdited: boolean;

  /** Whether the message has been soft-deleted / tombstoned (Rule R20). */
  isDeleted: boolean;
}

/**
 * Shared worker execution context injected by the parent worker bootstrap
 * (`workers/queue/src/index.ts`).
 *
 * Defined locally to avoid circular imports — mirrors the exported
 * `WorkerContext` interface from `index.ts`.
 */
interface WorkerContext {
  /** Prisma ORM client for database access. */
  prisma: PrismaClient;

  /** Root Pino logger instance — child logger created per job. */
  logger: Logger;

  /** IORedis connection used for pub/sub event emission. */
  redisConnection: RedisPublisher;
}

/**
 * Minimal Redis publish contract.
 *
 * Avoids importing `ioredis` directly — the actual IORedis instance
 * satisfies this interface at runtime. Keeps the file decoupled from
 * the concrete Redis client implementation.
 */
interface RedisPublisher {
  publish(channel: string, message: string): Promise<number>;
}

/**
 * Shape of the WebSocket event published via Redis pub/sub.
 *
 * The API server's Socket.IO Redis adapter subscribes to per-user
 * channels and emits `message:new` events to the correct connected
 * socket(s).
 */
interface MessageNewEvent {
  /** WebSocket event name for client-side routing. */
  event: 'message:new';

  /** Full message payload forwarded to the recipient. */
  message: MessageNewPayloadMessage;

  /** Correlation ID propagated for distributed tracing (Rule R29). */
  correlationId: string;

  /** ISO 8601 timestamp when the event was published. */
  timestamp: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Redis channel prefix for per-user message delivery events.
 *
 * The Socket.IO Redis adapter on the API server subscribes to channels
 * matching this prefix and emits `message:new` events to the correct
 * connected client socket.
 *
 * Channel format: `user:message:<userId>`
 */
const USER_MESSAGE_CHANNEL_PREFIX = 'user:message:';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Publishes a {@link MessageNewEvent} to a single recipient's Redis
 * pub/sub channel.
 *
 * @param redis      - Redis connection with publish capability.
 * @param userId     - Target recipient user ID.
 * @param event      - Serialised event payload.
 * @param logger     - Pino child logger for structured logging.
 * @returns `true` when the publish succeeded, `false` otherwise.
 */
async function publishToUser(
  redis: RedisPublisher,
  userId: string,
  serializedEvent: string,
  logger: Logger,
): Promise<boolean> {
  const channel = `${USER_MESSAGE_CHANNEL_PREFIX}${userId}`;
  try {
    await redis.publish(channel, serializedEvent);
    return true;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Log per-recipient failure but do NOT include sensitive data (R23).
    logger.warn(
      { userId, error: errorMessage },
      'Failed to publish message:new event to user channel',
    );
    return false;
  }
}

// =============================================================================
// Exported Job Processor
// =============================================================================

/**
 * BullMQ job processor for group message delivery fan-out.
 *
 * Execution flow:
 *   1. Validate and extract payload fields.
 *   2. Query conversation participants from Prisma.
 *   3. Filter out the sender from the recipient list.
 *   4. Build and serialise the `message:new` WebSocket event.
 *   5. Publish the event to each recipient's Redis channel.
 *   6. Log a summary with recipient count, success/failure counts,
 *      and total duration.
 *
 * Edge cases handled:
 *   - Empty participant list → warn and return.
 *   - Sender is the only participant → info and return.
 *   - Individual delivery failure → continue with remaining recipients
 *     (partial delivery is preferable to total failure).
 *   - Database/Redis connection errors → re-throw for BullMQ retry.
 *
 * @param job     BullMQ Job carrying {@link MessageFanoutPayload}.
 * @param context Worker context (Prisma, Pino logger, Redis).
 */
export async function processMessageFanout(
  job: Job<MessageFanoutPayload>,
  context: WorkerContext,
): Promise<void> {
  const { correlationId, conversationId, senderId, message } = job.data;

  // Create a child logger enriched with tracing metadata (Rule R29).
  const logger: Logger = context.logger.child({
    correlationId,
    jobId: job.id,
    jobName: 'message-fanout',
    conversationId,
  });

  const startTime: number = Date.now();

  // Log job start — messageId is safe metadata, NOT sensitive content.
  logger.info({ messageId: message.id }, 'Starting message fan-out');

  try {
    // -----------------------------------------------------------------
    // 1. Query all conversation participants
    // -----------------------------------------------------------------
    const participants = await context.prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });

    // Edge case: conversation has no participants (orphaned / deleted).
    if (participants.length === 0) {
      logger.warn(
        { messageId: message.id },
        'No participants found for conversation — skipping fan-out',
      );
      return;
    }

    // -----------------------------------------------------------------
    // 2. Filter out the sender — they already have the message
    // -----------------------------------------------------------------
    const recipientIds: string[] = participants
      .filter((p) => p.userId !== senderId)
      .map((p) => p.userId);

    // Edge case: sender is the only member of the group.
    if (recipientIds.length === 0) {
      logger.info(
        { messageId: message.id, participantCount: participants.length },
        'No recipients for fan-out — sender is the only participant',
      );
      return;
    }

    logger.info(
      { recipientCount: recipientIds.length },
      'Found recipients for fan-out',
    );

    // -----------------------------------------------------------------
    // 3. Build the WebSocket event payload
    // -----------------------------------------------------------------
    const event: MessageNewEvent = {
      event: 'message:new',
      message,
      correlationId,
      timestamp: new Date().toISOString(),
    };

    const serializedEvent: string = JSON.stringify(event);

    // -----------------------------------------------------------------
    // 4. Publish to each recipient via Redis pub/sub
    // -----------------------------------------------------------------
    let successCount = 0;
    let failureCount = 0;

    for (const recipientId of recipientIds) {
      const ok = await publishToUser(
        context.redisConnection,
        recipientId,
        serializedEvent,
        logger,
      );
      if (ok) {
        successCount++;
      } else {
        failureCount++;
      }
    }

    // -----------------------------------------------------------------
    // 5. Log completion summary
    // -----------------------------------------------------------------
    const durationMs: number = Date.now() - startTime;

    logger.info(
      {
        messageId: message.id,
        recipientCount: recipientIds.length,
        successCount,
        failureCount,
        durationMs,
      },
      'Message fan-out completed',
    );

    // If ALL deliveries failed, treat as a retryable error so BullMQ
    // can attempt the entire fan-out again on the next retry.
    if (successCount === 0 && recipientIds.length > 0) {
      throw new Error(
        `All ${recipientIds.length} fan-out deliveries failed — ` +
          'triggering BullMQ retry',
      );
    }
  } catch (err: unknown) {
    const durationMs: number = Date.now() - startTime;
    const error: Error = err instanceof Error ? err : new Error(String(err));

    // Sanitised error logging — no ciphertext, no keys, no tokens (R23).
    logger.error(
      { error: error.message, messageId: job.data.messageId, durationMs },
      'Message fan-out failed',
    );

    // Re-throw for BullMQ retry policy (3 attempts, exponential backoff).
    throw error;
  }
}
