/**
 * @file QueueProvider.test.ts — Unit tests for BullMQ QueueProvider
 *
 * Tests all IQueueProvider interface methods: enqueue, enqueueBulk,
 * scheduleRepeat, removeRepeat, getQueueDepth, close, and setMetricsService.
 */

// Mock BullMQ Queue class
const mockAdd = jest.fn();
const mockAddBulk = jest.fn();
const mockRemoveRepeatable = jest.fn();
const mockGetJobCounts = jest.fn();
const mockClose = jest.fn();

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockAdd,
    addBulk: mockAddBulk,
    removeRepeatable: mockRemoveRepeatable,
    getJobCounts: mockGetJobCounts,
    close: mockClose,
  })),
}));

import { QueueProvider } from '../../../src/providers/QueueProvider';
import type { QueueJobName } from '../../../src/domain/interfaces/IQueueProvider';

describe('QueueProvider', () => {
  let queueProvider: QueueProvider;
  const mockRedis = {} as any;
  const testRedisUrl = 'redis://localhost:6379';

  beforeEach(() => {
    jest.clearAllMocks();
    queueProvider = new QueueProvider(mockRedis, testRedisUrl);
  });

  // ---- enqueue ----
  describe('enqueue()', () => {
    it('should add a job to the queue and return JobInfo', async () => {
      mockAdd.mockResolvedValue({ id: 'job-1', name: 'link-preview', timestamp: 1000 });

      const result = await queueProvider.enqueue(
        'link-preview' as QueueJobName,
        { url: 'https://example.com' },
      );

      expect(mockAdd).toHaveBeenCalledWith(
        'link-preview',
        { url: 'https://example.com' },
        expect.any(Object),
      );
      expect(result).toEqual({
        id: 'job-1',
        name: 'link-preview',
        createdAt: 1000,
      });
    });

    it('should inject correlationId into payload when provided', async () => {
      mockAdd.mockResolvedValue({ id: 'job-2', name: 'link-preview', timestamp: 2000 });

      await queueProvider.enqueue(
        'link-preview' as QueueJobName,
        { url: 'https://example.com' },
        { correlationId: 'req-abc' },
      );

      expect(mockAdd).toHaveBeenCalledWith(
        'link-preview',
        { url: 'https://example.com', correlationId: 'req-abc' },
        expect.any(Object),
      );
    });

    it('should pass delay, attempts, priority, and backoff options', async () => {
      mockAdd.mockResolvedValue({ id: 'job-3', name: 'message-fanout', timestamp: 3000 });

      await queueProvider.enqueue(
        'message-fanout' as QueueJobName,
        { recipientId: 'user-1' },
        {
          delay: 5000,
          attempts: 5,
          priority: 1,
          backoff: { type: 'exponential', delay: 2000 },
        },
      );

      expect(mockAdd).toHaveBeenCalledWith(
        'message-fanout',
        { recipientId: 'user-1' },
        expect.objectContaining({
          delay: 5000,
          attempts: 5,
          priority: 1,
          backoff: { type: 'exponential', delay: 2000 },
        }),
      );
    });

    it('should record metrics when metrics service is set', async () => {
      const mockMetrics = {
        recordBullmqJob: jest.fn(),
        bullmqQueueDepth: { add: jest.fn() },
      };
      queueProvider.setMetricsService(mockMetrics);
      mockAdd.mockResolvedValue({ id: 'job-4', name: 'link-preview', timestamp: 4000 });

      await queueProvider.enqueue(
        'link-preview' as QueueJobName,
        { url: 'https://example.com' },
      );

      expect(mockMetrics.recordBullmqJob).toHaveBeenCalledWith({
        jobName: 'link-preview',
        status: 'enqueued',
        durationMs: 0,
      });
      expect(mockMetrics.bullmqQueueDepth.add).toHaveBeenCalledWith(1, { queue: 'kalle-jobs' });
    });

    it('should handle null job id', async () => {
      mockAdd.mockResolvedValue({ id: null, name: 'test', timestamp: 0 });
      const result = await queueProvider.enqueue('link-preview' as QueueJobName, {});
      expect(result.id).toBe('');
    });
  });

  // ---- enqueueBulk ----
  describe('enqueueBulk()', () => {
    it('should add multiple jobs atomically', async () => {
      mockAddBulk.mockResolvedValue([
        { id: 'b1', name: 'message-fanout', timestamp: 1000 },
        { id: 'b2', name: 'message-fanout', timestamp: 1001 },
      ]);

      const result = await queueProvider.enqueueBulk([
        { name: 'message-fanout' as QueueJobName, payload: { recipientId: 'u1' } },
        { name: 'message-fanout' as QueueJobName, payload: { recipientId: 'u2' } },
      ]);

      expect(mockAddBulk).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'message-fanout', data: { recipientId: 'u1' } }),
          expect.objectContaining({ name: 'message-fanout', data: { recipientId: 'u2' } }),
        ]),
      );
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('b1');
      expect(result[1].id).toBe('b2');
    });

    it('should inject correlationId in bulk jobs', async () => {
      mockAddBulk.mockResolvedValue([
        { id: 'b1', name: 'message-fanout', timestamp: 1000 },
      ]);

      await queueProvider.enqueueBulk([
        {
          name: 'message-fanout' as QueueJobName,
          payload: { recipientId: 'u1' },
          options: { correlationId: 'corr-1' },
        },
      ]);

      expect(mockAddBulk).toHaveBeenCalledWith([
        expect.objectContaining({
          data: { recipientId: 'u1', correlationId: 'corr-1' },
        }),
      ]);
    });

    it('should record metrics for each bulk job when metrics service is set', async () => {
      const mockMetrics = {
        recordBullmqJob: jest.fn(),
        bullmqQueueDepth: { add: jest.fn() },
      };
      queueProvider.setMetricsService(mockMetrics);
      mockAddBulk.mockResolvedValue([
        { id: 'b1', name: 'message-fanout', timestamp: 1000 },
        { id: 'b2', name: 'message-fanout', timestamp: 1001 },
      ]);

      await queueProvider.enqueueBulk([
        { name: 'message-fanout' as QueueJobName, payload: { recipientId: 'u1' } },
        { name: 'message-fanout' as QueueJobName, payload: { recipientId: 'u2' } },
      ]);

      expect(mockMetrics.recordBullmqJob).toHaveBeenCalledTimes(2);
      expect(mockMetrics.bullmqQueueDepth.add).toHaveBeenCalledWith(2, { queue: 'kalle-jobs' });
    });
  });

  // ---- scheduleRepeat ----
  describe('scheduleRepeat()', () => {
    it('should add a repeatable job with cron pattern', async () => {
      mockAdd.mockResolvedValue({ id: 'cron-1', name: 'story-cleanup', timestamp: 5000 });

      const result = await queueProvider.scheduleRepeat(
        'story-cleanup' as QueueJobName,
        {},
        '0 * * * *',
      );

      expect(mockAdd).toHaveBeenCalledWith(
        'story-cleanup',
        {},
        expect.objectContaining({
          repeat: { pattern: '0 * * * *' },
        }),
      );
      expect(result).toEqual({
        id: 'cron-1',
        name: 'story-cleanup',
        createdAt: 5000,
      });
    });

    it('should pass retry options to repeatable jobs', async () => {
      mockAdd.mockResolvedValue({ id: 'cron-2', name: 'audit-log-cleanup', timestamp: 6000 });

      await queueProvider.scheduleRepeat(
        'audit-log-cleanup' as QueueJobName,
        {},
        '0 0 * * 0',
        { attempts: 5, backoff: { type: 'fixed', delay: 3000 } },
      );

      expect(mockAdd).toHaveBeenCalledWith(
        'audit-log-cleanup',
        {},
        expect.objectContaining({
          attempts: 5,
          backoff: { type: 'fixed', delay: 3000 },
        }),
      );
    });
  });

  // ---- removeRepeat ----
  describe('removeRepeat()', () => {
    it('should remove a repeatable job by name and cron pattern', async () => {
      mockRemoveRepeatable.mockResolvedValue(undefined);
      await queueProvider.removeRepeat('story-cleanup' as QueueJobName, '0 * * * *');
      expect(mockRemoveRepeatable).toHaveBeenCalledWith('story-cleanup', {
        pattern: '0 * * * *',
      });
    });
  });

  // ---- getQueueDepth ----
  describe('getQueueDepth()', () => {
    it('should return combined count of waiting + delayed + active', async () => {
      mockGetJobCounts.mockResolvedValue({ waiting: 10, delayed: 5, active: 3 });
      const depth = await queueProvider.getQueueDepth();
      expect(depth).toBe(18);
      expect(mockGetJobCounts).toHaveBeenCalledWith('waiting', 'delayed', 'active');
    });

    it('should return 0 when queue is empty', async () => {
      mockGetJobCounts.mockResolvedValue({ waiting: 0, delayed: 0, active: 0 });
      const depth = await queueProvider.getQueueDepth();
      expect(depth).toBe(0);
    });
  });

  // ---- close ----
  describe('close()', () => {
    it('should close the underlying queue', async () => {
      mockClose.mockResolvedValue(undefined);
      await queueProvider.close();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  // ---- setMetricsService ----
  describe('setMetricsService()', () => {
    it('should accept and store metrics service', () => {
      const mockMetrics = {
        recordBullmqJob: jest.fn(),
        bullmqQueueDepth: { add: jest.fn() },
      };
      // Should not throw
      expect(() => queueProvider.setMetricsService(mockMetrics)).not.toThrow();
    });
  });

  // ---- constructor URL parsing ----
  describe('constructor — Redis URL parsing', () => {
    it('should parse redis:// URL with password and db', () => {
      // This just verifies the constructor doesn't throw for various URL formats
      expect(() => new QueueProvider(mockRedis, 'redis://:secret@redis-host:6380/2')).not.toThrow();
    });

    it('should parse rediss:// URL for TLS', () => {
      expect(() => new QueueProvider(mockRedis, 'rediss://redis-host:6380')).not.toThrow();
    });

    it('should use default port when none specified', () => {
      expect(() => new QueueProvider(mockRedis, 'redis://localhost')).not.toThrow();
    });
  });
});
