/**
 * @file presence-handler.test.ts
 * @description Unit tests for presence handler (connect/disconnect lifecycle).
 */
import { registerPresenceHandlers } from '../../../../src/websocket/handlers/presence-handler';
import type { PresenceHandlerDeps } from '../../../../src/websocket/handlers/presence-handler';

function makeMockSocket(overrides: Record<string, unknown> = {}): any {
  const handlers: Record<string, Function> = {};
  return {
    id: 'socket-1',
    data: {
      userId: 'user-1',
      correlationId: 'corr-1',
      displayName: 'Alice',
      conversationRooms: ['room-a', 'room-b'],
      ...overrides,
    },
    on: jest.fn((event: string, handler: Function) => { handlers[event] = handler; }),
    disconnect: jest.fn(),
    _handlers: handlers,
  };
}

function makeDeps(overrides: Partial<PresenceHandlerDeps> = {}): PresenceHandlerDeps {
  return {
    userService: {
      updateOnlineStatus: jest.fn().mockResolvedValue(undefined),
    },
    cacheProvider: {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
      setNx: jest.fn().mockResolvedValue(true),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(true),
      ttl: jest.fn().mockResolvedValue(-1),
    },
    realtimeProvider: {
      initialize: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      emitToRoom: jest.fn().mockResolvedValue(undefined),
      emitToUser: jest.fn().mockResolvedValue(undefined),
      joinRoom: jest.fn().mockResolvedValue(undefined),
      leaveRoom: jest.fn().mockResolvedValue(undefined),
      getUserSockets: jest.fn().mockResolvedValue([]),
      isUserOnline: jest.fn().mockResolvedValue(false),
      getConnectionStats: jest.fn().mockResolvedValue({ socketCount: 0, userCount: 0 }),
    } as any,
    rateLimiter: {
      checkLimit: jest.fn().mockResolvedValue(true),
      cleanup: jest.fn().mockResolvedValue(undefined),
    },
    metricsService: {
      recordWsConnection: jest.fn(),
      recordWsDisconnection: jest.fn(),
      recordWsMessage: jest.fn(),
    },
    logger: {
      child: jest.fn().mockReturnThis(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as any,
    ...overrides,
  };
}

describe('registerPresenceHandlers', () => {
  it('should register disconnect listener', () => {
    const socket = makeMockSocket();
    const deps = makeDeps();
    registerPresenceHandlers(socket, deps);
    expect(socket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
  });

  describe('handleConnect (on registration)', () => {
    it('should mark user online, cache presence, join room, and emit', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      registerPresenceHandlers(socket, deps);
      // Allow the async handleConnect to complete
      await new Promise(r => setTimeout(r, 50));
      expect(deps.metricsService.recordWsConnection).toHaveBeenCalled();
      expect(deps.userService.updateOnlineStatus).toHaveBeenCalledWith({ userId: 'user-1', status: 'ONLINE' });
      expect(deps.cacheProvider.set).toHaveBeenCalledWith(
        'presence:user-1',
        expect.objectContaining({ status: 'online' }),
        300,
      );
      expect(deps.realtimeProvider.joinRoom).toHaveBeenCalledWith('socket-1', 'user:user-1');
      expect(deps.realtimeProvider.emitToRoom).toHaveBeenCalledWith(
        'user:user-1',
        'user:presence',
        expect.objectContaining({ userId: 'user-1', status: 'online' }),
      );
    });

    it('should not crash if handleConnect encounters an error', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      (deps.userService.updateOnlineStatus as jest.Mock).mockRejectedValue(new Error('DB down'));
      registerPresenceHandlers(socket, deps);
      await new Promise(r => setTimeout(r, 50));
      // Should log error, not throw
      expect(socket.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('handleDisconnect', () => {
    it('should mark user offline when last socket disconnects', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      // No remaining sockets (getUserSockets returns empty list)
      (deps.realtimeProvider.getUserSockets as jest.Mock).mockResolvedValue([]);
      registerPresenceHandlers(socket, deps);
      // Allow fire-and-forget handleConnect to complete
      await new Promise(r => setTimeout(r, 50));
      // Clear mocks from connect phase so we only see disconnect calls
      jest.clearAllMocks();
      // Re-mock getUserSockets for the disconnect call
      (deps.realtimeProvider.getUserSockets as jest.Mock).mockResolvedValue([]);
      (deps.userService.updateOnlineStatus as jest.Mock).mockResolvedValue(undefined);
      (deps.cacheProvider.del as jest.Mock).mockResolvedValue(undefined);
      (deps.cacheProvider.set as jest.Mock).mockResolvedValue(undefined);
      (deps.realtimeProvider.emitToRoom as jest.Mock).mockResolvedValue(undefined);
      (deps.rateLimiter.cleanup as jest.Mock).mockResolvedValue(undefined);
      // Trigger disconnect (handler is fire-and-forget via void)
      socket._handlers['disconnect']('transport close');
      // Allow async handleDisconnect to complete
      await new Promise(r => setTimeout(r, 50));
      expect(deps.metricsService.recordWsDisconnection).toHaveBeenCalled();
      expect(deps.userService.updateOnlineStatus).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', status: 'OFFLINE', lastSeen: expect.any(Date) }),
      );
      expect(deps.cacheProvider.del).toHaveBeenCalledWith('presence:user-1');
      expect(deps.cacheProvider.set).toHaveBeenCalledWith(
        'presence:user-1',
        expect.objectContaining({ status: 'offline' }),
        300,
      );
      // Should emit offline to personal room + conversation rooms
      expect(deps.realtimeProvider.emitToRoom).toHaveBeenCalledWith(
        'user:user-1',
        'user:presence',
        expect.objectContaining({ status: 'offline' }),
      );
      expect(deps.realtimeProvider.emitToRoom).toHaveBeenCalledWith(
        'room-a',
        'user:presence',
        expect.objectContaining({ status: 'offline' }),
      );
      expect(deps.realtimeProvider.emitToRoom).toHaveBeenCalledWith(
        'room-b',
        'user:presence',
        expect.objectContaining({ status: 'offline' }),
      );
      // Rate limiter cleanup
      expect(deps.rateLimiter.cleanup).toHaveBeenCalled();
    });

    it('should keep user online if other sockets remain (multi-tab)', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      registerPresenceHandlers(socket, deps);
      await new Promise(r => setTimeout(r, 50));
      // Clear mocks from connect phase
      jest.clearAllMocks();
      // Other socket still connected
      (deps.realtimeProvider.getUserSockets as jest.Mock).mockResolvedValue(['socket-1', 'socket-2']);
      (deps.rateLimiter.cleanup as jest.Mock).mockResolvedValue(undefined);
      // Trigger disconnect (fire-and-forget)
      socket._handlers['disconnect']('ping timeout');
      await new Promise(r => setTimeout(r, 50));
      // Should NOT mark offline since socket-2 is still connected
      expect(deps.userService.updateOnlineStatus).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'OFFLINE' }),
      );
      // But should still cleanup rate limiter
      expect(deps.rateLimiter.cleanup).toHaveBeenCalled();
    });

    it('should handle disconnect errors gracefully', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      registerPresenceHandlers(socket, deps);
      await new Promise(r => setTimeout(r, 50));
      jest.clearAllMocks();
      (deps.realtimeProvider.getUserSockets as jest.Mock).mockRejectedValue(new Error('Redis fail'));
      // Trigger disconnect (fire-and-forget)
      socket._handlers['disconnect']('transport error');
      await new Promise(r => setTimeout(r, 50));
      // Should not throw — errors are caught internally
    });

    it('should handle missing conversationRooms gracefully', async () => {
      const socket = makeMockSocket({ conversationRooms: undefined });
      const deps = makeDeps();
      (deps.realtimeProvider.getUserSockets as jest.Mock).mockResolvedValue([]);
      registerPresenceHandlers(socket, deps);
      // Allow fire-and-forget handleConnect to complete
      await new Promise(r => setTimeout(r, 50));
      jest.clearAllMocks();
      (deps.realtimeProvider.getUserSockets as jest.Mock).mockResolvedValue([]);
      (deps.userService.updateOnlineStatus as jest.Mock).mockResolvedValue(undefined);
      (deps.cacheProvider.del as jest.Mock).mockResolvedValue(undefined);
      (deps.cacheProvider.set as jest.Mock).mockResolvedValue(undefined);
      (deps.realtimeProvider.emitToRoom as jest.Mock).mockResolvedValue(undefined);
      (deps.rateLimiter.cleanup as jest.Mock).mockResolvedValue(undefined);
      // Trigger disconnect (fire-and-forget)
      socket._handlers['disconnect']('transport close');
      await new Promise(r => setTimeout(r, 50));
      // Should not crash even without conversationRooms
      expect(deps.rateLimiter.cleanup).toHaveBeenCalled();
    });
  });
});
