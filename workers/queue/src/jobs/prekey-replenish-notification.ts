// =============================================================================
// Kalle — WhatsApp Clone · BullMQ Job: Prekey Replenish Notification
// =============================================================================
//
// Notifies users when their Signal Protocol one-time prekey supply drops below
// the configured threshold. Without available prekeys, new contacts cannot
// establish encrypted sessions via X3DH key agreement.
//
// Triggered when the EncryptionKeyService detects a low prekey count after
// consuming prekeys during session establishment. Emits a `key:replenish`
// WebSocket event to the user's client via Redis pub/sub.
//
// Critical Rules:
//   R12 — Prekeys are essential for Signal Protocol X3DH key agreement
//   R23 — No encryption keys, prekey material, or key IDs in logs
//   R28 — All logging via Pino with JSON output, zero console.log
//   R29 — Correlation ID extracted from job.data, injected into child logger
//   R7  — Zero warnings under tsc --noEmit --strict
// =============================================================================

import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Job payload for the prekey replenish notification job.
 * Enqueued by the EncryptionKeyService when prekey consumption reduces the
 * remaining count below the threshold.
 */
interface PrekeyReplenishPayload {
  /** UUID v4 correlation ID propagated from the originating request (R29). */
  correlationId: string;

  /** UUID of the user whose one-time prekeys are running low. */
  userId: string;

  /** Count of remaining unconsumed one-time prekeys at enqueue time. */
  remainingCount: number;

  /** Optional custom threshold override (defaults to DEFAULT_PREKEY_THRESHOLD). */
  threshold?: number;
}

/**
 * Minimal interface for Redis pub/sub publish capability.
 * Avoids importing the full ioredis package — compatible with any Redis client
 * that exposes a `publish` method returning a Promise.
 */
interface RedisPublisher {
  publish(channel: string, message: string): Promise<number>;
}

/**
 * Execution context provided by the worker bootstrap (index.ts).
 * Contains shared infrastructure clients for database, logging, and Redis.
 */
interface WorkerContext {
  /** Prisma ORM client for database queries. */
  prisma: PrismaClient;

  /** Pino structured logger instance (R28). */
  logger: Logger;

