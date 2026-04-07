// =============================================================================
// Kalle — WhatsApp Clone · BullMQ Worker Entry Point
// =============================================================================
//
// Composition root for the background job processing service.
//
// Responsibilities:
//   1. Validate required environment variables (Rule R26 — fail-fast)
//   2. Create Pino structured JSON logger (Rule R28 — zero console.log)
//   3. Connect to Redis with BullMQ-compatible settings
//   4. Initialize Prisma client for database operations
//   5. Register all 6 BullMQ workers with correlation ID propagation (R29)
//   6. Configure retry policies: 3 attempts, exponential backoff (R18)
//   7. Handle graceful shutdown (SIGTERM / SIGINT)
//
// Critical Rules Enforced:
//   R7  — Zero warnings build; strict TypeScript; no explicit `any` types.
//   R17 — Interface-driven dependencies; processors imported as modules.
//   R23 — Log hygiene: no tokens, passwords, ciphertext, or key material.
//   R26 — Environment validation on boot with descriptive failure messages.
//   R28 — ALL logging via Pino JSON output. Zero console.log.
//   R29 — Correlation ID extracted from job.data, propagated via Pino child.
//
// =============================================================================

import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';

// Internal job processor imports (Rule R17 — imported as modules, not inline)
import { processMessageFanout } from './jobs/message-fanout.js';
import { processSenderKeyDistribution } from './jobs/sender-key-distribution.js';
import { processLinkPreview } from './jobs/link-preview.js';
import { processStoryCleanup } from './jobs/story-cleanup.js';
import { processAuditLogCleanup } from './jobs/audit-log-cleanup.js';
import { processPrekeyReplenishNotification } from './jobs/prekey-replenish-notification.js';

// =============================================================================
// Exported Type Definitions
// =============================================================================

/**
 * Shared execution context provided to every job processor function.
 *
 * Contains infrastructure handles for database, logging, and Redis operations.
 * Each job processor file defines a structurally compatible local interface
 * to avoid circular imports — this is the canonical definition.
 */
export interface WorkerContext {
  /** Prisma ORM client for PostgreSQL database operations. */
  prisma: PrismaClient;

  /** Pino structured logger instance (Rule R28). */
  logger: pino.Logger;

  /** IORedis connection for pub/sub and cache operations. */
  redisConnection: Redis;
}

/**
 * Generic type for job processor functions.
 *
 * Every job processor follows this signature: receives a BullMQ Job and
 * a {@link WorkerContext}, performs its work, and resolves void on success.
 *
 * @typeParam T - Job payload data type. Defaults to `unknown`.
 */
export type JobProcessor<T = unknown> = (
  job: Job<T>,
  context: WorkerContext,
) => Promise<void>;

// =============================================================================
// Exported Constants
// =============================================================================

/**
 * BullMQ queue name constants for all 6 worker queues.
 *
 * Used by both the worker (consumer) and the API server (producer) to
 * reference queues consistently. Exported so the API service layer can
 * enqueue jobs with the correct queue names.
 */
export const QUEUE_NAMES = {
  MESSAGE_FANOUT: 'message-fanout',
  SENDER_KEY_DISTRIBUTION: 'sender-key-distribution',
  LINK_PREVIEW: 'link-preview',
  STORY_CLEANUP: 'story-cleanup',
  AUDIT_LOG_CLEANUP: 'audit-log-cleanup',
  PREKEY_REPLENISH: 'prekey-replenish-notification',
} as const;

/**
 * Default BullMQ job options applied to all queues.
 *
 * Retry policy: 3 attempts with exponential backoff (1 s → 4 s → 16 s),
 * then dead-letter. Completed jobs retained (last 1 000) for debugging;
 * failed jobs retained (last 5 000) for investigation.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1000,
  },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
} as const;

// =============================================================================
// Internal Types
// =============================================================================

/** Validated and typed environment configuration. */
interface ValidatedEnv {
  redisUrl: string;
  databaseUrl: string;
  logLevel: string;
}

// =============================================================================
// Environment Validation (Rule R26)
// =============================================================================

/**
 * Validates all required environment variables on boot.
 *
 * Fails fast with a descriptive Pino fatal log listing every missing
 * variable. The worker process MUST NOT start processing jobs when
 * required configuration is absent.
 */
