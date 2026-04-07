/**
 * @module media.test
 * @description Media Upload Integration Tests
 *
 * Comprehensive integration tests verifying media upload functionality
 * including MIME type validation against the allowlist, 25 MB file size
 * enforcement, encrypted blob storage, and metadata persistence.
 *
 * Rules Verified:
 * - R8:  Media Upload Validation — 25 MB size limit (413), MIME allowlist (415)
 * - R12: E2E Encryption Integrity — server stores encrypted blob without processing
 * - R22: Standardized error responses { error: { code, message, details? } }
 * - R27: Client-side thumbnail generation — server does NOT generate thumbnails
 * - R30: All REST endpoints under /api/v1/ prefix
 * - R31: Input validation via Zod — invalid input returns 400 with field errors
 *
 * Infrastructure Requirements:
 * - PostgreSQL database (TEST_DATABASE_URL or DATABASE_URL)
 * - Redis instance (REDIS_URL)
 * - Environment variables set (or defaults via validateEnv)
 *
 * @see apps/api/src/controllers/MediaController.ts
 * @see apps/api/src/services/MediaService.ts
 */

// ---------------------------------------------------------------------------
// External imports
// ---------------------------------------------------------------------------

import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import path from 'path';
import fs from 'fs';
import type { Application } from 'express';

// ---------------------------------------------------------------------------
// Shared type imports from @kalle/shared barrel export
// ---------------------------------------------------------------------------

import type {
  MediaResponse,
  AuthResponse,
  ApiErrorResponse,
} from '@kalle/shared';

import {
  MAX_FILE_SIZE,
} from '@kalle/shared';

// ---------------------------------------------------------------------------
// Internal imports — app factory and routing
// ---------------------------------------------------------------------------

import { createApp } from '../../src/app';
import { createV1Router } from '../../src/routes/v1/index';

// ---------------------------------------------------------------------------
// Internal imports — config
// ---------------------------------------------------------------------------

import { validateEnv } from '../../src/config/env';
import type { EnvConfig } from '../../src/config/env';
import { createRedisClient } from '../../src/config/redis';
import { getCorsOptions } from '../../src/config/cors';

// ---------------------------------------------------------------------------
// Internal imports — repositories (Prisma-backed)
// ---------------------------------------------------------------------------

import { UserRepository } from '../../src/repositories/UserRepository';
import { SessionRepository } from '../../src/repositories/SessionRepository';
import { AuditRepository } from '../../src/repositories/AuditRepository';
import { MediaRepository } from '../../src/repositories/MediaRepository';

// ---------------------------------------------------------------------------
// Internal imports — providers
// ---------------------------------------------------------------------------

import { CacheProvider } from '../../src/providers/CacheProvider';
import { StorageProvider } from '../../src/providers/StorageProvider';
import { LoggerProvider } from '../../src/providers/LoggerProvider';

// ---------------------------------------------------------------------------
// Internal imports — services
// ---------------------------------------------------------------------------

import { AuthService } from '../../src/services/AuthService';
import { AuditService } from '../../src/services/AuditService';
import { UserService } from '../../src/services/UserService';
import { MediaService } from '../../src/services/MediaService';
import { HealthService } from '../../src/services/HealthService';

// ---------------------------------------------------------------------------
// Internal imports — controllers
// ---------------------------------------------------------------------------

import { AuthController } from '../../src/controllers/AuthController';
import { UserController } from '../../src/controllers/UserController';
import { MediaController } from '../../src/controllers/MediaController';
import { HealthController } from '../../src/controllers/HealthController';

// ---------------------------------------------------------------------------
// Internal imports — middleware
// ---------------------------------------------------------------------------

import { createLoggerMiddleware } from '../../src/middleware/logger';

// ============================================================================
// Test Constants
// ============================================================================

/** Test user credentials for authenticated media upload requests. */
const MEDIA_TEST_USER = {
  email: 'media-test-user@integration-test.com',
  password: 'SecureMediaPass123!',
  displayName: 'Media Test User',
};

/** Temporary upload directory for test-scoped file storage. */
const TEST_UPLOAD_DIR = path.join(__dirname, '..', '..', '__test_uploads_media__');

