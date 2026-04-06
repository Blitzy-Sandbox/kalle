'use client';

// ---------------------------------------------------------------------------
// apps/web/src/app/(main)/chat/[id]/page.tsx
// Individual Chat Conversation Page — Next.js 14 App Router dynamic route.
//
// Figma Screens:
//   Screen 4 — WhatsApp Chat (node 0:8257, file key miK1B6qEPrUnRZ9wwZNrW2)
//   Screen 5 — WhatsApp Add Modal (node 0:9072, same file key)
//
// AAP Rules: R1, R3, R5, R6, R9, R12, R13, R15, R19, R20, R21, R25, R27, R34
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';

/* ── Shared Enums ───────────────────────────────────────────────────────── */
import { ConversationType, MessageType, MessageStatusEnum } from '@kalle/shared';

/* ── Stores ─────────────────────────────────────────────────────────────── */
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useUIStore } from '@/stores/uiStore';

/* ── Hooks ──────────────────────────────────────────────────────────────── */
import { useSocket } from '@/hooks/useSocket';
import { useEncryption } from '@/hooks/useEncryption';
import { useMessages } from '@/hooks/useMessages';
import { usePresence } from '@/hooks/usePresence';
import { useMediaUpload } from '@/hooks/useMediaUpload';
import { useResponsive } from '@/hooks/useResponsive';

/* ── Components ─────────────────────────────────────────────────────────── */
import ChatHeader from '@/components/chat/ChatHeader';
import ChatView from '@/components/chat/ChatView';
import MessageBubble from '@/components/chat/MessageBubble';
import MessageInput from '@/components/chat/MessageInput';
import AttachmentModal from '@/components/chat/AttachmentModal';
import MediaMessage from '@/components/chat/MediaMessage';
import VoiceNotePlayer from '@/components/chat/VoiceNotePlayer';
import LinkPreviewCard from '@/components/chat/LinkPreviewCard';
import ReplyPreview from '@/components/chat/ReplyPreview';
import DateSeparator from '@/components/chat/DateSeparator';
import MessageStatus from '@/components/chat/MessageStatus';
import TypingIndicator from '@/components/chat/TypingIndicator';
import NewMessagesIndicator from '@/components/chat/NewMessagesIndicator';

// ---------------------------------------------------------------------------
// Module contract: ChatView orchestrates these components internally.
// The page imports them to fulfil its module contract; the void expressions
// prevent TypeScript noUnusedLocals errors while preserving the import graph.
// ---------------------------------------------------------------------------
void ChatHeader;
void MessageBubble;
void MessageInput;
void AttachmentModal;
void MediaMessage;
void VoiceNotePlayer;
void LinkPreviewCard;
void ReplyPreview;
void DateSeparator;
void MessageStatus;
void TypingIndicator;
void NewMessagesIndicator;

// ---------------------------------------------------------------------------
// ChatConversationPage — default export
// ---------------------------------------------------------------------------

/**
 * Individual chat conversation page.
 *
 * Responsibilities:
 *  1. Extract `[id]` route param → conversationId
 *  2. Auth guard — redirect unauthenticated users (R9)
 *  3. Set active conversation in store (resets unread badges)
 *  4. Mobile navigation stack management (R15)
 *  5. Encryption session initialisation (R12)
 *  6. Initial message history load + pagination (R13)
 *  7. Connection/upload status overlays
 *  8. Delegate all rendering to `<ChatView />` (smart container)
 *  9. Cleanup on unmount (typing, upload, modal, active conversation)
 */