function validateEnvironment(logger: pino.Logger): ValidatedEnv {
  const errors: string[] = [];

  const bullRedisUrl = process.env['BULL_REDIS_URL'];
  const redisUrl = process.env['REDIS_URL'];
  const databaseUrl = process.env['DATABASE_URL'];
  const logLevel = process.env['LOG_LEVEL'] || 'info';

  if (!bullRedisUrl && !redisUrl) {
    errors.push('Either BULL_REDIS_URL or REDIS_URL must be provided');
  }

  if (!databaseUrl) {
    errors.push('DATABASE_URL is required');
  }

  if (errors.length > 0) {
    logger.fatal(
      { missingVariables: errors, variableCount: errors.length },
      'Environment validation failed — worker cannot start',
    );
    process.exit(1);
  }

  // Non-null assertions are safe here — validated above
  return {
    redisUrl: (bullRedisUrl || redisUrl) as string,
    databaseUrl: databaseUrl as string,
    logLevel,
  };
}

// =============================================================================
// Logger Factory (Rule R28)
// =============================================================================

/**
 * Creates the root Pino structured JSON logger for the worker process.
 *
 * Configuration:
 * - ISO 8601 timestamps for structured log aggregation
 * - Level label formatting for human readability
 * - Named logger for service identification in aggregated log streams
 */
function createLogger(logLevel: string): pino.Logger {
  return pino({
    name: 'kalle-worker',
    level: logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
  });
}

// =============================================================================
// Processor Wrapper (Rules R29, R23)
// =============================================================================

/**
 * Wraps a job processor function with correlation ID propagation,
 * structured logging, and timing instrumentation.
 *
 * For each job execution the wrapper:
 *   1. Extracts `correlationId` from `job.data` (Rule R29)
 *   2. Creates a Pino child logger with per-job correlation context
 *   3. Logs job start with queue name
 *   4. Invokes the processor with the enriched {@link WorkerContext}
 *   5. Logs job completion with duration in milliseconds
 *   6. On failure, logs a sanitised error message (Rule R23) and re-throws
 *      so BullMQ applies its retry policy
 */
function createProcessorWrapper(
  processorFn: (job: Job, context: WorkerContext) => Promise<void>,
  baseContext: WorkerContext,
): (job: Job) => Promise<void> {
  return async (job: Job): Promise<void> => {
    // Extract correlation ID from job payload (Rule R29).
    // Cast to Record for safe property access without relying on implicit any.
    const data = job.data as Record<string, unknown>;
    const correlationId =
      typeof data['correlationId'] === 'string'
        ? data['correlationId']
        : 'unknown';

    // Create child logger scoped to this job execution
    const jobLogger = baseContext.logger.child({
      correlationId,
      jobId: job.id,
      jobName: job.name,
    });

    const jobContext: WorkerContext = {
      prisma: baseContext.prisma,
      logger: jobLogger,
      redisConnection: baseContext.redisConnection,
    };

    const startTime = Date.now();
    jobLogger.info({ queue: job.queueName }, 'Job started');

    try {
      await processorFn(job, jobContext);
      const durationMs = Date.now() - startTime;
      jobLogger.info({ queue: job.queueName, durationMs }, 'Job completed');
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      // Sanitised error — no ciphertext, tokens, or key material (Rule R23)
      const errorMessage = err instanceof Error ? err.message : String(err);
      jobLogger.error(
        { queue: job.queueName, error: errorMessage, durationMs },
        'Job processing failed',
      );
      throw err;
    }
  };
}

// =============================================================================
// Worker Event Registration
// =============================================================================

/**
 * Attaches standard event listeners to a BullMQ Worker instance.
 *
 * CRITICAL: The `failed` handler does NOT log `job.data` — it may
 * contain sensitive payloads (ciphertext, encryption keys) per Rule R23.
 */
function registerWorkerEvents(worker: Worker, logger: pino.Logger): void {
  worker.on('completed', (job) => {
    logger.info(
      { jobId: job.id, queue: job.queueName },
      'Worker event: job completed',
    );
  });

  worker.on('failed', (job, err) => {
    // CRITICAL: Do NOT log job.data — may contain sensitive payloads (R23)
    logger.error(
      { jobId: job?.id, queue: job?.queueName, error: err.message },
      'Worker event: job failed',
    );
  });

  worker.on('error', (err) => {
    logger.error({ error: err.message }, 'Worker error');
  });
}

