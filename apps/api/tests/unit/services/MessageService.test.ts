/**
 * @module MessageService.test
 *
 * Comprehensive unit tests for the MessageService class — manages encrypted
 * message send (with dedup), edit (15-min window), delete (tombstone), cursor-
 * paginated history, offline sync, status tracking, and batch read.
 *
 * Tests validate:
 * - R4  (Real-Time Message Integrity): clientMessageId dedup, ordering
 * - R12 (E2E Encryption Integrity): ciphertext treated as opaque blob
 * - R18 (Fan-Out via Queue): BullMQ enqueue for 3+ recipients
 * - R19 (Message Edit Integrity): sender-only, 15-minute window, no retention
 * - R20 (Message Delete as Tombstone): ciphertext nulled, row retained
 * - R13 (Offline Reconciliation): syncMessages retrieves missed messages
 * - R17 (Interface-Driven Dependencies): constructor receives interfaces only
 * - R22 (Standardized Error Responses): typed domain errors
 *
 * Coverage target: ≥80%
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Imports
 * ──────────────────────────────────────────────────────────────────────────── */

import { MessageService } from '../../../src/services/MessageService';
import type { IMessageRepository } from '../../../src/domain/interfaces/IMessageRepository';
import type { IConversationRepository } from '../../../src/domain/interfaces/IConversationRepository';
import type { ICacheProvider } from '../../../src/domain/interfaces/ICacheProvider';
import type { IQueueProvider } from '../../../src/domain/interfaces/IQueueProvider';
import { NotFoundError } from '../../../src/errors/NotFoundError';
import { AuthorizationError } from '../../../src/errors/AuthorizationError';
import { ValidationError } from '../../../src/errors/ValidationError';
import { MessageStatusEnum, MessageType } from '@kalle/shared';
import type { MessageResponse, MessageStatusUpdate } from '@kalle/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Mock Factories
 * ──────────────────────────────────────────────────────────────────────────── */

function createMockMessageRepository(): jest.Mocked<IMessageRepository> {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    findByConversation: jest.fn(),
    findAfterTimestamp: jest.fn(),
    findByClientMessageId: jest.fn(),
    updateStatus: jest.fn(),
    batchUpdateStatus: jest.fn(),
    setLinkPreview: jest.fn(),
  };
}

function createMockConversationRepository(): jest.Mocked<
  Pick<
    IConversationRepository,
    | 'create'
    | 'findById'
    | 'findByUserId'
    | 'findDirectConversation'
    | 'addParticipant'
    | 'removeParticipant'
    | 'updateParticipantRole'
    | 'updateParticipantSettings'
    | 'updateGroupDetails'
    | 'getParticipantIds'
    | 'isParticipant'
    | 'getUnreadCounts'
    | 'resetUnreadCount'
    | 'incrementUnreadCount'
  >
> {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    findByUserId: jest.fn(),
    findDirectConversation: jest.fn(),
    addParticipant: jest.fn(),
    removeParticipant: jest.fn(),
    updateParticipantRole: jest.fn(),
    updateParticipantSettings: jest.fn(),
    updateGroupDetails: jest.fn(),
    getParticipantIds: jest.fn(),
    isParticipant: jest.fn(),
    getUnreadCounts: jest.fn(),
    resetUnreadCount: jest.fn(),
    incrementUnreadCount: jest.fn(),
  };
}

function createMockCacheProvider(): jest.Mocked<ICacheProvider> {
  return {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    setNx: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    ttl: jest.fn(),
  };
}

