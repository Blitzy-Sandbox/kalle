/**
 * @module HealthService.test
 * @description Unit tests for the HealthService class which provides
 * component-level health checks for PostgreSQL (via Prisma), Redis,
 * and local filesystem storage.
 *
 * Tests verify healthy, degraded, and unhealthy states for all
 * infrastructure components, response-time measurement, uptime tracking,
 * and the error-isolation guarantee that getHealth() never throws.
 *
 * Architecture rules validated:
 *  - R37: Health check returns structured component statuses
 *  - R28: Zero console.log in service and test code (structured logging only)
 *  - R7 : TypeScript strict mode, zero warnings
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Module-level mock — must appear BEFORE the HealthService import so that
 * Jest's module registry replaces the real node:fs/promises used inside
 * checkStorage().
 * ──────────────────────────────────────────────────────────────────────────── */

jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
}));

/* ────────────────────────────────────────────────────────────────────────────
 * Imports
 * ──────────────────────────────────────────────────────────────────────────── */

import { access } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import {
  HealthService,
  type HealthCheckResult,
  type ComponentHealth,
} from '../../../src/services/HealthService';

/** Typed reference to the mocked `access` function for setup and assertions. */
const mockAccess = jest.mocked(access);

/* ────────────────────────────────────────────────────────────────────────────
 * Test Suite
 * ──────────────────────────────────────────────────────────────────────────── */

