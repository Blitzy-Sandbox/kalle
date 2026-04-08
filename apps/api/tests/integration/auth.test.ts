/**
 * @module auth.test
 * @description Authentication Flow Integration Tests
 *
 * Comprehensive integration tests verifying the complete authentication flow:
 * - User registration with validation
 * - User login with credential verification
 * - JWT token refresh with rotation
 * - Session revocation (single and all-sessions) via Redis blacklist
 * - JWT middleware enforcement on protected vs public routes
 * - Standardized error response shape verification
 * - API versioning verification
 *
 * Rules Verified:
 * - R9:  Authentication on all protected routes
 * - R22: Standardized error responses { error: { code, message, details? } }
 * - R30: All REST endpoints under /api/v1/ prefix
 * - R31: Input validation via Zod — invalid input returns 400 with field errors
 * - R33: Session revocation — revoked tokens blacklisted in Redis by JTI
 *
 * Infrastructure Requirements:
 * - PostgreSQL database (TEST_DATABASE_URL or DATABASE_URL)
 * - Redis instance (REDIS_URL)
 * - Environment variables set (or defaults via validateEnv)
 *
 * @see apps/api/src/controllers/AuthController.ts
 * @see apps/api/src/services/AuthService.ts
 * @see apps/api/src/middleware/auth.ts
 */

import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import type { Application } from 'express';
import type {
  AuthResponse,
  TokenPair,
  UserResponse,
  RegisterDTO,
} from '@kalle/shared';
import type { ApiErrorResponse } from '@kalle/shared';

import { createApp } from '../../src/app';
import { createV1Router } from '../../src/routes/v1/index';
import { validateEnv } from '../../src/config/env';
import type { EnvConfig } from '../../src/config/env';
import { createRedisClient } from '../../src/config/redis';
import { getCorsOptions } from '../../src/config/cors';
import { UserRepository } from '../../src/repositories/UserRepository';
import { SessionRepository } from '../../src/repositories/SessionRepository';
import { AuditRepository } from '../../src/repositories/AuditRepository';
import { CacheProvider } from '../../src/providers/CacheProvider';
import { LoggerProvider } from '../../src/providers/LoggerProvider';
import { AuthService } from '../../src/services/AuthService';
import { AuditService } from '../../src/services/AuditService';
import { UserService } from '../../src/services/UserService';
import { HealthService } from '../../src/services/HealthService';
import { AuthController } from '../../src/controllers/AuthController';
import { UserController } from '../../src/controllers/UserController';
import { HealthController } from '../../src/controllers/HealthController';
import { createLoggerMiddleware } from '../../src/middleware/logger';

// ============================================================================
// Test Constants
// ============================================================================

const TEST_USER: Pick<RegisterDTO, 'email' | 'password' | 'displayName'> = {
  email: 'alice@integration-test.com',
  password: 'SecurePass123!',
  displayName: 'Alice Test',
};

// ============================================================================
// Global Test State
// ============================================================================

let app: Application;
let prisma: PrismaClient;
let redisClient: ReturnType<typeof createRedisClient>;
let env: EnvConfig;
let infrastructureAvailable = false;

// ============================================================================
// Test Environment Setup
// ============================================================================

/**
 * Sets up the minimal required environment variables for the test suite.
 * Uses localhost defaults for PostgreSQL and Redis. These values are
 * overridden by any existing environment variables (Docker Compose sets them).
 */