  /**
   * Redis connection (ioredis) for pub/sub event emission.
   * Typed with a minimal publish interface to avoid importing ioredis directly
   * while maintaining strict type safety (no `any`).
   */
  redisConnection: RedisPublisher;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Default threshold for triggering a prekey replenish notification.
 * When the user's remaining one-time prekey count drops below this value,
 * a notification is sent prompting the client to upload a fresh batch.
 *
 * Value of 10 aligns with Signal Protocol best practices — clients should
 * maintain a healthy supply of prekeys to ensure session establishment is
 * never blocked by prekey exhaustion.
 */
const DEFAULT_PREKEY_THRESHOLD = 10;

/**
 * Redis pub/sub channel prefix for per-user WebSocket event delivery.
 * The API server's Socket.IO event bridge subscribes to these channels
 * and routes published messages to the user's connected socket(s).
 *
 * Format: `kalle:user:events:<userId>`
 */
const USER_EVENT_CHANNEL_PREFIX = 'kalle:user:events:';

// -----------------------------------------------------------------------------
// Processor
// -----------------------------------------------------------------------------

/**
 * Processes a prekey replenish notification job.
 *
 * ### Workflow
 * 1. Validates that the user still exists in the database
 * 2. Queries the current prekey count (may have recovered since enqueue)
 * 3. If still below threshold, emits a `key:replenish` WebSocket event
 *    via Redis pub/sub for the API server to forward to the user's socket
 *
 * ### Idempotency
 * Safe to run multiple times for the same user. The client de-duplicates
 * replenish requests and uploads only one batch per cycle. Receiving
 * multiple notifications results in at most one upload.
 *
 * ### Retry Policy
 * Transient errors (Redis/Prisma connection failures) re-throw for BullMQ
 * retry (3 attempts, exponential backoff: 1s → 4s → 16s). Non-retryable
 * conditions (user not found) return without throwing.
 *
 * @param job     - BullMQ job containing the {@link PrekeyReplenishPayload}
 * @param context - Shared worker context (Prisma, Logger, Redis)
 */
export async function processPrekeyReplenishNotification(
  job: Job<PrekeyReplenishPayload>,
  context: WorkerContext,
): Promise<void> {
  const { correlationId, userId, remainingCount } = job.data;
  const threshold = job.data.threshold ?? DEFAULT_PREKEY_THRESHOLD;

  // Create a child logger with per-job correlation context (R29).
  // Every log entry from this job includes correlationId, jobId, and userId.
  const logger = context.logger.child({
    correlationId,
    jobId: job.id,
    userId,
  });

  logger.info(
    { remainingCount, threshold },
    'Processing prekey replenish notification',
  );

  try {
    // -------------------------------------------------------------------------
    // Step 1: Verify user exists in the database
    // -------------------------------------------------------------------------
    // The user may have been deleted between job enqueue and processing.
    // This is a non-retryable condition — we return without throwing.
    const user = await context.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      logger.warn('User not found, skipping prekey replenish notification');
      return;
    }

    // -------------------------------------------------------------------------
    // Step 2: Query current prekey count from database
    // -------------------------------------------------------------------------
    // The PreKeyBundle model stores one bundle per user (userId is @unique).
    // The `preKeys` field is a JSON array of { keyId: number, publicKey: string }
    // objects representing unconsumed one-time prekeys. We count the array
    // length to determine the current remaining supply.
    //
    // Note: The count may differ from `remainingCount` in the job payload
    // because prekeys may have been consumed or replenished between enqueue
    // and processing. Always use the fresh count for the decision.
    const bundle = await context.prisma.preKeyBundle.findUnique({
      where: { userId },
      select: { preKeys: true },
    });

    // Derive current count: no bundle → 0, non-array → 0, array → length
    const currentCount: number = bundle !== null && Array.isArray(bundle.preKeys)
      ? bundle.preKeys.length
      : 0;

    // -------------------------------------------------------------------------
    // Step 3: Check if replenishment is still needed
    // -------------------------------------------------------------------------
    // If the count has recovered (e.g., user already uploaded new prekeys),
    // skip the notification to avoid unnecessary client work.
    if (currentCount >= threshold) {
      logger.info(
        { currentCount, threshold },
        'Prekey count recovered since enqueue, skipping notification',
      );
      return;
    }

    // -------------------------------------------------------------------------
    // Step 4: Emit key:replenish WebSocket event via Redis pub/sub
    // -------------------------------------------------------------------------
    // Publish to a per-user Redis channel that the API server subscribes to.
    // The API server's event bridge forwards the message to the user's
    // connected Socket.IO socket(s). If the user is offline, the message
    // is dropped — the client will check prekey supply on next connection.
    const event = JSON.stringify({
      type: 'key:replenish',
      userId,
      remainingCount: currentCount,
      threshold,
      correlationId,
      timestamp: new Date().toISOString(),
    });

    const channel = `${USER_EVENT_CHANNEL_PREFIX}${userId}`;
    await context.redisConnection.publish(channel, event);

    // -------------------------------------------------------------------------
    // Step 5: Log completion
    // -------------------------------------------------------------------------
    // Urgency classification for observability dashboards:
    // - "critical": zero prekeys remain — new sessions cannot be established
    // - "warning":  below threshold but some prekeys still available
    const urgency = currentCount === 0 ? 'critical' : 'warning';

    logger.info(
      { currentCount, threshold, urgency, notified: true },
      'Prekey replenish notification sent',
    );
  } catch (err: unknown) {
    // Sanitize error for logging — NEVER include key material (R23).
    // Only log the error message string, not the full stack or payload.
    const errorMessage = err instanceof Error ? err.message : String(err);

    logger.error(
      { error: errorMessage },
      'Prekey replenish notification failed',
    );

    // Re-throw so BullMQ applies its retry policy:
    // 3 attempts with exponential backoff (1s, 4s, 16s), then dead-letter.
    // Transient errors (Redis/Prisma connection failures) will succeed on retry.
    throw err;
  }
}
