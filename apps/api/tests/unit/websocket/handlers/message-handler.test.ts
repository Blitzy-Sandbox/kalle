/**
 * @file message-handler.test.ts
 * @description Unit tests for all 5 WebSocket message event handlers (R4, R12, R19, R20, R25).
 */
import { registerMessageHandlers } from '../../../../src/websocket/handlers/message-handler';
import type { MessageHandlerDeps } from '../../../../src/websocket/handlers/message-handler';

function makeMockSocket(): any {
  const handlers: Record<string, Function> = {};
  const toMock = { emit: jest.fn() };
  return {
    id: 'socket-1',
    data: { userId: 'user-1', correlationId: 'corr-1', displayName: 'Alice' },
    on: jest.fn((event: string, handler: Function) => { handlers[event] = handler; }),
    to: jest.fn().mockReturnValue(toMock),
    disconnect: jest.fn(),
    _handlers: handlers,
    _toMock: toMock,
  };
}

function makeDeps(overrides: Partial<MessageHandlerDeps> = {}): MessageHandlerDeps {
  return {
    messageService: {
      sendMessage: jest.fn().mockResolvedValue({
        id: 'msg-1', conversationId: 'conv-1', senderId: 'user-1',
        ciphertext: 'encrypted', type: 'TEXT', serverTimestamp: '2026-01-01T00:00:00Z',
        clientMessageId: 'client-1', isDeleted: false, isEdited: false,
      }),
      editMessage: jest.fn().mockResolvedValue({
        id: 'msg-1', conversationId: 'conv-1', ciphertext: 'new-encrypted',
        isEdited: true, editedAt: '2026-01-01T00:01:00Z',
      }),
      deleteMessage: jest.fn().mockResolvedValue({
        id: 'msg-1', conversationId: 'conv-1', isDeleted: true,
        deletedAt: '2026-01-01T00:02:00Z',
      }),
      updateMessageStatus: jest.fn().mockResolvedValue(undefined),
      batchMarkRead: jest.fn().mockResolvedValue(undefined),
    },
    conversationService: { getParticipantIds: jest.fn().mockResolvedValue(['user-1', 'user-2']) },
    cacheProvider: {
      get: jest.fn(), set: jest.fn(), del: jest.fn(), exists: jest.fn(),
      setNx: jest.fn(), incr: jest.fn(), expire: jest.fn(), ttl: jest.fn(),
    } as any,
    realtimeProvider: {
      initialize: jest.fn(), close: jest.fn(), emitToRoom: jest.fn(), emitToUser: jest.fn(),
      joinRoom: jest.fn(), leaveRoom: jest.fn(), getUserSockets: jest.fn(),
      isUserOnline: jest.fn(), getConnectionStats: jest.fn(),
    } as any,
    rateLimiter: {
      checkLimit: jest.fn().mockResolvedValue(true),
      cleanup: jest.fn().mockResolvedValue(undefined),
    },
    logger: {
      child: jest.fn().mockReturnThis(),
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    } as any,
    ...overrides,
  };
}

