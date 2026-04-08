/**
 * @module server
 * @description Composition Root — DI Wiring, Environment Validation, and Bootstrap
 *
 * This is the single composition root for the Kalle backend. It is the ONLY
 * module that imports concrete repository and provider classes (Rule R17).
 * All other modules import and depend on interfaces only.
 *
 * Responsibilities:
 * 1. Validate all required environment variables (fail-fast — Rule R26)
 * 2. Construct infrastructure clients (Prisma, Redis)
 * 3. Instantiate repositories (concrete implementations of domain interfaces)
 * 4. Instantiate providers (concrete implementations of provider interfaces)
 * 5. Instantiate services (injected with interface-typed dependencies — Rule R16)
 * 6. Instantiate controllers (thin delegation layer — Rule R16)
 * 7. Build the Express v1 router tree (all routes under /api/v1/ — Rule R30)
 * 8. Create the Express app via app factory with full middleware chain
 * 9. Create the HTTP server, Socket.IO server with Redis adapter
 * 10. Register WebSocket event handlers for real-time messaging
 * 11. Start the server and register graceful shutdown handlers
 *
 * Architecture Rules Enforced:
 * - R16 (OOD Layering): Controllers → Services → Repositories/Providers
 * - R17 (Interface-Driven DI): Only this file imports concrete classes
 * - R26 (Env Validation): Zod validation before ANY initialization
 * - R28 (Structured Logging): Pino only — zero console.log, zero console.error
 * - R29 (Correlation ID): Logger factory supports correlation ID injection
 * - R30 (API Versioning): All REST endpoints under /api/v1/
 * - R38 (Zero External Deps): No external service calls at boot time
 *
 * @example
 * ```bash
 * # Development
 * tsx src/server.ts
 *
 * # Production
 * node dist/server.js
 * ```
 */

// ─── External Imports ──────────────────────────────────────────────────────────
import http from 'http';
import { randomUUID } from 'crypto';
import pinoHttp from 'pino-http';
import pino from 'pino';

// ─── Internal Configuration Imports ────────────────────────────────────────────
import { validateEnv } from './config/env';
import type { EnvConfig } from './config/env';
import { createPrismaClient } from './config/database';
import { Prisma } from '@prisma/client';
import { createRedisClient } from './config/redis';
import { getCorsOptions } from './config/cors';

// ─── App Factory Import ────────────────────────────────────────────────────────
import { createApp } from './app';

// ─── Middleware Imports ────────────────────────────────────────────────────────
import { configureRedisStore } from './middleware/rate-limiter';

// ─── Repository Imports (Concrete Classes — Rule R17: ONLY imported here) ──────
import { UserRepository } from './repositories/UserRepository';
import { ConversationRepository } from './repositories/ConversationRepository';
import { MessageRepository } from './repositories/MessageRepository';
import { MediaRepository } from './repositories/MediaRepository';
import { StoryRepository } from './repositories/StoryRepository';
import { KeyRepository } from './repositories/KeyRepository';
import { AuditRepository } from './repositories/AuditRepository';
import { SessionRepository } from './repositories/SessionRepository';

// ─── Provider Imports (Concrete Classes — Rule R17: ONLY imported here) ────────
import { StorageProvider } from './providers/StorageProvider';
import { RealtimeProvider } from './providers/RealtimeProvider';
import { QueueProvider } from './providers/QueueProvider';
import { CacheProvider } from './providers/CacheProvider';
import { LoggerProvider } from './providers/LoggerProvider';

// ─── Service Imports ───────────────────────────────────────────────────────────
import { AuthService } from './services/AuthService';
import { UserService } from './services/UserService';
import { ConversationService } from './services/ConversationService';
import { MessageService } from './services/MessageService';
import { MediaService } from './services/MediaService';
import { StoryService } from './services/StoryService';
import { EncryptionKeyService } from './services/EncryptionKeyService';
import { AuditService } from './services/AuditService';
import { HealthService } from './services/HealthService';
import { MetricsService } from './services/MetricsService';

