/**
 * @file QueueProvider.ts — BullMQ Queue Producer Implementation
 *
 * Concrete implementation of the IQueueProvider interface. Wraps a single
 * BullMQ Queue instance named 'kalle-jobs' for asynchronous job enqueuing.
 * This is the **producer** side — the worker process (workers/queue/) is
 * the consumer. Supports single job enqueue, bulk enqueue for fan-out
 * scenarios, cron-based repeatable jobs, queue depth monitoring for health
 * checks, and graceful shutdown.
 *
 * Architecture Rules Enforced:
 * - R17: Interface-Driven Dependencies — only the composition root (server.ts)
 *        imports this concrete class. All other consumers import IQueueProvider.
 * - R18: Fan-Out via Queue — delivery to 3+ recipients, Sender Key distribution,
 *        link preview extraction, and story cleanup go through BullMQ. Group
 *        message API returns before all deliveries complete.
 * - R29: Correlation ID Propagation — job payloads include correlation ID from
 *        JobOptions.correlationId as `_correlationId`. The worker process
 *        extracts it and propagates to its logger context.
 * - R28: Structured Logging Only — zero console.log calls.
 * - R7:  Zero Warnings Build — compiles under tsc --noEmit --strict with zero warnings.
 * - R37: Metrics Endpoint — getQueueDepth() provides waiting + delayed + active
 *        count for health check and Prometheus metrics.
 * - R38: Zero External Dependencies — uses only Docker-internal Redis.
 */

import { Queue } from 'bullmq';
import type { QueueOptions } from 'bullmq';
import type Redis from 'ioredis';
import type {
  IQueueProvider,
  QueueJobName,
  JobOptions,
  JobInfo,
} from '../domain/interfaces/IQueueProvider';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Name of the single BullMQ queue used for all job types */
const QUEUE_NAME = 'kalle-jobs';

/** Default number of retry attempts for failed jobs */
const DEFAULT_ATTEMPTS = 3;

/** Base delay (ms) for exponential backoff between retries (1s → 2s → 4s) */
const DEFAULT_BACKOFF_DELAY_MS = 1000;

/** Maximum completed jobs retained in the queue for inspection */
const DEFAULT_COMPLETED_RETENTION = 100;

/** Maximum failed jobs retained in the queue for dead-letter analysis */
const DEFAULT_FAILED_RETENTION = 500;

/** Reduced completed retention for repeatable (cron) jobs */
const REPEAT_COMPLETED_RETENTION = 10;

/** Reduced failed retention for repeatable (cron) jobs */
const REPEAT_FAILED_RETENTION = 50;

/** Default Redis port when not specified in the connection URL */
const DEFAULT_REDIS_PORT = 6379;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses a Redis connection URL into BullMQ-compatible connection options.
 *
 * Supports standard redis:// and rediss:// URL formats including:
 * - `redis://host:port`
 * - `redis://:password@host:port/db`
 * - `redis://username:password@host:port`
 *
 * BullMQ requires `maxRetriesPerRequest: null` on its internal Redis
 * connections for blocking command support. This function always includes
 * that setting regardless of the input URL.
 *
 * @param redisUrl - Full Redis connection URL string
 * @returns Connection options compatible with BullMQ QueueOptions.connection
 */
function parseRedisUrl(redisUrl: string): {
  host: string;
  port: number;
  password?: string;
  db?: number;
  maxRetriesPerRequest: null;
  tls?: Record<string, unknown>;
} {
  const parsed = new URL(redisUrl);
  const host = parsed.hostname || 'localhost';
  const port = parsed.port ? parseInt(parsed.port, 10) : DEFAULT_REDIS_PORT;

  // Extract password — URL spec puts password in the password field
  // but Redis URLs sometimes encode password after `:` in the userinfo section
  const password = parsed.password || undefined;

  // Extract database number from the path (e.g., /0, /1)
  const dbPath = parsed.pathname?.replace('/', '');
  const db = dbPath ? parseInt(dbPath, 10) : undefined;

  // Determine if TLS is required based on the URL scheme
  const useTls = parsed.protocol === 'rediss:';

  const opts: {
    host: string;
    port: number;
    password?: string;
    db?: number;
    maxRetriesPerRequest: null;
    tls?: Record<string, unknown>;
  } = {
    host,
    port,
    maxRetriesPerRequest: null, // Required by BullMQ for blocking BRPOPLPUSH
  };

  if (password) {
    opts.password = password;
  }

  if (db !== undefined && !isNaN(db)) {
    opts.db = db;
  }

  if (useTls) {
    opts.tls = {};
  }

  return opts;
}

