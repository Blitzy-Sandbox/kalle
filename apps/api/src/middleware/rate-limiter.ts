/**
 * @file apps/api/src/middleware/rate-limiter.ts
 * @description HTTP rate limiting middleware using `express-rate-limit` with
 * optional Redis-backed persistence via `rate-limit-redis`.
 *
 * Provides a factory function (`createRateLimiter`) that returns configured
 * Express middleware instances for IP-based request throttling. Three
 * pre-configured instances are exported for common route groups:
 *
 * - `authRateLimiter`   — 20 requests per 15-minute window (auth endpoints)
 * - `apiRateLimiter`    — 100 requests per 1-minute window (general API)
 * - `uploadRateLimiter` — 30 requests per 1-minute window (media uploads)
 *
 * When a client exceeds the configured rate, the middleware throws a
 * `RateLimitError` instead of sending a response directly. This ensures
 * the error flows through the global error handler (`error-handler.ts`)
 * and produces the standardized R22-compliant error shape:
 * `{ error: { code: 'RATE_LIMIT_EXCEEDED', message: '...', details: { retryAfter, limit, window } } }`
 *
 * **Redis-backed store:** Call `configureRedisStore(redisClient)` during
 * server bootstrap to switch all rate limiters from MemoryStore to a
 * Redis-backed store. This ensures rate limit counters persist across
 * server restarts and are shared across horizontal replicas.
 *
 * This is the **HTTP-side** rate limiter only. WebSocket rate limiting
 * is handled separately in `websocket/middleware/ws-rate-limiter.ts`
 * per Rule R25.
 *
 * Architecture Rules Enforced:
 * - R22 (Standardized Error Responses): Custom handler throws RateLimitError
 *        rather than crafting an ad-hoc response, so the global error handler
 *        formats the response in the standardized shape.
 * - R28 (Structured Logging Only): Zero `console.log` calls.
 * - R7  (Zero Warnings Build): Compiles under `tsc --noEmit --strict` with
 *        zero warnings. All parameters are used or prefixed with `_`.
 * - R23 (Log Hygiene): Error details contain only rate limit metadata
 *        (retryAfter, limit, window) — no tokens, passwords, or secrets.
 */

import { rateLimit } from 'express-rate-limit';
import type { Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request, Response, NextFunction } from 'express';
import type Redis from 'ioredis';
import { RateLimitError } from '../errors/RateLimitError';

// ---------------------------------------------------------------------------
// Module-Level Redis Store Configuration
// ---------------------------------------------------------------------------
// Stores a reference to the Redis client provided by `configureRedisStore()`.
// When set, all rate limiters created by `createRateLimiter()` use a
// Redis-backed store rather than the default MemoryStore. This enables
// rate limit persistence across server restarts and sharing across replicas.
// ---------------------------------------------------------------------------
let redisClient: Redis | null = null;

/**
 * Configures all rate limiters to use a Redis-backed store.
 *
 * Call this ONCE during server bootstrap after the Redis client is connected
 * and verified healthy. All subsequent `createRateLimiter()` calls will use
 * Redis for counter storage, enabling persistent and horizontally-shared
 * rate limit counters.
 *
 * @param client - Connected ioredis client instance from `config/redis.ts`
 */
export function configureRedisStore(client: Redis): void {
  redisClient = client;
}

/**
 * Creates a Redis-backed store for express-rate-limit using the configured
 * ioredis client. Returns undefined if no Redis client has been configured.
 *
 * @param prefix - Redis key prefix to isolate this limiter's counters
 * @returns RedisStore instance or undefined (fallback to MemoryStore)
 */
function createRedisStoreInstance(prefix: string): Store | undefined {
  if (!redisClient) {
    return undefined;
  }
  return new RedisStore({
    // Use ioredis sendCommand interface for rate-limit-redis v4 compatibility
    sendCommand: (...args: string[]) =>
      redisClient!.call(args[0], ...args.slice(1)) as never,
    prefix: `rl:${prefix}:`,
  });
}