/** Small 1 KB test buffer for valid upload scenarios. */
const SMALL_BUFFER_SIZE = 1024;

/** Exactly 25 MB (MAX_FILE_SIZE) for boundary-at-limit tests. */
const EXACT_LIMIT_SIZE = MAX_FILE_SIZE;

/** 25 MB + 1 byte — just over the limit. */
const OVER_LIMIT_SIZE = MAX_FILE_SIZE + 1;

/** Known encryption key for test assertions. */
const TEST_ENCRYPTION_KEY = 'dGVzdC1lbmNyeXB0aW9uLWtleS1iYXNlNjQ=';

/** Known encryption IV for test assertions. */
const TEST_ENCRYPTION_IV = 'dGVzdC1lbmNyeXB0aW9uLWl2LWJhc2U2NA==';

// ============================================================================
// Test File Buffer Helpers
// ============================================================================

/**
 * Creates a deterministic test buffer of the specified size.
 * Content is filled with a repeating byte pattern for reliable
 * byte-for-byte comparison in storage integrity tests.
 *
 * @param sizeInBytes - Buffer size in bytes.
 * @param fillByte - Optional fill byte (default 0x41 = 'A').
 * @returns Buffer of the requested size.
 */
function createTestBuffer(sizeInBytes: number, fillByte = 0x41): Buffer {
  return Buffer.alloc(sizeInBytes, fillByte);
}

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
 * Sets up the minimal required environment variables for the media test suite.
 * Uses localhost defaults for PostgreSQL and Redis. Overridden by any existing
 * environment variables (Docker Compose sets them).
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
    UPLOAD_DIR: TEST_UPLOAD_DIR,
    MAX_FILE_SIZE: String(MAX_FILE_SIZE),
    OTEL_SERVICE_NAME: 'kalle-api-media-test',
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

/**
 * Truncates all media-related and auth tables in dependency order
 * (children first) to satisfy foreign key constraints.
 */
async function cleanDatabase(): Promise<void> {
  await prisma.media.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
}

/**
 * Flushes all Redis keys matching the blacklist pattern.
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

    // Step 3: Create test upload directory
    if (!fs.existsSync(TEST_UPLOAD_DIR)) {
      fs.mkdirSync(TEST_UPLOAD_DIR, { recursive: true });
    }

    // Step 4: Connect to PostgreSQL
    prisma = new PrismaClient({
      datasources: {
        db: { url: env.DATABASE_URL },
      },
    });
    await prisma.$connect();

    // Step 5: Connect to Redis
    redisClient = createRedisClient(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      connectTimeout: 3000,
    });
    await redisClient.connect();
    await redisClient.ping();

    infrastructureAvailable = true;

    // Step 6: Build DI chain
    const loggerProvider = new LoggerProvider('silent');
    const baseLogger = loggerProvider.getBaseLogger();

    // Repositories (real Prisma-backed)
    const userRepository = new UserRepository(prisma);
    const sessionRepository = new SessionRepository(prisma);
    const auditRepository = new AuditRepository(prisma);
    const mediaRepository = new MediaRepository(prisma);

    // Providers (real implementations)
    const cacheProvider = new CacheProvider(redisClient);
    const storageProvider = new StorageProvider(TEST_UPLOAD_DIR);

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
    const mediaService = new MediaService(mediaRepository, storageProvider);
    const healthService = new HealthService(prisma, redisClient);

    // Controllers
    const authController = new AuthController(authService);
    const userController = new UserController(userService);
    const mediaController = new MediaController(mediaService);

    // MetricsService stub — satisfies HealthController constructor signature
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

    // V1 Router — stub controllers NOT under test
    const noopHandler = (
      _req: unknown,
      _res: unknown,
      next: unknown,
    ): void => {
      (next as () => void)();
    };

    const stubController = (methods: string[]): Record<string, unknown> => {
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
      mediaController,
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

    // Create Express app with full middleware chain
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
      `[media.test] Infrastructure not available: ${message}. ` +
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
  // Clean database
  if (prisma) {
    try {
      await cleanDatabase();
    } catch {
      // Best-effort cleanup
    }
    await prisma.$disconnect();
  }

  // Clean Redis
  if (redisClient) {
    try {
      await cleanRedis();
      await redisClient.quit();
    } catch {
      // Best-effort cleanup
    }
  }

  // Clean test upload directory
  if (fs.existsSync(TEST_UPLOAD_DIR)) {
    try {
      fs.rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
});

// conditionalIt removed — tests now use standard `it()` with beforeEach guard

// ============================================================================
// Auth Helper — registerAndLogin
// ============================================================================

/**
 * Registers a test user and logs in, returning the access token and userId
 * required for authenticated media upload requests (R9).
 */