/**
 * Injects the correlation ID into a job payload for end-to-end traceability.
 *
 * Per Rule R29, every job payload carries `_correlationId` when a correlation
 * ID is provided. The worker process extracts this field and sets it in the
 * Pino logger context for all log entries produced during job processing.
 *
 * @param payload - Original job payload
 * @param correlationId - Optional correlation ID to inject
 * @returns Payload with `_correlationId` added if the ID was provided
 */
function injectCorrelationId(
  payload: Record<string, unknown>,
  correlationId: string | undefined,
): Record<string, unknown> {
  if (correlationId) {
    return { ...payload, _correlationId: correlationId };
  }
  return payload;
}

// ---------------------------------------------------------------------------
// QueueProvider
// ---------------------------------------------------------------------------

/**
 * BullMQ-backed queue provider for asynchronous job processing.
 *
 * Uses a single queue named 'kalle-jobs' with job names used as BullMQ
 * job names for routing to the appropriate worker processor. All job types
 * (message-fanout, sender-key-distribution, link-preview, story-cleanup,
 * audit-log-cleanup, prekey-replenish-notification) flow through this
 * single queue, simplifying deployment and monitoring.
 *
 * Default retry policy: 3 attempts with exponential backoff (1s base delay).
 * Completed jobs: last 100 retained for inspection.
 * Failed jobs: last 500 retained for dead-letter analysis.
 *
 * @example
 * ```typescript
 * // Instantiation in composition root (server.ts)
 * const queueProvider = new QueueProvider(redis, env.REDIS_URL);
 *
 * // Enqueue a single job
 * const info = await queueProvider.enqueue('link-preview', {
 *   messageId: 'msg-123',
 *   url: 'https://example.com',
 * }, { correlationId: 'req-abc' });
 *
 * // Bulk enqueue for fan-out (Rule R18)
 * const results = await queueProvider.enqueueBulk([
 *   { name: 'message-fanout', payload: { recipientId: 'user-1', ... } },
 *   { name: 'message-fanout', payload: { recipientId: 'user-2', ... } },
 * ]);
 *
 * // Schedule a repeatable cron job
 * await queueProvider.scheduleRepeat('story-cleanup', {}, '0 * * * *');
 *
 * // Graceful shutdown
 * await queueProvider.close();
 * ```
 */
export class QueueProvider implements IQueueProvider {
  /**
   * The primary BullMQ Queue instance used for all job types.
   * Job names serve as the routing key to the corresponding worker processor.
   */
  private readonly defaultQueue: Queue;