// ─── Controller Imports ────────────────────────────────────────────────────────
import { AuthController } from './controllers/AuthController';
import { UserController } from './controllers/UserController';
import { ConversationController } from './controllers/ConversationController';
import { MessageController } from './controllers/MessageController';
import { MediaController } from './controllers/MediaController';
import { StoryController } from './controllers/StoryController';
import { KeyController } from './controllers/KeyController';
import { HealthController } from './controllers/HealthController';

// ─── Route & WebSocket Imports ─────────────────────────────────────────────────
import { createV1Router } from './routes/v1/index';
import { setupWebSocket } from './websocket/index';

// ─── Process-Level Error Handlers ──────────────────────────────────────────────
// Registered BEFORE bootstrap so errors during initialization are caught.
// A minimal Pino instance is created here so even fatal crash handlers
// produce structured JSON output (R28 full compliance — Issue 1 fix).
// This logger has no redaction or advanced config — it is only used for
// process-level crash events where the main LoggerProvider may be unavailable.
const crashLogger = pino({ name: 'kalle-api-crash', level: 'fatal' });

process.on('unhandledRejection', (reason: unknown) => {
  crashLogger.fatal({ reason: reason instanceof Error ? reason.message : String(reason) }, 'Unhandled Rejection');
  process.exit(1);
});

process.on('uncaughtException', (error: Error) => {
  crashLogger.fatal({ err: error.message, stack: error.stack }, 'Uncaught Exception');
  process.exit(1);
});

/**
 * Bootstraps the entire Kalle API server.
 *
 * This function is the composition root — it validates the environment,
 * creates all infrastructure clients, wires all dependencies through
 * constructor injection, and starts the HTTP + WebSocket server.
 * Graceful shutdown handlers are registered for clean teardown on
 * SIGTERM/SIGINT signals.
 *
 * Execution order follows strict dependency layering (R16, R17):
 *   Environment → Logger → Infrastructure → Repositories → Providers
 *   → Services → Controllers → Router → App → HTTP Server → Socket.IO
 *   → WebSocket Handlers → Listen
 *
 * @throws {Error} If environment validation fails (R26) — includes ALL
 *   missing/invalid variables in the error message.
 * @throws {Error} If PostgreSQL or Redis connections cannot be established.
 */