function createMockQueueProvider(): jest.Mocked<IQueueProvider> {
  return {
    enqueue: jest.fn(),
    enqueueBulk: jest.fn(),
    scheduleRepeat: jest.fn(),
    removeRepeat: jest.fn(),
    getQueueDepth: jest.fn(),
    close: jest.fn(),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Test Data Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

const now = new Date();

function testMessageResponse(
  overrides?: Partial<MessageResponse>,
): MessageResponse {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    senderId: 'user-1',
    senderName: 'Test User',
    senderAvatar: 'https://example.com/avatar.jpg',
    ciphertext: 'base64ciphertext==',
    type: MessageType.TEXT,
    clientMessageId: 'client-msg-1',
    serverTimestamp: now.toISOString(),
    isEdited: false,
    editedAt: null,
    isDeleted: false,
    deletedAt: null,
    replyToMessageId: null,
    mediaId: null,
    linkPreview: null,
    status: MessageStatusEnum.SENT,
    ...overrides,
  } as MessageResponse;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Test Suite
 * ──────────────────────────────────────────────────────────────────────────── */

describe('MessageService', () => {
  let service: MessageService;
  let mockMessageRepo: jest.Mocked<IMessageRepository>;
  let mockConversationRepo: ReturnType<typeof createMockConversationRepository>;
  let mockCache: jest.Mocked<ICacheProvider>;
  let mockQueue: jest.Mocked<IQueueProvider>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockMessageRepo = createMockMessageRepository();
    mockConversationRepo = createMockConversationRepository();
    mockCache = createMockCacheProvider();
    mockQueue = createMockQueueProvider();

    service = new MessageService(
      mockMessageRepo,
      mockConversationRepo as unknown as IConversationRepository,
      mockCache,
      mockQueue,
    );

    // Common defaults: sender is a participant, 2 participants by default
    mockConversationRepo.isParticipant.mockResolvedValue(true);
    mockConversationRepo.getParticipantIds.mockResolvedValue([
      'user-1',
      'user-2',
    ]);
    mockConversationRepo.incrementUnreadCount.mockResolvedValue(undefined);
    mockConversationRepo.resetUnreadCount.mockResolvedValue(undefined);
    mockCache.get.mockResolvedValue(null); // No cached participants
    mockCache.set.mockResolvedValue(undefined);
    mockQueue.enqueue.mockResolvedValue({ id: 'job-1', name: 'test-job', createdAt: Date.now() });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // sendMessage (R4, R12, R18)
  // ─────────────────────────────────────────────────────────────────────────

  describe('sendMessage', () => {
    const baseSendParams = {
      conversationId: 'conv-1',
      senderId: 'user-1',
      senderName: 'Test User',
      ciphertext: 'base64ciphertext==',
      type: MessageType.TEXT,
      clientMessageId: 'client-msg-1',
    };

    beforeEach(() => {
      mockMessageRepo.findByClientMessageId.mockResolvedValue(null);
      mockMessageRepo.create.mockResolvedValue(testMessageResponse());
    });

    it('should verify sender is a conversation participant', async () => {
      await service.sendMessage(baseSendParams);

      expect(mockConversationRepo.isParticipant).toHaveBeenCalledWith(
        'conv-1',
        'user-1',
      );
    });

    it('should throw AuthorizationError if sender is not a participant', async () => {
      mockConversationRepo.isParticipant.mockResolvedValue(false);

      await expect(service.sendMessage(baseSendParams)).rejects.toThrow(
        AuthorizationError,
      );
    });

    it('should return existing message for duplicate clientMessageId (R4 dedup)', async () => {
      const existing = testMessageResponse({ id: 'msg-existing' });
      mockMessageRepo.findByClientMessageId.mockResolvedValue(existing);

      const result = await service.sendMessage(baseSendParams);

      expect(result.id).toBe('msg-existing');
      expect(mockMessageRepo.create).not.toHaveBeenCalled();
    });

    it('should create a new message with ciphertext (R12 opaque blob)', async () => {
      await service.sendMessage(baseSendParams);

      expect(mockMessageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          senderId: 'user-1',
          senderName: 'Test User',
          ciphertext: 'base64ciphertext==',
          type: MessageType.TEXT,
          clientMessageId: 'client-msg-1',
        }),
      );
    });

    it('should increment unread counts for other participants', async () => {
      await service.sendMessage(baseSendParams);

      expect(mockConversationRepo.incrementUnreadCount).toHaveBeenCalledWith(
        'conv-1',
        'user-1',
      );
    });

    it('should NOT enqueue fan-out for 1:1 conversations (<3 participants) (R18)', async () => {
      // Default: 2 participants
      await service.sendMessage(baseSendParams);

      expect(mockQueue.enqueue).not.toHaveBeenCalledWith(
        'message-fanout',
        expect.anything(),
        expect.anything(),
      );
    });

    it('should enqueue fan-out for group conversations (≥3 participants) (R18)', async () => {
      mockConversationRepo.getParticipantIds.mockResolvedValue([
        'user-1',
        'user-2',
        'user-3',
      ]);

      await service.sendMessage(baseSendParams);

      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        'message-fanout',
        expect.objectContaining({
          messageId: 'msg-1',
          conversationId: 'conv-1',
          senderId: 'user-1',
          recipientIds: ['user-2', 'user-3'],
        }),
        expect.any(Object),
      );
    });

    it('should enqueue link-preview job when ciphertext matches URL pattern', async () => {
      const paramsWithUrl = {
        ...baseSendParams,
        ciphertext: 'https://example.com/page',
      };
      mockMessageRepo.create.mockResolvedValue(
        testMessageResponse({ ciphertext: 'https://example.com/page' }),
      );

      await service.sendMessage(paramsWithUrl);

      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        'link-preview',
        expect.objectContaining({ messageId: 'msg-1', conversationId: 'conv-1' }),
        expect.any(Object),
      );
    });

    it('should NOT enqueue link-preview for non-URL ciphertext', async () => {
      await service.sendMessage(baseSendParams);

      expect(mockQueue.enqueue).not.toHaveBeenCalledWith(
        'link-preview',
        expect.anything(),
        expect.anything(),
      );
    });

    it('should use cached participant IDs when available', async () => {
      mockCache.get.mockResolvedValue(['user-1', 'user-2', 'user-3']);

      await service.sendMessage(baseSendParams);

      expect(mockConversationRepo.getParticipantIds).not.toHaveBeenCalled();
      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        'message-fanout',
        expect.anything(),
        expect.anything(),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // editMessage (R19)
  // ─────────────────────────────────────────────────────────────────────────

  describe('editMessage', () => {
    const recentTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago

    beforeEach(() => {
      mockMessageRepo.findById.mockResolvedValue(
        testMessageResponse({
          senderId: 'user-1',
          serverTimestamp: recentTimestamp,
          isDeleted: false,
        }),
      );
      mockMessageRepo.update.mockResolvedValue(
        testMessageResponse({
          ciphertext: 'newCiphertext==',
          isEdited: true,
          editedAt: now.toISOString(),
        }),
      );
    });

    it('should replace ciphertext and mark as edited (R19)', async () => {
      const result = await service.editMessage({
        messageId: 'msg-1',
        senderId: 'user-1',
        newCiphertext: 'newCiphertext==',
      });

      expect(mockMessageRepo.update).toHaveBeenCalledWith(
        'msg-1',
        expect.objectContaining({
          ciphertext: 'newCiphertext==',
          isEdited: true,
        }),
      );
      expect(result.isEdited).toBe(true);
    });

    it('should throw NotFoundError if message does not exist', async () => {
      mockMessageRepo.findById.mockResolvedValue(null);

      await expect(
        service.editMessage({
          messageId: 'nonexistent',
          senderId: 'user-1',
          newCiphertext: 'x',
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw AuthorizationError if requester is not the sender (R19)', async () => {
      await expect(
        service.editMessage({
          messageId: 'msg-1',
          senderId: 'user-2',
          newCiphertext: 'x',
        }),
      ).rejects.toThrow(AuthorizationError);
    });

    it('should throw ValidationError if edit window (15 min) has expired (R19)', async () => {
      mockMessageRepo.findById.mockResolvedValue(
        testMessageResponse({
          senderId: 'user-1',
          serverTimestamp: new Date(
            Date.now() - 16 * 60 * 1000,
          ).toISOString(), // 16 min ago
        }),
      );

      await expect(
        service.editMessage({
          messageId: 'msg-1',
          senderId: 'user-1',
          newCiphertext: 'x',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError if message is a tombstone (R20)', async () => {
      mockMessageRepo.findById.mockResolvedValue(
        testMessageResponse({
          senderId: 'user-1',
          isDeleted: true,
          serverTimestamp: recentTimestamp,
        }),
      );

      await expect(
        service.editMessage({
          messageId: 'msg-1',
          senderId: 'user-1',
          newCiphertext: 'x',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('should NOT retain original ciphertext after edit (R19)', async () => {
      await service.editMessage({
        messageId: 'msg-1',
        senderId: 'user-1',
        newCiphertext: 'replacedCiphertext==',
      });

      const updateArgs = mockMessageRepo.update.mock.calls[0];
      expect(updateArgs[1].ciphertext).toBe('replacedCiphertext==');
      // No originalCiphertext field in the update data
      expect(updateArgs[1]).not.toHaveProperty('originalCiphertext');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // deleteMessage (R20)
  // ─────────────────────────────────────────────────────────────────────────

  describe('deleteMessage', () => {
    beforeEach(() => {
      mockMessageRepo.findById.mockResolvedValue(
        testMessageResponse({ senderId: 'user-1', isDeleted: false }),
      );
      mockMessageRepo.softDelete.mockResolvedValue(
        testMessageResponse({
          ciphertext: null as unknown as string,
          isDeleted: true,
          deletedAt: now.toISOString(),
        }),
      );
    });

    it('should soft-delete with ciphertext=null and isDeleted=true (R20)', async () => {
      const result = await service.deleteMessage({
        messageId: 'msg-1',
        senderId: 'user-1',
      });

      expect(mockMessageRepo.softDelete).toHaveBeenCalledWith(
        'msg-1',
        expect.objectContaining({
          ciphertext: null,
          isDeleted: true,
        }),
      );
      expect(result.isDeleted).toBe(true);
    });

    it('should throw NotFoundError if message does not exist', async () => {
      mockMessageRepo.findById.mockResolvedValue(null);

      await expect(
        service.deleteMessage({ messageId: 'nonexistent', senderId: 'user-1' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw AuthorizationError if requester is not the sender (R20)', async () => {
      await expect(
        service.deleteMessage({ messageId: 'msg-1', senderId: 'user-2' }),
      ).rejects.toThrow(AuthorizationError);
    });

    it('should be idempotent — return existing tombstone if already deleted', async () => {
      const tombstone = testMessageResponse({
        senderId: 'user-1',
        isDeleted: true,
        ciphertext: null as unknown as string,
      });
      mockMessageRepo.findById.mockResolvedValue(tombstone);

      const result = await service.deleteMessage({
        messageId: 'msg-1',
        senderId: 'user-1',
      });

      expect(result.isDeleted).toBe(true);
      expect(mockMessageRepo.softDelete).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getMessageHistory
  // ─────────────────────────────────────────────────────────────────────────

  describe('getMessageHistory', () => {
    const paginatedResult = {
      items: [testMessageResponse()],
      cursor: 'cursor-abc',
      hasMore: true,
    };

    beforeEach(() => {
      mockMessageRepo.findByConversation.mockResolvedValue(paginatedResult);
    });

    it('should throw AuthorizationError if user is not a participant', async () => {
      mockConversationRepo.isParticipant.mockResolvedValue(false);

      await expect(
        service.getMessageHistory({
          conversationId: 'conv-1',
          userId: 'user-1',
        }),
      ).rejects.toThrow(AuthorizationError);
    });

    it('should return cursor-paginated message history', async () => {
      const result = await service.getMessageHistory({
        conversationId: 'conv-1',
        userId: 'user-1',
      });

      expect(result.items).toHaveLength(1);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe('cursor-abc');
    });

    it('should use default limit of 50 when not provided', async () => {
      await service.getMessageHistory({
        conversationId: 'conv-1',
        userId: 'user-1',
      });

      expect(mockMessageRepo.findByConversation).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
      );
    });

    it('should pass custom cursor and limit to repository', async () => {
      await service.getMessageHistory({
        conversationId: 'conv-1',
        userId: 'user-1',
        cursor: 'custom-cursor',
        limit: 25,
      });

      expect(mockMessageRepo.findByConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          cursor: 'custom-cursor',
          limit: 25,
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // syncMessages (R13)
  // ─────────────────────────────────────────────────────────────────────────

  describe('syncMessages', () => {
    const afterTimestamp = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const missedMessages = [
      testMessageResponse({ id: 'msg-1' }),
      testMessageResponse({ id: 'msg-2' }),
    ];

    beforeEach(() => {
      mockMessageRepo.findAfterTimestamp.mockResolvedValue(missedMessages);
    });

    it('should return missed messages from authorized conversations (R13)', async () => {
      const result = await service.syncMessages({
        userId: 'user-1',
        conversationIds: ['conv-1'],
        afterTimestamp,
      });

      expect(result).toHaveLength(2);
      expect(mockMessageRepo.findAfterTimestamp).toHaveBeenCalledWith(
        ['conv-1'],
        afterTimestamp,
        undefined,
      );
    });

    it('should filter out non-participant conversations silently', async () => {
      mockConversationRepo.isParticipant
        .mockResolvedValueOnce(true)    // conv-1: authorized
        .mockResolvedValueOnce(false);  // conv-2: not authorized

      await service.syncMessages({
        userId: 'user-1',
        conversationIds: ['conv-1', 'conv-2'],
        afterTimestamp,
      });

      expect(mockMessageRepo.findAfterTimestamp).toHaveBeenCalledWith(
        ['conv-1'], // conv-2 filtered out
        afterTimestamp,
        undefined,
      );
    });

    it('should return empty array if user is not a participant in any conversation', async () => {
      mockConversationRepo.isParticipant.mockResolvedValue(false);

      const result = await service.syncMessages({
        userId: 'user-1',
        conversationIds: ['conv-1'],
        afterTimestamp,
      });

      expect(result).toEqual([]);
      expect(mockMessageRepo.findAfterTimestamp).not.toHaveBeenCalled();
    });

    it('should pass limit parameter to repository', async () => {
      await service.syncMessages({
        userId: 'user-1',
        conversationIds: ['conv-1'],
        afterTimestamp,
        limit: 100,
      });

      expect(mockMessageRepo.findAfterTimestamp).toHaveBeenCalledWith(
        ['conv-1'],
        afterTimestamp,
        100,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // updateMessageStatus
  // ─────────────────────────────────────────────────────────────────────────

  describe('updateMessageStatus', () => {
    it('should delegate status update to repository', async () => {
      const statusUpdate: MessageStatusUpdate = {
        messageId: 'msg-1',
        userId: 'user-2',
        status: MessageStatusEnum.DELIVERED,
      } as MessageStatusUpdate;
      mockMessageRepo.updateStatus.mockResolvedValue(statusUpdate);

      const result = await service.updateMessageStatus({
        messageId: 'msg-1',
        userId: 'user-2',
        status: MessageStatusEnum.DELIVERED,
      });

      expect(result.status).toBe(MessageStatusEnum.DELIVERED);
      expect(mockMessageRepo.updateStatus).toHaveBeenCalledWith(
        'msg-1',
        'user-2',
        MessageStatusEnum.DELIVERED,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // batchMarkRead
  // ─────────────────────────────────────────────────────────────────────────

  describe('batchMarkRead', () => {
    beforeEach(() => {
      mockMessageRepo.batchUpdateStatus.mockResolvedValue(undefined);
    });

    it('should mark all messages as READ status', async () => {
      await service.batchMarkRead({
        messageIds: ['msg-1', 'msg-2', 'msg-3'],
        userId: 'user-2',
        conversationId: 'conv-1',
      });

      expect(mockMessageRepo.batchUpdateStatus).toHaveBeenCalledWith(
        ['msg-1', 'msg-2', 'msg-3'],
        'user-2',
        MessageStatusEnum.READ,
      );
    });

    it('should reset unread count for the user in the conversation', async () => {
      await service.batchMarkRead({
        messageIds: ['msg-1'],
        userId: 'user-2',
        conversationId: 'conv-1',
      });

      expect(mockConversationRepo.resetUnreadCount).toHaveBeenCalledWith(
        'conv-1',
        'user-2',
      );
    });
  });
});
