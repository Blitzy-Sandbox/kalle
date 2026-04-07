/**
 * @file apps/api/tests/integration/group.test.ts
 * @description Integration tests for group conversation CRUD operations,
 * membership management, admin authorization, and Sender Key redistribution
 * triggers (R14). Also verifies fan-out via BullMQ for 3+ participant
 * groups (R18) and standardised error responses (R22).
 *
 * Tests are structured in 7 phases:
 *   Phase 1 — Setup & Helpers
 *   Phase 2 — Group Creation
 *   Phase 3 — Add Participant (R14)
 *   Phase 4 — Remove Participant (R14 key rotation)
 *   Phase 5 — Admin Promotion / Demotion
 *   Phase 6 — Fan-Out Threshold (R18)
 *   Phase 7 — Error Response Verification (R22)
 *
 * Critical Rules Verified:
 *   R14  — Group Encryption via Sender Keys
 *   R18  — Fan-Out via Queue (3+ participants → BullMQ job)
 *   R22  — Standardised Error Responses
 *   R30  — API Versioning (/api/v1/)
 *   R31  — Input Validation via Zod
 *   R32  — Immutable Audit Log
 *
 * @see apps/api/src/services/ConversationService.ts
 * @see apps/api/src/controllers/ConversationController.ts
 * @see apps/api/src/routes/v1/conversation.routes.ts
 */

// =============================================================================
// External Imports
// =============================================================================

import request from 'supertest';
import { PrismaClient } from '@prisma/client';

// =============================================================================
// Type-only imports from shared package
// =============================================================================

import type {
  ConversationResponse,
  AuthResponse,
  ApiErrorResponse,
} from '@kalle/shared';
import { ConversationType, ParticipantRole } from '@kalle/shared';
import type { Application } from 'express';

// =============================================================================
// Internal Imports — DI Chain
// =============================================================================

import { createApp } from '../../src/app';
import { createV1Router } from '../../src/routes/v1/index';
import { validateEnv } from '../../src/config/env';
import type { EnvConfig } from '../../src/config/env';
import { createRedisClient } from '../../src/config/redis';
import { getCorsOptions } from '../../src/config/cors';

// Repositories (Prisma-backed)
import { UserRepository } from '../../src/repositories/UserRepository';
import { SessionRepository } from '../../src/repositories/SessionRepository';
import { AuditRepository } from '../../src/repositories/AuditRepository';
import { ConversationRepository } from '../../src/repositories/ConversationRepository';
import { MessageRepository } from '../../src/repositories/MessageRepository';

// Providers
import { CacheProvider } from '../../src/providers/CacheProvider';
import { QueueProvider } from '../../src/providers/QueueProvider';
import { LoggerProvider } from '../../src/providers/LoggerProvider';

// Services
import { AuthService } from '../../src/services/AuthService';
import { AuditService } from '../../src/services/AuditService';
import { UserService } from '../../src/services/UserService';
import { ConversationService } from '../../src/services/ConversationService';
import { MessageService } from '../../src/services/MessageService';
import { HealthService } from '../../src/services/HealthService';
// Controllers
import { AuthController } from '../../src/controllers/AuthController';
import { UserController } from '../../src/controllers/UserController';
import { ConversationController } from '../../src/controllers/ConversationController';
import { MessageController } from '../../src/controllers/MessageController';
import { HealthController } from '../../src/controllers/HealthController';

// Middleware
import { createLoggerMiddleware } from '../../src/middleware/logger';

// =============================================================================
// Phase 1 — Test Constants and State
// =============================================================================

/** Test user definitions for group tests. */
const ALICE = {
  email: 'alice-group@integration-test.com',
  password: 'SecurePass123!',
  displayName: 'Alice Group',
};

const BOB = {
  email: 'bob-group@integration-test.com',
  password: 'SecurePass123!',
  displayName: 'Bob Group',
};

const CHARLIE = {
  email: 'charlie-group@integration-test.com',
  password: 'SecurePass123!',
  displayName: 'Charlie Group',
};

