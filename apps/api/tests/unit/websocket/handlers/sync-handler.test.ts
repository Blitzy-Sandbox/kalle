/**
 * @file sync-handler.test.ts
 * @description Unit tests for the message:sync WebSocket handler (R4, R13, R25).
 */
import { registerSyncHandlers } from '../../../../src/websocket/handlers/sync-handler';
import type { SyncHandlerDeps } from '../../../../src/websocket/handlers/sync-handler';

function makeMockSocket(): any {
  const handlers: Record<string, Function> = {};
  return {
    id: 'socket-1',
    data: { userId: 'user-1', correlationId: 'corr-1' },
    on: jest.fn((event: string, handler: Function) => { handlers[event] = handler; }),
    disconnect: jest.fn(),
    _handlers: handlers,
  };
}

function makeDeps(overrides: Partial<SyncHandlerDeps> = {}): SyncHandlerDeps {
  return {
    messageService: {
      syncMessages: jest.fn().mockResolvedValue([
        { id: 'msg-1', conversationId: 'conv-1', senderId: 'user-2', ciphertext: 'cipher1', type: 'TEXT', serverTimestamp: '2026-01-01T00:00:01Z', isDeleted: false, isEdited: false },
        { id: 'msg-2', conversationId: 'conv-1', senderId: 'user-2', ciphertext: 'cipher2', type: 'TEXT', serverTimestamp: '2026-01-01T00:00:02Z', isDeleted: false, isEdited: false },
      ]),
      getMessageHistory: jest.fn().mockResolvedValue({ messages: [], cursor: undefined, hasMore: false }),
    },
    conversationService: {
      getConversations: jest.fn().mockResolvedValue([{ id: 'conv-1' }, { id: 'conv-2' }]),
    },
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

describe('registerSyncHandlers', () => {
  it('should register message:sync event listener', () => {
    const socket = makeMockSocket();
    registerSyncHandlers(socket, makeDeps());
    expect(socket.on).toHaveBeenCalledWith('message:sync', expect.any(Function));
  });

  it('should return missed messages for valid sync request', async () => {
    const socket = makeMockSocket();
    const deps = makeDeps();
    registerSyncHandlers(socket, deps);
    const ack = jest.fn();
    await socket._handlers['message:sync']({ lastMessageIds: { 'conv-1': 'ts-0' } }, ack);
    expect(deps.messageService.syncMessages).toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ id: 'msg-1' }),
            expect.objectContaining({ id: 'msg-2' }),
          ]),
          hasMore: false,
        }),
      }),
    );
  });

  it('should disconnect on rate limit exceed (R25)', async () => {
    const socket = makeMockSocket();
    const deps = makeDeps();
    (deps.rateLimiter.checkLimit as jest.Mock).mockResolvedValue(false);
    registerSyncHandlers(socket, deps);
    await socket._handlers['message:sync']({ lastMessageIds: { 'conv-1': 'ts' } });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('should reject invalid payload (missing lastMessageIds)', async () => {
    const socket = makeMockSocket();
    registerSyncHandlers(socket, makeDeps());
    const ack = jest.fn();
    await socket._handlers['message:sync']({}, ack);
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.objectContaining({ code: 'INVALID_PAYLOAD' }) }),
    );
  });

  it('should reject array payload for lastMessageIds', async () => {
    const socket = makeMockSocket();
    registerSyncHandlers(socket, makeDeps());
    const ack = jest.fn();
    await socket._handlers['message:sync']({ lastMessageIds: ['conv-1'] }, ack);
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.objectContaining({ code: 'INVALID_PAYLOAD' }) }),
    );
  });

  it('should handle empty sync request (zero conversations)', async () => {
    const socket = makeMockSocket();
    registerSyncHandlers(socket, makeDeps());
    const ack = jest.fn();
    await socket._handlers['message:sync']({ lastMessageIds: {} }, ack);
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ messages: [], hasMore: false }),
      }),
    );
  });

  it('should filter out conversations user is not a participant of', async () => {
    const socket = makeMockSocket();
    const deps = makeDeps();
    (deps.conversationService.getConversations as jest.Mock).mockResolvedValue([{ id: 'conv-1' }]);
    registerSyncHandlers(socket, deps);
    const ack = jest.fn();
    await socket._handlers['message:sync']({ lastMessageIds: { 'conv-1': 't', 'conv-other': 't' } }, ack);
    expect(deps.messageService.syncMessages).toHaveBeenCalledTimes(1);
    expect(deps.messageService.syncMessages).toHaveBeenCalledWith(
      expect.objectContaining({ conversationIds: ['conv-1'] }),
    );
  });

  it('should return empty when user is not participant of any requested conversations', async () => {
    const socket = makeMockSocket();
    const deps = makeDeps();
    (deps.conversationService.getConversations as jest.Mock).mockResolvedValue([]);
    registerSyncHandlers(socket, deps);
    const ack = jest.fn();
    await socket._handlers['message:sync']({ lastMessageIds: { 'conv-1': 't' } }, ack);
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ messages: [], hasMore: false }),
      }),
    );
  });

  it('should sort messages by serverTimestamp ascending (R4)', async () => {
    const socket = makeMockSocket();
    const deps = makeDeps();
    (deps.messageService.syncMessages as jest.Mock).mockResolvedValue([
      { id: 'b', conversationId: 'conv-1', senderId: 'u2', ciphertext: 'c', type: 'TEXT', serverTimestamp: '2026-01-01T00:00:05Z', isDeleted: false, isEdited: false },
      { id: 'a', conversationId: 'conv-1', senderId: 'u2', ciphertext: 'c', type: 'TEXT', serverTimestamp: '2026-01-01T00:00:01Z', isDeleted: false, isEdited: false },
    ]);
    registerSyncHandlers(socket, deps);
    const ack = jest.fn();
    await socket._handlers['message:sync']({ lastMessageIds: { 'conv-1': 't' } }, ack);
    const msgs = ack.mock.calls[0][0].data.messages;
    expect(msgs[0].id).toBe('a');
    expect(msgs[1].id).toBe('b');
  });

  it('should deduplicate messages by ID (R4)', async () => {
    const socket = makeMockSocket();
    const deps = makeDeps();
    (deps.conversationService.getConversations as jest.Mock).mockResolvedValue([{ id: 'conv-1' }, { id: 'conv-2' }]);
    (deps.messageService.syncMessages as jest.Mock).mockResolvedValue([
      { id: 'dup', conversationId: 'conv-1', senderId: 'u2', ciphertext: 'c', type: 'TEXT', serverTimestamp: '2026-01-01T00:00:01Z', isDeleted: false, isEdited: false },
    ]);
    registerSyncHandlers(socket, deps);
    const ack = jest.fn();
    await socket._handlers['message:sync']({ lastMessageIds: { 'conv-1': 't', 'conv-2': 't' } }, ack);
    const msgs = ack.mock.calls[0][0].data.messages;
    expect(msgs.filter((m: any) => m.id === 'dup').length).toBe(1);
  });

  it('should set hasMore=true when any conversation returns max limit messages', async () => {
    const socket = makeMockSocket();
    const deps = makeDeps();
    const bigResult = Array.from({ length: 500 }, (_, i) => ({
      id: `msg-${i}`, conversationId: 'conv-1', senderId: 'u2', ciphertext: 'c', type: 'TEXT',
      serverTimestamp: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`, isDeleted: false, isEdited: false,
    }));
    (deps.messageService.syncMessages as jest.Mock).mockResolvedValue(bigResult);
    registerSyncHandlers(socket, deps);
    const ack = jest.fn();
    await socket._handlers['message:sync']({ lastMessageIds: { 'conv-1': 't' } }, ack);
    expect(ack.mock.calls[0][0].data.hasMore).toBe(true);
  });

  it('should send error ack on service exception (does NOT disconnect)', async () => {
    const socket = makeMockSocket();
    const deps = makeDeps();
    (deps.conversationService.getConversations as jest.Mock).mockRejectedValue(new Error('DB down'));
    registerSyncHandlers(socket, deps);
    const ack = jest.fn();
    await socket._handlers['message:sync']({ lastMessageIds: { 'conv-1': 't' } }, ack);
    expect(ack).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.objectContaining({ code: 'SYNC_ERROR' }) }),
    );
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});