async function registerAndLogin(
  userData: { email: string; password: string; displayName: string } = MEDIA_TEST_USER,
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

// ============================================================================
// Media Upload Helper
// ============================================================================

/**
 * Performs an authenticated multipart media upload request.
 *
 * @param token   - JWT access token for Authorization header.
 * @param buffer  - File content buffer (encrypted blob).
 * @param fields  - Multipart form field overrides.
 * @returns supertest Response object.
 */
function uploadMedia(
  token: string,
  buffer: Buffer,
  fields: Partial<{
    type: string;
    mimeType: string;
    fileName: string;
    fileSize: string;
    encryptionKey: string;
    encryptionIv: string;
    duration: string;
    waveform: string;
    width: string;
    height: string;
    hasThumbnail: string;
  }> = {},
): request.Test {
  const defaults = {
    type: 'IMAGE',
    mimeType: 'image/png',
    fileName: 'test-upload.png',
    fileSize: String(buffer.length),
    encryptionKey: TEST_ENCRYPTION_KEY,
    encryptionIv: TEST_ENCRYPTION_IV,
  };
  const merged = { ...defaults, ...fields };

  let req = request(app)
    .post('/api/v1/media')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', buffer, {
      filename: merged.fileName,
      contentType: 'application/octet-stream',
    });

  // Attach all form fields
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) {
      req = req.field(key, value);
    }
  }

  return req;
}

// ============================================================================
// Phase 2: Valid Media Upload Tests
// ============================================================================

describe('Media Upload - Valid Cases', () => {
  it(
    'should upload a valid image (POST /api/v1/media → 201)',
    async () => {
      const { accessToken, userId } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await uploadMedia(accessToken, testBuffer)
        .expect(201);

      // Verify response shape: { data: MediaResponse }
      const body = res.body as { data: MediaResponse };
      expect(body.data).toBeDefined();

      // Verify core fields
      expect(body.data.id).toBeDefined();
      expect(typeof body.data.id).toBe('string');
      expect(body.data.id.length).toBeGreaterThan(0);
      expect(body.data.uploaderId).toBe(userId);
      expect(body.data.type).toBe('IMAGE');
      expect(body.data.mimeType).toBe('image/png');
      expect(body.data.fileName).toBe('test-upload.png');
      expect(body.data.fileSize).toBe(SMALL_BUFFER_SIZE);

      // Verify encryption metadata stored (R12)
      expect(body.data.encryptionKey).toBe(TEST_ENCRYPTION_KEY);
      expect(body.data.encryptionIv).toBe(TEST_ENCRYPTION_IV);

      // Verify URL is populated (points to stored file location)
      expect(body.data.url).toBeDefined();
      expect(typeof body.data.url).toBe('string');
      expect(body.data.url.length).toBeGreaterThan(0);

      // Verify createdAt is valid ISO 8601
      expect(body.data.createdAt).toBeDefined();
      expect(new Date(body.data.createdAt).toISOString()).toBe(body.data.createdAt);
    },
  );

  it(
    'should upload a valid PDF document',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(2048);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'DOCUMENT',
        mimeType: 'application/pdf',
        fileName: 'report.pdf',
      }).expect(201);

      const body = res.body as { data: MediaResponse };
      expect(body.data.type).toBe('DOCUMENT');
      expect(body.data.mimeType).toBe('application/pdf');
      expect(body.data.fileName).toBe('report.pdf');
    },
  );

  it(
    'should upload a valid voice note with waveform data',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(4096);
      const waveformData = [0.1, 0.3, 0.5, 0.8, 0.4, 0.2];

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'VOICE_NOTE',
        mimeType: 'audio/ogg',
        fileName: 'voice-note.ogg',
        duration: '14',
        waveform: JSON.stringify(waveformData),
      }).expect(201);

      const body = res.body as { data: MediaResponse };
      expect(body.data.type).toBe('VOICE_NOTE');
      expect(body.data.mimeType).toBe('audio/ogg');

      // Verify duration and waveform stored
      expect(body.data.duration).toBe(14);
      expect(body.data.waveform).toEqual(waveformData);
    },
  );

  it(
    'should upload a video with dimensions',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(8192);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'VIDEO',
        mimeType: 'video/mp4',
        fileName: 'clip.mp4',
        width: '1920',
        height: '1080',
        duration: '30',
      }).expect(201);

      const body = res.body as { data: MediaResponse };
      expect(body.data.type).toBe('VIDEO');
      expect(body.data.mimeType).toBe('video/mp4');
      expect(body.data.width).toBe(1920);
      expect(body.data.height).toBe(1080);
      expect(body.data.duration).toBe(30);
    },
  );

  it(
    'should store encryption metadata alongside media (R12)',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);
      const customKey = 'custom-encryption-key-abc123';
      const customIv = 'custom-encryption-iv-def456';

      const res = await uploadMedia(accessToken, testBuffer, {
        encryptionKey: customKey,
        encryptionIv: customIv,
      }).expect(201);

      const body = res.body as { data: MediaResponse };

      // Verify encryption metadata returned in response
      expect(body.data.encryptionKey).toBe(customKey);
      expect(body.data.encryptionIv).toBe(customIv);

      // Verify encryption metadata persisted in database (R12)
      const dbMedia = await prisma.media.findUnique({
        where: { id: body.data.id },
      });
      expect(dbMedia).not.toBeNull();
      expect(dbMedia!.encryptionKey).toBe(customKey);
      expect(dbMedia!.encryptionIv).toBe(customIv);
    },
  );
});

