// =============================================================================
// Kalle — WhatsApp Clone · Redis Client Initialization
// =============================================================================
//
// Creates and configures ioredis client instances with automatic reconnection
// strategy, max retries, and health-check ping capability. Called by the
// composition root (`server.ts`) to create the Redis client used by:
//   - CacheProvider     (presence, participant lists, unread counts, token blacklist)
//   - QueueProvider     (BullMQ job queue)
//   - RealtimeProvider  (Socket.IO Redis adapter for horizontal scaling)
//   - Auth middleware    (JWT token blacklist lookups)
//
// Two factory functions are exported:
//   - `createRedisClient`     — primary Redis client factory
//   - `createRedisSubscriber` — subscriber-optimised factory for BullMQ / Socket.IO
//
// Architecture Rules:
//   R28 — Zero console.log calls. The composition root or LoggerProvider
//         attaches event listeners (connect, error, reconnecting) after client
//         creation. This keeps the factory pure.
//   R38 — Redis connection uses Docker Compose service hostname `redis`
//         (REDIS_URL=redis://redis:6379 in .env.example).
//   R7  — Compiles under tsc --noEmit --strict with zero warnings.
//   R26 — This module does NOT validate env vars. It receives a pre-validated
//         `redisUrl` string from the composition root (which validates via
//         config/env.ts).
//
// =============================================================================

import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';

// =============================================================================
// Constants
// =============================================================================

/** Base delay (ms) between reconnection attempts. Multiplied by attempt number. */
const RECONNECT_BASE_DELAY_MS = 200;

/** Upper bound (ms) for the computed reconnection delay. */
const RECONNECT_MAX_DELAY_MS = 5000;

/** Maximum retries per individual Redis command before throwing. */
const MAX_RETRIES_PER_REQUEST = 3;

/** Timeout (ms) for the initial TCP connection. Generous for Docker startup. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Timeout (ms) per Redis command. Prevents hung operations. */
const COMMAND_TIMEOUT_MS = 5_000;

// =============================================================================
// Primary Factory: createRedisClient
// =============================================================================

/**
 * Creates and returns a new ioredis `Redis` client configured with production-
 * grade defaults for the Kalle API server.
 *
 * The returned client connects immediately (no lazy connect) so that
 * connectivity errors surface at boot time (fail-fast).
 *
 * The caller (composition root) is responsible for:
 *  1. Verifying connectivity: `await redis.ping()`
 *  2. Attaching event listeners for structured logging
 *  3. Calling `await redis.quit()` on graceful shutdown
 *
 * @param redisUrl - The fully validated Redis connection URL
 *   (e.g., `redis://redis:6379`). Passed from the composition root after
 *   environment validation via `config/env.ts`.
 *
 * @param options - Optional partial `RedisOptions` that override the defaults
 *   defined below. Used for testing or BullMQ-specific configurations.
 *
 * @returns A new `Redis` client instance connected to the specified URL.
 *
 * @example
 * ```typescript
 * // In server.ts (composition root):
 * import { createRedisClient } from './config/redis.js';
 *
 * const redis = createRedisClient(env.REDIS_URL);
 * await redis.ping(); // Verify connectivity
 * logger.info('Redis connected');
 *
 * // Graceful shutdown:
 * await redis.quit();
 * ```
 */
export function createRedisClient(
  redisUrl: string,
  options?: Partial<RedisOptions>,
): Redis {
  const client = new Redis(redisUrl, {
    // ------------------------------------------------------------------
    // Reconnection strategy: exponential backoff WITHOUT permanent give-up
    // ------------------------------------------------------------------
    // Returns the delay in ms before the next reconnect attempt.
    //
    // Never returns `null` — ioredis will keep retrying indefinitely so
    // the health check recovers automatically once Redis comes back,
    // without requiring an API container restart (Issue 4 fix).
    //
    // Progression: 200ms → 400ms → … → capped at 5 000ms.
    // ------------------------------------------------------------------
    retryStrategy(times: number): number {
      return Math.min(times * RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS);
    },

    // ------------------------------------------------------------------
    // Command retry behaviour
    // ------------------------------------------------------------------
    // Individual commands that do not receive a reply (e.g. due to a
    // transient disconnection) are retried up to this many times before a
    // MaxRetriesPerRequestError is thrown.
    // ------------------------------------------------------------------
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,

    // ------------------------------------------------------------------
    // Connection settings
    // ------------------------------------------------------------------
    // enableReadyCheck: Sends an INFO command after TCP connect to verify
    //   that Redis has finished loading data from disk. The client emits
    //   the `ready` event only after this check passes.
    //
    // lazyConnect: false → connect immediately on construction so that
    //   connectivity errors surface at boot time (fail-fast).
    //
    // connectTimeout: 10 seconds — generous to accommodate Docker Compose
    //   service startup order and the wait-for-it.sh readiness script.
    //
    // commandTimeout: 5 seconds per command — prevents hung operations
    //   from blocking the event loop indefinitely.
    // ------------------------------------------------------------------
    enableReadyCheck: true,
    lazyConnect: false,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,

    // ------------------------------------------------------------------
    // Offline queue behaviour
    // ------------------------------------------------------------------
    // When true, commands issued while the client is disconnected (e.g.
    // during a brief Redis blip) are queued in memory and replayed once
    // the connection is re-established. This prevents message loss during
    // transient network interruptions.
    // ------------------------------------------------------------------
    enableOfflineQueue: true,

    // ------------------------------------------------------------------
    // Caller overrides
    // ------------------------------------------------------------------
    // Spread custom options LAST so they can override any of the above
    // defaults. Used by createRedisSubscriber() and testing utilities.
    // ------------------------------------------------------------------
    ...options,
  });

  return client;
}

// =============================================================================
// Subscriber Factory: createRedisSubscriber
// =============================================================================

/**
 * Creates a Redis client optimised for pub/sub subscriber connections.
 *
 * Both the Socket.IO Redis adapter and BullMQ require **separate** Redis
 * connections for command and subscriber channels. This factory produces a
 * connection tailored for subscriber use:
 *
 *  - `maxRetriesPerRequest: null` — Required by BullMQ; allows the worker
 *    to wait indefinitely for a response on blocking commands (BRPOPLPUSH)
 *    without throwing MaxRetriesPerRequestError.
 *
 *  - `enableReadyCheck: false` — Subscriber connections do not need the
 *    INFO-based ready check since they do not issue regular commands.
 *
 * @param redisUrl - The fully validated Redis connection URL
 *   (e.g., `redis://redis:6379`). Passed from the composition root after
 *   environment validation.
 *
 * @returns A new `Redis` client configured for subscriber / BullMQ usage.
 *
 * @example
 * ```typescript
 * // Socket.IO Redis adapter (two separate connections):
 * import { createRedisClient, createRedisSubscriber } from './config/redis.js';
 *
 * const pubClient  = createRedisClient(env.REDIS_URL);
 * const subClient  = createRedisSubscriber(env.REDIS_URL);
 *
 * io.adapter(createAdapter(pubClient, subClient));
 *
 * // BullMQ worker:
 * const workerConnection = createRedisSubscriber(env.REDIS_URL);
 * const worker = new Worker('my-queue', processor, { connection: workerConnection });
 * ```
 */
export function createRedisSubscriber(redisUrl: string): Redis {
  return createRedisClient(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}
