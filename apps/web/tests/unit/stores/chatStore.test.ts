/**
 * @module chatStore.test
 *
 * Unit tests for the chatStore Zustand store — the most complex frontend store
 * managing conversations, messages, message lifecycle (edit/delete), unread
 * counts, archive/mute, and offline sync state.
 *
 * Test phases:
 *  1. Conversation CRUD (setConversations sorting, add, update, remove)
 *  2. Message Lifecycle (R4 dedup/order, R19 edit, R20 tombstone, status advancement)
 *  3. Unread Counts (increment, reset, setActiveConversation auto-reset)
 *  4. Archive / Mute operations
 *  5. Pagination State (hasMoreMessages, messageCursors)
 *  6. Bulk Operations — R13 Offline Sync (addMessages merge/dedup/sort)
 *  7. Selector Tests (selectMessages, selectActiveConversation, selectUnreadCount,
 *     selectTotalUnreadCount, selectVisibleConversations)
 *  8. clearAll / clearChat reset operations
 *
 * @see AAP Rule R4  — Real-time Message Integrity
 * @see AAP Rule R13 — Offline Reconciliation
 * @see AAP Rule R19 — Message Edit Integrity
 * @see AAP Rule R20 — Message Delete as Tombstone
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConversationListItem, MessageResponse, MuteSettings } from '@kalle/shared';
import { MessageStatusEnum, MessageType, ConversationType } from '@kalle/shared';

import {
  useChatStore,
  selectMessages,
  selectActiveConversation,
  selectUnreadCount,
  selectTotalUnreadCount,
  selectVisibleConversations,
} from '@/stores/chatStore';

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

let messageSeq = 0;
let conversationSeq = 0;

/**
 * Factory for creating MessageResponse test fixtures with sensible defaults.
 * Each call produces a unique message using an incrementing counter.
 */
