/**
 * @file Unit tests for error-handler middleware
 * Tests: DomainError handling, Prisma P2002, ZodError safety-net,
 *        body-parser errors, payload too large, multer errors, unknown errors
 */
import { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../../../src/middleware/error-handler';
import { DomainError } from '../../../src/errors/DomainError';
import { ValidationError } from '../../../src/errors/ValidationError';
import { AuthenticationError } from '../../../src/errors/AuthenticationError';
import { NotFoundError } from '../../../src/errors/NotFoundError';
import { ConflictError } from '../../../src/errors/ConflictError';
import { PayloadTooLargeError } from '../../../src/errors/PayloadTooLargeError';
import { RateLimitError } from '../../../src/errors/RateLimitError';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    log: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
    correlationId: 'test-corr-id',
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response & { _status: number; _json: unknown } {
  const res: any = { _status: 0, _json: null };
  res.status = jest.fn((code: number) => { res._status = code; return res; });
  res.json = jest.fn((body: unknown) => { res._json = body; return res; });
  return res;
}

const next: NextFunction = jest.fn();

describe('errorHandler', () => {
  describe('DomainError handling', () => {
    it('handles AuthenticationError (401)', () => {
      const err = new AuthenticationError('Bad creds');
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res._json.error.code).toBe('AUTHENTICATION_ERROR');
      expect(res._json.error.correlationId).toBe('test-corr-id');
    });

    it('handles NotFoundError (404)', () => {
      const err = new NotFoundError('User not found');
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res._json.error.code).toBe('NOT_FOUND');
    });

    it('handles ValidationError with details (400)', () => {
      const err = new ValidationError('Invalid input', { fields: [{ field: 'email', message: 'required' }] });
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res._json.error.code).toBe('VALIDATION_ERROR');
      expect(res._json.error.details).toBeDefined();
    });

    it('handles ConflictError (409)', () => {
      const err = new ConflictError('Already exists');
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('handles PayloadTooLargeError (413)', () => {
      const err = new PayloadTooLargeError('Too big');
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(413);
    });

    it('handles RateLimitError (429)', () => {
      const err = new RateLimitError('Slow down');
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(429);
    });

    it('logs server errors at error level (500+ DomainError)', () => {
      // DomainError constructor: (message, code, statusCode, details?)
      const err = new DomainError('Server boom', 'INTERNAL', 500);
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(req.log!.error).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('logs client errors at warn level', () => {
      const err = new AuthenticationError('Bad token');
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(req.log!.warn).toHaveBeenCalled();
    });

    it('uses X-Correlation-ID header when correlationId not set', () => {
      const err = new NotFoundError('Gone');
      const req = mockReq({ correlationId: undefined, headers: { 'x-correlation-id': 'header-id' } });
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res._json.error.correlationId).toBe('header-id');
    });

    it('omits correlationId from response when not available', () => {
      const err = new NotFoundError('Gone');
      const req = mockReq({ correlationId: undefined, headers: {} });
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res._json.error.correlationId).toBeUndefined();
    });

    it('works without req.log', () => {
      const err = new AuthenticationError('No logger');
      const req = mockReq({ log: undefined as any });
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('Prisma P2002 constraint violation', () => {
    it('returns 409 for unique constraint violation', () => {
      const err = new Error('Unique constraint') as any;
      err.name = 'PrismaClientKnownRequestError';
      err.code = 'P2002';
      err.meta = { target: ['email'] };
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res._json.error.code).toBe('CONFLICT');
      expect(res._json.error.message).toContain('email');
    });

    it('handles P2002 with empty target', () => {
      const err = new Error('Constraint') as any;
      err.name = 'PrismaClientKnownRequestError';
      err.code = 'P2002';
      err.meta = {};
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res._json.error.message).toContain('unknown field');
    });

    it('handles P2002 via constructor name', () => {
      function PrismaClientKnownRequestError(this: any, msg: string) {
        Error.call(this, msg);
        this.message = msg;
        this.code = 'P2002';
        this.meta = { target: ['phone'] };
      }
      PrismaClientKnownRequestError.prototype = Object.create(Error.prototype);
      PrismaClientKnownRequestError.prototype.constructor = PrismaClientKnownRequestError;
      const err = new (PrismaClientKnownRequestError as any)('dup');
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(409);
    });
  });

  describe('ZodError safety-net', () => {
    it('returns 400 for uncaught ZodError', () => {
      const err = new Error('Validation') as any;
      err.name = 'ZodError';
      err.issues = [
        { path: ['body', 'email'], message: 'Required', code: 'invalid_type' },
        { path: ['body', 'name'], message: 'Too short', code: 'too_small' },
      ];
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res._json.error.code).toBe('VALIDATION_ERROR');
      expect(res._json.error.details.fields).toHaveLength(2);
      expect(res._json.error.details.fields[0].field).toBe('body.email');
    });

    it('handles ZodError with empty issues', () => {
      const err = new Error('Zod') as any;
      err.name = 'ZodError';
      err.issues = [];
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res._json.error.details.fields).toHaveLength(0);
    });
  });

  describe('Express body-parser errors', () => {
    it('returns 400 for entity.parse.failed', () => {
      const err = new Error('bad json') as any;
      err.type = 'entity.parse.failed';
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res._json.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for JSON parse error by message heuristic', () => {
      const err = new Error('Unexpected token in JSON at position 0') as any;
      err.status = 400;
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 413 for entity.too.large', () => {
      const err = new Error('too large') as any;
      err.type = 'entity.too.large';
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(413);
      expect(res._json.error.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('returns 413 for status 413', () => {
      const err = new Error('payload too large') as any;
      err.status = 413;
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(413);
    });
  });

  describe('Multer errors', () => {
    it('returns 413 for LIMIT_FILE_SIZE', () => {
      const err = new Error('File too large') as any;
      err.name = 'MulterError';
      err.code = 'LIMIT_FILE_SIZE';
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(413);
      expect(res._json.error.message).toContain('25MB');
    });
  });

  describe('Unknown errors', () => {
    it('returns 500 for generic Error', () => {
      const err = new Error('Something went wrong');
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res._json.error.code).toBe('INTERNAL_ERROR');
      expect(res._json.error.message).toBe('An unexpected error occurred');
    });

    it('logs stack trace server-side', () => {
      const err = new Error('crash');
      const req = mockReq();
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(req.log!.error).toHaveBeenCalledWith(
        expect.objectContaining({ stack: expect.any(String) }),
        'Unexpected internal error'
      );
    });

    it('works when req.log is undefined', () => {
      const err = new Error('crash no log');
      const req = mockReq({ log: undefined as any });
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('uses array x-correlation-id header first value', () => {
      const err = new Error('fail');
      const req = mockReq({
        correlationId: undefined,
        headers: { 'x-correlation-id': ['id-a', 'id-b'] },
      });
      const res = mockRes();
      errorHandler(err, req, res, next);
      expect(res._json.error.correlationId).toBe('id-a');
    });
  });
});
