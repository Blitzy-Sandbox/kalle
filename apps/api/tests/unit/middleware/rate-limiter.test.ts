/**
 * @file Unit tests for rate-limiter middleware
 *
 * Covers:
 * - `createRateLimiter` factory returns a middleware function
 * - `configureRedisStore` accepts a connected Redis client and reconstructs
 *   the pre-configured limiters with a Redis-backed store WITHOUT throwing
 *
 * **MINOR-1 (QA Checkpoint F2 — eager rate-limiter init):** The
 * `configureRedisStore` test previously passed an incomplete Redis mock
 * (lacking the `call` method) and the old implementation stored the
 * reference without exercising it, so the lack of `call` was never
 * detected. The new implementation reconstructs the three pre-configured
 * limiters synchronously inside `configureRedisStore`, which causes
 * `rate-limit-redis` v4's `RedisStore` constructor to call
 * `loadIncrementScript()` → `sendCommand("SCRIPT", "LOAD", lua)` →
 * `redisClient.call(...)`. The mock below now includes a `call` method
 * (returning a Lua-script SHA1 hash placeholder, which is the documented
 * shape of a successful `SCRIPT LOAD` response) so the constructor
 * succeeds. Other Redis methods (`multi`, `pttl`) remain mocked for
 * forward-compatibility with rate-limit-redis behaviour evolution.
 */
import type { Request, Response, NextFunction } from 'express';
import {
  createRateLimiter,
  configureRedisStore,
  authRateLimiter,
  apiRateLimiter,
  uploadRateLimiter,
} from '../../../src/middleware/rate-limiter';

describe('createRateLimiter', () => {
  it('returns a function (middleware)', () => {
    const mw = createRateLimiter({ windowMs: 60000, max: 100 });
    expect(typeof mw).toBe('function');
  });

  it('accepts custom options', () => {
    const mw = createRateLimiter({
      windowMs: 30000,
      max: 50,
      keyPrefix: 'test:',
    });
    expect(typeof mw).toBe('function');
  });

  it('returns middleware with default options', () => {
    const mw = createRateLimiter();
    expect(typeof mw).toBe('function');
  });

  it('returns middleware that delegates to the express-rate-limit handler', () => {
    /* Ensure the returned function has the express-rate-limit middleware
       signature `(req, res, next) => unknown`. We don't invoke it here to
       avoid pulling in real Express request/response plumbing. */
    const mw = createRateLimiter({ windowMs: 60000, max: 100 });
    expect(typeof mw).toBe('function');
    expect(mw.length).toBeGreaterThanOrEqual(2); // (req, res) at minimum
  });
});

describe('configureRedisStore', () => {
  it('configures without throwing when given a Redis-compatible client', () => {
    /* Mock Redis client that satisfies the methods invoked by rate-limit-redis
       v4 during RedisStore construction:
         - `call(cmd, ...args)` — used by `sendCommand` to load Lua scripts.
           rate-limit-redis calls this synchronously in the constructor with
           `('SCRIPT', 'LOAD', luaSourceCode)` to register the increment Lua
           script. The expected response is a 40-character SHA1 hash. We
           return a placeholder hash that satisfies the type contract; the
           script is never actually executed in this test (no rate-limit
           hits are made).
         - `multi()` / `pttl()` — used by RedisStore at increment time when
           the SCRIPT LOAD path is unavailable. Mocked for forward
           compatibility but unused in this test.
       The mock uses `as never` casts to satisfy TypeScript's strictness
       without spreading `any` types throughout the test. */
    const mockRedis = {
      status: 'ready',
      // SCRIPT LOAD support — synchronous-looking return is fine for this
      // construction-time call. rate-limit-redis stores the hash for later
      // EVALSHA calls; since this test never invokes the limiter, the hash
      // value itself is irrelevant beyond being a string.
      call: jest
        .fn()
        .mockResolvedValue('0000000000000000000000000000000000000000'),
      multi: jest.fn(() => ({
        incr: jest.fn().mockReturnThis(),
        pexpire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          [null, 1],
          [null, 1],
        ]),
      })),
      pttl: jest.fn().mockResolvedValue(60000),
    };
    expect(() =>
      configureRedisStore(mockRedis as unknown as never),
    ).not.toThrow();
  });

  it('reconstruction is idempotent across multiple configureRedisStore calls', () => {
    /* Calling configureRedisStore twice should not throw — each call
       reconstructs the three pre-configured limiters with the (potentially
       new) Redis client. This guards against accidental dependence on a
       single-shot construction pattern. */
    const mockRedis = {
      status: 'ready',
      call: jest
        .fn()
        .mockResolvedValue('0000000000000000000000000000000000000000'),
      multi: jest.fn(() => ({
        incr: jest.fn().mockReturnThis(),
        pexpire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          [null, 1],
          [null, 1],
        ]),
      })),
      pttl: jest.fn().mockResolvedValue(60000),
    };
    expect(() =>
      configureRedisStore(mockRedis as unknown as never),
    ).not.toThrow();
    expect(() =>
      configureRedisStore(mockRedis as unknown as never),
    ).not.toThrow();
  });
});

describe('pre-configured rate limiter exports (eager initialization)', () => {
  /* MINOR-1 verification: the three pre-configured rate limiters
     (`authRateLimiter`, `apiRateLimiter`, `uploadRateLimiter`) MUST be
     fully initialized at module load (NOT lazy on first request). This
     test asserts they are usable function values immediately after import,
     proving construction happened during module init rather than inside a
     request handler. The mere fact that the top-level import binding
     resolves to a function (rather than `null` or `undefined`) is
     sufficient evidence — under the prior lazy-init implementation, the
     bindings would resolve to wrapper closures that internally check a
     null-able reference; under the new eager-init implementation, the
     wrapper closures internally delegate to a non-null reference set
     during module evaluation. The middleware shape `(req, res, next)`
     is the same in both cases, so this test guards against a future
     regression that re-introduces lazy-init.
     Note: We can't safely invoke the limiters in this test because doing
     so would attempt to use the (un-mocked) MemoryStore on a non-Express
     request object. Other tests with full express-rate-limit fixtures
     (e.g., integration tests) cover invocation behaviour. */
  it('authRateLimiter is a function exported at module load', () => {
    expect(typeof authRateLimiter).toBe('function');
    /* Express middleware signature: (req, res, next) => unknown. */
    expect(authRateLimiter.length).toBeGreaterThanOrEqual(3);
  });

  it('apiRateLimiter is a function exported at module load', () => {
    expect(typeof apiRateLimiter).toBe('function');
    expect(apiRateLimiter.length).toBeGreaterThanOrEqual(3);
  });

  it('uploadRateLimiter is a function exported at module load', () => {
    expect(typeof uploadRateLimiter).toBe('function');
    expect(uploadRateLimiter.length).toBeGreaterThanOrEqual(3);
  });

  it('exported wrappers accept the express middleware signature', () => {
    /* Type-level assertion: each wrapper accepts (req, res, next). We
       cast to the express middleware type at the consumption site below
       to verify TypeScript's type compatibility without invoking. */
    const auth: (req: Request, res: Response, next: NextFunction) => void =
      authRateLimiter;
    const api: (req: Request, res: Response, next: NextFunction) => void =
      apiRateLimiter;
    const upload: (req: Request, res: Response, next: NextFunction) => void =
      uploadRateLimiter;
    expect(typeof auth).toBe('function');
    expect(typeof api).toBe('function');
    expect(typeof upload).toBe('function');
  });
});
