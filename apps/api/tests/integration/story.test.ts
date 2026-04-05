/**
 * @module story.test
 * @description Story Lifecycle Integration Tests
 *
 * Comprehensive integration tests verifying the complete story/status lifecycle:
 * - Text story creation with 24h expiration
 * - Story content stored as plaintext (NOT encrypted — R12 exception)
 * - Story feed retrieval (GET /feed) and own stories (GET /me)
 * - View tracking with deduplication
 * - Author-only deletion (403 for non-authors)
 * - Expiration enforcement (R11, R35)
 * - Input validation via Zod (R31)
 * - Standardized error responses (R22)
 * - API versioning under /api/v1/ prefix (R30)
 *
 * Rules Verified:
 * - R11: Story expiration — stories hidden after 24h
 * - R12: Stories are NOT encrypted (explicit exception to E2E encryption)
 * - R22: Standardized error responses { error: { code, message, details? } }
 * - R30: All REST endpoints under /api/v1/ prefix
 * - R31: Input validation via Zod — invalid input returns 400 with field errors
 * - R35: Data retention — stories/media purged after 24h
 *
 * Infrastructure Requirements:
 * - PostgreSQL database (TEST_DATABASE_URL or DATABASE_URL)
 * - Redis instance (REDIS_URL)
 * - Environment variables set (or defaults via validateEnv)
 *
 * @see apps/api/src/controllers/StoryController.ts
 * @see apps/api/src/services/StoryService.ts
 * @see apps/api/src/routes/v1/story.routes.ts
 * @see packages/shared/src/types/story.ts
 */

import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import type { Application } from 'express';
import type {
  StoryResponse,
  StoryFeedItem,
  StoryView as StoryViewType,
  CreateStoryDTO,
  ApiErrorResponse,
  AuthResponse,
} from '@kalle/shared';
import { StoryType } from '@kalle/shared';

import { createApp } from '../../src/app';
import { createV1Router } from '../../src/routes/v1/index';
import { validateEnv } from '../../src/config/env';
import type { EnvConfig } from '../../src/config/env';
import { createRedisClient } from '../../src/config/redis';
import { getCorsOptions } from '../../src/config/cors';
import { UserRepository } from '../../src/repositories/UserRepository';
import { SessionRepository } from '../../src/repositories/SessionRepository';
import { AuditRepository } from '../../src/repositories/AuditRepository';
import { StoryRepository } from '../../src/repositories/StoryRepository';
import { CacheProvider } from '../../src/providers/CacheProvider';
import { StorageProvider } from '../../src/providers/StorageProvider';
import { LoggerProvider } from '../../src/providers/LoggerProvider';
import { AuthService } from '../../src/services/AuthService';
import { AuditService } from '../../src/services/AuditService';
import { UserService } from '../../src/services/UserService';
import { StoryService } from '../../src/services/StoryService';
import { HealthService } from '../../src/services/HealthService';
import { MetricsService } from '../../src/services/MetricsService';
import { AuthController } from '../../src/controllers/AuthController';
import { UserController } from '../../src/controllers/UserController';
import { StoryController } from '../../src/controllers/StoryController';
import { HealthController } from '../../src/controllers/HealthController';
import { createLoggerMiddleware } from '../../src/middleware/logger';

// ============================================================================
// Test Constants
// ============================================================================

/** 24 hours in milliseconds — matches StoryService.STORY_DURATION_MS */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/** Tolerance in milliseconds for time-based assertions (5 seconds) */
const TIME_TOLERANCE_MS = 5_000;

/** Test user A — story author */
const USER_A = {
  email: 'story-author@integration-test.com',
  password: 'SecurePass123!',
  displayName: 'Story Author',
};

/** Test user B — story viewer */
const USER_B = {
  email: 'story-viewer@integration-test.com',
  password: 'SecurePass123!',
  displayName: 'Story Viewer',
};

