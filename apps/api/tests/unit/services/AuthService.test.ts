/**
 * @module AuthService.test
 *
 * Comprehensive unit tests for the AuthService class — the core authentication
 * service handling registration, login, token refresh, single-session revocation,
 * and all-sessions revocation with Redis-backed token blacklist.
 *
 * Tests validate:
 * - R33 (Session Revocation): Revoked access tokens blacklisted in Redis
 * - R32 (Immutable Audit Log): Audit entries written for security-sensitive actions
 * - R23 (Log Hygiene): No JWT tokens, passwords, or sensitive data in audit metadata
 * - R17 (Interface-Driven Dependencies): Constructor receives interfaces only
 * - R9  (Authentication): JWT generation and verification flows
 * - R22 (Standardized Error Responses): Typed domain errors thrown
 * - R7  (Zero Warnings Build): TypeScript strict mode, zero warnings
 *
 * Coverage target: ≥80%
 */

/* ────────────────────────────────────────────────────────────────────────────
 * External module mocks — MUST come before any imports that use them
 * ──────────────────────────────────────────────────────────────────────────── */

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('$2a$12$hashedpassword'),
  compare: jest.fn(),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('mock.jwt.token'),
  verify: jest.fn(),
  decode: jest.fn(),
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mock-uuid-v4'),
}));

/* ────────────────────────────────────────────────────────────────────────────
 * Imports
 * ──────────────────────────────────────────────────────────────────────────── */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

import { AuthService } from '../../../src/services/AuthService';
import type {
  IUserRepository,
  UserWithPassword,
} from '../../../src/domain/interfaces/IUserRepository';
import type { ICacheProvider } from '../../../src/domain/interfaces/ICacheProvider';
import type {
  ISessionRepository,
  SessionRecord,
  RefreshTokenRecord,
} from '../../../src/repositories/SessionRepository';
import type { AuditLogParams } from '../../../src/services/AuditService';
import { AuthenticationError } from '../../../src/errors/AuthenticationError';
import { ConflictError } from '../../../src/errors/ConflictError';
import { NotFoundError } from '../../../src/errors/NotFoundError';
import { AuditAction, type UserResponse, type RegisterDTO, type LoginDTO, type RefreshTokenDTO, type JWTPayload } from '@kalle/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Mock Factories
 * ──────────────────────────────────────────────────────────────────────────── */

function createMockUserRepository(): jest.Mocked<IUserRepository> {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    findByEmail: jest.fn(),
    update: jest.fn(),
    updatePassword: jest.fn(),
    search: jest.fn(),
    updateOnlineStatus: jest.fn(),
    blockUser: jest.fn(),
    unblockUser: jest.fn(),
    findBlockedUsers: jest.fn(),
    isBlocked: jest.fn(),
    existsByEmail: jest.fn(),
    findByIds: jest.fn(),
  };
}

function createMockSessionRepository(): jest.Mocked<ISessionRepository> {
  return {
    createSession: jest.fn(),
    findSessionByJti: jest.fn(),
    revokeSessionByJti: jest.fn(),
    revokeAllSessionsByUserId: jest.fn(),
    findActiveSessionsByUserId: jest.fn(),
    deleteExpiredSessions: jest.fn(),
    createRefreshToken: jest.fn(),
    findRefreshToken: jest.fn(),
    revokeRefreshToken: jest.fn(),
    revokeRefreshTokensBySessionId: jest.fn(),
    revokeRefreshTokensByUserId: jest.fn(),
    deleteExpiredRefreshTokens: jest.fn(),
  };
}

