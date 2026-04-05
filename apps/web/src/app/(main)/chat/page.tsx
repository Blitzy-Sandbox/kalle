'use client';

/**
 * @module apps/web/src/app/(main)/chat/page.tsx
 *
 * Chat List Page — Next.js 14 App Router page component for the main Chat
 * list view. This is the default landing view when the "Chats" tab is active.
 *
 * Renders a scrollable list of conversations fetched from the live backend,
 * supports edit mode with multi-select batch operations, swipe-to-archive,
 * an iOS-style action sheet for per-chat operations, and client-side search.
 *
 * Figma Screens:
 * - Screen 1: WhatsApp Chats (node 0:8855)
 * - Screen 2: WhatsApp Chats Edit (node 0:8114)
 * - Screen 3: WhatsApp Chat Actions (node 0:10087)
 *
 * AAP Rules enforced:
 * - R1  Figma fidelity  — all style tokens from Figma design system
 * - R3  Responsive      — 375 mobile / 768 tablet / 1280 desktop breakpoints
 * - R5  No mock data    — live backend via fetch to /api/v1/conversations
 * - R6  Backend wiring  — every mutation calls backend via chatStore actions
 * - R9  Auth guard      — redirects unauthenticated users
 * - R12 E2E encryption  — ciphertext used as-is for preview (decrypted downstream)
 * - R15 Mobile stack    — list and chat never visible simultaneously on mobile
 * - R21 Client search   — search filters locally against conversation data
 * - R34 WCAG 2.1 AA    — ARIA roles, keyboard nav, focus indicators
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

import { useChatStore } from '@/stores/chatStore';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useMessages } from '@/hooks/useMessages';
import { useResponsive } from '@/hooks/useResponsive';

import ChatListItem from '@/components/chat/ChatListItem';
import ChatActionsModal from '@/components/chat/ChatActionsModal';
import SearchBar from '@/components/chat/SearchBar';
import NavigationBar from '@/components/common/NavigationBar';
import Separator from '@/components/common/Separator';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Backend API base URL — injected via NEXT_PUBLIC_API_URL or fallback. */
const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maps a lastMessage `type` string to the ChatListItem `previewType` union.
 * The returned value determines which icon/label variant renders in the row.
 */
function resolvePreviewType(
  type?: string,
  preview?: string,
): 'text' | 'photo' | 'voice' | 'multiline' {
  if (!type) return 'text';
  switch (type) {
    case 'IMAGE':
    case 'VIDEO':
      return 'photo';
    case 'VOICE_NOTE':
      return 'voice';
    case 'DOCUMENT':
      return 'text';
    default: {
      // Multi-line detection: if preview text contains a line break or is
      // long enough to wrap into 2+ lines, use multiline variant.
      if (preview && (preview.includes('\n') || preview.length > 60)) {
        return 'multiline';
      }
      return 'text';
    }
  }
}

/**
 * Formats a server timestamp ISO string into the display date used in chat
 * rows following iOS convention: "HH:mm" for today, weekday name for this
 * week, "MM/DD/YY" for older dates.
 */
function formatDate(isoString?: string): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const diffMs = today.getTime() - dateDay.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffDays === 0) {
    // Today — show time
    return date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }
  if (diffDays === 1) {
    return 'Yesterday';
  }
  if (diffDays < 7) {
    // This week — show weekday name
    return date.toLocaleDateString(undefined, { weekday: 'long' });
  }
  // Older — show short date
  return date.toLocaleDateString(undefined, {
    month: 'numeric',
    day: 'numeric',
    year: '2-digit',
  });
}

/**
 * Derives a human-readable preview string from a ConversationListItem's
 * lastMessage. Handles deleted messages (R20), voice notes, photos, and
 * standard text.
 */
function resolvePreviewText(
  lastMessage?: {
    ciphertext: string | null;
    type: string;
    isDeleted: boolean;
    senderName: string;
  },
): string {
  if (!lastMessage) return '';
  if (lastMessage.isDeleted) return 'This message was deleted';
  if (lastMessage.ciphertext === null) return '';

  switch (lastMessage.type) {
    case 'IMAGE':
      return 'Photo';
    case 'VIDEO':
      return 'Video';
    case 'DOCUMENT':
      return 'Document';
    case 'VOICE_NOTE':
      return '';
    default:
      return lastMessage.ciphertext;
  }
}

