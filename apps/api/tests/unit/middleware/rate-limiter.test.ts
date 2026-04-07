/**
 * @file Unit tests for rate-limiter middleware
 */
import { Request, Response, NextFunction } from 'express';
import { createRateLimiter, configureRedisStore } from '../../../src/middleware/rate-limiter';

describe('createRateLimiter', () => {
  it('returns a function (middleware)', () => {
    const mw = createRateLimiter({ windowMs: 60000, max: 100 });
    expect(typeof mw).toBe('function');
  });

  it('accepts custom options', () => {
    const mw = createRateLimiter({ windowMs: 30000, max: 50, keyPrefix: 'test:' });
    expect(typeof mw).toBe('function');
  });

  it('returns middleware with default options', () => {
    const mw = createRateLimiter();
    expect(typeof mw).toBe('function');
  });
});

describe('configureRedisStore', () => {
  it('configures without throwing', () => {
    // Mock Redis client with minimal interface
    const mockRedis: any = {
      status: 'ready',
      multi: jest.fn(() => ({
        incr: jest.fn().mockReturnThis(),
        pexpire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([[null, 1], [null, 1]]),
      })),
      pttl: jest.fn().mockResolvedValue(60000),
    };
    expect(() => configureRedisStore(mockRedis)).not.toThrow();
  });
});
