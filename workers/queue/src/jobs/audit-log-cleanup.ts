/**
 * workers/queue/src/jobs/audit-log-cleanup.ts
 *
 * BullMQ job processor for purging audit log records older than 90 days.
 *
 * Schedule: Weekly — Cron `0 0 * * 0` (Sunday at midnight).
 * Scheduling is configured in the parent `workers/queue/src/index.ts`, NOT here.
 *
 * IMPORTANT — Rule R32 (Immutable Audit Log):
 * The `audit_log` table is append-only for the standard application database
 * role. This cleanup job is the SOLE code path that performs DELETEs on the
 * table. The worker's `DATABASE_URL` MUST connect with a role that has DELETE
 * privileges on `audit_logs`. If the standard role lacks DELETE, configure a
 * separate `AUDIT_CLEANUP_DATABASE_URL` environment variable pointing to an
 * elevated-role connection string.
 *
 * Rule R35 — Data Retention Enforcement:
 * Audit logs are purged after 90 days (configurable via job payload for testing).
 *
 * Rule R28 — Structured Logging Only:
 * All logging via Pino JSON. Zero `console.log`/`console.warn`/`console.error`.
 *
 * Rule R29 — Correlation ID Propagation:
 * Every log entry includes the `correlationId` extracted from the job payload.
 *
 * Rule R23 — Log Hygiene:
 * Logs must NOT contain audit metadata contents. Only: job ID, record counts,
 * date ranges, durations, and sanitised error messages.
 */

import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Payload carried by each `audit-log-cleanup` BullMQ job.
 * `retentionDays` and `triggeredAt` are optional to support testing overrides.
 */
interface AuditLogCleanupPayload {
  /** UUID v4 propagated through every log entry (Rule R29). */
  correlationId: string;
  /** Number of days to retain. Defaults to {@link DEFAULT_RETENTION_DAYS}. */
  retentionDays?: number;
  /** ISO 8601 timestamp indicating when the cron fired. Informational only. */
  triggeredAt?: string;
}

/**
 * Shared context provided to every job processor by the worker bootstrap
 * (`workers/queue/src/index.ts`). Defined locally because this file has no
 * internal dependency on the index module (avoids circular imports).
 */
