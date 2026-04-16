/**
 * @module chatStore
 *
 * Zustand store managing all conversation and message state for the
 * WhatsApp clone frontend. This is the most complex frontend store,
 * handling the chat list (Figma Screen 1), active conversation
 * (Figma Screen 4), message lifecycle, unread counts, and
 * archive/mute operations.
 *
 * Key design decisions and rule compliance:
 *
 * - **R4 — Real-time Message Integrity:** Messages are ordered by
 *   `serverTimestamp` ascending (oldest first) for display. Deduplication
 *   is enforced via `clientMessageId` — duplicate messages are silently
 *   dropped.
 *
 * - **R12 — E2E Encryption Integrity:** The store works exclusively with
 *   ciphertext. No decryption occurs in the store — that responsibility
 *   belongs to the encryption hook/library layer.
 *
 * - **R13 — Offline Reconciliation:** `addMessages` supports bulk merge
 *   for the `message:sync` protocol, deduplicating by `clientMessageId`
 *   and maintaining sort order.
 *
 * - **R19 — Message Edit Integrity:** `editMessage` replaces ciphertext
 *   and sets `isEdited = true` / `editedAt` without modifying
 *   `serverTimestamp` — message ordering is never disturbed by edits.
 *
 * - **R20 — Message Delete as Tombstone:** `deleteMessage` nulls
 *   ciphertext, sets `isDeleted = true` / `deletedAt`, and RETAINS the
 *   message row. The UI renders "This message was deleted" for
 *   tombstoned entries.
 *
 * Immutability strategy:
 *   Zustand detects changes via `Object.is()` reference equality.
 *   Every mutation that touches `messages`, `unreadCounts`,
 *   `hasMoreMessages`, or `messageCursors` creates a **new** Map
 *   instance to ensure React re-renders fire correctly.
 *   Conversation arrays are always replaced with new array references.
 */

import { create } from 'zustand';
import type {
  ConversationResponse,
  ConversationListItem,
  MessageResponse,
  MuteSettings,
} from '@kalle/shared';
import { MessageStatusEnum } from '@kalle/shared';

// Re-export ConversationResponse so callers can map API responses → store format
// without importing from @kalle/shared separately.
export type { ConversationResponse };

// =============================================================================
// Constants
// =============================================================================

/**
 * Numeric priority map for message status advancement.
 * Status may only advance (SENT → DELIVERED → READ), never regress.
 */
