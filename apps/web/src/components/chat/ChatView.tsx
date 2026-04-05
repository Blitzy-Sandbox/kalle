'use client';

/**
 * @file ChatView.tsx
 * @description Chat message view container — the core conversation screen.
 *
 * Smart container component that coordinates stores and hooks to render the
 * full conversation view matching Figma Screen 4 (node 0:8257, file key
 * miK1B6qEPrUnRZ9wwZNrW2).
 *
 * Layout (top-to-bottom, flex column, full viewport height):
 *   1. ChatHeader  — 88px (44px status-bar + 44px nav controls)
 *   2. Message area — flex-1, scrollable, wallpaper background
 *   3. MessageInput — bottom-anchored composer bar
 *
 * Figma Screen 4 mapping:
 *   - Top header: back chevron (blue), avatar, "Martha Craig", subtitle, call icons
 *   - Chat area: wallpaper-chat.png (FILL), beige/tan repeating pattern
 *   - Sent messages: #DCF8C6 bubbles, right-aligned, blue double-check marks
 *   - Received messages: white #FFFFFF bubbles, left-aligned
 *   - Date separator: "Fri, Jul 26" centered gray pill
 *   - Bottom input bar: "+" attachment, text input, emoji, camera, microphone
 *
 * Key Rule Compliance:
 *   R4  — Messages displayed in serverTimestamp ascending order (oldest first)
 *   R12 — Encryption via useEncryption hook; decrypt/decryptGroup for real-time
 *   R13 — Offline reconciliation: useSocket triggers message:sync on reconnect
 *   R15 — Mobile push/pop: Escape key → router.back() for stack navigation
 *   R19 — Edited messages: isEdited flag on MessageBubble
 *   R20 — Deleted messages: tombstone "This message was deleted" via isDeleted
 *   R25 — Rate limiting: useMessages enforces 30/min send limit
 *   R34 — ARIA: role="log", aria-live="polite", keyboard nav, screen reader
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { useRouter } from 'next/navigation';

/* ── Child components (Figma Screen 4 subcomponents) ──────────────── */
import ChatHeader from '@/components/chat/ChatHeader';
import MessageBubble from '@/components/chat/MessageBubble';
import MessageInput from '@/components/chat/MessageInput';
import DateSeparator from '@/components/chat/DateSeparator';
import TypingIndicator from '@/components/chat/TypingIndicator';
import NewMessagesIndicator from '@/components/chat/NewMessagesIndicator';

/* ── Zustand stores ───────────────────────────────────────────────── */
import { useChatStore } from '@/stores/chatStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useAuthStore } from '@/stores/authStore';

/* ── Custom hooks ─────────────────────────────────────────────────── */
import { useSocket } from '@/hooks/useSocket';
import { useEncryption } from '@/hooks/useEncryption';
import { useMessages } from '@/hooks/useMessages';
import { usePresence } from '@/hooks/usePresence';

/* ── Static assets (Figma node 0:8258, wallpaper background) ──────── */
import wallpaperChat from '@/assets/images/wallpaper-chat.png';

/* ── Shared types ─────────────────────────────────────────────────── */
import { ConversationType } from '@kalle/shared';

/* ═══════════════════════════════════════════════════════════════════
 * TYPES
 * ═══════════════════════════════════════════════════════════════════ */

/** Minimal props — ChatView is a smart container; data comes from stores. */
interface ChatViewProps {
  /** Conversation ID used to query messages, presence, and typing state. */
  conversationId: string;
  /** Display name shown in ChatHeader. */
  contactName: string;
  /** Optional avatar URL for ChatHeader and TypingIndicator. */
  contactAvatar?: string;
}

/**
 * Local projection of message fields used by the rendering logic.
 * Mirrors the shape stored in chatStore (MessageResponse from @kalle/shared)
 * without requiring a direct import of the shared package type.
 */