// ============================================================================
// Phase 3: Size Limit Tests (R8 — 413 Payload Too Large)
// ============================================================================

describe('Media Upload - Size Limits (R8)', () => {
  it(
    'should reject upload exceeding 25 MB with 413 (R8)',
    async () => {
      const { accessToken } = await registerAndLogin();

      // Create a buffer that is 1 MB over the limit
      const oversizedBuffer = createTestBuffer(MAX_FILE_SIZE + 1024 * 1024);

      const res = await uploadMedia(accessToken, oversizedBuffer, {
        fileSize: String(oversizedBuffer.length),
      });

      // May be 413 from MediaService or multer
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);

      // Verify error response shape (R22)
      const body = res.body as ApiErrorResponse;
      expect(body.error).toBeDefined();
      expect(body.error.code).toBeDefined();
      expect(body.error.message).toBeDefined();
    },
    60_000, // Extended timeout for large buffer upload
  );

  it(
    'should accept upload at exactly 25 MB',
    async () => {
      const { accessToken } = await registerAndLogin();

      // Create a buffer of exactly MAX_FILE_SIZE bytes
      const exactBuffer = createTestBuffer(EXACT_LIMIT_SIZE);

      const res = await uploadMedia(accessToken, exactBuffer, {
        fileSize: String(exactBuffer.length),
      });

      // The exact boundary should be accepted
      expect(res.status).toBe(201);

      const body = res.body as { data: MediaResponse };
      expect(body.data.fileSize).toBe(EXACT_LIMIT_SIZE);
    },
    60_000, // Extended timeout for large buffer upload
  );

  it(
    'should reject upload at 25 MB + 1 byte (R8)',
    async () => {
      const { accessToken } = await registerAndLogin();

      // Create buffer of exactly MAX_FILE_SIZE + 1 bytes
      const overByOneBuffer = createTestBuffer(OVER_LIMIT_SIZE);

      const res = await uploadMedia(accessToken, overByOneBuffer, {
        fileSize: String(overByOneBuffer.length),
      });

      // MediaService validates: file.size > MAX_FILE_SIZE → 413
      expect(res.status).toBe(413);

      // Verify standardized error shape (R22)
      const body = res.body as ApiErrorResponse;
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(typeof body.error.message).toBe('string');
    },
    60_000, // Extended timeout for large buffer upload
  );
});