const DAVE = {
  email: 'dave-group@integration-test.com',
  password: 'SecurePass123!',
  displayName: 'Dave Group',
};

/** Global test state. */
let app: Application;
let prisma: PrismaClient;
let redisClient: ReturnType<typeof createRedisClient>;
let env: EnvConfig;
let queueProvider: QueueProvider;
let infrastructureAvailable = false;

/** Spy on QueueProvider.enqueue to verify BullMQ job enqueue calls. */
let enqueueSpy: jest.SpyInstance;

// =============================================================================
// Environment Setup
// =============================================================================

/**
 * Populates process.env with sensible defaults for integration tests.
 * Values are only set when not already present, allowing CI overrides.
 */
function setupTestEnv(): void {
  const defaults: Record<string, string> = {
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      'postgresql://kalle_app:kalle_app_password@localhost:5432/kalle_db?schema=public',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'integration-test-jwt-secret-minimum-32-chars-long!',
    CORS_ORIGIN: 'http://localhost:3000',
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

// =============================================================================
// Database & Redis Cleanup
// =============================================================================

/**
 * Truncates all tables in dependency order (children → parents) for
 * deterministic test isolation.
 */
async function cleanDatabase(): Promise<void> {
  await prisma.messageStatus.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversationParticipant.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
}

/**
 * Flushes Redis keys used by the test suite (blacklist, cache).
 */
async function cleanRedis(): Promise<void> {
  const keys = await redisClient.keys('blacklist:*');
  const cacheKeys = await redisClient.keys('conversation:*');
  const allKeys = [...keys, ...cacheKeys];
  if (allKeys.length > 0) {
    await redisClient.del(...allKeys);
  }
}

// =============================================================================
// Test Lifecycle Hooks
// =============================================================================

beforeAll(async () => {
  try {
    // Step 1: Environment variables
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

    // Step 4: Connect to Redis
    redisClient = createRedisClient(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      connectTimeout: 3000,
    });
    await redisClient.connect();
    await redisClient.ping();

    infrastructureAvailable = true;

    // Step 5: Build full DI chain
    const loggerProvider = new LoggerProvider('silent');
    const baseLogger = loggerProvider.getBaseLogger();

    // Repositories
    const userRepository = new UserRepository(prisma);
    const sessionRepository = new SessionRepository(prisma);
    const auditRepository = new AuditRepository(prisma);
    const conversationRepository = new ConversationRepository(prisma);
    const messageRepository = new MessageRepository(prisma);

    // Providers
    const cacheProvider = new CacheProvider(redisClient);
    queueProvider = new QueueProvider(redisClient, env.REDIS_URL);

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
    const conversationService = new ConversationService(
      conversationRepository,
      userRepository,
      cacheProvider,
      queueProvider,
      auditService,
    );
    const messageService = new MessageService(
      messageRepository,
      conversationRepository,
      cacheProvider,
      queueProvider,
    );
    const healthService = new HealthService(prisma, redisClient);

    // MetricsService stub — satisfies HealthController constructor
    const metricsServiceStub = {
      httpRequestsTotal: { add: jest.fn() },
      httpRequestDuration: { record: jest.fn() },
      httpActiveRequests: { add: jest.fn() },
      wsConnectionsTotal: { add: jest.fn() },
      recordHttpRequest: jest.fn(),
      recordDbQuery: jest.fn(),
      recordBullmqJob: jest.fn(),
    };

    // Controllers
    const authController = new AuthController(authService);
    const userController = new UserController(userService);
    const conversationController = new ConversationController(
      conversationService,
    );
    const messageController = new MessageController(messageService);
    const healthController = new HealthController(
      healthService,
      metricsServiceStub as never,
    );

    // Stub controllers not under test (not in depends_on_files)
    const noopHandler = (
      _req: unknown,
      _res: unknown,
      next: unknown,
    ): void => {
      (next as () => void)();
    };
    const stubController = (methods: string[]) => {
      const ctrl: Record<string, unknown> = {};
      for (const method of methods) {
        ctrl[method] = noopHandler;
      }
      return ctrl;
    };

    // V1 Router with real controllers for auth, user, conversation, message, health
    const v1Router = createV1Router({
      authController,
      userController,
      conversationController,
      messageController,
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

    // Spy on QueueProvider.enqueue for verifying BullMQ job triggers (R14, R18)
    enqueueSpy = jest.spyOn(queueProvider, 'enqueue');
  } catch (error: unknown) {
    infrastructureAvailable = false;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[group.test] Infrastructure not available: ${message}. ` +
      'Start PostgreSQL and Redis before running integration tests.',
    );
  }
}, 30_000);

beforeEach(async () => {
  if (!infrastructureAvailable) return;
  await cleanDatabase();
  await cleanRedis();
  enqueueSpy?.mockClear();
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
  if (queueProvider) {
    try {
      await queueProvider.close();
    } catch {
      // Best-effort cleanup
    }
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

// =============================================================================
// Auth & Data Helpers
// =============================================================================

/**
 * Registers a user and logs in, returning the access token, refresh token,
 * and user ID.
 *
 * @param userData - User registration payload
 * @returns Object containing accessToken, refreshToken, and userId
 */
async function registerAndLogin(
  userData: { email: string; password: string; displayName: string },
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  // Register
  await request(app)
    .post('/api/v1/auth/register')
    .send(userData)
    .expect('Content-Type', /json/);

  // Login
  const loginRes = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: userData.email, password: userData.password })
    .expect('Content-Type', /json/);

  const body = loginRes.body as { data: AuthResponse };
  return {
    accessToken: body.data.tokens.accessToken,
    refreshToken: body.data.tokens.refreshToken,
    userId: body.data.user.id,
  };
}

/**
 * Creates a GROUP conversation via the API and returns the response body.
 *
 * @param accessToken - Authenticated user's JWT
 * @param participantIds - User IDs to include (excluding the creator)
 * @param groupName - Display name for the group
 * @returns Parsed ConversationResponse from the API
 */
async function createGroup(
  accessToken: string,
  participantIds: string[],
  groupName: string,
): Promise<{ response: request.Response; data: ConversationResponse }> {
  const response = await request(app)
    .post('/api/v1/conversations')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      type: ConversationType.GROUP,
      participantIds,
      groupName,
    });
  return {
    response,
    data: (response.body as { data: ConversationResponse }).data,
  };
}

/**
 * Creates a DIRECT (1:1) conversation via the API.
 *
 * @param accessToken - Authenticated user's JWT
 * @param otherUserId - The other user's ID
 * @returns Parsed ConversationResponse from the API
 */
async function createDirect(
  accessToken: string,
  otherUserId: string,
): Promise<{ response: request.Response; data: ConversationResponse }> {
  const response = await request(app)
    .post('/api/v1/conversations')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      type: ConversationType.DIRECT,
      participantIds: [otherUserId],
    });
  return {
    response,
    data: (response.body as { data: ConversationResponse }).data,
  };
}

// =============================================================================
// Phase 2: Group Creation Tests
// =============================================================================

describe('Group Creation', () => {
  it(
    'should create a group conversation (POST /api/v1/conversations → 201)',
    async () => {
      // Register 3 test users
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);

      // Create group with Alice as creator, Bob and Charlie as participants
      const { response, data } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Test Group',
      );

      // Verify response status
      expect(response.status).toBe(201);

      // Verify response shape: { data: ConversationResponse }
      expect(response.body).toHaveProperty('data');

      // Verify conversation type and name
      expect(data.type).toBe(ConversationType.GROUP);
      expect(data.groupName).toBe('Test Group');

      // Verify participant count (Alice + Bob + Charlie = 3)
      expect(data.participants).toHaveLength(3);

      // Verify creator (Alice) has ADMIN role
      const aliceParticipant = data.participants.find(
        (p) => p.userId === alice.userId,
      );
      expect(aliceParticipant).toBeDefined();
      expect(aliceParticipant!.role).toBe(ParticipantRole.ADMIN);

      // Verify Bob and Charlie have MEMBER role
      const bobParticipant = data.participants.find(
        (p) => p.userId === bob.userId,
      );
      expect(bobParticipant).toBeDefined();
      expect(bobParticipant!.role).toBe(ParticipantRole.MEMBER);

      const charlieParticipant = data.participants.find(
        (p) => p.userId === charlie.userId,
      );
      expect(charlieParticipant).toBeDefined();
      expect(charlieParticipant!.role).toBe(ParticipantRole.MEMBER);

      // Verify id is present (UUID format)
      expect(data.id).toBeDefined();
      expect(typeof data.id).toBe('string');
      expect(data.id.length).toBeGreaterThan(0);

      // Verify createdAt is a valid ISO 8601 timestamp
      expect(data.createdAt).toBeDefined();
      expect(new Date(data.createdAt).toISOString()).toBeTruthy();

      // Verify initial sender-key-distribution job was enqueued (R14)
      expect(enqueueSpy).toHaveBeenCalledWith(
        'sender-key-distribution',
        expect.objectContaining({
          groupId: data.id,
          action: 'initial',
        }),
      );
    },
  );

  it(
    'should require at least 2 other participants for a group (R31)',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);

      // Only 1 participantId for GROUP type → must fail validation
      const response = await request(app)
        .post('/api/v1/conversations')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({
          type: ConversationType.GROUP,
          participantIds: [bob.userId],
          groupName: 'Too Small Group',
        });

      // Service throws ValidationError: "GROUP conversations require at least 2 other participants"
      expect(response.status).toBe(400);
      const errorBody = response.body as ApiErrorResponse;
      expect(errorBody.error).toBeDefined();
      expect(errorBody.error.code).toBeDefined();
    },
  );

  it(
    'should require groupName for GROUP type (R31)',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);

      // GROUP with no groupName → Zod refinement failure
      const response = await request(app)
        .post('/api/v1/conversations')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({
          type: ConversationType.GROUP,
          participantIds: [bob.userId, charlie.userId],
        });

      expect(response.status).toBe(400);
      const errorBody = response.body as ApiErrorResponse;
      expect(errorBody.error).toBeDefined();
      expect(errorBody.error.code).toBeDefined();
    },
  );
});

// =============================================================================
// Phase 3: Add Participant Tests (R14 — Sender Key Distribution)
// =============================================================================

describe('Add Participant (R14)', () => {
  it(
    'should add a participant to a group (POST /api/v1/conversations/:id/members → 200)',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);
      const dave = await registerAndLogin(DAVE);

      // Create group with Alice, Bob, Charlie
      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Add Member Group',
      );
      enqueueSpy.mockClear(); // Clear initial sender-key-distribution call

      // Add Dave using Alice's (admin) token
      const addResponse = await request(app)
        .post(`/api/v1/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ userId: dave.userId });

      expect(addResponse.status).toBe(200);

      const updatedConversation = (
        addResponse.body as { data: ConversationResponse }
      ).data;

      // Verify 4 participants now
      expect(updatedConversation.participants).toHaveLength(4);

      // Verify Dave appears with MEMBER role
      const daveParticipant = updatedConversation.participants.find(
        (p) => p.userId === dave.userId,
      );
      expect(daveParticipant).toBeDefined();
      expect(daveParticipant!.role).toBe(ParticipantRole.MEMBER);
    },
  );

  it(
    'should trigger sender-key-distribution job on member add (R14)',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);
      const dave = await registerAndLogin(DAVE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'SKD Add Group',
      );
      enqueueSpy.mockClear();

      // Add Dave
      await request(app)
        .post(`/api/v1/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ userId: dave.userId })
        .expect(200);

      // Verify sender-key-distribution job was enqueued
      expect(enqueueSpy).toHaveBeenCalledWith(
        'sender-key-distribution',
        expect.objectContaining({
          groupId: group.id,
          newMemberId: dave.userId,
          action: 'member_added',
        }),
      );
    },
  );

  it(
    'should reject non-admin adding members → 403 (R22)',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);
      const dave = await registerAndLogin(DAVE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Non-Admin Add Group',
      );

      // Bob (MEMBER) attempts to add Dave → should be 403
      const response = await request(app)
        .post(`/api/v1/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${bob.accessToken}`)
        .send({ userId: dave.userId });

      expect(response.status).toBe(403);
      const errorBody = response.body as ApiErrorResponse;
      expect(errorBody.error).toBeDefined();
      expect(errorBody.error.code).toBe('AUTHORIZATION_ERROR');
    },
  );

  it(
    'should reject adding a user who is already a member → 409 (R22)',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Duplicate Add Group',
      );

      // Alice (admin) tries to add Bob who is already a member
      const response = await request(app)
        .post(`/api/v1/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ userId: bob.userId });

      expect(response.status).toBe(409);
      const errorBody = response.body as ApiErrorResponse;
      expect(errorBody.error).toBeDefined();
      expect(errorBody.error.code).toBe('CONFLICT');
    },
  );
});