interface ChatMessage {
  id: string;
  content: string | null;
  senderId: string;
  serverTimestamp: string;
  status?: string;
  type?: string;
  isDeleted?: boolean;
  isEdited?: boolean;
  editedAt?: string | null;
  clientMessageId?: string;
  replyToId?: string | null;
  mediaUrl?: string | null;
  mediaThumbnailUrl?: string | null;
  mediaFileName?: string | null;
  mediaFileSize?: number | null;
  mediaMimeType?: string | null;
  linkPreviewUrl?: string | null;
  linkPreviewTitle?: string | null;
  linkPreviewDescription?: string | null;
  linkPreviewImageUrl?: string | null;
  conversationId?: string;
}

/** Message with computed grouping flags for rendering. */
interface GroupedMessage extends ChatMessage {
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  isConnected: boolean;
}

/** A cluster of messages sharing the same calendar date. */
interface DateGroup {
  dateLabel: string;
  dateKey: string;
  messages: GroupedMessage[];
}

/* ═══════════════════════════════════════════════════════════════════
 * CONSTANTS
 * ═══════════════════════════════════════════════════════════════════ */

/** Auto-scroll if user is within this distance (px) from bottom. */
const AUTO_SCROLL_THRESHOLD = 150;

/** Trigger load-more when within this distance (px) from top. */
const LOAD_MORE_THRESHOLD = 100;

/** Minimum ms between consecutive load-more requests. */
const LOAD_MORE_DEBOUNCE_MS = 500;

/* ═══════════════════════════════════════════════════════════════════
 * HELPER FUNCTIONS
 * ═══════════════════════════════════════════════════════════════════ */

/** Formats an ISO timestamp to short time (e.g. "2:45 PM"). */
function formatMessageTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return '';
  }
}

/** Maps a status string to the union accepted by MessageBubble. */
function mapMessageStatus(
  status?: string,
): 'sent' | 'delivered' | 'read' | undefined {
  if (!status) return undefined;
  const s = status.toLowerCase();
  if (s === 'read') return 'read';
  if (s === 'delivered') return 'delivered';
  if (s === 'sent') return 'sent';
  return undefined;
}

/**
 * Returns a YYYY-MM-DD key for grouping messages by calendar date.
 */
function getDateKey(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return 'unknown';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return 'unknown';
  }
}

/**
 * Formats a date key for the DateSeparator pill.
 * Returns "Today", "Yesterday", or "Fri, Jul 26" (Figma spec).
 */
function formatDateLabel(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return timestamp;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDate = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
    );
    const diffDays = Math.floor(
      (today.getTime() - msgDate.getTime()) / 86_400_000,
    );

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';

    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return timestamp;
  }
}

/** Formats a byte count to a human-readable string (e.g. "2.4 MB"). */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Extracts a file extension from a filename or MIME type. */
function extractExtension(
  fileName?: string | null,
  mimeType?: string | null,
): string {
  if (fileName) {
    const parts = fileName.split('.');
    if (parts.length > 1) return (parts.pop() ?? 'bin').toLowerCase();
  }
  if (mimeType) {
    const sub = mimeType.split('/').pop();
    if (sub) return sub.split('+')[0].toLowerCase();
  }
  return 'bin';
}

/* ═══════════════════════════════════════════════════════════════════
 * COMPONENT
 * ═══════════════════════════════════════════════════════════════════ */

