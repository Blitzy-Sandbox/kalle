/**
 * @file Unit tests for correlation-id middleware
 */
jest.mock('uuid', () => ({ v4: jest.fn(() => 'generated-uuid-v4') }));

import { Request, Response, NextFunction } from 'express';
import { correlationIdMiddleware } from '../../../src/middleware/correlation-id';

function mockReq(headers: Record<string, string | string[] | undefined> = {}): Request {
  return { headers } as unknown as Request;
}

function mockRes(): Response {
  const res: any = {};
  res.setHeader = jest.fn();
  return res;
}

describe('correlationIdMiddleware', () => {
  let next: NextFunction;
  beforeEach(() => { next = jest.fn(); });

  it('generates a UUID when no header is present', () => {
    const req = mockReq();
    const res = mockRes();
    correlationIdMiddleware(req, res, next);
    expect(req.correlationId).toBe('generated-uuid-v4');
    expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-ID', 'generated-uuid-v4');
    expect(next).toHaveBeenCalled();
  });

  it('uses valid existing X-Correlation-ID header', () => {
    const req = mockReq({ 'x-correlation-id': 'client-abc-123' });
    const res = mockRes();
    correlationIdMiddleware(req, res, next);
    expect(req.correlationId).toBe('client-abc-123');
  });

  it('uses first value from array header', () => {
    const req = mockReq({ 'x-correlation-id': ['first-id', 'second-id'] });
    const res = mockRes();
    correlationIdMiddleware(req, res, next);
    expect(req.correlationId).toBe('first-id');
  });

  it('rejects empty header and generates UUID', () => {
    const req = mockReq({ 'x-correlation-id': '  ' });
    const res = mockRes();
    correlationIdMiddleware(req, res, next);
    expect(req.correlationId).toBe('generated-uuid-v4');
  });

  it('rejects header with unsafe characters and generates UUID', () => {
    const req = mockReq({ 'x-correlation-id': '<script>alert(1)</script>' });
    const res = mockRes();
    correlationIdMiddleware(req, res, next);
    expect(req.correlationId).toBe('generated-uuid-v4');
  });

  it('rejects header exceeding max length and generates UUID', () => {
    const req = mockReq({ 'x-correlation-id': 'a'.repeat(200) });
    const res = mockRes();
    correlationIdMiddleware(req, res, next);
    expect(req.correlationId).toBe('generated-uuid-v4');
  });

  it('accepts UUID-format correlation ID', () => {
    const req = mockReq({ 'x-correlation-id': '550e8400-e29b-41d4-a716-446655440000' });
    const res = mockRes();
    correlationIdMiddleware(req, res, next);
    expect(req.correlationId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('accepts correlation ID with dots, colons, underscores', () => {
    const req = mockReq({ 'x-correlation-id': 'trace_id:span.1234' });
    const res = mockRes();
    correlationIdMiddleware(req, res, next);
    expect(req.correlationId).toBe('trace_id:span.1234');
  });

  it('always calls next()', () => {
    const req = mockReq();
    const res = mockRes();
    correlationIdMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
