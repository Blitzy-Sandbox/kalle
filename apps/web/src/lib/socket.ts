/**
 * @module socket
 * Socket.IO Client Singleton with Auto-Reconnect
 *
 * Creates and exports a configured Socket.IO client singleton connecting to the
 * backend API server. Implements typed events from @kalle/shared for full
 * TypeScript type safety on all emit/on/off calls. Handles reconnection logic
 * for offline-to-online reconciliation (R13). Propagates auth token on
 * connection handshake (R9). Includes UUID v4 correlation ID generation (R29).
 */

import { io, Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '@kalle/shared';

/* ─── Type Definition ──────────────────────────────────────────────────── */

/**
 * Fully typed Socket.IO client instance parameterized with the server-to-client
 * and client-to-server event maps from @kalle/shared. Provides compile-time type
 * safety for all emit(), on(), and off() calls.
 *
 * Exposes: connected, id, auth, connect, disconnect, emit, on, off,
 * removeAllListeners — all inherited from the underlying Socket class.
 */
export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/* ─── Configuration Constants ──────────────────────────────────────────── */

/**
 * WebSocket server URL sourced from the NEXT_PUBLIC_WS_URL environment variable.
 * Defaults to http://localhost:3001 for local Docker development (R38, R40).
 */
const SOCKET_URL: string =
  process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:3001';

/**
 * Socket.IO client options:
 * - autoConnect: false — socket must be explicitly connected after auth token is set
 * - reconnection: true with Infinity attempts — required for R13 offline reconciliation
 * - reconnectionDelay: 1 s initial, 5 s max (exponential backoff)
 * - timeout: 10 s connection handshake timeout
 * - transports: WebSocket preferred, long-polling fallback
 */
const SOCKET_OPTIONS: Parameters<typeof io>[1] = {
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1_000,
  reconnectionDelayMax: 5_000,
  timeout: 10_000,
  transports: ['websocket', 'polling'],
};

/* ─── Singleton State ──────────────────────────────────────────────────── */

/** Module-scoped singleton socket instance. Created lazily by getSocket(). */
let socket: TypedSocket | null = null;

/**
 * Tracks whether the socket was previously connected and then disconnected.
 * Used by setupReconnectionHandler to differentiate initial connection from
 * reconnection events.
 */
let hasBeenConnected = false;

/* ─── Singleton Accessor ───────────────────────────────────────────────── */

/**
 * Returns the Socket.IO client singleton, creating it on the first call.
 * Subsequent invocations return the same instance (lazy initialization).
 *
 * @returns The singleton TypedSocket instance
 */
export function getSocket(): TypedSocket {
  if (!socket) {
    socket = io(SOCKET_URL, SOCKET_OPTIONS) as TypedSocket;
  }
  return socket;
}

/* ─── Connection Management ────────────────────────────────────────────── */

/**
 * Connects the socket using the provided JWT access token for the WebSocket
 * handshake. The backend WebSocket auth middleware reads the token from
 * `socket.handshake.auth.token` (R9).
 *
 * If the socket is already connected, it is disconnected first so that the
 * new token takes effect on the subsequent handshake.
 *
 * @param accessToken - A valid JWT access token
 * @returns The (re-)connected TypedSocket instance
 */
export function connectSocket(accessToken: string): TypedSocket {
  const s = getSocket();
  s.auth = { token: accessToken };

  if (s.connected) {
    s.disconnect();
  }

  s.connect();
  return s;
}

/**
 * Gracefully disconnects the socket without destroying the singleton.
 * The socket instance remains available for a later reconnection via
 * connectSocket(). Called during user-initiated disconnect scenarios.
 */
export function disconnectSocket(): void {
  if (socket && socket.connected) {
    socket.disconnect();
  }
}

/**
 * Fully destroys the socket singleton: removes all event listeners,
 * disconnects, and nulls the module reference. Resets the reconnection
 * tracking flag. Called during logout or full app teardown.
 */
export function destroySocket(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
    hasBeenConnected = false;
  }
}

/* ─── Reconnection Handling (R13) ──────────────────────────────────────── */

/**
 * Registers a handler that fires whenever the socket reconnects after a
 * prior disconnection. Uses the internal `hasBeenConnected` flag to
 * distinguish the initial connection from a reconnection.
 *
 * The callback typically triggers `message:sync` to reconcile all missed
 * messages while the client was offline (R13). All missed messages must
 * arrive in order within 3 seconds.
 *
 * @param onReconnectCallback - Invoked on each successful reconnection
 */
