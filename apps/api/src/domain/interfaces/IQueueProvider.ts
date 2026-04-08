/**
 * @file IQueueProvider.ts
 * @description Queue provider interface abstracting BullMQ for asynchronous job processing.
 *
 * This interface is consumed by services that enqueue background jobs:
 * - Message fan-out to group participants (R18)
 * - Sender Key distribution/rotation (R14)
 * - Link preview extraction
 * - Story cleanup (R11, R35)
 * - Audit log cleanup (R35)
 * - PreKey replenishment notifications
 *
 * Architecture Rules:
 * - R17: Services code against this interface — never import QueueProvider concrete class
 * - R18: Delivery to 3+ recipients, Sender Key distribution, link preview, story cleanup go through queue
 * - R16: Provider interface abstracting infrastructure (BullMQ) — zero business logic
 * - R29: Job payloads support correlation ID propagation
 * - R7: TypeScript strict mode, zero warnings
 * - R28: Zero console.log calls
 */

// ---------------------------------------------------------------------------
// Supporting Types
// ---------------------------------------------------------------------------

/**
 * Options for configuring job behavior in the queue.
 *
 * These options allow callers to control retry behavior, scheduling priority,
 * and traceability without coupling to the underlying BullMQ API.
 */
export interface JobOptions {
  /** Optional delay in milliseconds before job becomes processable */
  delay?: number;

  /** Number of retry attempts on failure (default: 3) */
  attempts?: number;

  /**
   * Backoff strategy configuration for retry attempts.
   * - `exponential`: delay doubles after each retry (base * 2^attempt)
   * - `fixed`: constant delay between retries
   */
  backoff?: {
    type: 'exponential' | 'fixed';
    /** Base delay in milliseconds */
    delay: number;
  };

  /** Correlation ID for end-to-end traceability across services and logs (R29) */
  correlationId?: string;

  /** Priority — lower number equals higher priority (1 = highest) */
  priority?: number;

  /**
   * Controls removal of completed jobs from the queue.
   * - `true`: remove immediately on completion
   * - `number`: keep the last N completed jobs
   * - `false` / `undefined`: retain all completed jobs
   */
  removeOnComplete?: boolean | number;

  /**
   * Controls removal of failed jobs from the queue.
   * - `true`: remove immediately on final failure (after all retry attempts exhausted)
   * - `number`: keep the last N failed jobs
   * - `false` / `undefined`: retain all failed jobs (dead-letter behavior)
   */
  removeOnFail?: boolean | number;
}

/**
 * Information about an enqueued job returned after successful enqueue.
 *
 * Contains the queue-assigned identifiers needed for job tracking and
 * observability purposes.
 */
export interface JobInfo {
  /** Unique job identifier assigned by the queue system */
  id: string;

  /** Name of the job / queue that the job was enqueued to */
  name: string;

  /** Unix timestamp (milliseconds) when the job was created */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Job Name Union Type
// ---------------------------------------------------------------------------

/**
 * All known job names processed by the BullMQ worker.
 *
 * Each entry maps to a dedicated job processor file in `workers/queue/src/jobs/`.
 * Using a string literal union ensures type-safe job enqueuing — callers cannot
 * enqueue arbitrary job names without updating this type.
 */
export type QueueJobName =
  | 'message-fanout'                // Group message delivery fan-out (R18)
  | 'sender-key-distribution'       // Sender Key redistribution on membership change (R14)
  | 'link-preview'                  // URL OG metadata extraction
  | 'story-cleanup'                 // Expired story and media purge (R11, R35)
  | 'audit-log-cleanup'            // 90-day audit log purge (R35)
  | 'prekey-replenish-notification'; // Low prekey warning notification

// ---------------------------------------------------------------------------
// Queue Provider Interface
// ---------------------------------------------------------------------------

/**
 * Queue provider contract abstracting asynchronous job processing.
 *
 * The concrete implementation uses BullMQ backed by Redis for reliable,
 * horizontally-scalable job queuing. This interface ensures services remain
 * decoupled from the queue infrastructure (R17).
 *
 * All methods are asynchronous since queue operations involve network I/O
 * to the Redis backend.
 */
export interface IQueueProvider {
  /**
   * Enqueue a single job for asynchronous processing.
   *
   * The job will be picked up by the corresponding worker processor registered
   * under the given `jobName`. Payloads are JSON-serialized for transport.
   *
   * @param jobName - Name of the job type (must be a valid QueueJobName)
   * @param payload - Job data payload (will be JSON-serialized by the queue)
   * @param options - Optional job configuration (delay, retries, priority, correlationId)
   * @returns Promise resolving to JobInfo with the queue-assigned job ID
   */
  enqueue(
    jobName: QueueJobName,
    payload: Record<string, unknown>,
    options?: JobOptions,
  ): Promise<JobInfo>;

  /**
   * Enqueue multiple jobs in a single atomic operation (bulk enqueue).
   *
   * Used primarily for fan-out scenarios where a single action needs to
   * trigger delivery to multiple recipients (R18). For example, a group
   * message triggers one `message-fanout` job per recipient.
   *
   * @param jobs - Array of job definitions, each with name, payload, and optional config
   * @returns Promise resolving to an array of JobInfo, one per enqueued job
   */
  enqueueBulk(
    jobs: Array<{
      name: QueueJobName;
      payload: Record<string, unknown>;
      options?: JobOptions;
    }>,
  ): Promise<JobInfo[]>;

  /**
   * Schedule a repeatable job on a cron schedule.
   *
   * Used for periodic background tasks that run on a fixed schedule:
   * - Story cleanup: `'0 * * * *'` (hourly) — R11, R35
   * - Audit log cleanup: `'0 0 * * 0'` (weekly Sunday midnight) — R35
   *
   * If a repeatable job with the same name and cron expression already exists,
   * the implementation should handle deduplication gracefully.
   *
   * @param jobName - Name of the job type
   * @param payload - Job data payload
   * @param cronExpression - Standard cron expression (e.g., '0 * * * *' for hourly)
   * @param options - Optional job configuration
   * @returns Promise resolving to JobInfo with the assigned job ID
   */
  scheduleRepeat(
    jobName: QueueJobName,
    payload: Record<string, unknown>,
    cronExpression: string,
    options?: JobOptions,
  ): Promise<JobInfo>;

  /**
   * Remove a previously scheduled repeatable job.
   *
   * Identifies the repeatable job by the combination of job name and
   * cron expression. After removal, the job will no longer be enqueued
   * on the specified schedule.
   *
   * @param jobName - Name of the job type
   * @param cronExpression - Cron expression of the repeatable job to remove
   */
  removeRepeat(
    jobName: QueueJobName,
    cronExpression: string,
  ): Promise<void>;

  /**
   * Get the current count of waiting (pending) jobs in the queue.
   *
   * Used by the health check endpoint and metrics collection (R37) to
   * monitor queue depth and detect potential processing bottlenecks.
   *
   * @param jobName - Optional filter by job name; if omitted, returns total across all job types
   * @returns Promise resolving to the number of waiting jobs
   */
  getQueueDepth(jobName?: QueueJobName): Promise<number>;

  /**
   * Close all queue connections gracefully.
   *
   * Must be called during server shutdown to ensure pending operations
   * complete and connections are properly released. After calling close(),
   * no further enqueue operations should be attempted.
   */
  close(): Promise<void>;
}