describe('HealthService', () => {
  let service: HealthService;
  let mockPrisma: { $queryRaw: jest.Mock };
  let mockRedis: { ping: jest.Mock; info: jest.Mock };

  /**
   * Realistic Redis INFO memory section output used across positive test
   * cases. The parser inside HealthService splits on \r\n and extracts
   * *_human keys for the details field.
   */
  const sampleRedisMemoryInfo = [
    '# Memory',
    'used_memory:1024000',
    'used_memory_human:1000.00K',
    'used_memory_peak:2048000',
    'used_memory_peak_human:2.00M',
    'maxmemory:0',
    'maxmemory_human:0B',
    'used_memory_rss:4096000',
    'used_memory_rss_human:3.91M',
    'total_system_memory:17179869184',
    'total_system_memory_human:16.00G',
  ].join('\r\n');

  /**
   * Prepare fresh mocks and a new HealthService instance before each test.
   */
  beforeEach(() => {
    jest.clearAllMocks();

    mockPrisma = { $queryRaw: jest.fn() };
    mockRedis = { ping: jest.fn(), info: jest.fn() };

    // Default: storage directory is accessible (resolves without error).
    mockAccess.mockResolvedValue(undefined);

    service = new HealthService(
      mockPrisma as unknown as PrismaClient,
      mockRedis as unknown as Redis,
    );
  });

  /** Ensure real timers are restored after any test that uses fake timers. */
  afterEach(() => {
    jest.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // constructor
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('should initialize with prisma and redis dependencies', () => {
      expect(
        () =>
          new HealthService(
            mockPrisma as unknown as PrismaClient,
            mockRedis as unknown as Redis,
          ),
      ).not.toThrow();
    });

    it('should record start time for uptime tracking', () => {
      const uptime = service.getUptime();
      expect(typeof uptime).toBe('number');
      expect(uptime).toBeGreaterThanOrEqual(0);
    });
  });

  // -----------------------------------------------------------------------
  // getHealth — all healthy
  // -----------------------------------------------------------------------

  describe('getHealth — all healthy', () => {
    beforeEach(() => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockRedis.ping.mockResolvedValue('PONG');
      mockRedis.info.mockResolvedValue(sampleRedisMemoryInfo);
    });

    it('should return healthy status when all components are healthy', async () => {
      const result: HealthCheckResult = await service.getHealth();

      // Overall status must be 'healthy'
      expect(result.status).toBe('healthy');

      // Each individual component must report healthy
      expect(result.components.database.status).toBe('healthy');
      expect(result.components.redis.status).toBe('healthy');
      expect(result.components.storage.status).toBe('healthy');

      // Timestamp must be valid ISO 8601
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);

      // Uptime must be a non-negative number
      expect(result.uptime).toBeGreaterThanOrEqual(0);

      // Version must be defined and non-empty
      expect(result.version).toBeDefined();
      expect(typeof result.version).toBe('string');
      expect(result.version.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // getHealth — degraded
  // -----------------------------------------------------------------------

  describe('getHealth — degraded', () => {
    it('should return degraded when database is unhealthy but redis is healthy', async () => {
      mockPrisma.$queryRaw.mockRejectedValue(new Error('Connection refused'));
      mockRedis.ping.mockResolvedValue('PONG');
      mockRedis.info.mockResolvedValue(sampleRedisMemoryInfo);

      const result: HealthCheckResult = await service.getHealth();

      expect(result.status).toBe('degraded');
      expect(result.components.database.status).toBe('unhealthy');
      expect(result.components.database.message).toContain('Connection refused');
      expect(result.components.redis.status).toBe('healthy');
    });

    it('should return degraded when redis is unhealthy but database is healthy', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockRedis.ping.mockRejectedValue(new Error('Redis connection lost'));

      const result: HealthCheckResult = await service.getHealth();

      expect(result.status).toBe('degraded');
      expect(result.components.redis.status).toBe('unhealthy');
      expect(result.components.redis.message).toContain('Redis connection lost');
      expect(result.components.database.status).toBe('healthy');
    });

    it('should return degraded when storage is unhealthy but others are healthy', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockRedis.ping.mockResolvedValue('PONG');
      mockRedis.info.mockResolvedValue(sampleRedisMemoryInfo);
      mockAccess.mockRejectedValue(
        new Error('ENOENT: no such file or directory'),
      );

      const result: HealthCheckResult = await service.getHealth();

      expect(result.status).toBe('degraded');
      expect(result.components.storage.status).toBe('unhealthy');
      expect(result.components.database.status).toBe('healthy');
      expect(result.components.redis.status).toBe('healthy');
    });
  });

  // -----------------------------------------------------------------------
  // getHealth — unhealthy
  // -----------------------------------------------------------------------

  describe('getHealth — unhealthy', () => {
    it('should return unhealthy when ALL components are unhealthy', async () => {
      mockPrisma.$queryRaw.mockRejectedValue(new Error('DB down'));
      mockRedis.ping.mockRejectedValue(new Error('Redis down'));
      mockAccess.mockRejectedValue(new Error('Storage inaccessible'));

      const result: HealthCheckResult = await service.getHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.components.database.status).toBe('unhealthy');
      expect(result.components.redis.status).toBe('unhealthy');
      expect(result.components.storage.status).toBe('unhealthy');
    });
  });

  // -----------------------------------------------------------------------
  // checkDatabase (exposed indirectly via getHealth)
  // -----------------------------------------------------------------------

  describe('checkDatabase', () => {
    it('should measure response time for database check', async () => {
      // Introduce a measurable delay so responseTimeMs is a positive number
      mockPrisma.$queryRaw.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve([{ '?column?': 1 }]), 25),
          ),
      );
      mockRedis.ping.mockResolvedValue('PONG');
      mockRedis.info.mockResolvedValue(sampleRedisMemoryInfo);

      const result = await service.getHealth();

      expect(result.components.database.status).toBe('healthy');
      expect(typeof result.components.database.responseTimeMs).toBe('number');
      expect(result.components.database.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle database timeout gracefully', async () => {
      jest.useFakeTimers();

      // A promise that never settles to simulate a hung database connection
      mockPrisma.$queryRaw.mockImplementation(
        () => new Promise(() => { /* intentionally never resolves */ }),
      );
      mockRedis.ping.mockResolvedValue('PONG');
      mockRedis.info.mockResolvedValue(sampleRedisMemoryInfo);

      const healthPromise = service.getHealth();

      // Advance past the 5 000 ms HEALTH_CHECK_TIMEOUT_MS constant
      jest.advanceTimersByTime(6000);

      const result = await healthPromise;

      expect(result.components.database.status).toBe('unhealthy');
      expect(result.components.database.message).toContain('timed out');
    });
  });

  // -----------------------------------------------------------------------
  // checkRedis (exposed indirectly via getHealth)
  // -----------------------------------------------------------------------

  describe('checkRedis', () => {
    it('should include memory info in healthy Redis details', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockRedis.ping.mockResolvedValue('PONG');
      mockRedis.info.mockResolvedValue(sampleRedisMemoryInfo);

      const result = await service.getHealth();

      const redisHealth: ComponentHealth = result.components.redis;
      expect(redisHealth.status).toBe('healthy');
      expect(redisHealth.details).toBeDefined();
      expect(redisHealth.details).toHaveProperty('used_memory_human');
      expect(redisHealth.details).toHaveProperty('used_memory_peak_human');
      expect(redisHealth.details).toHaveProperty('total_system_memory_human');
    });

    it('should handle Redis connection error gracefully', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockRedis.ping.mockRejectedValue(new Error('Connection refused'));

      const result = await service.getHealth();

      expect(result.components.redis.status).toBe('unhealthy');
      expect(result.components.redis.message).toContain('Connection refused');
    });

    it('should return unhealthy when Redis ping returns unexpected response', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockRedis.ping.mockResolvedValue('OK'); // Not 'PONG'

      const result = await service.getHealth();

      expect(result.components.redis.status).toBe('unhealthy');
      expect(result.components.redis.message).toContain('Unexpected ping response');
    });

    it('should remain healthy when ping succeeds but info fails', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockRedis.ping.mockResolvedValue('PONG');
      mockRedis.info.mockRejectedValue(new Error('INFO command disabled'));

      const result = await service.getHealth();

      // Memory info is best-effort — ping success determines health
      expect(result.components.redis.status).toBe('healthy');
    });
  });

  // -----------------------------------------------------------------------
  // checkStorage (exposed indirectly via getHealth)
  // -----------------------------------------------------------------------

  describe('checkStorage', () => {
    it('should return healthy when storage is accessible', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockRedis.ping.mockResolvedValue('PONG');
      mockRedis.info.mockResolvedValue(sampleRedisMemoryInfo);
      mockAccess.mockResolvedValue(undefined);

      const result = await service.getHealth();

      expect(result.components.storage.status).toBe('healthy');
      expect(typeof result.components.storage.responseTimeMs).toBe('number');
      expect(result.components.storage.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy when storage is not accessible', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockRedis.ping.mockResolvedValue('PONG');
      mockRedis.info.mockResolvedValue(sampleRedisMemoryInfo);
      mockAccess.mockRejectedValue(
        new Error("ENOENT: no such file or directory, access './uploads'"),
      );

      const result = await service.getHealth();

      expect(result.components.storage.status).toBe('unhealthy');
      expect(result.components.storage.message).toBeDefined();
      expect(result.components.storage.message).toContain('ENOENT');
    });
  });

  // -----------------------------------------------------------------------
  // getUptime
  // -----------------------------------------------------------------------

  describe('getUptime', () => {
    it('should return uptime in seconds', () => {
      const uptime = service.getUptime();
      expect(typeof uptime).toBe('number');
      expect(uptime).toBeGreaterThanOrEqual(0);
    });

    it('should increase over time', async () => {
      const before = service.getUptime();
      // Wait a small interval to produce a measurable uptime difference
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 60);
      });
      const after = service.getUptime();
      expect(after).toBeGreaterThan(before);
    });
  });

  // -----------------------------------------------------------------------
  // Error isolation
  // -----------------------------------------------------------------------

  describe('error isolation', () => {
    it('should never throw from getHealth — always returns a HealthCheckResult', async () => {
      // Use unusual error subtypes to test broad catch coverage
      mockPrisma.$queryRaw.mockRejectedValue(new TypeError('Unexpected null'));
      mockRedis.ping.mockRejectedValue(new RangeError('Out of bounds'));
      mockAccess.mockRejectedValue(new URIError('Malformed path'));

      // getHealth() must NEVER reject — it always returns a valid result
      const result: HealthCheckResult = await service.getHealth();

      expect(result).toBeDefined();
      expect(['healthy', 'degraded', 'unhealthy']).toContain(result.status);
      expect(result.timestamp).toBeDefined();
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(result.version).toBeDefined();
      expect(result.components).toBeDefined();
      expect(result.components.database).toBeDefined();
      expect(result.components.redis).toBeDefined();
      expect(result.components.storage).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Response structure validation
  // -----------------------------------------------------------------------

  describe('response structure validation', () => {
    beforeEach(() => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockRedis.ping.mockResolvedValue('PONG');
      mockRedis.info.mockResolvedValue(sampleRedisMemoryInfo);
    });

    it('should include all required fields in HealthCheckResult', async () => {
      const result: HealthCheckResult = await service.getHealth();

      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('uptime');
      expect(result).toHaveProperty('version');
      expect(result).toHaveProperty('components');
      expect(result.components).toHaveProperty('database');
      expect(result.components).toHaveProperty('redis');
      expect(result.components).toHaveProperty('storage');
    });

    it('should include required fields in each ComponentHealth', async () => {
      const result = await service.getHealth();

      const componentNames = ['database', 'redis', 'storage'] as const;
      for (const name of componentNames) {
        const component: ComponentHealth = result.components[name];
        expect(component).toHaveProperty('status');
        expect(component).toHaveProperty('responseTimeMs');
        expect(['healthy', 'unhealthy', 'degraded']).toContain(component.status);
        expect(typeof component.responseTimeMs).toBe('number');
      }
    });

    it('should return valid status enum values only', async () => {
      const validStatuses = ['healthy', 'degraded', 'unhealthy'];

      // Verify healthy overall status
      const healthyResult = await service.getHealth();
      expect(validStatuses).toContain(healthyResult.status);

      // Reconfigure mocks to produce unhealthy overall status
      mockPrisma.$queryRaw.mockRejectedValue(new Error('fail'));
      mockRedis.ping.mockRejectedValue(new Error('fail'));
      mockAccess.mockRejectedValue(new Error('fail'));

      const unhealthyResult = await service.getHealth();
      expect(validStatuses).toContain(unhealthyResult.status);
    });
  });
});