// =============================================================================
// Phase 4: Remove Participant Tests (R14 — Key Rotation)
// =============================================================================

describe('Remove Participant (R14)', () => {
  it(
    'should remove participant from group (DELETE /api/v1/conversations/:id/members/:userId → 200)',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);
      const dave = await registerAndLogin(DAVE);

      // Create group with 4 members
      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId, dave.userId],
        'Remove Member Group',
      );
      enqueueSpy.mockClear();

      // Alice (admin) removes Charlie
      const removeResponse = await request(app)
        .delete(
          `/api/v1/conversations/${group.id}/members/${charlie.userId}`,
        )
        .set('Authorization', `Bearer ${alice.accessToken}`);

      expect(removeResponse.status).toBe(200);

      const updatedConversation = (
        removeResponse.body as { data: ConversationResponse }
      ).data;

      // Verify 3 participants remain (Charlie removed)
      expect(updatedConversation.participants).toHaveLength(3);

      // Verify Charlie is not in the participant list
      const charlieParticipant = updatedConversation.participants.find(
        (p) => p.userId === charlie.userId,
      );
      expect(charlieParticipant).toBeUndefined();
    },
  );

  it(
    'should trigger sender-key-distribution job with key rotation on member removal (R14)',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'SKD Remove Group',
      );
      enqueueSpy.mockClear();

      // Remove Bob
      await request(app)
        .delete(
          `/api/v1/conversations/${group.id}/members/${bob.userId}`,
        )
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .expect(200);

      // Verify sender-key-distribution job enqueued with 'member_removed'
      expect(enqueueSpy).toHaveBeenCalledWith(
        'sender-key-distribution',
        expect.objectContaining({
          groupId: group.id,
          removedMemberId: bob.userId,
          action: 'member_removed',
        }),
      );
    },
  );

  it(
    'should reject non-admin removing members → 403 (R22)',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Non-Admin Remove Group',
      );

      // Bob (MEMBER) attempts to remove Charlie → should be 403
      const response = await request(app)
        .delete(
          `/api/v1/conversations/${group.id}/members/${charlie.userId}`,
        )
        .set('Authorization', `Bearer ${bob.accessToken}`);

      expect(response.status).toBe(403);
      const errorBody = response.body as ApiErrorResponse;
      expect(errorBody.error).toBeDefined();
      expect(errorBody.error.code).toBe('AUTHORIZATION_ERROR');
    },
  );

  it(
    'should allow a member to leave the group (self-remove)',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Self Leave Group',
      );

      // Bob (MEMBER) removes himself (self-leave) → should be 200
      const response = await request(app)
        .delete(
          `/api/v1/conversations/${group.id}/members/${bob.userId}`,
        )
        .set('Authorization', `Bearer ${bob.accessToken}`);

      expect(response.status).toBe(200);

      const updatedConversation = (
        response.body as { data: ConversationResponse }
      ).data;
      expect(updatedConversation.participants).toHaveLength(2);

      // Bob should not be in the list
      const bobParticipant = updatedConversation.participants.find(
        (p) => p.userId === bob.userId,
      );
      expect(bobParticipant).toBeUndefined();
    },
  );
});

