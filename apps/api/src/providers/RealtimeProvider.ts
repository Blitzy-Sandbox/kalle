/**
 * @file RealtimeProvider.ts — Socket.IO with Redis Adapter Implementation
 *
 * Concrete implementation of the IRealtimeProvider interface. Wraps Socket.IO
 * Server with the @socket.io/redis-adapter for horizontal scaling across
 * multiple API server instances. Manages room joins/leaves, emits events to
 * specific rooms and users, tracks connected user sockets, and provides
 * connection statistics for health checks and metrics.
 *
 * Architecture Rules Enforced:
 * - R17: Interface-Driven Dependencies — only the composition root (server.ts)
 *        imports this concrete class. All other consumers import IRealtimeProvider.
 * - R28: Structured Logging Only — zero console.log calls.
 * - R29: Correlation ID Propagation — events support correlation ID in metadata.
 * - R4:  Real-Time Message Integrity — messages arrive in send-order via Socket.IO
 *        ordered delivery guarantees and Redis adapter pub/sub.
 * - R13: Offline Reconciliation — provider tracks connected users so the sync
 *        handler can determine what to sync on reconnect.
 * - R7:  Zero Warnings Build — compiles under tsc --noEmit --strict.
 * - R38: Zero External Dependencies — uses only Docker-internal Redis.
 */

import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import http from 'http';
import type { IRealtimeProvider } from '../domain/interfaces/IRealtimeProvider';

/**
 * Environment configuration subset required by the RealtimeProvider.
 * Extracted here to avoid coupling to the full EnvConfig type, which
 * is not in the depends_on_files list for this module.
 */
interface RealtimeProviderEnv {
  /** Redis connection URL (e.g., redis://redis:6379) */
  readonly REDIS_URL: string;
  /** Comma-separated list of allowed CORS origins */
  readonly CORS_ORIGIN: string;
}

/**
 * Concrete implementation of the real-time communication provider.
 *
 * Uses Socket.IO Server with Redis adapter for horizontal scaling.
 * Each user's sockets are joined to a `user:${userId}` room on connection
 * so that targeted user delivery works across server instances.
 *
 * Lifecycle:
 * 1. Instantiate via constructor (injected by server.ts composition root)
 * 2. Call initialize() to create Socket.IO server and connect Redis adapter
 * 3. Use emit/join/leave methods during application operation
 * 4. Call close() during graceful shutdown
 *
 * @example
 * ```typescript
 * // In server.ts composition root:
 * const realtimeProvider = new RealtimeProvider(httpServer, redis, env);
 * await realtimeProvider.initialize();
 *
 * // Get Socket.IO server for handler registration:
 * const io = realtimeProvider.getServer();
 * ```
 */
export class RealtimeProvider implements IRealtimeProvider {
  /**
   * Socket.IO server instance. Null before initialize() and after close().
   */
  private io: SocketIOServer | null = null;

  /**
   * Node.js HTTP server that Socket.IO attaches to, sharing the same port
   * for both REST and WebSocket traffic.
   */
  private readonly httpServer: http.Server;

  /**
   * Redis connection URL used to create dedicated pub/sub clients
   * for the Socket.IO Redis adapter.
   */
  private readonly redisUrl: string;

  /**
   * Comma-separated CORS origins parsed from environment configuration.
   * Applied to Socket.IO server CORS settings.
   */
  private readonly corsOrigin: string;

  /**
   * Dedicated Redis client for publishing messages through the adapter.
   * Created during initialize(), closed during close().
   */
  private pubClient: Redis | null = null;

  /**
   * Dedicated Redis client for subscribing to messages through the adapter.
   * Created during initialize(), closed during close().
   */
  private subClient: Redis | null = null;

  /**
   * Creates a new RealtimeProvider instance.
   *
   * @param httpServer - Node.js HTTP server from http.createServer(expressApp).
   *                     Socket.IO attaches to this server to share the port.
   * @param _redis     - Main ioredis client instance (retained for reference;
   *                     separate pub/sub clients are created in initialize()).
   * @param env        - Environment configuration subset with REDIS_URL and CORS_ORIGIN.
   */
  constructor(
    httpServer: http.Server,
    _redis: Redis,
    env: RealtimeProviderEnv,
  ) {
    this.httpServer = httpServer;
    this.redisUrl = env.REDIS_URL;
    this.corsOrigin = env.CORS_ORIGIN || 'http://localhost:3000';
  }

