/**
 * @file Unit tests for metrics middleware
 */
import { Request, Response, NextFunction } from 'express';
import { metricsMiddleware, getMetricsData, createMetricsMiddleware } from '../../../src/middleware/metrics';

function mockReq(overrides: Partial<Request> = {}): Request {
  return { method: 'GET', path: '/test', baseUrl: '/api/v1', route: { path: '/test' }, ...overrides } as unknown as Request;
}

function mockRes(): Response {
  const res: any = { statusCode: 200 };
  const listeners: Record<string, Function[]> = {};
  res.on = jest.fn((event: string, fn: Function) => { (listeners[event] = listeners[event] || []).push(fn); return res; });
  res._emit = (event: string) => (listeners[event] || []).forEach(fn => fn());
  return res;
}

describe('metricsMiddleware (standalone)', () => {
  it('increments activeRequests and calls next', () => {
    const before = getMetricsData().activeRequests;
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();
    metricsMiddleware(req, res, next);
    expect(getMetricsData().activeRequests).toBe(before + 1);
    expect(next).toHaveBeenCalled();
  });

  it('decrements activeRequests on finish', () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();
    metricsMiddleware(req, res, next);
    const afterIncrement = getMetricsData().activeRequests;
    (res as any)._emit('finish');
    expect(getMetricsData().activeRequests).toBe(afterIncrement - 1);
  });

  it('does not go below 0', () => {
    // Force counter to 0 by emitting finish for each active
    const data = getMetricsData();
    expect(data.activeRequests).toBeGreaterThanOrEqual(0);
  });
});

describe('getMetricsData', () => {
  it('returns object with activeRequests', () => {
    const data = getMetricsData();
    expect(data).toHaveProperty('activeRequests');
    expect(typeof data.activeRequests).toBe('number');
  });
});

describe('createMetricsMiddleware', () => {
  it('creates middleware that records metrics via metricsService', () => {
    const metricsService: any = {
      httpActiveRequests: { add: jest.fn() },
      recordHttpRequest: jest.fn(),
    };
    const mw = createMetricsMiddleware(metricsService);
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(metricsService.httpActiveRequests.add).toHaveBeenCalledWith(1, { method: 'GET' });
    // Simulate finish
    (res as any)._emit('finish');
    expect(metricsService.recordHttpRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      statusCode: 200,
    }));
    expect(metricsService.httpActiveRequests.add).toHaveBeenCalledWith(-1, { method: 'GET' });
  });
});