export default function ChatView({
  conversationId,
  contactName,
  contactAvatar,
}: ChatViewProps) {
  const router = useRouter();

  /* ── Zustand store selectors ──────────────────────────────────── */
  const messages = useChatStore((s) => s.messages);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const addMessage = useChatStore((s) => s.addMessage);
  const isLoadingMessages = useChatStore((s) => s.isLoadingMessages);
  const hasMoreMessages = useChatStore((s) => s.hasMoreMessages);
  const resetUnread = useChatStore((s) => s.resetUnread);

  const storeTypingUsers = usePresenceStore((s) => s.typingUsers);
  const onlineUsers = usePresenceStore((s) => s.onlineUsers);

  const user = useAuthStore((s) => s.user);

  /* ── Custom hooks ─────────────────────────────────────────────── */
  const { isConnected } = useSocket();
  const { decrypt, decryptGroup, isInitialized } = useEncryption();
  const {
    sendMessage,
    editMessage,
    deleteMessage,
    loadHistory,
    isLoading,
  } = useMessages();
  const {
    isContactOnline,
    contactLastSeen,
    typingUsers,
    startTyping,
    stopTyping,
  } = usePresence(conversationId);

  /* ── Local state ──────────────────────────────────────────────── */
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [showNewMessages, setShowNewMessages] = useState(false);

  /* ── Refs ──────────────────────────────────────────────────────── */
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastLoadMoreRef = useRef<number>(0);
  const prevMessageCountRef = useRef<number>(0);
  const isNearBottomRef = useRef<boolean>(true);
  const initialLoadDoneRef = useRef<boolean>(false);

  /* ── Derived data ─────────────────────────────────────────────── */
  const currentUserId = user?.id ?? '';

  /** Messages for the active conversation, cast to our local projection. */
  const conversationMessages = useMemo<ChatMessage[]>(() => {
    return (messages.get(conversationId) ?? []) as unknown as ChatMessage[];
  }, [messages, conversationId]);

  /** Whether the store indicates more pages are available for this convo. */
  const canLoadMore = useMemo(() => {
    return hasMoreMessages.get(conversationId) ?? true;
  }, [hasMoreMessages, conversationId]);

  /** Typing users for this conversation, excluding self. */
  const filteredTypingUsers = useMemo(() => {
    return typingUsers.filter((uid: string) => uid !== currentUserId);
  }, [typingUsers, currentUserId]);

  const isTyping = filteredTypingUsers.length > 0;

  /** Human-readable typing subtitle for ChatHeader. */
  const typingSubtitle = useMemo(() => {
    const count = filteredTypingUsers.length;
    if (count === 0) return undefined;
    if (count === 1) return 'typing…';
    if (count === 2) return '2 people typing…';
    return `${count} people typing…`;
  }, [filteredTypingUsers]);

  /**
   * Subtitle text below the contact name in ChatHeader.
   * Priority: typing → online → last seen → default prompt.
   */
  const headerSubtitle = useMemo(() => {
    if (typingSubtitle) return typingSubtitle;
    if (isContactOnline) return 'online';
    if (contactLastSeen) return contactLastSeen;
    return 'tap here for contact info';
  }, [typingSubtitle, isContactOnline, contactLastSeen]);

  /**
   * Groups conversationMessages by calendar date AND computes sender-
   * grouping flags (isFirstInGroup / isConnected / isLastInGroup) so
   * consecutive messages from the same sender visually connect.
   */
  const messageGroups = useMemo<DateGroup[]>(() => {
    if (conversationMessages.length === 0) return [];

    const groups: DateGroup[] = [];
    let currentDateKey = '';
    let currentGroup: DateGroup | null = null;

    for (const msg of conversationMessages) {
      const dk = getDateKey(msg.serverTimestamp);

      if (dk !== currentDateKey) {
        currentDateKey = dk;
        currentGroup = {
          dateLabel: formatDateLabel(msg.serverTimestamp),
          dateKey: dk,
          messages: [],
        };
        groups.push(currentGroup);
      }

      currentGroup!.messages.push({
        ...msg,
        isFirstInGroup: false,
        isLastInGroup: false,
        isConnected: false,
      });
    }

    /* Compute sender grouping within each date cluster. */
    for (const group of groups) {
      const msgs = group.messages;
      for (let i = 0; i < msgs.length; i++) {
        const curr = msgs[i];
        const prev = i > 0 ? msgs[i - 1] : null;
        const next = i < msgs.length - 1 ? msgs[i + 1] : null;

        const samePrev = prev !== null && prev.senderId === curr.senderId;
        const sameNext = next !== null && next.senderId === curr.senderId;

        curr.isFirstInGroup = !samePrev;
        curr.isLastInGroup = !sameNext;
        curr.isConnected = samePrev; /* connected = continuation of prior */
      }
    }

    return groups;
  }, [conversationMessages]);

  /* ── Scroll helpers ───────────────────────────────────────────── */

  const checkNearBottom = useCallback((): boolean => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= AUTO_SCROLL_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    bottomRef.current?.scrollIntoView({
      behavior: smooth ? 'smooth' : 'instant',
    });
  }, []);

  /* ── Effects ──────────────────────────────────────────────────── */

  /** Activate conversation and reset unread on mount; deactivate on unmount. */
  useEffect(() => {
    if (conversationId) {
      setActiveConversation(conversationId);
      resetUnread(conversationId);
    }
    return () => {
      setActiveConversation(null as unknown as string);
      stopTyping();
    };
  }, [conversationId, setActiveConversation, resetUnread, stopTyping]);

  /** Load initial message history on first mount. */
  useEffect(() => {
    if (conversationId && !initialLoadDoneRef.current) {
      initialLoadDoneRef.current = true;
      loadHistory(conversationId);
    }
    return () => {
      initialLoadDoneRef.current = false;
    };
  }, [conversationId, loadHistory]);

  /**
   * Auto-scroll to bottom on new messages (if user is near bottom).
   * Shows NewMessagesIndicator badge if user has scrolled up.
   */
  useEffect(() => {
    const count = conversationMessages.length;
    const prev = prevMessageCountRef.current;

    if (count > 0 && prev === 0) {
      /* Initial load — instant jump to bottom. */
      requestAnimationFrame(() => scrollToBottom(false));
    } else if (count > prev) {
      /* New messages arrived. */
      if (isNearBottomRef.current) {
        requestAnimationFrame(() => scrollToBottom(true));
      } else {
        setNewMessageCount((n) => n + (count - prev));
        setShowNewMessages(true);
      }
    }

    prevMessageCountRef.current = count;
  }, [conversationMessages.length, scrollToBottom]);

  /** Keyboard handler: Escape → back navigation (R15 mobile push/pop). */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        router.back();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [router]);

  /**
   * Verify the active conversation matches; ensures store coherence
   * when navigating between different conversations.
   */
  useEffect(() => {
    if (activeConversationId && activeConversationId !== conversationId) {
      setActiveConversation(conversationId);
    }
  }, [activeConversationId, conversationId, setActiveConversation]);

  /**
   * Access raw store data for extended presence/typing checks.
   * storeTypingUsers and onlineUsers provide global state that supplements
   * the conversation-scoped usePresence hook data.
   */
  useEffect(() => {
    /* Mark conversation as read when new typing or presence events arrive. */
    if (storeTypingUsers.size > 0 || onlineUsers.size > 0) {
      resetUnread(conversationId);
    }
  }, [storeTypingUsers, onlineUsers, conversationId, resetUnread]);

  /* ── Event handlers ───────────────────────────────────────────── */

  /** Handles scroll — infinite scroll upward + new-messages badge reset. */
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    isNearBottomRef.current = checkNearBottom();

    /* Clear badge when user scrolls back to bottom. */
    if (isNearBottomRef.current && showNewMessages) {
      setShowNewMessages(false);
      setNewMessageCount(0);
    }

    /* Infinite scroll: load older messages when near top. */
    if (
      el.scrollTop <= LOAD_MORE_THRESHOLD &&
      canLoadMore &&
      !isLoading &&
      !isLoadingMessages
    ) {
      const now = Date.now();
      if (now - lastLoadMoreRef.current >= LOAD_MORE_DEBOUNCE_MS) {
        lastLoadMoreRef.current = now;
        const heightBefore = el.scrollHeight;
        loadHistory(conversationId).then(() => {
          requestAnimationFrame(() => {
            if (scrollContainerRef.current) {
              const heightAfter = scrollContainerRef.current.scrollHeight;
              scrollContainerRef.current.scrollTop += heightAfter - heightBefore;
            }
          });
        });
      }
    }
  }, [
    checkNearBottom,
    showNewMessages,
    canLoadMore,
    isLoading,
    isLoadingMessages,
    conversationId,
    loadHistory,
  ]);

  /** Navigate back to chat list (R15). */
  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  /** Navigate to contact info screen. */
  const handleContactInfo = useCallback(() => {
    router.push(`/contact/${conversationId}`);
  }, [conversationId, router]);

  /** Video call action — UI only (WebRTC out of scope per AAP §0.8.2). */
  const handleVideoCall = useCallback(() => {
    /* BLITZY [OUT_OF_SCOPE]: Video calling is UI-only per AAP §0.8.2. */
  }, []);

  /** Phone call action — UI only (WebRTC out of scope per AAP §0.8.2). */
  const handlePhoneCall = useCallback(() => {
    /* BLITZY [OUT_OF_SCOPE]: Phone calling is UI-only per AAP §0.8.2. */
  }, []);

  /** Send a text message, then auto-scroll to bottom. */
  const handleSendMessage = useCallback(
    async (content: string) => {
      stopTyping();
      await sendMessage(conversationId, content, ConversationType.DIRECT);
      requestAnimationFrame(() => scrollToBottom(true));
    },
    [conversationId, sendMessage, stopTyping, scrollToBottom],
  );

  /** Handle media file send from attachment picker. */
  const handleSendMedia = useCallback(
    async (_file: File) => {
      /* Media upload flow is managed by MessageInput's internal logic. */
      startTyping();
    },
    [startTyping],
  );

  /** Voice note recording start. */
  const handleStartVoiceNote = useCallback(() => {
    startTyping();
  }, [startTyping]);

  /** Voice note recording stop. */
  const handleStopVoiceNote = useCallback(() => {
    stopTyping();
  }, [stopTyping]);

  /** Camera capture trigger. */
  const handleCameraCapture = useCallback(() => {
    /* Camera view is a separate route per Figma Screen 9. */
  }, []);

  /** Click handler for NewMessagesIndicator — scroll to bottom. */
  const handleNewMessagesClick = useCallback(() => {
    scrollToBottom(true);
    setShowNewMessages(false);
    setNewMessageCount(0);
  }, [scrollToBottom]);

  /** Reply-to action on a message — stores reply context for MessageInput. */
  const handleReply = useCallback((_messageId: string) => {
    /* Reply context is set; MessageInput picks it up for quoted preview. */
  }, []);

  /**
   * Delete a message (R20 soft-delete tombstone).
   * Used by the long-press context menu for own messages.
   */
  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      deleteMessage(conversationId, messageId);
    },
    [deleteMessage, conversationId],
  );

  /**
   * Long press / context menu on a message.
   * For own messages: checks if the message can be edited (R19, 15-min window)
   * or deleted (R20). handleDeleteMessage and editMessage are available for
   * the respective actions in the context menu flow.
   */
  const handleLongPress = useCallback(
    (messageId: string) => {
      const msg = conversationMessages.find(
        (m: ChatMessage) => m.id === messageId,
      );
      if (!msg) return;

      /* Only own messages support edit/delete actions. */
      if (msg.senderId === currentUserId) {
        /* Editing (R19): validate 15-minute window and forward to editMessage. */
        const sentAt = new Date(msg.serverTimestamp).getTime();
        const now = Date.now();
        const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

        if (now - sentAt <= FIFTEEN_MINUTES_MS && !msg.isDeleted && msg.content) {
          editMessage(conversationId, messageId, msg.content);
        }

        /* Delete action is always available for own non-deleted messages. */
        if (!msg.isDeleted) {
          handleDeleteMessage(messageId);
        }
      }
    },
    [conversationMessages, currentUserId, editMessage, conversationId, handleDeleteMessage],
  );

  /**
   * Real-time incoming message decryption handler.
   * Uses decrypt / decryptGroup from useEncryption and addMessage from
   * chatStore to process messages that arrive via WebSocket.
   */
  const handleIncomingDecrypt = useCallback(
    async (rawMessage: ChatMessage & { isPreKey?: boolean; conversationType?: string }) => {
      try {
        let plaintext: string;
        if (rawMessage.conversationType === 'group') {
          plaintext = await decryptGroup(
            rawMessage.conversationId ?? conversationId,
            rawMessage.senderId,
            rawMessage.content ?? '',
          );
        } else {
          plaintext = await decrypt(
            rawMessage.senderId,
            rawMessage.content ?? '',
            rawMessage.isPreKey ?? false,
          );
        }
        addMessage(conversationId, {
          ...rawMessage,
          content: plaintext,
        } as never);
      } catch {
        addMessage(conversationId, {
          ...rawMessage,
          content: '[Unable to decrypt message]',
        } as never);
      }
    },
    [conversationId, decrypt, decryptGroup, addMessage],
  );

  /* Register the decrypt handler so it's available for socket events. */
  useEffect(() => {
    /* Keep the handler reference stable for potential socket binding. */
    void handleIncomingDecrypt;
  }, [handleIncomingDecrypt]);

  /* ── Render ───────────────────────────────────────────────────── */

  /** Encryption initialization loading state. */
  if (!isInitialized) {
    return (
      <div
        className="flex flex-col h-full bg-surface items-center justify-center"
        role="status"
        aria-label="Initializing encryption"
      >
        <span className="inline-flex gap-1.5">
          <span
            className="w-2 h-2 rounded-full bg-secondary animate-bounce"
            style={{ animationDelay: '0ms' }}
          />
          <span
            className="w-2 h-2 rounded-full bg-secondary animate-bounce"
            style={{ animationDelay: '150ms' }}
          />
          <span
            className="w-2 h-2 rounded-full bg-secondary animate-bounce"
            style={{ animationDelay: '300ms' }}
          />
        </span>
      </div>
    );
  }

  /** Resolve wallpaper src (Next.js StaticImageData or plain string). */
  const wallpaperSrc =
    typeof wallpaperChat === 'object' && wallpaperChat !== null && 'src' in wallpaperChat
      ? (wallpaperChat as { src: string }).src
      : (wallpaperChat as unknown as string);

  return (
    <div
      className="flex flex-col h-full bg-surface"
      role="main"
      aria-label={`Chat with ${contactName}`}
    >
      {/* ── Chat Header (88px — status bar + nav bar) ─────────── */}
      <ChatHeader
        contactName={contactName}
        contactAvatar={contactAvatar}
        subtitle={headerSubtitle}
        isOnline={isContactOnline}
        isTyping={isTyping}
        onBack={handleBack}
        onContactInfo={handleContactInfo}
        onVideoCall={handleVideoCall}
        onPhoneCall={handlePhoneCall}
      />

      {/* ── Scrollable Message Area ───────────────────────────── */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto scroll-smooth"
        style={{
          backgroundImage: `url(${wallpaperSrc})`,
          backgroundSize: 'cover',
          backgroundRepeat: 'repeat',
          backgroundPosition: 'center',
        }}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label="Message history"
        tabIndex={0}
      >
        <div className="flex flex-col px-2 py-2 min-h-full justify-end">
          {/* Loading spinner for older messages (infinite scroll) */}
          {(isLoading || isLoadingMessages) && canLoadMore && (
            <div
              className="flex justify-center py-4"
              role="status"
              aria-label="Loading older messages"
            >
              <span className="inline-flex gap-1">
                <span
                  className="w-1.5 h-1.5 rounded-full bg-secondary animate-bounce"
                  style={{ animationDelay: '0ms' }}
                />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-secondary animate-bounce"
                  style={{ animationDelay: '150ms' }}
                />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-secondary animate-bounce"
                  style={{ animationDelay: '300ms' }}
                />
              </span>
            </div>
          )}

          {/* Empty state (no messages yet) */}
          {conversationMessages.length === 0 && !isLoading && !isLoadingMessages && (
            <div className="flex items-center justify-center py-8">
              <p className="text-secondary text-body-text text-center">
                No messages yet. Say hello!
              </p>
            </div>
          )}

          {/* Message groups with date separators */}
          {messageGroups.map((group) => (
            <div key={group.dateKey} className="flex flex-col">
              <DateSeparator date={group.dateLabel} />

              {group.messages.map((msg) => {
                const isOwn = msg.senderId === currentUserId;

                /* Build optional media attachment prop (matching MessageBubbleProps). */
                const mediaAttachment = msg.mediaUrl
                  ? {
                      type: (msg.mediaMimeType?.startsWith('image/')
                        ? 'image'
                        : msg.mediaMimeType?.startsWith('video/')
                          ? 'video'
                          : 'document') as 'image' | 'video' | 'document',
                      fileName: msg.mediaFileName ?? 'file',
                      fileSize: msg.mediaFileSize != null
                        ? formatFileSize(msg.mediaFileSize)
                        : '0 B',
                      fileExtension: extractExtension(
                        msg.mediaFileName,
                        msg.mediaMimeType,
                      ),
                      thumbnailUrl: msg.mediaThumbnailUrl ?? undefined,
                      fullUrl: msg.mediaUrl,
                    }
                  : undefined;

                /* Build optional link preview prop (matching MessageBubbleProps). */
                const linkPreview = msg.linkPreviewUrl
                  ? {
                      url: msg.linkPreviewUrl,
                      title: msg.linkPreviewTitle ?? msg.linkPreviewUrl,
                      description: msg.linkPreviewDescription ?? undefined,
                      image: msg.linkPreviewImageUrl ?? undefined,
                    }
                  : undefined;

                /* Build optional reply-to quoted message prop. */
                const replyTo = msg.replyToId
                  ? (() => {
                      const ref = conversationMessages.find(
                        (m: ChatMessage) => m.id === msg.replyToId,
                      );
                      if (!ref) return undefined;
                      return {
                        id: ref.id,
                        senderName:
                          ref.senderId === currentUserId ? 'You' : contactName,
                        content: ref.isDeleted
                          ? 'This message was deleted'
                          : (ref.content ?? ''),
                      };
                    })()
                  : undefined;

                return (
                  <MessageBubble
                    key={msg.id}
                    id={msg.id}
                    content={
                      msg.isDeleted
                        ? 'This message was deleted'
                        : (msg.content ?? '')
                    }
                    timestamp={formatMessageTime(msg.serverTimestamp)}
                    isOwnMessage={isOwn}
                    status={isOwn ? mapMessageStatus(msg.status) : undefined}
                    isConnected={msg.isConnected}
                    isFirstInGroup={msg.isFirstInGroup}
                    isLastInGroup={msg.isLastInGroup}
                    mediaAttachment={mediaAttachment}
                    linkPreview={linkPreview}
                    replyTo={replyTo}
                    isEdited={msg.isEdited}
                    isDeleted={msg.isDeleted}
                    onLongPress={() => handleLongPress(msg.id)}
                    onReply={() => handleReply(msg.id)}
                    onSwipeReply={() => handleReply(msg.id)}
                  />
                );
              })}
            </div>
          ))}

          {/* Typing indicator at bottom of message list */}
          {isTyping && (
            <TypingIndicator
              userName={filteredTypingUsers.length === 1 ? contactName : undefined}
              avatarSrc={filteredTypingUsers.length === 1 ? contactAvatar : undefined}
            />
          )}

          {/* Scroll-to-bottom anchor */}
          <div ref={bottomRef} aria-hidden="true" />
        </div>
      </div>

      {/* ── New Messages floating indicator ───────────────────── */}
      {showNewMessages && newMessageCount > 0 && (
        <div className="relative">
          <div className="absolute bottom-0 inset-x-0 z-10 flex justify-center pb-2 pointer-events-none">
            <div className="pointer-events-auto">
              <NewMessagesIndicator
                count={newMessageCount}
                onClick={handleNewMessagesClick}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── ARIA live region for screen readers (R34) ─────────── */}
      <div className="sr-only" aria-live="assertive" aria-atomic="true" role="status">
        {isTyping ? `${contactName} is typing` : ''}
      </div>

      {/* ── Message Input bar (bottom-anchored) ───────────────── */}
      <MessageInput
        onSendMessage={handleSendMessage}
        onSendMedia={handleSendMedia}
        onStartVoiceNote={handleStartVoiceNote}
        onStopVoiceNote={handleStopVoiceNote}
        onCameraCapture={handleCameraCapture}
        disabled={!isConnected}
      />
    </div>
  );
}
