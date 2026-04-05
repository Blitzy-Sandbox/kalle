/**
 * @module apps/web/src/hooks/useMessages
 *
 * Custom React hook providing a complete message operations API for chat UI
 * components. Combines WebSocket real-time events, Zustand store mutations,
 * Signal Protocol E2E encryption (R12), and IndexedDB search indexing (R21).
 *
 * Exposed operations:
 * - sendMessage  — encrypt & emit via WebSocket with optimistic store update
 * - editMessage  — sender-only, 15-min window (R19), PATCH REST + store update
 * - deleteMessage — sender-only tombstone (R20), DELETE REST + store update
 * - loadHistory  — cursor-paginated REST fetch + batch decrypt + store merge
 * - syncMessages — offline reconciliation via message:sync event (R13)
 *
 * Security invariants:
 * - All message content encrypted client-side before network transit (R12)
 * - Group messages encrypted via Sender Key distribution (R14)
 * - Zero plaintext or encryption keys logged anywhere (R23)
 * - Search index populated after decryption for client-side search only (R21)
 *
 * Rate limiting (R25): Tracks message send frequency (30/min) via useRef.
 * Correlation IDs (R29): Every emitted WebSocket event includes a UUID v4.
 */

import { useCallback, useEffect, useRef } from 'react';

import { useChatStore } from '../stores/chatStore';
import { useAuthStore } from '../stores/authStore';
import {
  emitEvent,
  onEvent,
  offEvent,
  isConnected,
  generateCorrelationId,
  getSocket,
} from '../lib/socket';
import {
  encryptMessage,
  decryptMessage,
  encryptGroupMessage,
  decryptGroupMessage,
  hasSession,
  createSession,
} from '../lib/encryption';
import { indexMessage, removeMessageFromIndex } from '../lib/search';
import { apiClient } from '../lib/api';

import type {
  MessageResponse,
  SendMessageDTO,
  EditMessageDTO,
  GetMessagesResponse,
  PreKeyBundleResponse,
  ConversationListItem,
} from '@kalle/shared';

import {
  ConversationType,
  MessageStatusEnum,
  MessageType,
  TTL,
  RATE_LIMITS,
} from '@kalle/shared';

// Re-import payload types used by WebSocket event handlers.
// These are type-only imports used exclusively for callback parameter typing.
import type {
  MessageNewPayload,
  MessageEditedPayload,
  MessageDeletedPayload,
  MessageStatusPayload,
  MessageSyncResponsePayload,
} from '@kalle/shared';

// =============================================================================
// Hook Return Type
// =============================================================================

/**
 * UseMessagesReturn — public API surface of the useMessages hook.
 *
 * All mutating functions are async and return Promise<void>.
 * `isLoading` reflects the current loading state for message history fetches.
 */
export interface UseMessagesReturn {
  /**
   * Send an encrypted message to a conversation.
   *
   * @param conversationId - Target conversation UUID
   * @param content - Plaintext message content (encrypted before transmission)
   * @param conversationType - DIRECT or GROUP — determines encryption strategy
   * @param recipientId - Required for DIRECT conversations (other participant's ID)
   */
  sendMessage: (
    conversationId: string,
    content: string,
    conversationType: ConversationType,
    recipientId?: string,
  ) => Promise<void>;

  /**
   * Edit an existing message (R19).
   * Sender-only, within 15-minute window from serverTimestamp.
   *
   * @param conversationId - Conversation containing the message
   * @param messageId - ID of the message to edit
   * @param newContent - New plaintext content (re-encrypted before transmission)
   */
  editMessage: (
    conversationId: string,
    messageId: string,
    newContent: string,
  ) => Promise<void>;

  /**
   * Delete a message as a tombstone (R20).
   * Sender-only. Ciphertext is nulled; row is retained.
   *
   * @param conversationId - Conversation containing the message
   * @param messageId - ID of the message to delete
   */
  deleteMessage: (
    conversationId: string,
    messageId: string,
  ) => Promise<void>;

  /**
   * Load message history with cursor-based pagination.
   *
   * @param conversationId - Target conversation UUID
   * @param cursor - Optional pagination cursor (serverTimestamp of oldest loaded message)
   */
  loadHistory: (
    conversationId: string,
    cursor?: string,
  ) => Promise<void>;