/** Test user C — secondary viewer for multi-viewer tests */
const USER_C = {
  email: 'story-viewer-c@integration-test.com',
  password: 'SecurePass123!',
  displayName: 'Story Viewer C',
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
 * Truncates all story-related tables in the correct order to satisfy
 * foreign key constraints. Called before each test for deterministic isolation.
 */
async function cleanDatabase(): Promise<void> {
  // Delete in dependency order: children first, parents last
  await prisma.storyView.deleteMany();
  await prisma.media.deleteMany();
  await prisma.story.deleteMany();
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
    const storyRepository = new StoryRepository(prisma);

    // Providers (real Redis-backed and filesystem)
    const cacheProvider = new CacheProvider(redisClient);
    const storageProvider = new StorageProvider(env.UPLOAD_DIR);

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
    const storyService = new StoryService(storyRepository, storageProvider);
    const healthService = new HealthService(prisma, redisClient);
    const metricsService = new MetricsService();

    // Controllers
    const authController = new AuthController(authService);
    const userController = new UserController(userService);
    const storyController = new StoryController(storyService);
    const healthController = new HealthController(healthService, metricsService);

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
      storyController,
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
      metricsService,
    });
  } catch (error: unknown) {
    // Infrastructure is not available — tests will be skipped gracefully
    const message =
      error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.warn(
      `[story.test] Infrastructure not available — tests will be skipped. Reason: ${message}`,
    );
    infrastructureAvailable = false;
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

// ============================================================================
// Conditional execution helper
// ============================================================================

/**
 * Wraps `it` to skip tests when infrastructure is unavailable.
 * Uses standard Jest `it`/`it.skip` mechanism.
 */
const conditionalIt = (...args: Parameters<typeof it>) => {
  if (infrastructureAvailable) {
    return it(...args);
  }
  return it.skip(...args);
};

// ============================================================================
// Auth Helper
// ============================================================================

/**
 * Helper to register a user and return the access token, userId, and email.
 * Reduces boilerplate in tests that need authenticated users.
 */
async function registerAndLogin(
  userData: { email: string; password: string; displayName: string },
): Promise<{ accessToken: string; userId: string; email: string }> {
  // Register
  await request(app)
    .post('/api/v1/auth/register')
    .send(userData)
    .expect('Content-Type', /json/)
    .expect(201);

  // Login
  const loginRes = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: userData.email, password: userData.password })
    .expect('Content-Type', /json/)
    .expect(200);

  const body = loginRes.body as { data: AuthResponse };
  return {
    accessToken: body.data.tokens.accessToken,
    userId: body.data.user.id,
    email: userData.email,
  };
}

// ============================================================================
// Phase 2: Story Creation Tests
// ============================================================================

describe('Story Creation', () => {
  conditionalIt(
    'should create a text story with 24h expiration (POST /api/v1/stories → 201)',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const payload: CreateStoryDTO = {
        type: StoryType.TEXT,
        content: 'Hello World',
        backgroundColor: '#FF6B6B',
      };

      const res = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(payload)
        .expect('Content-Type', /json/)
        .expect(201);

      const story = res.body.data as StoryResponse;

      // Verify response structure
      expect(story).toBeDefined();
      expect(story.id).toBeDefined();
      expect(story.type).toBe('TEXT');
      expect(story.content).toBe('Hello World');
      expect(story.backgroundColor).toBe('#FF6B6B');
      expect(story.isExpired).toBe(false);
      expect(story.viewCount).toBe(0);

      // Verify 24h expiration (R11)
      const createdAt = new Date(story.createdAt).getTime();
      const expiresAt = new Date(story.expiresAt).getTime();
      const diff = expiresAt - createdAt;
      expect(Math.abs(diff - TWENTY_FOUR_HOURS_MS)).toBeLessThan(
        TIME_TOLERANCE_MS,
      );

      // Verify valid ISO 8601 timestamps
      expect(new Date(story.createdAt).toISOString()).toBe(story.createdAt);
      expect(new Date(story.expiresAt).toISOString()).toBe(story.expiresAt);
    },
  );

  conditionalIt(
    'should default TEXT story duration to 7 seconds',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const res = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'Duration test' })
        .expect(201);

      const story = res.body.data as StoryResponse;
      expect(story.duration).toBe(7);
    },
  );

  conditionalIt(
    'should allow custom duration within 1-30 range',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const res = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'Custom duration', duration: 15 })
        .expect(201);

      const story = res.body.data as StoryResponse;
      expect(story.duration).toBe(15);
    },
  );

  conditionalIt(
    'should return 400 for missing story type (R31)',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const res = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ content: 'No type provided' })
        .expect('Content-Type', /json/)
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(typeof res.body.error.message).toBe('string');
    },
  );

  conditionalIt(
    'should return 400 for invalid story type value',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const res = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'INVALID_TYPE', content: 'Bad type' })
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  conditionalIt(
    'should return 400 for TEXT story without content (R31)',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const res = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT' })
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  conditionalIt(
    'should return 400 for content exceeding 1000 characters',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const longContent = 'A'.repeat(1001);

      const res = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: longContent })
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  conditionalIt(
    'should return 400 for invalid backgroundColor format',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const res = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          type: 'TEXT',
          content: 'Bad color',
          backgroundColor: 'not-a-color',
        })
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  conditionalIt(
    'should return 400 for duration outside 1-30 range',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      // Duration too large
      const res1 = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'Bad duration', duration: 31 })
        .expect(400);

      expect(res1.body.error.code).toBe('VALIDATION_ERROR');

      // Duration too small (0)
      const res2 = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'Bad duration', duration: 0 })
        .expect(400);

      expect(res2.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  conditionalIt(
    'should store story content as plaintext - not encrypted (R12 exception)',
    async () => {
      const { accessToken, userId } = await registerAndLogin(USER_A);
      const testContent =
        'This is a test status message for R12 verification';

      const res = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: testContent })
        .expect(201);

      const storyId = (res.body.data as StoryResponse).id;

      // Query database directly to verify plaintext storage
      const dbStory = await prisma.story.findUnique({
        where: { id: storyId },
      });

      expect(dbStory).not.toBeNull();
      expect(dbStory!.textContent).toBe(testContent);
      expect(dbStory!.authorId).toBe(userId);
    },
  );

  conditionalIt(
    'should set authorId from authenticated user',
    async () => {
      const { accessToken, userId } = await registerAndLogin(USER_A);

      const res = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'Author test' })
        .expect(201);

      const story = res.body.data as StoryResponse;
      expect(story.authorId).toBe(userId);
    },
  );
});