describe('registerMessageHandlers', () => {
  it('should register all 5 event listeners', () => {
    const socket = makeMockSocket();
    registerMessageHandlers(socket, makeDeps());
    const events = socket.on.mock.calls.map((c: any) => c[0]);
    expect(events).toEqual(expect.arrayContaining([
      'message:send', 'message:edit', 'message:delete', 'message:delivered', 'message:read',
    ]));
  });

  describe('message:send', () => {
    it('should call messageService.sendMessage and ack with success', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      registerMessageHandlers(socket, deps);
      const ack = jest.fn();
      await socket._handlers['message:send'](
        { conversationId: 'conv-1', ciphertext: 'cipher', clientMessageId: 'client-1', type: 'TEXT' },
        ack,
      );
      expect(deps.messageService.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: 'conv-1', senderId: 'user-1', ciphertext: 'cipher', clientMessageId: 'client-1',
      }));
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(socket.to).toHaveBeenCalledWith('conv-1');
      expect(socket._toMock.emit).toHaveBeenCalledWith('message:new', expect.anything());
    });

    it('should reject invalid payload (missing conversationId)', async () => {
      const socket = makeMockSocket();
      registerMessageHandlers(socket, makeDeps());
      const ack = jest.fn();
      await socket._handlers['message:send']({ ciphertext: 'cipher', clientMessageId: 'c-1' }, ack);
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });

    it('should disconnect on rate limit exceeded', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      (deps.rateLimiter.checkLimit as jest.Mock).mockResolvedValue(false);
      registerMessageHandlers(socket, deps);
      await socket._handlers['message:send']({ conversationId: 'conv-1', ciphertext: 'x', clientMessageId: 'c-1' });
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('should ack with error on service exception', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      (deps.messageService.sendMessage as jest.Mock).mockRejectedValue(new Error('Svc fail'));
      registerMessageHandlers(socket, deps);
      const ack = jest.fn();
      await socket._handlers['message:send'](
        { conversationId: 'conv-1', ciphertext: 'x', clientMessageId: 'c-1' },
        ack,
      );
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });
  });

  describe('message:edit', () => {
    it('should call editMessage and emit message:edited', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      registerMessageHandlers(socket, deps);
      const ack = jest.fn();
      await socket._handlers['message:edit']({ messageId: 'msg-1', ciphertext: 'new-cipher' }, ack);
      expect(deps.messageService.editMessage).toHaveBeenCalledWith({
        messageId: 'msg-1', senderId: 'user-1', newCiphertext: 'new-cipher',
      });
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(socket._toMock.emit).toHaveBeenCalledWith('message:edited', expect.anything());
    });

    it('should reject missing messageId', async () => {
      const socket = makeMockSocket();
      registerMessageHandlers(socket, makeDeps());
      const ack = jest.fn();
      await socket._handlers['message:edit']({ ciphertext: 'x' }, ack);
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });

    it('should disconnect on rate limit', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      (deps.rateLimiter.checkLimit as jest.Mock).mockResolvedValue(false);
      registerMessageHandlers(socket, deps);
      await socket._handlers['message:edit']({ messageId: 'msg-1', ciphertext: 'x' });
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('message:delete', () => {
    it('should call deleteMessage and emit message:deleted (R20)', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      registerMessageHandlers(socket, deps);
      const ack = jest.fn();
      await socket._handlers['message:delete']({ messageId: 'msg-1' }, ack);
      expect(deps.messageService.deleteMessage).toHaveBeenCalledWith({ messageId: 'msg-1', senderId: 'user-1' });
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(socket._toMock.emit).toHaveBeenCalledWith('message:deleted', expect.anything());
    });

    it('should reject missing messageId', async () => {
      const socket = makeMockSocket();
      registerMessageHandlers(socket, makeDeps());
      const ack = jest.fn();
      await socket._handlers['message:delete']({}, ack);
      expect(ack).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });
  });

  describe('message:delivered', () => {
    it('should update status and emit to room', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      registerMessageHandlers(socket, deps);
      await socket._handlers['message:delivered']({ messageId: 'msg-1', conversationId: 'conv-1' });
      expect(deps.messageService.updateMessageStatus).toHaveBeenCalledWith({
        messageId: 'msg-1', userId: 'user-1', status: 'DELIVERED',
      });
      expect(socket._toMock.emit).toHaveBeenCalledWith('message:status', expect.objectContaining({
        messageId: 'msg-1', status: 'DELIVERED',
      }));
    });

    it('should warn on invalid payload', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      registerMessageHandlers(socket, deps);
      await socket._handlers['message:delivered']({ messageId: '' });
      expect(deps.messageService.updateMessageStatus).not.toHaveBeenCalled();
    });

    it('should disconnect on rate limit', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      (deps.rateLimiter.checkLimit as jest.Mock).mockResolvedValue(false);
      registerMessageHandlers(socket, deps);
      await socket._handlers['message:delivered']({ messageId: 'msg-1', conversationId: 'conv-1' });
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('message:read', () => {
    it('should batch mark read and emit status for each message', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      registerMessageHandlers(socket, deps);
      await socket._handlers['message:read']({ messageIds: ['msg-1', 'msg-2'], conversationId: 'conv-1' });
      expect(deps.messageService.batchMarkRead).toHaveBeenCalledWith({ messageIds: ['msg-1', 'msg-2'], userId: 'user-1' });
      expect(socket._toMock.emit).toHaveBeenCalledTimes(2);
    });

    it('should warn on empty messageIds', async () => {
      const socket = makeMockSocket();
      registerMessageHandlers(socket, makeDeps());
      await socket._handlers['message:read']({ messageIds: [], conversationId: 'conv-1' });
    });

    it('should warn on invalid messageId entries', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      registerMessageHandlers(socket, deps);
      await socket._handlers['message:read']({ messageIds: ['', 123 as any], conversationId: 'conv-1' });
      expect(deps.messageService.batchMarkRead).not.toHaveBeenCalled();
    });

    it('should disconnect on rate limit', async () => {
      const socket = makeMockSocket();
      const deps = makeDeps();
      (deps.rateLimiter.checkLimit as jest.Mock).mockResolvedValue(false);
      registerMessageHandlers(socket, deps);
      await socket._handlers['message:read']({ messageIds: ['msg-1'], conversationId: 'conv-1' });
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });
  });
});
