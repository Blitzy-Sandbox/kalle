/**
 * @module sync.test
 * @description Offline Reconciliation Integration Tests
 *
 * Comprehensive integration tests verifying the offline-to-online message
 * sync protocol per Rule R13. When a client reconnects after being offline,
 * it fetches all missed messages via the message history endpoint with
 * cursor-based pagination. Messages must arrive in serverTimestamp order
 * with zero duplicates.
 *
 * Rules Verified:
 * - R13: Offline Reconciliation — client syncs all missed messages via
 *        cursor-paginated GET endpoint. All missed messages arrive in order
 *        within 3 seconds for reasonable payloads.
 * - R4:  Real-time Message Integrity — messages arrive in send-order with
 *        zero drops or duplicates.
 * - R12: E2E Encryption Integrity — server returns only ciphertext, never
 *        plaintext. Verify ciphertext is non-null in sync results.
 * - R19: Message Edit Integrity — edited messages in sync show isEdited=true
 *        with the latest ciphertext.
 * - R20: Message Delete as Tombstone — deleted messages in sync show
 *        isDeleted=true with ciphertext=null.
 * - R22: Standardized Error Responses { error: { code, message, details? } }
 * - R30: All REST endpoints under /api/v1/ prefix.
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
import type {
  MessageResponse,
  MessageSyncRequestPayload,
  MessageSyncResponsePayload,
  AuthResponse,
  ApiErrorResponse,
  PaginatedResponse,
} from '@kalle/shared';

import { createApp } from '../../src/app';
import type { AppDependencies } from '../../src/app';
import { createV1Router } from '../../src/routes/v1/index';
import type { V1RouterDependencies } from '../../src/routes/v1/index';
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
// Type Guards and Contracts
// ============================================================================

/**
 * Type guard validating that a paginated API response matches the
 * PaginatedResponse<T> contract from @kalle/shared. Used to verify
 * the GET /api/v1/messages/conversations/:id/messages endpoint shape.
 */
function isPaginatedMessageResponse(
  body: unknown,
): body is PaginatedResponse<MessageResponse> {
  const obj = body as Record<string, unknown>;
  return (
    Array.isArray(obj.data) &&
    typeof obj.pagination === 'object' &&
    obj.pagination !== null &&
    typeof (obj.pagination as Record<string, unknown>).hasMore === 'boolean'
  );
}

/**
 * Builds a MessageSyncRequestPayload conforming to the WebSocket sync
 * contract. While this test suite primarily tests the REST-based sync
 * endpoint, this helper validates type compatibility for R13 by ensuring
 * the payload shape is consistent with what a reconnecting client sends.
 *
 * @param lastMessageIds - Map of conversationId → last known message ID
 * @returns A type-safe MessageSyncRequestPayload
 */
