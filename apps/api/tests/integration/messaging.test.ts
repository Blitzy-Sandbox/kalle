/**
 * @module messaging.test
 * @description Encrypted Messaging Integration Tests
 *
 * Comprehensive integration tests verifying the full encrypted message lifecycle:
 * - Send encrypted message (ciphertext-only storage, R12)
 * - Message edit (15-minute window, sender-only, ciphertext swap, R19)
 * - Message delete (soft-delete tombstone, ciphertext nulled, R20)
 * - Message history with cursor-based pagination
 * - Client deduplication via clientMessageId (R4)
 * - Standardized error responses (R22)
 * - API versioning (R30)
 * - Input validation via Zod (R31)
 *
 * Rules Verified:
 * - R12: E2E Encryption Integrity — server stores ONLY ciphertext, zero plaintext
 * - R19: Message Edit Integrity — sender-only, 15-min window, ciphertext replaced
 * - R20: Message Delete as Tombstone — ciphertext nulled, row retained
 * - R4:  Real-time Message Integrity — deduplication via clientMessageId
 * - R22: Standardized Error Responses { error: { code, message, details? } }
 * - R30: All REST endpoints under /api/v1/ prefix
 * - R31: Input validation via Zod — invalid input returns 400 with field errors
 *
 * Infrastructure Requirements:
 * - PostgreSQL database (TEST_DATABASE_URL or DATABASE_URL)
 * - Redis instance (REDIS_URL)
 * - Environment variables set (or defaults via validateEnv)
 *
 * @see apps/api/src/controllers/MessageController.ts
 * @see apps/api/src/services/MessageService.ts
 * @see apps/api/src/routes/v1/message.routes.ts
 */

import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import type { Application } from 'express';
import {
  MessageType,
  MessageStatusEnum,
} from '@kalle/shared';
import type {
  MessageResponse,
  SendMessageDTO,
  EditMessageDTO,
  AuthResponse,
  ApiErrorResponse,
} from '@kalle/shared';

import { createApp, type AppDependencies } from '../../src/app';
import { createV1Router, type V1RouterDependencies } from '../../src/routes/v1/index';
import { validateEnv } from '../../src/config/env';
import type { EnvConfig } from '../../src/config/env';
import { createRedisClient } from '../../src/config/redis';
import { getCorsOptions } from '../../src/config/cors';
import { UserRepository } from '../../src/repositories/UserRepository';
import { SessionRepository } from '../../src/repositories/SessionRepository';
import { AuditRepository } from '../../src/repositories/AuditRepository';
import { MessageRepository } from '../../src/repositories/MessageRepository';
import { ConversationRepository } from '../../src/repositories/ConversationRepository';
import { CacheProvider } from '../../src/providers/CacheProvider';
import { QueueProvider } from '../../src/providers/QueueProvider';
import { LoggerProvider } from '../../src/providers/LoggerProvider';
import { AuditService } from '../../src/services/AuditService';
import { AuthService } from '../../src/services/AuthService';
import { UserService } from '../../src/services/UserService';
import { ConversationService } from '../../src/services/ConversationService';
import { MessageService } from '../../src/services/MessageService';
import { HealthService } from '../../src/services/HealthService';
import { AuthController } from '../../src/controllers/AuthController';
import { UserController } from '../../src/controllers/UserController';
import { ConversationController } from '../../src/controllers/ConversationController';
import { MessageController } from '../../src/controllers/MessageController';
import { HealthController } from '../../src/controllers/HealthController';
import { createLoggerMiddleware } from '../../src/middleware/logger';

// ============================================================================
// Test Constants
// ============================================================================

/** Alice user fixture for test registration. */
const ALICE = {
  email: 'alice-msg@integration-test.com',
  password: 'SecurePass123!',
  displayName: 'Alice Msg',
};

/** Bob user fixture for test registration. */
const BOB = {
  email: 'bob-msg@integration-test.com',
  password: 'SecurePass456!',
  displayName: 'Bob Msg',
};

// ============================================================================
// Global Test State
// ============================================================================

let app: Application;
let prisma: PrismaClient;
let redisClient: ReturnType<typeof createRedisClient>;
let env: EnvConfig;
let infrastructureAvailable = false;