// ============================================================================
// Phase 3: Story Feed and Own Stories Tests
// ============================================================================

describe('Story Feed and Own Stories', () => {
  conditionalIt(
    'should return own stories via GET /api/v1/stories/me (200)',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      // Create two stories
      await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'Story 1' })
        .expect(201);

      await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          type: 'TEXT',
          content: 'Story 2',
          backgroundColor: '#000000',
        })
        .expect(201);

      const res = await request(app)
        .get('/api/v1/stories/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect('Content-Type', /json/)
        .expect(200);

      const stories = res.body.data as StoryResponse[];
      expect(Array.isArray(stories)).toBe(true);
      expect(stories.length).toBe(2);
    },
  );

  conditionalIt(
    'should return story feed as array (GET /api/v1/stories/feed -> 200)',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const res = await request(app)
        .get('/api/v1/stories/feed')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect('Content-Type', /json/)
        .expect(200);

      // Feed returns an array of StoryFeedItem (may be empty if no contacts have stories)
      const feed = res.body.data as StoryFeedItem[];
      expect(Array.isArray(feed)).toBe(true);
    },
  );

  conditionalIt(
    'should exclude expired stories from /me (R11)',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      // Create a story
      const createRes = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'Will expire soon' })
        .expect(201);

      const storyId = (createRes.body.data as StoryResponse).id;

      // Manually expire the story in DB
      await prisma.story.update({
        where: { id: storyId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      // Fetch own stories
      const res = await request(app)
        .get('/api/v1/stories/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const stories = res.body.data as StoryResponse[];
      const returnedIds = stories.map((s) => s.id);
      expect(returnedIds).not.toContain(storyId);
    },
  );

  conditionalIt(
    'should return empty array when user has no stories',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const res = await request(app)
        .get('/api/v1/stories/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.data).toEqual([]);
    },
  );

  conditionalIt(
    'should sort own stories chronologically',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      // Create stories with slight delay
      await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'First story' })
        .expect(201);

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 50));

      await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'Second story' })
        .expect(201);

      const res = await request(app)
        .get('/api/v1/stories/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const stories = res.body.data as StoryResponse[];
      expect(stories.length).toBe(2);

      // Verify chronological order (ascending or descending)
      const timestamps = stories.map((s) =>
        new Date(s.createdAt).getTime(),
      );
      const isSorted =
        timestamps.every(
          (t, i) => i === 0 || t >= timestamps[i - 1],
        ) ||
        timestamps.every(
          (t, i) => i === 0 || t <= timestamps[i - 1],
        );
      expect(isSorted).toBe(true);
    },
  );
});

