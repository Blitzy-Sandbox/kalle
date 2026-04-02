/**
 * @file IRealtimeProvider.ts
 * @description Defines the real-time communication provider contract abstracting
 * Socket.IO with Redis adapter for horizontal scaling. This interface is consumed
 * by services and WebSocket handlers that need to emit events to specific users,
 * rooms (conversations), or broadcast to all connections.
 *
 * The concrete implementation (RealtimeProvider) uses Socket.IO with
 * @socket.io/redis-adapter. Services import ONLY this interface per Rule R17
 * (Interface-Driven Dependencies).
 *
 * Architecture Rules:
 * - R17: Services code against this interface — no service imports the concrete class.
 * - R4:  Messages must arrive in send-order with zero drops or duplicates.
 * - R13: On reconnect, clients sync missed messages; provider tracks connected users.
 * - R25: Rate limiting is handled at the middleware level, not within this interface.
 * - R16: Provider interface abstracts infrastructure (Socket.IO). Zero business logic.
 * - R7:  TypeScript strict mode, zero warnings.
 * - R28: Zero console.log calls — structured logging only.
 */

/**
 * Real-time communication provider contract.
 *
 * Abstracts the underlying WebSocket implementation (Socket.IO + Redis adapter)
 * so that services remain decoupled from infrastructure concerns. All event data
 * is typed as `unknown` at this contract level — concrete handlers cast payloads
 * to the typed event contracts defined in `@kalle/shared/types/websocket-events`.
 *
 * No Socket.IO-specific types leak through this interface.
 */
export interface IRealtimeProvider {
  /**
   * Emit an event to all sockets in a specific room (conversation).
   *
   * Used for broadcasting messages, typing indicators, and presence updates
   * to all participants of a conversation. The room identifier is typically
   * the conversationId.
   *
   * @param room  - Room identifier (typically the conversationId)
   * @param event - Event name (e.g., 'message:new', 'typing:indicator')
   * @param data  - Event payload (must match the typed event contracts from @kalle/shared)
   * @returns Resolves when the event has been emitted to the room
   */
  emitToRoom(room: string, event: string, data: unknown): Promise<void>;

  /**
   * Emit an event to a specific user across all their connected sockets.
   *
   * Used for user-specific notifications such as message status updates,
   * presence changes, and key rotation notifications. Internally uses the
   * user-specific room pattern `user:${userId}` to target all of a user's
   * active connections across horizontally scaled server instances.
   *
   * @param userId - Target user ID
   * @param event  - Event name (e.g., 'message:status', 'user:presence')
   * @param data   - Event payload
   * @returns Resolves when the event has been emitted to all user sockets
   */
  emitToUser(userId: string, event: string, data: unknown): Promise<void>;

  /**
   * Join a socket to a specific room.
   *
   * Called when a user connects and needs to receive events for their
   * conversations. Each socket is joined to rooms corresponding to the
   * conversations the user participates in.
   *
   * @param socketId - The socket's unique identifier
   * @param room     - Room to join (e.g., conversationId)
   * @returns Resolves when the socket has joined the room
   */
  joinRoom(socketId: string, room: string): Promise<void>;

  /**
   * Remove a socket from a specific room.
   *
   * Called when a user leaves a conversation or is removed from a group.
   * After leaving, the socket will no longer receive events emitted to
   * that room.
   *
   * @param socketId - The socket's unique identifier
   * @param room     - Room to leave
   * @returns Resolves when the socket has left the room
   */
  leaveRoom(socketId: string, room: string): Promise<void>;

  /**
   * Get all socket IDs currently connected for a specific user.
   *
   * Useful for determining if a user is online and for targeted delivery.
   * Returns an empty array if the user has no active connections (offline).
   *
   * @param userId - User ID to look up
   * @returns Array of socket IDs (empty if user is offline)
   */
  getUserSockets(userId: string): Promise<string[]>;

  /**
   * Check if a user is currently connected (has at least one active socket).
   *
   * Used for presence tracking — determining online/offline status before
   * emitting presence events or deciding delivery strategy.
   *
   * @param userId - User ID to check
   * @returns `true` if the user has at least one active connection
   */
  isUserOnline(userId: string): Promise<boolean>;

  /**
   * Get the count of currently connected sockets and unique users.
   *
   * Used by health checks and the metrics endpoint (R37) to expose
   * Prometheus-compatible WebSocket connection statistics.
   *
   * @returns Object containing the total socket count and unique user count
   */
  getConnectionStats(): Promise<{ socketCount: number; userCount: number }>;

  /**
   * Initialize the realtime provider.
   *
   * Sets up the Redis adapter for horizontal scaling, configures the
   * Socket.IO server instance, and prepares for accepting connections.
   * Called once during server bootstrap in the composition root.
   *
   * @returns Resolves when initialization is complete and the provider is ready
   */
  initialize(): Promise<void>;

  /**
   * Gracefully close all connections and shut down the server.
   *
   * Disconnects all active sockets, closes the Redis adapter connection,
   * and releases all resources. Called during graceful server shutdown.
   *
   * @returns Resolves when all connections are closed and resources are released
   */
  close(): Promise<void>;
}
