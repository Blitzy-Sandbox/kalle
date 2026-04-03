/**
 * @file presence-handler.ts
 * @description Handles user presence (online/offline/lastSeen) on WebSocket
 * connect and disconnect events. Sets user status to online when connected,
 * offline with lastSeen timestamp when disconnected. Emits `user:presence`
 * events to relevant users via the user's personal room. Uses ICacheProvider
 * for presence state caching with a 5-minute TTL. Records WebSocket
 * connection/disconnection metrics via MetricsService.
 *
 * Architecture Rules Applied:
 *   R7  — Zero warnings build (TypeScript strict, explicit types, no `any`)
 *   R17 — Interface-driven dependencies (deps via function params, no globals)
 *   R25 — WebSocket rate limiting (cleanup on disconnect via rateLimiter)
 *   R28 — Structured logging only (zero console.log/warn/error calls)
 *   R29 — Correlation ID propagation (child logger + emitted event payloads)
 *   R37 — Metrics via MetricsService (connection/disconnection counts)
 */

import type { Socket } from 'socket.io';
import type { Logger } from 'pino';
import type { ICacheProvider } from '../../domain/interfaces/ICacheProvider';
import type { IRealtimeProvider } from '../../domain/interfaces/IRealtimeProvider';
import type { WsRateLimiter } from '../middleware/ws-rate-limiter';
import type {
  UserPresencePayload,
  SocketData,
} from '@kalle/shared/types/websocket-events';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Time-to-live for presence cache entries in seconds (5 minutes). */
const PRESENCE_CACHE_TTL_SECONDS = 300;

/** Redis key prefix for presence cache entries. Pattern: `presence:{userId}` */
const PRESENCE_KEY_PREFIX = 'presence:';

// ---------------------------------------------------------------------------
// Dependencies Interface
// ---------------------------------------------------------------------------

/**
 * Typed dependencies for the presence handler.
 *
 * Follows R17 (Interface-Driven Dependencies): `userService` and
 * `metricsService` are defined inline with only the methods the handler
 * consumes. This avoids importing concrete service classes. The actual
 * service instances are injected by the WebSocket `index.ts` module at
 * runtime from the composition root (`server.ts`).
 */
export interface PresenceHandlerDeps {
  /**
   * User service — update online/offline status in the persistent store.
   * Defined inline per R17 to avoid importing the concrete UserService class.
   */
  userService: {
    updateOnlineStatus(params: {
      userId: string;
      status: 'ONLINE' | 'OFFLINE';
      lastSeen?: Date;
    }): Promise<void>;
  };

  /** Cache provider for Redis-backed presence state caching (R17). */
  cacheProvider: ICacheProvider;

  /** Real-time provider for room management and event broadcasting (R17). */
  realtimeProvider: IRealtimeProvider;

  /** Per-connection WebSocket rate limiter — cleaned up on disconnect (R25). */
  rateLimiter: WsRateLimiter;

  /**
   * Metrics service — records WebSocket connection/disconnection counts (R37).
   * Defined inline per R17 to avoid importing the concrete MetricsService class.
   */
  metricsService: {
    recordWsConnection(): void;
    recordWsDisconnection(): void;
    recordWsMessage(eventType: string): void;
  };