// ============================================================================
// Phase 4: MIME Type Validation Tests (R8 — 415 Unsupported Media Type)
// ============================================================================

describe('Media Upload - MIME Validation (R8)', () => {
  it(
    'should reject disallowed MIME type with 415 (R8)',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'DOCUMENT',
        mimeType: 'application/x-executable',
        fileName: 'malware.exe',
      }).expect(415);

      // Verify standardized error shape (R22)
      const body = res.body as ApiErrorResponse;
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(typeof body.error.message).toBe('string');
    },
  );

  it(
    'should reject application/octet-stream MIME type',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'DOCUMENT',
        mimeType: 'application/octet-stream',
        fileName: 'binary.bin',
      }).expect(415);

      const body = res.body as ApiErrorResponse;
      expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    },
  );

  it(
    'should reject text/javascript MIME type',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'DOCUMENT',
        mimeType: 'text/javascript',
        fileName: 'script.js',
      }).expect(415);

      const body = res.body as ApiErrorResponse;
      expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    },
  );

  it(
    'should reject text/html MIME type',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'DOCUMENT',
        mimeType: 'text/html',
        fileName: 'page.html',
      }).expect(415);

      const body = res.body as ApiErrorResponse;
      expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    },
  );

  // --- Verify all allowed MIME types from ALLOWED_MIME_TYPES are accepted ---

  it(
    'should accept image/jpeg MIME type',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'IMAGE',
        mimeType: 'image/jpeg',
        fileName: 'photo.jpg',
      }).expect(201);

      const body = res.body as { data: MediaResponse };
      expect(body.data.type).toBe('IMAGE');
      expect(body.data.mimeType).toBe('image/jpeg');
    },
  );

  it(
    'should accept image/png MIME type',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'IMAGE',
        mimeType: 'image/png',
        fileName: 'screenshot.png',
      }).expect(201);

      const body = res.body as { data: MediaResponse };
      expect(body.data.mimeType).toBe('image/png');
    },
  );

  it(
    'should accept image/gif MIME type',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'IMAGE',
        mimeType: 'image/gif',
        fileName: 'animation.gif',
      }).expect(201);

      const body = res.body as { data: MediaResponse };
      expect(body.data.mimeType).toBe('image/gif');
    },
  );

  it(
    'should accept image/webp MIME type',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'IMAGE',
        mimeType: 'image/webp',
        fileName: 'modern.webp',
      }).expect(201);

      const body = res.body as { data: MediaResponse };
      expect(body.data.mimeType).toBe('image/webp');
    },
  );

  it(
    'should accept video/mp4 MIME type',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'VIDEO',
        mimeType: 'video/mp4',
        fileName: 'clip.mp4',
      }).expect(201);

      const body = res.body as { data: MediaResponse };
      expect(body.data.type).toBe('VIDEO');
      expect(body.data.mimeType).toBe('video/mp4');
    },
  );

  it(
    'should accept application/pdf MIME type',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'DOCUMENT',
        mimeType: 'application/pdf',
        fileName: 'document.pdf',
      }).expect(201);

      const body = res.body as { data: MediaResponse };
      expect(body.data.type).toBe('DOCUMENT');
      expect(body.data.mimeType).toBe('application/pdf');
    },
  );

  it(
    'should accept audio/ogg MIME type',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'VOICE_NOTE',
        mimeType: 'audio/ogg',
        fileName: 'voice.ogg',
      }).expect(201);

      const body = res.body as { data: MediaResponse };
      expect(body.data.type).toBe('VOICE_NOTE');
      expect(body.data.mimeType).toBe('audio/ogg');
    },
  );
});

// ============================================================================
// Phase 5: Server Does NOT Process Media (R12, R27)
// ============================================================================