/**
 * Configuration options for the rate limiter factory.
 *
 * All properties are optional and fall back to sensible defaults:
 * - `windowMs` defaults to 60 000 ms (1 minute)
 * - `max` defaults to 100 requests per window
 * - `message` defaults to a generic "Too many requests" string
 * - `keyPrefix` defaults to 'default' — used for Redis key namespacing
 */
export interface RateLimiterOptions {
  /** Duration of the rate limit window in milliseconds. */
  windowMs?: number;
  /** Maximum number of requests allowed within the window. */
  max?: number;
  /** Human-readable message included in the RateLimitError. */
  message?: string;
  /** Redis key prefix to isolate this limiter's counters (default: 'default'). */
  keyPrefix?: string;
}

/**
 * Factory function that creates a configured `express-rate-limit` middleware.
 *
 * The returned middleware tracks request counts per IP address using the
 * built-in MemoryStore (suitable for Docker single-instance dev). When
 * the configured limit is exceeded, a `RateLimitError` is passed to
 * `next()` so the global error handler can produce the R22-compliant
 * error response.
 *
 * Key behaviours:
 * 1. **Standard rate limit headers** — Sends `RateLimit-Limit`,
 *    `RateLimit-Remaining`, and `RateLimit-Reset` per RFC 6585.
 * 2. **CORS preflight bypass** — `OPTIONS` requests are not counted
 *    towards the rate limit budget.
 * 3. **IP-based keying** — Uses `req.ip` which respects the Express
 *    `trust proxy` setting for correct resolution behind Docker/nginx.
 * 4. **Error delegation** — Throws `RateLimitError` via `next()` rather
 *    than responding directly, ensuring consistent error formatting.
 *
 * @param options - Optional rate limiter configuration overrides
 * @returns Configured Express rate limiting middleware
 *
 * @example
 * ```typescript
 * import { createRateLimiter } from '../middleware/rate-limiter';
 *
 * // Custom limiter: 50 requests per 2-minute window
 * const customLimiter = createRateLimiter({
 *   windowMs: 2 * 60 * 1000,
 *   max: 50,
 *   message: 'Custom rate limit exceeded',
 * });
 *
 * router.use('/custom', customLimiter);
 * ```
 */
export function createRateLimiter(options?: RateLimiterOptions) {
  const windowMs = options?.windowMs ?? 60 * 1000; // 1-minute default window
  const max = options?.max ?? 100;                  // 100 requests per window default
  const message = options?.message ?? 'Too many requests, please try again later';
  const keyPrefix = options?.keyPrefix ?? 'default';

  // Attempt to create a Redis-backed store. Falls back to the built-in
  // MemoryStore when no Redis client has been configured (e.g. in tests
  // or before server.ts calls configureRedisStore()).
  const store = createRedisStoreInstance(keyPrefix);

  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,   // Return rate limit info in `RateLimit-*` headers (RFC 6585)
    legacyHeaders: false,    // Disable deprecated `X-RateLimit-*` headers
    ...(store !== undefined && { store }),  // Use Redis store when available

    /**
     * Custom handler invoked when a client exceeds the rate limit.
     *
     * Instead of sending a response directly, we pass a `RateLimitError`
     * to `next()`. This delegates response formatting to the global
     * error handler, ensuring the R22-compliant standardized error shape.
     *
     * The `details` object includes:
     * - `retryAfter` — Seconds until the client may retry
     * - `limit`      — Maximum allowed requests in the window
     * - `window`     — Human-readable window duration (e.g. "60s")
     */
    handler: (
      _req: Request,
      _res: Response,
      next: NextFunction,
    ) => {
      next(
        new RateLimitError(message, {
          retryAfter: Math.ceil(windowMs / 1000),
          limit: max,
          window: `${Math.ceil(windowMs / 1000)}s`,
        }),
      );
    },

    /**
     * Skip CORS preflight requests.
     *
     * OPTIONS requests are not counted toward the rate limit budget.
     * This prevents preflight requests from consuming a client's
     * quota, which would cause legitimate follow-up requests to be
     * incorrectly throttled.
     */
    skip: (req: Request, _res: Response) => req.method === 'OPTIONS',

    /**
     * Generate the rate limit key from the client's IP address.
     *
     * Defense-in-depth: Uses `req.socket.remoteAddress` (the actual TCP
     * connection source IP) as the primary key. This value cannot be
     * spoofed via X-Forwarded-For headers, preventing rate limiter
     * bypass when the API is accessed directly without a reverse proxy.
     *
     * In production behind a properly configured reverse proxy (e.g.,
     * nginx), `req.socket.remoteAddress` will be the proxy's IP — rate
     * limiting per end-user should then be enforced at the proxy level
     * or via a more granular key. For the Docker development environment
     * where the API is directly accessible, this ensures spoofed
     * X-Forwarded-For headers do not create separate rate limit buckets.
     */
    keyGenerator: (req: Request, _res: Response): string => {
      return req.socket.remoteAddress ?? req.ip ?? 'unknown';
    },
  });
}

