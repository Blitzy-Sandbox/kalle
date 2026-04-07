/**
 * @file CacheProvider.test.ts — Unit tests for Redis-backed CacheProvider
 *
 * Tests all ICacheProvider interface methods: get, set, del, exists, setNx,
 * incr, expire, ttl — with mock ioredis client.
 */

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  exists: jest.fn(),
  setnx: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  ttl: jest.fn(),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedis);
});

import { CacheProvider } from '../../../src/providers/CacheProvider';

describe('CacheProvider', () => {
  let cache: CacheProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    cache = new CacheProvider(mockRedis as any);
  });

  // ---- get ----
  describe('get()', () => {
    it('should return parsed JSON when value exists', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ name: 'Alice' }));
      const result = await cache.get<{ name: string }>('user:1');
      expect(mockRedis.get).toHaveBeenCalledWith('user:1');
      expect(result).toEqual({ name: 'Alice' });
    });

    it('should return null when key does not exist', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await cache.get('missing');
      expect(result).toBeNull();
    });

    it('should return raw string when JSON parse fails', async () => {
      mockRedis.get.mockResolvedValue('plain-text-value');
      const result = await cache.get<string>('key');
      expect(result).toBe('plain-text-value');
    });
  });

  // ---- set ----
  describe('set()', () => {
    it('should use setex when ttlSeconds is provided', async () => {
      mockRedis.setex.mockResolvedValue('OK');
      await cache.set('token:abc', true, 3600);
      expect(mockRedis.setex).toHaveBeenCalledWith('token:abc', 3600, 'true');
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('should use set when ttlSeconds is omitted', async () => {
      mockRedis.set.mockResolvedValue('OK');
      await cache.set('key', { data: 1 });
      expect(mockRedis.set).toHaveBeenCalledWith('key', JSON.stringify({ data: 1 }));
      expect(mockRedis.setex).not.toHaveBeenCalled();
    });

    it('should use set when ttlSeconds is 0 or negative', async () => {
      mockRedis.set.mockResolvedValue('OK');
      await cache.set('key', 'val', 0);
      expect(mockRedis.set).toHaveBeenCalled();
      expect(mockRedis.setex).not.toHaveBeenCalled();
    });
  });

  // ---- del ----
  describe('del()', () => {
    it('should call redis.del with the key', async () => {
      mockRedis.del.mockResolvedValue(1);
      await cache.del('session:xyz');
      expect(mockRedis.del).toHaveBeenCalledWith('session:xyz');
    });
  });

  // ---- exists ----
  describe('exists()', () => {
    it('should return true when key exists (result === 1)', async () => {
      mockRedis.exists.mockResolvedValue(1);
      const result = await cache.exists('blacklist:jti');
      expect(result).toBe(true);
    });

    it('should return false when key does not exist (result === 0)', async () => {
      mockRedis.exists.mockResolvedValue(0);
      const result = await cache.exists('missing');
      expect(result).toBe(false);
    });
  });

  // ---- setNx ----
  describe('setNx()', () => {
    it('should use SET NX EX when ttlSeconds is provided', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const result = await cache.setNx('lock:resource', 'owner', 30);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'lock:resource',
        '"owner"',
        'EX',
        30,
        'NX',
      );
      expect(result).toBe(true);
    });

    it('should return false when SET NX EX fails (key exists)', async () => {
      mockRedis.set.mockResolvedValue(null);
      const result = await cache.setNx('lock:resource', 'owner', 30);
      expect(result).toBe(false);
    });

    it('should use setnx when ttlSeconds is omitted', async () => {
      mockRedis.setnx.mockResolvedValue(1);
      const result = await cache.setNx('key', 'value');
      expect(mockRedis.setnx).toHaveBeenCalledWith('key', '"value"');
      expect(result).toBe(true);
    });

    it('should return false from setnx when key already exists', async () => {
      mockRedis.setnx.mockResolvedValue(0);
      const result = await cache.setNx('key', 'value');
      expect(result).toBe(false);
    });
  });

  // ---- incr ----
  describe('incr()', () => {
    it('should return incremented value', async () => {
      mockRedis.incr.mockResolvedValue(5);
      const result = await cache.incr('counter');
      expect(mockRedis.incr).toHaveBeenCalledWith('counter');
      expect(result).toBe(5);
    });
  });

  // ---- expire ----
  describe('expire()', () => {
    it('should return true when key exists and timeout is set', async () => {
      mockRedis.expire.mockResolvedValue(1);
      const result = await cache.expire('key', 60);
      expect(mockRedis.expire).toHaveBeenCalledWith('key', 60);
      expect(result).toBe(true);
    });

    it('should return false when key does not exist', async () => {
      mockRedis.expire.mockResolvedValue(0);
      const result = await cache.expire('missing', 60);
      expect(result).toBe(false);
    });
  });

  // ---- ttl ----
  describe('ttl()', () => {
    it('should return positive TTL for key with expiry', async () => {
      mockRedis.ttl.mockResolvedValue(3600);
      const result = await cache.ttl('session:abc');
      expect(result).toBe(3600);
    });

    it('should return -1 for key with no expiry', async () => {
      mockRedis.ttl.mockResolvedValue(-1);
      const result = await cache.ttl('permanent');
      expect(result).toBe(-1);
    });

    it('should return -2 for non-existent key', async () => {
      mockRedis.ttl.mockResolvedValue(-2);
      const result = await cache.ttl('missing');
      expect(result).toBe(-2);
    });
  });
});
