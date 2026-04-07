/**
 * @file auth.test.ts
 * Unit tests for the JWT authentication middleware (R9, R33).
 */
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createAuthMiddleware } from '../../../src/middleware/auth';
import { AuthenticationError } from '../../../src/errors/AuthenticationError';

// ── Mocks ───────────────────────────────────────────────────────────────────
const mockCacheProvider = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  exists: jest.fn(),
  setex: jest.fn(),
  ttl: jest.fn(),
  keys: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
};

const JWT_SECRET = 'test-jwt-secret-key-for-unit-tests';

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}
function makeRes(): Response {
  return {} as unknown as Response;
}

describe('Auth Middleware (R9, R33)', () => {
  let middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  let next: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCacheProvider.exists.mockResolvedValue(false);
    middleware = createAuthMiddleware(JWT_SECRET, mockCacheProvider as any);
    next = jest.fn();
  });

  it('should call next with AuthenticationError when Authorization header is missing', async () => {
    await middleware(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
  });

  it('should call next with AuthenticationError when Bearer prefix is missing', async () => {
    await middleware(makeReq({ authorization: 'Token abc' }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
  });

  it('should call next with AuthenticationError when token is empty', async () => {
    await middleware(makeReq({ authorization: 'Bearer ' }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
  });

  it('should call next with AuthenticationError for invalid token', async () => {
    await middleware(makeReq({ authorization: 'Bearer invalid.token.here' }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
  });

  it('should call next with AuthenticationError for expired token', async () => {
    const token = jwt.sign(
      { sub: 'user-1', email: 'a@b.com', jti: 'jti-1' },
      JWT_SECRET,
      { expiresIn: -10 },
    );
    await middleware(makeReq({ authorization: `Bearer ${token}` }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
  });

  it('should call next with AuthenticationError when sub claim is missing', async () => {
    const token = jwt.sign({ email: 'a@b.com', jti: 'jti-1' }, JWT_SECRET, { expiresIn: '1h' });
    await middleware(makeReq({ authorization: `Bearer ${token}` }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
  });

  it('should call next with AuthenticationError when jti claim is missing', async () => {
    const token = jwt.sign({ sub: 'user-1', email: 'a@b.com' }, JWT_SECRET, {
      expiresIn: '1h',
      noTimestamp: false,
    });
    // Remove jti — sign without it
    await middleware(makeReq({ authorization: `Bearer ${token}` }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
  });

  it('should call next with AuthenticationError when token is blacklisted (R33)', async () => {
    mockCacheProvider.exists.mockResolvedValue(true);
    const token = jwt.sign(
      { sub: 'user-1', email: 'a@b.com', jti: 'revoked-jti' },
      JWT_SECRET,
      { expiresIn: '1h' },
    );
    await middleware(makeReq({ authorization: `Bearer ${token}` }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
    expect(mockCacheProvider.exists).toHaveBeenCalledWith('blacklist:revoked-jti');
  });

  it('should attach user to req and call next() for valid non-blacklisted token', async () => {
    const token = jwt.sign(
      { sub: 'user-1', email: 'test@example.com', jti: 'valid-jti' },
      JWT_SECRET,
      { expiresIn: '1h' },
    );
    const req = makeReq({ authorization: `Bearer ${token}` });
    await middleware(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toBeDefined();
    expect(req.user!.userId).toBe('user-1');
    expect(req.user!.email).toBe('test@example.com');
    expect(req.user!.jti).toBe('valid-jti');
  });

  it('should check blacklist with correct key format', async () => {
    const token = jwt.sign(
      { sub: 'user-1', email: 'a@b.com', jti: 'my-jti-123' },
      JWT_SECRET,
      { expiresIn: '1h' },
    );
    await middleware(makeReq({ authorization: `Bearer ${token}` }), makeRes(), next);
    expect(mockCacheProvider.exists).toHaveBeenCalledWith('blacklist:my-jti-123');
  });
});