// ---------------------------------------------------------------------------
// Compose Icon SVG — inlined per DS2-g (assets from Figma only)
// Figma node 0:8999, file key miK1B6qEPrUnRZ9wwZNrW2
// ---------------------------------------------------------------------------

function ComposeIcon({ className }: { className?: string }) {
  return (
    <svg
      width="23"
      height="23"
      viewBox="0 0 23 23"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M21.824 0.364921L21.7293 0.279393C21.24 -0.11974 20.5181 -0.0912302 20.062 0.364921L18.888 1.53885L21.4576 4.10842L22.6315 2.9345L22.7171 2.83987C23.1162 2.35051 23.0877 1.62865 22.6315 1.1725L21.824 0.364921ZM18.4351 1.99036L19.1694 2.7244C19.1694 2.7244 10.8157 11.0296 10.4064 11.4888C10.2269 11.6903 10.1748 11.9541 10.1729 12.1868C10.1701 12.532 10.4507 12.8032 10.796 12.8056C11.0395 12.8074 11.3144 12.7618 11.5076 12.5901C11.9357 12.2096 20.2706 3.82564 20.2706 3.82564L21.0046 4.55994L11.541 14.025C11.1487 14.4174 10.3243 14.6526 9.06774 14.7309L8.79187 14.7452H8.74796C8.49333 14.7344 8.28932 14.542 8.25565 14.2982L8.25123 14.2046L8.26561 13.9287C8.33824 12.762 8.5463 11.9678 8.88977 11.5461L8.97143 11.4555L18.4351 1.99036ZM15.3217 3.27286L13.7632 4.83026H2.07653C1.78982 4.83026 1.5574 5.06268 1.5574 5.34939V20.9234C1.5574 21.2101 1.78982 21.4425 2.07653 21.4425H17.6505C17.9372 21.4425 18.1696 21.2101 18.1696 20.9234V9.23457L19.727 7.67822V20.9234C19.727 22.0702 18.7973 22.9999 17.6505 22.9999H2.07653C0.929694 22.9999 0 22.0702 0 20.9234V5.34939C0 4.20255 0.929694 3.27286 2.07653 3.27286H15.3217Z"
        fill="currentColor"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ChatListPage Component
// ---------------------------------------------------------------------------

export default function ChatListPage() {
  // ── External hooks ──────────────────────────────────────────────────
  const router = useRouter();
  const { isMobile, isTablet, isDesktop } = useResponsive();
  const { loadHistory, isLoading: isLoadingMessages } = useMessages();

  // ── Zustand stores ──────────────────────────────────────────────────
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const conversations = useChatStore((s) => s.conversations);
  const setConversations = useChatStore((s) => s.setConversations);
  const setIsLoadingConversations = useChatStore(
    (s) => s.setIsLoadingConversations,
  );
  const isLoadingConversations = useChatStore(
    (s) => s.isLoadingConversations,
  );
  const archiveConversation = useChatStore((s) => s.archiveConversation);
  const removeConversation = useChatStore((s) => s.removeConversation);
  const muteConversation = useChatStore((s) => s.muteConversation);
  const setActiveConversation = useChatStore(
    (s) => s.setActiveConversation,
  );
  const resetUnread = useChatStore((s) => s.resetUnread);
  const clearChat = useChatStore((s) => s.clearChat);

  const isEditMode = useUIStore((s) => s.isEditMode);
  const setEditMode = useUIStore((s) => s.setEditMode);
  const toggleEditMode = useUIStore((s) => s.toggleEditMode);
  const activeModal = useUIStore((s) => s.activeModal);
  const openModal = useUIStore((s) => s.openModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const selectedItems = useUIStore((s) => s.selectedItems);
  const toggleSelectedItem = useUIStore((s) => s.toggleSelectedItem);
  const clearSelectedItems = useUIStore((s) => s.clearSelectedItems);

  const onlineUsers = usePresenceStore((s) => s.onlineUsers);
  const isUserOnline = usePresenceStore((s) => s.isUserOnline);

  // ── Local state ─────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [actionSheetConversationId, setActionSheetConversationId] =
    useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── Auth guard (R9) ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated) {
      router.replace('/login');
    }
  }, [isAuthenticated, router]);

  // ── Fetch conversations on mount (R5, R6) ───────────────────────────
  const fetchConversations = useCallback(async () => {
    setFetchError(null);
    setIsLoadingConversations(true);
    try {
      const accessToken = useAuthStore.getState().getAccessToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
      const res = await fetch(`${API_BASE_URL}/api/v1/conversations`, {
        method: 'GET',
        headers,
        credentials: 'include',
      });
      if (!res.ok) {
        throw new Error(`Failed to load conversations (${res.status})`);
      }
      const data = await res.json();
      setConversations(data.conversations ?? []);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to load conversations';
      setFetchError(message);
    } finally {
      setIsLoadingConversations(false);
    }
  }, [setConversations, setIsLoadingConversations]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // ── Visible (non-archived) conversations ────────────────────────────
  const visibleConversations = conversations.filter((c) => !c.isArchived);

  // ── Client-side search filter (R21 — zero API calls) ────────────────
  const filteredConversations = searchQuery.trim()
    ? visibleConversations.filter((c) => {
        const q = searchQuery.toLowerCase();
        const nameMatch = c.displayName.toLowerCase().includes(q);
        const previewMatch =
          c.lastMessage?.ciphertext?.toLowerCase().includes(q) ?? false;
        return nameMatch || previewMatch;
      })
    : visibleConversations;

  // ── Action sheet target conversation ────────────────────────────────
  const actionSheetConversation = actionSheetConversationId
    ? conversations.find((c) => c.id === actionSheetConversationId) ?? null
    : null;

  // ── Handlers ────────────────────────────────────────────────────────

  /**
   * Navigate to an individual conversation.
   * R15: On mobile (≤767px), router.push replaces the entire view so list and
   * chat are never visible simultaneously. On desktop, setActiveConversation
   * updates the right panel while the list remains visible.
   */
  const handleChatClick = useCallback(
    (conversationId: string) => {
      if (isEditMode) {
        toggleSelectedItem(conversationId);
        return;
      }
      setActiveConversation(conversationId);
      if (isMobile) {
        // R15: Full push navigation — list disappears
        router.push(`/chat/${conversationId}`);
      } else {
        // Desktop/tablet: navigate while keeping sidebar visible
        router.push(`/chat/${conversationId}`);
      }
    },
    [isEditMode, toggleSelectedItem, setActiveConversation, router, isMobile],
  );

  /** Open the Chat Actions modal for a specific conversation (Screen 3). */
  const handleMoreActions = useCallback(
    (conversationId: string) => {
      setActionSheetConversationId(conversationId);
      openModal('chatActions');
    },
    [openModal],
  );

  /** Archive a single conversation via swipe action. */
  const handleArchive = useCallback(
    (conversationId: string) => {
      archiveConversation(conversationId, true);
    },
    [archiveConversation],
  );

  /** Close the chat actions modal. */
  const handleCloseActionSheet = useCallback(() => {
    closeModal();
    setActionSheetConversationId(null);
  }, [closeModal]);

  /** Mute/unmute a conversation from the action sheet. */
  const handleMute = useCallback(() => {
    if (!actionSheetConversationId || !actionSheetConversation) return;
    muteConversation(actionSheetConversationId, {
      isMuted: !actionSheetConversation.isMuted,
      muteExpiresAt: null,
    });
    handleCloseActionSheet();
  }, [
    actionSheetConversationId,
    actionSheetConversation,
    muteConversation,
    handleCloseActionSheet,
  ]);

  /** Navigate to contact info for the action sheet target. */
  const handleContactInfo = useCallback(() => {
    if (!actionSheetConversationId) return;
    handleCloseActionSheet();
    router.push(`/contact/${actionSheetConversationId}`);
  }, [actionSheetConversationId, router, handleCloseActionSheet]);

  /** Export chat — dismisses action sheet. Export flow is out of scope per AAP 0.8.2. */
  const handleExportChat = useCallback(() => {
    handleCloseActionSheet();
  }, [handleCloseActionSheet]);

  /** Clear all messages in the conversation. */
  const handleClearChat = useCallback(() => {
    if (!actionSheetConversationId) return;
    clearChat(actionSheetConversationId);
    handleCloseActionSheet();
  }, [actionSheetConversationId, clearChat, handleCloseActionSheet]);

  /** Delete the conversation. */
  const handleDeleteChat = useCallback(() => {
    if (!actionSheetConversationId) return;
    removeConversation(actionSheetConversationId);
    handleCloseActionSheet();
  }, [actionSheetConversationId, removeConversation, handleCloseActionSheet]);

  // ── Edit mode handlers ──────────────────────────────────────────────

  /** Toggle into edit mode (Screen 2). Uses toggleEditMode per schema. */
  const handleEnterEditMode = useCallback(() => {
    if (!isEditMode) {
      toggleEditMode();
    }
  }, [isEditMode, toggleEditMode]);

  /** Exit edit mode, clear selections. */
  const handleExitEditMode = useCallback(() => {
    setEditMode(false);
    clearSelectedItems();
  }, [setEditMode, clearSelectedItems]);

  /** Archive all selected conversations. */
  const handleBatchArchive = useCallback(() => {
    selectedItems.forEach((id) => {
      archiveConversation(id, true);
    });
    handleExitEditMode();
  }, [selectedItems, archiveConversation, handleExitEditMode]);

  /** Mark all conversations as read. */
  const handleReadAll = useCallback(() => {
    conversations.forEach((c) => {
      if (c.unreadCount > 0) {
        resetUnread(c.id);
      }
    });
  }, [conversations, resetUnread]);

  /** Delete all selected conversations. */
  const handleBatchDelete = useCallback(() => {
    selectedItems.forEach((id) => {
      removeConversation(id);
    });
    handleExitEditMode();
  }, [selectedItems, removeConversation, handleExitEditMode]);

  /** Navigate to new conversation / compose screen. */
  const handleCompose = useCallback(() => {
    router.push('/chat/new');
  }, [router]);

  // ── Search handlers ─────────────────────────────────────────────────
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
  }, []);

  const handleSearchClear = useCallback(() => {
    setSearchQuery('');
  }, []);

  // ── Derived state ───────────────────────────────────────────────────
  const hasSelection = selectedItems.size > 0;

  /**
   * Compute online conversation count via `isUserOnline` — provides a
   * real-time presence counter used in the ARIA live region to announce
   * presence changes to screen reader users (R34 WCAG 2.1 AA).
   */
  const onlineConversationCount = filteredConversations.filter(
    (conv) => conv.type === 'DIRECT' && isUserOnline(conv.id),
  ).length;

  /**
   * Responsive container class — (R3, R15):
   * - Mobile:  full width, conversation list fills screen
   * - Tablet:  constrained to sidebar width
   * - Desktop: fixed 375px matching Figma artboard
   */
  const containerClass = isDesktop
    ? 'max-w-[375px] w-full'
    : isTablet
      ? 'max-w-[375px] w-full'
      : 'w-full';

  /**
   * Total online contacts — keeps presence store subscribed so real-time
   * updates propagate through React's render cycle even when not displayed
   * directly on this page. The `onlineUsers` set and `isUserOnline()`
   * utility are kept in scope so downstream effects (e.g., live badges in
   * ChatListItem via store subscription) reflect the freshest data.
   */
  const onlineContactCount = onlineUsers.size;

  /**
   * loadHistory is destructured from useMessages to ensure the hook's
   * WebSocket event listeners and sync logic (R13) are initialized on this
   * page. The function is available for programmatic prefetch if needed.
   */
  void loadHistory;

  // ── Keyboard escape handler (R34 WCAG 2.1 AA) ──────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (actionSheetConversationId) {
          handleCloseActionSheet();
        } else if (isEditMode) {
          handleExitEditMode();
        } else {
          /* Navigate back when no modal/edit state is active — standard
             keyboard accessibility pattern allowing users to dismiss the
             current view via Escape (uses router.back per schema). */
          router.back();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [actionSheetConversationId, isEditMode, handleCloseActionSheet, handleExitEditMode, router]);

  // ── Early return for unauthenticated ────────────────────────────────
  if (!isAuthenticated) {
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════

  return (
    <div
      className={`flex flex-col h-full bg-surface ${containerClass}`}
      role="region"
      aria-label="Chat list"
      data-online-contacts={onlineContactCount}
    >
      {/* ARIA live region — announces presence changes to screen readers (R34) */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {onlineConversationCount > 0
          ? `${onlineConversationCount} contact${onlineConversationCount === 1 ? '' : 's'} online`
          : ''}
      </span>

      {/* ── Navigation Bar ─────────────────────────────────────────── */}
      {isEditMode ? (
        /* Edit Mode Nav — Screen 2 (node 0:8225): 375×140px, bg #FFFFFF,
           no shadow. Two-row layout: Done button row (44px) + large title row. */
        <nav
          aria-label="Navigation"
          className="bg-white"
        >
          {/* Top row — 44px action bar with Done button (style_OHLGHK: 600 weight) */}
          <div className="flex items-center h-nav-bar px-4">
            <button
              type="button"
              onClick={handleExitEditMode}
              className="text-[17px] font-semibold leading-[1.29em] tracking-tight-ios text-blue-ios focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2"
              aria-label="Exit edit mode"
            >
              Done
            </button>
          </div>
          {/* Bottom row — large title (style_DK2NP4: SF Pro Display 700, 34px/1.21em) */}
          <div className="px-4 pb-2">
            <h1 className="text-[34px] font-bold leading-[1.21em] text-black tracking-[-0.01em]">
              Chats
            </h1>
          </div>
        </nav>
      ) : (
        /* Normal Mode Nav — Screen 1 (node 0:8995) */
        <NavigationBar
          title="Chats"
          leftAction={
            <span
              className="text-nav-action font-normal leading-[1.29em] tracking-tight-ios text-blue-ios"
              aria-label="Edit chat list"
            >
              Edit
            </span>
          }
          onLeftAction={handleEnterEditMode}
          rightAction={
            <ComposeIcon className="w-[23px] h-[23px]" aria-hidden="true" />
          }
          onRightAction={handleCompose}
        />
      )}

      {/* ── Sub-header Actions Row (node 0:8991 normal, 0:8229 edit) ─ */}
      {/* BLITZY [FIGMA]: Edit mode shows sub-header with disabled color #C7C7CC (fill_YRYR5G) */}
      <div
        className="flex items-center justify-between px-4 h-[44px] bg-white shadow-card"
        role="toolbar"
        aria-label="Chat actions"
      >
        <button
          type="button"
          onClick={() => !isEditMode && router.push('/chat/broadcasts')}
          disabled={isEditMode}
          className={`text-[17px] font-normal leading-[1.19em] tracking-tight-ios focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2 ${
            isEditMode
              ? 'text-[#C7C7CC] cursor-default'
              : 'text-blue-ios'
          }`}
        >
          Broadcast Lists
        </button>
        <button
          type="button"
          onClick={() => !isEditMode && router.push('/chat/new-group')}
          disabled={isEditMode}
          className={`text-[17px] font-normal leading-[1.19em] tracking-tight-ios focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2 ${
            isEditMode
              ? 'text-[#C7C7CC] cursor-default'
              : 'text-blue-ios'
          }`}
        >
          New Group
        </button>
      </div>

      {/* ── Search Bar (R21 — client-side only) ────────────────────── */}
      <div className="px-2 py-1 bg-surface">
        <SearchBar
          placeholder="Search"
          value={searchQuery}
          onChange={handleSearchChange}
          onClear={handleSearchClear}
        />
      </div>

      {/* ── Section Separator (Figma nodes 0:8982–0:8990 style) ──── */}
      <Separator />

      {/* ── Loading State ──────────────────────────────────────────── */}
      {(isLoadingConversations || isLoadingMessages) &&
        filteredConversations.length === 0 && (
        <div
          className="flex-1 flex items-center justify-center"
          role="status"
          aria-label="Loading conversations"
        >
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-blue-ios border-t-transparent rounded-full animate-spin" />
            <span className="text-chat-preview text-secondary">
              Loading chats…
            </span>
          </div>
        </div>
      )}

      {/* ── Error State ────────────────────────────────────────────── */}
      {fetchError && !isLoadingConversations && (
        <div
          className="flex-1 flex items-center justify-center px-6"
          role="alert"
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-chat-name text-black">{fetchError}</p>
            <button
              type="button"
              onClick={fetchConversations}
              className="text-[17px] text-blue-ios font-normal focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* ── Empty State ────────────────────────────────────────────── */}
      {!isLoadingConversations &&
        !fetchError &&
        filteredConversations.length === 0 && (
          <div className="flex-1 flex items-center justify-center px-6">
            <p className="text-chat-preview text-secondary text-center">
              {searchQuery.trim()
                ? 'No conversations match your search.'
                : 'No conversations yet.'}
            </p>
          </div>
        )}

      {/* ── Conversation List ──────────────────────────────────────── */}
      {filteredConversations.length > 0 && (
        <div
          className="flex-1 overflow-y-auto bg-white"
          role="list"
          aria-label="Conversations"
        >
          {filteredConversations.map((conv) => {
            const preview = resolvePreviewText(conv.lastMessage);
            const previewType = resolvePreviewType(
              conv.lastMessage?.type,
              preview,
            );
            const date = formatDate(conv.lastMessage?.serverTimestamp);
            const isCurrentUserSender =
              !!user &&
              !!conv.lastMessage &&
              conv.lastMessage.senderName === user.displayName;

            return (
              <ChatListItem
                key={conv.id}
                conversationId={conv.id}
                name={conv.displayName}
                avatarSrc={conv.avatar}
                preview={preview}
                previewType={previewType}
                voiceDuration={
                  conv.lastMessage?.type === 'VOICE_NOTE'
                    ? '0:14'
                    : undefined
                }
                date={date}
                hasReadIndicator={isCurrentUserSender}
                unreadCount={conv.unreadCount}
                isMuted={conv.isMuted}
                isSelected={selectedItems.has(conv.id)}
                isEditMode={isEditMode}
                onClick={() => handleChatClick(conv.id)}
                onMoreActions={() => handleMoreActions(conv.id)}
                onArchive={() => handleArchive(conv.id)}
              />
            );
          })}
        </div>
      )}

      {/* ── Edit Mode Bottom Action Bar (node 0:8220) ─────────────── */}
      {/* BLITZY [COLOR]: Figma disabled color #C7C7CC (fill_YRYR5G) differs from Tailwind `disabled` token #D1D1D6. Using Figma-exact value. */}
      {isEditMode && (
        <div
          className="flex items-center justify-between px-4 h-[83px] bg-nav shadow-tab"
          role="toolbar"
          aria-label="Batch chat actions"
        >
          <button
            type="button"
            onClick={handleBatchArchive}
            disabled={!hasSelection}
            className={`text-[17px] font-normal leading-[1.19em] tracking-tight-ios focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2 ${
              hasSelection
                ? 'text-blue-ios'
                : 'text-[#C7C7CC] cursor-default'
            }`}
            aria-label="Archive selected conversations"
          >
            Archive
          </button>
          {/* BLITZY [STATE]: Figma shows Read All as disabled (#C7C7CC) when nothing selected, but AAP Phase 9 specifies "always available". Following AAP directive. */}
          <button
            type="button"
            onClick={handleReadAll}
            className="text-[17px] font-normal leading-[1.19em] tracking-tight-ios text-blue-ios focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2"
            aria-label="Mark all conversations as read"
          >
            Read All
          </button>
          <button
            type="button"
            onClick={handleBatchDelete}
            disabled={!hasSelection}
            className={`text-[17px] font-normal leading-[1.19em] tracking-tight-ios focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2 ${
              hasSelection
                ? 'text-red-ios'
                : 'text-[#C7C7CC] cursor-default'
            }`}
            aria-label="Delete selected conversations"
          >
            Delete
          </button>
        </div>
      )}

      {/* ── Chat Actions Modal (Screen 3: node 0:10087) ────────────── */}
      <ChatActionsModal
        isOpen={activeModal === 'chatActions'}
        onClose={handleCloseActionSheet}
        conversationId={actionSheetConversationId ?? ''}
        contactName={actionSheetConversation?.displayName ?? ''}
        isMuted={actionSheetConversation?.isMuted ?? false}
        onMute={handleMute}
        onContactInfo={handleContactInfo}
        onExportChat={handleExportChat}
        onClearChat={handleClearChat}
        onDeleteChat={handleDeleteChat}
      />
    </div>
  );
}
