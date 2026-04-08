/**
 * Unit tests for HealthController — per R16, R37.
 */
import { Request, Response, NextFunction } from 'express';
import { HealthController } from '../../../src/controllers/HealthController';

const mockHealthService = {
  getHealth: jest.fn(),
};

const mockMetricsService = {
  getMetrics: jest.fn(),
};

function buildReq(): Partial<Request> {
  return {} as Partial<Request>;
}

function buildRes(): {
  res: Partial<Response>;
  statusFn: jest.Mock;
  jsonFn: jest.Mock;
  setFn: jest.Mock;
  sendFn: jest.Mock;
} {
  const jsonFn = jest.fn();
  const sendFn = jest.fn();
  const setFn = jest.fn().mockReturnValue({ status: jest.fn().mockReturnValue({ send: sendFn }) });
  const statusFn = jest.fn().mockReturnValue({ json: jsonFn });
  return { res: { status: statusFn, set: setFn } as Partial<Response>, statusFn, jsonFn, setFn, sendFn };
}

describe('HealthController', () => {
  let ctrl: HealthController;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    ctrl = new HealthController(mockHealthService as any, mockMetricsService as any);
    next = jest.fn();
  });

  // ── check ───────────────────────────────────────────────────────
  it('check returns 200 with healthy status', async () => {
    mockHealthService.getHealth.mockResolvedValue({
      status: 'healthy',
      version: '1.0.0',
      uptime: 100,
      components: {
        database: { status: 'healthy', responseTimeMs: 5 },
        redis: { status: 'healthy', responseTimeMs: 2 },
        storage: { status: 'healthy', responseTimeMs: 1 },
      },
    });
    const req = buildReq();
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.check(req as Request, res as Response, next);

    expect(mockHealthService.getHealth).toHaveBeenCalled();
    expect(statusFn).toHaveBeenCalledWith(200);
    const response = jsonFn.mock.calls[0][0];
    expect(response.data.status).toBe('healthy');
    expect(response.data.components).toHaveProperty('database');
    expect(response.data.components).toHaveProperty('redis');
    expect(response.data.components).toHaveProperty('queue');
    expect(response.data.components).toHaveProperty('storage');
  });

  it('check returns 503 when unhealthy', async () => {
    mockHealthService.getHealth.mockResolvedValue({
      status: 'unhealthy',
      version: '1.0.0',
      uptime: 100,
      components: {
        database: { status: 'unhealthy', responseTimeMs: 0, details: 'Connection refused' },
        redis: { status: 'healthy', responseTimeMs: 2 },
        storage: { status: 'healthy', responseTimeMs: 1 },
      },
    });
    const req = buildReq();
    const { res, statusFn } = buildRes();

    await ctrl.check(req as Request, res as Response, next);

    expect(statusFn).toHaveBeenCalledWith(503);
  });

  it('check propagates queue details from redis details', async () => {
    mockHealthService.getHealth.mockResolvedValue({
      status: 'degraded',
      version: '1.0.0',
      uptime: 100,
      components: {
        database: { status: 'healthy', responseTimeMs: 5 },
        redis: { status: 'unhealthy', responseTimeMs: 0, details: 'Redis down' },
        storage: { status: 'healthy', responseTimeMs: 1 },
      },
    });
    const req = buildReq();
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.check(req as Request, res as Response, next);

    const response = jsonFn.mock.calls[0][0];
    // queue status should be 'down' when redis is unhealthy
    expect(response.data.components.queue.status).toBe('down');
    expect(response.data.components.queue.details).toBe('Redis down');
  });

  it('check delegates errors to next', async () => {
    mockHealthService.getHealth.mockRejectedValue(new Error('fail'));
    const req = buildReq();
    const { res } = buildRes();

    await ctrl.check(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── metrics ─────────────────────────────────────────────────────
  it('metrics returns 200 with text/plain content type', async () => {
    const metricsText = '# HELP http_requests Total\nhttp_requests 42\n';
    mockMetricsService.getMetrics.mockResolvedValue(metricsText);
    const req = buildReq();
    const { res, setFn, sendFn } = buildRes();

    await ctrl.metrics(req as Request, res as Response, next);

    expect(mockMetricsService.getMetrics).toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    expect(sendFn).toHaveBeenCalledWith(metricsText);
  });

  it('metrics delegates errors to next', async () => {
    mockMetricsService.getMetrics.mockRejectedValue(new Error('fail'));
    const req = buildReq();
    const { res } = buildRes();

    await ctrl.metrics(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