// =============================================================================
// Phase 5: Admin Promotion / Demotion
// =============================================================================

describe('Admin Management', () => {
  it(
    'should add a participant directly as ADMIN via role parameter',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);
      const dave = await registerAndLogin(DAVE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Admin Add Group',
      );

      // Add Dave as ADMIN
      const response = await request(app)
        .post(`/api/v1/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ userId: dave.userId, role: ParticipantRole.ADMIN });

      expect(response.status).toBe(200);

      const updatedConversation = (
        response.body as { data: ConversationResponse }
      ).data;

      const daveParticipant = updatedConversation.participants.find(
        (p) => p.userId === dave.userId,
      );
      expect(daveParticipant).toBeDefined();
      expect(daveParticipant!.role).toBe(ParticipantRole.ADMIN);
    },
  );

  it(
    'should not allow non-admin to add members with ADMIN role → 403',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);
      const dave = await registerAndLogin(DAVE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Non-Admin Promote Group',
      );

      // Bob (MEMBER) attempts to add Dave as ADMIN → 403
      const response = await request(app)
        .post(`/api/v1/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${bob.accessToken}`)
        .send({ userId: dave.userId, role: ParticipantRole.ADMIN });

      expect(response.status).toBe(403);
      const errorBody = response.body as ApiErrorResponse;
      expect(errorBody.error).toBeDefined();
      expect(errorBody.error.code).toBe('AUTHORIZATION_ERROR');
    },
  );

  it(
    'should verify group has admin after creation',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Admin Check Group',
      );

      // Verify at least one admin exists
      const admins = group.participants.filter(
        (p) => p.role === ParticipantRole.ADMIN,
      );
      expect(admins.length).toBeGreaterThanOrEqual(1);

      // Alice should be the admin
      expect(admins[0].userId).toBe(alice.userId);
    },
  );

  it(
    'should allow an admin added as ADMIN to also manage members',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);
      const dave = await registerAndLogin(DAVE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Multi Admin Group',
      );

      // Add Dave as ADMIN via Alice
      await request(app)
        .post(`/api/v1/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ userId: dave.userId, role: ParticipantRole.ADMIN })
        .expect(200);

      // Register a new user to be added by Dave
      const eve = await registerAndLogin({
        email: 'eve-group@integration-test.com',
        password: 'SecurePass123!',
        displayName: 'Eve Group',
      });

      // Dave (now ADMIN) adds Eve → should succeed
      const response = await request(app)
        .post(`/api/v1/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${dave.accessToken}`)
        .send({ userId: eve.userId });

      expect(response.status).toBe(200);

      const updatedConversation = (
        response.body as { data: ConversationResponse }
      ).data;
      expect(updatedConversation.participants).toHaveLength(5);
    },
  );
});