function createMessage(overrides?: Partial<MessageResponse>): MessageResponse {
  messageSeq += 1;
  const ts = new Date(Date.UTC(2024, 0, 1, 12, 0, messageSeq)).toISOString();
  return {
    id: `msg-${messageSeq}`,
    conversationId: 'conv-default',
    senderId: 'user-sender',
    senderName: 'Alice',
    ciphertext: `encrypted-payload-${messageSeq}`,
    type: MessageType.TEXT,
    status: MessageStatusEnum.SENT,
    isEdited: false,
    isDeleted: false,
    clientMessageId: `client-msg-${messageSeq}`,
    serverTimestamp: ts,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

/**
 * Factory for creating ConversationListItem test fixtures with sensible defaults.
 * Each call produces a unique conversation using an incrementing counter.
 */
function createConversation(
  overrides?: Partial<ConversationListItem>,
): ConversationListItem {
  conversationSeq += 1;
  const ts = new Date(Date.UTC(2024, 0, 1, 12, 0, conversationSeq)).toISOString();
  return {
    id: `conv-${conversationSeq}`,
    type: ConversationType.DIRECT,
    displayName: `Contact ${conversationSeq}`,
    avatar: `https://example.com/avatar-${conversationSeq}.png`,
    unreadCount: 0,
    isArchived: false,
    isMuted: false,
    lastMessage: {
      senderName: 'Alice',
      ciphertext: `last-cipher-${conversationSeq}`,
      type: MessageType.TEXT,
      serverTimestamp: ts,
      isDeleted: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('chatStore', () => {
  beforeEach(() => {
    useChatStore.getState().clearAll();
    messageSeq = 0;
    conversationSeq = 0;
  });

  // =========================================================================
  // Phase 1: Conversation CRUD Tests
  // =========================================================================

  describe('Phase 1 — Conversation CRUD', () => {
    describe('setConversations', () => {
      it('should replace conversations array and sort by lastMessage.serverTimestamp descending', () => {
        const c1 = createConversation({
          id: 'c1',
          lastMessage: {
            senderName: 'A',
            ciphertext: 'c',
            type: MessageType.TEXT,
            serverTimestamp: '2024-01-01T10:00:00Z',
            isDeleted: false,
          },
        });
        const c2 = createConversation({
          id: 'c2',
          lastMessage: {
            senderName: 'B',
            ciphertext: 'c',
            type: MessageType.TEXT,
            serverTimestamp: '2024-01-01T12:00:00Z',
            isDeleted: false,
          },
        });
        const c3 = createConversation({
          id: 'c3',
          lastMessage: {
            senderName: 'C',
            ciphertext: 'c',
            type: MessageType.TEXT,
            serverTimestamp: '2024-01-01T08:00:00Z',
            isDeleted: false,
          },
        });

        useChatStore.getState().setConversations([c1, c2, c3]);
        const state = useChatStore.getState();

        expect(state.conversations).toHaveLength(3);
        expect(state.conversations[0].id).toBe('c2');
        expect(state.conversations[1].id).toBe('c1');
        expect(state.conversations[2].id).toBe('c3');
      });
    });

    describe('addConversation', () => {
      it('should insert a conversation and re-sort by lastMessage timestamp', () => {
        const c1 = createConversation({
          id: 'c1',
          lastMessage: {
            senderName: 'A',
            ciphertext: 'c',
            type: MessageType.TEXT,
            serverTimestamp: '2024-01-01T12:00:00Z',
            isDeleted: false,
          },
        });
        const c2 = createConversation({
          id: 'c2',
          lastMessage: {
            senderName: 'B',
            ciphertext: 'c',
            type: MessageType.TEXT,
            serverTimestamp: '2024-01-01T08:00:00Z',
            isDeleted: false,
          },
        });

        useChatStore.getState().setConversations([c1, c2]);

        const c3 = createConversation({
          id: 'c3',
          lastMessage: {
            senderName: 'C',
            ciphertext: 'c',
            type: MessageType.TEXT,
            serverTimestamp: '2024-01-01T10:00:00Z',
            isDeleted: false,
          },
        });

        useChatStore.getState().addConversation(c3);
        const state = useChatStore.getState();

        expect(state.conversations).toHaveLength(3);
        expect(state.conversations[0].id).toBe('c1');
        expect(state.conversations[1].id).toBe('c3');
        expect(state.conversations[2].id).toBe('c2');
      });
    });

    describe('updateConversation', () => {
      it('should merge partial updates into an existing conversation', () => {
        const conv = createConversation({ id: 'upd-1', displayName: 'Original Name' });
        useChatStore.getState().setConversations([conv]);

        useChatStore.getState().updateConversation('upd-1', { displayName: 'Updated Name' });
        const state = useChatStore.getState();

        const found = state.conversations.find((c) => c.id === 'upd-1');
        expect(found).toBeDefined();
        expect(found!.displayName).toBe('Updated Name');
        expect(found!.type).toBe(ConversationType.DIRECT);
        expect(found!.isArchived).toBe(false);
      });
    });

    describe('removeConversation', () => {
      it('should remove the conversation and clean up related state', () => {
        const conv = createConversation({ id: 'rem-1' });
        useChatStore.getState().setConversations([conv]);

        const msg = createMessage({ conversationId: 'rem-1', clientMessageId: 'rem-msg-1' });
        useChatStore.getState().addMessage('rem-1', msg);
        useChatStore.getState().incrementUnread('rem-1');

        useChatStore.getState().removeConversation('rem-1');
        const state = useChatStore.getState();

        expect(state.conversations.find((c) => c.id === 'rem-1')).toBeUndefined();
        expect(state.messages.has('rem-1')).toBe(false);
        expect(state.unreadCounts.has('rem-1')).toBe(false);
      });
    });
  });

  // =========================================================================
  // Phase 2: Message Lifecycle Tests
  // =========================================================================

  describe('Phase 2 — Message Lifecycle', () => {
    describe('addMessage — R4 deduplication and ordering', () => {
      it('should deduplicate by clientMessageId — same message twice results in single entry', () => {
        const convId = 'conv-dedup';
        const conv = createConversation({ id: convId });
        useChatStore.getState().setConversations([conv]);

        const msg = createMessage({
          conversationId: convId,
          clientMessageId: 'abc123',
          serverTimestamp: '2024-01-01T10:00:00Z',
        });

        useChatStore.getState().addMessage(convId, msg);
        useChatStore.getState().addMessage(convId, { ...msg, id: 'msg-duplicate' });

        const messages = useChatStore.getState().messages.get(convId) ?? [];
        expect(messages).toHaveLength(1);
      });

      it('should maintain ascending serverTimestamp order (R4)', () => {
        const convId = 'conv-order';
        const conv = createConversation({ id: convId });
        useChatStore.getState().setConversations([conv]);

        const msg10 = createMessage({
          conversationId: convId,
          clientMessageId: 'cm-10',
          serverTimestamp: '2024-01-01T10:00:00Z',
        });
        const msg09 = createMessage({
          conversationId: convId,
          clientMessageId: 'cm-09',
          serverTimestamp: '2024-01-01T09:00:00Z',
        });
        const msg11 = createMessage({
          conversationId: convId,
          clientMessageId: 'cm-11',
          serverTimestamp: '2024-01-01T11:00:00Z',
        });

        useChatStore.getState().addMessage(convId, msg10);
        useChatStore.getState().addMessage(convId, msg09);
        useChatStore.getState().addMessage(convId, msg11);

        const messages = useChatStore.getState().messages.get(convId) ?? [];
        expect(messages).toHaveLength(3);
        expect(messages[0].serverTimestamp).toBe('2024-01-01T09:00:00Z');
        expect(messages[1].serverTimestamp).toBe('2024-01-01T10:00:00Z');
        expect(messages[2].serverTimestamp).toBe('2024-01-01T11:00:00Z');
      });

      it('should update conversation lastMessage and re-sort conversation list', () => {
        const cOlder = createConversation({
          id: 'conv-older',
          lastMessage: {
            senderName: 'A',
            ciphertext: 'c',
            type: MessageType.TEXT,
            serverTimestamp: '2024-01-01T08:00:00Z',
            isDeleted: false,
          },
        });
        const cNewer = createConversation({
          id: 'conv-newer',
          lastMessage: {
            senderName: 'B',
            ciphertext: 'c',
            type: MessageType.TEXT,
            serverTimestamp: '2024-01-01T12:00:00Z',
            isDeleted: false,
          },
        });

        useChatStore.getState().setConversations([cOlder, cNewer]);
        expect(useChatStore.getState().conversations[0].id).toBe('conv-newer');

        const newMsg = createMessage({
          conversationId: 'conv-older',
          clientMessageId: 'new-msg-for-older',
          serverTimestamp: '2024-01-01T15:00:00Z',
        });
        useChatStore.getState().addMessage('conv-older', newMsg);

        expect(useChatStore.getState().conversations[0].id).toBe('conv-older');
      });
    });

    describe('editMessage — R19', () => {
      it('should set new ciphertext, isEdited=true, editedAt without changing ordering', () => {
        const convId = 'conv-edit';
        const conv = createConversation({ id: convId });
        useChatStore.getState().setConversations([conv]);

        const msg1 = createMessage({
          id: 'em-1',
          conversationId: convId,
          clientMessageId: 'em-cm-1',
          serverTimestamp: '2024-01-01T09:00:00Z',
        });
        const msg2 = createMessage({
          id: 'em-2',
          conversationId: convId,
          clientMessageId: 'em-cm-2',
          serverTimestamp: '2024-01-01T10:00:00Z',
        });
        const msg3 = createMessage({
          id: 'em-3',
          conversationId: convId,
          clientMessageId: 'em-cm-3',
          serverTimestamp: '2024-01-01T11:00:00Z',
        });

        useChatStore.getState().addMessage(convId, msg1);
        useChatStore.getState().addMessage(convId, msg2);
        useChatStore.getState().addMessage(convId, msg3);

        const editedAt = '2024-01-01T10:05:00Z';
        useChatStore.getState().editMessage(convId, 'em-2', 'new-ciphertext', editedAt);

        const messages = useChatStore.getState().messages.get(convId) ?? [];
        expect(messages).toHaveLength(3);
        expect(messages[1].id).toBe('em-2');
        expect(messages[1].ciphertext).toBe('new-ciphertext');
        expect(messages[1].isEdited).toBe(true);
        expect(messages[1].editedAt).toBe(editedAt);
        expect(messages[0].id).toBe('em-1');
        expect(messages[2].id).toBe('em-3');
      });
    });

    describe('deleteMessage — R20 tombstone', () => {
      it('should set ciphertext=null, isDeleted=true and RETAIN the message row', () => {
        const convId = 'conv-del';
        const conv = createConversation({ id: convId });
        useChatStore.getState().setConversations([conv]);

        const msg = createMessage({
          id: 'dm-1',
          conversationId: convId,
          clientMessageId: 'dm-cm-1',
          ciphertext: 'original-cipher',
        });
        useChatStore.getState().addMessage(convId, msg);

        const deletedAt = '2024-01-01T12:30:00Z';
        useChatStore.getState().deleteMessage(convId, 'dm-1', deletedAt);

        const messages = useChatStore.getState().messages.get(convId) ?? [];
        expect(messages).toHaveLength(1);
        expect(messages[0].ciphertext).toBeNull();
        expect(messages[0].isDeleted).toBe(true);
        expect(messages[0].deletedAt).toBe(deletedAt);
      });
    });

    describe('updateMessageStatus', () => {
      it('should only advance status (SENT→DELIVERED→READ), never regress', () => {
        const convId = 'conv-status';
        const conv = createConversation({ id: convId });
        useChatStore.getState().setConversations([conv]);

        const msg = createMessage({
          id: 'sm-1',
          conversationId: convId,
          clientMessageId: 'sm-cm-1',
          status: MessageStatusEnum.SENT,
        });
        useChatStore.getState().addMessage(convId, msg);

        useChatStore.getState().updateMessageStatus(convId, 'sm-1', MessageStatusEnum.DELIVERED);
        let messages = useChatStore.getState().messages.get(convId) ?? [];
        expect(messages[0].status).toBe(MessageStatusEnum.DELIVERED);

        useChatStore.getState().updateMessageStatus(convId, 'sm-1', MessageStatusEnum.READ);
        messages = useChatStore.getState().messages.get(convId) ?? [];
        expect(messages[0].status).toBe(MessageStatusEnum.READ);

        useChatStore.getState().updateMessageStatus(convId, 'sm-1', MessageStatusEnum.SENT);
        messages = useChatStore.getState().messages.get(convId) ?? [];
        expect(messages[0].status).toBe(MessageStatusEnum.READ);

        useChatStore.getState().updateMessageStatus(convId, 'sm-1', MessageStatusEnum.DELIVERED);
        messages = useChatStore.getState().messages.get(convId) ?? [];
        expect(messages[0].status).toBe(MessageStatusEnum.READ);
      });
    });
  });

  // =========================================================================
  // Phase 3: Unread Count Tests
  // =========================================================================

  describe('Phase 3 — Unread Counts', () => {
    describe('incrementUnread / resetUnread', () => {
      it('should increment the unread count for a conversation', () => {
        const convId = 'conv-unread';
        useChatStore.getState().incrementUnread(convId);
        useChatStore.getState().incrementUnread(convId);
        useChatStore.getState().incrementUnread(convId);

        expect(useChatStore.getState().unreadCounts.get(convId)).toBe(3);
      });

      it('should reset the unread count to 0', () => {
        const convId = 'conv-reset';
        useChatStore.getState().incrementUnread(convId);
        useChatStore.getState().incrementUnread(convId);
        useChatStore.getState().incrementUnread(convId);
        useChatStore.getState().incrementUnread(convId);
        useChatStore.getState().incrementUnread(convId);

        useChatStore.getState().resetUnread(convId);

        expect(useChatStore.getState().unreadCounts.get(convId)).toBe(0);
      });
    });

    describe('setActiveConversation auto-reset', () => {
      it('should reset unread count when activating a conversation', () => {
        const conv = createConversation({ id: 'conv-active' });
        useChatStore.getState().setConversations([conv]);
        useChatStore.getState().incrementUnread('conv-active');
        useChatStore.getState().incrementUnread('conv-active');
        useChatStore.getState().incrementUnread('conv-active');

        expect(useChatStore.getState().unreadCounts.get('conv-active')).toBe(3);

        useChatStore.getState().setActiveConversation('conv-active');

        expect(useChatStore.getState().unreadCounts.get('conv-active')).toBe(0);
        expect(useChatStore.getState().activeConversationId).toBe('conv-active');
      });
    });
  });

  // =========================================================================
  // Phase 4: Archive / Mute Tests
  // =========================================================================

  describe('Phase 4 — Archive / Mute', () => {
    describe('archiveConversation', () => {
      it('should toggle the isArchived flag', () => {
        const conv = createConversation({ id: 'arch-1', isArchived: false });
        useChatStore.getState().setConversations([conv]);

        useChatStore.getState().archiveConversation('arch-1', true);
        let found = useChatStore.getState().conversations.find((c) => c.id === 'arch-1');
        expect(found!.isArchived).toBe(true);

        useChatStore.getState().archiveConversation('arch-1', false);
        found = useChatStore.getState().conversations.find((c) => c.id === 'arch-1');
        expect(found!.isArchived).toBe(false);
      });
    });

    describe('muteConversation', () => {
      it('should update the mute settings on a conversation', () => {
        const conv = createConversation({ id: 'mute-1', isMuted: false });
        useChatStore.getState().setConversations([conv]);

        const muteSettings: MuteSettings = { isMuted: true, muteExpiresAt: null };
        useChatStore.getState().muteConversation('mute-1', muteSettings);

        const found = useChatStore.getState().conversations.find((c) => c.id === 'mute-1');
        expect(found!.isMuted).toBe(true);
      });
    });
  });

  // =========================================================================
  // Phase 5: Pagination State Tests
  // =========================================================================

  describe('Phase 5 — Pagination State', () => {
    describe('setHasMoreMessages', () => {
      it('should store pagination state per conversation', () => {
        const convId = 'conv-page';
        useChatStore.getState().setHasMoreMessages(convId, true);

        expect(useChatStore.getState().hasMoreMessages.get(convId)).toBe(true);
      });
    });

    describe('setMessageCursor', () => {
      it('should store cursor per conversation', () => {
        const convId = 'conv-cursor';
        useChatStore.getState().setMessageCursor(convId, 'cursor-abc');

        expect(useChatStore.getState().messageCursors.get(convId)).toBe('cursor-abc');
      });
    });
  });

  // =========================================================================
  // Phase 6: Bulk Operations — R13 Offline Sync
  // =========================================================================

  describe('Phase 6 — Bulk Operations (R13 Offline Sync)', () => {
    describe('addMessages — merge, deduplicate, and sort', () => {
      it('should merge incoming with existing, deduplicate by clientMessageId, and sort by serverTimestamp', () => {
        const convId = 'conv-bulk';
        const conv = createConversation({ id: convId });
        useChatStore.getState().setConversations([conv]);

        const msg1 = createMessage({
          id: 'bulk-1',
          conversationId: convId,
          clientMessageId: 'bulk-cm-1',
          serverTimestamp: '2024-01-01T09:00:00Z',
        });
        const msg2 = createMessage({
          id: 'bulk-2',
          conversationId: convId,
          clientMessageId: 'bulk-cm-2',
          serverTimestamp: '2024-01-01T10:00:00Z',
        });
        const msg3 = createMessage({
          id: 'bulk-3',
          conversationId: convId,
          clientMessageId: 'bulk-cm-3',
          serverTimestamp: '2024-01-01T11:00:00Z',
        });
        const msg4 = createMessage({
          id: 'bulk-4',
          conversationId: convId,
          clientMessageId: 'bulk-cm-4',
          serverTimestamp: '2024-01-01T12:00:00Z',
        });

        useChatStore.getState().addMessage(convId, msg1);
        useChatStore.getState().addMessage(convId, msg2);

        useChatStore.getState().addMessages(convId, [msg2, msg3, msg4]);

        const messages = useChatStore.getState().messages.get(convId) ?? [];
        expect(messages).toHaveLength(4);
        expect(messages[0].clientMessageId).toBe('bulk-cm-1');
        expect(messages[1].clientMessageId).toBe('bulk-cm-2');
        expect(messages[2].clientMessageId).toBe('bulk-cm-3');
        expect(messages[3].clientMessageId).toBe('bulk-cm-4');
      });
    });
  });

  // =========================================================================
  // Phase 7: Selector Tests
  // =========================================================================

  describe('Phase 7 — Selectors', () => {
    describe('selectMessages', () => {
      it('should return messages for a specific conversation', () => {
        const convId = 'conv-sel-msg';
        const msg = createMessage({ conversationId: convId, clientMessageId: 'sel-cm-1' });
        useChatStore.getState().addMessage(convId, msg);

        const result = selectMessages(convId);
        expect(result).toHaveLength(1);
        expect(result[0].conversationId).toBe(convId);
      });

      it('should return empty array for unknown conversation', () => {
        expect(selectMessages('nonexistent')).toEqual([]);
      });
    });

    describe('selectActiveConversation', () => {
      it('should return the conversation matching activeConversationId', () => {
        const conv = createConversation({ id: 'sel-active' });
        useChatStore.getState().setConversations([conv]);
        useChatStore.getState().setActiveConversation('sel-active');

        const result = selectActiveConversation();
        expect(result).not.toBeNull();
        expect(result!.id).toBe('sel-active');
      });

      it('should return null when no conversation is active', () => {
        expect(selectActiveConversation()).toBeNull();
      });
    });

    describe('selectUnreadCount', () => {
      it('should return the unread count for a conversation', () => {
        useChatStore.getState().incrementUnread('sel-unread');
        useChatStore.getState().incrementUnread('sel-unread');

        expect(selectUnreadCount('sel-unread')).toBe(2);
      });

      it('should return 0 for unknown conversation', () => {
        expect(selectUnreadCount('unknown-conv')).toBe(0);
      });
    });

    describe('selectTotalUnreadCount', () => {
      it('should sum all unread counts across conversations', () => {
        useChatStore.getState().incrementUnread('conv-a');
        useChatStore.getState().incrementUnread('conv-a');
        useChatStore.getState().incrementUnread('conv-b');
        useChatStore.getState().incrementUnread('conv-c');
        useChatStore.getState().incrementUnread('conv-c');
        useChatStore.getState().incrementUnread('conv-c');

        expect(selectTotalUnreadCount()).toBe(6);
      });

      it('should return 0 when no unread messages exist', () => {
        expect(selectTotalUnreadCount()).toBe(0);
      });
    });

    describe('selectVisibleConversations', () => {
      it('should return only non-archived conversations', () => {
        const visible1 = createConversation({ id: 'vis-1', isArchived: false });
        const visible2 = createConversation({ id: 'vis-2', isArchived: false });
        const archived = createConversation({ id: 'arch-sel', isArchived: true });
        useChatStore.getState().setConversations([visible1, visible2, archived]);

        const result = selectVisibleConversations();
        expect(result).toHaveLength(2);
        expect(result.some((c) => c.id === 'arch-sel')).toBe(false);
      });
    });
  });

  // =========================================================================
  // Phase 8: clearAll / clearChat Tests
  // =========================================================================

  describe('Phase 8 — clearAll / clearChat', () => {
    describe('clearAll', () => {
      it('should reset entire store to initial state', () => {
        const conv = createConversation({ id: 'clear-conv' });
        useChatStore.getState().setConversations([conv]);
        const msg = createMessage({
          conversationId: 'clear-conv',
          clientMessageId: 'clear-msg-1',
        });
        useChatStore.getState().addMessage('clear-conv', msg);
        useChatStore.getState().setActiveConversation('clear-conv');
        useChatStore.getState().incrementUnread('clear-conv');
        useChatStore.getState().setHasMoreMessages('clear-conv', true);
        useChatStore.getState().setMessageCursor('clear-conv', 'cursor-x');

        useChatStore.getState().clearAll();
        const state = useChatStore.getState();

        expect(state.conversations).toEqual([]);
        expect(state.messages.size).toBe(0);
        expect(state.unreadCounts.size).toBe(0);
        expect(state.activeConversationId).toBeNull();
        expect(state.hasMoreMessages.size).toBe(0);
        expect(state.messageCursors.size).toBe(0);
      });
    });

    describe('clearChat', () => {
      it('should remove messages for a specific conversation only', () => {
        const msg1 = createMessage({
          conversationId: 'cc-1',
          clientMessageId: 'cc-cm-1',
        });
        const msg2 = createMessage({
          conversationId: 'cc-2',
          clientMessageId: 'cc-cm-2',
        });

        useChatStore.getState().addMessage('cc-1', msg1);
        useChatStore.getState().addMessage('cc-2', msg2);

        useChatStore.getState().clearChat('cc-1');

        expect(useChatStore.getState().messages.has('cc-1')).toBe(false);
        expect(useChatStore.getState().messages.has('cc-2')).toBe(true);
        expect((useChatStore.getState().messages.get('cc-2') ?? []).length).toBe(1);
      });
    });
  });

  // =========================================================================
  // Supplementary: Verify vi import is accessible (ensures vitest framework)
  // =========================================================================

  describe('vitest framework verification', () => {
    it('should have access to vi spy utilities from vitest', () => {
      const fn = vi.fn();
      fn('test');
      expect(fn).toHaveBeenCalledWith('test');
    });
  });
});
