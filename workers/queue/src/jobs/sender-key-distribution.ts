// =============================================================================
// Kalle — WhatsApp Clone · Sender Key Distribution/Rotation Job
// =============================================================================
//
// BullMQ job processor for Sender Key distribution and rotation in group
// conversations. Implements forward/backward secrecy for group E2E encryption
// per Rule R14 (Signal Protocol Sender Keys).
//
// Trigger scenarios:
//   member_removed  → Forward secrecy: rotate Sender Keys so removed member
//                     cannot decrypt future messages.
//   member_added    → Backward secrecy: distribute existing Sender Keys to the
//                     new member (they still cannot decrypt past messages).
//   key_compromised → Full rotation: all members generate new Sender Keys.
//
// Critical rules enforced:
//   R12 — Server stores only ciphertext. Zero decryption logic here.
//   R14 — Sender Keys with rotation on membership change.
//   R18 — Sender Key distribution goes through BullMQ.
//   R23 — Logs must NOT contain encryption keys, prekey material, or Sender
//          Key distribution messages.
//   R28 — ALL logging via Pino (zero console.log/warn/error).
//   R29 — Correlation ID propagated via Pino child logger.
//
// =============================================================================

import { Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';

// =============================================================================
// Types
// =============================================================================

/**
 * Reason a Sender Key distribution/rotation was triggered.
 *
 * - `member_removed`  — A member left or was removed from the group.
 * - `member_added`    — A new member was added to the group.
 * - `key_compromised` — Key material is suspected compromised; full rotation.
 */
type SenderKeyDistributionReason =
  | 'member_removed'
  | 'member_added'
  | 'key_compromised';

/**
 * Payload carried by a `sender-key-distribution` BullMQ job.
 */
interface SenderKeyDistributionPayload {
  /** UUID v4 correlation ID for distributed tracing (Rule R29). */
  correlationId: string;
  /** Conversation (group) ID that requires key distribution. */
  groupId: string;
  /** Why the distribution was triggered. */
  reason: SenderKeyDistributionReason;
  /** User ID of the removed member (set when reason is 'member_removed'). */
  removedUserId?: string;
  /** User ID of the added member (set when reason is 'member_added'). */
  addedUserId?: string;
  /** User ID that initiated the membership change. */
  initiatorId: string;
}

/**
 * Event published to Redis pub/sub for Socket.IO adapter pickup.
 * Each connected client receives this and performs the appropriate
 * cryptographic operation (generate / distribute Sender Key).
 */
interface SenderKeyEvent {
  /** Discriminator for the client-side handler. */
  type: 'key:rotate' | 'key:distribute';
  /** Group conversation ID. */
  groupId: string;
  /** Why this event was emitted. */
  reason: SenderKeyDistributionReason;
  /** The member that was removed (present for member_removed / key_compromised). */
  removedUserId?: string;
  /** The member that was added (present for member_added). */
  addedUserId?: string;
  /** Correlation ID for end-to-end request tracing. */
  correlationId: string;
  /** ISO 8601 timestamp of when the event was emitted. */
  timestamp: string;
}

/**
 * Context injected by the worker bootstrap (index.ts) into every job
 * processor. Contains shared infrastructure handles.
 */
interface WorkerContext {
  /** Prisma ORM client for database queries. */
  prisma: PrismaClient;
  /** Pino structured logger instance (Rule R28). */
  logger: Logger;
  /** IORedis connection for pub/sub and cache operations. */
  redisConnection: RedisLike;
}

/**
 * Minimal interface for the Redis connection used by this processor.
 * Avoids importing ioredis directly — the concrete type is supplied
 * by the worker bootstrap at runtime.
 */
interface RedisLike {
  publish(channel: string, message: string): Promise<number>;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Redis channel prefix used for per-user Socket.IO adapter events.
 * The Socket.IO Redis adapter listens on `socket.io#/<nsp>#` channels.
 * We publish user-targeted events to a well-known per-user channel.
 */
const USER_CHANNEL_PREFIX = 'user:sender-key:';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Publishes a {@link SenderKeyEvent} to every target user via Redis pub/sub.
 * Each event is published to a per-user channel so that the Socket.IO Redis
 * adapter on the API server can route it to the correct connected socket.
 *
 * @param redis   - Redis connection with publish capability.
 * @param userIds - Array of user IDs to notify.
 * @param event   - The Sender Key event payload.
 * @param logger  - Pino child logger for structured logging.
 * @returns The number of events successfully published.
 */
async function publishToUsers(
  redis: RedisLike,
  userIds: readonly string[],
  event: SenderKeyEvent,
  logger: Logger,
): Promise<number> {
  const serialized = JSON.stringify(event);
  let successCount = 0;

  for (const userId of userIds) {
    try {
      const channel = `${USER_CHANNEL_PREFIX}${userId}`;
      await redis.publish(channel, serialized);
      successCount += 1;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Log publish failure per-user but continue — partial delivery is
      // preferable to total failure (BullMQ retry handles transient issues).
      logger.warn(
        { userId, error: message },
        'Failed to publish Sender Key event to user channel',
      );
    }
  }

  return successCount;
}

// =============================================================================
// Processor — exported
// =============================================================================

/**
 * Processes a `sender-key-distribution` BullMQ job.
 *
 * Depending on the {@link SenderKeyDistributionPayload.reason}, this
 * processor:
 *
 * 1. Queries the current group participants from the database.
 * 2. Publishes the appropriate `key:rotate` or `key:distribute` event to
 *    each target user via Redis pub/sub.
 * 3. The connected client (via Socket.IO) reacts by generating and/or
 *    distributing Sender Keys through the key exchange REST API.
 *
 * The server NEVER handles plaintext key material — all cryptographic
 * operations happen on the client (Rule R12).
 *
 * @param job     - BullMQ Job instance carrying the distribution payload.
 * @param context - Shared worker context (prisma, logger, redis).
 * @throws Re-throws errors for BullMQ retry (3 attempts, exponential backoff).
 */
export async function processSenderKeyDistribution(
  job: Job<SenderKeyDistributionPayload>,
  context: WorkerContext,
): Promise<void> {
  const startTime = Date.now();

  const {
    correlationId,
    groupId,
    reason,
    removedUserId,
    addedUserId,
    initiatorId,
  } = job.data;

  // Create a child logger scoped to this job (Rule R29 — correlation ID).
  const logger = context.logger.child({
    correlationId,
    jobId: job.id,
    groupId,
  });

  logger.info({ reason, initiatorId }, 'Starting Sender Key distribution');

  try {
    // ------------------------------------------------------------------
    // 1. Validate the group conversation exists
    // ------------------------------------------------------------------
    const conversation = await context.prisma.conversation.findUnique({
      where: { id: groupId },
      select: { id: true, type: true },
    });

    if (!conversation) {
      logger.error({ groupId }, 'Group conversation not found');
      throw new Error(`Group conversation ${groupId} not found`);
    }

    if (conversation.type !== 'GROUP') {
      logger.warn(
        { groupId, type: conversation.type },
        'Sender Key distribution only applies to GROUP conversations — skipping',
      );
      return;
    }

    // ------------------------------------------------------------------
    // 2. Query current group participants
    // ------------------------------------------------------------------
    const participants =
      await context.prisma.conversationParticipant.findMany({
        where: { conversationId: groupId },
        select: { userId: true },
      });

    const currentMemberIds = participants.map((p) => p.userId);

    if (currentMemberIds.length === 0) {
      logger.warn('Group has no participants — skipping distribution');
      return;
    }

    // ------------------------------------------------------------------
    // 3. Dispatch based on reason
    // ------------------------------------------------------------------
    let distributionCount = 0;
    const timestamp = new Date().toISOString();

    switch (reason) {
      // ----------------------------------------------------------------
      // MEMBER REMOVED — Forward Secrecy (Rule R14)
      // ----------------------------------------------------------------
      case 'member_removed': {
        if (!removedUserId) {
          logger.error(
            'removedUserId is required for member_removed reason',
          );
          throw new Error(
            'removedUserId is required for member_removed reason',
          );
        }

        // Idempotency: if the user was already removed from participants,
        // we still proceed with rotation for remaining members. The
        // membership change has already been committed by the API server.
        const remainingIds = currentMemberIds.filter(
          (id) => id !== removedUserId,
        );

        if (remainingIds.length === 0) {
          logger.warn(
            { removedUserId },
            'No remaining members after removal — rotation event still sent',
          );
        }

        // Notify ALL remaining members to rotate their Sender Keys.
        // The removed user is explicitly excluded — forward secrecy.
        const rotateEvent: SenderKeyEvent = {
          type: 'key:rotate',
          groupId,
          reason,
          removedUserId,
          correlationId,
          timestamp,
        };

        distributionCount = await publishToUsers(
          context.redisConnection,
          remainingIds,
          rotateEvent,
          logger,
        );

        logger.info(
          {
            removedUserId,
            remainingCount: remainingIds.length,
            distributionCount,
          },
          'Sender Key rotation triggered for member removal',
        );
        break;
      }

      // ----------------------------------------------------------------
      // MEMBER ADDED — Backward Secrecy (Rule R14)
      // ----------------------------------------------------------------
      case 'member_added': {
        if (!addedUserId) {
          logger.error(
            'addedUserId is required for member_added reason',
          );
          throw new Error(
            'addedUserId is required for member_added reason',
          );
        }

        // Idempotency: if the user is already a member, skip distribution.
        const isAlreadyMember = currentMemberIds.includes(addedUserId);
        if (!isAlreadyMember) {
          logger.warn(
            { addedUserId },
            'Added user not found in current participants — may have been removed again',
          );
          return;
        }

        // Notify EXISTING members (excluding the newly added one) to
        // distribute their current Sender Key to the new member.
        const existingIds = currentMemberIds.filter(
          (id) => id !== addedUserId,
        );

        const distributeEvent: SenderKeyEvent = {
          type: 'key:distribute',
          groupId,
          reason,
          addedUserId,
          correlationId,
          timestamp,
        };

        distributionCount = await publishToUsers(
          context.redisConnection,
          existingIds,
          distributeEvent,
          logger,
        );

        logger.info(
          {
            addedUserId,
            existingMemberCount: existingIds.length,
            distributionCount,
          },
          'Sender Key distribution triggered for new member',
        );
        break;
      }

      // ----------------------------------------------------------------
      // KEY COMPROMISED — Full Rotation
      // ----------------------------------------------------------------
      case 'key_compromised': {
        // Every member must generate a fresh Sender Key and redistribute.
        logger.warn(
          { groupId, memberCount: currentMemberIds.length },
          'Full Sender Key rotation triggered due to key compromise',
        );

        const compromisedEvent: SenderKeyEvent = {
          type: 'key:rotate',
          groupId,
          reason,
          correlationId,
          timestamp,
        };

        distributionCount = await publishToUsers(
          context.redisConnection,
          currentMemberIds,
          compromisedEvent,
          logger,
        );

        logger.info(
          { memberCount: currentMemberIds.length, distributionCount },
          'Full Sender Key rotation events published',
        );
        break;
      }

      default: {
        // Exhaustiveness check — TypeScript will flag unhandled cases.
        const _exhaustive: never = reason;
        logger.error(
          { reason: _exhaustive },
          'Unknown Sender Key distribution reason',
        );
        throw new Error(`Unknown distribution reason: ${String(reason)}`);
      }
    }

    // ------------------------------------------------------------------
    // 4. Log completion with timing
    // ------------------------------------------------------------------
    const duration = Date.now() - startTime;
    logger.info(
      { reason, distributionCount, duration },
      'Sender Key distribution completed',
    );
  } catch (err: unknown) {
    const duration = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    // Sanitized error logging — no key material (Rule R23).
    logger.error(
      { error: message, groupId, reason, duration },
      'Sender Key distribution failed',
    );

    // Re-throw so BullMQ applies its retry policy
    // (3 attempts, exponential backoff: 1 s → 4 s → 16 s).
    throw err;
  }
}
