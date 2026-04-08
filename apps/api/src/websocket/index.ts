/**
 * @file apps/api/src/websocket/index.ts
 * @description Socket.IO Server Setup with Redis Adapter and Event Handler Registration
 *
 * This is the WebSocket server entry point. It exports a `setupWebSocket` function
 * that is called from the composition root (`server.ts`). This function:
 *  - Registers WebSocket middleware (authentication R9/R33, rate limiting R25)
 *  - Binds all event handlers (message, typing, presence, sync)
 *  - Configures room management for conversations
 *  - Integrates with the metrics service for connection tracking (R37)
 *
 * Architecture rules enforced:
 *  - R4  Real-time message integrity (send-order, zero drops/duplicates)
 *  - R12 E2E encryption integrity (server handles only ciphertext — zero decryption)
 *  - R13 Offline reconciliation via message:sync protocol
 *  - R17 Interface-driven DI — services received via composition root
 *  - R25 Per-connection WebSocket rate limiting
 *  - R28 Structured Pino JSON logging only — zero console.log calls
 *  - R29 Correlation ID propagation on every connection
 *  - R7  Zero-warnings TypeScript strict build
 */

// ---------------------------------------------------------------------------
// External imports
// ---------------------------------------------------------------------------
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import type { Socket } from 'socket.io';

// ---------------------------------------------------------------------------
// Shared type imports — Socket.IO generic type parameters
// ---------------------------------------------------------------------------
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
} from '@kalle/shared/types/websocket-events';

// ---------------------------------------------------------------------------
// WebSocket middleware imports
// ---------------------------------------------------------------------------
import { createWsAuthMiddleware } from './middleware/ws-auth';
import { createWsRateLimiter } from './middleware/ws-rate-limiter';

// ---------------------------------------------------------------------------
// WebSocket event handler imports
// ---------------------------------------------------------------------------
import { registerMessageHandlers } from './handlers/message-handler';
import { registerTypingHandlers } from './handlers/typing-handler';
import { registerPresenceHandlers } from './handlers/presence-handler';
import { registerSyncHandlers } from './handlers/sync-handler';

// ---------------------------------------------------------------------------
// Provider and service type imports (type-only for DI interface definition)
// ---------------------------------------------------------------------------
import type { RealtimeProvider } from '../providers/RealtimeProvider';
import type { MessageService } from '../services/MessageService';
import type { ConversationService } from '../services/ConversationService';
import type { UserService } from '../services/UserService';
import type { AuthService } from '../services/AuthService';
import type { ICacheProvider } from '../domain/interfaces/ICacheProvider';
import type { MetricsService } from '../services/MetricsService';
import type { Logger } from '../providers/LoggerProvider';

// ---------------------------------------------------------------------------
// Type alias for typed Socket.IO socket with shared event contracts
// ---------------------------------------------------------------------------

/**
 * Fully-typed Socket.IO socket using shared event type contracts.
 *
 * Used internally for type-safe event handling. Handlers receive the
 * unparameterised Socket type from socket.io to keep their dependency surface
 * small, and structural typing ensures compatibility.
 */
type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

// ---------------------------------------------------------------------------
// WebSocketServices — dependency bundle passed from composition root
// ---------------------------------------------------------------------------

/**
 * Typed dependency bundle injected into `setupWebSocket` from the composition
 * root (`server.ts`).
 *
 * Every service and provider is coded against its interface — this object
 * simply aggregates the concrete instances that the composition root wires
 * together (Rule R17).
 *
 * `jwtSecret` is required because `createWsAuthMiddleware` verifies JWTs
 * using the raw secret string (not via AuthService).  AuthService is still
 * included for potential future middleware needs and to satisfy the declared
 * schema contract.
 */
export interface WebSocketServices {
  /** Message send / edit / delete / status / sync operations */
  messageService: MessageService;

  /** Conversation list / membership / participant queries */
  conversationService: ConversationService;

  /** User profile / online-status updates */
  userService: UserService;

  /** Auth service reference — kept for interface contract compliance */
  authService: AuthService;

  /** Redis-backed cache for rate-limiting buckets, presence, typing TTLs */
  cacheProvider: ICacheProvider;

  /** Optional Prometheus-compatible metrics collector (R37) */
  metricsService?: MetricsService;

  /** Optional Pino structured logger with correlation ID support (R28) */
  logger?: Logger;