  /**
   * Sync missed messages after reconnection (R13).
   * Sends per-conversation cursors to server; receives all missed messages.
   */
  syncMessages: () => Promise<void>;

  /** Whether message history is currently being loaded. */
  isLoading: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Default page size for cursor-paginated message history fetches. */
const MESSAGE_PAGE_SIZE = 50;

/** Default Signal Protocol device ID for 1:1 sessions. */
const DEFAULT_DEVICE_ID = 1;

// =============================================================================
// Rate Limiter Utility
// =============================================================================

/**
 * Tracks timestamps of recent message sends for client-side rate limiting (R25).
 * Uses a sliding window of 60 seconds matching RATE_LIMITS.WS_MESSAGE_SEND_PER_MIN.
 */
interface RateLimitState {
  /** Timestamps (ms) of recent message:send events within the current window. */
  sendTimestamps: number[];
}

/**
 * Checks whether sending a new message would exceed the rate limit.
 * Prunes timestamps older than 60 seconds from the window.
 *
 * @param state - Mutable rate limit state ref
 * @returns true if the send would exceed the limit
 */
function isRateLimited(state: RateLimitState): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  // Prune stale timestamps outside the 60-second sliding window
  state.sendTimestamps = state.sendTimestamps.filter(
    (ts) => now - ts < windowMs,
  );
  return state.sendTimestamps.length >= RATE_LIMITS.WS_MESSAGE_SEND_PER_MIN;
}

/**
 * Records a successful message send timestamp in the rate limit window.
 *
 * @param state - Mutable rate limit state ref
 */
function recordSend(state: RateLimitState): void {
  state.sendTimestamps.push(Date.now());
}

// =============================================================================
// Helper: Generate UUID v4 for clientMessageId (R4)
// =============================================================================

/**
 * Generates a UUID v4 string for use as clientMessageId.
 * Falls back to crypto.randomUUID() or a polyfill.
 */
function generateClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// =============================================================================
// Helper: Decrypt a single message (R12)
// =============================================================================

/**
 * Decrypts a single MessageResponse in place, returning the plaintext.
 * Handles tombstoned messages (isDeleted, ciphertext null) gracefully.
 *
 * @param message - The encrypted message from the server
 * @param conversationType - DIRECT or GROUP
 * @returns Decrypted plaintext or empty string for tombstones
 */
async function decryptSingleMessage(
  message: MessageResponse,
  conversationType: ConversationType,
): Promise<string> {
  // Tombstoned messages (R20) have null ciphertext — nothing to decrypt
  if (message.isDeleted || !message.ciphertext) {
    return '';
  }

  try {
    if (conversationType === ConversationType.DIRECT) {
      // Determine if this is a PreKeyWhisperMessage by checking format prefix
      const isPreKey = message.ciphertext.startsWith('3:');
      return await decryptMessage(
        message.senderId,
        DEFAULT_DEVICE_ID,
        message.ciphertext,
        isPreKey,
      );
    }
    // GROUP conversation — use Sender Key decryption (R14)
    return await decryptGroupMessage(
      message.conversationId,
      message.senderId,
      message.ciphertext,
    );
  } catch {
    // Decryption failure — return placeholder rather than crashing the UI.
    // This can happen if the session was lost or Sender Key is stale.
    return '[Unable to decrypt message]';
  }
}

// =============================================================================
// Helper: Index a decrypted message for client-side search (R21)
// =============================================================================

/**
 * Indexes a decrypted message into IndexedDB for client-side full-text search.
 * Only TEXT-type messages with non-empty content are indexed.
 * No network calls are made — search operates entirely locally (R21).
 *
 * @param message - The server message object
 * @param plaintext - The decrypted plaintext content
 * @param conversationName - Display name of the conversation (for search results)
 * @param senderName - Display name of the sender (for search results)
 */
async function indexDecryptedMessage(
  message: MessageResponse,
  plaintext: string,
  conversationName: string,
  senderName: string,
): Promise<void> {
  // Only index TEXT messages with actual content
  if (message.isDeleted || !plaintext || plaintext === '[Unable to decrypt message]') {
    return;
  }

  try {
    await indexMessage({
      id: message.id,
      conversationId: message.conversationId,
      conversationName,
      senderId: message.senderId,
      senderName,
      content: plaintext,
      timestamp: message.serverTimestamp,
      type: message.type,
    });
  } catch {
    // Non-critical: search indexing failure should not break messaging
  }
}