// ============================================================================
// Phase 4: Story View Tracking Tests
// ============================================================================

describe('Story View Tracking', () => {
  conditionalIt(
    'should record story view (POST /api/v1/stories/:storyId/view -> 200)',
    async () => {
      const userA = await registerAndLogin(USER_A);
      const userB = await registerAndLogin(USER_B);

      // User A creates a story
      const createRes = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ type: 'TEXT', content: 'View me' })
        .expect(201);

      const storyId = (createRes.body.data as StoryResponse).id;

      // User B views it
      const viewRes = await request(app)
        .post(`/api/v1/stories/${storyId}/view`)
        .set('Authorization', `Bearer ${userB.accessToken}`)
        .expect('Content-Type', /json/)
        .expect(200);

      const viewRecord = viewRes.body.data as StoryViewType | null;
      expect(viewRecord || viewRes.body.data).toBeDefined();

      // Verify view record in DB
      const views = await prisma.storyView.findMany({
        where: { storyId },
      });
      expect(views.length).toBe(1);
      expect(views[0].viewerId).toBe(userB.userId);
    },
  );

  conditionalIt(
    'should deduplicate views from the same user',
    async () => {
      const userA = await registerAndLogin(USER_A);
      const userB = await registerAndLogin(USER_B);

      // User A creates a story
      const createRes = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ type: 'TEXT', content: 'Dedup test' })
        .expect(201);

      const storyId = (createRes.body.data as StoryResponse).id;

      // User B views it twice
      await request(app)
        .post(`/api/v1/stories/${storyId}/view`)
        .set('Authorization', `Bearer ${userB.accessToken}`)
        .expect(200);

      await request(app)
        .post(`/api/v1/stories/${storyId}/view`)
        .set('Authorization', `Bearer ${userB.accessToken}`)
        .expect(200);

      // Verify: only one view record
      const views = await prisma.storyView.findMany({
        where: { storyId },
      });
      expect(views.length).toBe(1);
    },
  );

  conditionalIt(
    'should track views from multiple users independently',
    async () => {
      const userA = await registerAndLogin(USER_A);
      const userB = await registerAndLogin(USER_B);
      const userC = await registerAndLogin(USER_C);

      const createRes = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ type: 'TEXT', content: 'Multi-viewer test' })
        .expect(201);

      const storyId = (createRes.body.data as StoryResponse).id;

      // Both users view it
      await request(app)
        .post(`/api/v1/stories/${storyId}/view`)
        .set('Authorization', `Bearer ${userB.accessToken}`)
        .expect(200);

      await request(app)
        .post(`/api/v1/stories/${storyId}/view`)
        .set('Authorization', `Bearer ${userC.accessToken}`)
        .expect(200);

      // Verify: two view records with correct viewerIds
      const views = await prisma.storyView.findMany({
        where: { storyId },
        orderBy: { viewedAt: 'asc' },
      });

      expect(views.length).toBe(2);
      const viewerIds = views.map((v) => v.viewerId).sort();
      expect(viewerIds).toEqual(
        [userB.userId, userC.userId].sort(),
      );
    },
  );

  conditionalIt(
    'should return 404 for viewing a non-existent story',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const fakeUuid = '00000000-0000-4000-a000-000000000000';

      const res = await request(app)
        .post(`/api/v1/stories/${fakeUuid}/view`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect('Content-Type', /json/)
        .expect(404);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('NOT_FOUND');
    },
  );

  conditionalIt(
    'should return 400 for invalid storyId format on view',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const res = await request(app)
        .post('/api/v1/stories/not-a-uuid/view')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  conditionalIt(
    'should return 404 when viewing an expired story',
    async () => {
      const userA = await registerAndLogin(USER_A);
      const userB = await registerAndLogin(USER_B);

      const createRes = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ type: 'TEXT', content: 'Will expire' })
        .expect(201);

      const storyId = (createRes.body.data as StoryResponse).id;

      // Manually expire the story
      await prisma.story.update({
        where: { id: storyId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      // Attempt to view expired story
      const res = await request(app)
        .post(`/api/v1/stories/${storyId}/view`)
        .set('Authorization', `Bearer ${userB.accessToken}`)
        .expect(404);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('NOT_FOUND');
    },
  );
});

// ============================================================================
// Phase 5: Story Deletion Tests
// ============================================================================

