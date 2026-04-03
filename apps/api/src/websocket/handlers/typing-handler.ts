/**
 * @file typing-handler.ts
 * @description Handles `typing:start` and `typing:stop` WebSocket events with
 * server-side debounce (3-second interval) and automatic expiry (5-second TTL)
 * using Redis keys via ICacheProvider. Emits `typing:indicator` events to
 * conversation rooms via IRealtimeProvider.
 *
 * Architecture rules enforced:
 *  R7  — Zero warnings build (TypeScript strict mode, no unused vars)
 *  R17 — Interface-driven dependencies (all deps via function params)
 *  R25 — WebSocket rate limiting (typing:start max 10/min, typing:stop 60/min)
 *  R28 — Structured logging only (zero console.log, Pino JSON only)
 *  R29 — Correlation ID propagation (every log entry and emitted event)
 *
 * Debounce strategy:
 *  - On `typing:start`, build Redis key `typing:{conversationId}:{userId}`.
 *  - If the key already exists (within 3 s debounce window), refresh its TTL
 *    to 5 s and suppress re-emission of the indicator event.
 *  - If the key does NOT exist, atomically set it with 5 s TTL and emit.
 *  - On `typing:stop`, delete the key and emit isTyping=false.
 *  - If neither stop nor another start arrives within 5 s, the key expires
 *    automatically and the typing indicator on the client side times out.
 */

import type { Socket } from 'socket.io';
import type { Logger } from 'pino';
import type { ICacheProvider } from '../../domain/interfaces/ICacheProvider';
import type { IRealtimeProvider } from '../../domain/interfaces/IRealtimeProvider';
import type { WsRateLimiter } from '../middleware/ws-rate-limiter';
import type {
  TypingStartPayload,
  TypingStopPayload,
  TypingIndicatorPayload,
  SocketData,
} from '@kalle/shared/types/websocket-events';

// ---------------------------------------------------------------------------
// Dependencies Interface
// ---------------------------------------------------------------------------

/**
 * Typed dependency bag injected into {@link registerTypingHandlers}.
 *
 * All members are infrastructure abstractions — the handler never imports
 * concrete classes. Wiring is performed by the WebSocket index.ts
 * composition layer.
 */
export interface TypingHandlerDeps {
  /** Redis-backed cache for debounce keys and TTL management */
  cacheProvider: ICacheProvider;

  /** Socket.IO abstraction for emitting events to conversation rooms */
  realtimeProvider: IRealtimeProvider;

  /** Per-connection sliding-window rate limiter (R25) */
  rateLimiter: WsRateLimiter;