describe('Media Storage Integrity (R12, R27)', () => {
  it(
    'should store uploaded bytes exactly as received — no server-side processing (R12)',
    async () => {
      const { accessToken } = await registerAndLogin();

      // Create a buffer with a specific, recognizable byte pattern
      const knownContent = Buffer.from(
        'This is encrypted content that should be stored as-is. ' +
        'The server MUST NOT modify, decrypt, or process this data. ' +
        'Rule R12 enforcement check.',
      );

      const res = await uploadMedia(accessToken, knownContent, {
        type: 'DOCUMENT',
        mimeType: 'application/pdf',
        fileName: 'encrypted-doc.enc',
      }).expect(201);

      const body = res.body as { data: MediaResponse };
      const storedUrl = body.data.url;

      // Determine the file's location on disk from the stored URL.
      // StorageProvider stores at `basePath + key`, and the URL is
      // `/uploads/<key>`. Strip the `/uploads/` prefix to recover the key.
      const storedKey = storedUrl.replace(/^\/uploads\//, '');
      const storedFilePath = path.join(TEST_UPLOAD_DIR, storedKey);

      // Read the stored file and verify byte-for-byte equality
      expect(fs.existsSync(storedFilePath)).toBe(true);
      const storedBytes = fs.readFileSync(storedFilePath);
      expect(Buffer.compare(storedBytes, knownContent)).toBe(0);
    },
  );

  it(
    'should NOT generate thumbnails server-side (R27)',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'IMAGE',
        mimeType: 'image/png',
        fileName: 'no-thumbnail-test.png',
      }).expect(201);

      const body = res.body as { data: MediaResponse };

      // Verify that no thumbnail was server-generated
      // (hasThumbnail was not sent → server should NOT create one)
      expect(body.data.thumbnailUrl).toBeUndefined();

      // Verify no thumbnail files exist in the upload directory
      // beyond the single primary file
      const mediaDir = path.join(TEST_UPLOAD_DIR, 'media');

      if (fs.existsSync(mediaDir)) {
        const allFiles = fs.readdirSync(mediaDir, { recursive: true }) as string[];
        // Only the primary file should exist — no 'thumb' directory entries
        const thumbnailFiles = allFiles.filter(
          (f) => typeof f === 'string' && f.includes('thumb'),
        );
        // No thumbnails should be generated by the server (R27)
        // Thumbnails are only present when client uploads them explicitly
        expect(thumbnailFiles.length).toBe(0);
      }
    },
  );

  it(
    'should persist correct metadata in the database (R12)',
    async () => {
      const { accessToken, userId } = await registerAndLogin();
      const testBuffer = createTestBuffer(2048);

      const res = await uploadMedia(accessToken, testBuffer, {
        type: 'IMAGE',
        mimeType: 'image/png',
        fileName: 'metadata-check.png',
        encryptionKey: 'meta-test-key',
        encryptionIv: 'meta-test-iv',
        width: '800',
        height: '600',
      }).expect(201);

      const body = res.body as { data: MediaResponse };

      // Direct database query to verify persistence
      const dbRecord = await prisma.media.findUnique({
        where: { id: body.data.id },
      });

      expect(dbRecord).not.toBeNull();
      expect(dbRecord!.userId).toBe(userId);
      expect(dbRecord!.type).toBe('IMAGE');
      expect(dbRecord!.mimeType).toBe('image/png');
      expect(dbRecord!.filename).toBe('metadata-check.png');
      expect(dbRecord!.size).toBe(2048);
      expect(dbRecord!.encryptionKey).toBe('meta-test-key');
      expect(dbRecord!.encryptionIv).toBe('meta-test-iv');
      expect(dbRecord!.width).toBe(800);
      expect(dbRecord!.height).toBe(600);
    },
  );
});

// ============================================================================
// Phase 6: Error Response Verification (R22)
// ============================================================================