describe('Story Deletion', () => {
  conditionalIt(
    'should allow author to delete own story (DELETE /api/v1/stories/:id -> 200)',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const createRes = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'To be deleted' })
        .expect(201);

      const storyId = (createRes.body.data as StoryResponse).id;

      // Delete
      const deleteRes = await request(app)
        .delete(`/api/v1/stories/${storyId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect('Content-Type', /json/)
        .expect(200);

      expect(deleteRes.body.data).toBeDefined();
      expect(deleteRes.body.data.message).toBeDefined();

      // Verify story no longer exists in DB
      const dbStory = await prisma.story.findUnique({
        where: { id: storyId },
      });
      expect(dbStory).toBeNull();
    },
  );

  conditionalIt(
    'should not allow non-author to delete story (403)',
    async () => {
      const userA = await registerAndLogin(USER_A);
      const userB = await registerAndLogin(USER_B);

      const createRes = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ type: 'TEXT', content: 'Protected story' })
        .expect(201);

      const storyId = (createRes.body.data as StoryResponse).id;

      // User B tries to delete User A's story
      const res = await request(app)
        .delete(`/api/v1/stories/${storyId}`)
        .set('Authorization', `Bearer ${userB.accessToken}`)
        .expect(403);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBeDefined();
    },
  );

  conditionalIt(
    'should return 404 for deleting non-existent story',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);
      const fakeUuid = '00000000-0000-4000-a000-000000000000';

      const res = await request(app)
        .delete(`/api/v1/stories/${fakeUuid}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('NOT_FOUND');
    },
  );

  conditionalIt(
    'should return 400 for invalid storyId format on delete',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const res = await request(app)
        .delete('/api/v1/stories/not-a-uuid')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  conditionalIt(
    'should cascade-delete associated StoryView records',
    async () => {
      const userA = await registerAndLogin(USER_A);
      const userB = await registerAndLogin(USER_B);

      const createRes = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .send({ type: 'TEXT', content: 'Cascade test' })
        .expect(201);

      const storyId = (createRes.body.data as StoryResponse).id;

      // Add a view
      await request(app)
        .post(`/api/v1/stories/${storyId}/view`)
        .set('Authorization', `Bearer ${userB.accessToken}`)
        .expect(200);

      // Verify view exists
      const viewsBefore = await prisma.storyView.findMany({
        where: { storyId },
      });
      expect(viewsBefore.length).toBe(1);

      // Delete story
      await request(app)
        .delete(`/api/v1/stories/${storyId}`)
        .set('Authorization', `Bearer ${userA.accessToken}`)
        .expect(200);

      // Verify views are cascade-deleted
      const viewsAfter = await prisma.storyView.findMany({
        where: { storyId },
      });
      expect(viewsAfter.length).toBe(0);
    },
  );
});

// ============================================================================
// Phase 6: Story Expiration Tests (R11, R35)
// ============================================================================

describe('Story Expiration (R11, R35)', () => {
  conditionalIt(
    'should set expiresAt to exactly 24h from creation',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const res = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'Expiration timing test' })
        .expect(201);

      const story = res.body.data as StoryResponse;
      const createdAt = new Date(story.createdAt).getTime();
      const expiresAt = new Date(story.expiresAt).getTime();
      const diff = expiresAt - createdAt;

      // Should be within 5 seconds of exactly 24 hours
      expect(Math.abs(diff - TWENTY_FOUR_HOURS_MS)).toBeLessThan(
        TIME_TOLERANCE_MS,
      );
    },
  );

  conditionalIt(
    'should store expiresAt correctly in database',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      const res = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'DB expiration test' })
        .expect(201);

      const storyId = (res.body.data as StoryResponse).id;
      const dbStory = await prisma.story.findUnique({
        where: { id: storyId },
      });

      expect(dbStory).not.toBeNull();

      const dbExpires = dbStory!.expiresAt.getTime();
      const dbCreated = dbStory!.createdAt.getTime();
      const diff = dbExpires - dbCreated;

      expect(Math.abs(diff - TWENTY_FOUR_HOURS_MS)).toBeLessThan(
        TIME_TOLERANCE_MS,
      );
    },
  );

  conditionalIt(
    'should not return expired stories from /me endpoint (R11)',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      // Create two stories
      const activeRes = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'Active story' })
        .expect(201);

      const expiredRes = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ type: 'TEXT', content: 'Expired story' })
        .expect(201);

      const activeId = (activeRes.body.data as StoryResponse).id;
      const expiredId = (expiredRes.body.data as StoryResponse).id;

      // Manually expire one story
      await prisma.story.update({
        where: { id: expiredId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      // Fetch own stories
      const res = await request(app)
        .get('/api/v1/stories/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const stories = res.body.data as StoryResponse[];
      const returnedIds = stories.map((s) => s.id);

      expect(returnedIds).toContain(activeId);
      expect(returnedIds).not.toContain(expiredId);
    },
  );
});