  /**
   * Creates a new QueueProvider instance.
   *
   * Initializes a BullMQ Queue with connection options parsed from the
   * provided Redis URL. BullMQ manages its own internal Redis connections
   * separate from the application's main Redis client, which is why the
   * URL is parsed rather than passing the client directly.
   *
   * @param _redis - Main ioredis client instance (retained for type compatibility
   *                 with the composition root's DI pattern; BullMQ creates its own
   *                 internal connections)
   * @param redisUrl - Redis connection URL (e.g., 'redis://redis:6379')
   */
  constructor(_redis: Redis, redisUrl: string) {
    // Parse Redis URL into BullMQ-compatible connection options
    // BullMQ requires maxRetriesPerRequest: null for its internal blocking operations
    const connectionOptions = parseRedisUrl(redisUrl);

    // Create the main queue instance with sensible defaults
    this.defaultQueue = new Queue(QUEUE_NAME, {
      connection: connectionOptions,
      defaultJobOptions: {
        attempts: DEFAULT_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: DEFAULT_BACKOFF_DELAY_MS,
        },
        removeOnComplete: { count: DEFAULT_COMPLETED_RETENTION },
        removeOnFail: { count: DEFAULT_FAILED_RETENTION },
      },
    } satisfies QueueOptions);
  }

  // -------------------------------------------------------------------------
  // IQueueProvider — enqueue
  // -------------------------------------------------------------------------

  /**
   * Enqueue a single job for asynchronous processing.
   *
   * The job will be picked up by the corresponding worker processor registered
   * under the given `jobName`. Payloads are JSON-serialized for transport.
   * Correlation ID (Rule R29) is embedded in the payload as `_correlationId`
   * so the worker can extract it for structured log propagation.
   *
   * @param jobName - Name of the job type (must be a valid QueueJobName)
   * @param payload - Job data payload (will be JSON-serialized by BullMQ)
   * @param options - Optional job configuration (delay, retries, priority, correlationId)
   * @returns Promise resolving to JobInfo with the queue-assigned job ID
   */
  async enqueue(
    jobName: QueueJobName,
    payload: Record<string, unknown>,
    options?: JobOptions,
  ): Promise<JobInfo> {
    // Inject correlation ID into payload for cross-service traceability (R29)
    const jobData = injectCorrelationId(payload, options?.correlationId);

    const job = await this.defaultQueue.add(jobName, jobData, {
      // Scheduling: delay job processing by N milliseconds
      ...(options?.delay !== undefined && { delay: options.delay }),

      // Retry configuration: override queue defaults if specified
      ...(options?.attempts !== undefined && { attempts: options.attempts }),

      // Backoff strategy: exponential or fixed delay between retries
      ...(options?.backoff && {
        backoff: {
          type: options.backoff.type,
          delay: options.backoff.delay,
        },
      }),

      // Priority: lower number = higher priority (1 = highest)
      ...(options?.priority !== undefined && { priority: options.priority }),

      // Job retention: override queue defaults for completed/failed jobs
      ...(options?.removeOnComplete !== undefined && {
        removeOnComplete: options.removeOnComplete,
      }),
      ...(options?.removeOnFail !== undefined && {
        removeOnFail: options.removeOnFail,
      }),
    });

    return {
      id: job.id ?? '',
      name: job.name,
      createdAt: job.timestamp,
    };
  }

  // -------------------------------------------------------------------------
  // IQueueProvider — enqueueBulk
  // -------------------------------------------------------------------------

  /**
   * Enqueue multiple jobs in a single atomic operation (bulk enqueue).
   *
   * Uses BullMQ's addBulk() for atomic batch insertion — either all jobs
   * are added or none. This is critical for fan-out scenarios (Rule R18)
   * where a single action needs to trigger delivery to multiple recipients.
   *
   * Example: a group message with 50 participants triggers 50 individual
   * `message-fanout` jobs, all inserted atomically.
   *
   * @param jobs - Array of job definitions, each with name, payload, and optional config
   * @returns Promise resolving to an array of JobInfo, one per enqueued job
   */
  async enqueueBulk(
    jobs: Array<{
      name: QueueJobName;
      payload: Record<string, unknown>;
      options?: JobOptions;
    }>,
  ): Promise<JobInfo[]> {
    // Map interface job definitions to BullMQ's addBulk format
    const bulkJobs = jobs.map((job) => ({
      name: job.name,
      data: injectCorrelationId(job.payload, job.options?.correlationId),
      opts: {
        // Scheduling
        ...(job.options?.delay !== undefined && { delay: job.options.delay }),

        // Retry configuration
        ...(job.options?.attempts !== undefined && {
          attempts: job.options.attempts,
        }),

        // Backoff strategy
        ...(job.options?.backoff && {
          backoff: {
            type: job.options.backoff.type,
            delay: job.options.backoff.delay,
          },
        }),

        // Priority
        ...(job.options?.priority !== undefined && {
          priority: job.options.priority,
        }),

        // Job retention
        ...(job.options?.removeOnComplete !== undefined && {
          removeOnComplete: job.options.removeOnComplete,
        }),
        ...(job.options?.removeOnFail !== undefined && {
          removeOnFail: job.options.removeOnFail,
        }),
      },
    }));

    const result = await this.defaultQueue.addBulk(bulkJobs);

    return result.map((job) => ({
      id: job.id ?? '',
      name: job.name,
      createdAt: job.timestamp,
    }));
  }

  // -------------------------------------------------------------------------
  // IQueueProvider — scheduleRepeat
  // -------------------------------------------------------------------------

  /**
   * Schedule a repeatable job on a cron schedule.
   *
   * Uses BullMQ's built-in `repeat` option with cron pattern. Intended for:
   * - `story-cleanup`: '0 * * * *' (hourly) — Rules R11, R35
   * - `audit-log-cleanup`: '0 0 * * 0' (weekly Sunday midnight) — Rule R35
   *
   * BullMQ handles deduplication of repeatable jobs internally. If a job with
   * the same name and cron pattern already exists, it will be updated rather
   * than duplicated.
   *
   * Retention is lower for repeatable jobs (10 completed, 50 failed) since
   * they run continuously and would otherwise accumulate unbounded history.
   *
   * @param jobName - Name of the job type
   * @param payload - Job data payload
   * @param cronExpression - Standard cron expression (e.g., '0 * * * *' for hourly)
   * @param options - Optional job configuration (retry, backoff)
   * @returns Promise resolving to JobInfo with the assigned job ID
   */
  async scheduleRepeat(
    jobName: QueueJobName,
    payload: Record<string, unknown>,
    cronExpression: string,
    options?: JobOptions,
  ): Promise<JobInfo> {
    const job = await this.defaultQueue.add(jobName, payload, {
      repeat: {
        pattern: cronExpression,
      },

      // Retry configuration: use caller's values or sensible defaults
      ...(options?.attempts !== undefined && { attempts: options.attempts }),

      // Backoff strategy
      ...(options?.backoff && {
        backoff: {
          type: options.backoff.type,
          delay: options.backoff.delay,
        },
      }),

      // Lower retention for repeatable jobs to prevent unbounded accumulation
      removeOnComplete: options?.removeOnComplete ?? {
        count: REPEAT_COMPLETED_RETENTION,
      },
      removeOnFail: options?.removeOnFail ?? {
        count: REPEAT_FAILED_RETENTION,
      },
    });

    return {
      id: job.id ?? '',
      name: job.name,
      createdAt: job.timestamp,
    };
  }

  // -------------------------------------------------------------------------
  // IQueueProvider — removeRepeat
  // -------------------------------------------------------------------------

  /**
   * Remove a previously scheduled repeatable job.
   *
   * Identifies the repeatable job by the combination of job name and cron
   * expression. After removal, the job will no longer be enqueued on the
   * specified schedule. Note that already-enqueued instances of the job
   * that are waiting or in-progress will continue to execute.
   *
   * @param jobName - Name of the job type
   * @param cronExpression - Cron expression of the repeatable job to remove
   */
  async removeRepeat(
    jobName: QueueJobName,
    cronExpression: string,
  ): Promise<void> {
    await this.defaultQueue.removeRepeatable(jobName, {
      pattern: cronExpression,
    });
  }

  // -------------------------------------------------------------------------
  // IQueueProvider — getQueueDepth
  // -------------------------------------------------------------------------

  /**
   * Get the current count of pending jobs in the queue.
   *
   * Returns the combined count of waiting + delayed + active jobs across
   * all job types. Used by HealthService and MetricsService (Rule R37) to
   * monitor queue depth and detect potential processing bottlenecks.
   *
   * Note: BullMQ does not natively support per-job-name filtering in
   * getJobCounts(). The optional `jobName` parameter is accepted for
   * interface compatibility but currently returns the total across all
   * job types. For per-name monitoring, individual job inspection via
   * BullMQ's getJobs() would be needed.
   *
   * @param _jobName - Optional filter by job name (currently unused; returns total)
   * @returns Promise resolving to the number of pending jobs
   */
  async getQueueDepth(_jobName?: QueueJobName): Promise<number> {
    const counts = await this.defaultQueue.getJobCounts(
      'waiting',
      'delayed',
      'active',
    );
    return counts.waiting + counts.delayed + counts.active;
  }

  // -------------------------------------------------------------------------
  // IQueueProvider — close
  // -------------------------------------------------------------------------

  /**
   * Close all queue connections gracefully.
   *
   * Waits for any pending BullMQ operations to complete, then closes the
   * internal Redis connections managed by BullMQ. Must be called during
   * server shutdown (server.ts graceful shutdown handler) to prevent
   * connection leaks and ensure clean process termination.
   *
   * After calling close(), no further enqueue operations should be attempted
   * as the underlying connections are no longer available.
   */
  async close(): Promise<void> {
    await this.defaultQueue.close();
  }
}