const STATUS_PRIORITY: Record<string, number> = {
  [MessageStatusEnum.SENT]: 0,
  [MessageStatusEnum.DELIVERED]: 1,
  [MessageStatusEnum.READ]: 2,
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Sorts conversations by `lastMessage.serverTimestamp` in descending order
 * (most recent first). Conversations without a last message are placed at
 * the end, ordered by their position in the original array.
 */
function sortConversationsByRecent(
  conversations: ConversationListItem[],
): ConversationListItem[] {
  return [...conversations].sort((a, b) => {
    const tsA = a.lastMessage?.serverTimestamp ?? '';
    const tsB = b.lastMessage?.serverTimestamp ?? '';
    if (tsB > tsA) return 1;
    if (tsB < tsA) return -1;
    return 0;
  });
}

/**
 * Sorts messages by `serverTimestamp` in ascending order (oldest first)
 * for chronological chat display. This is the canonical display order
 * required by R4.
 */
function sortMessagesByTimestamp(
  messages: MessageResponse[],
): MessageResponse[] {
  return [...messages].sort((a, b) => {
    if (a.serverTimestamp < b.serverTimestamp) return -1;
    if (a.serverTimestamp > b.serverTimestamp) return 1;
    return 0;
  });
}

/**
 * Deduplicates messages by `clientMessageId`. When duplicates are found,
 * the later entry (by array position) takes precedence, ensuring that
 * server-confirmed messages replace optimistic client-side entries.
 */
function deduplicateMessages(
  messages: MessageResponse[],
): MessageResponse[] {
  const seen = new Map<string, MessageResponse>();
  for (const msg of messages) {
    seen.set(msg.clientMessageId, msg);
  }
  return Array.from(seen.values());
}

// =============================================================================
// State Interface
// =============================================================================

/**
 * Complete state shape for the chat store, including all observable
 * properties and mutation actions.
 */
interface ChatState {
  // ─── State Properties ────────────────────────────────────────────────

  /** Conversation list sorted by lastMessage.serverTimestamp descending. */
  conversations: ConversationListItem[];

  /** ID of the currently active/open conversation, or null if none. */
  activeConversationId: string | null;

  /** Per-conversation message arrays keyed by conversation ID. */
  messages: Map<string, MessageResponse[]>;

  /** Per-conversation unread counts keyed by conversation ID. */
  unreadCounts: Map<string, number>;

  /** Whether the conversation list is being fetched from the API. */
  isLoadingConversations: boolean;

  /** Whether messages for the active conversation are being fetched. */
  isLoadingMessages: boolean;

  /** Per-conversation flag indicating if more messages are available for pagination. */
  hasMoreMessages: Map<string, boolean>;

  /** Per-conversation cursor (serverTimestamp) for message pagination. */
  messageCursors: Map<string, string>;

  // ─── Actions ─────────────────────────────────────────────────────────

  /** Replace the entire conversations list. Sorts by lastMessage timestamp descending. */
  setConversations: (conversations: ConversationListItem[]) => void;

  /** Add a single conversation and re-sort the list. */
  addConversation: (conversation: ConversationListItem) => void;

  /** Merge partial updates into an existing conversation by ID. Re-sorts if lastMessage changed. */
  updateConversation: (conversationId: string, updates: Partial<ConversationListItem>) => void;

  /** Remove a conversation and clean up all associated state (messages, cursors, unread). */
  removeConversation: (conversationId: string) => void;

  /** Set the active conversation. Resets unread count when navigating into a conversation. */
  setActiveConversation: (conversationId: string | null) => void;

  /** Set the full message list for a conversation. Sorts by serverTimestamp ascending. */
  setMessages: (conversationId: string, messages: MessageResponse[]) => void;

  /**
   * Add a single message to a conversation. Deduplicates by clientMessageId (R4).
   * Maintains ascending serverTimestamp order. Updates conversation lastMessage.
   */
  addMessage: (conversationId: string, message: MessageResponse) => void;

  /**
   * Bulk-add messages for pagination or offline sync (R13).
   * Merges with existing, deduplicates by clientMessageId, and re-sorts.
   */
  addMessages: (conversationId: string, messages: MessageResponse[]) => void;

  /**
   * Edit a message — replace ciphertext, set isEdited and editedAt (R19).
   * Does NOT alter serverTimestamp or message ordering.
   */
  editMessage: (conversationId: string, messageId: string, newCiphertext: string, editedAt: string) => void;

  /**
   * Soft-delete a message — null ciphertext, set isDeleted and deletedAt (R20).
   * The message row is RETAINED (tombstone). Never removed from the array.
   */
  deleteMessage: (conversationId: string, messageId: string, deletedAt: string) => void;

  /**
   * Advance message delivery status (SENT → DELIVERED → READ).
   * Status may only advance, never regress.
   */
  updateMessageStatus: (conversationId: string, messageId: string, status: MessageStatusEnum) => void;

  /** Set or clear the archive flag on a conversation. */
  archiveConversation: (conversationId: string, isArchived: boolean) => void;

  /** Update mute settings for a conversation. */
  muteConversation: (conversationId: string, muteSettings: MuteSettings) => void;

  /** Increment the unread count for a conversation by 1. */
  incrementUnread: (conversationId: string) => void;

  /** Reset the unread count for a conversation to 0. */
  resetUnread: (conversationId: string) => void;

  /** Set the loading state for the conversation list. */
  setIsLoadingConversations: (loading: boolean) => void;

  /** Set the loading state for messages. */
  setIsLoadingMessages: (loading: boolean) => void;

  /** Set whether more messages are available for pagination. */
  setHasMoreMessages: (conversationId: string, hasMore: boolean) => void;

  /** Set the pagination cursor for a conversation's messages. */
  setMessageCursor: (conversationId: string, cursor: string) => void;

  /** Clear all messages, cursor, and unread count for a single conversation. */
  clearChat: (conversationId: string) => void;

  /** Reset the entire store to initial state. Used on logout. */
  clearAll: () => void;
}

// =============================================================================
// Initial State Factory
// =============================================================================

/**
 * Returns a fresh copy of the initial state values.
 * Used both for store creation and for `clearAll()`.
 */
function createInitialState() {
  return {
    conversations: [] as ConversationListItem[],
    activeConversationId: null as string | null,
    messages: new Map<string, MessageResponse[]>(),
    unreadCounts: new Map<string, number>(),
    isLoadingConversations: false,
    isLoadingMessages: false,
    hasMoreMessages: new Map<string, boolean>(),
    messageCursors: new Map<string, string>(),
  };
}

// =============================================================================
// Store
// =============================================================================

export const useChatStore = create<ChatState>((set, get) => ({
  // ─── Initial State ─────────────────────────────────────────────────
  ...createInitialState(),

  // ─── Conversation Actions ──────────────────────────────────────────

  setConversations: (conversations: ConversationListItem[]): void => {
    const sorted = sortConversationsByRecent(conversations);
    const existingUnreadCounts = get().unreadCounts;
    const newUnreadCounts = new Map<string, number>(existingUnreadCounts);

    const merged = sorted.map((conv) => {
      if (!existingUnreadCounts.has(conv.id)) {
        // First time seeing this conversation — initialize from server data
        newUnreadCounts.set(conv.id, conv.unreadCount);
        return conv;
      }
      // Conversation already tracked — preserve locally-tracked count
      const localCount = existingUnreadCounts.get(conv.id)!;
      if (localCount !== conv.unreadCount) {
        return { ...conv, unreadCount: localCount };
      }
      return conv;
    });

    set({ conversations: merged, unreadCounts: newUnreadCounts });
  },

  addConversation: (conversation: ConversationListItem): void => {
    const state = get();
    const exists = state.conversations.some((c) => c.id === conversation.id);
    if (exists) {
      return;
    }

    const newUnreadCounts = new Map(state.unreadCounts);
    newUnreadCounts.set(conversation.id, conversation.unreadCount);

    set({
      conversations: sortConversationsByRecent([
        ...state.conversations,
        conversation,
      ]),
      unreadCounts: newUnreadCounts,
    });
  },

  updateConversation: (
    conversationId: string,
    updates: Partial<ConversationListItem>,
  ): void => {
    const state = get();
    const idx = state.conversations.findIndex((c) => c.id === conversationId);
    if (idx === -1) {
      return;
    }

    const updatedConversations = [...state.conversations];
    updatedConversations[idx] = { ...updatedConversations[idx], ...updates };

    /* Re-sort if lastMessage changed (may shift position in list) */
    const sorted =
      updates.lastMessage !== undefined
        ? sortConversationsByRecent(updatedConversations)
        : updatedConversations;

    set({ conversations: sorted });
  },

  removeConversation: (conversationId: string): void => {
    const state = get();

    const newMessages = new Map(state.messages);
    newMessages.delete(conversationId);

    const newUnreadCounts = new Map(state.unreadCounts);
    newUnreadCounts.delete(conversationId);

    const newHasMore = new Map(state.hasMoreMessages);
    newHasMore.delete(conversationId);

    const newCursors = new Map(state.messageCursors);
    newCursors.delete(conversationId);

    set({
      conversations: state.conversations.filter((c) => c.id !== conversationId),
      messages: newMessages,
      unreadCounts: newUnreadCounts,
      hasMoreMessages: newHasMore,
      messageCursors: newCursors,
      activeConversationId:
        state.activeConversationId === conversationId
          ? null
          : state.activeConversationId,
    });
  },

  // ─── Active Conversation ───────────────────────────────────────────

  setActiveConversation: (conversationId: string | null): void => {
    const state = get();

    /* When navigating into a conversation, reset its unread count to 0 */
    if (conversationId !== null) {
      const newUnreadCounts = new Map(state.unreadCounts);
      newUnreadCounts.set(conversationId, 0);

      set({
        activeConversationId: conversationId,
        unreadCounts: newUnreadCounts,
      });
    } else {
      set({ activeConversationId: null });
    }
  },

  // ─── Message Actions ───────────────────────────────────────────────

  setMessages: (conversationId: string, messages: MessageResponse[]): void => {
    const newMessages = new Map(get().messages);
    newMessages.set(conversationId, sortMessagesByTimestamp(messages));
    set({ messages: newMessages });
  },

  addMessage: (conversationId: string, message: MessageResponse): void => {
    const state = get();
    const existing = state.messages.get(conversationId) ?? [];

    /* R4 — Deduplication by clientMessageId */
    const isDuplicate = existing.some(
      (m) => m.clientMessageId === message.clientMessageId,
    );
    if (isDuplicate) {
      return;
    }

    /* Insert in sorted position (ascending serverTimestamp) for R4 ordering */
    const updated = sortMessagesByTimestamp([...existing, message]);

    const newMessages = new Map(state.messages);
    newMessages.set(conversationId, updated);

    /* Update conversation lastMessage and re-sort the conversation list */
    const convIdx = state.conversations.findIndex(
      (c) => c.id === conversationId,
    );
    let updatedConversations = state.conversations;
    if (convIdx !== -1) {
      const convCopy = [...state.conversations];
      convCopy[convIdx] = {
        ...convCopy[convIdx],
        lastMessage: {
          senderName: message.senderName,
          ciphertext: message.ciphertext,
          type: message.type,
          serverTimestamp: message.serverTimestamp,
          isDeleted: message.isDeleted,
        },
      };
      updatedConversations = sortConversationsByRecent(convCopy);
    }

    /* Increment unread count for non-active conversations */
    const newUnreadCounts = new Map(state.unreadCounts);
    if (conversationId !== state.activeConversationId) {
      const current = newUnreadCounts.get(conversationId) ?? 0;
      newUnreadCounts.set(conversationId, current + 1);
    }

    set({
      messages: newMessages,
      conversations: updatedConversations,
      unreadCounts: newUnreadCounts,
    });
  },

  addMessages: (
    conversationId: string,
    incomingMessages: MessageResponse[],
  ): void => {
    if (incomingMessages.length === 0) {
      return;
    }

    const state = get();
    const existing = state.messages.get(conversationId) ?? [];

    /* Merge then deduplicate by clientMessageId (R4 + R13) */
    const merged = deduplicateMessages([...existing, ...incomingMessages]);
    const sorted = sortMessagesByTimestamp(merged);

    const newMessages = new Map(state.messages);
    newMessages.set(conversationId, sorted);

    set({ messages: newMessages });
  },

  editMessage: (
    conversationId: string,
    messageId: string,
    newCiphertext: string,
    editedAt: string,
  ): void => {
    const state = get();
    const msgs = state.messages.get(conversationId);
    if (!msgs) {
      return;
    }

    const msgIdx = msgs.findIndex((m) => m.id === messageId);
    if (msgIdx === -1) {
      return;
    }

    /*
     * R19 — Replace ciphertext, set isEdited + editedAt.
     * DO NOT modify serverTimestamp — ordering must remain stable.
     */
    const updatedMsgs = [...msgs];
    updatedMsgs[msgIdx] = {
      ...updatedMsgs[msgIdx],
      ciphertext: newCiphertext,
      isEdited: true,
      editedAt,
    };

    const newMessages = new Map(state.messages);
    newMessages.set(conversationId, updatedMsgs);

    /* If this was the last message in the conversation, update lastMessage preview */
    const lastMsg = updatedMsgs[updatedMsgs.length - 1];
    let updatedConversations = state.conversations;
    if (lastMsg && lastMsg.id === messageId) {
      const convIdx = state.conversations.findIndex(
        (c) => c.id === conversationId,
      );
      if (convIdx !== -1) {
        const convCopy = [...state.conversations];
        convCopy[convIdx] = {
          ...convCopy[convIdx],
          lastMessage: {
            senderName: lastMsg.senderName,
            ciphertext: newCiphertext,
            type: lastMsg.type,
            serverTimestamp: lastMsg.serverTimestamp,
            isDeleted: lastMsg.isDeleted,
          },
        };
        updatedConversations = convCopy;
      }
    }

    set({ messages: newMessages, conversations: updatedConversations });
  },

  deleteMessage: (
    conversationId: string,
    messageId: string,
    deletedAt: string,
  ): void => {
    const state = get();
    const msgs = state.messages.get(conversationId);
    if (!msgs) {
      return;
    }

    const msgIdx = msgs.findIndex((m) => m.id === messageId);
    if (msgIdx === -1) {
      return;
    }

    /*
     * R20 — Tombstone: null ciphertext, set isDeleted + deletedAt.
     * The message row is RETAINED — never removed from the array.
     */
    const updatedMsgs = [...msgs];
    updatedMsgs[msgIdx] = {
      ...updatedMsgs[msgIdx],
      ciphertext: null,
      isDeleted: true,
      deletedAt,
    };

    const newMessages = new Map(state.messages);
    newMessages.set(conversationId, updatedMsgs);

    /* If this was the last message, update conversation lastMessage with deletion state */
    const lastMsg = updatedMsgs[updatedMsgs.length - 1];
    let updatedConversations = state.conversations;
    if (lastMsg && lastMsg.id === messageId) {
      const convIdx = state.conversations.findIndex(
        (c) => c.id === conversationId,
      );
      if (convIdx !== -1) {
        const convCopy = [...state.conversations];
        convCopy[convIdx] = {
          ...convCopy[convIdx],
          lastMessage: {
            senderName: lastMsg.senderName,
            ciphertext: null,
            type: lastMsg.type,
            serverTimestamp: lastMsg.serverTimestamp,
            isDeleted: true,
          },
        };
        updatedConversations = convCopy;
      }
    }

    set({ messages: newMessages, conversations: updatedConversations });
  },

  updateMessageStatus: (
    conversationId: string,
    messageId: string,
    status: MessageStatusEnum,
  ): void => {
    const state = get();
    const msgs = state.messages.get(conversationId);
    if (!msgs) {
      return;
    }

    const msgIdx = msgs.findIndex((m) => m.id === messageId);
    if (msgIdx === -1) {
      return;
    }

    /* Status may only advance: SENT → DELIVERED → READ (never regress) */
    const currentPriority = STATUS_PRIORITY[msgs[msgIdx].status] ?? 0;
    const newPriority = STATUS_PRIORITY[status] ?? 0;
    if (newPriority <= currentPriority) {
      return;
    }

    const updatedMsgs = [...msgs];
    updatedMsgs[msgIdx] = { ...updatedMsgs[msgIdx], status };

    const newMessages = new Map(state.messages);
    newMessages.set(conversationId, updatedMsgs);

    set({ messages: newMessages });
  },

  // ─── Conversation Setting Actions ──────────────────────────────────

  archiveConversation: (conversationId: string, isArchived: boolean): void => {
    const state = get();
    const idx = state.conversations.findIndex((c) => c.id === conversationId);
    if (idx === -1) {
      return;
    }

    const updatedConversations = [...state.conversations];
    updatedConversations[idx] = {
      ...updatedConversations[idx],
      isArchived,
    };

    set({ conversations: updatedConversations });
  },

  muteConversation: (
    conversationId: string,
    muteSettings: MuteSettings,
  ): void => {
    const state = get();
    const idx = state.conversations.findIndex((c) => c.id === conversationId);
    if (idx === -1) {
      return;
    }

    const updatedConversations = [...state.conversations];
    updatedConversations[idx] = {
      ...updatedConversations[idx],
      isMuted: muteSettings.isMuted,
    };

    set({ conversations: updatedConversations });
  },

  // ─── Unread Count Actions ──────────────────────────────────────────

  incrementUnread: (conversationId: string): void => {
    const state = get();
    const newUnreadCounts = new Map(state.unreadCounts);
    const current = newUnreadCounts.get(conversationId) ?? 0;
    newUnreadCounts.set(conversationId, current + 1);
    set({ unreadCounts: newUnreadCounts });
  },

  resetUnread: (conversationId: string): void => {
    const state = get();
    const newUnreadCounts = new Map(state.unreadCounts);
    newUnreadCounts.set(conversationId, 0);
    set({ unreadCounts: newUnreadCounts });
  },

  // ─── Loading / Pagination Actions ──────────────────────────────────

  setIsLoadingConversations: (loading: boolean): void => {
    set({ isLoadingConversations: loading });
  },

  setIsLoadingMessages: (loading: boolean): void => {
    set({ isLoadingMessages: loading });
  },

  setHasMoreMessages: (conversationId: string, hasMore: boolean): void => {
    const newHasMore = new Map(get().hasMoreMessages);
    newHasMore.set(conversationId, hasMore);
    set({ hasMoreMessages: newHasMore });
  },

  setMessageCursor: (conversationId: string, cursor: string): void => {
    const newCursors = new Map(get().messageCursors);
    newCursors.set(conversationId, cursor);
    set({ messageCursors: newCursors });
  },

  // ─── Cleanup Actions ───────────────────────────────────────────────

  clearChat: (conversationId: string): void => {
    const state = get();

    const newMessages = new Map(state.messages);
    newMessages.delete(conversationId);

    const newUnreadCounts = new Map(state.unreadCounts);
    newUnreadCounts.set(conversationId, 0);

    const newCursors = new Map(state.messageCursors);
    newCursors.delete(conversationId);

    const newHasMore = new Map(state.hasMoreMessages);
    newHasMore.delete(conversationId);

    set({
      messages: newMessages,
      unreadCounts: newUnreadCounts,
      messageCursors: newCursors,
      hasMoreMessages: newHasMore,
    });
  },

  clearAll: (): void => {
    set(createInitialState());
  },
}));

// =============================================================================
// Derived Selectors
// =============================================================================

/**
 * Returns the message array for a specific conversation.
 * Messages are sorted by serverTimestamp ascending (oldest first).
 * Returns an empty array if no messages exist for the conversation.
 */
export function selectMessages(conversationId: string): MessageResponse[] {
  return useChatStore.getState().messages.get(conversationId) ?? [];
}

/**
 * Returns the currently active conversation object, or null if none is selected.
 */
export function selectActiveConversation(): ConversationListItem | null {
  const state = useChatStore.getState();
  if (state.activeConversationId === null) {
    return null;
  }
  return (
    state.conversations.find((c) => c.id === state.activeConversationId) ?? null
  );
}

/**
 * Returns the unread message count for a specific conversation.
 * Returns 0 if the conversation has no recorded unread count.
 */
export function selectUnreadCount(conversationId: string): number {
  return useChatStore.getState().unreadCounts.get(conversationId) ?? 0;
}

/**
 * Returns the total unread message count across all conversations.
 * Used for app-level badges (e.g., Chats tab badge in TabBar).
 */
export function selectTotalUnreadCount(): number {
  const counts = useChatStore.getState().unreadCounts;
  let total = 0;
  counts.forEach((count) => {
    total += count;
  });
  return total;
}

/**
 * Returns all non-archived conversations (the main chat list).
 * Maintains the existing sort order (lastMessage timestamp descending).
 */
export function selectVisibleConversations(): ConversationListItem[] {
  return useChatStore
    .getState()
    .conversations.filter((c) => !c.isArchived);
}

/**
 * Returns all archived conversations.
 * Maintains the existing sort order (lastMessage timestamp descending).
 */
export function selectArchivedConversations(): ConversationListItem[] {
  return useChatStore
    .getState()
    .conversations.filter((c) => c.isArchived);
}