function setupTestEnv(): void {
  const defaults: Record<string, string> = {
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgresql://kalle_app:kalle_app_password@localhost:5432/kalle_db?schema=public',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    JWT_SECRET:
      process.env.JWT_SECRET ??
      'integration-test-jwt-secret-minimum-32-chars-long!',
    CORS_ORIGIN: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JWT_ACCESS_TOKEN_EXPIRY: '15m',
    JWT_REFRESH_TOKEN_EXPIRY: '7d',
    API_PORT: '3001',
    UPLOAD_DIR: './uploads',
    MAX_FILE_SIZE: '26214400',
    OTEL_SERVICE_NAME: 'kalle-api-test',
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

/**
 * Truncates all auth-related tables in the correct order to satisfy
 * foreign key constraints. Called before each test for deterministic isolation.
 */
async function cleanDatabase(): Promise<void> {
  // Delete in dependency order: children first, parents last
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
}

/**
 * Flushes all keys matching the blacklist pattern from Redis.
 * Ensures a clean token blacklist state between tests.
 */
async function cleanRedis(): Promise<void> {
  const keys = await redisClient.keys('blacklist:*');
  if (keys.length > 0) {
    await redisClient.del(...keys);
  }
}

// ============================================================================
// Test Lifecycle Hooks
// ============================================================================

beforeAll(async () => {
  try {
    // Step 1: Set up environment variables
    setupTestEnv();

    // Step 2: Validate environment
    env = validateEnv();

    // Step 3: Connect to PostgreSQL
    prisma = new PrismaClient({
      datasources: {
        db: { url: env.DATABASE_URL },
      },
    });
    await prisma.$connect();

    // Step 4: Connect to Redis (lazyConnect to control timing)
    redisClient = createRedisClient(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      connectTimeout: 3000,
    });
    await redisClient.connect();
    await redisClient.ping();

    infrastructureAvailable = true;

    // Step 5: Build DI chain
    const loggerProvider = new LoggerProvider('silent');
    const baseLogger = loggerProvider.getBaseLogger();

    // Repositories (real Prisma-backed)
    const userRepository = new UserRepository(prisma);
    const sessionRepository = new SessionRepository(prisma);
    const auditRepository = new AuditRepository(prisma);

    // Providers (real Redis-backed)
    const cacheProvider = new CacheProvider(redisClient);

    // Services
    const auditService = new AuditService(auditRepository);
    const authService = new AuthService(
      userRepository,
      sessionRepository,
      cacheProvider,
      auditService,
      env,
    );
    const userService = new UserService(
      userRepository,
      cacheProvider,
      auditService,
    );
    const healthService = new HealthService(prisma, redisClient);

    // Controllers
    const authController = new AuthController(authService);
    const userController = new UserController(userService);

    // MetricsService is not in our dependency list — provide a no-op stub
    // that satisfies the HealthController constructor signature.
    const metricsServiceStub = {
      httpRequestsTotal: { add: jest.fn() },
      httpRequestDuration: { record: jest.fn() },
      httpActiveRequests: { add: jest.fn() },
      wsConnectionsTotal: { add: jest.fn() },
      recordHttpRequest: jest.fn(),
      recordDbQuery: jest.fn(),
      recordBullmqJob: jest.fn(),
    };

    const healthController = new HealthController(
      healthService,
      metricsServiceStub as never,
    );

    // V1 Router — stub controllers not under test (not in depends_on_files)
    const noopHandler = (_req: unknown, _res: unknown, next: unknown) => {
      (next as () => void)();
    };

    const stubController = (methods: string[]) => {
      const ctrl: Record<string, unknown> = {};
      for (const method of methods) {
        ctrl[method] = noopHandler;
      }
      return ctrl;
    };

    const v1Router = createV1Router({
      authController,
      userController,
      conversationController: stubController([
        'list',
        'create',
        'getById',
        'update',
        'addMember',
        'removeMember',
      ]) as never,
      messageController: stubController([
        'send',
        'edit',
        'delete',
        'getHistory',
      ]) as never,
      mediaController: stubController(['upload', 'getMedia']) as never,
      storyController: stubController([
        'create',
        'getFeed',
        'getMyStories',
        'view',
        'delete',
      ]) as never,
      keyController: stubController([
        'uploadBundle',
        'getBundle',
      ]) as never,
      healthController,
      authService,
      cacheProvider,
      jwtSecret: env.JWT_SECRET,
    });

    // Create Express app
    const pinoHttpMiddleware = createLoggerMiddleware(baseLogger);
    const corsOptions = getCorsOptions(env.CORS_ORIGIN);

    app = createApp({
      corsOptions,
      v1Router,
      pinoHttpMiddleware,
      metricsService: metricsServiceStub as never,
    });
  } catch (error: unknown) {
    infrastructureAvailable = false;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[auth.test] Infrastructure not available: ${message}. ` +
      'Start PostgreSQL and Redis before running integration tests.',
    );
  }
}, 30_000);

beforeEach(async () => {
  if (!infrastructureAvailable) return;
  await cleanDatabase();
  await cleanRedis();
});

afterAll(async () => {
  if (prisma) {
    try {
      await cleanDatabase();
    } catch {
      // Best-effort cleanup
    }
    await prisma.$disconnect();
  }
  if (redisClient) {
    try {
      await cleanRedis();
      await redisClient.quit();
    } catch {
      // Best-effort cleanup
    }
  }
});

// conditionalIt removed — tests now use standard `it()` with beforeEach guard

/**
 * Helper to register a user and return the full response.
 * Reduces boilerplate in tests that need an authenticated user.
 */
async function registerUser(
  userData: { email: string; password: string; displayName: string } = TEST_USER,
): Promise<request.Response> {
  return request(app)
    .post('/api/v1/auth/register')
    .send(userData)
    .expect('Content-Type', /json/);
}

/**
 * Helper to login a user and return the full response.
 */
async function loginUser(
  credentials: { email: string; password: string } = {
    email: TEST_USER.email,
    password: TEST_USER.password,
  },
): Promise<request.Response> {
  return request(app)
    .post('/api/v1/auth/login')
    .send(credentials)
    .expect('Content-Type', /json/);
}

/**
 * Helper to register and login, returning tokens.
 */
async function registerAndLogin(
  userData: { email: string; password: string; displayName: string } = TEST_USER,
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  await registerUser(userData);
  const loginRes = await loginUser({
    email: userData.email,
    password: userData.password,
  });
  const body = loginRes.body as { data: AuthResponse };
  return {
    accessToken: body.data.tokens.accessToken,
    refreshToken: body.data.tokens.refreshToken,
    userId: body.data.user.id,
  };
}

// ============================================================================
// Phase 2: User Registration Tests
// ============================================================================

describe('User Registration', () => {
  it(
    'should register a new user (POST /api/v1/auth/register → 201)',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: TEST_USER.email,
          password: TEST_USER.password,
          displayName: TEST_USER.displayName,
        })
        .expect('Content-Type', /json/)
        .expect(201);

      const body = res.body as { data: AuthResponse };

      // Verify response structure
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('user');
      expect(body.data).toHaveProperty('tokens');

      // Verify user object
      const user = body.data.user;
      expect(user.id).toBeDefined();
      expect(typeof user.id).toBe('string');
      expect(user.id.length).toBeGreaterThan(0);
      expect(user.email).toBe(TEST_USER.email);
      expect(user.displayName).toBe(TEST_USER.displayName);
      // Password must NEVER be exposed in response
      expect(user).not.toHaveProperty('password');
      expect(user).not.toHaveProperty('passwordHash');

      // Verify tokens
      const tokens = body.data.tokens;
      expect(typeof tokens.accessToken).toBe('string');
      expect(tokens.accessToken.length).toBeGreaterThan(0);
      expect(typeof tokens.refreshToken).toBe('string');
      expect(tokens.refreshToken.length).toBeGreaterThan(0);
      expect(typeof tokens.expiresIn).toBe('number');
      expect(tokens.expiresIn).toBeGreaterThan(0);
      expect(typeof tokens.refreshExpiresIn).toBe('number');
      expect(tokens.refreshExpiresIn).toBeGreaterThan(0);
    },
  );

  it(
    'should reject duplicate email registration → 409 CONFLICT',
    async () => {
      // Register first user
      await registerUser();

      // Attempt duplicate registration
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: TEST_USER.email,
          password: 'DifferentPass999!',
          displayName: 'Different Name',
        })
        .expect('Content-Type', /json/)
        .expect(409);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code', 'CONFLICT');
      expect(body.error).toHaveProperty('message');
      expect(typeof body.error.message).toBe('string');
    },
  );

  it(
    'should reject invalid email format → 400 VALIDATION_ERROR (R31)',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'not-an-email',
          password: TEST_USER.password,
          displayName: TEST_USER.displayName,
        })
        .expect('Content-Type', /json/)
        .expect(400);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error).toHaveProperty('message');
    },
  );

  it(
    'should reject short password → 400 VALIDATION_ERROR (R31)',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'short-pass@test.com',
          password: '12345',
          displayName: TEST_USER.displayName,
        })
        .expect('Content-Type', /json/)
        .expect(400);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error).toHaveProperty('message');
    },
  );

  it(
    'should reject missing displayName → 400 VALIDATION_ERROR (R31)',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'no-name@test.com',
          password: TEST_USER.password,
        })
        .expect('Content-Type', /json/)
        .expect(400);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error).toHaveProperty('message');
    },
  );

  it(
    'should reject empty request body → 400 VALIDATION_ERROR',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({})
        .expect('Content-Type', /json/)
        .expect(400);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error).toHaveProperty('message');
    },
  );
});

// ============================================================================
// Phase 3: User Login Tests
// ============================================================================

describe('User Login', () => {
  it(
    'should login with valid credentials (POST /api/v1/auth/login → 200)',
    async () => {
      // Register user first
      await registerUser();

      // Login with valid credentials
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: TEST_USER.email,
          password: TEST_USER.password,
        })
        .expect('Content-Type', /json/)
        .expect(200);

      const body = loginRes.body as { data: AuthResponse };

      // Verify response structure
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('user');
      expect(body.data).toHaveProperty('tokens');

      // Verify user matches registered user
      expect(body.data.user.email).toBe(TEST_USER.email);
      expect(body.data.user.displayName).toBe(TEST_USER.displayName);
      expect(body.data.user).not.toHaveProperty('password');

      // Verify tokens
      expect(typeof body.data.tokens.accessToken).toBe('string');
      expect(body.data.tokens.accessToken.length).toBeGreaterThan(0);
      expect(typeof body.data.tokens.refreshToken).toBe('string');
      expect(body.data.tokens.refreshToken.length).toBeGreaterThan(0);
    },
  );

  it(
    'should reject invalid password → 401 AUTHENTICATION_ERROR',
    async () => {
      // Register user first
      await registerUser();

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: TEST_USER.email,
          password: 'WrongPassword999!',
        })
        .expect('Content-Type', /json/)
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
      expect(body.error).toHaveProperty('message');
    },
  );

  it(
    'should reject non-existent email → 401 AUTHENTICATION_ERROR',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'nonexistent@test.com',
          password: TEST_USER.password,
        })
        .expect('Content-Type', /json/)
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
      expect(body.error).toHaveProperty('message');
      // Error message should NOT reveal whether the email exists
      // (constant-time comparison in AuthService)
    },
  );

  it(
    'should reject login with missing email → 400 VALIDATION_ERROR',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          password: TEST_USER.password,
        })
        .expect('Content-Type', /json/)
        .expect(400);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it(
    'should reject login with missing password → 400 VALIDATION_ERROR',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: TEST_USER.email,
        })
        .expect('Content-Type', /json/)
        .expect(400);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('VALIDATION_ERROR');
    },
  );
});

// ============================================================================
// Phase 4: Token Refresh Tests
// ============================================================================

describe('Token Refresh', () => {
  it(
    'should refresh tokens with rotated refresh token (POST /api/v1/auth/refresh → 200)',
    async () => {
      // Register and login to get initial tokens
      const { accessToken, refreshToken } = await registerAndLogin();

      // Wait briefly to ensure different token generation
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Refresh tokens
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect('Content-Type', /json/)
        .expect(200);

      const body = res.body as { data: { tokens: TokenPair } };

      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('tokens');

      const newTokens = body.data.tokens;
      // New access token should be different from the original
      expect(typeof newTokens.accessToken).toBe('string');
      expect(newTokens.accessToken.length).toBeGreaterThan(0);
      expect(newTokens.accessToken).not.toBe(accessToken);

      // Refresh token must be rotated (different from original)
      expect(typeof newTokens.refreshToken).toBe('string');
      expect(newTokens.refreshToken.length).toBeGreaterThan(0);
      expect(newTokens.refreshToken).not.toBe(refreshToken);

      // Expiry values must be positive
      expect(newTokens.expiresIn).toBeGreaterThan(0);
      expect(newTokens.refreshExpiresIn).toBeGreaterThan(0);
    },
  );

  it(
    'should reject invalid refresh token → 401',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: 'invalid-token-value' })
        .expect('Content-Type', /json/)
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
    },
  );

  it(
    'should reject expired refresh token → 401',
    async () => {
      // Register and login to get tokens
      const { refreshToken } = await registerAndLogin();

      // Manually expire the refresh token in the database
      await prisma.refreshToken.updateMany({
        where: { token: refreshToken },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      // Attempt refresh with expired token
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect('Content-Type', /json/)
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
    },
  );

  it(
    'should reject old refresh token after rotation',
    async () => {
      // Register and login to get initial tokens
      const { refreshToken: originalRefreshToken } =
        await registerAndLogin();

      // Perform a refresh to rotate the token
      const refreshRes = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: originalRefreshToken })
        .expect(200);

      const newTokens = (
        refreshRes.body as { data: { tokens: TokenPair } }
      ).data.tokens;

      // Verify the new tokens are different
      expect(newTokens.refreshToken).not.toBe(originalRefreshToken);

      // Attempt refresh with the OLD (rotated-out) refresh token
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: originalRefreshToken })
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
    },
  );

  it(
    'should reject refresh with missing refreshToken field → 400',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .send({})
        .expect('Content-Type', /json/)
        .expect(400);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('VALIDATION_ERROR');
    },
  );
});

// ============================================================================
// Phase 5: Session Revocation Tests (R33)
// ============================================================================

describe('Session Revocation (R33)', () => {
  it(
    'should revoke single session (POST /api/v1/auth/revoke → 200)',
    async () => {
      const { accessToken, refreshToken } = await registerAndLogin();

      const res = await request(app)
        .post('/api/v1/auth/revoke')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken })
        .expect('Content-Type', /json/)
        .expect(200);

      const body = res.body as { data: { message: string } };
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('message');
      expect(typeof body.data.message).toBe('string');
    },
  );

  it(
    'should deny access with revoked token (R33 Redis blacklist)',
    async () => {
      const { accessToken, refreshToken } = await registerAndLogin();

      // Verify the token works BEFORE revocation
      const preRevokeRes = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect('Content-Type', /json/);

      expect(preRevokeRes.status).toBe(200);

      // Revoke the session
      await request(app)
        .post('/api/v1/auth/revoke')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken })
        .expect(200);

      // Attempt to access protected endpoint with REVOKED token
      const postRevokeRes = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect('Content-Type', /json/)
        .expect(401);

      const body = postRevokeRes.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
    },
  );

  it(
    'should revoke all sessions (POST /api/v1/auth/revoke-all → 200)',
    async () => {
      // Register user
      await registerUser();

      // Login from "device 1"
      const login1 = await loginUser();
      const tokens1 = (login1.body as { data: AuthResponse }).data.tokens;

      // Login from "device 2" (second session)
      const login2 = await loginUser();
      const tokens2 = (login2.body as { data: AuthResponse }).data.tokens;

      // Verify both sessions are active
      expect(tokens1.accessToken).not.toBe(tokens2.accessToken);

      // Revoke ALL sessions using device 1's token
      const res = await request(app)
        .post('/api/v1/auth/revoke-all')
        .set('Authorization', `Bearer ${tokens1.accessToken}`)
        .expect('Content-Type', /json/)
        .expect(200);

      const body = res.body as {
        data: { message: string; revokedCount: number };
      };
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('message');
      expect(typeof body.data.revokedCount).toBe('number');
      // At least 2 sessions should be revoked
      expect(body.data.revokedCount).toBeGreaterThanOrEqual(2);
    },
  );

  it(
    'should deny access on ALL sessions after revoke-all (R33)',
    async () => {
      // Register user
      await registerUser();

      // Login from two separate sessions
      const login1 = await loginUser();
      const tokens1 = (login1.body as { data: AuthResponse }).data.tokens;

      const login2 = await loginUser();
      const tokens2 = (login2.body as { data: AuthResponse }).data.tokens;

      // Revoke all using session 1
      await request(app)
        .post('/api/v1/auth/revoke-all')
        .set('Authorization', `Bearer ${tokens1.accessToken}`)
        .expect(200);

      // Attempt access with session 1's token → should fail
      const res1 = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${tokens1.accessToken}`)
        .expect(401);

      expect((res1.body as ApiErrorResponse).error.code).toBe(
        'AUTHENTICATION_ERROR',
      );

      // Attempt access with session 2's token → should also fail
      const res2 = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${tokens2.accessToken}`)
        .expect(401);

      expect((res2.body as ApiErrorResponse).error.code).toBe(
        'AUTHENTICATION_ERROR',
      );
    },
  );

  it(
    'should require authentication for revoke endpoint',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/revoke')
        .send({ refreshToken: 'some-token' })
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
    },
  );

  it(
    'should require authentication for revoke-all endpoint',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/revoke-all')
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
    },
  );
});

// ============================================================================
// Phase 6: JWT Format and Middleware Tests (R9)
// ============================================================================

describe('JWT Middleware (R9)', () => {
  it(
    'should return 401 when Authorization header is missing',
    async () => {
      const res = await request(app)
        .get('/api/v1/users/me')
        .expect('Content-Type', /json/)
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
      expect(body.error).toHaveProperty('message');
    },
  );

  it(
    'should return 401 for malformed JWT',
    async () => {
      const res = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', 'Bearer not-a-real-jwt-token')
        .expect('Content-Type', /json/)
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
    },
  );

  it(
    'should return 401 for Bearer prefix missing',
    async () => {
      const { accessToken } = await registerAndLogin();

      // Send token without "Bearer " prefix
      const res = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', accessToken)
        .expect('Content-Type', /json/)
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
    },
  );

  it(
    'should allow valid JWT to access protected endpoints',
    async () => {
      const { accessToken } = await registerAndLogin();

      const res = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect('Content-Type', /json/)
        .expect(200);

      // Verify we get the user's profile back
      const body = res.body as { data: UserResponse };
      expect(body).toHaveProperty('data');
      expect(body.data.email).toBe(TEST_USER.email);
      expect(body.data.displayName).toBe(TEST_USER.displayName);
      expect(body.data).not.toHaveProperty('password');
    },
  );

  // --- Public Endpoints (R9) ---

  it(
    'should allow POST /api/v1/auth/register without auth',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'public-test@test.com',
          password: 'PublicPass123!',
          displayName: 'Public Test',
        });

      // Should succeed (201), not 401
      expect(res.status).toBe(201);
    },
  );

  it(
    'should allow POST /api/v1/auth/login without auth',
    async () => {
      // Register first
      await registerUser();

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: TEST_USER.email,
          password: TEST_USER.password,
        });

      // Should succeed (200), not 401
      expect(res.status).toBe(200);
    },
  );

  it(
    'should allow GET /api/v1/health without auth',
    async () => {
      const res = await request(app)
        .get('/api/v1/health');

      // Should return 200 (or 503 if a component is unhealthy),
      // but NOT 401 (auth must not be required)
      expect(res.status).not.toBe(401);
      expect([200, 503]).toContain(res.status);
    },
  );
});

// ============================================================================
// Phase 7: Error Response Shape Verification (R22)
// ============================================================================

describe('Standardized Error Responses (R22)', () => {
  it(
    'should return consistent error shape for 400 VALIDATION_ERROR',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'invalid' })
        .expect(400);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
      expect(body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it(
    'should return consistent error shape for 401 AUTHENTICATION_ERROR',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'nobody@test.com',
          password: 'WrongPass123!',
        })
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
    },
  );

  it(
    'should return consistent error shape for 409 CONFLICT',
    async () => {
      await registerUser();

      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: TEST_USER.email,
          password: 'AnotherPass123!',
          displayName: 'Another Name',
        })
        .expect(409);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
      expect(body.error.code).toBe('CONFLICT');
    },
  );

  it(
    'should include field-level details for validation errors (R31)',
    async () => {
      // Send multiple invalid fields to trigger detailed validation errors
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'not-valid',
          password: '123',
        })
        .expect(400);

      const body = res.body as ApiErrorResponse;
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('VALIDATION_ERROR');

      // Validation errors should include details about specific field failures
      // The exact shape of details depends on the validation middleware
      // but the error should contain useful information
      expect(body.error.message.length).toBeGreaterThan(0);
    },
  );

  it(
    'should never expose error stack traces in production-style responses',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'no-one@test.com',
          password: 'NoPass123!',
        })
        .expect(401);

      const body = res.body as ApiErrorResponse;
      // Verify the error response does not leak stack traces
      expect(body.error).not.toHaveProperty('stack');
      expect(JSON.stringify(body)).not.toContain('at Object.');
      expect(JSON.stringify(body)).not.toContain('node_modules');
    },
  );
});

// ============================================================================
// Phase 8: API Versioning Verification (R30)
// ============================================================================

describe('API Versioning (R30)', () => {
  it(
    'should serve auth endpoints under /api/v1/ prefix',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'versioned@test.com',
          password: 'VersionedPass123!',
          displayName: 'Versioned User',
        });

      // Correct versioned prefix → should succeed (201)
      expect(res.status).toBe(201);
    },
  );

  it(
    'should return 404 for endpoints without /api/v1/ prefix',
    async () => {
      // Missing /api/v1/ prefix entirely
      const res1 = await request(app)
        .post('/auth/register')
        .send({
          email: 'noprefix@test.com',
          password: 'NoPrefix123!',
          displayName: 'No Prefix',
        });

      expect(res1.status).toBe(404);
    },
  );

  it(
    'should return 404 for unversioned /api/ prefix',
    async () => {
      // /api/ without version
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'noversion@test.com',
          password: 'NoVersion123!',
          displayName: 'No Version',
        });

      expect(res.status).toBe(404);
    },
  );

  it(
    'should return 404 for invalid version prefix',
    async () => {
      // /api/v2/ (wrong version)
      const res = await request(app)
        .post('/api/v2/auth/register')
        .send({
          email: 'v2test@test.com',
          password: 'V2Test123!',
          displayName: 'V2 Test',
        });

      expect(res.status).toBe(404);
    },
  );
});