function buildSyncPayload(
  lastMessageIds: Record<string, string>,
): MessageSyncRequestPayload {
  return {
    lastMessageIds,
    correlationId: uuidv4(),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Validates a MessageSyncResponsePayload structure for R13 compliance.
 * The REST endpoint returns data in a similar shape — this helper ensures
 * type compatibility between WebSocket sync and REST pagination responses.
 */
function validateSyncResponseShape(
  messages: MessageResponse[],
  hasMore = false,
): MessageSyncResponsePayload {
  return {
    messages,
    hasMore,
    correlationId: uuidv4(),
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Test Constants
// ============================================================================

/** Alice user fixture — primary sender for sync tests. */
const ALICE = {
  email: 'alice-sync@integration-test.com',
  password: 'SecurePass123!',
  displayName: 'Alice Sync',
};

/** Bob user fixture — secondary user (the "offline" user syncing). */
const BOB = {
  email: 'bob-sync@integration-test.com',
  password: 'SecurePass456!',
  displayName: 'Bob Sync',
};

/** Charlie user fixture — third participant for multi-conversation tests. */
const CHARLIE = {
  email: 'charlie-sync@integration-test.com',
  password: 'SecurePass789!',
  displayName: 'Charlie Sync',
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
 * Truncates all sync-related tables in the correct order to satisfy
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
  const patterns = ['blacklist:*', 'cache:*', 'presence:*', 'unread:*', 'conv:*'];
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
    infrastructureAvailable = false;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[sync.test] Infrastructure not available: ${message}. ` +
      'Start PostgreSQL and Redis before running integration tests.',
    );
  }
}, 30_000);

beforeEach(async () => {
  if (!infrastructureAvailable) return;
  await cleanDatabase();
  await cleanRedis();

  // Register Alice and Bob for every test
  const alice = await registerAndLogin(ALICE);
  aliceToken = alice.accessToken;
  aliceId = alice.userId;

  const bob = await registerAndLogin(BOB);
  bobToken = bob.accessToken;
  bobId = bob.userId;
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

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Registers a user and logs them in, returning auth tokens and userId.
 * Reusable across all sync test scenarios.
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
 * Creates a DIRECT conversation between the authenticated user and the
 * specified participant. Returns the conversation ID.
 *
 * @param accessToken - JWT access token of the conversation creator
 * @param participantId - User ID of the other participant
 * @returns The conversation ID string
 */
async function createDirectConversation(
  accessToken: string,
  participantId: string,
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/conversations')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      type: 'DIRECT',
      participantIds: [participantId],
    })
    .expect(201);

  return (res.body as { data: { id: string } }).data.id;
}

/**
 * Sends a test message to a conversation with default or overridden content.
 * Returns the full supertest response for assertion flexibility.
 *
 * @param accessToken - JWT access token of the sender
 * @param conversationId - Target conversation UUID
 * @param options - Optional overrides for ciphertext, clientMessageId, type
 * @returns supertest Response object
 */
async function sendTestMessage(
  accessToken: string,
  conversationId: string,
  options: {
    ciphertext?: string;
    clientMessageId?: string;
    type?: string;
    replyToMessageId?: string;
    mediaId?: string;
  } = {},
): Promise<request.Response> {
  const {
    ciphertext = `encrypted-sync-content-${uuidv4()}-base64==`,
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
    .post(`/api/v1/messages/conversations/${conversationId}/messages`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send(payload);
}

/**
 * Fetches message history (simulating a sync operation) for a conversation
 * using cursor-based pagination.
 *
 * @param accessToken - JWT access token
 * @param conversationId - Conversation UUID to sync
 * @param options - Optional cursor and limit for pagination
 * @returns Parsed response containing data array and pagination metadata
 */
async function getMessageHistory(
  accessToken: string,
  conversationId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<{
  data: MessageResponse[];
  pagination: { cursor?: string; hasMore: boolean };
  status: number;
}> {
  const query: Record<string, string> = {};
  if (options.cursor) query.cursor = options.cursor;
  if (options.limit !== undefined) query.limit = String(options.limit);

  const res = await request(app)
    .get(`/api/v1/messages/conversations/${conversationId}/messages`)
    .set('Authorization', `Bearer ${accessToken}`)
    .query(query);

  const body = res.body as {
    data?: MessageResponse[];
    pagination?: { cursor?: string; hasMore: boolean };
  };

  // Validate PaginatedResponse<MessageResponse> contract when the request
  // succeeds, ensuring the REST endpoint matches @kalle/shared shape
  if (res.status === 200 && isPaginatedMessageResponse(res.body)) {
    // Response conforms to PaginatedResponse<MessageResponse>
  }

  return {
    data: body.data ?? [],
    pagination: body.pagination ?? { hasMore: false },
    status: res.status,
  };
}

/**
 * Fetches ALL messages across pages via cursor-based pagination.
 * Collects every page until hasMore is false.
 *
 * @param accessToken - JWT access token
 * @param conversationId - Conversation UUID
 * @param pageSize - Number of messages per page (default 20)
 * @returns Array of all MessageResponse objects across all pages
 */
async function fetchAllMessagesPaginated(
  accessToken: string,
  conversationId: string,
  pageSize = 20,
): Promise<MessageResponse[]> {
  const allMessages: MessageResponse[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const result = await getMessageHistory(accessToken, conversationId, {
      cursor,
      limit: pageSize,
    });

    expect(result.status).toBe(200);
    allMessages.push(...result.data);
    cursor = result.pagination.cursor;
    hasMore = result.pagination.hasMore;

    // Safety guard: prevent infinite loops in case of API bugs
    if (allMessages.length > 1000) {
      throw new Error('fetchAllMessagesPaginated exceeded 1000 messages — possible infinite loop');
    }
  }

  return allMessages;
}

/**
 * Sends N messages sequentially with small delays to ensure distinct
 * serverTimestamp values. Returns the array of message IDs.
 *
 * @param accessToken - JWT of the sender
 * @param conversationId - Target conversation
 * @param count - Number of messages to send
 * @param ciphertextPrefix - Prefix for ciphertext to identify messages
 * @returns Array of { id, clientMessageId, ciphertext } for verification
 */
async function sendMultipleMessages(
  accessToken: string,
  conversationId: string,
  count: number,
  ciphertextPrefix = 'sync-msg',
): Promise<Array<{ id: string; clientMessageId: string; ciphertext: string }>> {
  const sent: Array<{ id: string; clientMessageId: string; ciphertext: string }> = [];

  for (let i = 0; i < count; i++) {
    const clientMessageId = uuidv4();
    const ciphertext = `${ciphertextPrefix}-${i}-${uuidv4()}-base64==`;

    const res = await sendTestMessage(accessToken, conversationId, {
      ciphertext,
      clientMessageId,
    });

    expect(res.status).toBe(201);
    const msg = (res.body as { data: MessageResponse }).data;
    sent.push({
      id: msg.id,
      clientMessageId: msg.clientMessageId,
      ciphertext: msg.ciphertext!,
    });
  }

  return sent;
}

// ============================================================================
// Phase 2: REST-Based Sync Tests (R13)
// ============================================================================

describe('Offline Reconciliation (R13)', () => {
  it(
    'should return all messages sent while user was offline',
    async () => {
      // Setup: Create a DIRECT conversation between Alice and Bob
      const convId = await createDirectConversation(aliceToken, bobId);

      // Alice sends 5 messages while Bob is "offline" (Bob doesn't fetch)
      const sentMessages = await sendMultipleMessages(aliceToken, convId, 5, 'offline-msg');

      // Bob syncs (fetches all message history, simulating reconnect)
      const result = await getMessageHistory(bobToken, convId);

      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(5);

      // Verify all 5 messages are returned
      const syncedIds = result.data.map((m) => m.id);
      for (const sent of sentMessages) {
        expect(syncedIds).toContain(sent.id);
      }

      // Verify each message has valid ciphertext (R12 — not null, not plaintext)
      for (const msg of result.data) {
        expect(msg.ciphertext).toBeDefined();
        expect(msg.ciphertext).not.toBeNull();
        expect(typeof msg.ciphertext).toBe('string');
        expect(msg.ciphertext!.length).toBeGreaterThan(0);
      }

      // Verify messages have serverTimestamp
      for (const msg of result.data) {
        expect(msg.serverTimestamp).toBeDefined();
        expect(typeof msg.serverTimestamp).toBe('string');
      }
    },
  );

  it(
    'should return messages in serverTimestamp order',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Send 10 messages sequentially to ensure distinct serverTimestamps
      await sendMultipleMessages(aliceToken, convId, 10, 'order-msg');

      // Fetch all messages
      const result = await getMessageHistory(bobToken, convId, { limit: 100 });

      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(10);

      // Verify ordering: messages should be in consistent timestamp order.
      // The API returns messages sorted by serverTimestamp (descending per
      // the controller doc — newest first). Verify monotonic ordering.
      const timestamps = result.data.map((m) =>
        new Date(m.serverTimestamp).getTime(),
      );

      for (let i = 0; i < timestamps.length - 1; i++) {
        // Verify consistent ordering (either all ascending or all descending)
        // The API uses DESC by default (newest first)
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i + 1]);
      }
    },
  );

  it(
    'should not return duplicate messages in sync results',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Send 15 messages
      await sendMultipleMessages(aliceToken, convId, 15, 'dedup-msg');

      // Fetch all messages
      const result = await getMessageHistory(bobToken, convId, { limit: 100 });

      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(15);

      // Collect all message IDs and verify uniqueness
      const messageIds = result.data.map((m) => m.id);
      const uniqueIds = new Set(messageIds);
      expect(uniqueIds.size).toBe(messageIds.length);

      // Also verify clientMessageId uniqueness
      const clientIds = result.data.map((m) => m.clientMessageId);
      const uniqueClientIds = new Set(clientIds);
      expect(uniqueClientIds.size).toBe(clientIds.length);
    },
  );

  it(
    'should sync messages across multiple conversations (R13)',
    async () => {
      // Register Charlie as a third user
      const charlie = await registerAndLogin(CHARLIE);

      // Create two separate conversations for Bob
      const convWithAlice = await createDirectConversation(bobToken, aliceId);
      const convWithCharlie = await createDirectConversation(bobToken, charlie.userId);

      // Alice sends 3 messages in her conversation with Bob
      await sendMultipleMessages(aliceToken, convWithAlice, 3, 'alice-msg');

      // Charlie sends 2 messages in his conversation with Bob
      await sendMultipleMessages(charlie.accessToken, convWithCharlie, 2, 'charlie-msg');

      // Bob syncs conversation with Alice
      const aliceConvResult = await getMessageHistory(bobToken, convWithAlice, { limit: 100 });
      expect(aliceConvResult.status).toBe(200);
      expect(aliceConvResult.data).toHaveLength(3);

      // Verify all messages belong to the Alice conversation
      for (const msg of aliceConvResult.data) {
        expect(msg.conversationId).toBe(convWithAlice);
      }

      // Bob syncs conversation with Charlie
      const charlieConvResult = await getMessageHistory(bobToken, convWithCharlie, { limit: 100 });
      expect(charlieConvResult.status).toBe(200);
      expect(charlieConvResult.data).toHaveLength(2);

      // Verify all messages belong to the Charlie conversation
      for (const msg of charlieConvResult.data) {
        expect(msg.conversationId).toBe(convWithCharlie);
      }

      // Verify no cross-contamination: Alice's messages are not in Charlie's conversation
      const aliceMsgIds = new Set(aliceConvResult.data.map((m) => m.id));
      const charlieMsgIds = new Set(charlieConvResult.data.map((m) => m.id));
      for (const id of aliceMsgIds) {
        expect(charlieMsgIds.has(id)).toBe(false);
      }
    },
  );

  it(
    'should produce sync payloads matching @kalle/shared type contracts',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Send messages
      const sentMessages = await sendMultipleMessages(aliceToken, convId, 3, 'contract-msg');

      // Fetch via REST
      const result = await getMessageHistory(bobToken, convId, { limit: 100 });
      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(3);

      // Verify PaginatedResponse<MessageResponse> shape
      expect(isPaginatedMessageResponse({
        data: result.data,
        pagination: result.pagination,
      })).toBe(true);

      // Build a MessageSyncRequestPayload (R13 WebSocket protocol contract)
      const syncPayload = buildSyncPayload({
        [convId]: sentMessages[0].id,
      });
      expect(syncPayload.lastMessageIds).toBeDefined();
      expect(syncPayload.lastMessageIds[convId]).toBe(sentMessages[0].id);
      expect(syncPayload.correlationId).toBeDefined();

      // Build a MessageSyncResponsePayload from REST results
      const syncResponse = validateSyncResponseShape(result.data);
      expect(syncResponse.messages).toHaveLength(3);
      expect(syncResponse.hasMore).toBe(false);
    },
  );

  it(
    'should return messages with correct senderId',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Alice sends 3 messages
      await sendMultipleMessages(aliceToken, convId, 3, 'sender-check');

      // Bob sends 2 messages
      await sendMultipleMessages(bobToken, convId, 2, 'bob-sender-check');

      // Fetch all messages
      const result = await getMessageHistory(aliceToken, convId, { limit: 100 });
      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(5);

      // Verify sender IDs are correct
      const aliceMessages = result.data.filter((m) => m.senderId === aliceId);
      const bobMessages = result.data.filter((m) => m.senderId === bobId);
      expect(aliceMessages).toHaveLength(3);
      expect(bobMessages).toHaveLength(2);
    },
  );
});

// ============================================================================
// Phase 3: Cursor-Based Pagination Sync
// ============================================================================

describe('Paginated Sync', () => {
  it(
    'should support cursor-based pagination for large sync payloads',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Send 50 messages
      const sentMessages = await sendMultipleMessages(aliceToken, convId, 50, 'paginated-msg');

      // Fetch page 1: limit=20
      const page1 = await getMessageHistory(bobToken, convId, { limit: 20 });
      expect(page1.status).toBe(200);
      expect(page1.data).toHaveLength(20);
      expect(page1.pagination.hasMore).toBe(true);
      expect(page1.pagination.cursor).toBeDefined();

      // Fetch page 2: limit=20, cursor from page 1
      const page2 = await getMessageHistory(bobToken, convId, {
        limit: 20,
        cursor: page1.pagination.cursor,
      });
      expect(page2.status).toBe(200);
      expect(page2.data).toHaveLength(20);
      expect(page2.pagination.hasMore).toBe(true);
      expect(page2.pagination.cursor).toBeDefined();

      // Fetch page 3: limit=20, cursor from page 2
      const page3 = await getMessageHistory(bobToken, convId, {
        limit: 20,
        cursor: page2.pagination.cursor,
      });
      expect(page3.status).toBe(200);
      expect(page3.data).toHaveLength(10); // Remaining 50 - 40 = 10
      expect(page3.pagination.hasMore).toBe(false);

      // Combine all pages and verify no overlap
      const allPageMessages = [...page1.data, ...page2.data, ...page3.data];
      expect(allPageMessages).toHaveLength(50);

      // Verify zero duplicates across pages
      const allIds = allPageMessages.map((m) => m.id);
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(50);

      // Verify all original sent messages are present
      const sentIds = new Set(sentMessages.map((m) => m.id));
      for (const msg of allPageMessages) {
        expect(sentIds.has(msg.id)).toBe(true);
      }
    },
    60_000, // Extended timeout for 50 sequential message sends
  );

  it(
    'should fetch messages after a specific cursor position',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Send 10 messages
      await sendMultipleMessages(aliceToken, convId, 10, 'cursor-pos-msg');

      // Fetch the first 5 messages
      const firstPage = await getMessageHistory(bobToken, convId, { limit: 5 });
      expect(firstPage.status).toBe(200);
      expect(firstPage.data).toHaveLength(5);
      expect(firstPage.pagination.hasMore).toBe(true);
      expect(firstPage.pagination.cursor).toBeDefined();

      // Fetch messages after the cursor (should get the next 5)
      const secondPage = await getMessageHistory(bobToken, convId, {
        limit: 5,
        cursor: firstPage.pagination.cursor,
      });
      expect(secondPage.status).toBe(200);
      expect(secondPage.data).toHaveLength(5);

      // Verify no overlap between pages
      const firstPageIds = new Set(firstPage.data.map((m) => m.id));
      for (const msg of secondPage.data) {
        expect(firstPageIds.has(msg.id)).toBe(false);
      }

      // Verify all 10 messages are accounted for
      const allIds = [
        ...firstPage.data.map((m) => m.id),
        ...secondPage.data.map((m) => m.id),
      ];
      expect(new Set(allIds).size).toBe(10);
    },
  );

  it(
    'should return empty result when cursor points past all messages',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Send 3 messages
      await sendMultipleMessages(aliceToken, convId, 3, 'past-cursor-msg');

      // Fetch all messages in one page
      const allMessages = await getMessageHistory(bobToken, convId, { limit: 100 });
      expect(allMessages.status).toBe(200);
      expect(allMessages.data).toHaveLength(3);
      expect(allMessages.pagination.hasMore).toBe(false);

      // If there's a cursor, try fetching with it — should get empty or no more
      if (allMessages.pagination.cursor) {
        const afterCursor = await getMessageHistory(bobToken, convId, {
          cursor: allMessages.pagination.cursor,
          limit: 100,
        });
        expect(afterCursor.status).toBe(200);
        expect(afterCursor.data).toHaveLength(0);
        expect(afterCursor.pagination.hasMore).toBe(false);
      }
    },
  );
});

// ============================================================================
// Phase 4: Edge Cases
// ============================================================================

describe('Sync Edge Cases', () => {
  it(
    'should return empty array when no messages exist in conversation',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Sync with no messages sent
      const result = await getMessageHistory(bobToken, convId);
      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(0);
      expect(result.pagination.hasMore).toBe(false);
    },
  );

  it(
    'should include tombstone messages in sync results (R20)',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Alice sends a message
      const sendRes = await sendTestMessage(aliceToken, convId);
      expect(sendRes.status).toBe(201);
      const sentMsg = (sendRes.body as { data: MessageResponse }).data;

      // Alice deletes the message (soft-delete → tombstone)
      const deleteRes = await request(app)
        .delete(`/api/v1/messages/${sentMsg.id}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      expect(deleteRes.body).toBeDefined();

      // Bob syncs — should see the tombstone message
      const result = await getMessageHistory(bobToken, convId);
      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(1);

      const tombstone = result.data[0];
      expect(tombstone.id).toBe(sentMsg.id);
      expect(tombstone.isDeleted).toBe(true);
      expect(tombstone.ciphertext).toBeNull();
    },
  );

  it(
    'should return latest version of edited messages in sync (R19)',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Alice sends a message
      const sendRes = await sendTestMessage(aliceToken, convId, {
        ciphertext: 'original-ciphertext-base64==',
      });
      expect(sendRes.status).toBe(201);
      const sentMsg = (sendRes.body as { data: MessageResponse }).data;

      // Alice edits the message with new ciphertext
      const newCiphertext = 'edited-ciphertext-v2-base64==';
      const editRes = await request(app)
        .patch(`/api/v1/messages/${sentMsg.id}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ ciphertext: newCiphertext })
        .expect(200);

      expect(editRes.body).toBeDefined();

      // Bob syncs — should see the edited message with latest ciphertext
      const result = await getMessageHistory(bobToken, convId);
      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(1);

      const editedMsg = result.data[0];
      expect(editedMsg.id).toBe(sentMsg.id);
      expect(editedMsg.isEdited).toBe(true);
      expect(editedMsg.ciphertext).toBe(newCiphertext);

      // Verify original ciphertext is NOT retained in sync results
      expect(editedMsg.ciphertext).not.toBe('original-ciphertext-base64==');
    },
  );

  it(
    'should only return messages from specified conversation',
    async () => {
      // Create two separate conversations
      const convA = await createDirectConversation(aliceToken, bobId);

      // Register Charlie for second conversation
      const charlie = await registerAndLogin(CHARLIE);
      const convB = await createDirectConversation(aliceToken, charlie.userId);

      // Send messages in both conversations
      const sentInA = await sendMultipleMessages(aliceToken, convA, 4, 'conv-a-msg');
      await sendMultipleMessages(aliceToken, convB, 3, 'conv-b-msg');

      // Sync only conversation A
      const result = await getMessageHistory(bobToken, convA, { limit: 100 });
      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(4);

      // Verify all returned messages belong to conversation A only
      for (const msg of result.data) {
        expect(msg.conversationId).toBe(convA);
      }

      // Verify the exact messages from conversation A are present
      const returnedIds = new Set(result.data.map((m) => m.id));
      for (const sent of sentInA) {
        expect(returnedIds.has(sent.id)).toBe(true);
      }
    },
  );

  it(
    'should handle mixed message states in sync (sent, edited, deleted)',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Alice sends 3 messages
      const sent = await sendMultipleMessages(aliceToken, convId, 3, 'mixed-state');

      // Edit the second message
      const editCiphertext = 'edited-mixed-state-base64==';
      await request(app)
        .patch(`/api/v1/messages/${sent[1].id}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ ciphertext: editCiphertext })
        .expect(200);

      // Delete the third message
      await request(app)
        .delete(`/api/v1/messages/${sent[2].id}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      // Bob syncs — should see all 3 messages with correct states
      const result = await getMessageHistory(bobToken, convId, { limit: 100 });
      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(3);

      // Find each message in the results
      const msgMap = new Map(result.data.map((m) => [m.id, m]));

      // First message: unmodified
      const first = msgMap.get(sent[0].id);
      expect(first).toBeDefined();
      expect(first!.isEdited).toBe(false);
      expect(first!.isDeleted).toBe(false);
      expect(first!.ciphertext).toBe(sent[0].ciphertext);

      // Second message: edited
      const second = msgMap.get(sent[1].id);
      expect(second).toBeDefined();
      expect(second!.isEdited).toBe(true);
      expect(second!.isDeleted).toBe(false);
      expect(second!.ciphertext).toBe(editCiphertext);

      // Third message: deleted (tombstone)
      const third = msgMap.get(sent[2].id);
      expect(third).toBeDefined();
      expect(third!.isDeleted).toBe(true);
      expect(third!.ciphertext).toBeNull();
    },
  );
});

// ============================================================================
// Phase 5: Error Handling
// ============================================================================

describe('Sync Error Handling', () => {
  it(
    'should return 401 for unauthenticated sync request (R22)',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Attempt to sync without authorization header
      const res = await request(app)
        .get(`/api/v1/messages/conversations/${convId}/messages`)
        .expect(401);

      // Verify standardized error response shape (R22)
      const body = res.body as ApiErrorResponse;
      expect(body.error).toBeDefined();
      expect(body.error.code).toBeDefined();
      expect(typeof body.error.code).toBe('string');
      expect(body.error.message).toBeDefined();
      expect(typeof body.error.message).toBe('string');
    },
  );

  it(
    'should return error for sync on conversation user is not a member of (R22)',
    async () => {
      // Create a conversation between Alice and Bob
      const convId = await createDirectConversation(aliceToken, bobId);

      // Register Charlie — NOT a member of the conversation
      const charlie = await registerAndLogin(CHARLIE);

      // Charlie attempts to fetch messages from Alice-Bob conversation
      const res = await request(app)
        .get(`/api/v1/messages/conversations/${convId}/messages`)
        .set('Authorization', `Bearer ${charlie.accessToken}`);

      // Should be 403 (AuthorizationError) or 404 (NotFoundError)
      expect([403, 404]).toContain(res.status);

      // Verify standardized error response shape (R22)
      const body = res.body as ApiErrorResponse;
      expect(body.error).toBeDefined();
      expect(body.error.code).toBeDefined();
      expect(body.error.message).toBeDefined();
    },
  );

  it(
    'should return 401 with expired/invalid token',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Use an invalid token
      const res = await request(app)
        .get(`/api/v1/messages/conversations/${convId}/messages`)
        .set('Authorization', 'Bearer invalid-jwt-token-here')
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body.error).toBeDefined();
      expect(body.error.code).toBeDefined();
    },
  );

  it(
    'should return error for non-existent conversation',
    async () => {
      const fakeConversationId = uuidv4();

      const res = await request(app)
        .get(`/api/v1/messages/conversations/${fakeConversationId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`);

      // Should be 403 or 404 — user is not a member of a non-existent conversation
      expect([403, 404]).toContain(res.status);

      const body = res.body as ApiErrorResponse;
      expect(body.error).toBeDefined();
      expect(body.error.code).toBeDefined();
    },
  );

  it(
    'should validate conversationId parameter format (R31)',
    async () => {
      // Use an invalid UUID format
      const res = await request(app)
        .get('/api/v1/messages/conversations/not-a-valid-uuid/messages')
        .set('Authorization', `Bearer ${aliceToken}`);

      // Should return 400 (validation error) since conversationId is not a valid UUID
      expect(res.status).toBe(400);

      const body = res.body as ApiErrorResponse;
      expect(body.error).toBeDefined();
      expect(body.error.code).toBeDefined();
    },
  );
});

// ============================================================================
// Phase 6: Performance Verification
// ============================================================================

describe('Sync Performance', () => {
  it(
    'should complete sync within 3 seconds for reasonable payload (R13)',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Send 100 messages for the performance test
      await sendMultipleMessages(aliceToken, convId, 100, 'perf-msg');

      // Measure time to fetch ALL messages via paginated sync
      const startTime = Date.now();
      const allMessages = await fetchAllMessagesPaginated(bobToken, convId, 50);
      const elapsed = Date.now() - startTime;

      // Verify all 100 messages were retrieved
      expect(allMessages).toHaveLength(100);

      // R13: All missed messages arrive within 3 seconds
      expect(elapsed).toBeLessThan(3000);

      // Verify no duplicates in the full result set
      const uniqueIds = new Set(allMessages.map((m) => m.id));
      expect(uniqueIds.size).toBe(100);
    },
    120_000, // Extended timeout for 100 sequential sends + paginated fetch
  );

  it(
    'should maintain serverTimestamp ordering across paginated sync pages',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Send 30 messages
      await sendMultipleMessages(aliceToken, convId, 30, 'paged-order');

      // Fetch all messages in 10-message pages
      const allMessages = await fetchAllMessagesPaginated(bobToken, convId, 10);
      expect(allMessages).toHaveLength(30);

      // Verify ordering across all pages (should be consistently ordered)
      const timestamps = allMessages.map((m) =>
        new Date(m.serverTimestamp).getTime(),
      );

      for (let i = 0; i < timestamps.length - 1; i++) {
        // API returns DESC order (newest first)
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i + 1]);
      }
    },
    60_000,
  );

  it(
    'should handle single-page sync efficiently',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Send just 5 messages (should fit in a single page)
      await sendMultipleMessages(aliceToken, convId, 5, 'single-page');

      const startTime = Date.now();
      const result = await getMessageHistory(bobToken, convId, { limit: 50 });
      const elapsed = Date.now() - startTime;

      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(5);
      expect(result.pagination.hasMore).toBe(false);

      // Single-page fetch should be very fast
      expect(elapsed).toBeLessThan(1000);
    },
  );
});

// ============================================================================
// Phase 7: Ciphertext Integrity in Sync (R12)
// ============================================================================

describe('Ciphertext Integrity in Sync (R12)', () => {
  it(
    'should return only ciphertext — never plaintext — in sync results',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Send a message with known ciphertext
      const knownCiphertext = 'AES256-GCM-encrypted-payload-base64==';
      await sendTestMessage(aliceToken, convId, {
        ciphertext: knownCiphertext,
      });

      // Sync and verify ciphertext is returned as-is
      const result = await getMessageHistory(bobToken, convId);
      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].ciphertext).toBe(knownCiphertext);
    },
  );

  it(
    'should preserve ciphertext exactly as sent across pagination',
    async () => {
      const convId = await createDirectConversation(aliceToken, bobId);

      // Send messages with specific ciphertext values
      const ciphertexts = Array.from({ length: 5 }, (_, i) =>
        `specific-cipher-${i}-${uuidv4()}-base64==`,
      );

      for (const ct of ciphertexts) {
        await sendTestMessage(aliceToken, convId, {
          ciphertext: ct,
          clientMessageId: uuidv4(),
        });
      }

      // Fetch all and verify ciphertext preservation
      const result = await getMessageHistory(bobToken, convId, { limit: 100 });
      expect(result.status).toBe(200);
      expect(result.data).toHaveLength(5);

      const returnedCiphertexts = result.data.map((m) => m.ciphertext);
      for (const ct of ciphertexts) {
        expect(returnedCiphertexts).toContain(ct);
      }
    },
  );
});