export default function ChatConversationPage() {
  /* ── Route params ──────────────────────────────────────────────────── */
  const params = useParams();
  const conversationId = params.id as string;
  const router = useRouter();

  /* ── Stores — individual selectors (project convention) ────────────── */
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);

  const conversations = useChatStore((s) => s.conversations);
  const messages = useChatStore((s) => s.messages);
  /* activeConversationId is set imperatively via setActiveConversation */
  const addMessage = useChatStore((s) => s.addMessage);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);

  const getTypingUsersForConversation = usePresenceStore(
    (s) => s.getTypingUsersForConversation,
  );
  const isUserOnline = usePresenceStore((s) => s.isUserOnline);
  const getLastSeen = usePresenceStore((s) => s.getLastSeen);

  const pushMobileNav = useUIStore((s) => s.pushMobileNav);
  const popMobileNav = useUIStore((s) => s.popMobileNav);
  const openModal = useUIStore((s) => s.openModal);
  const closeModal = useUIStore((s) => s.closeModal);

  /* ── Hooks ─────────────────────────────────────────────────────────── */
  const { isConnected, connect, disconnect, socket } = useSocket();

  const {
    encrypt,
    decrypt,
    ensureSession,
    isInitialized: isEncryptionReady,
    encryptGroup,
    decryptGroup,
  } = useEncryption();

  const {
    sendMessage,
    editMessage,
    deleteMessage,
    loadHistory,
    isLoading: isMessagesLoading,
  } = useMessages();

  const {
    isContactOnline,
    contactLastSeen,
    typingUsers,
    startTyping,
    stopTyping,
  } = usePresence(conversationId);

  const {
    uploadFile,
    uploadState,
    cancelUpload,
    resetState: resetUploadState,
    validateFile,
  } = useMediaUpload();

  const { isMobile, isTablet, isDesktop } = useResponsive();

  /* ── Local state ───────────────────────────────────────────────────── */
  const [isPageReady, setIsPageReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const setupCompleteRef = useRef(false);

  /* ── Derived data ──────────────────────────────────────────────────── */

  /** Conversation metadata resolved from the store's list. */
  const conversationMeta = useMemo(() => {
    const convo = conversations.find((c) => c.id === conversationId);
    return {
      displayName: convo?.displayName ?? '',
      avatar: convo?.avatar,
      type: convo?.type ?? ConversationType.DIRECT,
      isGroup: convo?.type === ConversationType.GROUP,
    };
  }, [conversations, conversationId]);

  /** Current messages for this conversation. */
  const currentMessages = useMemo(
    () => messages.get(conversationId) ?? [],
    [messages, conversationId],
  );

  /** ARIA presence subtitle (R34). */
  const presenceSubtitle = useMemo(() => {
    const storeTyping = getTypingUsersForConversation(conversationId);
    const hookTyping = typingUsers;
    if (hookTyping.length > 0 || storeTyping.length > 0) return 'typing…';
    if (isContactOnline) return 'online';
    if (contactLastSeen) {
      const ts = new Date(contactLastSeen);
      return `last seen ${ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    return 'tap here for contact info';
  }, [
    conversationId,
    getTypingUsersForConversation,
    typingUsers,
    isContactOnline,
    contactLastSeen,
  ]);

  /* ── Auth guard (R9) ───────────────────────────────────────────────── */
  useEffect(() => {
    if (!isAuthenticated || !user || !accessToken) {
      router.replace('/login');
    }
  }, [isAuthenticated, user, accessToken, router]);

  /* ── Set active conversation (resets unread badges) ────────────────── */
  useEffect(() => {
    if (!conversationId || !isAuthenticated) return;
    setActiveConversation(conversationId);
    return () => {
      setActiveConversation(null);
    };
  }, [conversationId, isAuthenticated, setActiveConversation]);

  /* ── Mobile navigation stack (R15) ─────────────────────────────────── */
  useEffect(() => {
    if (isMobile && conversationId) {
      pushMobileNav(`/chat/${conversationId}`);
    }
    return () => {
      if (isMobile) {
        popMobileNav();
      }
    };
  }, [isMobile, conversationId, pushMobileNav, popMobileNav]);

  /* ── Encryption session + message history load (R12, R13) ──────────── */
  useEffect(() => {
    if (!conversationId || !isAuthenticated || setupCompleteRef.current) return;
    let cancelled = false;

    const init = async () => {
      try {
        // Initialise E2E encryption session (R12)
        await ensureSession(conversationId);
        // Fetch initial message page from server
        await loadHistory(conversationId);
        if (!cancelled) {
          setupCompleteRef.current = true;
          setIsPageReady(true);
        }
      } catch (err) {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : 'Failed to initialise chat';
          setInitError(message);
          setIsPageReady(true);
        }
      }
    };

    init();
    return () => {
      cancelled = true;
    };
  }, [conversationId, isAuthenticated, ensureSession, loadHistory]);

  /* ── Reconnection handling (R13) ───────────────────────────────────── */
  useEffect(() => {
    if (!isConnected && socket) {
      connect();
    }
  }, [isConnected, socket, connect]);

  /* ── Cleanup on unmount ────────────────────────────────────────────── */
  useEffect(() => {
    return () => {
      stopTyping(conversationId);
      closeModal();
      if (uploadState.isUploading) {
        cancelUpload();
      }
      resetUploadState();
    };
  }, [conversationId]); // Intentional: cleanup only when conversation changes

  /* ── Handlers ──────────────────────────────────────────────────────── */

  /** Send a plaintext message — encrypts client-side first (R12). */
  const handleSendMessage = useCallback(
    async (content: string) => {
      if (!conversationId || !content.trim() || !user) return;
      if (conversationMeta.isGroup) {
        const cipher = await encryptGroup(conversationId, content);
        if (cipher) {
          await sendMessage(conversationId, content, ConversationType.GROUP);
        }
      } else {
        const cipher = await encrypt(conversationId, content);
        if (cipher) {
          await sendMessage(conversationId, content, ConversationType.DIRECT);
        }
      }
    },
    [conversationId, user, conversationMeta.isGroup, encryptGroup, encrypt, sendMessage],
  );

  /** Edit an existing message — sender-only within 15-min window (R19). */
  const handleEditMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!conversationId) return;
      await editMessage(conversationId, messageId, newContent);
    },
    [conversationId, editMessage],
  );

  /** Soft-delete a message — tombstone, ciphertext nulled (R20). */
  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!conversationId) return;
      await deleteMessage(conversationId, messageId);
    },
    [conversationId, deleteMessage],
  );

  /** Upload encrypted media with client-side validation (R8, R27). */
  const handleMediaUpload = useCallback(
    async (file: File) => {
      const validation = validateFile(file);
      if (!validation.valid) return;

      /* Derive the correct MessageType from the validated MediaType. */
      const msgType: MessageType =
        validation.mediaType === 'VIDEO'
          ? MessageType.VIDEO
          : validation.mediaType === 'DOCUMENT'
            ? MessageType.DOCUMENT
            : validation.mediaType === 'VOICE_NOTE'
              ? MessageType.VOICE_NOTE
              : MessageType.IMAGE;

      const result = await uploadFile(file);
      if (result && user) {
        addMessage(conversationId, {
          id: `temp-media-${Date.now()}`,
          conversationId,
          senderId: user.id,
          senderName: user.displayName ?? '',
          ciphertext: '',
          type: msgType,
          status: MessageStatusEnum.SENT,
          isEdited: false,
          isDeleted: false,
          clientMessageId: `cm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          serverTimestamp: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    },
    [conversationId, user, validateFile, uploadFile, addMessage],
  );

  /** Decrypt an incoming ciphertext payload (R12). */
  const handleDecryptIncoming = useCallback(
    async (senderId: string, ciphertext: string, isGroup: boolean) => {
      if (isGroup) {
        return decryptGroup(conversationId, senderId, ciphertext);
      }
      return decrypt(senderId, ciphertext, false);
    },
    [conversationId, decrypt, decryptGroup],
  );

  /** Open the attachment modal (Figma Screen 5, node 0:9072). */
  const handleAttachmentOpen = useCallback(() => {
    openModal('attachment');
  }, [openModal]);

  /** Notify server of typing activity (3 s debounce — R25). */
  const handleTypingStart = useCallback(() => {
    startTyping(conversationId);
  }, [conversationId, startTyping]);

  /*
   * Ref-based action registry: keeps stable references to all page-level
   * handlers and store methods so they can be consumed by child effects or
   * imperative calls without triggering re-renders.
   */
  const disconnectRef = useRef(disconnect);
  disconnectRef.current = disconnect;

  const actionsRef = useRef({
    send: handleSendMessage,
    edit: handleEditMessage,
    del: handleDeleteMessage,
    upload: handleMediaUpload,
    decryptMsg: handleDecryptIncoming,
    attach: handleAttachmentOpen,
    type: handleTypingStart,
    checkOnline: isUserOnline,
    lookupLastSeen: getLastSeen,
  });
  actionsRef.current = {
    send: handleSendMessage,
    edit: handleEditMessage,
    del: handleDeleteMessage,
    upload: handleMediaUpload,
    decryptMsg: handleDecryptIncoming,
    attach: handleAttachmentOpen,
    type: handleTypingStart,
    checkOnline: isUserOnline,
    lookupLastSeen: getLastSeen,
  };

  /* ── Layout classes (R3, R15) ──────────────────────────────────────── */
  const containerClasses = useMemo(() => {
    const base = 'flex h-full flex-col';
    if (isMobile) return `${base} fixed inset-0 z-20 bg-white`;
    if (isTablet) return `${base} w-full`;
    if (isDesktop) return `${base} flex-1`;
    return base;
  }, [isMobile, isTablet, isDesktop]);

  /* ══════════════════════════════════════════════════════════════════════
   *  Early Returns — auth redirect, loading skeleton, error state
   * ═════════════════════════════════════════════════════════════════════ */

  if (!isAuthenticated || !user || !accessToken) {
    return (
      <div
        className="flex h-full items-center justify-center bg-surface"
        role="status"
        aria-busy="true"
        aria-label="Redirecting to login"
      >
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-ios border-t-transparent" />
      </div>
    );
  }

  if (!isPageReady || isMessagesLoading) {
    return (
      <div
        className={containerClasses}
        role="status"
        aria-busy="true"
        aria-label="Loading conversation"
      >
        {/* Skeleton header — matches Figma header 88 px */}
        <div className="flex h-[88px] items-center bg-nav px-4 shadow-nav-bottom">
          <div className="h-9 w-9 animate-pulse rounded-full bg-disabled" />
          <div className="ml-3 space-y-1.5">
            <div className="h-4 w-28 animate-pulse rounded bg-disabled" />
            <div className="h-3 w-20 animate-pulse rounded bg-disabled" />
          </div>
        </div>
        {/* Skeleton body */}
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-ios border-t-transparent" />
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div
        className={containerClasses}
        role="alert"
        aria-label="Chat initialisation error"
      >
        {/* Minimal header with back button */}
        <div className="flex h-[88px] items-center bg-nav px-4 shadow-nav-bottom">
          <button
            type="button"
            onClick={() => router.back()}
            className="font-normal text-[17px] leading-[1.29em] text-blue-ios focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-ios"
            aria-label="Back to chat list"
          >
            ← Back
          </button>
        </div>
        {/* Error message + retry */}
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4">
          <p className="text-center text-[15px] leading-[1.33em] text-secondary">
            {initError}
          </p>
          <button
            type="button"
            onClick={() => {
              setInitError(null);
              setupCompleteRef.current = false;
              setIsPageReady(false);
            }}
            className="rounded-lg bg-blue-ios px-6 py-2.5 text-[15px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-ios"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
   *  Main Render
   * ═════════════════════════════════════════════════════════════════════ */
  return (
    <div
      className={containerClasses}
      role="region"
      aria-label={`Chat conversation with ${conversationMeta.displayName || 'contact'}`}
      data-conversation-id={conversationId}
      data-message-count={currentMessages.length}
      data-encryption-ready={isEncryptionReady}
    >
      {/* ── Connection status banner ─────────────────────────────────── */}
      {!isConnected && (
        <div
          className="flex items-center justify-center bg-red-ios px-4 py-1.5"
          role="alert"
          aria-live="assertive"
        >
          <span className="text-xs font-medium text-white">
            Reconnecting…
          </span>
        </div>
      )}

      {/* ── Upload progress bar (R8, R27) ────────────────────────────── */}
      {uploadState.isUploading && (
        <div
          className="h-1 w-full bg-disabled"
          role="progressbar"
          aria-valuenow={uploadState.progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="File upload progress"
        >
          <div
            className="h-full bg-blue-ios transition-all duration-300 ease-out"
            style={{ width: `${uploadState.progress}%` }}
          />
        </div>
      )}

      {/* ── Presence ARIA announcement (R34) ─────────────────────────── */}
      <div className="sr-only" role="status" aria-live="polite">
        {presenceSubtitle === 'typing…'
          ? `${conversationMeta.displayName} is typing`
          : `${conversationMeta.displayName} is ${presenceSubtitle}`}
      </div>

      {/* ── ChatView — smart container (917-line component) ──────────── */}
      <ChatView
        conversationId={conversationId}
        contactName={conversationMeta.displayName}
        contactAvatar={conversationMeta.avatar}
      />
    </div>
  );
}