// =============================================================================
// Phase 6: Fan-Out Threshold Tests (R18)
// =============================================================================

describe('Fan-Out via Queue (R18)', () => {
  it(
    'should trigger BullMQ message-fanout job for group with 3+ participants',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);

      // Create group with 3 members (Alice, Bob, Charlie)
      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Fan-Out Group',
      );
      enqueueSpy.mockClear();

      // Send a message in the group via the message endpoint
      const sendResponse = await request(app)
        .post(
          `/api/v1/messages/conversations/${group.id}/messages`,
        )
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({
          ciphertext: 'encrypted-test-message-content',
          type: 'TEXT',
          clientMessageId: '00000000-0000-4000-8000-000000000001',
        });

      expect(sendResponse.status).toBe(201);

      // Verify message-fanout BullMQ job was enqueued (R18)
      expect(enqueueSpy).toHaveBeenCalledWith(
        'message-fanout',
        expect.objectContaining({
          conversationId: group.id,
          senderId: alice.userId,
        }),
      );
    },
  );

  it(
    'should NOT trigger message-fanout for 1:1 DIRECT conversation',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);

      // Create DIRECT conversation (2 participants)
      const { data: direct } = await createDirect(
        alice.accessToken,
        bob.userId,
      );
      expect(direct.type).toBe(ConversationType.DIRECT);
      enqueueSpy.mockClear();

      // Send a message in the DIRECT conversation
      const sendResponse = await request(app)
        .post(
          `/api/v1/messages/conversations/${direct.id}/messages`,
        )
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({
          ciphertext: 'encrypted-direct-message-content',
          type: 'TEXT',
          clientMessageId: '00000000-0000-4000-8000-000000000002',
        });

      expect(sendResponse.status).toBe(201);

      // Verify message-fanout was NOT enqueued (only 2 participants)
      const fanoutCalls = enqueueSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'message-fanout',
      );
      expect(fanoutCalls).toHaveLength(0);
    },
  );
});

