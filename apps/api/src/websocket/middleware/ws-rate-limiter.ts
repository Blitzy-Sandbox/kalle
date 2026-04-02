/**
 * @file ws-rate-limiter.ts
 * @description Per-connection WebSocket rate limiter using Redis-backed sliding
 * window counters via ICacheProvider.
 *
 * Implements Rule R25 — three distinct rate limit tiers per connection:
 *   - message:send  → 30 events / 60-second window
 *   - typing:start  → 10 events / 60-second window
 *   - all others    → 60 events / 60-second window
 *
 * When a limit is exceeded, `checkLimit` returns `false` — the caller
 * (event handler) is responsible for disconnecting the socket with a
 * `rate-limit-exceeded` error code.
 *
 * Architecture rules applied:
 *   R7  — Zero warnings build (TypeScript strict, explicit types, no `any`)
 *   R17 — Interface-driven dependencies (ICacheProvider, not concrete Redis)
 *   R25 — WebSocket rate limiting (per-connection sliding window)
 *   R28 — Structured logging only (zero console.* calls)
 *   R29 — Correlation ID propagation (socketId used for key scoping)
 */

import type { ICacheProvider } from '../../domain/interfaces/ICacheProvider';

// ---------------------------------------------------------------------------
// Rate-Limit Tier Configuration
// ---------------------------------------------------------------------------

/**
 * Describes a single rate-limit tier: maximum allowed requests within a
 * sliding time window expressed in seconds.
 */
interface RateLimitTier {
  /** Maximum number of events allowed within the window. */
  readonly maxRequests: number;
  /** Duration of the sliding window in seconds. */
  readonly windowSeconds: number;
}

/**
 * Per-connection rate-limit tiers enforced by the WebSocket layer (R25).
 *
 * - `message:send` — 30 events per 60 s
 * - `typing:start` — 10 events per 60 s
 * - `default`      — 60 events per 60 s (all other event types)
 *
 * Exported so that tests and documentation can reference the exact limits.
 */
export const RATE_LIMITS: Readonly<Record<string, RateLimitTier>> = {
  'message:send': { maxRequests: 30, windowSeconds: 60 },
  'typing:start': { maxRequests: 10, windowSeconds: 60 },
  default: { maxRequests: 60, windowSeconds: 60 },
};

// ---------------------------------------------------------------------------
// WsRateLimiter Interface
// ---------------------------------------------------------------------------

/**
 * Public contract returned by {@link createWsRateLimiter}.
 *
 * Handlers call `checkLimit` before processing each incoming event.
 * On socket disconnect, the connection layer calls `cleanup` to remove
 * all rate-limit keys from Redis, preventing stale key accumulation.
 */
export interface WsRateLimiter {
  /**
   * Checks whether the current event is within the rate limit for the
   * given event name.
   *
   * @param eventName - The Socket.IO event name (e.g. `"message:send"`)
   * @returns `true` if the request is within the limit; `false` if the
   *          limit has been exceeded (caller should disconnect the socket)
   */
  checkLimit(eventName: string): Promise<boolean>;

  /**
   * Removes all rate-limit keys associated with this connection from
   * Redis. Must be called when the socket disconnects to free memory.
   */
  cleanup(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

/**
 * Creates a per-connection WebSocket rate limiter backed by Redis atomic
 * counters.
 *
 * The returned {@link WsRateLimiter} uses the `INCR` + `EXPIRE` pattern:
 *
 * 1. Atomically increment the counter for the (socketId, event) pair.
 * 2. On the **first** increment (count === 1), set a TTL equal to the
 *    window duration so the counter auto-resets after the window elapses.
 * 3. If the counter exceeds `maxRequests`, signal that the limit is
 *    exceeded by returning `false`.
 *
 * @param cacheProvider - ICacheProvider instance for Redis operations
 * @param socketId      - Unique Socket.IO connection identifier used to
 *                        scope rate-limit keys
 * @returns A {@link WsRateLimiter} bound to the given connection
 */
export function createWsRateLimiter(
  cacheProvider: ICacheProvider,
  socketId: string,
): WsRateLimiter {
  /**
   * Tracks every Redis key touched by this connection so that `cleanup`
   * deletes only the keys that were actually used — avoids unnecessary
   * DEL calls for tiers the client never triggered.
   */
  const activeKeys: Set<string> = new Set<string>();

  /**
   * Resolve the appropriate rate-limit tier for a given event name.
   * Falls back to `RATE_LIMITS.default` for unrecognised events.
   */
  function resolveTier(eventName: string): { tier: RateLimitTier; key: string } {
    const isSpecific = Object.prototype.hasOwnProperty.call(RATE_LIMITS, eventName) && eventName !== 'default';
    const tier: RateLimitTier = isSpecific
      ? RATE_LIMITS[eventName]
      : RATE_LIMITS['default'];

    const keySegment = isSpecific ? eventName : 'default';
    const key = `ratelimit:ws:${socketId}:${keySegment}`;

    return { tier, key };
  }

  // --- Public interface implementation ------------------------------------

  async function checkLimit(eventName: string): Promise<boolean> {
    const { tier, key } = resolveTier(eventName);

    // Track the key for cleanup on disconnect
    activeKeys.add(key);

    // Atomically increment — Redis creates the key with value 1 if absent
    const currentCount: number = await cacheProvider.incr(key);

    // Set TTL only on the first request in a new window
    if (currentCount === 1) {
      await cacheProvider.expire(key, tier.windowSeconds);
    }

    // Determine whether the limit has been exceeded
    return currentCount <= tier.maxRequests;
  }

  async function cleanup(): Promise<void> {
    if (activeKeys.size === 0) {
      return;
    }

    const deletePromises: Array<Promise<void>> = [];
    for (const key of activeKeys) {
      deletePromises.push(cacheProvider.del(key));
    }
    await Promise.all(deletePromises);

    activeKeys.clear();
  }

  return { checkLimit, cleanup };
}