interface WorkerContext {
  /** Prisma ORM client — must be connected with audit_log DELETE privileges. */
  prisma: PrismaClient;
  /** Root Pino logger instance. A child logger with correlationId is created per job. */
  logger: Logger;
  /** IORedis connection shared across workers (unused by this job but required by interface). */
  redisConnection: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default retention period in days. Audit log records older than this are
 * purged (Rule R35). Overridable per-job via `AuditLogCleanupPayload.retentionDays`.
 */
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Maximum number of records to delete in a single database round-trip.
 * Batching prevents long-running transactions from causing lock contention
 * and allows progress reporting to BullMQ.
 */
const BATCH_SIZE = 5_000;

/**
 * Threshold above which we switch from a simple `deleteMany` to batched
 * raw-SQL deletion with a `LIMIT` clause.
 */
const BATCH_THRESHOLD = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the error indicates a database permission denial.
 * Used to surface clear guidance about the elevated-role requirement (R32).
 */
function isPermissionDenied(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('permission denied') ||
      msg.includes('access denied') ||
      msg.includes('insufficient privilege')
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Process a single `audit-log-cleanup` job.
 *
 * 1. Calculate the cutoff date (`now − retentionDays`).
 * 2. Count matching records (for logging).
 * 3. Delete expired records — simple path for small volumes, batched raw SQL
 *    for large volumes (> {@link BATCH_THRESHOLD}).
 * 4. Report progress and duration.
 *
 * Errors are logged and re-thrown so BullMQ retries the job (3 attempts,
 * exponential backoff as configured in the worker bootstrap).
 *
 * @param job     BullMQ job instance carrying {@link AuditLogCleanupPayload}.
 * @param context Shared worker context (Prisma client, Pino logger, Redis).
 */
export async function processAuditLogCleanup(
  job: Job<AuditLogCleanupPayload>,
  context: WorkerContext,
): Promise<void> {
  const { correlationId, triggeredAt } = job.data;
  const retentionDays = job.data.retentionDays ?? DEFAULT_RETENTION_DAYS;

  // Create a child logger scoped to this job (Rule R29).
  const logger = context.logger.child({
    correlationId,
    jobId: job.id,
    jobName: 'audit-log-cleanup',
  });

  const startedAt = Date.now();

  // ---------- 1. Compute cutoff date ----------------------------------
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  // Warn operators about unusually short retention periods that may indicate
  // misconfiguration (the default is 90 days; anything under 7 is suspicious).
  if (retentionDays < 7) {
    logger.warn(
      { retentionDays },
      'Audit log retention period is unusually short — verify configuration',
    );
  }

  logger.info(
    {
      retentionDays,
      cutoffDate: cutoffDate.toISOString(),
      triggeredAt: triggeredAt ?? null,
    },
    'Starting audit log cleanup',
  );

  try {
    // ---------- 2. Count records eligible for deletion -----------------
    const countToDelete = await context.prisma.auditLog.count({
      where: { createdAt: { lt: cutoffDate } },
    });

    logger.info(
      { recordsToDelete: countToDelete },
      'Found audit log records for cleanup',
    );

    // ---------- 3. Early exit when nothing to purge -------------------
    if (countToDelete === 0) {
      logger.info('No audit log records older than retention period');
      await job.updateProgress(100);
      return;
    }

    // ---------- 4. Delete expired records -----------------------------
    let totalDeleted: number;

    if (countToDelete <= BATCH_THRESHOLD) {
      // ----- Simple path: single deleteMany ---------------------------
      // Uses the Prisma client's configured connection. The worker's
      // DATABASE_URL must grant DELETE on the `audit_logs` table (R32).
      const result = await context.prisma.auditLog.deleteMany({
        where: { createdAt: { lt: cutoffDate } },
      });
      totalDeleted = result.count;
      await job.updateProgress(100);
    } else {
      // ----- Batched path: raw SQL with LIMIT -------------------------
      // Prisma's `deleteMany` doesn't support a row-limit clause. We use
      // raw SQL to delete in bounded batches, preventing long-running
      // transactions and reducing lock contention on high-volume tables.
      //
      // The `ctid IN (SELECT ctid … LIMIT $2)` pattern efficiently
      // targets a batch of physical rows in PostgreSQL.
      totalDeleted = 0;

      while (totalDeleted < countToDelete) {
        const batchDeleted: number = await context.prisma.$executeRaw`
          DELETE FROM "audit_logs"
          WHERE "ctid" IN (
            SELECT "ctid" FROM "audit_logs"
            WHERE "created_at" < ${cutoffDate}
            LIMIT ${BATCH_SIZE}
          )
        `;

        totalDeleted += batchDeleted;

        // Report progress to BullMQ dashboard consumers.
        const progress = Math.min(
          100,
          Math.round((totalDeleted / countToDelete) * 100),
        );
        await job.updateProgress(progress);

        logger.info(
          { batchDeleted, totalDeleted, progress },
          'Audit log cleanup batch completed',
        );

        // If a batch returned zero rows the table is clean.
        if (batchDeleted === 0) {
          break;
        }
      }
    }

    // ---------- 5. Log completion -------------------------------------
    const durationMs = Date.now() - startedAt;

    // When the actual deleted count is lower than the pre-delete count, a
    // concurrent cleanup or manual intervention occurred. This is benign
    // (deleteMany is idempotent) but worth logging for observability.
    if (totalDeleted < countToDelete) {
      logger.warn(
        { expected: countToDelete, actual: totalDeleted },
        'Fewer records deleted than expected — concurrent cleanup likely',
      );
    }

    logger.info(
      {
        recordsDeleted: totalDeleted,
        retentionDays,
        cutoffDate: cutoffDate.toISOString(),
        durationMs,
      },
      'Audit log cleanup completed',
    );
  } catch (error: unknown) {
    const durationMs = Date.now() - startedAt;
    const errMessage =
      error instanceof Error ? error.message : String(error);

    // Surface a clear, actionable message when the DB role lacks DELETE
    // permissions on the audit_logs table (Rule R32).
    if (isPermissionDenied(error)) {
      logger.error(
        { durationMs },
        'Audit log cleanup failed: permission denied on audit_logs table. ' +
          'The worker DATABASE_URL must connect with a role that has DELETE ' +
          'privileges on audit_logs (Rule R32).',
      );
    } else {
      logger.error(
        { error: errMessage, durationMs },
        'Audit log cleanup failed',
      );
    }

    // Re-throw so BullMQ applies its retry policy (3 attempts, exponential
    // backoff). Transient errors (connection drops, lock timeouts) will
    // resolve on retry; permission errors will exhaust retries and land in
    // the dead-letter queue where an operator can investigate.
    throw error;
  }
}