  /** Pino logger for structured JSON logging (R28). */
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Registers presence handlers on a WebSocket connection.
 *
 * Called immediately after authentication succeeds. Marks the user as
 * online, caches presence state in Redis with a 5-minute TTL, joins
 * the user's personal room (`user:{userId}`), and broadcasts a
 * `user:presence` event with status `'online'`.
 *
 * On disconnect, performs multi-tab detection via
 * `realtimeProvider.getUserSockets()`. If this was the last active
 * socket for the user, marks them offline, updates the cache, and
 * broadcasts an offline presence event. If other sockets remain, the
 * user's presence status is unchanged.
 *
 * Every disconnect also cleans up rate limiter state to free Redis
 * memory (R25).
 *
 * @param socket - Authenticated Socket.IO connection (`socket.data`
 *                 populated by ws-auth middleware with userId and
 *                 correlationId)
 * @param deps   - Injected dependencies (R17: no concrete class imports)
 */
export function registerPresenceHandlers(
  socket: Socket,
  deps: PresenceHandlerDeps,
): void {
  const {
    userService,
    cacheProvider,
    realtimeProvider,
    rateLimiter,
    metricsService,
    logger,
  } = deps;

  // Extract user identity from socket data (populated by ws-auth middleware)
  const socketData = socket.data as SocketData;
  const userId: string = socketData.userId;
  const correlationId: string = socketData.correlationId;

  // Create a child logger with handler-scoped bindings for traceability (R29)
  const childLogger = logger.child({
    handler: 'presence',
    userId,
    correlationId,
  });

  // -------------------------------------------------------------------------
  // handleConnect — invoked immediately when the handler is registered
  // -------------------------------------------------------------------------

  /**
   * Handles the initial connection: marks the user as online in the
   * persistent store and cache, joins the personal room, and broadcasts
   * the online presence event.
   *
   * Wrapped in an async function invoked via `void` to avoid unhandled
   * promise rejection on the synchronous `registerPresenceHandlers` call.
   * Errors are caught and logged — the connection is NOT terminated on
   * presence failures (resilient design).
   */
  async function handleConnect(): Promise<void> {
    try {
      // Record WebSocket connection metric (R37)
      metricsService.recordWsConnection();

      // Update user status to ONLINE in the persistent store
      await userService.updateOnlineStatus({ userId, status: 'ONLINE' });

      // Cache presence state in Redis with a 5-minute TTL
      const cacheKey = `${PRESENCE_KEY_PREFIX}${userId}`;
      await cacheProvider.set(
        cacheKey,
        {
          status: 'online' as const,
          connectedAt: new Date().toISOString(),
          socketId: socket.id,
        },
        PRESENCE_CACHE_TTL_SECONDS,
      );

      // Join user's personal room for targeted event delivery
      // Conversation room joins are handled by the WebSocket index.ts
      await realtimeProvider.joinRoom(socket.id, `user:${userId}`);

      // Broadcast user:presence (online) to the user's personal room
      // Contacts who have joined this room receive the presence update
      const payload: UserPresencePayload = {
        userId,
        status: 'online',
        correlationId,
        timestamp: new Date().toISOString(),
      };
      await realtimeProvider.emitToRoom(
        `user:${userId}`,
        'user:presence',
        payload,
      );

      childLogger.info(
        { socketId: socket.id, event: 'connect' },
        'User connected - presence online',
      );
    } catch (err: unknown) {
      // Presence errors must NOT terminate the connection — log and continue
      childLogger.error(
        { err, socketId: socket.id, event: 'connect' },
        'Error handling presence connect',
      );
    }
  }

  // -------------------------------------------------------------------------
  // handleDisconnect — invoked when the socket disconnects
  // -------------------------------------------------------------------------

  /**
   * Handles socket disconnection with multi-tab awareness.
   *
   * Checks whether the disconnecting socket was the user's last active
   * connection. If yes, transitions the user to offline with a lastSeen
   * timestamp and broadcasts the offline presence event. If the user still
   * has other active sockets, presence status remains unchanged.
   *
   * Always performs rate limiter cleanup and best-effort typing indicator
   * cleanup regardless of multi-tab state. Errors are caught and logged —
   * disconnect handlers must be resilient and never throw.
   *
   * @param reason - Socket.IO disconnect reason string
   */
  async function handleDisconnect(reason: string): Promise<void> {
    try {
      // Record WebSocket disconnection metric (R37)
      metricsService.recordWsDisconnection();

      // Check for other active sockets (multi-tab / multi-device scenario)
      const remainingSockets = await realtimeProvider.getUserSockets(userId);

      // Filter out the current disconnecting socket from the count
      const activeSockets = remainingSockets.filter(
        (id: string) => id !== socket.id,
      );

      if (activeSockets.length === 0) {
        // -----------------------------------------------------------------
        // Last socket — user is going fully offline
        // -----------------------------------------------------------------
        const now = new Date();
        const lastSeenIso = now.toISOString();

        // Update user status to OFFLINE with lastSeen in the persistent store
        await userService.updateOnlineStatus({
          userId,
          status: 'OFFLINE',
          lastSeen: now,
        });

        // Transition presence cache: remove stale online entry, then set
        // new offline state with TTL
        const cacheKey = `${PRESENCE_KEY_PREFIX}${userId}`;
        await cacheProvider.del(cacheKey);
        await cacheProvider.set(
          cacheKey,
          {
            status: 'offline' as const,
            lastSeen: lastSeenIso,
          },
          PRESENCE_CACHE_TTL_SECONDS,
        );

        // Broadcast user:presence (offline) to the user's personal room
        const payload: UserPresencePayload = {
          userId,
          status: 'offline',
          lastSeen: lastSeenIso,
          correlationId,
          timestamp: lastSeenIso,
        };
        await realtimeProvider.emitToRoom(
          `user:${userId}`,
          'user:presence',
          payload,
        );

        childLogger.info(
          {
            socketId: socket.id,
            event: 'disconnect',
            reason,
            lastSeen: lastSeenIso,
          },
          'User disconnected - presence offline (last socket)',
        );
      } else {
        // -----------------------------------------------------------------
        // User still has other active connections — presence unchanged
        // -----------------------------------------------------------------
        childLogger.debug(
          {
            socketId: socket.id,
            activeConnections: activeSockets.length,
          },
          'Socket disconnected but user has other active connections',
        );
      }

      // Best-effort typing indicator cleanup:
      // Typing indicator keys follow the pattern `typing:{conversationId}:{userId}`
      // with a 5-second TTL set by the typing handler. ICacheProvider does not
      // expose pattern-based key scanning (SCAN/KEYS), and the socket has already
      // left all rooms at disconnect time, so we cannot enumerate specific
      // conversation-scoped typing keys. The 5-second TTL on all typing keys
      // ensures phantom indicators expire automatically — an acceptable trade-off
      // given the interface constraints.

      // Clean up rate limiter state to free Redis memory (R25)
      await rateLimiter.cleanup();
    } catch (err: unknown) {
      // Disconnect handlers must be resilient — log but never throw
      childLogger.error(
        { err, socketId: socket.id, event: 'disconnect', reason },
        'Error handling presence disconnect',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Wire up handlers
  // -------------------------------------------------------------------------

  // Immediately handle connection (user going online)
  void handleConnect();

  // Register disconnect handler — wraps async function to avoid unhandled
  // promise rejections since Socket.IO expects a synchronous callback
  socket.on('disconnect', (reason: string) => {
    void handleDisconnect(reason);
  });
}