function createMockCacheProvider(): jest.Mocked<ICacheProvider> {
  return {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    setNx: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    ttl: jest.fn(),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Test Data Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

const now = new Date();
const futureDate = new Date(Date.now() + 3600 * 1000);

function testUserResponse(overrides?: Partial<UserResponse>): UserResponse {
  return {
    id: 'user-1',
    email: 'test@example.com',
    displayName: 'Test User',
    status: 'OFFLINE' as UserResponse['status'],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function testUserWithPassword(overrides?: Partial<UserWithPassword>): UserWithPassword {
  return {
    id: 'user-1',
    email: 'test@example.com',
    displayName: 'Test User',
    passwordHash: '$2a$12$storedhashedpassword',
    status: 'OFFLINE' as UserWithPassword['status'],
    lastSeen: undefined,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function testSessionRecord(overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    id: 'session-1',
    userId: 'user-1',
    jti: 'jti-1',
    deviceInfo: null,
    isRevoked: false,
    createdAt: now,
    expiresAt: futureDate,
    ...overrides,
  };
}

function testRefreshTokenRecord(overrides?: Partial<RefreshTokenRecord>): RefreshTokenRecord {
  return {
    id: 'refresh-1',
    userId: 'user-1',
    token: 'refresh-token-value',
    sessionId: 'session-1',
    isRevoked: false,
    createdAt: now,
    expiresAt: futureDate,
    ...overrides,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Test Suite
 * ──────────────────────────────────────────────────────────────────────────── */

describe('AuthService', () => {
  let service: AuthService;
  let mockUserRepository: jest.Mocked<IUserRepository>;
  let mockSessionRepository: jest.Mocked<ISessionRepository>;
  let mockCacheProvider: jest.Mocked<ICacheProvider>;
  let mockAuditService: { log: jest.Mock };
  let mockEnvConfig: {
    JWT_SECRET: string;
    JWT_ACCESS_TOKEN_EXPIRY: string;
    JWT_REFRESH_TOKEN_EXPIRY: string;
    BCRYPT_SALT_ROUNDS: number;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockUserRepository = createMockUserRepository();
    mockSessionRepository = createMockSessionRepository();
    mockCacheProvider = createMockCacheProvider();
    mockAuditService = { log: jest.fn().mockResolvedValue(undefined) };
    mockEnvConfig = {
      JWT_SECRET: 'test-jwt-secret-key-at-least-32-chars!!',
      JWT_ACCESS_TOKEN_EXPIRY: '15m',
      JWT_REFRESH_TOKEN_EXPIRY: '7d',
      BCRYPT_SALT_ROUNDS: 12,
    };

    service = new AuthService(
      mockUserRepository,
      mockSessionRepository,
      mockCacheProvider,
      mockAuditService as unknown as import('../../../src/services/AuditService').AuditService,
      mockEnvConfig as unknown as import('../../../src/config/env').EnvConfig,
    );

    // Default mock responses
    mockUserRepository.existsByEmail.mockResolvedValue(false);
    mockUserRepository.create.mockResolvedValue(testUserResponse());
    mockSessionRepository.createSession.mockResolvedValue(testSessionRecord());
    mockSessionRepository.createRefreshToken.mockResolvedValue(testRefreshTokenRecord());
    mockCacheProvider.set.mockResolvedValue(undefined);
    mockCacheProvider.exists.mockResolvedValue(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // describe: register
  // ─────────────────────────────────────────────────────────────────────────

  describe('register', () => {
    const registerDto: RegisterDTO = {
      email: 'new@example.com',
      password: 'SecurePass123!',
      displayName: 'New User',
    };

    it('should throw ConflictError when email already exists', async () => {
      mockUserRepository.existsByEmail.mockResolvedValue(true);

      await expect(service.register(registerDto)).rejects.toThrow(ConflictError);
      expect(mockUserRepository.existsByEmail).toHaveBeenCalledWith(registerDto.email);
      expect(mockUserRepository.create).not.toHaveBeenCalled();
    });

    it('should hash password with bcrypt', async () => {
      await service.register(registerDto);

      expect(bcrypt.hash).toHaveBeenCalledWith(registerDto.password, 12);
    });

    it('should create user with hashed password via repository', async () => {
      await service.register(registerDto);

      expect(mockUserRepository.create).toHaveBeenCalledTimes(1);
      const createArg = mockUserRepository.create.mock.calls[0]![0];
      expect(createArg.email).toBe(registerDto.email);
      expect(createArg.passwordHash).toBe('$2a$12$hashedpassword');
      expect(createArg.displayName).toBe(registerDto.displayName);
    });

    it('should generate JWT access token with UUID v4 JTI', async () => {
      await service.register(registerDto);

      expect(uuidv4).toHaveBeenCalled();
      expect(jwt.sign).toHaveBeenCalledTimes(1);
      const signCall = (jwt.sign as jest.Mock).mock.calls[0]!;
      const payload = signCall[0];
      expect(payload.jti).toBe('mock-uuid-v4');
      expect(payload.sub).toBe('user-1');
      expect(signCall[1]).toBe(mockEnvConfig.JWT_SECRET);
    });

    it('should create session record in database', async () => {
      await service.register(registerDto);

      expect(mockSessionRepository.createSession).toHaveBeenCalledTimes(1);
      const sessionArg = mockSessionRepository.createSession.mock.calls[0]![0];
      expect(sessionArg.userId).toBe('user-1');
      expect(sessionArg.jti).toBe('mock-uuid-v4');
      expect(sessionArg.expiresAt).toBeInstanceOf(Date);
    });

    it('should create refresh token record linked to session', async () => {
      await service.register(registerDto);

      expect(mockSessionRepository.createRefreshToken).toHaveBeenCalledTimes(1);
      const refreshArg = mockSessionRepository.createRefreshToken.mock.calls[0]![0];
      expect(refreshArg.userId).toBe('user-1');
      expect(refreshArg.sessionId).toBe('session-1');
      expect(refreshArg.token).toBe('mock-uuid-v4'); // uuid v4 returns this
    });

    it('should return AuthResponse with tokens and user data', async () => {
      const result = await service.register(registerDto);

      expect(result.user).toBeDefined();
      expect(result.user.id).toBe('user-1');
      expect(result.user.email).toBe('test@example.com');
      expect(result.tokens).toBeDefined();
      expect(result.tokens.accessToken).toBe('mock.jwt.token');
      expect(result.tokens.refreshToken).toBe('mock-uuid-v4');
      expect(typeof result.tokens.expiresIn).toBe('number');
      expect(typeof result.tokens.refreshExpiresIn).toBe('number');
    });

    it('should write audit log entry for USER_REGISTER (R32)', async () => {
      await service.register(registerDto);

      expect(mockAuditService.log).toHaveBeenCalledTimes(1);
      const auditArg = mockAuditService.log.mock.calls[0]![0] as AuditLogParams;
      expect(auditArg.action).toBe(AuditAction.USER_REGISTER);
      expect(auditArg.actorId).toBe('user-1');
    });

    it('should NOT include password or tokens in audit metadata (R23)', async () => {
      await service.register(registerDto);

      const auditArg = mockAuditService.log.mock.calls[0]![0] as AuditLogParams;
      const metadata = auditArg.metadata || {};
      expect(metadata).not.toHaveProperty('password');
      expect(metadata).not.toHaveProperty('passwordHash');
      expect(metadata).not.toHaveProperty('accessToken');
      expect(metadata).not.toHaveProperty('refreshToken');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // describe: login
  // ─────────────────────────────────────────────────────────────────────────

  describe('login', () => {
    const loginDto: LoginDTO = {
      email: 'test@example.com',
      password: 'SecurePass123!',
    };

    beforeEach(() => {
      mockUserRepository.findByEmail.mockResolvedValue(testUserWithPassword());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    });

    it('should find user by email', async () => {
      await service.login(loginDto);

      expect(mockUserRepository.findByEmail).toHaveBeenCalledWith(loginDto.email);
    });

    it('should throw AuthenticationError when user not found (generic message for R23)', async () => {
      mockUserRepository.findByEmail.mockResolvedValue(null);

      await expect(service.login(loginDto)).rejects.toThrow(AuthenticationError);
      await expect(service.login(loginDto)).rejects.toThrow('Invalid credentials');
    });

    it('should audit USER_LOGIN_FAILED when password is incorrect (R32)', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(service.login(loginDto)).rejects.toThrow(AuthenticationError);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.USER_LOGIN_FAILED,
          actorId: 'user-1',
        }),
      );
    });

    it('should throw identical error message for wrong email AND wrong password (prevents enumeration)', async () => {
      // Wrong email
      mockUserRepository.findByEmail.mockResolvedValue(null);
      let emailError: Error | null = null;
      try {
        await service.login(loginDto);
      } catch (e) {
        emailError = e as Error;
      }

      // Wrong password
      mockUserRepository.findByEmail.mockResolvedValue(testUserWithPassword());
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      let passwordError: Error | null = null;
      try {
        await service.login(loginDto);
      } catch (e) {
        passwordError = e as Error;
      }

      expect(emailError!.message).toBe(passwordError!.message);
      expect(emailError!.message).toBe('Invalid credentials');
    });

    it('should generate tokens and create session on successful login', async () => {
      await service.login(loginDto);

      expect(jwt.sign).toHaveBeenCalledTimes(1);
      expect(mockSessionRepository.createSession).toHaveBeenCalledTimes(1);
      expect(mockSessionRepository.createRefreshToken).toHaveBeenCalledTimes(1);
    });

    it('should write audit log entry for USER_LOGIN on success (R32)', async () => {
      await service.login(loginDto);

      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.USER_LOGIN,
          actorId: 'user-1',
        }),
      );
    });

    it('should NOT include password or tokens in audit metadata (R23)', async () => {
      await service.login(loginDto);

      for (const call of mockAuditService.log.mock.calls) {
        const auditArg = call[0] as AuditLogParams;
        const metadata = auditArg.metadata || {};
        expect(metadata).not.toHaveProperty('password');
        expect(metadata).not.toHaveProperty('passwordHash');
        expect(metadata).not.toHaveProperty('accessToken');
        expect(metadata).not.toHaveProperty('refreshToken');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // describe: refreshToken
  // ─────────────────────────────────────────────────────────────────────────

  describe('refreshToken', () => {
    const refreshDto: RefreshTokenDTO = { refreshToken: 'valid-refresh-token' };

    beforeEach(() => {
      mockSessionRepository.findRefreshToken.mockResolvedValue(testRefreshTokenRecord({
        token: 'valid-refresh-token',
      }));
      mockSessionRepository.findActiveSessionsByUserId.mockResolvedValue([
        testSessionRecord(),
      ]);
      mockUserRepository.findById.mockResolvedValue(testUserResponse());
      mockSessionRepository.revokeRefreshToken.mockResolvedValue(undefined);
      mockSessionRepository.revokeSessionByJti.mockResolvedValue(undefined);
      mockSessionRepository.revokeRefreshTokensBySessionId.mockResolvedValue(1);
    });

    it('should find refresh token in database', async () => {
      await service.refreshToken(refreshDto);

      expect(mockSessionRepository.findRefreshToken).toHaveBeenCalledWith(refreshDto.refreshToken);
    });

    it('should throw AuthenticationError if refresh token not found', async () => {
      mockSessionRepository.findRefreshToken.mockResolvedValue(null);

      await expect(service.refreshToken(refreshDto)).rejects.toThrow(AuthenticationError);
    });

    it('should throw AuthenticationError if refresh token is revoked', async () => {
      mockSessionRepository.findRefreshToken.mockResolvedValue(
        testRefreshTokenRecord({ token: 'valid-refresh-token', isRevoked: true }),
      );

      await expect(service.refreshToken(refreshDto)).rejects.toThrow(AuthenticationError);
    });

    it('should throw AuthenticationError if refresh token is expired', async () => {
      mockSessionRepository.findRefreshToken.mockResolvedValue(
        testRefreshTokenRecord({
          token: 'valid-refresh-token',
          expiresAt: new Date(Date.now() - 1000),
        }),
      );

      await expect(service.refreshToken(refreshDto)).rejects.toThrow(AuthenticationError);
    });

    it('should revoke old refresh token and create new token pair (rotation)', async () => {
      const result = await service.refreshToken(refreshDto);

      // Old refresh token revoked
      expect(mockSessionRepository.revokeRefreshToken).toHaveBeenCalledWith(refreshDto.refreshToken);

      // New session created
      expect(mockSessionRepository.createSession).toHaveBeenCalledTimes(1);

      // New refresh token created
      expect(mockSessionRepository.createRefreshToken).toHaveBeenCalledTimes(1);

      // Valid token pair returned
      expect(result.accessToken).toBe('mock.jwt.token');
      expect(result.refreshToken).toBe('mock-uuid-v4');
      expect(typeof result.expiresIn).toBe('number');
      expect(typeof result.refreshExpiresIn).toBe('number');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // describe: revokeSession (R33)
  // ─────────────────────────────────────────────────────────────────────────

  describe('revokeSession', () => {
    const accessToken = 'valid.access.token';
    const userId = 'user-1';

    beforeEach(() => {
      (jwt.verify as jest.Mock).mockReturnValue({
        sub: 'user-1',
        email: 'test@example.com',
        jti: 'jti-1',
        exp: Math.floor(Date.now() / 1000) + 900,
        iat: Math.floor(Date.now() / 1000),
      } as JWTPayload);
      mockSessionRepository.findSessionByJti.mockResolvedValue(testSessionRecord());
      mockSessionRepository.revokeSessionByJti.mockResolvedValue(undefined);
      mockSessionRepository.revokeRefreshTokensBySessionId.mockResolvedValue(1);
    });

    it('should extract JTI from access token', async () => {
      await service.revokeSession(accessToken, userId);

      expect(jwt.verify).toHaveBeenCalledWith(accessToken, mockEnvConfig.JWT_SECRET);
    });

    it('should throw NotFoundError if session not found by JTI', async () => {
      mockSessionRepository.findSessionByJti.mockResolvedValue(null);

      await expect(service.revokeSession(accessToken, userId)).rejects.toThrow(NotFoundError);
    });

    it('should throw AuthenticationError if session belongs to different user', async () => {
      mockSessionRepository.findSessionByJti.mockResolvedValue(
        testSessionRecord({ userId: 'other-user' }),
      );

      await expect(service.revokeSession(accessToken, userId)).rejects.toThrow(AuthenticationError);
    });

    it('should blacklist JTI in Redis with remaining TTL (R33)', async () => {
      await service.revokeSession(accessToken, userId);

      expect(mockCacheProvider.set).toHaveBeenCalledWith(
        'blacklist:jti-1',
        'revoked',
        expect.any(Number),
      );
    });

    it('should skip blacklist write if already blacklisted (idempotent)', async () => {
      mockCacheProvider.exists.mockResolvedValue(true);

      await service.revokeSession(accessToken, userId);

      // set should NOT be called since exists returned true
      expect(mockCacheProvider.set).not.toHaveBeenCalled();
    });

    it('should revoke session and refresh tokens in database', async () => {
      await service.revokeSession(accessToken, userId);

      expect(mockSessionRepository.revokeSessionByJti).toHaveBeenCalledWith('jti-1');
      expect(mockSessionRepository.revokeRefreshTokensBySessionId).toHaveBeenCalledWith('session-1');
    });

    it('should write audit log entry for SESSION_REVOKE (R32)', async () => {
      await service.revokeSession(accessToken, userId);

      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.SESSION_REVOKE,
          actorId: userId,
        }),
      );
    });

    it('should NOT include tokens in audit metadata (R23)', async () => {
      await service.revokeSession(accessToken, userId);

      const auditArg = mockAuditService.log.mock.calls[0]![0] as AuditLogParams;
      const metadata = auditArg.metadata || {};
      expect(metadata).not.toHaveProperty('accessToken');
      expect(metadata).not.toHaveProperty('refreshToken');
      expect(metadata).not.toHaveProperty('jti');
    });

    it('should handle expired tokens via jwt.decode fallback', async () => {
      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error('jwt expired');
      });
      (jwt.decode as jest.Mock).mockReturnValue({
        sub: 'user-1',
        email: 'test@example.com',
        jti: 'jti-1',
        exp: Math.floor(Date.now() / 1000) - 100,
        iat: Math.floor(Date.now() / 1000) - 1000,
      });

      await service.revokeSession(accessToken, userId);

      expect(jwt.decode).toHaveBeenCalledWith(accessToken);
      expect(mockSessionRepository.findSessionByJti).toHaveBeenCalledWith('jti-1');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // describe: revokeAllSessions (R33)
  // ─────────────────────────────────────────────────────────────────────────

  describe('revokeAllSessions', () => {
    const userId = 'user-1';

    beforeEach(() => {
      mockSessionRepository.findActiveSessionsByUserId.mockResolvedValue([
        testSessionRecord({ id: 'session-1', jti: 'jti-1' }),
        testSessionRecord({ id: 'session-2', jti: 'jti-2' }),
        testSessionRecord({ id: 'session-3', jti: 'jti-3' }),
      ]);
      mockSessionRepository.revokeAllSessionsByUserId.mockResolvedValue(3);
      mockSessionRepository.revokeRefreshTokensByUserId.mockResolvedValue(3);
    });

    it('should blacklist ALL active session JTIs in Redis (R33)', async () => {
      await service.revokeAllSessions(userId);

      expect(mockCacheProvider.set).toHaveBeenCalledTimes(3);
      expect(mockCacheProvider.set).toHaveBeenCalledWith(
        'blacklist:jti-1',
        'revoked',
        expect.any(Number),
      );
      expect(mockCacheProvider.set).toHaveBeenCalledWith(
        'blacklist:jti-2',
        'revoked',
        expect.any(Number),
      );
      expect(mockCacheProvider.set).toHaveBeenCalledWith(
        'blacklist:jti-3',
        'revoked',
        expect.any(Number),
      );
    });

    it('should revoke all sessions in database', async () => {
      await service.revokeAllSessions(userId);

      expect(mockSessionRepository.revokeAllSessionsByUserId).toHaveBeenCalledWith(userId);
    });

    it('should revoke all refresh tokens for user', async () => {
      await service.revokeAllSessions(userId);

      expect(mockSessionRepository.revokeRefreshTokensByUserId).toHaveBeenCalledWith(userId);
    });

    it('should write audit log entry for SESSION_REVOKE_ALL (R32)', async () => {
      await service.revokeAllSessions(userId);

      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.SESSION_REVOKE_ALL,
          actorId: userId,
        }),
      );
    });

    it('should include revokedCount in audit metadata', async () => {
      const result = await service.revokeAllSessions(userId);

      expect(result).toBe(3);
      const auditArg = mockAuditService.log.mock.calls[0]![0] as AuditLogParams;
      expect(auditArg.metadata).toEqual(expect.objectContaining({ revokedCount: 3 }));
    });

    it('should handle zero active sessions gracefully', async () => {
      mockSessionRepository.findActiveSessionsByUserId.mockResolvedValue([]);
      mockSessionRepository.revokeAllSessionsByUserId.mockResolvedValue(0);

      const result = await service.revokeAllSessions(userId);

      expect(result).toBe(0);
      expect(mockCacheProvider.set).not.toHaveBeenCalled();
      expect(mockAuditService.log).toHaveBeenCalledTimes(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // describe: Architecture Rules
  // ─────────────────────────────────────────────────────────────────────────

  describe('Architecture Rules', () => {
    it('should use identical "Invalid credentials" message for both email and password errors (R23 enumeration prevention)', async () => {
      // Email not found
      mockUserRepository.findByEmail.mockResolvedValue(null);
      const emailErrorPromise = service.login({ email: 'wrong@example.com', password: 'pass' });
      await expect(emailErrorPromise).rejects.toThrow('Invalid credentials');

      // Password mismatch
      mockUserRepository.findByEmail.mockResolvedValue(testUserWithPassword());
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      const passwordErrorPromise = service.login({ email: 'test@example.com', password: 'wrong' });
      await expect(passwordErrorPromise).rejects.toThrow('Invalid credentials');
    });

    it('should use 12 bcrypt salt rounds', async () => {
      await service.register({
        email: 'new@example.com',
        password: 'SecurePass123!',
        displayName: 'New User',
      });

      expect(bcrypt.hash).toHaveBeenCalledWith('SecurePass123!', 12);
    });

    it('should use JWT_SECRET from env config for token signing', async () => {
      await service.register({
        email: 'new@example.com',
        password: 'SecurePass123!',
        displayName: 'New User',
      });

      expect(jwt.sign).toHaveBeenCalledWith(
        expect.any(Object),
        mockEnvConfig.JWT_SECRET,
        expect.any(Object),
      );
    });
  });
});
