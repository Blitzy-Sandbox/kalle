/**
 * @file CacheProvider.ts
 * @description Concrete implementation of the ICacheProvider interface.
 *
 * Wraps an ioredis client to provide typed caching operations with JSON
 * serialization, TTL support, atomic operations for rate limiting and
 * counters, and token blacklist management for JWT revocation (Rule R33).
 *
 * This is one of the most frequently called providers — used for:
 * - Presence tracking (online/offline status with TTL)
 * - Participant lists caching
 * - Unread message counts (via atomic incr)
 * - Rate limiting (via incr + expire)
 * - JWT token blacklist for session revocation (Rule R33)
 * - Typing indicator state with TTL
 * - Distributed locks (via setNx)
 *
 * Architecture Rules:
 * - R17: Only the composition root (server.ts) imports this concrete class.
 *        All other consumers import the ICacheProvider interface.
 * - R33: Revoked access tokens blacklisted in Redis keyed by JTI with
 *        TTL = remaining token expiry.
 * - R28: Zero console.log calls — structured logging only.
 * - R7:  Compiles under tsc --noEmit --strict with zero warnings.
 */

import type { Redis } from 'ioredis';

import type { ICacheProvider } from '../domain/interfaces/ICacheProvider';

/**
 * Redis-backed cache provider implementing the ICacheProvider contract.
 *
 * All values are JSON-serialized on write and JSON-parsed on read,
 * enabling type-safe caching of complex objects. The provider receives
 * a pre-configured ioredis client via constructor injection, allowing
 * the composition root to manage connection lifecycle.
 *
 * @example
 * ```typescript
 * // In server.ts (composition root):
 * const redis = createRedisClient();
 * const cacheProvider = new CacheProvider(redis);
 *
 * // Token blacklist (Rule R33):
 * await cacheProvider.set(`blacklist:${jti}`, true, remainingExpiry);
 * const isBlacklisted = await cacheProvider.exists(`blacklist:${jti}`);
 *
 * // Rate limiting:
 * const count = await cacheProvider.incr(`ratelimit:${ip}:${window}`);
 * await cacheProvider.expire(`ratelimit:${ip}:${window}`, 60);
 * ```
 */
export class CacheProvider implements ICacheProvider {
  /**
   * Pre-configured ioredis client instance.
   * Injected via constructor by the composition root (server.ts).
   */
  private readonly redis: Redis;

  /**
   * Creates a new CacheProvider wrapping the given ioredis client.
   *
   * The Redis client should be pre-configured with connection parameters
   * (host, port, password, etc.) by the composition root. This class
   * does not manage the Redis connection lifecycle.
   *
   * @param redis - Pre-configured ioredis client instance
   */
  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Retrieve a cached value by key with automatic JSON deserialization.
   *
   * Returns null if the key does not exist or has expired. If the stored
   * value is valid JSON, it is parsed and returned as type T. If parsing
   * fails (e.g., the value was set by another Redis client without JSON
   * serialization), the raw string is returned cast to T.
   *
   * @typeParam T - Expected type of the cached value
   * @param key - Cache key string
   * @returns Parsed value of type T, or null if the key does not exist
   */
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw === null) {
      return null;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      // Value is not valid JSON — return the raw string cast to T.
      // This gracefully handles simple string values stored by other
      // Redis clients or tools that bypass JSON serialization.
      return raw as unknown as T;
    }
  }

  /**
   * Store a value in cache with optional TTL.
   *
   * The value is JSON-serialized before storage. When ttlSeconds is
   * provided, Redis SETEX is used for atomic set-with-expiry semantics.
   * When omitted, the key persists until explicit deletion via del().
   *
   * Token blacklist usage (Rule R33):
   *   await cache.set(`blacklist:${jti}`, true, remainingExpirySeconds);
   *
   * @param key - Cache key string
   * @param value - Value to cache (must be JSON-serializable)
   * @param ttlSeconds - Optional time-to-live in seconds
   */
  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);

    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.redis.setex(key, ttlSeconds, serialized);
    } else {
      await this.redis.set(key, serialized);
    }
  }

  /**
   * Delete a cached key.
   *
   * This operation is idempotent — calling del() on a non-existent key
   * does not throw an error or produce any side effects.
   *
   * @param key - Cache key string
   */
  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /**
   * Check if a key exists in cache.
   *
   * Returns true only if the key exists and has not expired. This method
   * is the primary mechanism for JWT token blacklist checks (Rule R33):
   *
   *   const isBlacklisted = await cache.exists(`blacklist:${jti}`);
   *
   * @param key - Cache key string
   * @returns true if the key exists and has not expired, false otherwise
   */
  async exists(key: string): Promise<boolean> {
    const result = await this.redis.exists(key);
    return result === 1;
  }

  /**
   * Set a value only if the key does not already exist (SET NX semantics).
   *
   * This is an atomic operation useful for implementing distributed locks,
   * idempotency checks, and other optimistic concurrency patterns. When
   * ttlSeconds is provided, the atomic SET ... NX EX command is used to
   * ensure the key is set with expiry in a single round-trip.
   *
   * @param key - Cache key string
   * @param value - Value to cache (must be JSON-serializable)
   * @param ttlSeconds - Optional time-to-live in seconds
   * @returns true if the key was set (did not exist), false if it already existed
   */
  async setNx(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    const serialized = JSON.stringify(value);

    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      // Atomic conditional set with expiry: SET key value EX ttl NX
      const result = await this.redis.set(key, serialized, 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    }

    const result = await this.redis.setnx(key, serialized);
    return result === 1;
  }

  /**
   * Increment a numeric value atomically.
   *
   * If the key does not exist, it is initialized to 0 before incrementing,
   * resulting in a value of 1. This is an atomic operation safe for
   * concurrent use across multiple API server instances.
   *
   * Common use cases:
   * - Rate limiting: incr(`ratelimit:${ip}:${window}`)
   * - Unread counts: incr(`unread:${conversationId}:${userId}`)
   *
   * @param key - Cache key string
   * @returns The new value after increment
   */
  async incr(key: string): Promise<number> {
    return await this.redis.incr(key);
  }

  /**
   * Set expiration on an existing key.
   *
   * Applies a TTL to a key that may have been created without one, or
   * resets the TTL on an existing key. Returns false if the key does
   * not exist — no timeout can be set on a non-existent key.
   *
   * Commonly paired with incr() for rate limiting windows:
   *   const count = await cache.incr(key);
   *   if (count === 1) await cache.expire(key, windowSeconds);
   *
   * @param key - Cache key string
   * @param ttlSeconds - Time-to-live in seconds
   * @returns true if the timeout was set, false if the key does not exist
   */
  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.expire(key, ttlSeconds);
    return result === 1;
  }

  /**
   * Get remaining TTL for a key in seconds.
   *
   * Return value semantics:
   * - Positive number: remaining seconds until expiry
   * - -1: key exists but has no associated expiry (persists indefinitely)
   * - -2: key does not exist
   *
   * @param key - Cache key string
   * @returns TTL in seconds, -1 for no expiry, -2 for non-existent key
   */
  async ttl(key: string): Promise<number> {
    return await this.redis.ttl(key);
  }
}
