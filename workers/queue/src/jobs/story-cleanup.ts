// =============================================================================
// Kalle — WhatsApp Clone · BullMQ Story Cleanup Job
// =============================================================================
//
// Expired story and media purge job processor (Rules R11, R35).
// Runs on an hourly cron schedule (`0 * * * *`) — scheduling is wired
// in workers/queue/src/index.ts, NOT in this file.
//
// Queries stories where expiresAt < NOW(), deletes associated media files
// from local storage, and removes expired database records.
//
// Stories are NOT encrypted (Rule R12), so media files can be deleted
// directly from disk without any decryption step.
//
// Critical Rules:
//   R11  — Stories hidden after 24 h. Expired media deleted by cleanup job.
//   R12  — Stories are NOT encrypted (simplifies cleanup).
//   R23  — No user content, media URLs, or sensitive data in logs.
//   R28  — All logging via Pino JSON output. Zero console.log.
//   R29  — Correlation ID in every log entry.
//   R35  — Stories and associated media purged after 24 h.
// =============================================================================

import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Payload carried by the story-cleanup BullMQ job.
 * For cron-triggered jobs the correlationId may be pre-assigned by the
 * scheduler; when absent a new UUID is generated at processing time.
 */
interface StoryCleanupPayload {
  /** Correlation ID for end-to-end request tracing (Rule R29). */
  correlationId: string;
  /** ISO 8601 timestamp indicating when the cron schedule fired. */
  triggeredAt?: string;
}

/**
 * Shared context provided by the worker bootstrap (index.ts) to every
 * job processor function.
 */
interface WorkerContext {
  prisma: PrismaClient;
  logger: Logger;
  /** IORedis instance — typed as unknown to avoid coupling to ioredis. */
  redisConnection: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of expired stories fetched and processed per iteration
 * to prevent long-running transactions and excessive memory usage.
 */
const BATCH_SIZE = 100;

/**
 * Fallback upload directory when the UPLOAD_DIR environment variable is
 * not configured. In production this is always set via docker-compose.
 */
const DEFAULT_UPLOAD_DIR = './uploads';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to delete a single file from local storage.
 *
 * ENOENT errors are handled gracefully (the file may have been removed by
 * a prior run or an external process). All other errors are logged as
 * warnings but do NOT propagate — individual file failures must never
 * abort the entire cleanup batch.
 *
 * @returns `true` when the file was successfully deleted, `false` otherwise.
 */
async function safeUnlink(filePath: string, logger: Logger): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      // File already removed — expected in concurrent/repeated runs
      return false;
    }
    // Log a warning but continue processing the rest of the batch (R23:
    // do NOT include the file path — it may contain user-identifiable info)
    logger.warn(
      { errorCode: nodeErr.code, errorMessage: nodeErr.message },
      'Failed to delete media file from storage',
    );
    return false;
  }
}

/**
 * Derives the absolute on-disk path for a media record's primary file.
 * Uses the `filename` field if available, falling back to the record `id`.
 */
function resolveMediaPath(
  uploadDir: string,
  filename: string,
  recordId: string,
): string {
  return path.resolve(uploadDir, filename || recordId);
}

/**
 * Derives the absolute on-disk path for a media record's thumbnail.
 * The thumbnailUrl may be a bare filename or a relative path — the last
 * segment is extracted and resolved against UPLOAD_DIR.
 */
function resolveThumbnailPath(
  uploadDir: string,
  thumbnailUrl: string,
): string {
  const baseName = thumbnailUrl.split('/').pop() ?? thumbnailUrl;
  return path.resolve(uploadDir, baseName);
}

/**
 * Deletes all on-disk files (main + thumbnail) for an array of media
 * records belonging to expired stories.
 *
 * Returns aggregate counts of successful deletions and errors.
 */
async function deleteMediaFiles(
  mediaRecords: ReadonlyArray<{
    id: string;
    filename: string;
    encryptedUrl: string;
    thumbnailUrl: string | null;
  }>,
  uploadDir: string,
  logger: Logger,
): Promise<{ filesDeleted: number; fileErrors: number }> {
  let filesDeleted = 0;
  let fileErrors = 0;

  for (const media of mediaRecords) {
    // Delete the primary media file
    const mainPath = resolveMediaPath(uploadDir, media.filename, media.id);
    const mainOk = await safeUnlink(mainPath, logger);
    if (mainOk) {
      filesDeleted++;
    } else {
      fileErrors++;
    }

    // Delete the thumbnail when present
    if (media.thumbnailUrl) {
      const thumbPath = resolveThumbnailPath(uploadDir, media.thumbnailUrl);
      const thumbOk = await safeUnlink(thumbPath, logger);
      if (thumbOk) {
        filesDeleted++;
      } else {
        fileErrors++;
      }
    }
  }

  return { filesDeleted, fileErrors };
}

// ---------------------------------------------------------------------------
// Exported Job Processor
// ---------------------------------------------------------------------------

/**
 * BullMQ job processor for expired story cleanup.
 *
 * Execution flow:
 *   1. Count total expired stories for progress tracking.
 *   2. Fetch expired stories in batches of {@link BATCH_SIZE}.
 *   3. For each batch:
 *      a. Delete associated media files from local storage.
 *      b. Delete StoryView records (explicit, pre-cascade safeguard).
 *      c. Delete Media DB records (MUST precede story deletion because
 *         the Media → Story FK uses onDelete: SetNull, not Cascade).
 *      d. Delete the expired Story records.
 *      e. Report progress via `job.updateProgress()`.
 *   4. Log a final summary with counts and duration.
 *
 * On transient errors (DB connection, etc.) the function re-throws so
 * that BullMQ applies its retry policy (3 attempts, exponential backoff).
 *
 * @param job      BullMQ Job carrying {@link StoryCleanupPayload}.
 * @param context  Worker context (Prisma, Pino logger, Redis).
 */
