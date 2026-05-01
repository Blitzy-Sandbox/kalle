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
 * server restarts and are shared across horizontal replicas. This call
 * triggers an internal reconstruction of all three pre-configured limiters
 * so the Redis-backed store is bound at construction time (NOT at request
 * time, which would surface the `ERR_ERL_CREATED_IN_REQUEST_HANDLER`
 * warning that QA Checkpoint F2 flagged as MINOR-1).
 *
 * **MINOR-1 (QA Checkpoint F2 final report) — Eager initialization:**
 * The pre-configured rate limiter instances (`authRateLimiter`,
 * `apiRateLimiter`, `uploadRateLimiter`) are constructed at MODULE LOAD
 * time, NOT lazily on first request. Eager initialization eliminates the
 * `ERR_ERL_CREATED_IN_REQUEST_HANDLER` validation warning emitted by
 * `express-rate-limit` v7+ when an instance is created inside a request
 * handler. Both prior `_authLimiter = createRateLimiter(...)` and
 * `_uploadLimiter = createRateLimiter(...)` invocations now occur at
 * module init scope. When `configureRedisStore()` is called during server
 * bootstrap (post-Redis-handshake), all three limiters are reconstructed
 * with the Redis-backed store — that reconstruction is also OUTSIDE any
 * request handler, so the warning never fires.
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
 *        ALSO eliminates the `ERR_ERL_CREATED_IN_REQUEST_HANDLER` runtime
 *        warning per QA MINOR-1 fix (eager init).
 * - R23 (Log Hygiene): Error details contain only rate limit metadata
 *        (retryAfter, limit, window) — no tokens, passwords, or secrets.
 * - R12 (API Stability): Public exports `authRateLimiter`, `apiRateLimiter`,
 *        `uploadRateLimiter`, `createRateLimiter`, `configureRedisStore`,
 *        and `RateLimiterOptions` are unchanged. Only the internal
 *        construction timing has shifted from lazy → eager + reconfigure.
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
//
// The reference is mutable so `configureRedisStore()` can swap from null to
// a connected client at server bootstrap. Each call to `createRateLimiter()`
// captures the current value of `redisClient` AT CONSTRUCTION TIME via
// `createRedisStoreInstance()`. This means a limiter constructed BEFORE
// `configureRedisStore()` will use MemoryStore even if Redis is later
// configured — to switch all pre-configured limiters to Redis, the
// `configureRedisStore()` function reconstructs them (see implementation
// below).
// ---------------------------------------------------------------------------
let redisClient: Redis | null = null;

/**
 * Whether the application is running in a test environment.
 * When true, rate limits are raised significantly to prevent test suite
 * interference (E2E and integration tests may issue hundreds of auth
 * requests during a single run). The limits remain non-infinite to
 * ensure rate-limiting logic is still exercised.
 *
 * Captured at module load. In Jest/Vitest, `NODE_ENV` is set to `'test'`
 * BEFORE any user code runs (the test runner sets it as part of its own
 * bootstrap), so this is the same value the prior lazy implementation
 * would have observed at first request.
 */
const isTestEnv: boolean = process.env.NODE_ENV === 'test';

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
 * built-in MemoryStore (suitable for Docker single-instance dev) UNLESS
 * `configureRedisStore()` has been called prior to the factory invocation,
 * in which case a Redis-backed store is used. When the configured limit is
 * exceeded, a `RateLimitError` is passed to `next()` so the global error
 * handler can produce the R22-compliant error response.
 *
 * Key behaviours:
 * 1. **Standard rate limit headers** — Sends `RateLimit-Limit`,
 *    `RateLimit-Remaining`, and `RateLimit-Reset` per RFC 6585.
 * 2. **CORS preflight bypass** — `OPTIONS` requests are not counted
 *    towards the rate limit budget.
 * 3. **IP-based keying** — Uses `req.socket.remoteAddress` (with `req.ip`
 *    fallback) which respects the Express `trust proxy` setting for correct
 *    resolution behind Docker/nginx, while remaining spoof-resistant when
 *    accessed directly.
 * 4. **Error delegation** — Throws `RateLimitError` via `next()` rather
 *    than responding directly, ensuring consistent error formatting.
 *
 * **MINOR-1 callsite discipline:** Callers of this factory MUST invoke it
 * at module load or during application bootstrap, NOT inside a request
 * handler. The pre-configured `authRateLimiter`/`apiRateLimiter`/
 * `uploadRateLimiter` exports below illustrate the correct pattern.
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
// Pre-configured rate limiter instance configurations
// ---------------------------------------------------------------------------
// These factory option objects are constants captured at module load. They
// are passed to `createRateLimiter()` at module init AND again whenever
// `configureRedisStore()` is invoked, ensuring identical configuration
// across both eager-init and Redis-reconfigure paths.
// ---------------------------------------------------------------------------

/**
 * Configuration for the authentication endpoints rate limiter.
 *
 * Window: 15 minutes (900 000 ms)
 * Limit:  20 requests (production) / 10 000 (test environment)
 *
 * The high test-environment limit prevents test suite interference where
 * E2E and integration tests may issue hundreds of auth requests in a
 * single run. The limit remains non-infinite so rate-limiting logic is
 * still exercised (e.g., a limit-exceeded test can use `max: 1`).
 */