// =============================================================================
// Worker Creation
// =============================================================================

/**
 * Shared queue name matching the API producer's BullMQ Queue.
 *
 * The API's `QueueProvider` enqueues ALL job types to a single queue
 * named `'kalle-jobs'` using the job name (e.g., `'link-preview'`,
 * `'message-fanout'`) as the BullMQ job name field. This unified
 * Worker listens on the same queue and dispatches each job to the
 * correct processor based on `job.name`.
 */
const SHARED_QUEUE_NAME = 'kalle-jobs';

/**
 * Maximum concurrency for the unified worker.
 * Set to the highest concurrency needed by any individual job type
 * to allow concurrent processing across different job types.
 */
const UNIFIED_WORKER_CONCURRENCY = 5;

/**
 * Creates a single unified BullMQ Worker on the `kalle-jobs` queue.
 *
 * The API producer enqueues all job types to a single queue named
 * `kalle-jobs`. Each job carries its type in the BullMQ `job.name`
 * field (e.g., `'link-preview'`, `'message-fanout'`). The dispatch
 * processor routes each incoming job to the correct processor function
 * based on `job.name`, preserving all 6 processor implementations,
 * correlation ID propagation, and structured logging.
 */
function createAllWorkers(
  baseContext: WorkerContext,
  redisConnection: Redis,
): Worker[] {
  // Job name → processor dispatch map
  const processorMap = new Map<string, (job: Job, context: WorkerContext) => Promise<void>>([
    [QUEUE_NAMES.MESSAGE_FANOUT, processMessageFanout],
    [QUEUE_NAMES.SENDER_KEY_DISTRIBUTION, processSenderKeyDistribution],
    [QUEUE_NAMES.LINK_PREVIEW, processLinkPreview],
    [QUEUE_NAMES.STORY_CLEANUP, processStoryCleanup],
    [QUEUE_NAMES.AUDIT_LOG_CLEANUP, processAuditLogCleanup],
    [QUEUE_NAMES.PREKEY_REPLENISH, processPrekeyReplenishNotification],
  ]);

  // Dispatch processor that routes jobs by name to the correct handler
  const dispatchProcessor = async (
    job: Job,
    context: WorkerContext,
  ): Promise<void> => {
    const processor = processorMap.get(job.name);
    if (!processor) {
      context.logger.error(
        { jobName: job.name, jobId: job.id },
        'Unknown job name received — no matching processor registered',
      );
      return;
    }
    await processor(job, context);
  };

  // Wrap with correlation ID propagation, logging, and timing (R29, R28)
  const wrappedProcessor = createProcessorWrapper(dispatchProcessor, baseContext);

  // Create a single Worker on the shared queue matching the API producer
  const worker = new Worker(SHARED_QUEUE_NAME, wrappedProcessor, {
    connection: redisConnection,
    concurrency: UNIFIED_WORKER_CONCURRENCY,
  });

  registerWorkerEvents(worker, baseContext.logger);

  baseContext.logger.info(
    {
      queue: SHARED_QUEUE_NAME,
      concurrency: UNIFIED_WORKER_CONCURRENCY,
      registeredJobs: Array.from(processorMap.keys()),
    },
    'Unified worker registered for all job types',
  );

  return [worker];
}

// =============================================================================
// Graceful Shutdown
// =============================================================================

/** Flag preventing duplicate shutdown sequences from concurrent signals. */
let isShuttingDown = false;

/**
 * Gracefully shuts down all workers, database, and Redis connections.
 *
 * Handles SIGTERM, SIGINT, uncaught exceptions, and unhandled rejections.
 * Uses a module-level flag to prevent double-shutdown when multiple
 * signals arrive in quick succession.
 */
