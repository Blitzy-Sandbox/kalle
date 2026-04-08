/**
 * Unit tests for SessionRepository — per R16, R17, R33.
 */
import { SessionRepository } from '../../../src/repositories/SessionRepository';

function mockPrisma() {
  return {
    session: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  } as any;
}

const SESSION_ROW = {
  id: 's-1',
  userId: 'u-1',
  jti: 'jti-1',
  isRevoked: false,
  expiresAt: new Date(Date.now() + 3600000),
  createdAt: new Date(),
  userAgent: 'test',
  ipAddress: '127.0.0.1',
};

const REFRESH_ROW = {
  id: 'rt-1',
  token: 'tok-abc',
  sessionId: 's-1',
  userId: 'u-1',
  isRevoked: false,
  expiresAt: new Date(Date.now() + 86400000),
  createdAt: new Date(),
};

describe('SessionRepository', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let repo: SessionRepository;

  beforeEach(() => {
    prisma = mockPrisma();
    repo = new SessionRepository(prisma);
  });

  it('createSession persists session', async () => {
    prisma.session.create.mockResolvedValue(SESSION_ROW);
    const result = await repo.createSession({
      userId: 'u-1',
      jti: 'jti-1',
      expiresAt: new Date(),
      userAgent: 'test',
      ipAddress: '127.0.0.1',
    });
    expect(result).toHaveProperty('jti', 'jti-1');
  });

  it('findSessionByJti finds session', async () => {
    prisma.session.findUnique.mockResolvedValue(SESSION_ROW);
    const result = await repo.findSessionByJti('jti-1');
    expect(result).toHaveProperty('id', 's-1');
  });

  it('revokeSessionByJti marks revoked', async () => {
    prisma.session.update.mockResolvedValue({ ...SESSION_ROW, isRevoked: true });
    await repo.revokeSessionByJti('jti-1');
    expect(prisma.session.update).toHaveBeenCalled();
  });

  it('revokeAllSessionsByUserId revokes all', async () => {
    prisma.session.updateMany.mockResolvedValue({ count: 3 });
    const count = await repo.revokeAllSessionsByUserId('u-1');
    expect(count).toBe(3);
  });

  it('findActiveSessionsByUserId returns active sessions', async () => {
    prisma.session.findMany.mockResolvedValue([SESSION_ROW]);
    const result = await repo.findActiveSessionsByUserId('u-1');
    expect(result.length).toBe(1);
  });

  it('deleteExpiredSessions cleans up', async () => {
    prisma.session.deleteMany.mockResolvedValue({ count: 5 });
    const count = await repo.deleteExpiredSessions();
    expect(count).toBe(5);
  });

  it('createRefreshToken persists token', async () => {
    prisma.refreshToken.create.mockResolvedValue(REFRESH_ROW);
    const result = await repo.createRefreshToken({
      token: 'tok-abc',
      sessionId: 's-1',
      userId: 'u-1',
      expiresAt: new Date(),
    });
    expect(result).toHaveProperty('token', 'tok-abc');
  });

  it('findRefreshToken looks up token', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(REFRESH_ROW);
    const result = await repo.findRefreshToken('tok-abc');
    expect(result).toHaveProperty('sessionId', 's-1');
  });

  it('revokeRefreshToken marks token revoked', async () => {
    prisma.refreshToken.update.mockResolvedValue({ ...REFRESH_ROW, isRevoked: true });
    await repo.revokeRefreshToken('tok-abc');
    expect(prisma.refreshToken.update).toHaveBeenCalled();
  });

  it('revokeRefreshTokensBySessionId revokes all for session', async () => {
    prisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });
    const count = await repo.revokeRefreshTokensBySessionId('s-1');
    expect(count).toBe(2);
  });

  it('revokeRefreshTokensByUserId revokes all for user', async () => {
    prisma.refreshToken.updateMany.mockResolvedValue({ count: 4 });
    const count = await repo.revokeRefreshTokensByUserId('u-1');
    expect(count).toBe(4);
  });

  it('deleteExpiredRefreshTokens cleans up', async () => {
    prisma.refreshToken.deleteMany.mockResolvedValue({ count: 10 });
    const count = await repo.deleteExpiredRefreshTokens();
    expect(count).toBe(10);
  });
});