export function setupReconnectionHandler(
  onReconnectCallback: () => void,
): void {
  const s = getSocket();

  s.on('disconnect', () => {
    hasBeenConnected = true;
  });

  s.on('connect', () => {
    if (hasBeenConnected) {
      onReconnectCallback();
    }
  });
}

/**
 * Convenience wrapper: listens for the Socket.IO Manager's built-in
 * `reconnect` event, which fires each time the automatic reconnection
 * strategy succeeds. Unlike setupReconnectionHandler, this relies on the
 * Manager-level event rather than tracking connect/disconnect state.
 *
 * @param callback - Invoked on successful automatic reconnection
 */
export function onReconnect(callback: () => void): void {
  const s = getSocket();
  s.io.on('reconnect', () => {
    callback();
  });
}

/* ─── Type-Safe Event Helpers ──────────────────────────────────────────── */

/**
 * Type-safe wrapper around `socket.emit` for client-to-server events.
 * The generic constraint ensures both the event name and its payload
 * conform to the ClientToServerEvents contract at compile time.
 *
 * @throws {Error} If the socket is not connected
 * @param event - An event name defined in ClientToServerEvents
 * @param args  - The event payload(s) matching the event's signature
 */
export function emitEvent<K extends keyof ClientToServerEvents>(
  event: K,
  ...args: Parameters<ClientToServerEvents[K]>
): void {
  const s = getSocket();
  if (!s.connected) {
    throw new Error(
      `Cannot emit "${String(event)}" — socket is not connected. Call connectSocket() first.`,
    );
  }
  /* Type assertion bridges the gap between our generic wrapper and
     Socket.IO's complex overloaded emit signature which combines
     reserved and user events in a discriminated union. The external
     call-site retains full type safety via the generic constraint. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (s as any).emit(event, ...args);
}

/**
 * Type-safe wrapper around `socket.on` for server-to-client events.
 * The generic constraint ensures the handler signature matches the
 * event's payload type at compile time.
 *
 * @param event   - An event name defined in ServerToClientEvents
 * @param handler - A handler whose signature matches the event
 */
export function onEvent<K extends keyof ServerToClientEvents>(
  event: K,
  handler: ServerToClientEvents[K],
): void {
  const s = getSocket();
  /* Type assertion for the same reason as emitEvent — Socket.IO's
     on() overload merges reserved + user events in a conditional type
     that TypeScript cannot narrow through a generic K. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (s as any).on(event, handler);
}

/**
 * Type-safe wrapper around `socket.off` for server-to-client events.
 * If no handler is provided, all listeners for the event are removed.
 *
 * @param event   - An event name defined in ServerToClientEvents
 * @param handler - Optional specific handler to remove
 */
export function offEvent<K extends keyof ServerToClientEvents>(
  event: K,
  handler?: ServerToClientEvents[K],
): void {
  const s = getSocket();
  if (handler) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s as any).off(event, handler);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s as any).off(event);
  }
}

/* ─── Connection State ─────────────────────────────────────────────────── */

/**
 * Returns `true` when the socket is currently connected to the server.
 */
export function isConnected(): boolean {
  return socket?.connected ?? false;
}

/**
 * Returns the current transport-level socket ID, or `undefined` if the
 * socket is not connected.
 */
export function getSocketId(): string | undefined {
  return socket?.id;
}

/* ─── Correlation ID Generation (R29) ──────────────────────────────────── */

/**
 * Generates a UUID v4 correlation ID for WebSocket event tracing (R29).
 * Every emitted event should include this ID in the EventMetadata payload
 * for end-to-end request correlation across frontend, backend, and workers.
 *
 * Prefers the native `crypto.randomUUID()` API when available and falls
 * back to a manual RFC 4122 § 4.4-compliant implementation for older
 * browser environments.
 *
 * @returns A UUID v4 string (e.g. "550e8400-e29b-41d4-a716-446655440000")
 */
export function generateCorrelationId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  /* Manual UUID v4 fallback (RFC 4122 § 4.4):
     - Version nibble (bits 48-51) set to 0100 (4)
     - Variant bits (bits 64-65) set to 10 */
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