async function bootstrap(): Promise<void> {
  // ─── Step 1: Environment Validation (Rule R26) ───────────────────────────
  // validateEnv() uses Zod to parse process.env. If ANY required variable is
  // missing or invalid, it throws immediately with a descriptive error listing
  // EVERY problem — the server will NOT start in a misconfigured state.
  const env: EnvConfig = validateEnv();

  // ─── Step 2: Logger Initialization (Rules R28, R29) ──────────────────────
  // LoggerProvider configures Pino with structured JSON output, ISO timestamps,
  // field-level redaction of sensitive data (Rule R23), and service tag for
  // multi-service log aggregation. All subsequent logging flows through Pino.
  const loggerProvider = new LoggerProvider(env.LOG_LEVEL || 'info');
  const logger = loggerProvider.createLogger('server');
  logger.info('Environment validated successfully');

  // ─── Step 3: Infrastructure Client Initialization ────────────────────────
  // Create and verify database and cache connections before any business
  // layer initialization. Both clients are shared across repositories and
  // providers through constructor injection.
  const prisma = createPrismaClient(env.DATABASE_URL);
  const redis = createRedisClient(env.REDIS_URL);

  // Verify PostgreSQL connectivity — fail fast if database is unreachable
  await prisma.$connect();
  logger.info('PostgreSQL connected');

  // Verify Redis connectivity — fail fast if Redis is unreachable
  await redis.ping();
  logger.info('Redis connected');

  // Configure Redis-backed rate limiting for horizontal scalability.
  // This replaces the default in-memory MemoryStore with a Redis-backed
  // store so that rate limit counters persist across server restarts and
  // are shared across multiple API instances behind a load balancer.
  configureRedisStore(redis);
  logger.info('Rate limiter configured with Redis store');

  // ─── Step 4: Repository Construction (Rule R17) ──────────────────────────
  // Each repository receives the Prisma client and implements a domain
  // interface (IUserRepository, IConversationRepository, etc.). This is
  // the ONLY file that instantiates concrete repository classes — all
  // other modules depend on interfaces only.
  const userRepository = new UserRepository(prisma);
  const conversationRepository = new ConversationRepository(prisma);
  const messageRepository = new MessageRepository(prisma);
  const mediaRepository = new MediaRepository(prisma);
  const storyRepository = new StoryRepository(prisma);
  const keyRepository = new KeyRepository(prisma);
  const auditRepository = new AuditRepository(prisma);
  const sessionRepository = new SessionRepository(prisma);

  // ─── Step 5: Provider Construction (Rule R17) ────────────────────────────
  // Each provider implements a provider interface (IStorageProvider,
  // ICacheProvider, IQueueProvider). Concrete classes are only instantiated
  // in this composition root.
  // Note: RealtimeProvider is created AFTER the HTTP server since Socket.IO
  // requires the http.Server instance for attachment.
  const storageProvider = new StorageProvider(env.UPLOAD_DIR || './uploads');
  const cacheProvider = new CacheProvider(redis);
  const queueProvider = new QueueProvider(
    redis,
    env.BULL_REDIS_URL || env.REDIS_URL,
  );

  // ─── Step 6: Service Construction (Rules R16, R17) ───────────────────────
  // Services encapsulate all business logic. They are injected with
  // interface-typed dependencies only (not concrete classes). The service
  // layer never imports Prisma, Redis, or any database driver directly.

  // AuditService is constructed first — it is a foundational dependency
  // injected into multiple other services for immutable audit trail
  // recording of security-sensitive actions (Rule R32).
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

  const mediaService = new MediaService(mediaRepository, storageProvider);
  const storyService = new StoryService(storyRepository, storageProvider, conversationRepository);
  const encryptionKeyService = new EncryptionKeyService(keyRepository, auditService);

  // HealthService depends on IDatabaseClient and IRedisClient interfaces.
  // PrismaClient and ioredis Redis both satisfy these interfaces, so they
  // are passed directly — the HealthService never imports concrete types.
  const healthService = new HealthService(prisma, redis);

  // MetricsService is self-contained — it initializes the OpenTelemetry
  // SDK internally with zero constructor dependencies (Rule R37).
  const metricsService = new MetricsService();

  // ─── Step 6b: Observability Wiring (Rule R37) ────────────────────────────
  // Wire Prisma query events → MetricsService.recordDbQuery() so that
  // db_query_duration_seconds metrics appear in Prometheus output.
  // Prisma emits 'query' events because createPrismaClient() configures
  // log: [{ emit: 'event', level: 'query' }].
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma $on generic requires log config type parameter
  (prisma as any).$on('query', (e: Prisma.QueryEvent) => {
    // Extract the SQL operation type from the query string (e.g., SELECT, INSERT)
    const operationMatch = e.query.match(/^\s*(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)/i);
    const operation = operationMatch ? operationMatch[1].toLowerCase() : 'unknown';
    metricsService.recordDbQuery({ operation, durationMs: e.duration });
  });

  // Wire BullMQ job enqueue metrics → MetricsService so that
  // bullmq_jobs_total and bullmq_queue_depth appear in Prometheus output.
  queueProvider.setMetricsService(metricsService);

  // ─── Step 7: Controller Construction (Rule R16) ──────────────────────────
  // Controllers are thin delegation layers: parse request → validate input
  // via Zod (Rule R31) → call service method → format response. They
  // contain zero business logic.
  const authController = new AuthController(authService);
  const userController = new UserController(userService);
  const conversationController = new ConversationController(conversationService);
  const messageController = new MessageController(messageService);
  const mediaController = new MediaController(mediaService);
  const storyController = new StoryController(storyService);
  const keyController = new KeyController(encryptionKeyService);
  const healthController = new HealthController(healthService, metricsService);

  // ─── Step 8: v1 Router Construction (Rule R30) ───────────────────────────
  // Aggregates all v1 route modules under the /api/v1/ prefix. The factory
  // creates the JWT auth middleware internally from jwtSecret and cacheProvider,
  // then mounts each controller's routes on the appropriate sub-paths.
  const v1Router = createV1Router({
    authController,
    userController,
    conversationController,
    messageController,
    mediaController,
    storyController,
    keyController,
    healthController,
    authService,
    cacheProvider,
    jwtSecret: env.JWT_SECRET,
  });

  // ─── Step 9: Pino HTTP Middleware (Rules R28, R23) ───────────────────────
  // Integrates Pino structured logging into the Express request/response
  // cycle. Uses a named child logger from LoggerProvider to tag all HTTP
  // log entries with component: 'http'. The underlying logger's redaction
  // config (from LoggerProvider) ensures authorization headers, tokens,
  // and other sensitive fields are never logged (Rule R23).
  // -----------------------------------------------------------------------
  // Sensitive query parameter redaction for request URL logging (R23).
  // Tokens passed in URL query strings (e.g., ?token=eyJ...) must be
  // redacted from log entries even though the application correctly
  // rejects query-string authentication. The standard pino-http req
  // serializer logs req.url verbatim — this custom serializer strips
  // known sensitive parameter values before the URL reaches the log.
  // -----------------------------------------------------------------------
  const SENSITIVE_QUERY_PARAMS = new Set([
    'token',
    'access_token',
    'refresh_token',
    'api_key',
    'apikey',
    'secret',
    'password',
    'jwt',
    'authorization',
  ]);

  /**
   * Redact sensitive query parameter values from a URL string.
   *
   * Replaces the *values* of parameters whose names (case-insensitive)
   * appear in `SENSITIVE_QUERY_PARAMS` with `[REDACTED]`.  Parameter
   * names are preserved so operators can still observe which parameter
   * was sent.
   *
   * @example
   *   redactSensitiveQueryParams('/api/v1/users/me?token=eyJhb...&page=1')
   *   // → '/api/v1/users/me?token=[REDACTED]&page=1'
   */
  const redactSensitiveQueryParams = (url: string | undefined): string | undefined => {
    if (!url || !url.includes('?')) return url;
    try {
      const [pathname, queryString] = url.split('?', 2);
      if (!queryString) return url;
      const params = new URLSearchParams(queryString);
      let redacted = false;
      for (const key of params.keys()) {
        if (SENSITIVE_QUERY_PARAMS.has(key.toLowerCase())) {
          params.set(key, '[REDACTED]');
          redacted = true;
        }
      }
      return redacted ? `${pathname}?${params.toString()}` : url;
    } catch {
      // If URL parsing fails, return the original URL rather than
      // breaking the logging pipeline.
      return url;
    }
  };

  const pinoHttpMiddleware = pinoHttp({
    logger: loggerProvider.createLogger('http'),
    autoLogging: true,
    // R29 Fix (Issue 2): Use the correlation ID assigned by the correlation-id
    // middleware as the pino-http request ID so it appears top-level in every
    // "request completed" log entry (as `req.id`). Falls back to a new UUID
    // for edge cases where the correlation-id middleware has not yet run.
    genReqId: (req) =>
      (req as unknown as { correlationId?: string }).correlationId || randomUUID(),
    customLogLevel: (_req, res, err) => {
      if (res.statusCode >= 500 || err) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (raw: Record<string, unknown>) => {
        // Custom req serializer that redacts sensitive query parameters
        // from the URL field before logging (R23: log hygiene).
        // Builds a clean serialized object mirroring pino-http defaults
        // while ensuring tokens in query strings are never persisted.
        const req = raw as unknown as {
          id?: string;
          method?: string;
          url?: string;
          headers?: Record<string, string>;
          remoteAddress?: string;
          remotePort?: number;
        };
        return {
          id: req.id,
          method: req.method,
          url: redactSensitiveQueryParams(req.url),
          remoteAddress: req.remoteAddress,
          remotePort: req.remotePort,
        };
      },
    },
  });

  // ─── Step 10: Express App Creation ───────────────────────────────────────
  // createApp() builds the complete Express middleware chain in order:
  // CORS → Helmet → Compression → Correlation ID → Pino HTTP Logging →
  // Rate Limiting → Body Parsing → v1 Router → 404 Handler → Error Handler
  const corsOptions = getCorsOptions(env.CORS_ORIGIN);
  const app = createApp({
    corsOptions,
    v1Router,
    pinoHttpMiddleware: pinoHttpMiddleware as unknown as import('express').RequestHandler,
    metricsService,
  });

  // ─── Step 11: HTTP Server + Socket.IO Setup ──────────────────────────────
  // The HTTP server underlies both Express and Socket.IO. RealtimeProvider
  // creates the Socket.IO server and configures the Redis adapter for
  // horizontal scaling across multiple server instances.
  const httpServer = http.createServer(app);

  // RealtimeProvider constructor takes http.Server, Redis client, and
  // an env subset containing REDIS_URL and CORS_ORIGIN for Socket.IO
  // CORS and Redis adapter configuration.
  const realtimeProvider = new RealtimeProvider(httpServer, redis, {
    REDIS_URL: env.REDIS_URL,
    CORS_ORIGIN: env.CORS_ORIGIN,
  });
  await realtimeProvider.initialize();
  logger.info('Socket.IO server initialized with Redis adapter');

  // ─── Step 12: WebSocket Event Handler Registration ───────────────────────
  // Registers all Socket.IO event handlers for real-time messaging,
  // typing indicators (3s debounce, 5s expiry), presence tracking
  // (online/offline/last-seen), and offline sync (message:sync protocol).
  const wsLogger = loggerProvider.createLogger('websocket');
  setupWebSocket(realtimeProvider, {
    messageService,
    conversationService,
    userService,
    authService,
    cacheProvider,
    metricsService,
    logger: wsLogger,
    jwtSecret: env.JWT_SECRET,
  });
  logger.info('WebSocket event handlers registered');

  // ─── Step 12b: Schedule Repeating BullMQ Cron Jobs (R11, R35) ───────────
  // Register cron-based recurring jobs:
  //  - story-cleanup: runs every hour to purge expired stories and their media
  //  - audit-log-cleanup: runs weekly (Sunday midnight) to purge audit logs
  //    older than 90 days
  // Both jobs are added to the default BullMQ queue and processed by the
  // unified worker. BullMQ deduplicates repeating jobs, so calling
  // scheduleRepeat on restart is safe — only one instance per cron pattern
  // will ever be active.
  await queueProvider.scheduleRepeat('story-cleanup', {}, '0 * * * *');
  logger.info('Scheduled story-cleanup cron job (hourly)');

  await queueProvider.scheduleRepeat('audit-log-cleanup', {}, '0 0 * * 0');
  logger.info('Scheduled audit-log-cleanup cron job (weekly, Sunday midnight)');

  // ─── Step 13: Graceful Shutdown ──────────────────────────────────────────
  // SIGTERM (container orchestrator) and SIGINT (Ctrl+C) trigger a clean
  // teardown sequence: stop accepting connections → close WebSocket →
  // drain job queues → disconnect Redis → disconnect PostgreSQL.
  // This prevents data corruption, in-flight request loss, and resource leaks.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Received shutdown signal, closing gracefully...');

    // Step 1: Stop accepting new HTTP connections and let in-flight
    // requests finish within the server's keep-alive timeout.
    httpServer.close();

    // Step 2: Close Socket.IO server, disconnect all WebSocket clients,
    // and tear down the Redis adapter pub/sub connections.
    await realtimeProvider.close();

    // Step 3: Close BullMQ producer queues (no more job enqueuing).
    await queueProvider.close();

    // Step 4: Disconnect the Redis client (cache, presence, JWT blacklist).
    await redis.quit();

    // Step 5: Disconnect Prisma ORM / PostgreSQL connection pool.
    await prisma.$disconnect();

    logger.info('All connections closed. Exiting.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ─── Step 14: Start Listening ────────────────────────────────────────────
  // Port is configurable via API_PORT env var (validated as a number by Zod),
  // defaulting to 3001 for local development with Docker Compose.
  const port = env.API_PORT || 3001;
  httpServer.listen(port, () => {
    logger.info({ port }, `Kalle API server listening on port ${port}`);
  });
}

// ─── Entry Point ─────────────────────────────────────────────────────────────
// Invoke bootstrap. If ANY step fails (env validation, DB connection, Redis
// connection, provider initialization, etc.), the error is caught and the
// process exits with status 1. crashLogger (minimal Pino) is used so that
// even fatal bootstrap errors produce structured JSON output (R28 full compliance).
bootstrap().catch((err: unknown) => {
  crashLogger.fatal(
    { err: err instanceof Error ? err.message : String(err) },
    'Fatal error during bootstrap',
  );
  process.exit(1);
});
