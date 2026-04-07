/**
 * @file ws-rate-limiter.test.ts
 * @description Unit tests for createWsRateLimiter (R25 WebSocket rate limiting).
 */
import { createWsRateLimiter, RATE_LIMITS } from '../../../../src/websocket/middleware/ws-rate-limiter';
import type { ICacheProvider } from '../../../../src/domain/interfaces/ICacheProvider';

function mockCacheProvider(): jest.Mocked<ICacheProvider> {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    setNx: jest.fn().mockResolvedValue(true),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(true),
    ttl: jest.fn().mockResolvedValue(-1),
  };
}

describe('createWsRateLimiter', () => {
  let cache: jest.Mocked<ICacheProvider>;
  const socketId = 'socket-abc';

  beforeEach(() => {
    cache = mockCacheProvider();
  });

  it('should allow requests within the message:send limit (30/min)', async () => {
    cache.incr.mockResolvedValue(1);
    const limiter = createWsRateLimiter(cache, socketId);
    const result = await limiter.checkLimit('message:send');
    expect(result).toBe(true);
    expect(cache.incr).toHaveBeenCalledWith(expect.stringContaining('message:send'));
    // First increment sets TTL
    expect(cache.expire).toHaveBeenCalledWith(
      expect.stringContaining('message:send'),
      RATE_LIMITS['message:send'].windowSeconds,
    );
  });

  it('should block requests exceeding the message:send limit', async () => {
    cache.incr.mockResolvedValue(31);
    const limiter = createWsRateLimiter(cache, socketId);
    const result = await limiter.checkLimit('message:send');
    expect(result).toBe(false);
  });

  it('should allow typing:start within limit (10/min)', async () => {
    cache.incr.mockResolvedValue(10);
    const limiter = createWsRateLimiter(cache, socketId);
    const result = await limiter.checkLimit('typing:start');
    expect(result).toBe(true);
  });

  it('should block typing:start beyond limit', async () => {
    cache.incr.mockResolvedValue(11);
    const limiter = createWsRateLimiter(cache, socketId);
    const result = await limiter.checkLimit('typing:start');
    expect(result).toBe(false);
  });

  it('should use default limit (60/min) for unknown events', async () => {
    cache.incr.mockResolvedValue(60);
    const limiter = createWsRateLimiter(cache, socketId);
    const result = await limiter.checkLimit('some:custom:event');
    expect(result).toBe(true);
    expect(cache.incr).toHaveBeenCalledWith(expect.stringContaining('default'));
  });

  it('should block unknown events beyond default limit', async () => {
    cache.incr.mockResolvedValue(61);
    const limiter = createWsRateLimiter(cache, socketId);
    const result = await limiter.checkLimit('some:custom:event');
    expect(result).toBe(false);
  });

  it('should set TTL only on first request in a window (count=1)', async () => {
    cache.incr.mockResolvedValue(2); // not the first request
    const limiter = createWsRateLimiter(cache, socketId);
    await limiter.checkLimit('message:send');
    expect(cache.expire).not.toHaveBeenCalled();
  });

  it('should clean up all tracked keys on cleanup()', async () => {
    cache.incr.mockResolvedValue(1);
    const limiter = createWsRateLimiter(cache, socketId);
    await limiter.checkLimit('message:send');
    await limiter.checkLimit('typing:start');
    await limiter.checkLimit('unknown:event');
    await limiter.cleanup();
    // Three unique keys: message:send, typing:start, default
    expect(cache.del).toHaveBeenCalledTimes(3);
  });

  it('should no-op on cleanup when no keys tracked', async () => {
    const limiter = createWsRateLimiter(cache, socketId);
    await limiter.cleanup();
    expect(cache.del).not.toHaveBeenCalled();
  });

  it('should scope keys to the socketId', async () => {
    cache.incr.mockResolvedValue(1);
    const limiter = createWsRateLimiter(cache, 'socket-xyz');
    await limiter.checkLimit('message:send');
    expect(cache.incr).toHaveBeenCalledWith('ratelimit:ws:socket-xyz:message:send');
  });
});