async function gracefulShutdown(
  signal: string,
  workers: Worker[],
  prisma: PrismaClient,
  redisConnection: Redis,
  logger: pino.Logger,
): Promise<void> {
  if (isShuttingDown) {
    logger.warn(
      { signal },
      'Shutdown already in progress — ignoring duplicate signal',
    );
    return;
  }
  isShuttingDown = true;

  logger.info({ signal }, 'Received shutdown signal, closing workers...');

  try {
    // 1. Close all BullMQ workers (stop accepting, wait for in-progress jobs)
    const results = await Promise.allSettled(
      workers.map((w) => w.close()),
    );

    const closedCount = results.filter((r) => r.status === 'fulfilled').length;
    const failedCount = results.filter((r) => r.status === 'rejected').length;
    logger.info(
      { closedCount, failedCount, totalWorkers: workers.length },
      'BullMQ workers closed',
    );

    // 2. Disconnect Prisma client
    await prisma.$disconnect();
    logger.info('Prisma client disconnected');

    // 3. Close Redis connection
    await redisConnection.quit();
    logger.info('Redis connection closed');

    logger.info('Worker process shut down successfully');
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ error: errorMessage }, 'Error during shutdown');
  }

  process.exit(0);
}

// =============================================================================
// Main Bootstrap
// =============================================================================

/**
 * Main entry point — initialises all infrastructure, registers workers,
 * and configures signal handlers.
 *
 * Execution order:
 *   1. Create logger (needed for all subsequent steps)
 *   2. Validate environment variables (Rule R26 — fail-fast)
 *   3. Connect to Redis with BullMQ-required settings
 *   4. Initialise and connect Prisma client
 *   5. Build shared WorkerContext
 *   6. Register all 6 BullMQ workers
 *   7. Register shutdown signal handlers
 *   8. Log boot completion with PID and queue names
 */
async function main(): Promise<void> {
  // 1. Create root logger (Rule R28 — zero console.log from this point)
  const preLogger = createLogger(process.env['LOG_LEVEL'] || 'info');
  preLogger.info('Worker process starting...');

  // 2. Validate environment (Rule R26 — fail-fast on missing vars)
  const env = validateEnvironment(preLogger);

  // Re-create logger with the validated log level
  const logger = createLogger(env.logLevel);

  // 3. Connect to Redis
  // CRITICAL: maxRetriesPerRequest: null is REQUIRED by BullMQ.
  // enableReadyCheck: false avoids issues with Redis sentinel/cluster.
  // lazyConnect: true allows error handler attachment before connection.
  const redisConnection = new Redis(env.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });

  redisConnection.on('connect', () => {
    logger.info('Redis connection established');
  });

  redisConnection.on('error', (err) => {
    logger.error({ error: err.message }, 'Redis connection error');
  });

  await redisConnection.connect();

  // Log Redis URL with credentials masked (Rule R23 — no secrets in logs)
  const maskedUrl = env.redisUrl.replace(/\/\/.*@/, '//***@');
  logger.info({ redisUrl: maskedUrl }, 'Connected to Redis');

  // 4. Initialise Prisma client
  const prisma = new PrismaClient({
    log: [
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  });

  // Forward Prisma log events to Pino (Rule R28 — no console output)
  prisma.$on('error', (event) => {
    logger.error(
      { target: event.target, message: event.message },
      'Prisma error',
    );
  });

  prisma.$on('warn', (event) => {
    logger.warn(
      { target: event.target, message: event.message },
      'Prisma warning',
    );
  });

  await prisma.$connect();
  logger.info('Prisma client connected to database');

  // 5. Build shared worker context
  const baseContext: WorkerContext = {
    prisma,
    logger,
    redisConnection,
  };

  // 6. Register all 6 BullMQ workers
  const workers = createAllWorkers(baseContext, redisConnection);

  // 7. Register shutdown signal handlers
  const shutdown = (signal: string): void => {
    gracefulShutdown(signal, workers, prisma, redisConnection, logger).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.fatal({ error: msg }, 'Fatal error during shutdown');
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ error: err.message }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason: String(reason) }, 'Unhandled rejection');
    shutdown('unhandledRejection');
  });

  // 8. Log boot completion
  logger.info(
    {
      queue: SHARED_QUEUE_NAME,
      registeredJobs: Object.values(QUEUE_NAMES),
      workerCount: workers.length,
      pid: process.pid,
    },
    'All workers registered and ready',
  );
}

// =============================================================================
// Entry Point
// =============================================================================

// Create a minimal logger for the top-level error handler.
// The production logger is created inside main() after environment validation.
const bootLogger = createLogger(process.env['LOG_LEVEL'] || 'info');

main().catch((err: unknown) => {
  const errorMessage = err instanceof Error ? err.message : String(err);
  bootLogger.fatal({ error: errorMessage }, 'Worker failed to start');
  process.exit(1);
});
