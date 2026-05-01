/**
 * @file auth.test.ts
 * Unit tests for the JWT authentication middleware (R9, R33).
 *
 * NOTE: These tests exercise ONLY the legacy 2-arg overload of
 * `createAuthMiddleware(jwtSecret, cacheProvider)`. The V2 OAuth dispatch
 * overload (FR-9) is exercised by integration tests in
 * `tests/integration/auth.test.ts` and the @blitzy/auth/integration suite.
 *
 * The `@blitzy/auth` and `@blitzy/admin-ui` modules are mocked here because
 * the assigned middleware (`src/middleware/auth.ts`) loads them as TOP-LEVEL
 * STATIC IMPORTS (Rule R3 forbids conditional imports). Without these mocks
 * Jest's resolver would follow the imports into `@blitzy/auth/src/auth/initAuth.ts`
 * which transitively requires the runtime-generated Prisma client. The mocks
 * are runtime-only — they do not affect the legacy code path under test, since
 * the V2 path is never invoked when the legacy 2-arg overload is constructed.
 */
/* ────────────────────────────────────────────────────────────────────────────
 * External module mocks — MUST come before any imports that use them.
 * @blitzy/auth and @blitzy/admin-ui are mocked because the legacy V1 tests
 * never invoke their runtime functions; the assigned middleware imports them
 * statically per Rule R3 but only calls them on the V2 branch.
 * ──────────────────────────────────────────────────────────────────────────── */

jest.mock('@blitzy/auth', () => ({
  createExpressMiddleware: jest.fn(),
}));

jest.mock('@blitzy/admin-ui', () => ({
  checkFlag: jest.fn(),
}));

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
