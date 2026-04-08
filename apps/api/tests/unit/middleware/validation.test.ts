/**
 * @file validation.test.ts
 * Unit tests for Zod validation middleware (R31).
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validate, validateBody, validateParams, validateQuery } from '../../../src/middleware/validation';
import { ValidationError } from '../../../src/errors/ValidationError';

function makeReq(overrides: Partial<Request> = {}): Request {
  return { body: {}, query: {}, params: {}, headers: {}, ...overrides } as unknown as Request;
}
function makeRes(): Response {
  return {} as unknown as Response;
}

describe('Validation Middleware (R31)', () => {
  let next: jest.Mock;

  beforeEach(() => {
    next = jest.fn();
  });

  describe('validate()', () => {
    it('should call next() with no error when all schemas pass', () => {
      const mw = validate({
        body: z.object({ name: z.string() }),
      });
      mw(makeReq({ body: { name: 'Alice' } }), makeRes(), next);
      expect(next).toHaveBeenCalledWith();
    });

    it('should call next with ValidationError when body validation fails', () => {
      const mw = validate({ body: z.object({ email: z.string().email() }) });
      mw(makeReq({ body: { email: 'not-an-email' } }), makeRes(), next);
      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('should call next with ValidationError when query validation fails', () => {
      const mw = validate({ query: z.object({ page: z.coerce.number().min(1) }) });
      mw(makeReq({ query: { page: '-1' } as any }), makeRes(), next);
      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('should call next with ValidationError when params validation fails', () => {
      const mw = validate({ params: z.object({ id: z.string().uuid() }) });
      mw(makeReq({ params: { id: 'not-uuid' } }), makeRes(), next);
      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('should replace req.body with parsed data on success', () => {
      const mw = validate({ body: z.object({ count: z.coerce.number().default(10) }) });
      const req = makeReq({ body: {} });
      mw(req, makeRes(), next);
      expect(next).toHaveBeenCalledWith();
      expect(req.body).toEqual({ count: 10 });
    });

    it('should aggregate errors from body, query, and params', () => {
      const mw = validate({
        body: z.object({ name: z.string() }),
        query: z.object({ limit: z.coerce.number() }),
        params: z.object({ id: z.string().uuid() }),
      });
      mw(makeReq({ body: {}, query: {} as any, params: { id: 'bad' } }), makeRes(), next);
      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });

  describe('validateBody()', () => {
    it('should validate body only', () => {
      const mw = validateBody(z.object({ password: z.string().min(8) }));
      mw(makeReq({ body: { password: 'short' } }), makeRes(), next);
      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('should pass with valid body', () => {
      const mw = validateBody(z.object({ password: z.string().min(8) }));
      mw(makeReq({ body: { password: 'longpassword' } }), makeRes(), next);
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('validateParams()', () => {
    it('should validate params only', () => {
      const mw = validateParams(z.object({ id: z.string().uuid() }));
      mw(makeReq({ params: { id: 'valid-but-not-uuid' } }), makeRes(), next);
      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });

  describe('validateQuery()', () => {
    it('should validate query only', () => {
      const mw = validateQuery(z.object({ search: z.string().min(1) }));
      mw(makeReq({ query: { search: '' } as any }), makeRes(), next);
      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });
  });
});