  /** Pino structured JSON logger — zero console.* calls (R28) */
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Automatic expiry TTL for the Redis typing key, in seconds.
 *
 * The client is expected to send `typing:start` events approximately every
 * 3 seconds (debounce interval). If the key already exists (i.e. a
 * `typing:start` was processed within the last {@link TYPING_EXPIRY_SECONDS}
 * seconds), the handler suppresses re-emission and refreshes the TTL only.
 *
 * If neither a subsequent `typing:start` nor a `typing:stop` arrives within
 * this period, the key expires automatically and the client-side indicator
 * times out.
 */
const TYPING_EXPIRY_SECONDS = 5;

// ---------------------------------------------------------------------------
// Typing Key Helper
// ---------------------------------------------------------------------------

/**
 * Builds the Redis key used for debounce tracking.
 *
 * Format: `typing:{conversationId}:{userId}`
 *
 * Each key is scoped to a single user within a single conversation, so
 * typing in multiple conversations simultaneously produces independent keys.
 */
function buildTypingKey(conversationId: string, userId: string): string {
  return `typing:${conversationId}:${userId}`;
}

// ---------------------------------------------------------------------------
// Main Export — Handler Registration
// ---------------------------------------------------------------------------

/**
 * Registers `typing:start` and `typing:stop` event listeners on the given
 * Socket.IO socket.
 *
 * This function is called once per authenticated WebSocket connection from
 * the WebSocket index.ts composition layer. It closes over the provided
 * dependencies and socket metadata (userId, correlationId).
 *
 * @param socket - Authenticated Socket.IO socket instance. `socket.data`
 *                 contains `userId` and `correlationId` set by ws-auth
 *                 middleware.
 * @param deps   - Injected dependencies (cache, realtime, rate limiter, logger)
 */
export function registerTypingHandlers(
  socket: Socket,
  deps: TypingHandlerDeps,
): void {
  const { cacheProvider, realtimeProvider, rateLimiter, logger } = deps;

  // Extract per-connection metadata populated by ws-auth middleware
  const userId: string = (socket.data as SocketData).userId;
  const correlationId: string = (socket.data as SocketData).correlationId;

  // Create a child logger with handler-scoped context for every log entry (R29)
  const childLogger: Logger = logger.child({
    handler: 'typing',
    userId,
    correlationId,
  });

  // -------------------------------------------------------------------------
  // typing:start handler
  // -------------------------------------------------------------------------
  socket.on('typing:start', async (payload: TypingStartPayload): Promise<void> => {
    const { conversationId } = payload;

    try {
      // ── Rate limit check (R25) — typing:start max 10/min ──────────────
      const withinLimit: boolean = await rateLimiter.checkLimit('typing:start');
      if (!withinLimit) {
        childLogger.warn(
          { conversationId, event: 'typing:start' },
          'Rate limit exceeded for typing:start — disconnecting socket',
        );
        socket.disconnect(true);
        return;
      }

      // ── Server-side debounce via Redis key existence ──────────────────
      const key: string = buildTypingKey(conversationId, userId);
      const alreadyTyping: boolean = await cacheProvider.exists(key);

      if (alreadyTyping) {
        // Within debounce window — refresh TTL only, suppress re-emission
        await cacheProvider.expire(key, TYPING_EXPIRY_SECONDS);

        childLogger.debug(
          { conversationId, event: 'typing:start', debounced: true },
          'Typing indicator debounced — TTL refreshed',
        );
        return;
      }

      // New typing event — atomically set the key with TTL
      await cacheProvider.setNx(key, 'typing', TYPING_EXPIRY_SECONDS);

      // ── Emit typing:indicator (isTyping: true) to conversation room ───
      const indicatorPayload: TypingIndicatorPayload = {
        conversationId,
        userId,
        displayName: '', // Client resolves display name from local user cache
        isTyping: true,
        correlationId,
        timestamp: new Date().toISOString(),
      };

      await realtimeProvider.emitToRoom(
        conversationId,
        'typing:indicator',
        indicatorPayload,
      );

      childLogger.debug(
        { conversationId, event: 'typing:start', debounced: false },
        'Typing indicator started',
      );
    } catch (err: unknown) {
      // Processing errors are NOT fatal — do NOT disconnect the socket.
      // Only rate-limit violations trigger disconnection.
      childLogger.error(
        { err, conversationId, event: 'typing:start' },
        'Error processing typing:start',
      );
    }
  });

  // -------------------------------------------------------------------------
  // typing:stop handler
  // -------------------------------------------------------------------------
  socket.on('typing:stop', async (payload: TypingStopPayload): Promise<void> => {
    const { conversationId } = payload;

    try {
      // ── Rate limit check (R25) — typing:stop falls under "all others" 60/min
      const withinLimit: boolean = await rateLimiter.checkLimit('typing:stop');
      if (!withinLimit) {
        childLogger.warn(
          { conversationId, event: 'typing:stop' },
          'Rate limit exceeded for typing:stop — disconnecting socket',
        );
        socket.disconnect(true);
        return;
      }

      // ── Remove typing key from Redis ──────────────────────────────────
      const key: string = buildTypingKey(conversationId, userId);
      await cacheProvider.del(key);

      // ── Emit typing:indicator (isTyping: false) to conversation room ──
      const indicatorPayload: TypingIndicatorPayload = {
        conversationId,
        userId,
        displayName: '', // Client resolves display name from local user cache
        isTyping: false,
        correlationId,
        timestamp: new Date().toISOString(),
      };

      await realtimeProvider.emitToRoom(
        conversationId,
        'typing:indicator',
        indicatorPayload,
      );

      childLogger.debug(
        { conversationId, event: 'typing:stop' },
        'Typing indicator stopped',
      );
    } catch (err: unknown) {
      // Processing errors are NOT fatal — do NOT disconnect.
      childLogger.error(
        { err, conversationId, event: 'typing:stop' },
        'Error processing typing:stop',
      );
    }
  });
}