export async function processStoryCleanup(
  job: Job<StoryCleanupPayload>,
  context: WorkerContext,
): Promise<void> {
  // Derive a correlation ID — cron-triggered jobs may not carry one (R29)
  const correlationId: string = job.data.correlationId || randomUUID();
  const logger: Logger = context.logger.child({
    correlationId,
    jobId: job.id,
    jobName: 'story-cleanup',
  });

  const startTime: number = Date.now();
  logger.info('Starting expired story cleanup');

  try {
    const uploadDir: string = process.env['UPLOAD_DIR'] || DEFAULT_UPLOAD_DIR;
    const now: Date = new Date();

    // -------------------------------------------------------------------
    // 1. Total count (used for progress percentage)
    // -------------------------------------------------------------------
    const totalExpired: number = await context.prisma.story.count({
      where: { expiresAt: { lt: now } },
    });

    logger.info({ expiredCount: totalExpired }, 'Found expired stories');

    if (totalExpired === 0) {
      logger.info('No expired stories found');
      return;
    }

    // -------------------------------------------------------------------
    // 2. Batch processing loop
    // -------------------------------------------------------------------
    let totalStoriesDeleted = 0;
    let totalViewsDeleted = 0;
    let totalMediaRecordsDeleted = 0;
    let totalMediaFilesDeleted = 0;
    let totalMediaFileErrors = 0;
    let processedCount = 0;

    // Continue until no more expired stories remain or the total is reached
    while (processedCount < totalExpired) {
      // Fetch a batch of expired stories with associated media
      const expiredBatch = await context.prisma.story.findMany({
        where: { expiresAt: { lt: now } },
        take: BATCH_SIZE,
        select: {
          id: true,
          authorId: true,
          type: true,
          media: {
            select: {
              id: true,
              encryptedUrl: true,
              thumbnailUrl: true,
              filename: true,
            },
          },
        },
      });

      // Guard: concurrent cleanup may have already removed all records
      if (expiredBatch.length === 0) {
        break;
      }

      const batchStoryIds: string[] = expiredBatch.map((s) => s.id);

      // Flatten all media records from this batch
      const batchMediaRecords = expiredBatch.flatMap((s) => s.media);
      const batchMediaIds: string[] = batchMediaRecords.map((m) => m.id);

      // -----------------------------------------------------------------
      // 2a. Delete media files from local storage (R12: NOT encrypted)
      // -----------------------------------------------------------------
      if (batchMediaRecords.length > 0) {
        const fileResult = await deleteMediaFiles(
          batchMediaRecords,
          uploadDir,
          logger,
        );
        totalMediaFilesDeleted += fileResult.filesDeleted;
        totalMediaFileErrors += fileResult.fileErrors;
      }

      // -----------------------------------------------------------------
      // 2b. Delete StoryView records (referential integrity safeguard;
      //     cascade would also handle this if the Story is deleted, but
      //     explicit deletion is deterministic and avoids ordering issues)
      // -----------------------------------------------------------------
      const deletedViews = await context.prisma.storyView.deleteMany({
        where: { storyId: { in: batchStoryIds } },
      });
      totalViewsDeleted += deletedViews.count;

      // -----------------------------------------------------------------
      // 2c. Delete Media DB records BEFORE stories (Media → Story FK is
      //     onDelete: SetNull — deleting the story would orphan the media
      //     record rather than removing it)
      // -----------------------------------------------------------------
      if (batchMediaIds.length > 0) {
        const deletedMedia = await context.prisma.media.deleteMany({
          where: { id: { in: batchMediaIds } },
        });
        totalMediaRecordsDeleted += deletedMedia.count;
      }

      // -----------------------------------------------------------------
      // 2d. Delete the expired Story records
      // -----------------------------------------------------------------
      const deletedStories = await context.prisma.story.deleteMany({
        where: { id: { in: batchStoryIds } },
      });
      totalStoriesDeleted += deletedStories.count;

      processedCount += expiredBatch.length;

      // Report progress to BullMQ dashboard / listeners
      const progressPercent: number = Math.min(
        100,
        Math.round((processedCount / totalExpired) * 100),
      );
      await job.updateProgress(progressPercent);

      logger.info(
        {
          batchSize: expiredBatch.length,
          batchStoriesDeleted: deletedStories.count,
          batchViewsDeleted: deletedViews.count,
          batchMediaIds: batchMediaIds.length,
          progress: progressPercent,
        },
        'Batch cleanup completed',
      );
    }

    // -------------------------------------------------------------------
    // 3. Final summary
    // -------------------------------------------------------------------
    const durationMs: number = Date.now() - startTime;

    logger.info(
      {
        totalExpired,
        storiesDeleted: totalStoriesDeleted,
        viewsDeleted: totalViewsDeleted,
        mediaRecordsDeleted: totalMediaRecordsDeleted,
        mediaFilesDeleted: totalMediaFilesDeleted,
        mediaFileErrors: totalMediaFileErrors,
        durationMs,
      },
      'Story cleanup completed',
    );
  } catch (err: unknown) {
    const durationMs: number = Date.now() - startTime;
    const error: Error = err instanceof Error ? err : new Error(String(err));

    logger.error(
      { error: error.message, durationMs },
      'Story cleanup failed',
    );

    // Re-throw so BullMQ applies its retry policy
    // (3 attempts with exponential backoff: 1 s → 4 s → 16 s)
    throw error;
  }
}