// =============================================================================
// Phase 7: Error Response Verification (R22)
// =============================================================================

describe('Group Error Responses (R22)', () => {
  it(
    'should return 401 for unauthenticated group creation',
    async () => {
      const response = await request(app)
        .post('/api/v1/conversations')
        .send({
          type: ConversationType.GROUP,
          participantIds: [
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000002',
          ],
          groupName: 'Unauthenticated Group',
        });

      expect(response.status).toBe(401);
      const errorBody = response.body as ApiErrorResponse;
      expect(errorBody.error).toBeDefined();
      expect(errorBody.error.code).toBe('AUTHENTICATION_ERROR');
      expect(typeof errorBody.error.message).toBe('string');
    },
  );

  it(
    'should return 404 for add member on non-existent conversation',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);

      const nonExistentId = '00000000-0000-4000-8000-999999999999';

      const response = await request(app)
        .post(`/api/v1/conversations/${nonExistentId}/members`)
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ userId: bob.userId });

      expect(response.status).toBe(404);
      const errorBody = response.body as ApiErrorResponse;
      expect(errorBody.error).toBeDefined();
      expect(errorBody.error.code).toBe('NOT_FOUND');
    },
  );

  it(
    'should return 401 for unauthenticated member add',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Unauth Member Add Group',
      );

      // No auth header
      const response = await request(app)
        .post(`/api/v1/conversations/${group.id}/members`)
        .send({ userId: '00000000-0000-4000-8000-000000000001' });

      expect(response.status).toBe(401);
      const errorBody = response.body as ApiErrorResponse;
      expect(errorBody.error).toBeDefined();
      expect(errorBody.error.code).toBe('AUTHENTICATION_ERROR');
    },
  );

  it(
    'should return 400 for invalid UUID in path parameter',
    async () => {
      const alice = await registerAndLogin(ALICE);

      const response = await request(app)
        .post('/api/v1/conversations/not-a-uuid/members')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({
          userId: '00000000-0000-4000-8000-000000000001',
        });

      expect(response.status).toBe(400);
      const errorBody = response.body as ApiErrorResponse;
      expect(errorBody.error).toBeDefined();
      expect(errorBody.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it(
    'should return error with standardised shape for all failures (R22)',
    async () => {
      // Send a request guaranteed to fail: no auth, no body
      const response = await request(app)
        .post('/api/v1/conversations')
        .send({});

      // Should be either 401 (no auth) or 400 (validation)
      expect([400, 401]).toContain(response.status);

      const errorBody = response.body as ApiErrorResponse;
      expect(errorBody).toHaveProperty('error');
      expect(errorBody.error).toHaveProperty('code');
      expect(errorBody.error).toHaveProperty('message');
      expect(typeof errorBody.error.code).toBe('string');
      expect(typeof errorBody.error.message).toBe('string');
    },
  );

  it(
    'should return 404 for remove member on non-existent conversation',
    async () => {
      const alice = await registerAndLogin(ALICE);

      const nonExistentId = '00000000-0000-4000-8000-999999999999';
      const fakeUserId = '00000000-0000-4000-8000-888888888888';

      const response = await request(app)
        .delete(
          `/api/v1/conversations/${nonExistentId}/members/${fakeUserId}`,
        )
        .set('Authorization', `Bearer ${alice.accessToken}`);

      expect(response.status).toBe(404);
      const errorBody = response.body as ApiErrorResponse;
      expect(errorBody.error).toBeDefined();
      expect(errorBody.error.code).toBe('NOT_FOUND');
    },
  );
});

// =============================================================================
// Additional Edge Case Tests
// =============================================================================

describe('Group Edge Cases', () => {
  it(
    'should use /api/v1/ prefix for all endpoints (R30)',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);

      // Verify group creation endpoint is under /api/v1/
      const response = await request(app)
        .post('/api/v1/conversations')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({
          type: ConversationType.GROUP,
          participantIds: [bob.userId, charlie.userId],
          groupName: 'API V1 Group',
        });

      expect(response.status).toBe(201);

      // Verify non-versioned endpoint returns 404
      const noVersionResponse = await request(app)
        .post('/api/conversations')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({
          type: ConversationType.GROUP,
          participantIds: [bob.userId, charlie.userId],
          groupName: 'No Version Group',
        });

      expect(noVersionResponse.status).toBe(404);
    },
  );

  it(
    'should handle adding a non-existent user to group → 404',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Non-Existent User Group',
      );

      const nonExistentUserId = '00000000-0000-4000-8000-777777777777';

      const response = await request(app)
        .post(`/api/v1/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ userId: nonExistentUserId });

      expect(response.status).toBe(404);
      const errorBody = response.body as ApiErrorResponse;
      expect(errorBody.error).toBeDefined();
      expect(errorBody.error.code).toBe('NOT_FOUND');
    },
  );

  it(
    'should return audit log entries for group membership changes (R32)',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);
      const dave = await registerAndLogin(DAVE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Audit Group',
      );

      // Add Dave
      await request(app)
        .post(`/api/v1/conversations/${group.id}/members`)
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .send({ userId: dave.userId })
        .expect(200);

      // Remove Dave
      await request(app)
        .delete(
          `/api/v1/conversations/${group.id}/members/${dave.userId}`,
        )
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .expect(200);

      // Verify audit log entries via direct database query
      const auditEntries = await prisma.auditLog.findMany({
        where: {
          OR: [
            { action: 'group.member_add' },
            { action: 'group.member_remove' },
          ],
        },
        orderBy: { createdAt: 'asc' },
      });

      // Should have at least 2 entries: one for add, one for remove
      expect(auditEntries.length).toBeGreaterThanOrEqual(2);

      // Verify the add entry
      const addEntry = auditEntries.find(
        (e) =>
          e.action === 'group.member_add' && e.targetId === dave.userId,
      );
      expect(addEntry).toBeDefined();
      expect(addEntry!.actorId).toBe(alice.userId);

      // Verify the remove entry
      const removeEntry = auditEntries.find(
        (e) =>
          e.action === 'group.member_remove' &&
          e.targetId === dave.userId,
      );
      expect(removeEntry).toBeDefined();
      expect(removeEntry!.actorId).toBe(alice.userId);
    },
  );

  it(
    'should get conversation details for group (GET /api/v1/conversations/:id)',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Get Details Group',
      );

      const getResponse = await request(app)
        .get(`/api/v1/conversations/${group.id}`)
        .set('Authorization', `Bearer ${alice.accessToken}`);

      expect(getResponse.status).toBe(200);

      const conversation = (
        getResponse.body as { data: ConversationResponse }
      ).data;
      expect(conversation.id).toBe(group.id);
      expect(conversation.type).toBe(ConversationType.GROUP);
      expect(conversation.groupName).toBe('Get Details Group');
      expect(conversation.participants).toHaveLength(3);
    },
  );

  it(
    'should not allow non-participant to view group details → 403',
    async () => {
      const alice = await registerAndLogin(ALICE);
      const bob = await registerAndLogin(BOB);
      const charlie = await registerAndLogin(CHARLIE);
      const dave = await registerAndLogin(DAVE);

      const { data: group } = await createGroup(
        alice.accessToken,
        [bob.userId, charlie.userId],
        'Non-Participant View Group',
      );

      // Dave is not a participant → should get 403
      const response = await request(app)
        .get(`/api/v1/conversations/${group.id}`)
        .set('Authorization', `Bearer ${dave.accessToken}`);

      expect(response.status).toBe(403);
    },
  );
});
