/**
 * @file ws-auth.test.ts
 * @description Unit tests for WebSocket authentication middleware (R9, R33).
 */
import jwt from 'jsonwebtoken';
import { createWsAuthMiddleware } from '../../../../src/websocket/middleware/ws-auth';
import type { ICacheProvider } from '../../../../src/domain/interfaces/ICacheProvider';

// Mock uuid to return deterministic value
jest.mock('uuid', () => ({ v4: () => 'mock-uuid-v4' }));

function mockCacheProvider(): jest.Mocked<ICacheProvider> {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    setNx: jest.fn().mockResolvedValue(true),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(true),
    ttl: jest.fn().mockResolvedValue(-1),
  };
}

const JWT_SECRET = 'test-secret-key';

function makeValidToken(overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    { sub: 'user-1', email: 'user@test.com', jti: 'jti-1', type: 'access', displayName: 'Test', ...overrides },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeSocket(token?: string): { handshake: { auth: Record<string, unknown> }; data: Record<string, unknown> } {
  return {
    handshake: { auth: { token } },
    data: {},
  };
}

describe('createWsAuthMiddleware', () => {
  let cache: jest.Mocked<ICacheProvider>;
  let middleware: (socket: any, next: (err?: Error) => void) => void;

  beforeEach(() => {
    cache = mockCacheProvider();
    middleware = createWsAuthMiddleware(JWT_SECRET, cache);
  });

  it('should call next() without error for valid access token', (done) => {
    const token = makeValidToken();
    const socket = makeSocket(token);
    middleware(socket as any, (err?: Error) => {
      expect(err).toBeUndefined();
      expect(socket.data.userId).toBe('user-1');
      expect(socket.data.email).toBe('user@test.com');
      expect(socket.data.correlationId).toBe('mock-uuid-v4');
      expect(socket.data.jti).toBe('jti-1');
      done();
    });
  });

  it('should reject when no token is provided', (done) => {
    const socket = makeSocket(undefined);
    middleware(socket as any, (err?: Error) => {
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('No token provided');
      done();
    });
  });

  it('should reject when token is empty string', (done) => {
    const socket = makeSocket('');
    middleware(socket as any, (err?: Error) => {
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('No token provided');
      done();
    });
  });

  it('should reject an invalid/malformed JWT', (done) => {
    const socket = makeSocket('not-a-valid-jwt');
    middleware(socket as any, (err?: Error) => {
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('Invalid token');
      done();
    });
  });

  it('should reject an expired JWT', (done) => {
    const token = jwt.sign(
      { sub: 'user-1', email: 'u@test.com', jti: 'j-1', type: 'access' },
      JWT_SECRET,
      { expiresIn: '-1s' },
    );
    const socket = makeSocket(token);
    middleware(socket as any, (err?: Error) => {
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('Invalid token');
      done();
    });
  });

  it('should reject a refresh token (type !== access)', (done) => {
    const token = makeValidToken({ type: 'refresh' });
    const socket = makeSocket(token);
    middleware(socket as any, (err?: Error) => {
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('Invalid token type');
      done();
    });
  });

  it('should reject a token with missing sub claim', (done) => {
    const token = jwt.sign({ email: 'u@t.com', jti: 'j-1', type: 'access' }, JWT_SECRET, { expiresIn: '1h' });
    const socket = makeSocket(token);
    middleware(socket as any, (err?: Error) => {
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('Malformed token payload');
      done();
    });
  });

  it('should reject a token with missing jti claim', (done) => {
    const token = jwt.sign({ sub: 'u-1', email: 'u@t.com', type: 'access' }, JWT_SECRET, { expiresIn: '1h' });
    const socket = makeSocket(token);
    middleware(socket as any, (err?: Error) => {
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('Malformed token payload');
      done();
    });
  });

  it('should reject a blacklisted/revoked token (R33)', (done) => {
    cache.exists.mockResolvedValue(true);
    const token = makeValidToken();
    const socket = makeSocket(token);
    middleware(socket as any, (err?: Error) => {
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('revoked');
      expect(cache.exists).toHaveBeenCalledWith('blacklist:jti-1');
      done();
    });
  });

  it('should handle internal cache errors gracefully', (done) => {
    cache.exists.mockRejectedValue(new Error('Redis down'));
    const token = makeValidToken();
    const socket = makeSocket(token);
    middleware(socket as any, (err?: Error) => {
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('Internal server error');
      done();
    });
  });

  it('should set displayName from token or empty string', (done) => {
    const token = makeValidToken({ displayName: undefined });
    const socket = makeSocket(token);
    middleware(socket as any, (err?: Error) => {
      expect(err).toBeUndefined();
      expect(socket.data.displayName).toBe('');
      done();
    });
  });
});
