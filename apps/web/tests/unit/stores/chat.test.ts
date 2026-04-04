/**
 * @module chat.test
 *
 * Unit tests for the chatStore Zustand store.
 *
 * Covers:
 * - Initial state verification
 * - Conversation CRUD (setConversations, addConversation, updateConversation, removeConversation)
 * - Active conversation management (setActiveConversation, unread reset)
 * - Message CRUD (setMessages, addMessage, addMessages)
 * - R4 — Message deduplication by clientMessageId and serverTimestamp ordering
 * - R13 — Offline reconciliation via addMessages bulk merge
 * - R19 — Message edit (ciphertext swap, isEdited/editedAt, serverTimestamp preserved)
 * - R20 — Message delete as tombstone (ciphertext nulled, isDeleted/deletedAt, row retained)
 * - Status advancement (SENT → DELIVERED → READ, never regress)
 * - Archive/mute conversation operations
 * - Unread count management (increment, reset, auto-increment on non-active)
 * - Loading/pagination state (hasMoreMessages, messageCursors)
 * - Cleanup (clearChat, clearAll)
 * - Derived selectors (selectMessages, selectActiveConversation, selectUnreadCount,
 *   selectTotalUnreadCount, selectVisibleConversations, selectArchivedConversations)
 *
 * @see AAP Section 0.7.1 Group 16 — Frontend State Management
 * @see AAP Rule R4 — Real-time Message Integrity
 * @see AAP Rule R13 — Offline Reconciliation
 * @see AAP Rule R19 — Message Edit Integrity
 * @see AAP Rule R20 — Message Delete as Tombstone
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageStatusEnum, MessageType, ConversationType } from '@kalle/shared';
import type { ConversationListItem, MessageResponse, MuteSettings } from '@kalle/shared';

// ---------------------------------------------------------------------------
// Import store under test
// ---------------------------------------------------------------------------

import {
  useChatStore,
  selectMessages,
  selectActiveConversation,
  selectUnreadCount,
  selectTotalUnreadCount,
  selectVisibleConversations,
  selectArchivedConversations,
} from '@/stores/chatStore';

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

let msgCounter = 0;
let convCounter = 0;

function makeMessage(overrides?: Partial<MessageResponse>): MessageResponse {
  msgCounter += 1;
  const now = new Date(Date.now() + msgCounter * 1000).toISOString();
  return {
    id: `msg-${msgCounter}`,
    conversationId: 'conv-1',
    senderId: 'user-1',
    senderName: 'Alice',
    ciphertext: `encrypted-content-${msgCounter}`,
    type: MessageType.TEXT,
    status: MessageStatusEnum.SENT,
    isEdited: false,
    isDeleted: false,
    clientMessageId: `client-${msgCounter}`,
    serverTimestamp: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeConversation(
  overrides?: Partial<ConversationListItem>,
): ConversationListItem {
  convCounter += 1;
  return {
    id: `conv-${convCounter}`,
    type: ConversationType.DIRECT,
    displayName: `Contact ${convCounter}`,
    avatar: `https://cdn.example.com/avatar-${convCounter}.png`,
    unreadCount: 0,
    isArchived: false,
    isMuted: false,
    lastMessage: {
      senderName: 'Alice',
      ciphertext: `latest-cipher-${convCounter}`,
      type: MessageType.TEXT,
      serverTimestamp: new Date(Date.now() + convCounter * 60000).toISOString(),
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
    // Reset store to initial state before each test
    useChatStore.getState().clearAll();
    msgCounter = 0;
    convCounter = 0;
  });

  // =========================================================================
  // Initial State
  // =========================================================================

  describe('initial state', () => {
    it('should have empty conversations and messages', () => {
      const state = useChatStore.getState();
      expect(state.conversations).toEqual([]);
      expect(state.activeConversationId).toBeNull();
      expect(state.messages.size).toBe(0);
      expect(state.unreadCounts.size).toBe(0);
      expect(state.isLoadingConversations).toBe(false);
      expect(state.isLoadingMessages).toBe(false);
      expect(state.hasMoreMessages.size).toBe(0);
      expect(state.messageCursors.size).toBe(0);
    });
  });

  // =========================================================================
  // Conversation CRUD
  // =========================================================================

  describe('setConversations()', () => {
    it('should replace the conversation list', () => {
      const convs = [makeConversation(), makeConversation()];
      useChatStore.getState().setConversations(convs);
      expect(useChatStore.getState().conversations).toHaveLength(2);
    });

    it('should sort conversations by lastMessage.serverTimestamp descending', () => {
      const older = makeConversation({
        id: 'old',
        lastMessage: {
          senderName: 'A',
          ciphertext: 'x',
          type: MessageType.TEXT,
          serverTimestamp: '2025-01-01T00:00:00Z',
          isDeleted: false,
        },
      });
      const newer = makeConversation({
        id: 'new',
        lastMessage: {
          senderName: 'B',
          ciphertext: 'y',
          type: MessageType.TEXT,
          serverTimestamp: '2025-06-01T00:00:00Z',
          isDeleted: false,
        },
      });

      useChatStore.getState().setConversations([older, newer]);

      const sorted = useChatStore.getState().conversations;
      expect(sorted[0].id).toBe('new');
      expect(sorted[1].id).toBe('old');
    });

    it('should initialise unread counts from conversation objects', () => {
      const conv = makeConversation({ id: 'c1', unreadCount: 5 });
      useChatStore.getState().setConversations([conv]);
      expect(useChatStore.getState().unreadCounts.get('c1')).toBe(5);
    });

    it('should not overwrite existing unread counts', () => {
      // Pre-set an unread count
      useChatStore.getState().incrementUnread('c1');
      useChatStore.getState().incrementUnread('c1');
      expect(useChatStore.getState().unreadCounts.get('c1')).toBe(2);

      // Now set conversations — should preserve the 2
      const conv = makeConversation({ id: 'c1', unreadCount: 0 });
      useChatStore.getState().setConversations([conv]);
      expect(useChatStore.getState().unreadCounts.get('c1')).toBe(2);
    });
  });

  describe('addConversation()', () => {
    it('should add a new conversation to the list', () => {
      const conv = makeConversation({ id: 'new-conv' });
      useChatStore.getState().addConversation(conv);
      expect(useChatStore.getState().conversations).toHaveLength(1);
      expect(useChatStore.getState().conversations[0].id).toBe('new-conv');
    });

    it('should not add a duplicate conversation', () => {
      const conv = makeConversation({ id: 'dup-conv' });
      useChatStore.getState().addConversation(conv);
      useChatStore.getState().addConversation(conv);
      expect(useChatStore.getState().conversations).toHaveLength(1);
    });

    it('should set unread count for the new conversation', () => {
      const conv = makeConversation({ id: 'c2', unreadCount: 3 });
      useChatStore.getState().addConversation(conv);
      expect(useChatStore.getState().unreadCounts.get('c2')).toBe(3);
    });
  });

  describe('updateConversation()', () => {
    it('should merge partial updates into an existing conversation', () => {
      const conv = makeConversation({ id: 'u-conv', displayName: 'Old Name' });
      useChatStore.getState().setConversations([conv]);

      useChatStore
        .getState()
        .updateConversation('u-conv', { displayName: 'New Name' });

      const updated = useChatStore
        .getState()
        .conversations.find((c) => c.id === 'u-conv');
      expect(updated?.displayName).toBe('New Name');
    });

    it('should re-sort when lastMessage is updated', () => {
      const conv1 = makeConversation({
        id: 'c1',
        lastMessage: {
          senderName: 'A',
          ciphertext: 'x',
          type: MessageType.TEXT,
          serverTimestamp: '2025-06-01T00:00:00Z',
          isDeleted: false,
        },
      });
      const conv2 = makeConversation({
        id: 'c2',
        lastMessage: {
          senderName: 'B',
          ciphertext: 'y',
          type: MessageType.TEXT,
          serverTimestamp: '2025-01-01T00:00:00Z',
          isDeleted: false,
        },
      });
      useChatStore.getState().setConversations([conv1, conv2]);

      // c1 should be first (newer)
      expect(useChatStore.getState().conversations[0].id).toBe('c1');

      // Update c2 with a newer message
      useChatStore.getState().updateConversation('c2', {
        lastMessage: {
          senderName: 'B',
          ciphertext: 'z',
          type: MessageType.TEXT,
          serverTimestamp: '2025-12-01T00:00:00Z',
          isDeleted: false,
        },
      });

      // c2 should now be first
      expect(useChatStore.getState().conversations[0].id).toBe('c2');
    });

    it('should be a no-op for non-existent conversation', () => {
      useChatStore
        .getState()
        .updateConversation('nonexistent', { displayName: 'Ghost' });
      expect(useChatStore.getState().conversations).toHaveLength(0);
    });
  });

  describe('removeConversation()', () => {
    it('should remove a conversation and all associated state', () => {
      const conv = makeConversation({ id: 'rm-conv' });
      useChatStore.getState().setConversations([conv]);
      useChatStore
        .getState()
        .setMessages('rm-conv', [makeMessage({ conversationId: 'rm-conv' })]);
      useChatStore.getState().incrementUnread('rm-conv');
      useChatStore.getState().setHasMoreMessages('rm-conv', true);
      useChatStore.getState().setMessageCursor('rm-conv', 'cursor-123');

      useChatStore.getState().removeConversation('rm-conv');

      expect(useChatStore.getState().conversations).toHaveLength(0);
      expect(useChatStore.getState().messages.has('rm-conv')).toBe(false);
      expect(useChatStore.getState().unreadCounts.has('rm-conv')).toBe(false);
      expect(useChatStore.getState().hasMoreMessages.has('rm-conv')).toBe(false);
      expect(useChatStore.getState().messageCursors.has('rm-conv')).toBe(false);
    });

    it('should clear activeConversationId if the removed conversation was active', () => {
      const conv = makeConversation({ id: 'active-rm' });
      useChatStore.getState().setConversations([conv]);
      useChatStore.getState().setActiveConversation('active-rm');

      useChatStore.getState().removeConversation('active-rm');

      expect(useChatStore.getState().activeConversationId).toBeNull();
    });

    it('should preserve activeConversationId if a different conversation is removed', () => {
      const conv1 = makeConversation({ id: 'keep' });
      const conv2 = makeConversation({ id: 'remove' });
      useChatStore.getState().setConversations([conv1, conv2]);
      useChatStore.getState().setActiveConversation('keep');

      useChatStore.getState().removeConversation('remove');

      expect(useChatStore.getState().activeConversationId).toBe('keep');
    });
  });

  // =========================================================================
  // Active Conversation
  // =========================================================================

  describe('setActiveConversation()', () => {
    it('should set the active conversation ID', () => {
      useChatStore.getState().setActiveConversation('conv-abc');
      expect(useChatStore.getState().activeConversationId).toBe('conv-abc');
    });

    it('should reset unread count to 0 when navigating into a conversation', () => {
      useChatStore.getState().incrementUnread('conv-abc');
      useChatStore.getState().incrementUnread('conv-abc');
      useChatStore.getState().incrementUnread('conv-abc');
      expect(useChatStore.getState().unreadCounts.get('conv-abc')).toBe(3);

      useChatStore.getState().setActiveConversation('conv-abc');
      expect(useChatStore.getState().unreadCounts.get('conv-abc')).toBe(0);
    });

    it('should allow setting to null (deselect)', () => {
      useChatStore.getState().setActiveConversation('conv-abc');
      useChatStore.getState().setActiveConversation(null);
      expect(useChatStore.getState().activeConversationId).toBeNull();
    });
  });

  // =========================================================================
  // Message CRUD — R4 Ordering & Deduplication
  // =========================================================================

  describe('setMessages()', () => {
    it('should set messages sorted by serverTimestamp ascending', () => {
      const msg1 = makeMessage({
        id: 'm1',
        serverTimestamp: '2025-01-01T00:00:02Z',
      });
      const msg2 = makeMessage({
        id: 'm2',
        serverTimestamp: '2025-01-01T00:00:01Z',
      });

      useChatStore.getState().setMessages('conv-1', [msg1, msg2]);

      const stored = useChatStore.getState().messages.get('conv-1')!;
      expect(stored[0].id).toBe('m2'); // earlier timestamp first
      expect(stored[1].id).toBe('m1');
    });
  });

  describe('addMessage() — R4 deduplication and ordering', () => {
    it('should add a message to a conversation', () => {
      const msg = makeMessage({ conversationId: 'conv-1' });
      useChatStore.getState().addMessage('conv-1', msg);
      expect(useChatStore.getState().messages.get('conv-1')).toHaveLength(1);
    });

    it('should reject duplicate messages by clientMessageId (R4)', () => {
      const msg1 = makeMessage({
        conversationId: 'conv-1',
        clientMessageId: 'dedup-id',
      });
      const msg2 = makeMessage({
        conversationId: 'conv-1',
        clientMessageId: 'dedup-id',
        id: 'different-server-id',
      });

      useChatStore.getState().addMessage('conv-1', msg1);
      useChatStore.getState().addMessage('conv-1', msg2);

      expect(useChatStore.getState().messages.get('conv-1')).toHaveLength(1);
    });

    it('should maintain ascending serverTimestamp order (R4)', () => {
      const early = makeMessage({
        id: 'early',
        conversationId: 'conv-1',
        clientMessageId: 'c-early',
        serverTimestamp: '2025-01-01T00:00:01Z',
      });
      const late = makeMessage({
        id: 'late',
        conversationId: 'conv-1',
        clientMessageId: 'c-late',
        serverTimestamp: '2025-01-01T00:00:03Z',
      });
      const middle = makeMessage({
        id: 'mid',
        conversationId: 'conv-1',
        clientMessageId: 'c-mid',
        serverTimestamp: '2025-01-01T00:00:02Z',
      });

      useChatStore.getState().addMessage('conv-1', late);
      useChatStore.getState().addMessage('conv-1', early);
      useChatStore.getState().addMessage('conv-1', middle);

      const msgs = useChatStore.getState().messages.get('conv-1')!;
      expect(msgs[0].id).toBe('early');
      expect(msgs[1].id).toBe('mid');
      expect(msgs[2].id).toBe('late');
    });

    it('should update conversation lastMessage when a new message is added', () => {
      const conv = makeConversation({ id: 'conv-1' });
      useChatStore.getState().setConversations([conv]);

      const msg = makeMessage({
        conversationId: 'conv-1',
        senderName: 'Bob',
        ciphertext: 'new-cipher',
        serverTimestamp: '2099-01-01T00:00:00Z',
      });
      useChatStore.getState().addMessage('conv-1', msg);

      const updated = useChatStore
        .getState()
        .conversations.find((c) => c.id === 'conv-1');
      expect(updated?.lastMessage?.senderName).toBe('Bob');
      expect(updated?.lastMessage?.ciphertext).toBe('new-cipher');
    });

    it('should increment unread count for non-active conversations', () => {
      const conv = makeConversation({ id: 'bg-conv', unreadCount: 0 });
      useChatStore.getState().setConversations([conv]);
      useChatStore.getState().setActiveConversation(null);

      const msg = makeMessage({ conversationId: 'bg-conv' });
      useChatStore.getState().addMessage('bg-conv', msg);

      expect(useChatStore.getState().unreadCounts.get('bg-conv')).toBe(1);
    });

    it('should NOT increment unread count for the active conversation', () => {
      const conv = makeConversation({ id: 'active-conv', unreadCount: 0 });
      useChatStore.getState().setConversations([conv]);
      useChatStore.getState().setActiveConversation('active-conv');

      const msg = makeMessage({ conversationId: 'active-conv' });
      useChatStore.getState().addMessage('active-conv', msg);

      expect(useChatStore.getState().unreadCounts.get('active-conv')).toBe(0);
    });
  });

  // =========================================================================
  // addMessages — R13 Offline Reconciliation
  // =========================================================================

  describe('addMessages() — R13 bulk merge', () => {
    it('should merge new messages with existing ones', () => {
      const existing = makeMessage({
        conversationId: 'conv-1',
        clientMessageId: 'existing-1',
      });
      useChatStore.getState().addMessage('conv-1', existing);

      const incoming = [
        makeMessage({
          conversationId: 'conv-1',
          clientMessageId: 'sync-1',
        }),
        makeMessage({
          conversationId: 'conv-1',
          clientMessageId: 'sync-2',
        }),
      ];
      useChatStore.getState().addMessages('conv-1', incoming);

      expect(useChatStore.getState().messages.get('conv-1')).toHaveLength(3);
    });

    it('should deduplicate by clientMessageId during merge (R4 + R13)', () => {
      const existing = makeMessage({
        conversationId: 'conv-1',
        clientMessageId: 'dup-sync',
      });
      useChatStore.getState().addMessage('conv-1', existing);

      const incoming = [
        makeMessage({
          conversationId: 'conv-1',
          clientMessageId: 'dup-sync',
          id: 'server-confirmed-id',
        }),
        makeMessage({
          conversationId: 'conv-1',
          clientMessageId: 'new-msg',
        }),
      ];
      useChatStore.getState().addMessages('conv-1', incoming);

      // Should have 2 unique messages (dup-sync deduped, new-msg added)
      expect(useChatStore.getState().messages.get('conv-1')).toHaveLength(2);
    });

    it('should maintain serverTimestamp ascending order after merge', () => {
      const early = makeMessage({
        conversationId: 'conv-1',
        clientMessageId: 'a',
        serverTimestamp: '2025-01-01T00:00:01Z',
      });
      useChatStore.getState().addMessage('conv-1', early);

      const synced = [
        makeMessage({
          conversationId: 'conv-1',
          clientMessageId: 'c',
          serverTimestamp: '2025-01-01T00:00:03Z',
        }),
        makeMessage({
          conversationId: 'conv-1',
          clientMessageId: 'b',
          serverTimestamp: '2025-01-01T00:00:02Z',
        }),
      ];
      useChatStore.getState().addMessages('conv-1', synced);

      const msgs = useChatStore.getState().messages.get('conv-1')!;
      expect(msgs[0].clientMessageId).toBe('a');
      expect(msgs[1].clientMessageId).toBe('b');
      expect(msgs[2].clientMessageId).toBe('c');
    });

    it('should be a no-op for empty incoming array', () => {
      const existing = makeMessage({ conversationId: 'conv-1' });
      useChatStore.getState().addMessage('conv-1', existing);

      const before = useChatStore.getState().messages;
      useChatStore.getState().addMessages('conv-1', []);
      const after = useChatStore.getState().messages;

      // Reference should be same (no mutation)
      expect(before).toBe(after);
    });
  });

  // =========================================================================
  // editMessage — R19 Message Edit Integrity
  // =========================================================================

  describe('editMessage() — R19', () => {
    it('should replace ciphertext and set isEdited + editedAt', () => {
      const msg = makeMessage({
        id: 'edit-me',
        conversationId: 'conv-1',
        ciphertext: 'original-cipher',
      });
      useChatStore.getState().setMessages('conv-1', [msg]);

      const editTime = '2025-06-15T12:00:00Z';
      useChatStore
        .getState()
        .editMessage('conv-1', 'edit-me', 'new-cipher', editTime);

      const edited = useChatStore.getState().messages.get('conv-1')![0];
      expect(edited.ciphertext).toBe('new-cipher');
      expect(edited.isEdited).toBe(true);
      expect(edited.editedAt).toBe(editTime);
    });

    it('should NOT modify serverTimestamp (R19 — ordering preserved)', () => {
      const originalTs = '2025-01-01T00:00:00Z';
      const msg = makeMessage({
        id: 'stable-ts',
        conversationId: 'conv-1',
        serverTimestamp: originalTs,
      });
      useChatStore.getState().setMessages('conv-1', [msg]);

      useChatStore
        .getState()
        .editMessage('conv-1', 'stable-ts', 'edited-cipher', '2025-06-15T12:00:00Z');

      const edited = useChatStore.getState().messages.get('conv-1')![0];
      expect(edited.serverTimestamp).toBe(originalTs);
    });

    it('should update conversation lastMessage if edited message is the latest', () => {
      const conv = makeConversation({ id: 'conv-1' });
      useChatStore.getState().setConversations([conv]);

      const msg = makeMessage({
        id: 'last-msg',
        conversationId: 'conv-1',
        ciphertext: 'old',
      });
      useChatStore.getState().setMessages('conv-1', [msg]);

      useChatStore
        .getState()
        .editMessage('conv-1', 'last-msg', 'edited-content', '2025-06-15T12:00:00Z');

      const updated = useChatStore
        .getState()
        .conversations.find((c) => c.id === 'conv-1');
      expect(updated?.lastMessage?.ciphertext).toBe('edited-content');
    });

    it('should be a no-op for non-existent conversation', () => {
      useChatStore
        .getState()
        .editMessage('no-conv', 'no-msg', 'x', '2025-06-15T12:00:00Z');
      // Should not throw
      expect(useChatStore.getState().messages.has('no-conv')).toBe(false);
    });

    it('should be a no-op for non-existent message', () => {
      useChatStore.getState().setMessages('conv-1', [
        makeMessage({ id: 'real-msg', conversationId: 'conv-1' }),
      ]);

      useChatStore
        .getState()
        .editMessage('conv-1', 'ghost-msg', 'x', '2025-06-15T12:00:00Z');

      const msg = useChatStore.getState().messages.get('conv-1')![0];
      expect(msg.id).toBe('real-msg');
      expect(msg.isEdited).toBe(false);
    });
  });

  // =========================================================================
  // deleteMessage — R20 Message Delete as Tombstone
  // =========================================================================

  describe('deleteMessage() — R20 tombstone', () => {
    it('should null ciphertext, set isDeleted and deletedAt', () => {
      const msg = makeMessage({
        id: 'del-me',
        conversationId: 'conv-1',
        ciphertext: 'secret-content',
      });
      useChatStore.getState().setMessages('conv-1', [msg]);

      const deleteTime = '2025-06-15T14:00:00Z';
      useChatStore.getState().deleteMessage('conv-1', 'del-me', deleteTime);

      const deleted = useChatStore.getState().messages.get('conv-1')![0];
      expect(deleted.ciphertext).toBeNull();
      expect(deleted.isDeleted).toBe(true);
      expect(deleted.deletedAt).toBe(deleteTime);
    });

    it('should RETAIN the message row (not remove from array)', () => {
      const msg = makeMessage({
        id: 'tombstone',
        conversationId: 'conv-1',
      });
      useChatStore.getState().setMessages('conv-1', [msg]);

      useChatStore
        .getState()
        .deleteMessage('conv-1', 'tombstone', '2025-06-15T14:00:00Z');

      // Message count should remain 1
      expect(useChatStore.getState().messages.get('conv-1')).toHaveLength(1);
      expect(useChatStore.getState().messages.get('conv-1')![0].id).toBe('tombstone');
    });

    it('should update conversation lastMessage with deletion state', () => {
      const conv = makeConversation({ id: 'conv-1' });
      useChatStore.getState().setConversations([conv]);

      const msg = makeMessage({
        id: 'last-del',
        conversationId: 'conv-1',
      });
      useChatStore.getState().setMessages('conv-1', [msg]);

      useChatStore
        .getState()
        .deleteMessage('conv-1', 'last-del', '2025-06-15T14:00:00Z');

      const updated = useChatStore
        .getState()
        .conversations.find((c) => c.id === 'conv-1');
      expect(updated?.lastMessage?.ciphertext).toBeNull();
      expect(updated?.lastMessage?.isDeleted).toBe(true);
    });

    it('should be a no-op for non-existent conversation', () => {
      useChatStore
        .getState()
        .deleteMessage('no-conv', 'no-msg', '2025-06-15T14:00:00Z');
      expect(useChatStore.getState().messages.has('no-conv')).toBe(false);
    });
  });

  // =========================================================================
  // updateMessageStatus — Status Advancement
  // =========================================================================

  describe('updateMessageStatus()', () => {
    it('should advance status from SENT to DELIVERED', () => {
      const msg = makeMessage({
        id: 's2d',
        conversationId: 'conv-1',
        status: MessageStatusEnum.SENT,
      });
      useChatStore.getState().setMessages('conv-1', [msg]);

      useChatStore
        .getState()
        .updateMessageStatus('conv-1', 's2d', MessageStatusEnum.DELIVERED);

      const updated = useChatStore.getState().messages.get('conv-1')![0];
      expect(updated.status).toBe(MessageStatusEnum.DELIVERED);
    });

    it('should advance status from DELIVERED to READ', () => {
      const msg = makeMessage({
        id: 'd2r',
        conversationId: 'conv-1',
        status: MessageStatusEnum.DELIVERED,
      });
      useChatStore.getState().setMessages('conv-1', [msg]);

      useChatStore
        .getState()
        .updateMessageStatus('conv-1', 'd2r', MessageStatusEnum.READ);

      const updated = useChatStore.getState().messages.get('conv-1')![0];
      expect(updated.status).toBe(MessageStatusEnum.READ);
    });

    it('should advance status from SENT directly to READ', () => {
      const msg = makeMessage({
        id: 's2r',
        conversationId: 'conv-1',
        status: MessageStatusEnum.SENT,
      });
      useChatStore.getState().setMessages('conv-1', [msg]);

      useChatStore
        .getState()
        .updateMessageStatus('conv-1', 's2r', MessageStatusEnum.READ);

      expect(useChatStore.getState().messages.get('conv-1')![0].status).toBe(
        MessageStatusEnum.READ,
      );
    });

    it('should NOT regress status from READ to DELIVERED', () => {
      const msg = makeMessage({
        id: 'no-regress',
        conversationId: 'conv-1',
        status: MessageStatusEnum.READ,
      });
      useChatStore.getState().setMessages('conv-1', [msg]);

      useChatStore
        .getState()
        .updateMessageStatus('conv-1', 'no-regress', MessageStatusEnum.DELIVERED);

      expect(useChatStore.getState().messages.get('conv-1')![0].status).toBe(
        MessageStatusEnum.READ,
      );
    });

    it('should NOT regress status from DELIVERED to SENT', () => {
      const msg = makeMessage({
        id: 'no-regress-2',
        conversationId: 'conv-1',
        status: MessageStatusEnum.DELIVERED,
      });
      useChatStore.getState().setMessages('conv-1', [msg]);

      useChatStore
        .getState()
        .updateMessageStatus('conv-1', 'no-regress-2', MessageStatusEnum.SENT);

      expect(useChatStore.getState().messages.get('conv-1')![0].status).toBe(
        MessageStatusEnum.DELIVERED,
      );
    });

    it('should be a no-op for same status (no reference change)', () => {
      const msg = makeMessage({
        id: 'same-status',
        conversationId: 'conv-1',
        status: MessageStatusEnum.SENT,
      });
      useChatStore.getState().setMessages('conv-1', [msg]);

      const before = useChatStore.getState().messages;
      useChatStore
        .getState()
        .updateMessageStatus('conv-1', 'same-status', MessageStatusEnum.SENT);
      const after = useChatStore.getState().messages;

      // Status didn't advance, so Map reference should be unchanged
      expect(before).toBe(after);
    });
  });

  // =========================================================================
  // Archive / Mute
  // =========================================================================

  describe('archiveConversation()', () => {
    it('should set isArchived to true', () => {
      const conv = makeConversation({ id: 'arc', isArchived: false });
      useChatStore.getState().setConversations([conv]);

      useChatStore.getState().archiveConversation('arc', true);

      const updated = useChatStore
        .getState()
        .conversations.find((c) => c.id === 'arc');
      expect(updated?.isArchived).toBe(true);
    });

    it('should set isArchived to false (unarchive)', () => {
      const conv = makeConversation({ id: 'unarc', isArchived: true });
      useChatStore.getState().setConversations([conv]);

      useChatStore.getState().archiveConversation('unarc', false);

      const updated = useChatStore
        .getState()
        .conversations.find((c) => c.id === 'unarc');
      expect(updated?.isArchived).toBe(false);
    });
  });

  describe('muteConversation()', () => {
    it('should update isMuted based on MuteSettings', () => {
      const conv = makeConversation({ id: 'mute-conv', isMuted: false });
      useChatStore.getState().setConversations([conv]);

      const settings: MuteSettings = {
        isMuted: true,
        muteExpiresAt: '2025-12-31T23:59:59Z',
      };
      useChatStore.getState().muteConversation('mute-conv', settings);

      const updated = useChatStore
        .getState()
        .conversations.find((c) => c.id === 'mute-conv');
      expect(updated?.isMuted).toBe(true);
    });
  });

  // =========================================================================
  // Unread Count Management
  // =========================================================================

  describe('unread counts', () => {
    it('should increment unread count', () => {
      useChatStore.getState().incrementUnread('conv-x');
      useChatStore.getState().incrementUnread('conv-x');
      expect(useChatStore.getState().unreadCounts.get('conv-x')).toBe(2);
    });

    it('should reset unread count to 0', () => {
      useChatStore.getState().incrementUnread('conv-x');
      useChatStore.getState().incrementUnread('conv-x');
      useChatStore.getState().resetUnread('conv-x');
      expect(useChatStore.getState().unreadCounts.get('conv-x')).toBe(0);
    });

    it('should start from 0 for unknown conversations', () => {
      useChatStore.getState().incrementUnread('new-conv');
      expect(useChatStore.getState().unreadCounts.get('new-conv')).toBe(1);
    });
  });

  // =========================================================================
  // Loading & Pagination
  // =========================================================================

  describe('loading and pagination state', () => {
    it('should set isLoadingConversations', () => {
      useChatStore.getState().setIsLoadingConversations(true);
      expect(useChatStore.getState().isLoadingConversations).toBe(true);
      useChatStore.getState().setIsLoadingConversations(false);
      expect(useChatStore.getState().isLoadingConversations).toBe(false);
    });

    it('should set isLoadingMessages', () => {
      useChatStore.getState().setIsLoadingMessages(true);
      expect(useChatStore.getState().isLoadingMessages).toBe(true);
    });

    it('should set hasMoreMessages per conversation', () => {
      useChatStore.getState().setHasMoreMessages('conv-1', true);
      expect(useChatStore.getState().hasMoreMessages.get('conv-1')).toBe(true);
      useChatStore.getState().setHasMoreMessages('conv-1', false);
      expect(useChatStore.getState().hasMoreMessages.get('conv-1')).toBe(false);
    });

    it('should set messageCursor per conversation', () => {
      useChatStore.getState().setMessageCursor('conv-1', '2025-01-01T00:00:00Z');
      expect(useChatStore.getState().messageCursors.get('conv-1')).toBe(
        '2025-01-01T00:00:00Z',
      );
    });
  });

  // =========================================================================
  // Cleanup
  // =========================================================================

  describe('clearChat()', () => {
    it('should clear messages, cursor, hasMore, and reset unread for a conversation', () => {
      useChatStore
        .getState()
        .setMessages('conv-1', [makeMessage({ conversationId: 'conv-1' })]);
      useChatStore.getState().incrementUnread('conv-1');
      useChatStore.getState().setHasMoreMessages('conv-1', true);
      useChatStore.getState().setMessageCursor('conv-1', 'cursor-1');

      useChatStore.getState().clearChat('conv-1');

      expect(useChatStore.getState().messages.has('conv-1')).toBe(false);
      expect(useChatStore.getState().unreadCounts.get('conv-1')).toBe(0);
      expect(useChatStore.getState().hasMoreMessages.has('conv-1')).toBe(false);
      expect(useChatStore.getState().messageCursors.has('conv-1')).toBe(false);
    });

    it('should not affect other conversations', () => {
      useChatStore
        .getState()
        .setMessages('conv-1', [makeMessage({ conversationId: 'conv-1' })]);
      useChatStore
        .getState()
        .setMessages('conv-2', [makeMessage({ conversationId: 'conv-2' })]);

      useChatStore.getState().clearChat('conv-1');

      expect(useChatStore.getState().messages.has('conv-1')).toBe(false);
      expect(useChatStore.getState().messages.has('conv-2')).toBe(true);
    });
  });

  describe('clearAll()', () => {
    it('should reset the entire store to initial state', () => {
      // Populate store with data
      const conv = makeConversation({ id: 'conv-1' });
      useChatStore.getState().setConversations([conv]);
      useChatStore
        .getState()
        .setMessages('conv-1', [makeMessage({ conversationId: 'conv-1' })]);
      useChatStore.getState().setActiveConversation('conv-1');
      useChatStore.getState().incrementUnread('conv-1');
      useChatStore.getState().setIsLoadingConversations(true);
      useChatStore.getState().setHasMoreMessages('conv-1', true);

      useChatStore.getState().clearAll();

      const state = useChatStore.getState();
      expect(state.conversations).toEqual([]);
      expect(state.activeConversationId).toBeNull();
      expect(state.messages.size).toBe(0);
      expect(state.unreadCounts.size).toBe(0);
      expect(state.isLoadingConversations).toBe(false);
      expect(state.isLoadingMessages).toBe(false);
      expect(state.hasMoreMessages.size).toBe(0);
      expect(state.messageCursors.size).toBe(0);
    });
  });

  // =========================================================================
  // Derived Selectors
  // =========================================================================

  describe('selectMessages()', () => {
    it('should return messages for a conversation', () => {
      const msg = makeMessage({ conversationId: 'conv-1' });
      useChatStore.getState().setMessages('conv-1', [msg]);

      const result = selectMessages('conv-1');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(msg.id);
    });

    it('should return empty array for unknown conversation', () => {
      expect(selectMessages('unknown')).toEqual([]);
    });
  });

  describe('selectActiveConversation()', () => {
    it('should return the active conversation object', () => {
      const conv = makeConversation({ id: 'active' });
      useChatStore.getState().setConversations([conv]);
      useChatStore.getState().setActiveConversation('active');

      const result = selectActiveConversation();
      expect(result?.id).toBe('active');
    });

    it('should return null when no conversation is active', () => {
      expect(selectActiveConversation()).toBeNull();
    });

    it('should return null when active ID does not match any conversation', () => {
      useChatStore.getState().setActiveConversation('ghost');
      expect(selectActiveConversation()).toBeNull();
    });
  });

  describe('selectUnreadCount()', () => {
    it('should return unread count for a conversation', () => {
      useChatStore.getState().incrementUnread('conv-1');
      useChatStore.getState().incrementUnread('conv-1');
      expect(selectUnreadCount('conv-1')).toBe(2);
    });

    it('should return 0 for unknown conversation', () => {
      expect(selectUnreadCount('unknown')).toBe(0);
    });
  });

  describe('selectTotalUnreadCount()', () => {
    it('should sum unread counts across all conversations', () => {
      useChatStore.getState().incrementUnread('conv-1');
      useChatStore.getState().incrementUnread('conv-1');
      useChatStore.getState().incrementUnread('conv-2');
      expect(selectTotalUnreadCount()).toBe(3);
    });

    it('should return 0 when no unread messages', () => {
      expect(selectTotalUnreadCount()).toBe(0);
    });
  });

  describe('selectVisibleConversations()', () => {
    it('should return only non-archived conversations', () => {
      const visible = makeConversation({ id: 'v', isArchived: false });
      const archived = makeConversation({ id: 'a', isArchived: true });
      useChatStore.getState().setConversations([visible, archived]);

      const result = selectVisibleConversations();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('v');
    });
  });

  describe('selectArchivedConversations()', () => {
    it('should return only archived conversations', () => {
      const visible = makeConversation({ id: 'v', isArchived: false });
      const archived = makeConversation({ id: 'a', isArchived: true });
      useChatStore.getState().setConversations([visible, archived]);

      const result = selectArchivedConversations();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('a');
    });
  });

  // =========================================================================
  // Immutability — Map reference changes
  // =========================================================================

  describe('immutability', () => {
    it('should create new Map reference on addMessage', () => {
      const before = useChatStore.getState().messages;
      useChatStore
        .getState()
        .addMessage('conv-1', makeMessage({ conversationId: 'conv-1' }));
      const after = useChatStore.getState().messages;
      expect(before).not.toBe(after);
    });

    it('should create new Map reference on editMessage', () => {
      useChatStore.getState().setMessages('conv-1', [
        makeMessage({ id: 'im-msg', conversationId: 'conv-1' }),
      ]);
      const before = useChatStore.getState().messages;
      useChatStore
        .getState()
        .editMessage('conv-1', 'im-msg', 'new', '2025-01-01T00:00:00Z');
      const after = useChatStore.getState().messages;
      expect(before).not.toBe(after);
    });

    it('should create new Map reference on deleteMessage', () => {
      useChatStore.getState().setMessages('conv-1', [
        makeMessage({ id: 'im-del', conversationId: 'conv-1' }),
      ]);
      const before = useChatStore.getState().messages;
      useChatStore
        .getState()
        .deleteMessage('conv-1', 'im-del', '2025-01-01T00:00:00Z');
      const after = useChatStore.getState().messages;
      expect(before).not.toBe(after);
    });

    it('should create new Map reference on incrementUnread', () => {
      const before = useChatStore.getState().unreadCounts;
      useChatStore.getState().incrementUnread('conv-1');
      const after = useChatStore.getState().unreadCounts;
      expect(before).not.toBe(after);
    });
  });
});