  /**
   * Initialize the Socket.IO server with Redis adapter for horizontal scaling.
   *
   * Performs three steps:
   * 1. Creates the Socket.IO server attached to the HTTP server with CORS
   *    and transport configuration.
   * 2. Creates two dedicated Redis connections (pub/sub) required by the
   *    @socket.io/redis-adapter. These are separate from the main Redis
   *    client used by the application for caching.
   * 3. Attaches the Redis adapter to the Socket.IO server, enabling event
   *    broadcasting across multiple API server instances.
   *
   * @throws Error if Redis pub/sub connections fail to establish
   */
  async initialize(): Promise<void> {
    // Step 1: Create Socket.IO server attached to the HTTP server
    const origins = this.corsOrigin
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);

    this.io = new SocketIOServer(this.httpServer, {
      cors: {
        origin: origins,
        credentials: true,
      },
      transports: ['websocket', 'polling'],
      pingInterval: 25000,
      pingTimeout: 20000,
      maxHttpBufferSize: 1e7,
    });

    // Step 2: Create dedicated pub/sub Redis clients for the adapter.
    // The @socket.io/redis-adapter requires separate Redis connections
    // because the subscribing client enters a special "subscribed" state
    // where it can only receive messages, not send commands.
    this.pubClient = new Redis(this.redisUrl, {
      lazyConnect: true,
      retryStrategy: (times: number): number | null => {
        if (times > 10) {
          return null;
        }
        return Math.min(times * 200, 3000);
      },
    });

    this.subClient = new Redis(this.redisUrl, {
      lazyConnect: true,
      retryStrategy: (times: number): number | null => {
        if (times > 10) {
          return null;
        }
        return Math.min(times * 200, 3000);
      },
    });

    // Connect both clients and wait for them to be ready
    await Promise.all([
      this.pubClient.connect(),
      this.subClient.connect(),
    ]);