// ============================================================================
// Phase 7: Story Error Responses (R22)
// ============================================================================

describe('Story Error Responses (R22)', () => {
  conditionalIt(
    'should return 401 for unauthenticated story creation',
    async () => {
      const res = await request(app)
        .post('/api/v1/stories')
        .send({ type: 'TEXT', content: 'No auth' })
        .expect('Content-Type', /json/)
        .expect(401);

      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBeDefined();
      expect(typeof res.body.error.message).toBe('string');
    },
  );

  conditionalIt(
    'should return 401 for unauthenticated feed request',
    async () => {
      const res = await request(app)
        .get('/api/v1/stories/feed')
        .expect(401);

      expect(res.body.error).toBeDefined();
    },
  );

  conditionalIt(
    'should return 401 for unauthenticated own stories request',
    async () => {
      const res = await request(app)
        .get('/api/v1/stories/me')
        .expect(401);

      expect(res.body.error).toBeDefined();
    },
  );

  conditionalIt(
    'should return 401 for unauthenticated story view',
    async () => {
      const fakeUuid = '00000000-0000-4000-a000-000000000000';

      const res = await request(app)
        .post(`/api/v1/stories/${fakeUuid}/view`)
        .expect(401);

      expect(res.body.error).toBeDefined();
    },
  );

  conditionalIt(
    'should return 401 for unauthenticated story deletion',
    async () => {
      const fakeUuid = '00000000-0000-4000-a000-000000000000';

      const res = await request(app)
        .delete(`/api/v1/stories/${fakeUuid}`)
        .expect(401);

      expect(res.body.error).toBeDefined();
    },
  );

  conditionalIt(
    'should return 401 for invalid JWT token',
    async () => {
      const res = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', 'Bearer invalid.jwt.token')
        .send({ type: 'TEXT', content: 'Invalid JWT' })
        .expect(401);

      expect(res.body.error).toBeDefined();
    },
  );

  conditionalIt(
    'should use standardized error shape for all error responses (R22)',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      // 400 — validation error
      const valRes = await request(app)
        .post('/api/v1/stories')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({}) // Missing type
        .expect(400);

      const valError = valRes.body as ApiErrorResponse;
      expect(valError.error).toBeDefined();
      expect(valError.error.code).toBeDefined();
      expect(typeof valError.error.message).toBe('string');

      // 404 — not found
      const fakeUuid = '00000000-0000-4000-a000-000000000000';
      const notFoundRes = await request(app)
        .post(`/api/v1/stories/${fakeUuid}/view`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      const notFoundError = notFoundRes.body as ApiErrorResponse;
      expect(notFoundError.error).toBeDefined();
      expect(notFoundError.error.code).toBeDefined();
      expect(typeof notFoundError.error.message).toBe('string');

      // 401 — unauthenticated
      const unauthRes = await request(app)
        .post('/api/v1/stories')
        .send({ type: 'TEXT', content: 'No auth' })
        .expect(401);

      const unauthError = unauthRes.body as ApiErrorResponse;
      expect(unauthError.error).toBeDefined();
      expect(unauthError.error.code).toBeDefined();
      expect(typeof unauthError.error.message).toBe('string');
    },
  );
});

// ============================================================================
// Phase 8: API Versioning (R30)
// ============================================================================

describe('API Versioning (R30)', () => {
  conditionalIt(
    'should respond on versioned /api/v1/stories endpoints',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      // Versioned endpoint works
      const res = await request(app)
        .get('/api/v1/stories/feed')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body).toBeDefined();
    },
  );

  conditionalIt(
    'should return 404 for unversioned /stories endpoint (R30)',
    async () => {
      const { accessToken } = await registerAndLogin(USER_A);

      await request(app)
        .get('/stories/feed')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
    },
  );
});