// Per-test state populated in beforeEach
let aliceToken: string;
let aliceId: string;
let bobToken: string;
let bobId: string;
let conversationId: string;

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
 * Truncates all messaging-related tables in the correct order to satisfy
 * foreign key constraints. Called before each test for deterministic isolation.
 */
async function cleanDatabase(): Promise<void> {
  // Delete in dependency order: children first, parents last
  await prisma.auditLog.deleteMany();
  await prisma.messageStatus.deleteMany();
  await prisma.media.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversationParticipant.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
}

/**
 * Flushes all keys matching the blacklist and cache patterns from Redis.
 * Ensures a clean state between tests.
 */
async function cleanRedis(): Promise<void> {
  const patterns = ['blacklist:*', 'cache:*', 'presence:*', 'unread:*'];
  for (const pattern of patterns) {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
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
    const messageRepository = new MessageRepository(prisma);
    const conversationRepository = new ConversationRepository(prisma);

    // Providers (real Redis-backed)
    const cacheProvider = new CacheProvider(redisClient);
    const queueProvider = new QueueProvider(redisClient, env.REDIS_URL);

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

    // Controllers
    const authController = new AuthController(authService);
    const userController = new UserController(userService);
    const conversationController = new ConversationController(conversationService);
    const messageController = new MessageController(messageService);

    // MetricsService stub — not in our dependency list
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

    // V1 Router — stub controllers not under test
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

    const routerDeps: V1RouterDependencies = {
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
    };

    const v1Router = createV1Router(routerDeps);

    // Create Express app
    const pinoHttpMiddleware = createLoggerMiddleware(baseLogger);
    const corsOptions = getCorsOptions(env.CORS_ORIGIN);

    const appDeps: AppDependencies = {
      corsOptions,
      v1Router,
      pinoHttpMiddleware,
      metricsService: metricsServiceStub as never,
    };

    app = createApp(appDeps);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.warn(
      `[messaging.test] Infrastructure not available — tests will be skipped. Reason: ${message}`,
    );
    infrastructureAvailable = false;
  }
}, 30_000);