// ---------------------------------------------------------------------------
// Pre-configured rate limiter instances for common route groups
// ---------------------------------------------------------------------------

/**
 * Rate limiter for authentication endpoints.
 *
 * Enforces a stricter limit of **20 requests per 15-minute window** to
 * mitigate brute-force login and credential stuffing attacks. Applied
 * to routes under `/api/v1/auth/`.
 *
 * Window: 15 minutes (900 000 ms)
 * Limit:  20 requests
 *
 * Uses lazy initialization to ensure the Redis store (configured via
 * `configureRedisStore()` during server bootstrap) is available when
 * the limiter is first invoked.
 */
let _authLimiter: ReturnType<typeof createRateLimiter> | null = null;
export const authRateLimiter = (req: Request, res: Response, next: NextFunction): void => {
  if (!_authLimiter) {
    _authLimiter = createRateLimiter({
      windowMs: 15 * 60 * 1000,
      max: 20,
      message: 'Too many authentication attempts, please try again later',
      keyPrefix: 'auth',
    });
  }
  _authLimiter(req, res, next);
};

/**
 * Rate limiter for general API endpoints.
 *
 * Enforces a standard limit of **100 requests per 1-minute window**.
 * Applied to most routes under `/api/v1/` except auth and media uploads
 * which have their own dedicated limiters.
 *
 * Window: 1 minute (60 000 ms)
 * Limit:  100 requests
 *
 * Uses lazy initialization to ensure the Redis store is available.
 */
let _apiLimiter: ReturnType<typeof createRateLimiter> | null = null;
export const apiRateLimiter = (req: Request, res: Response, next: NextFunction): void => {
  if (!_apiLimiter) {
    _apiLimiter = createRateLimiter({
      windowMs: 60 * 1000,
      max: 100,
      keyPrefix: 'api',
    });
  }
  _apiLimiter(req, res, next);
};

/**
 * Rate limiter for media upload endpoints.
 *
 * Enforces a lower limit of **30 requests per 1-minute window** due to
 * the higher resource cost of file upload processing. Applied to routes
 * under `/api/v1/media/`.
 *
 * Window: 1 minute (60 000 ms)
 * Limit:  30 requests
 *
 * Uses lazy initialization to ensure the Redis store is available.
 */
let _uploadLimiter: ReturnType<typeof createRateLimiter> | null = null;
export const uploadRateLimiter = (req: Request, res: Response, next: NextFunction): void => {
  if (!_uploadLimiter) {
    _uploadLimiter = createRateLimiter({
      windowMs: 60 * 1000,
      max: 30,
      message: 'Too many upload requests, please try again later',
      keyPrefix: 'upload',
    });
  }
  _uploadLimiter(req, res, next);
};
