/**
 * @file ICacheProvider.ts
 * @description Cache provider interface abstracting Redis for caching operations.
 *
 * This interface defines the contract for all cache interactions consumed by
 * services that need caching functionality — including presence tracking,
 * participant lists, unread counts, and JWT token blacklist (R33).
 *
 * The concrete implementation (CacheProvider) uses ioredis. Services import
 * ONLY this interface — never the concrete Redis class (Rule R17).
 *
 * Architecture Rules:
 * - R17: Interface-driven dependencies — services code against this interface
 * - R33: Session revocation — cache stores revoked JWT tokens (keyed by JTI)
 * - R16: OOD layering — provider interface abstracts infrastructure (Redis)
 * - R7:  Zero warnings build — TypeScript strict mode compatible
 * - R28: Structured logging — zero console.log calls
 */

/**
 * Cache provider contract abstracting Redis for caching operations.
 *
 * All methods are asynchronous (returning Promise) since the underlying
 * cache store (Redis) operates over the network. Values are internally
 * serialized as JSON — callers should only pass JSON-serializable values.
 *
 * No Redis-specific types leak through this interface. The concrete
 * implementation handles all ioredis details internally.
 */
export interface ICacheProvider {
  /**
   * Retrieve a cached value by key.
   *
   * The value is deserialized from JSON and cast to the generic type T.
   * Returns null if the key does not exist or has expired.
   *
   * @typeParam T - Expected type of the cached value
   * @param key - Cache key string
   * @returns Parsed value of type T, or null if the key does not exist
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Store a value in cache with optional TTL.
   *
   * The value is serialized to JSON before storage. If ttlSeconds is
   * provided, the key automatically expires after that duration. If
   * ttlSeconds is omitted, the key persists until explicitly deleted.
   *
   * @param key - Cache key string
   * @param value - Value to cache (must be JSON-serializable)
   * @param ttlSeconds - Optional time-to-live in seconds
   */
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;

  /**
   * Delete a cached key.
   *
   * This operation is idempotent — no error is thrown if the key
   * does not exist.
   *
   * @param key - Cache key string
   */
  del(key: string): Promise<void>;

  /**
   * Check if a key exists in cache.
   *
   * Returns true only if the key exists and has not expired. Used by
   * the auth middleware to check the JWT token blacklist (R33).
   *
   * @param key - Cache key string
   * @returns true if the key exists and has not expired, false otherwise
   */
  exists(key: string): Promise<boolean>;

  /**
   * Set a value only if the key does not already exist (SET NX semantics).
   *
   * This is an atomic operation useful for implementing distributed locks
   * and idempotency checks. If the key already exists, the value is not
   * overwritten and the method returns false.
   *
   * @param key - Cache key string
   * @param value - Value to cache (must be JSON-serializable)
   * @param ttlSeconds - Optional time-to-live in seconds
   * @returns true if the key was set (did not exist), false if it already existed
   */
  setNx(key: string, value: unknown, ttlSeconds?: number): Promise<boolean>;

  /**
   * Increment a numeric value atomically.
   *
   * If the key does not exist, it is created with value 1. If the key
   * exists, its value is incremented by 1. This is an atomic operation
   * suitable for counters such as rate limiting windows and unread
   * message counts.
   *
   * @param key - Cache key string
   * @returns The new value after increment
   */
  incr(key: string): Promise<number>;

  /**
   * Set expiration on an existing key.
   *
   * Applies a TTL to a key that may have been created without one, or
   * resets the TTL on an existing key. Returns false if the key does
   * not exist (no timeout can be set on a non-existent key).
   *
   * @param key - Cache key string
   * @param ttlSeconds - Time-to-live in seconds
   * @returns true if the timeout was set, false if the key does not exist
   */
  expire(key: string, ttlSeconds: number): Promise<boolean>;

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
  ttl(key: string): Promise<number>;
}
