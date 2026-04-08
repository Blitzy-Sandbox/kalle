/**
 * @file typing-handler.test.ts
 * @description Unit tests for typing:start / typing:stop WebSocket handlers (R25).
 */
import { registerTypingHandlers } from '../../../../src/websocket/handlers/typing-handler';
import type { TypingHandlerDeps } from '../../../../src/websocket/handlers/typing-handler';

function makeMockSocket(): any {
  const handlers: Record<string, Function> = {};
  return {
    data: { userId: 'user-1', correlationId: 'corr-1', displayName: 'Alice' },
    on: jest.fn((event: string, handler: Function) => { handlers[event] = handler; }),
    disconnect: jest.fn(),
    _handlers: handlers,
  };
}

function makeDeps(overrides: Partial<TypingHandlerDeps> = {}): TypingHandlerDeps {
  return {
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

describe('registerTypingHandlers', () => {
  it('should register typing:start and typing:stop listeners', () => {
    const socket = makeMockSocket();
    const deps = makeDeps();
    registerTypingHandlers(socket, deps);
    expect(socket.on).toHaveBeenCalledWith('typing:start', expect.any(Function));
    expect(socket.on).toHaveBeenCalledWith('typing:stop', expect.any(Function));
  });

  describe('typing:start', () => {
    it('should emit typing indicator when not debounced', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      (deps.cacheProvider.exists as jest.Mock).mockResolvedValue(false);
      registerTypingHandlers(socket, deps);
      await socket._handlers['typing:start']({ conversationId: 'conv-1' });
      expect(deps.cacheProvider.setNx).toHaveBeenCalledWith('typing:conv-1:user-1', 'typing', 5);
      expect(deps.realtimeProvider.emitToRoom).toHaveBeenCalledWith(
        'conv-1',
        'typing:indicator',
        expect.objectContaining({ conversationId: 'conv-1', userId: 'user-1', isTyping: true }),
      );
    });

    it('should debounce when typing key already exists (refresh TTL only)', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      (deps.cacheProvider.exists as jest.Mock).mockResolvedValue(true);
      registerTypingHandlers(socket, deps);
      await socket._handlers['typing:start']({ conversationId: 'conv-1' });
      expect(deps.cacheProvider.expire).toHaveBeenCalledWith('typing:conv-1:user-1', 5);
      expect(deps.cacheProvider.setNx).not.toHaveBeenCalled();
      expect(deps.realtimeProvider.emitToRoom).not.toHaveBeenCalled();
    });

    it('should disconnect socket on rate limit exceeded (R25)', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      (deps.rateLimiter.checkLimit as jest.Mock).mockResolvedValue(false);
      registerTypingHandlers(socket, deps);
      await socket._handlers['typing:start']({ conversationId: 'conv-1' });
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(deps.realtimeProvider.emitToRoom).not.toHaveBeenCalled();
    });

    it('should log error but not disconnect on processing error', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      (deps.cacheProvider.exists as jest.Mock).mockRejectedValue(new Error('Redis fail'));
      registerTypingHandlers(socket, deps);
      await socket._handlers['typing:start']({ conversationId: 'conv-1' });
      expect(socket.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('typing:stop', () => {
    it('should delete key and emit isTyping false', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      registerTypingHandlers(socket, deps);
      await socket._handlers['typing:stop']({ conversationId: 'conv-1' });
      expect(deps.cacheProvider.del).toHaveBeenCalledWith('typing:conv-1:user-1');
      expect(deps.realtimeProvider.emitToRoom).toHaveBeenCalledWith(
        'conv-1',
        'typing:indicator',
        expect.objectContaining({ conversationId: 'conv-1', userId: 'user-1', isTyping: false }),
      );
    });

    it('should disconnect on rate limit exceeded for typing:stop', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      (deps.rateLimiter.checkLimit as jest.Mock).mockResolvedValue(false);
      registerTypingHandlers(socket, deps);
      await socket._handlers['typing:stop']({ conversationId: 'conv-1' });
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('should log error but not disconnect on processing error', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      (deps.cacheProvider.del as jest.Mock).mockRejectedValue(new Error('Redis fail'));
      registerTypingHandlers(socket, deps);
      await socket._handlers['typing:stop']({ conversationId: 'conv-1' });
      expect(socket.disconnect).not.toHaveBeenCalled();
    });
  });
});