beforeEach(async () => {
  if (!infrastructureAvailable) return;
  await cleanDatabase();
  await cleanRedis();

  // Register Alice and Bob, then create a DIRECT conversation between them
  const alice = await registerAndLogin(ALICE);
  aliceToken = alice.accessToken;
  aliceId = alice.userId;

  const bob = await registerAndLogin(BOB);
  bobToken = bob.accessToken;
  bobId = bob.userId;

  // Create a DIRECT conversation between Alice and Bob
  const convRes = await request(app)
    .post('/api/v1/conversations')
    .set('Authorization', `Bearer ${aliceToken}`)
    .send({
      type: 'DIRECT',
      participantIds: [bobId],
    })
    .expect(201);

  conversationId = (convRes.body as { data: { id: string } }).data.id;
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
// Test Helpers
// ============================================================================

/**
 * Registers a user and logs them in, returning auth tokens and userId.
 */
async function registerAndLogin(
  userData: { email: string; password: string; displayName: string },
): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
  await request(app)
    .post('/api/v1/auth/register')
    .send(userData)
    .expect(201);

  const loginRes = await request(app)
    .post('/api/v1/auth/login')
    .send({
      email: userData.email,
      password: userData.password,
    })
    .expect(200);

  const body = loginRes.body as { data: AuthResponse };
  return {
    accessToken: body.data.tokens.accessToken,
    refreshToken: body.data.tokens.refreshToken,
    userId: body.data.user.id,
  };
}

/**
 * Sends a test message to the conversation. Returns the response.
 * Defaults: ciphertext = random base64, type = 'TEXT', fresh clientMessageId.
 */
async function sendTestMessage(
  accessToken: string,
  targetConversationId: string,
  options: {
    ciphertext?: string;
    clientMessageId?: string;
    type?: string;
    replyToMessageId?: string;
    mediaId?: string;
  } = {},
): Promise<request.Response> {
  const {
    ciphertext = `encrypted-content-${uuidv4()}-base64==`,
    clientMessageId = uuidv4(),
    type = 'TEXT',
    replyToMessageId,
    mediaId,
  } = options;

  const payload: Record<string, unknown> = {
    ciphertext,
    type,
    clientMessageId,
  };

  if (replyToMessageId) payload.replyToMessageId = replyToMessageId;
  if (mediaId) payload.mediaId = mediaId;

  return request(app)
    .post(`/api/v1/messages/conversations/${targetConversationId}/messages`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send(payload);
}

// ============================================================================
// Phase 2: Send Encrypted Message Tests (R12)
// ============================================================================

describe('Send Encrypted Message (R12)', () => {
  conditionalIt(
    'should send a message with ciphertext (POST → 201)',
    async () => {
      const clientMessageId = uuidv4();
      const ciphertext = 'encrypted-content-base64-ABC123==';

      const sendPayload: SendMessageDTO = {
        conversationId,
        ciphertext,
        type: MessageType.TEXT,
        clientMessageId,
      };

      const res = await request(app)
        .post(`/api/v1/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send(sendPayload)
        .expect('Content-Type', /json/)
        .expect(201);

      const body = res.body as { data: MessageResponse };
      const msg = body.data;

      // Verify response shape
      expect(msg).toBeDefined();
      expect(msg.id).toBeDefined();
      expect(typeof msg.id).toBe('string');
      expect(msg.conversationId).toBe(conversationId);
      expect(msg.senderId).toBe(aliceId);
      expect(msg.ciphertext).toBe(ciphertext);
      expect(msg.type).toBe(MessageType.TEXT);
      expect(msg.status).toBe(MessageStatusEnum.SENT);
      expect(msg.isEdited).toBe(false);
      expect(msg.isDeleted).toBe(false);
      expect(msg.clientMessageId).toBe(clientMessageId);
      expect(msg.serverTimestamp).toBeDefined();

      // serverTimestamp should be valid ISO 8601
      const ts = new Date(msg.serverTimestamp);
      expect(ts.getTime()).not.toBeNaN();
    },
  );

  conditionalIt(
    'should store ONLY ciphertext in database — zero plaintext (R12)',
    async () => {
      const clientMsgId = uuidv4();
      const knownCiphertext = 'encrypted-AEAD-ciphertext-base64-XYZ789==';

      // Send message with known ciphertext
      await sendTestMessage(aliceToken, conversationId, {
        ciphertext: knownCiphertext,
        clientMessageId: clientMsgId,
      }).then((r) => expect(r.status).toBe(201));

      // Query message table directly via Prisma
      const dbMessage = await prisma.message.findFirst({
        where: { clientMessageId: clientMsgId },
      });

      expect(dbMessage).not.toBeNull();
      expect(dbMessage!.ciphertext).toBe(knownCiphertext);

      // Verify there is no plaintext, content, or decryptedContent field
      const record = dbMessage as Record<string, unknown>;
      expect(record['plaintext']).toBeUndefined();
      expect(record['content']).toBeUndefined();
      expect(record['decryptedContent']).toBeUndefined();

      // The stored value should look like base64 ciphertext, not plaintext
      expect(dbMessage!.ciphertext).toContain('encrypted-');
    },
  );

  conditionalIt(
    'should send a reply message with replyToMessageId',
    async () => {
      // Send original message
      const originalRes = await sendTestMessage(aliceToken, conversationId);
      expect(originalRes.status).toBe(201);

      const originalMsg = (originalRes.body as { data: MessageResponse }).data;

      // Send reply with replyToMessageId
      const replyRes = await sendTestMessage(aliceToken, conversationId, {
        replyToMessageId: originalMsg.id,
      });
      expect(replyRes.status).toBe(201);

      const replyMsg = (replyRes.body as { data: MessageResponse }).data;

      // Verify the reply has a reference to the original message
      expect(replyMsg.replyToMessageId).toBe(originalMsg.id);
    },
  );

  conditionalIt(
    'should allow Bob (participant) to send messages to the conversation',
    async () => {
      const res = await sendTestMessage(bobToken, conversationId);
      expect(res.status).toBe(201);

      const msg = (res.body as { data: MessageResponse }).data;
      expect(msg.senderId).toBe(bobId);
      expect(msg.conversationId).toBe(conversationId);
    },
  );
});

// ============================================================================
// Phase 3: Client Message Deduplication Tests (R4)
// ============================================================================

describe('Client Message Deduplication (R4)', () => {
  conditionalIt(
    'should deduplicate messages with same clientMessageId',
    async () => {
      const clientMessageId = uuidv4();
      const ciphertext = 'dedup-test-ciphertext-base64==';

      // First send — should succeed with 201
      const first = await sendTestMessage(aliceToken, conversationId, {
        ciphertext,
        clientMessageId,
      });
      expect(first.status).toBe(201);

      const firstMsg = (first.body as { data: MessageResponse }).data;

      // Second send with identical clientMessageId — should return existing message
      const second = await sendTestMessage(aliceToken, conversationId, {
        ciphertext: 'different-ciphertext-but-same-clientMessageId',
        clientMessageId,
      });

      // Should return 200 or 201 with the original message (idempotent)
      expect([200, 201]).toContain(second.status);
      const secondMsg = (second.body as { data: MessageResponse }).data;

      // Both responses should have the same message ID
      expect(secondMsg.id).toBe(firstMsg.id);

      // Verify only ONE message row exists in the database
      const count = await prisma.message.count({
        where: { clientMessageId },
      });
      expect(count).toBe(1);
    },
  );
});

// ============================================================================
// Phase 4: Edit Message Tests (R19)
// ============================================================================

describe('Message Edit (R19)', () => {
  conditionalIt(
    'should edit message within 15-min window — ciphertext replaced (PATCH → 200)',
    async () => {
      // Send original message
      const originalCipher = 'original-cipher-text-base64==';
      const sendRes = await sendTestMessage(aliceToken, conversationId, {
        ciphertext: originalCipher,
      });
      expect(sendRes.status).toBe(201);

      const msgId = (sendRes.body as { data: MessageResponse }).data.id;

      // Edit with new ciphertext
      const editedCipher = 'edited-cipher-text-base64-NEW==';
      const editPayload: EditMessageDTO = { ciphertext: editedCipher };
      const editRes = await request(app)
        .patch(`/api/v1/messages/${msgId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send(editPayload)
        .expect('Content-Type', /json/)
        .expect(200);

      const updated = (editRes.body as { data: MessageResponse }).data;

      // Verify ciphertext was replaced
      expect(updated.ciphertext).toBe(editedCipher);
      expect(updated.isEdited).toBe(true);
      expect(updated.editedAt).toBeDefined();

      // editedAt should be valid ISO 8601
      const editedTs = new Date(updated.editedAt!);
      expect(editedTs.getTime()).not.toBeNaN();

      // Query DB directly: verify stored ciphertext is the new one
      const dbMsg = await prisma.message.findUnique({ where: { id: msgId } });
      expect(dbMsg!.ciphertext).toBe(editedCipher);
    },
  );

  conditionalIt(
    'should reject edit after 15-minute window (R19)',
    async () => {
      // Send message
      const sendRes = await sendTestMessage(aliceToken, conversationId);
      expect(sendRes.status).toBe(201);

      const msgId = (sendRes.body as { data: MessageResponse }).data.id;

      // Manually backdate the serverTimestamp to 16 minutes ago
      const sixteenMinutesAgo = new Date(Date.now() - 16 * 60 * 1000);
      await prisma.message.update({
        where: { id: msgId },
        data: { serverTimestamp: sixteenMinutesAgo },
      });

      // Attempt edit after window
      const editRes = await request(app)
        .patch(`/api/v1/messages/${msgId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ ciphertext: 'should-fail-cipher' })
        .expect('Content-Type', /json/);

      // Should be rejected — 400 (validation/business rule) or 403 (auth)
      expect([400, 403]).toContain(editRes.status);

      const errBody = editRes.body as ApiErrorResponse;
      expect(errBody.error).toBeDefined();
      expect(errBody.error.code).toBeDefined();
      expect(errBody.error.message).toBeDefined();
    },
  );

  conditionalIt(
    'should reject edit by non-sender → 403',
    async () => {
      // Alice sends message
      const sendRes = await sendTestMessage(aliceToken, conversationId);
      expect(sendRes.status).toBe(201);

      const msgId = (sendRes.body as { data: MessageResponse }).data.id;

      // Bob attempts to edit Alice's message
      const editRes = await request(app)
        .patch(`/api/v1/messages/${msgId}`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ ciphertext: 'bob-should-not-edit-this' })
        .expect('Content-Type', /json/);

      expect(editRes.status).toBe(403);

      const errBody = editRes.body as ApiErrorResponse;
      expect(errBody.error).toBeDefined();
      expect(errBody.error.code).toBeDefined();
    },
  );

  conditionalIt(
    'should NOT retain original ciphertext after edit (R19)',
    async () => {
      const originalCipher = 'original-cipher-text-MUST-NOT-EXIST-base64';
      const editedCipher = 'edited-cipher-text-REPLACED-base64';
      const clientMsgId = uuidv4();

      // Send with originalCipher
      const sendRes = await sendTestMessage(aliceToken, conversationId, {
        ciphertext: originalCipher,
        clientMessageId: clientMsgId,
      });
      expect(sendRes.status).toBe(201);

      const msgId = (sendRes.body as { data: MessageResponse }).data.id;

      // Edit with editedCipher
      await request(app)
        .patch(`/api/v1/messages/${msgId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ ciphertext: editedCipher })
        .expect(200);

      // Query DB: verify ciphertext was replaced entirely
      const dbMsg = await prisma.message.findUnique({ where: { id: msgId } });
      expect(dbMsg!.ciphertext).toBe(editedCipher);

      // Verify originalCipher does NOT exist in the message record
      const recordJson = JSON.stringify(dbMsg);
      expect(recordJson).not.toContain(originalCipher);

      // There should be no 'previousCiphertext' or 'originalCiphertext' field
      const record = dbMsg as Record<string, unknown>;
      expect(record['previousCiphertext']).toBeUndefined();
      expect(record['originalCiphertext']).toBeUndefined();
    },
  );
});

// ============================================================================
// Phase 5: Delete Message Tests (R20)
// ============================================================================

describe('Message Delete — Tombstone (R20)', () => {
  conditionalIt(
    'should soft-delete message — ciphertext nulled, isDeleted=true (DELETE → 200)',
    async () => {
      // Send message
      const sendRes = await sendTestMessage(aliceToken, conversationId);
      expect(sendRes.status).toBe(201);

      const msgId = (sendRes.body as { data: MessageResponse }).data.id;

      // Delete message
      const deleteRes = await request(app)
        .delete(`/api/v1/messages/${msgId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect('Content-Type', /json/)
        .expect(200);

      const delBody = deleteRes.body as { data: { id: string; conversationId: string; isDeleted: boolean; deletedAt: string } };
      expect(delBody.data.isDeleted).toBe(true);
      expect(delBody.data.deletedAt).toBeDefined();
      expect(delBody.data.id).toBe(msgId);

      // deletedAt should be valid ISO 8601
      const deletedTs = new Date(delBody.data.deletedAt);
      expect(deletedTs.getTime()).not.toBeNaN();

      // Query DB directly — verify tombstone state
      const dbMsg = await prisma.message.findUnique({ where: { id: msgId } });
      expect(dbMsg).not.toBeNull();
      expect(dbMsg!.ciphertext).toBeNull(); // Ciphertext NULLED
      expect(dbMsg!.isDeleted).toBe(true);

      // Row is NOT physically deleted — still exists in database
      expect(dbMsg!.id).toBe(msgId);
    },
  );

  conditionalIt(
    'should reject delete by non-sender → 403',
    async () => {
      // Alice sends message
      const sendRes = await sendTestMessage(aliceToken, conversationId);
      expect(sendRes.status).toBe(201);

      const msgId = (sendRes.body as { data: MessageResponse }).data.id;

      // Bob attempts to delete Alice's message
      const deleteRes = await request(app)
        .delete(`/api/v1/messages/${msgId}`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect('Content-Type', /json/);

      expect(deleteRes.status).toBe(403);

      const errBody = deleteRes.body as ApiErrorResponse;
      expect(errBody.error).toBeDefined();
      expect(errBody.error.code).toBeDefined();
    },
  );

  conditionalIt(
    'should show deleted message as tombstone in message history',
    async () => {
      // Send message, then delete it
      const sendRes = await sendTestMessage(aliceToken, conversationId);
      expect(sendRes.status).toBe(201);

      const msgId = (sendRes.body as { data: MessageResponse }).data.id;

      // Delete
      await request(app)
        .delete(`/api/v1/messages/${msgId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      // Fetch message history
      const historyRes = await request(app)
        .get(`/api/v1/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect('Content-Type', /json/)
        .expect(200);

      const messages = (historyRes.body as { data: MessageResponse[] }).data;

      // Find the deleted message in history
      const tombstone = messages.find((m: MessageResponse) => m.id === msgId);
      expect(tombstone).toBeDefined();
      expect(tombstone!.isDeleted).toBe(true);
      expect(tombstone!.ciphertext).toBeNull();
    },
  );

  conditionalIt(
    'should be idempotent — deleting an already-deleted message succeeds',
    async () => {
      // Send and delete
      const sendRes = await sendTestMessage(aliceToken, conversationId);
      expect(sendRes.status).toBe(201);

      const msgId = (sendRes.body as { data: MessageResponse }).data.id;

      // First delete
      await request(app)
        .delete(`/api/v1/messages/${msgId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      // Second delete — should also succeed (idempotent)
      const secondDelete = await request(app)
        .delete(`/api/v1/messages/${msgId}`)
        .set('Authorization', `Bearer ${aliceToken}`);

      // Accept 200 (idempotent success)
      expect(secondDelete.status).toBe(200);
    },
  );
});

// ============================================================================
// Phase 6: Message History Tests
// ============================================================================

describe('Message History', () => {
  conditionalIt(
    'should return paginated message history (GET → 200)',
    async () => {
      // Send 15 messages to have enough for pagination
      const sendPromises: Promise<request.Response>[] = [];
      for (let i = 0; i < 15; i++) {
        sendPromises.push(
          sendTestMessage(aliceToken, conversationId, {
            ciphertext: `msg-${i}-ciphertext-base64`,
          }),
        );
      }
      // Send sequentially to ensure ordering
      for (const promise of sendPromises) {
        const res = await promise;
        expect(res.status).toBe(201);
      }

      // Fetch first page with limit=5
      const page1Res = await request(app)
        .get(`/api/v1/messages/conversations/${conversationId}/messages?limit=5`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect('Content-Type', /json/)
        .expect(200);

      const page1 = page1Res.body as {
        data: MessageResponse[];
        pagination: { cursor: string | null; hasMore: boolean };
      };

      expect(page1.data).toHaveLength(5);
      expect(page1.pagination).toBeDefined();
      expect(page1.pagination.hasMore).toBe(true);
      expect(page1.pagination.cursor).toBeDefined();

      // Fetch second page using cursor
      const page2Res = await request(app)
        .get(
          `/api/v1/messages/conversations/${conversationId}/messages?limit=5&cursor=${page1.pagination.cursor}`,
        )
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const page2 = page2Res.body as {
        data: MessageResponse[];
        pagination: { cursor: string | null; hasMore: boolean };
      };

      expect(page2.data).toHaveLength(5);

      // Verify no overlap between pages (message IDs should be different)
      const page1Ids = new Set(page1.data.map((m: MessageResponse) => m.id));
      const page2Ids = page2.data.map((m: MessageResponse) => m.id);
      for (const id of page2Ids) {
        expect(page1Ids.has(id)).toBe(false);
      }
    },
  );

  conditionalIt(
    'should return messages in serverTimestamp order',
    async () => {
      // Send multiple messages sequentially
      for (let i = 0; i < 5; i++) {
        const res = await sendTestMessage(aliceToken, conversationId, {
          ciphertext: `ordered-msg-${i}-cipher`,
        });
        expect(res.status).toBe(201);
      }

      // Fetch message history
      const historyRes = await request(app)
        .get(`/api/v1/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const messages = (historyRes.body as { data: MessageResponse[] }).data;
      expect(messages.length).toBeGreaterThanOrEqual(5);

      // Verify messages are sorted by serverTimestamp (descending — newest first)
      for (let i = 1; i < messages.length; i++) {
        const prev = new Date(messages[i - 1].serverTimestamp).getTime();
        const curr = new Date(messages[i].serverTimestamp).getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    },
  );

  conditionalIt(
    'should return empty data for conversation with no messages',
    async () => {
      const historyRes = await request(app)
        .get(`/api/v1/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const body = historyRes.body as {
        data: MessageResponse[];
        pagination: { hasMore: boolean };
      };
      expect(body.data).toHaveLength(0);
      expect(body.pagination.hasMore).toBe(false);
    },
  );
});

// ============================================================================
// Phase 7: Error Response Verification (R22, R30, R31)
// ============================================================================

describe('Messaging Error Responses (R22)', () => {
  conditionalIt(
    'should return 401 for unauthenticated message send',
    async () => {
      const res = await request(app)
        .post(`/api/v1/messages/conversations/${conversationId}/messages`)
        .send({
          ciphertext: 'some-cipher',
          type: 'TEXT',
          clientMessageId: uuidv4(),
        })
        .expect('Content-Type', /json/);

      expect(res.status).toBe(401);

      const errBody = res.body as ApiErrorResponse;
      expect(errBody.error).toBeDefined();
      expect(errBody.error.code).toBeDefined();
      expect(errBody.error.message).toBeDefined();
    },
  );

  conditionalIt(
    'should return 400 for missing required fields (R31)',
    async () => {
      // POST with missing ciphertext — should fail Zod validation
      const res = await request(app)
        .post(`/api/v1/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({
          type: 'TEXT',
          clientMessageId: uuidv4(),
          // ciphertext is MISSING
        })
        .expect('Content-Type', /json/);

      expect(res.status).toBe(400);

      const errBody = res.body as ApiErrorResponse;
      expect(errBody.error).toBeDefined();
      expect(errBody.error.code).toBeDefined();
      expect(errBody.error.message).toBeDefined();
    },
  );

  conditionalIt(
    'should return 400 for missing clientMessageId (R31)',
    async () => {
      const res = await request(app)
        .post(`/api/v1/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({
          ciphertext: 'some-cipher',
          type: 'TEXT',
          // clientMessageId is MISSING
        })
        .expect('Content-Type', /json/);

      expect(res.status).toBe(400);

      const errBody = res.body as ApiErrorResponse;
      expect(errBody.error).toBeDefined();
    },
  );

  conditionalIt(
    'should return 400 for invalid conversationId format in path',
    async () => {
      const res = await request(app)
        .post('/api/v1/messages/conversations/not-a-valid-uuid/messages')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({
          ciphertext: 'some-cipher',
          type: 'TEXT',
          clientMessageId: uuidv4(),
        })
        .expect('Content-Type', /json/);

      expect(res.status).toBe(400);
    },
  );

  conditionalIt(
    'should return 404 for editing non-existent message',
    async () => {
      const fakeMessageId = uuidv4();
      const res = await request(app)
        .patch(`/api/v1/messages/${fakeMessageId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ ciphertext: 'edit-nonexistent' })
        .expect('Content-Type', /json/);

      expect(res.status).toBe(404);

      const errBody = res.body as ApiErrorResponse;
      expect(errBody.error).toBeDefined();
      expect(errBody.error.code).toBeDefined();
    },
  );

  conditionalIt(
    'should return 404 for deleting non-existent message',
    async () => {
      const fakeMessageId = uuidv4();
      const res = await request(app)
        .delete(`/api/v1/messages/${fakeMessageId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect('Content-Type', /json/);

      expect(res.status).toBe(404);
    },
  );

  conditionalIt(
    'should return 401 for unauthenticated message history',
    async () => {
      const res = await request(app)
        .get(`/api/v1/messages/conversations/${conversationId}/messages`)
        .expect('Content-Type', /json/);

      expect(res.status).toBe(401);
    },
  );

  conditionalIt(
    'should use /api/v1/ prefix for all message endpoints (R30)',
    async () => {
      // Verify that endpoints without /api/v1/ prefix return 404
      const res = await request(app)
        .post(`/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({
          ciphertext: 'test',
          type: 'TEXT',
          clientMessageId: uuidv4(),
        });

      expect(res.status).toBe(404);
    },
  );

  conditionalIt(
    'should return standardized error shape for all errors (R22)',
    async () => {
      // Missing auth — should return { error: { code, message } }
      const noAuth = await request(app)
        .post(`/api/v1/messages/conversations/${conversationId}/messages`)
        .send({
          ciphertext: 'test',
          type: 'TEXT',
          clientMessageId: uuidv4(),
        });

      expect(noAuth.status).toBe(401);
      const noAuthBody = noAuth.body as ApiErrorResponse;
      expect(noAuthBody.error).toBeDefined();
      expect(typeof noAuthBody.error.code).toBe('string');
      expect(typeof noAuthBody.error.message).toBe('string');

      // Validation error — should also follow same shape
      const badInput = await request(app)
        .post(`/api/v1/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({
          // Missing required fields
        });

      expect(badInput.status).toBe(400);
      const badInputBody = badInput.body as ApiErrorResponse;
      expect(badInputBody.error).toBeDefined();
      expect(typeof badInputBody.error.code).toBe('string');
      expect(typeof badInputBody.error.message).toBe('string');
    },
  );
});

// ============================================================================
// Phase 8: Additional Edge Cases
// ============================================================================

describe('Message Edge Cases', () => {
  conditionalIt(
    'should handle concurrent sends with different clientMessageIds',
    async () => {
      // Send multiple messages concurrently
      const promises = Array.from({ length: 5 }, () =>
        sendTestMessage(aliceToken, conversationId),
      );

      const results = await Promise.all(promises);

      // All should succeed
      for (const res of results) {
        expect(res.status).toBe(201);
      }

      // Verify all 5 messages exist in the database
      const count = await prisma.message.count({
        where: { conversationId },
      });
      expect(count).toBe(5);
    },
  );

  conditionalIt(
    'should correctly handle edit then delete sequence',
    async () => {
      // Send
      const sendRes = await sendTestMessage(aliceToken, conversationId, {
        ciphertext: 'original-before-edit-and-delete',
      });
      expect(sendRes.status).toBe(201);

      const msgId = (sendRes.body as { data: MessageResponse }).data.id;

      // Edit
      await request(app)
        .patch(`/api/v1/messages/${msgId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ ciphertext: 'edited-before-delete' })
        .expect(200);

      // Delete
      await request(app)
        .delete(`/api/v1/messages/${msgId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      // Verify tombstone state in DB
      const dbMsg = await prisma.message.findUnique({ where: { id: msgId } });
      expect(dbMsg!.isDeleted).toBe(true);
      expect(dbMsg!.ciphertext).toBeNull();
      expect(dbMsg!.isEdited).toBe(true); // Was edited before delete
    },
  );

  conditionalIt(
    'should reject edit on a deleted message',
    async () => {
      // Send and delete
      const sendRes = await sendTestMessage(aliceToken, conversationId);
      expect(sendRes.status).toBe(201);

      const msgId = (sendRes.body as { data: MessageResponse }).data.id;

      await request(app)
        .delete(`/api/v1/messages/${msgId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      // Attempt to edit a deleted message
      const editRes = await request(app)
        .patch(`/api/v1/messages/${msgId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ ciphertext: 'should-not-work' })
        .expect('Content-Type', /json/);

      // Should be rejected — typically 400 or 404
      expect([400, 403, 404]).toContain(editRes.status);
    },
  );

  conditionalIt(
    'should include both sent and received messages in conversation history',
    async () => {
      // Alice sends a message
      const aliceRes = await sendTestMessage(aliceToken, conversationId, {
        ciphertext: 'alice-message-cipher',
      });
      expect(aliceRes.status).toBe(201);

      // Bob sends a message
      const bobRes = await sendTestMessage(bobToken, conversationId, {
        ciphertext: 'bob-message-cipher',
      });
      expect(bobRes.status).toBe(201);

      // Alice fetches history — should see both messages
      const historyRes = await request(app)
        .get(`/api/v1/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const messages = (historyRes.body as { data: MessageResponse[] }).data;
      expect(messages.length).toBeGreaterThanOrEqual(2);

      const senderIds = messages.map((m: MessageResponse) => m.senderId);
      expect(senderIds).toContain(aliceId);
      expect(senderIds).toContain(bobId);
    },
  );
});