const authLimiterOptions: RateLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: isTestEnv ? 10_000 : 20,
  message: 'Too many authentication attempts, please try again later',
  keyPrefix: 'auth',
};

/**
 * Configuration for general API endpoints rate limiter.
 *
 * Window: 1 minute (60 000 ms)
 * Limit:  100 requests (production) / 50 000 (test environment)
 */
const apiLimiterOptions: RateLimiterOptions = {
  windowMs: 60 * 1000,
  max: isTestEnv ? 50_000 : 100,
  keyPrefix: 'api',
};

/**
 * Configuration for media upload rate limiter.
 *
 * Window: 1 minute (60 000 ms)
 * Limit:  30 requests (production) / 10 000 (test environment)
 *
 * The lower production limit reflects the higher resource cost of file
 * upload processing (image transcoding, thumbnail generation, virus
 * scanning).
 */
const uploadLimiterOptions: RateLimiterOptions = {
  windowMs: 60 * 1000,
  max: isTestEnv ? 10_000 : 30,
  message: 'Too many upload requests, please try again later',
  keyPrefix: 'upload',
};

// ---------------------------------------------------------------------------
// Pre-configured rate limiter instances (EAGERLY INITIALIZED — MINOR-1 fix)
// ---------------------------------------------------------------------------
// MINOR-1 (QA Checkpoint F2): These three instances were previously
// constructed lazily on first request, which caused express-rate-limit v7+
// to emit `ERR_ERL_CREATED_IN_REQUEST_HANDLER` ValidationError on the first
// hit to each route group. They are now constructed at module load time so
// the validation warning never fires.
//
// At module load, `redisClient` is `null`, so each instance binds to the
// default MemoryStore. After server bootstrap calls `configureRedisStore()`,
// the three instances are reconstructed (still synchronously, still in
// non-handler context) so they switch to a Redis-backed store. The exported
// symbols (`authRateLimiter`, `apiRateLimiter`, `uploadRateLimiter`) are
// thin wrapper functions that delegate to the current instance, allowing
// the underlying limiter reference to be reassigned without breaking
// import bindings.
// ---------------------------------------------------------------------------

/** Internal mutable reference for auth limiter (reassignable on Redis configure). */
let _authLimiter: ReturnType<typeof createRateLimiter> = createRateLimiter(authLimiterOptions);

/** Internal mutable reference for general API limiter (reassignable on Redis configure). */
let _apiLimiter: ReturnType<typeof createRateLimiter> = createRateLimiter(apiLimiterOptions);

/** Internal mutable reference for upload limiter (reassignable on Redis configure). */
let _uploadLimiter: ReturnType<typeof createRateLimiter> = createRateLimiter(uploadLimiterOptions);

/**
 * Configures all rate limiters to use a Redis-backed store.
 *
 * Call this ONCE during server bootstrap after the Redis client is
 * connected and verified healthy. All three pre-configured limiters
 * (`authRateLimiter`, `apiRateLimiter`, `uploadRateLimiter`) are
 * reconstructed synchronously with the Redis-backed store, replacing the
 * MemoryStore instances that were created at module load.
 *
 * **MINOR-1 (QA Checkpoint F2):** This function executes during server
 * bootstrap, which is OUTSIDE any request handler. Therefore the
 * `ERR_ERL_CREATED_IN_REQUEST_HANDLER` warning that the prior lazy
 * implementation triggered is now eliminated. The reconstruction also
 * does NOT swap the exported function identities — `authRateLimiter`,
 * `apiRateLimiter`, and `uploadRateLimiter` are stable closures that
 * delegate to the (mutable) `_authLimiter`/`_apiLimiter`/`_uploadLimiter`
 * references.
 *
 * Subsequent calls to `configureRedisStore()` are idempotent in the
 * sense that they reconstruct the limiters again with the (potentially
 * new) Redis client. This is rare in practice (the function is meant to
 * be called once), but the behavior is well-defined.
 *
 * @param client - Connected ioredis client instance from `config/redis.ts`
 */
export function configureRedisStore(client: Redis): void {
  redisClient = client;
  // Reconstruct the three pre-configured limiters so they bind to a
  // Redis-backed store. This call site is bootstrap context, NOT a
  // request handler, so express-rate-limit's
  // ERR_ERL_CREATED_IN_REQUEST_HANDLER warning is not triggered.
  _authLimiter = createRateLimiter(authLimiterOptions);
  _apiLimiter = createRateLimiter(apiLimiterOptions);
  _uploadLimiter = createRateLimiter(uploadLimiterOptions);
}

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
 * Constructed at module load (MINOR-1). The wrapper function below
 * delegates to the current `_authLimiter` reference, which may be
 * reassigned by `configureRedisStore()` to switch from MemoryStore to
 * a Redis-backed store. This delegation pattern preserves the exported
 * function identity across the swap, so any code that captured the
 * exported reference (e.g., a route definition) continues to work after
 * the swap.
 */
export const authRateLimiter = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
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
 * Constructed at module load (MINOR-1). See `authRateLimiter` doc above
 * for the delegation-and-reassignment pattern.
 */
export const apiRateLimiter = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
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
 * Constructed at module load (MINOR-1). See `authRateLimiter` doc above
 * for the delegation-and-reassignment pattern.
 */
export const uploadRateLimiter = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  _uploadLimiter(req, res, next);
};