  /**
   * JWT signing / verification secret.
   *
   * Sourced from `env.JWT_SECRET` in the composition root.
   * Required by `createWsAuthMiddleware` for handshake token verification.
   */
  jwtSecret: string;
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of conversations to join on initial connection.
 * A generous upper-bound — most users will have far fewer active rooms.
 */
const MAX_CONVERSATION_ROOMS_ON_CONNECT = 1000;

// ---------------------------------------------------------------------------
// setupWebSocket — primary exported function
// ---------------------------------------------------------------------------

/**
 * Initialises the WebSocket layer on top of the Socket.IO server instance
 * managed by {@link RealtimeProvider}.
 *
 * Call once from the composition root (`server.ts`) after HTTP server creation:
 *
 * ```ts
 * setupWebSocket(realtimeProvider, {
 *   messageService,
 *   conversationService,
 *   userService,
 *   authService,
 *   cacheProvider,
 *   metricsService,
 *   logger,
 *   jwtSecret: env.JWT_SECRET,
 * });
 * ```
 *
 * @param realtimeProvider - Concrete {@link RealtimeProvider} instance whose
 *   `getServer()` returns the raw Socket.IO `Server` (this method is NOT on
 *   the `IRealtimeProvider` interface — it is only on the concrete class).
 * @param services - Aggregated dependency bundle injected from `server.ts`.
 */
export function setupWebSocket(
  realtimeProvider: RealtimeProvider,
  services: WebSocketServices,
): void {
  // -----------------------------------------------------------------------
  // 1. Obtain the raw Socket.IO server from the concrete provider
  // -----------------------------------------------------------------------
  const io = realtimeProvider.getServer();

  const { logger } = services;

  // -----------------------------------------------------------------------
  // 1b. Create effective logger and metrics fallbacks
  //
  //     All four handler modules declare `logger: Logger` (non-optional)
  //     and the presence handler requires `metricsService` as non-optional.
  //     When the composition root omits them, provide silent / noop stubs
  //     so handlers never need to guard against undefined.
  // -----------------------------------------------------------------------
  const effectiveLogger: Logger = logger ?? pino({ level: 'silent' });

  const effectiveMetrics: {
    recordWsConnection(): void;
    recordWsDisconnection(): void;
    recordWsMessage(eventType: string): void;
  } = services.metricsService ?? {
    recordWsConnection: (): void => { /* noop */ },
    recordWsDisconnection: (): void => { /* noop */ },
    recordWsMessage: (_eventType: string): void => { /* noop */ },
  };

  // -----------------------------------------------------------------------
  // 1c. Thin service adapters for handler deps whose structural types
  //     diverge from the concrete service classes
  //
  //     sync-handler.ts declares `afterTimestamp: string` (ISO-8601) while
  //     MessageService.syncMessages takes `Date`.  The adapter converts.
  //
  //     sync-handler.ts declares getConversations with a single-object
  //     param and flat-array return, while ConversationService uses
  //     separate params and returns `{ items, cursor, hasMore }`.
  // -----------------------------------------------------------------------

  /** Adapter bridging sync-handler messageService deps to concrete MessageService. */
  const syncMessageServiceAdapter = {
    syncMessages: async (params: {
      userId: string;
      conversationIds: string[];
      afterTimestamp: string;
      limit?: number;
    }) => {
      const messages = await services.messageService.syncMessages({
        userId: params.userId,
        conversationIds: params.conversationIds,
        afterTimestamp: new Date(params.afterTimestamp),
        limit: params.limit,
      });
      // MessageResponse structurally satisfies the handler's return shape;
      // the intermediate `unknown` is needed because MessageResponse lacks
      // an explicit index-signature (`[key: string]: unknown`).
      return messages as unknown as Array<{
        id: string;
        conversationId: string;
        senderId: string;
        ciphertext: string | null;
        type: string;
        serverTimestamp: string;
        isDeleted: boolean;
        isEdited: boolean;
        [key: string]: unknown;
      }>;
    },
    getMessageHistory: async (params: {
      conversationId: string;
      userId: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      messages: Array<Record<string, unknown>>;
      cursor?: string;
      hasMore: boolean;
    }> => {
      const result = await services.messageService.getMessageHistory(params);
      return {
        messages: result.items as unknown as Array<Record<string, unknown>>,
        cursor: result.cursor,
        hasMore: result.hasMore,
      };
    },
  };

  /** Adapter bridging sync-handler conversationService deps to concrete ConversationService. */
  const syncConversationServiceAdapter = {
    getConversations: async (params: {
      userId: string;
      limit?: number;
    }): Promise<Array<{ id: string; [key: string]: unknown }>> => {
      const result = await services.conversationService.getConversations(
        params.userId,
        { limit: params.limit },
      );
      return result.items as unknown as Array<{ id: string; [key: string]: unknown }>;
    },
  };

  // -----------------------------------------------------------------------
  // 2. Register server-level middleware — Authentication (R9, R33)
  //
  //    `createWsAuthMiddleware` verifies the JWT from the connection
  //    handshake `auth.token` field, checks the Redis token blacklist,
  //    and sets `socket.data.userId`, `.displayName`, `.email`, `.jti`,
  //    and `.correlationId` on success.
  // -----------------------------------------------------------------------
  io.use(createWsAuthMiddleware(services.jwtSecret, services.cacheProvider));

  // -----------------------------------------------------------------------
  // 3. Connection handler — runs once per successful handshake
  // -----------------------------------------------------------------------
  io.on('connection', async (socket: TypedSocket) => {
    // -------------------------------------------------------------------
    // 3a. Extract authenticated user data set by ws-auth middleware
    // -------------------------------------------------------------------
    const userId: string = socket.data.userId;

    // Ensure a correlation ID exists. The ws-auth middleware normally sets
    // one, but we guard defensively (R29).
    const correlationId: string = socket.data.correlationId || uuidv4();
    if (!socket.data.correlationId) {
      socket.data.correlationId = correlationId;
    }

    // -------------------------------------------------------------------
    // 3b. Structured connection log (R28)
    // -------------------------------------------------------------------
    if (logger) {
      logger.info({
        correlationId,
        userId,
        socketId: socket.id,
        msg: 'WebSocket client connected',
      });
    }

    // -------------------------------------------------------------------
    // 3c. Create per-connection rate limiter (R25)
    //
    //     SYNCHRONOUS — created before async operations to prevent
    //     race conditions where early events bypass rate limiting.
    //     Each socket gets its own rate-limit buckets:
    //       message:send  → 30 / min
    //       typing:start  → 10 / min
    //       default       → 60 / min
    // -------------------------------------------------------------------
    const rateLimiter = createWsRateLimiter(
      services.cacheProvider,
      socket.id,
    );

    // -------------------------------------------------------------------
    // 3d. Register all event handler groups — SYNCHRONOUS
    //
    //     CRITICAL: Handler registration MUST happen before any async
    //     operations (room joins, presence updates). This prevents a
    //     race condition where events emitted by the client immediately
    //     after the `connect` event would be silently dropped because
    //     the handlers had not yet been registered.
    //
    //     Each handler module registers its own Socket.IO `socket.on()`
    //     listeners internally.  Deps are narrowly typed per handler via
    //     structural typing (handler-specific inline interfaces).
    // -------------------------------------------------------------------

    // Message events: send, edit, delete, delivered, read (R4, R12, R18, R19, R20)
    //
    // Type assertion for messageService: MessageResponse defines
    // `ciphertext: string | null` (covering tombstoned messages), but
    // the message-handler inline type requires `ciphertext: string` for
    // sendMessage because new messages always carry non-null ciphertext
    // (R12).  The structural types are otherwise compatible; the narrow
    // cast is safe for the sendMessage creation path.
    registerMessageHandlers(socket as Socket, {
      messageService: services.messageService as unknown as
        Parameters<typeof registerMessageHandlers>[1]['messageService'],
      conversationService: services.conversationService,
      cacheProvider: services.cacheProvider,
      realtimeProvider,
      rateLimiter,
      logger: effectiveLogger,
    });

    // Typing indicators: start, stop (3s debounce, 5s TTL) (R25)
    registerTypingHandlers(socket as Socket, {
      cacheProvider: services.cacheProvider,
      realtimeProvider,
      rateLimiter,
      logger: effectiveLogger,
    });

    // Presence: online / offline lifecycle, metrics (R37)
    // The handler internally manages:
    //   - metricsService.recordWsConnection() / recordWsDisconnection()
    //   - userService.updateOnlineStatus()
    //   - user personal room join
    //   - user:presence broadcasts to user room
    //   - multi-tab disconnect detection
    //   - rate-limiter cleanup on disconnect
    // Note: Conversation room presence broadcasts are handled below (3e)
    // after room joins complete, and by the handler on disconnect via
    // socket.data.conversationRooms.
    registerPresenceHandlers(socket as Socket, {
      userService: services.userService,
      cacheProvider: services.cacheProvider,
      realtimeProvider,
      rateLimiter,
      metricsService: effectiveMetrics,
      logger: effectiveLogger,
    });

    // Offline reconciliation: message:sync (R13 — 3s target)
    registerSyncHandlers(socket as Socket, {
      messageService: syncMessageServiceAdapter,
      conversationService: syncConversationServiceAdapter,
      rateLimiter,
      logger: effectiveLogger,
    });

    // -------------------------------------------------------------------
    // 3e. Join conversation rooms (ASYNC)
    //
    //     The presence handler manages the user-specific room
    //     (`user:${userId}`) and online-status lifecycle internally.
    //     This block is responsible ONLY for conversation rooms, as
    //     stated by the presence-handler comment:
    //       "Conversation room joins are handled by the WebSocket index.ts"
    //
    //     After room joins complete, conversation IDs are stored on
    //     socket.data for the presence handler's disconnect broadcast,
    //     and an initial online presence event is emitted to all joined
    //     rooms so contacts are notified immediately.
    // -------------------------------------------------------------------
    let conversationCount = 0;
    try {
      const result = await services.conversationService.getConversations(
        userId,
        { limit: MAX_CONVERSATION_ROOMS_ON_CONNECT },
      );

      const items = result.items;
      const joinedRoomIds: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const conversation = items[i];
        if (conversation && conversation.id) {
          await socket.join(conversation.id);
          joinedRoomIds.push(conversation.id);
          conversationCount++;
        }
      }

      // Store conversation room IDs on socket.data for the presence
      // handler to use on disconnect (socket.rooms is cleared before
      // the `disconnect` event fires in Socket.IO).
      socket.data.conversationRooms = joinedRoomIds;

      // Broadcast initial online presence to all conversation rooms so
      // contacts see this user come online. The presence handler only
      // emits to the user's personal room (`user:${userId}`); this
      // covers the conversation rooms that contacts are listening on.
      if (joinedRoomIds.length > 0) {
        const presencePayload = {
          userId,
          status: 'online' as const,
          correlationId,
          timestamp: new Date().toISOString(),
        };
        for (const roomId of joinedRoomIds) {
          await realtimeProvider.emitToRoom(roomId, 'user:presence', presencePayload);
        }
      }

      if (logger) {
        logger.info({
          correlationId,
          userId,
          socketId: socket.id,
          conversationCount,
          msg: 'Joined conversation rooms and broadcast online presence',
        });
      }
    } catch (err: unknown) {
      // Non-fatal — the user can still receive events via their personal
      // room; conversation rooms will be joined lazily as messages arrive.
      if (logger) {
        logger.error({
          err,
          correlationId,
          userId,
          socketId: socket.id,
          msg: 'Failed to join conversation rooms on connect',
        });
      }
    }

    // -------------------------------------------------------------------
    // 3f. Socket-level error handler (R28)
    // -------------------------------------------------------------------
    socket.on('error', (err: Error) => {
      if (logger) {
        logger.error({
          err,
          userId,
          socketId: socket.id,
          correlationId,
          msg: 'WebSocket error',
        });
      }
    });

    // -------------------------------------------------------------------
    // 3g. Disconnection logging
    //
    //     The presence handler already manages the full disconnect
    //     lifecycle (online-status, metrics, rate-limiter cleanup).
    //     This listener adds structured disconnection logging only.
    //     Socket.IO supports multiple listeners on the same event.
    // -------------------------------------------------------------------
    socket.on('disconnect', (reason: string) => {
      if (logger) {
        logger.info({
          correlationId,
          userId,
          socketId: socket.id,
          reason,
          msg: 'WebSocket client disconnected',
        });
      }
    });
  });

  // -----------------------------------------------------------------------
  // 4. Log server initialisation
  // -----------------------------------------------------------------------
  if (logger) {
    logger.info({ msg: 'WebSocket server initialised and accepting connections' });
  }
}

// ---------------------------------------------------------------------------
// Room management utilities
// ---------------------------------------------------------------------------

/**
 * Join a socket to a conversation room.
 *
 * Called from outside the WebSocket layer (e.g. when a user creates or is
 * added to a new conversation) to ensure the socket receives real-time
 * events for that conversation immediately.
 *
 * @param realtimeProvider - Concrete {@link RealtimeProvider} instance
 * @param socketId        - The Socket.IO socket ID to add to the room
 * @param conversationId  - The conversation (room) ID to join
 */
export async function joinConversationRoom(
  realtimeProvider: RealtimeProvider,
  socketId: string,
  conversationId: string,
): Promise<void> {
  await realtimeProvider.joinRoom(socketId, conversationId);
}

/**
 * Remove a socket from a conversation room.
 *
 * Called from outside the WebSocket layer (e.g. when a user leaves or is
 * removed from a conversation) to stop the socket from receiving events
 * for that conversation.
 *
 * @param realtimeProvider - Concrete {@link RealtimeProvider} instance
 * @param socketId        - The Socket.IO socket ID to remove from the room
 * @param conversationId  - The conversation (room) ID to leave
 */
export async function leaveConversationRoom(
  realtimeProvider: RealtimeProvider,
  socketId: string,
  conversationId: string,
): Promise<void> {
  await realtimeProvider.leaveRoom(socketId, conversationId);
}