// =============================================================================
// useMessages Hook
// =============================================================================

/**
 * useMessages — primary hook for message CRUD operations in chat UI components.
 *
 * Manages the full lifecycle of messages: send (encrypt → emit → optimistic update),
 * receive (listen → decrypt → store → index), edit (R19), delete (R20), history
 * loading (paginated → decrypt → store → index), and offline sync (R13).
 *
 * @returns UseMessagesReturn object with all message operations and loading state
 */
export function useMessages(): UseMessagesReturn {
  // ─── Store Access ──────────────────────────────────────────────────

  const conversations = useChatStore((state) => state.conversations);
  const messages = useChatStore((state) => state.messages);
  const isLoadingMessages = useChatStore((state) => state.isLoadingMessages);

  const addMessage = useChatStore((state) => state.addMessage);
  const addMessages = useChatStore((state) => state.addMessages);
  const storeEditMessage = useChatStore((state) => state.editMessage);
  const storeDeleteMessage = useChatStore((state) => state.deleteMessage);
  const updateMessageStatus = useChatStore((state) => state.updateMessageStatus);
  const setIsLoadingMessages = useChatStore((state) => state.setIsLoadingMessages);
  const setHasMoreMessages = useChatStore((state) => state.setHasMoreMessages);
  const setMessageCursor = useChatStore((state) => state.setMessageCursor);
  const setMessages = useChatStore((state) => state.setMessages);
  const incrementUnread = useChatStore((state) => state.incrementUnread);

  const user = useAuthStore((state) => state.user);

  // ─── Refs ──────────────────────────────────────────────────────────

  /** Rate limit tracker — mutable ref to avoid re-renders (R25). */
  const rateLimitRef = useRef<RateLimitState>({ sendTimestamps: [] });

  /** Tracks pending operations to prevent duplicate requests. */
  const pendingOpsRef = useRef<Set<string>>(new Set());

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Finds a conversation from the store by ID.
   * Returns undefined if not found.
   */
  const findConversation = useCallback(
    (conversationId: string): ConversationListItem | undefined => {
      return conversations.find((c) => c.id === conversationId);
    },
    [conversations],
  );

  /**
   * Finds a message in the store by conversation and message ID.
   * Returns undefined if not found.
   */
  const findMessage = useCallback(
    (conversationId: string, messageId: string): MessageResponse | undefined => {
      const conversationMessages = messages.get(conversationId);
      if (!conversationMessages) return undefined;
      return conversationMessages.find((m) => m.id === messageId);
    },
    [messages],
  );

  // ─── sendMessage ───────────────────────────────────────────────────

  /**
   * Encrypt and send a message via WebSocket (R12).
   *
   * Flow:
   * 1. Validate auth, connection, and rate limit
   * 2. Encrypt content (Signal Protocol for DIRECT, Sender Key for GROUP)
   * 3. Emit message:send with ack callback
   * 4. Optimistically add to store with SENT status
   * 5. Index plaintext in IndexedDB for search (R21)
   */
  const sendMessage = useCallback(
    async (
      conversationId: string,
      content: string,
      conversationType: ConversationType,
      recipientId?: string,
    ): Promise<void> => {
      // Guard: authenticated user required
      if (!user) {
        throw new Error('Cannot send message: user is not authenticated');
      }

      // Guard: WebSocket must be connected
      if (!isConnected()) {
        throw new Error('Cannot send message: WebSocket is not connected');
      }

      // Guard: rate limit check (R25 — 30 msgs/min)
      if (isRateLimited(rateLimitRef.current)) {
        throw new Error('Rate limit exceeded: maximum 30 messages per minute');
      }

      // Generate unique IDs for this message
      const clientMessageId = generateClientMessageId();
      const correlationId = generateCorrelationId();
      const timestamp = new Date().toISOString();

      // ── Encrypt content (R12) ────────────────────────────────────
      let ciphertext: string;

      if (conversationType === ConversationType.DIRECT) {
        if (!recipientId) {
          throw new Error('recipientId is required for DIRECT conversations');
        }

        // Ensure a Signal Protocol session exists with the recipient
        const sessionExists = await hasSession(recipientId, DEFAULT_DEVICE_ID);
        if (!sessionExists) {
          // Fetch the recipient's prekey bundle from the server
          const bundle = await apiClient.get<PreKeyBundleResponse>(
            `/api/v1/keys/${recipientId}`,
          );
          await createSession(recipientId, DEFAULT_DEVICE_ID, bundle);
        }

        ciphertext = await encryptMessage(
          recipientId,
          DEFAULT_DEVICE_ID,
          content,
        );
      } else {
        // GROUP encryption via Sender Key (R14)
        ciphertext = await encryptGroupMessage(conversationId, content);
      }

      // ── Build the SendMessageDTO-shaped payload for the server ───
      // SendMessageDTO defines the REST create body; the WS payload extends
      // EventMetadata with the same core fields (ciphertext, type, clientMessageId).
      const messageDto: Pick<SendMessageDTO, 'ciphertext' | 'clientMessageId'> = {
        ciphertext,
        clientMessageId,
      };

      // ── Emit via WebSocket ───────────────────────────────────────
      const payload = {
        conversationId,
        ciphertext: messageDto.ciphertext,
        type: MessageType.TEXT,
        clientMessageId: messageDto.clientMessageId,
        correlationId,
        timestamp,
      };

      emitEvent('message:send', payload, (response) => {
        if (response.success && response.data) {
          // Server confirmed — update the optimistic message with server-assigned ID
          // The store deduplicates by clientMessageId (R4)
          addMessage(conversationId, response.data);
        }
      });

      // ── Optimistic store update ──────────────────────────────────
      const optimisticMessage: MessageResponse = {
        id: clientMessageId, // Temporary — replaced when server ack arrives
        conversationId,
        senderId: user.id,
        senderName: user.displayName ?? '',
        ciphertext,
        type: MessageType.TEXT,
        status: MessageStatusEnum.SENT,
        isEdited: false,
        isDeleted: false,
        clientMessageId,
        serverTimestamp: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      addMessage(conversationId, optimisticMessage);

      // Record the send for rate limiting (R25)
      recordSend(rateLimitRef.current);

      // ── Index plaintext for client-side search (R21) ─────────────
      const conversation = findConversation(conversationId);
      await indexDecryptedMessage(
        optimisticMessage,
        content,
        conversation?.displayName ?? '',
        user.displayName ?? '',
      );
    },
    [user, addMessage, findConversation],
  );

  // ─── editMessage ───────────────────────────────────────────────────

  /**
   * Edit an existing message (R19).
   *
   * Constraints:
   * - Current user must be the sender
   * - Within 15-minute edit window from serverTimestamp
   * - New content re-encrypted before PATCH API call
   *
   * Flow:
   * 1. Validate ownership and edit window
   * 2. Encrypt new content with existing session
   * 3. PATCH /api/v1/messages/:id with new ciphertext
   * 4. Update local store (ciphertext swap, isEdited=true)
   * 5. Re-index in search with new content (R21)
   */
  const editMessage = useCallback(
    async (
      conversationId: string,
      messageId: string,
      newContent: string,
    ): Promise<void> => {
      if (!user) {
        throw new Error('Cannot edit message: user is not authenticated');
      }

      // Find the original message in the store
      const originalMessage = findMessage(conversationId, messageId);
      if (!originalMessage) {
        throw new Error('Cannot edit message: message not found in store');
      }

      // R19: sender-only restriction
      if (originalMessage.senderId !== user.id) {
        throw new Error('Cannot edit message: only the sender can edit');
      }

      // R19: 15-minute edit window
      const elapsedMs =
        Date.now() - new Date(originalMessage.serverTimestamp).getTime();
      if (elapsedMs >= TTL.MESSAGE_EDIT_WINDOW_MS) {
        throw new Error(
          'Cannot edit message: edit window has expired (15 minutes)',
        );
      }

      // Determine conversation type for encryption strategy
      const conversation = findConversation(conversationId);
      const conversationType = conversation?.type ?? ConversationType.DIRECT;

      // ── Encrypt new content (R12) ────────────────────────────────
      let newCiphertext: string;

      if (conversationType === ConversationType.DIRECT) {
        // For DIRECT, find the other participant
        // The recipientId is the message's original senderId (us) sending to other side
        // Since we are the sender, we need to encrypt for the conversation partner
        // We'll use the conversationId to figure out who else is in the conversation
        const otherParticipantId = findDirectRecipient(conversation, user.id);
        if (!otherParticipantId) {
          throw new Error('Cannot edit message: unable to determine recipient');
        }

        newCiphertext = await encryptMessage(
          otherParticipantId,
          DEFAULT_DEVICE_ID,
          newContent,
        );
      } else {
        newCiphertext = await encryptGroupMessage(conversationId, newContent);
      }

      // ── PATCH API call (R19) ─────────────────────────────────────
      const editPayload: EditMessageDTO = { ciphertext: newCiphertext };
      await apiClient.patch<void>(
        `/api/v1/messages/${messageId}`,
        editPayload,
      );

      // ── Update local store ───────────────────────────────────────
      const editedAt = new Date().toISOString();
      storeEditMessage(conversationId, messageId, newCiphertext, editedAt);

      // ── Re-index for search (R21) ────────────────────────────────
      const updatedMessage = findMessage(conversationId, messageId);
      if (updatedMessage) {
        await indexDecryptedMessage(
          updatedMessage,
          newContent,
          conversation?.displayName ?? '',
          user.displayName ?? '',
        );
      }
    },
    [user, findMessage, findConversation, storeEditMessage],
  );

  // ─── deleteMessage ─────────────────────────────────────────────────

  /**
   * Delete a message as a tombstone (R20).
   *
   * Soft-delete: ciphertext nulled, isDeleted=true, row retained.
   * All participants receive message:deleted and render "This message was deleted."
   *
   * Flow:
   * 1. Validate sender ownership
   * 2. DELETE /api/v1/messages/:id
   * 3. Update store as tombstone
   * 4. Remove from search index (R21)
   */
  const deleteMessage = useCallback(
    async (
      conversationId: string,
      messageId: string,
    ): Promise<void> => {
      if (!user) {
        throw new Error('Cannot delete message: user is not authenticated');
      }

      // Find the message to verify ownership
      const message = findMessage(conversationId, messageId);
      if (!message) {
        throw new Error('Cannot delete message: message not found in store');
      }

      // R20: sender-only deletion
      if (message.senderId !== user.id) {
        throw new Error('Cannot delete message: only the sender can delete');
      }

      // ── DELETE API call (R20) ────────────────────────────────────
      await apiClient.delete<void>(`/api/v1/messages/${messageId}`);

      // ── Update store as tombstone ────────────────────────────────
      const deletedAt = new Date().toISOString();
      storeDeleteMessage(conversationId, messageId, deletedAt);

      // ── Remove from search index (R21) ───────────────────────────
      try {
        await removeMessageFromIndex(messageId);
      } catch {
        // Non-critical: search de-indexing failure should not break deletion
      }
    },
    [user, findMessage, storeDeleteMessage],
  );

  // ─── loadHistory ───────────────────────────────────────────────────

  /**
   * Load message history with cursor-based pagination.
   *
   * Flow:
   * 1. Fetch encrypted messages from REST API
   * 2. Decrypt each non-tombstoned message (R12)
   * 3. Merge into store via addMessages (deduplicates by clientMessageId R4)
   * 4. Batch-index decrypted messages for search (R21)
   * 5. Update pagination cursors
   */
  const loadHistory = useCallback(
    async (
      conversationId: string,
      cursor?: string,
    ): Promise<void> => {
      // Prevent duplicate concurrent fetches for the same conversation
      const opKey = `loadHistory:${conversationId}:${cursor ?? 'initial'}`;
      if (pendingOpsRef.current.has(opKey)) return;
      pendingOpsRef.current.add(opKey);

      setIsLoadingMessages(true);

      try {
        // ── Fetch from REST API ──────────────────────────────────────
        const queryParams = new URLSearchParams({
          limit: String(MESSAGE_PAGE_SIZE),
        });
        if (cursor) {
          queryParams.set('cursor', cursor);
        }

        const response = await apiClient.get<GetMessagesResponse>(
          `/api/v1/conversations/${conversationId}/messages?${queryParams.toString()}`,
        );

        const fetchedMessages = response.data;
        const { pagination } = response;

        // ── Determine conversation context ─────────────────────────
        const conversation = findConversation(conversationId);
        const conversationType = conversation?.type ?? ConversationType.DIRECT;
        const conversationName = conversation?.displayName ?? '';

        // ── Decrypt each message (R12) ─────────────────────────────
        const decryptedContents = new Map<string, string>();

        for (const msg of fetchedMessages) {
          const plaintext = await decryptSingleMessage(msg, conversationType);
          decryptedContents.set(msg.id, plaintext);
        }

        // ── Merge into store ───────────────────────────────────────
        // For initial load (no cursor), replace all messages to ensure clean state.
        // For paginated loads, append via addMessages (deduplicates by clientMessageId R4).
        if (!cursor) {
          setMessages(conversationId, fetchedMessages);
        } else {
          addMessages(conversationId, fetchedMessages);
        }

        // ── Batch-index for search (R21) ───────────────────────────
        for (const msg of fetchedMessages) {
          const plaintext = decryptedContents.get(msg.id) ?? '';
          await indexDecryptedMessage(
            msg,
            plaintext,
            conversationName,
            msg.senderName ?? '',
          );
        }

        // ── Update pagination state ────────────────────────────────
        setHasMoreMessages(conversationId, pagination.hasMore);
        if (pagination.cursor) {
          setMessageCursor(conversationId, pagination.cursor);
        }
      } finally {
        setIsLoadingMessages(false);
        pendingOpsRef.current.delete(opKey);
      }
    },
    [
      findConversation,
      addMessages,
      setMessages,
      setIsLoadingMessages,
      setHasMoreMessages,
      setMessageCursor,
    ],
  );

  // ─── syncMessages ──────────────────────────────────────────────────

  /**
   * Sync missed messages after WebSocket reconnection (R13).
   *
   * Sends per-conversation cursors (last known message IDs) to the server.
   * Server responds with all missed messages in chronological order.
   * All missed messages must arrive within 3 seconds (R13).
   *
   * Flow:
   * 1. Build per-conversation last-message-ID map
   * 2. Emit message:sync with ack callback
   * 3. Decrypt all missed messages
   * 4. Merge into store
   * 5. Index for search (R21)
   */
  const syncMessages = useCallback(
    async (): Promise<void> => {
      if (!isConnected()) {
        return; // Cannot sync without a WebSocket connection
      }

      // Build last-known-message-ID map for all conversations
      const lastMessageIds: Record<string, string> = {};

      for (const conversation of conversations) {
        const conversationMessages = messages.get(conversation.id);
        if (conversationMessages && conversationMessages.length > 0) {
          // Get the last message (most recent by serverTimestamp — array is sorted ascending)
          const lastMsg = conversationMessages[conversationMessages.length - 1];
          lastMessageIds[conversation.id] = lastMsg.id;
        }
      }

      // If no conversations have messages, nothing to sync
      if (Object.keys(lastMessageIds).length === 0) {
        return;
      }

      const correlationId = generateCorrelationId();
      const timestamp = new Date().toISOString();

      // Emit sync request via WebSocket with ack callback
      return new Promise<void>((resolve) => {
        emitEvent(
          'message:sync',
          {
            lastMessageIds,
            correlationId,
            timestamp,
          },
          async (response) => {
            if (!response.success || !response.data) {
              resolve();
              return;
            }

            const { messages: missedMessages } = response.data;

            // Group missed messages by conversation for batch processing
            const byConversation = new Map<string, MessageResponse[]>();
            for (const msg of missedMessages) {
              const arr = byConversation.get(msg.conversationId) ?? [];
              arr.push(msg);
              byConversation.set(msg.conversationId, arr);
            }

            // Decrypt and merge each conversation's missed messages
            for (const [convId, msgs] of byConversation) {
              const conversation = conversations.find((c) => c.id === convId);
              const conversationType = conversation?.type ?? ConversationType.DIRECT;
              const conversationName = conversation?.displayName ?? '';

              // Decrypt each message
              for (const msg of msgs) {
                const plaintext = await decryptSingleMessage(
                  msg,
                  conversationType,
                );

                // Index for search (R21)
                await indexDecryptedMessage(
                  msg,
                  plaintext,
                  conversationName,
                  msg.senderName ?? '',
                );
              }

              // Merge into store (deduplicates by clientMessageId R4)
              addMessages(convId, msgs);

              // Increment unread count for conversations the user isn't actively viewing
              const activeId = useChatStore.getState().activeConversationId;
              if (convId !== activeId && msgs.length > 0) {
                // Increment unread once per missed message
                msgs.forEach(() => incrementUnread(convId));
              }
            }

            resolve();
          },
        );
      });
    },
    [conversations, messages, addMessages, incrementUnread],
  );

  // ─── WebSocket Event Listeners ─────────────────────────────────────

  useEffect(() => {
    // Ensure the Socket.IO singleton is initialised before registering
    // server-to-client event listeners. getSocket() creates the connection
    // lazily if it hasn't been established yet.
    const socket = getSocket();
    if (!socket.connected && !isConnected()) {
      // Socket exists but hasn't connected yet — listeners will still be
      // registered and will fire once the connection is established.
    }

    /**
     * Handle incoming new message from another participant.
     * Decrypts, adds to store, indexes for search, and sends delivery ack.
     */
    const handleNewMessage = async (data: MessageNewPayload): Promise<void> => {
      const { message: incomingMessage } = data;
      const currentUser = useAuthStore.getState().user;

      // Skip messages we sent (we already have them via optimistic update)
      if (currentUser && incomingMessage.senderId === currentUser.id) {
        return;
      }

      // Determine conversation type for decryption
      const conv = useChatStore
        .getState()
        .conversations.find((c) => c.id === incomingMessage.conversationId);
      const convType = conv?.type ?? ConversationType.DIRECT;

      // Decrypt the incoming message (R12)
      const plaintext = await decryptSingleMessage(incomingMessage, convType);

      // Add to store
      addMessage(incomingMessage.conversationId, incomingMessage);

      // Increment unread count if not the active conversation
      const activeId = useChatStore.getState().activeConversationId;
      if (incomingMessage.conversationId !== activeId) {
        incrementUnread(incomingMessage.conversationId);
      }

      // Index for client-side search (R21)
      await indexDecryptedMessage(
        incomingMessage,
        plaintext,
        conv?.displayName ?? '',
        incomingMessage.senderName ?? '',
      );

      // Send delivery acknowledgement (fire-and-forget)
      if (isConnected()) {
        emitEvent('message:delivered', {
          messageId: incomingMessage.id,
          conversationId: incomingMessage.conversationId,
          correlationId: generateCorrelationId(),
          timestamp: new Date().toISOString(),
        });
      }
    };

    /**
     * Handle message edit broadcast from another participant (R19).
     * Updates the local store with new ciphertext and re-indexes for search.
     */
    const handleEditedMessage = async (
      data: MessageEditedPayload,
    ): Promise<void> => {
      const { messageId, conversationId, ciphertext, editedAt } = data;

      // Update store with new ciphertext
      storeEditMessage(conversationId, messageId, ciphertext, editedAt);

      // Re-decrypt and re-index for search (R21)
      const conv = useChatStore
        .getState()
        .conversations.find((c) => c.id === conversationId);
      const convType = conv?.type ?? ConversationType.DIRECT;

      // Build a temporary message for decryption
      const updatedMsg = useChatStore
        .getState()
        .messages.get(conversationId)
        ?.find((m) => m.id === messageId);

      if (updatedMsg) {
        const plaintext = await decryptSingleMessage(updatedMsg, convType);
        await indexDecryptedMessage(
          updatedMsg,
          plaintext,
          conv?.displayName ?? '',
          updatedMsg.senderName ?? '',
        );
      }
    };

    /**
     * Handle message deletion broadcast from another participant (R20).
     * Updates store as tombstone and removes from search index.
     */
    const handleDeletedMessage = (data: MessageDeletedPayload): void => {
      const { messageId, conversationId, deletedAt } = data;

      // Update store as tombstone (ciphertext nulled, isDeleted=true)
      storeDeleteMessage(conversationId, messageId, deletedAt);

      // Remove from search index (R21) — fire and forget
      removeMessageFromIndex(messageId).catch(() => {
        // Non-critical: search de-indexing failure is non-fatal
      });
    };

    /**
     * Handle message status update (DELIVERED or READ) broadcast from server.
     * Updates the checkmark indicators on our sent messages.
     */
    const handleStatus = (data: MessageStatusPayload): void => {
      const { messageId, conversationId, status } = data;
      updateMessageStatus(
        conversationId,
        messageId,
        status,
      );
    };

    /**
     * Handle sync response broadcast from server (R13).
     * This handles the event-based sync response (as opposed to the ack-based
     * response in syncMessages). Both paths are supported for robustness.
     */
    const handleSyncResponse = async (
      data: MessageSyncResponsePayload,
    ): Promise<void> => {
      const { messages: missedMessages } = data;

      // Group by conversation
      const byConversation = new Map<string, MessageResponse[]>();
      for (const msg of missedMessages) {
        const arr = byConversation.get(msg.conversationId) ?? [];
        arr.push(msg);
        byConversation.set(msg.conversationId, arr);
      }

      const storeState = useChatStore.getState();

      for (const [convId, msgs] of byConversation) {
        const conv = storeState.conversations.find((c) => c.id === convId);
        const convType = conv?.type ?? ConversationType.DIRECT;
        const convName = conv?.displayName ?? '';

        for (const msg of msgs) {
          const plaintext = await decryptSingleMessage(msg, convType);
          await indexDecryptedMessage(
            msg,
            plaintext,
            convName,
            msg.senderName ?? '',
          );
        }

        addMessages(convId, msgs);

        // Increment unread for non-active conversations
        const activeId = storeState.activeConversationId;
        if (convId !== activeId) {
          const currentUser = useAuthStore.getState().user;
          for (const msg of msgs) {
            if (currentUser && msg.senderId !== currentUser.id) {
              incrementUnread(convId);
            }
          }
        }
      }
    };

    // ── Register all listeners ──────────────────────────────────────
    onEvent('message:new', handleNewMessage);
    onEvent('message:edited', handleEditedMessage);
    onEvent('message:deleted', handleDeletedMessage);
    onEvent('message:status', handleStatus);
    onEvent('message:sync:response', handleSyncResponse);

    // ── Cleanup on unmount ──────────────────────────────────────────
    return () => {
      offEvent('message:new', handleNewMessage);
      offEvent('message:edited', handleEditedMessage);
      offEvent('message:deleted', handleDeletedMessage);
      offEvent('message:status', handleStatus);
      offEvent('message:sync:response', handleSyncResponse);
    };
  }, [
    addMessage,
    addMessages,
    storeEditMessage,
    storeDeleteMessage,
    updateMessageStatus,
    incrementUnread,
  ]);

  // ─── Return ────────────────────────────────────────────────────────

  return {
    sendMessage,
    editMessage,
    deleteMessage,
    loadHistory,
    syncMessages,
    isLoading: isLoadingMessages,
  };
}

// =============================================================================
// Private Utility: Find Direct Conversation Recipient
// =============================================================================

/**
 * Extracts the other participant's ID from a DIRECT conversation.
 * Returns undefined if the conversation data is unavailable or is not DIRECT.
 *
 * @param conversation - The conversation list item (may be undefined)
 * @param currentUserId - The current authenticated user's ID
 * @returns The other participant's user ID, or undefined
 */
function findDirectRecipient(
  conversation: ConversationListItem | undefined,
  currentUserId: string,
): string | undefined {
  if (!conversation) return undefined;
  if (conversation.type !== ConversationType.DIRECT) return undefined;

  // ConversationListItem does not expose a participant list or recipientId.
  // For DIRECT conversations we scan the in-memory message history kept in
  // the Zustand store and look for any message whose sender is NOT the
  // current user — that sender is the other participant.
  const storeMessages = useChatStore.getState().messages;
  const conversationMessages = storeMessages.get(conversation.id);

  if (conversationMessages && conversationMessages.length > 0) {
    const otherMessage = conversationMessages.find(
      (m) => m.senderId !== currentUserId,
    );
    if (otherMessage) {
      return otherMessage.senderId;
    }
  }

  return undefined;
}