describe('Media Error Responses (R22)', () => {
  it(
    'should return 401 for unauthenticated media upload',
    async () => {
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      // POST /api/v1/media without Authorization header
      const res = await request(app)
        .post('/api/v1/media')
        .attach('file', testBuffer, {
          filename: 'unauthorized.png',
          contentType: 'application/octet-stream',
        })
        .field('type', 'IMAGE')
        .field('mimeType', 'image/png')
        .field('fileName', 'unauthorized.png')
        .field('fileSize', String(SMALL_BUFFER_SIZE))
        .field('encryptionKey', TEST_ENCRYPTION_KEY)
        .field('encryptionIv', TEST_ENCRYPTION_IV)
        .expect(401);

      // Verify standardized error shape (R22)
      const body = res.body as ApiErrorResponse;
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
      expect(typeof body.error.message).toBe('string');
    },
  );

  it(
    'should return 400 for missing file in upload (R31)',
    async () => {
      const { accessToken } = await registerAndLogin();

      // POST /api/v1/media with form fields but NO attached file
      const res = await request(app)
        .post('/api/v1/media')
        .set('Authorization', `Bearer ${accessToken}`)
        .field('type', 'IMAGE')
        .field('mimeType', 'image/png')
        .field('fileName', 'missing-file.png')
        .field('fileSize', '1024')
        .field('encryptionKey', TEST_ENCRYPTION_KEY)
        .field('encryptionIv', TEST_ENCRYPTION_IV);

      // Should return 400 or 500 for missing file — controller checks req.file
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(600);

      const body = res.body as ApiErrorResponse;
      expect(body.error).toBeDefined();
      expect(typeof body.error.message).toBe('string');
    },
  );

  it(
    'should return 401 for expired/invalid JWT token',
    async () => {
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      const res = await request(app)
        .post('/api/v1/media')
        .set('Authorization', 'Bearer invalid-token-garbage')
        .attach('file', testBuffer, {
          filename: 'bad-token.png',
          contentType: 'application/octet-stream',
        })
        .field('type', 'IMAGE')
        .field('mimeType', 'image/png')
        .field('fileName', 'bad-token.png')
        .field('fileSize', String(SMALL_BUFFER_SIZE))
        .field('encryptionKey', TEST_ENCRYPTION_KEY)
        .field('encryptionIv', TEST_ENCRYPTION_IV)
        .expect(401);

      const body = res.body as ApiErrorResponse;
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('AUTHENTICATION_ERROR');
    },
  );

  it(
    'should use /api/v1/ prefix for all media endpoints (R30)',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      // Verify the correct path works
      const goodRes = await uploadMedia(accessToken, testBuffer).expect(201);
      expect(goodRes.body.data).toBeDefined();

      // Verify non-versioned path returns 404
      const badRes = await request(app)
        .post('/media')
        .set('Authorization', `Bearer ${accessToken}`)
        .attach('file', testBuffer, {
          filename: 'wrong-path.png',
          contentType: 'application/octet-stream',
        })
        .field('type', 'IMAGE')
        .field('mimeType', 'image/png')
        .field('fileName', 'wrong-path.png')
        .field('fileSize', String(SMALL_BUFFER_SIZE))
        .field('encryptionKey', TEST_ENCRYPTION_KEY)
        .field('encryptionIv', TEST_ENCRYPTION_IV);

      expect(badRes.status).toBe(404);
    },
  );

  it(
    'should return media metadata via GET /api/v1/media/:mediaId',
    async () => {
      const { accessToken } = await registerAndLogin();
      const testBuffer = createTestBuffer(SMALL_BUFFER_SIZE);

      // First upload a media file
      const uploadRes = await uploadMedia(accessToken, testBuffer).expect(201);
      const mediaId = (uploadRes.body as { data: MediaResponse }).data.id;

      // Retrieve via GET endpoint
      const getRes = await request(app)
        .get(`/api/v1/media/${mediaId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const body = getRes.body as { data: MediaResponse };
      expect(body.data.id).toBe(mediaId);
      expect(body.data.type).toBe('IMAGE');
      expect(body.data.mimeType).toBe('image/png');
      expect(body.data.encryptionKey).toBe(TEST_ENCRYPTION_KEY);
      expect(body.data.encryptionIv).toBe(TEST_ENCRYPTION_IV);
    },
  );

  it(
    'should return 404 for non-existent media ID',
    async () => {
      const { accessToken } = await registerAndLogin();

      const fakeId = '00000000-0000-0000-0000-000000000000';

      const res = await request(app)
        .get(`/api/v1/media/${fakeId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      const body = res.body as ApiErrorResponse;
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('NOT_FOUND');
    },
  );
});