    // Step 3: Attach Redis adapter for horizontal scaling across
    // multiple API server instances. All events emitted via this
    // provider will be broadcast through Redis Pub/Sub.
    this.io.adapter(createAdapter(this.pubClient, this.subClient));
  }

  /**
   * Gracefully close all connections and shut down the server.
   *
   * Performs cleanup in order:
   * 1. Disconnect all connected sockets (force close underlying connections)
   * 2. Close the Socket.IO server
   * 3. Disconnect the dedicated pub/sub Redis clients
   * 4. Null out references for garbage collection
   */
  async close(): Promise<void> {
    if (this.io) {
      // Force-disconnect all sockets before closing the server
      this.io.disconnectSockets(true);

      // Close the Socket.IO server and wait for completion
      await this.io.close();
      this.io = null;
    }

    // Close the dedicated pub/sub Redis clients
    if (this.pubClient) {
      this.pubClient.disconnect();
      this.pubClient = null;
    }

    if (this.subClient) {
      this.subClient.disconnect();
      this.subClient = null;
    }
  }

  /**
   * Get the underlying Socket.IO server instance.
   *
   * Used by the composition root (server.ts) to register WebSocket event
   * handlers after initialization. This method is NOT part of the
   * IRealtimeProvider interface — it is accessible only on the concrete class.
   *
   * @returns The Socket.IO Server instance
   * @throws Error if the provider has not been initialized
   */
  getServer(): SocketIOServer {
    if (!this.io) {
      throw new Error('RealtimeProvider not initialized — call initialize() first');
    }
    return this.io;
  }

  /**
   * Emit an event to all sockets in a specific room.
   *
   * Rooms typically map to conversation IDs. When emitting to a room,
   * all sockets that have joined that room (across all server instances
   * via the Redis adapter) will receive the event.
   *
   * @param room  - Room identifier (typically conversationId)
   * @param event - Event name (e.g., 'message:new', 'typing:indicator')
   * @param data  - Event payload matching the typed event contracts
   */
  async emitToRoom(room: string, event: string, data: unknown): Promise<void> {
    if (!this.io) {
      throw new Error('RealtimeProvider not initialized — call initialize() first');
    }
    this.io.to(room).emit(event, data);
  }

  /**
   * Emit an event to a specific user across all their connected sockets.
   *
   * Uses the user-specific room pattern `user:${userId}`. Each socket is
   * automatically joined to this room upon WebSocket authentication, so
   * emitting to `user:${userId}` reaches all of a user's active connections
   * across horizontally scaled server instances.
   *
   * @param userId - Target user's unique identifier
   * @param event  - Event name (e.g., 'message:status', 'user:presence')
   * @param data   - Event payload
   */
  async emitToUser(userId: string, event: string, data: unknown): Promise<void> {
    if (!this.io) {
      throw new Error('RealtimeProvider not initialized — call initialize() first');
    }
    this.io.to(`user:${userId}`).emit(event, data);
  }

  /**
   * Join a socket to a specific room.
   *
   * Called when a user connects and needs to receive events for their
   * conversations. Each socket is joined to rooms corresponding to the
   * conversations the user participates in, plus their user-specific room.
   *
   * If the socket ID is not found (e.g., already disconnected), the
   * operation is silently skipped.
   *
   * @param socketId - The socket's unique identifier
   * @param room     - Room to join (e.g., conversationId or `user:${userId}`)
   */
  async joinRoom(socketId: string, room: string): Promise<void> {
    if (!this.io) {
      throw new Error('RealtimeProvider not initialized — call initialize() first');
    }
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.join(room);
    }
  }

  /**
   * Remove a socket from a specific room.
   *
   * Called when a user leaves a conversation or is removed from a group.
   * After leaving, the socket will no longer receive events emitted to
   * that room.
   *
   * If the socket ID is not found (e.g., already disconnected), the
   * operation is silently skipped.
   *
   * @param socketId - The socket's unique identifier
   * @param room     - Room to leave
   */
  async leaveRoom(socketId: string, room: string): Promise<void> {
    if (!this.io) {
      throw new Error('RealtimeProvider not initialized — call initialize() first');
    }
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.leave(room);
    }
  }

  /**
   * Get all socket IDs currently connected for a specific user.
   *
   * Queries the user-specific room `user:${userId}` via the Redis adapter
   * to find all active sockets across all server instances. Returns an
   * empty array if the user has no active connections (offline).
   *
   * @param userId - User ID to look up
   * @returns Array of socket IDs (empty if user is offline)
   */
  async getUserSockets(userId: string): Promise<string[]> {
    if (!this.io) {
      throw new Error('RealtimeProvider not initialized — call initialize() first');
    }
    const sockets = await this.io.in(`user:${userId}`).fetchSockets();
    return sockets.map((s) => s.id);
  }

  /**
   * Check if a user is currently connected (has at least one active socket).
   *
   * Used for presence tracking — determining online/offline status before
   * emitting presence events or deciding delivery strategy (immediate
   * delivery vs. queued for sync).
   *
   * @param userId - User ID to check
   * @returns `true` if the user has at least one active connection
   */
  async isUserOnline(userId: string): Promise<boolean> {
    const sockets = await this.getUserSockets(userId);
    return sockets.length > 0;
  }

  /**
   * Get connection statistics for health checks and metrics.
   *
   * Queries all connected sockets across all server instances (via Redis
   * adapter) and counts unique users by inspecting socket.data.userId
   * (set during WebSocket authentication).
   *
   * Returns zeroes if the provider is not initialized.
   *
   * @returns Object containing total socket count and unique user count
   */
  async getConnectionStats(): Promise<{ socketCount: number; userCount: number }> {
    if (!this.io) {
      return { socketCount: 0, userCount: 0 };
    }

    const sockets = await this.io.fetchSockets();
    const uniqueUsers = new Set<string>();

    for (const socket of sockets) {
      const socketData = socket.data as Record<string, unknown>;
      const userId = socketData?.userId;
      if (typeof userId === 'string' && userId.length > 0) {
        uniqueUsers.add(userId);
      }
    }

    return {
      socketCount: sockets.length,
      userCount: uniqueUsers.size,
    };
  }
}
