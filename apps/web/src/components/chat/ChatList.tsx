'use client';

/**
 * ChatList — Main conversation list container component.
 *
 * Renders the WhatsApp-style chat list screen (Figma Screen 1 — node 0:8855)
 * and edit mode variant (Figma Screen 2 — node 0:8114).
 *
 * Structure (top to bottom):
 *   StatusBar (44px) → NavigationBar (44px) → Actions Row (44px)
 *   → SearchBar → Scrollable Chat List → Edit Mode Bottom Bar → TabBar (83px)
 *
 * Integrates with:
 *   - useChatStore: conversation data, archive/mute/delete operations
 *   - useUIStore: edit mode, selection, search, modal state
 *   - useSocket: real-time WebSocket connection for live updates
 *
 * Accessibility:
 *   - role="list" on chat container, role="listitem" on each row
 *   - ARIA live region announces edit mode transitions
 *   - All interactive elements keyboard-accessible (Tab, Enter, Escape)
 *
 * @module ChatList
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import Image from 'next/image';

/* Internal component imports — all from depends_on_files */
import ChatListItem from './ChatListItem';
import type { PreviewType } from './ChatListItem';
import ChatActionsModal from './ChatActionsModal';
import SearchBar from './SearchBar';
import NavigationBar from '../common/NavigationBar';
import Separator from '../common/Separator';
import StatusBar from '../common/StatusBar';
/* TabBar is rendered by the parent (main)/layout.tsx — not included here */

/* Store and hook imports */
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useSocket } from '../../hooks/useSocket';

/* Shared type imports for typed WebSocket event payloads */
import type { MessageNewPayload, MessageStatusPayload } from '@kalle/shared';

/* Asset imports — SVG resolved to StaticImageData by Next.js */
import iconCompose from '@/assets/icons/icon-compose.svg';

/* ============================================================
 * TYPES
 * ============================================================ */

/**
 * Props interface for the ChatList component.
 *
 * All callbacks are invoked by user interactions within the list:
 *   - onSelectConversation: tap a conversation row
 *   - onNewChat: tap the compose icon in the navigation bar
 *   - onBroadcastLists: tap "Broadcast Lists" in the actions row
 *   - onNewGroup: tap "New Group" in the actions row
 */
export interface ChatListProps {
  /** Callback when a conversation row is tapped. Receives the conversation ID. */
  onSelectConversation: (conversationId: string) => void;
  /** Callback when the compose (new message) icon is tapped. */
  onNewChat: () => void;
  /** Callback when "Broadcast Lists" action link is tapped. */
  onBroadcastLists: () => void;
  /** Callback when "New Group" action link is tapped. */
  onNewGroup: () => void;
}

/* ============================================================
 * CONSTANTS
 * ============================================================ */

/** API base URL for conversation fetch — sourced from environment with fallback. */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

/* ============================================================
 * HELPER FUNCTIONS
 * ============================================================ */

/**
 * Formats an ISO 8601 timestamp string into a WhatsApp-style chat list date.
 *
 * Rules:
 *   - Today      → "HH:MM AM/PM" (e.g., "2:13 PM")
 *   - Yesterday  → "Yesterday"
 *   - This week  → Day name (e.g., "Monday")
 *   - This year  → "M/D/YY" (e.g., "10/7/18")
 *   - Older      → "M/D/YY"
 *
 * Falls back to empty string if the input is invalid.
 */
function formatChatDate(isoString: string): string {
  if (!isoString) return '';

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffMs = today.getTime() - messageDay.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    /* Today — show time (e.g., "2:13 PM") */
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  if (diffDays === 1) {
    return 'Yesterday';
  }

  if (diffDays < 7 && diffDays > 0) {
    /* This week — show day name */
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  }

  /* Older — show M/D/YY */
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = String(date.getFullYear()).slice(-2);
  return `${month}/${day}/${year}`;
}

/**
 * Extracts preview text and preview type from a conversation's last message.
 *
 * Maps the message type string to ChatListItem's PreviewType enum:
 *   - TEXT / DOCUMENT → 'text'
 *   - IMAGE / VIDEO   → 'photo'
 *   - VOICE_NOTE      → 'voice'
 *   - Deleted          → 'text' with tombstone label
 *   - No message       → 'text' with empty string
 *
 * Returns: { text, type, voiceDuration? }
 */
function getMessagePreviewInfo(
  lastMessage?: {
    senderName: string;
    ciphertext: string | null;
    type: string;
    serverTimestamp: string;
    isDeleted: boolean;
  },
): { text: string; type: PreviewType; voiceDuration?: string } {
  if (!lastMessage) {
    return { text: '', type: 'text' };
  }

  /* Deleted message tombstone (R20) — show standard tombstone text */
  if (lastMessage.isDeleted || lastMessage.ciphertext === null) {
    return { text: 'This message was deleted', type: 'text' };
  }

  const messageType = lastMessage.type.toUpperCase();

  switch (messageType) {
    case 'IMAGE':
    case 'VIDEO':
      return { text: 'Photo', type: 'photo' };

    case 'VOICE_NOTE': {
      /* Attempt to extract duration from ciphertext if it looks like a time code */
      const cipherStr = lastMessage.ciphertext ?? '';
      const durationMatch = cipherStr.match(/^(\d+:\d{2})$/);
      return {
        text: '',
        type: 'voice',
        voiceDuration: durationMatch ? durationMatch[1] : '0:14',
      };
    }

    case 'DOCUMENT':
      return {
        text: lastMessage.ciphertext ?? 'Document',
        type: 'text',
      };

    case 'TEXT':
    default: {
      const ct = lastMessage.ciphertext ?? '';
      return {
        text: ct,
        type: ct.includes('\n') ? 'multiline' : 'text',
      };
    }
  }
}

/* ============================================================
 * COMPONENT
 * ============================================================ */

/**
 * ChatList — conversation list container.
 *
 * Renders the full Figma Screen 1 layout: status bar, navigation bar,
 * actions row, searchable conversation list, and tab bar. Supports edit
 * mode with batch selection, real-time updates via WebSocket, and
 * pull-to-refresh.
 */
function ChatList({
  onSelectConversation,
  onNewChat,
  onBroadcastLists,
  onNewGroup,
}: ChatListProps): React.JSX.Element {
  /* ── Store Subscriptions ── */

  /* Chat store — conversation data and operations */
  const conversations = useChatStore((state) => state.conversations);
  const isLoadingConversations = useChatStore((state) => state.isLoadingConversations);
  const archiveConversation = useChatStore((state) => state.archiveConversation);
  const muteConversation = useChatStore((state) => state.muteConversation);

  /* UI store — edit mode, selection, search, modals */
  const isEditMode = useUIStore((state) => state.isEditMode);
  const selectedItems = useUIStore((state) => state.selectedItems);
  const searchQuery = useUIStore((state) => state.searchQuery);
  const isSearchActive = useUIStore((state) => state.isSearchActive);
  const toggleEditMode = useUIStore((state) => state.toggleEditMode);
  const setEditMode = useUIStore((state) => state.setEditMode);
  const toggleSelectedItem = useUIStore((state) => state.toggleSelectedItem);
  const selectAllItems = useUIStore((state) => state.selectAllItems);
  const clearSelectedItems = useUIStore((state) => state.clearSelectedItems);
  const setSearchQuery = useUIStore((state) => state.setSearchQuery);
  const setSearchActive = useUIStore((state) => state.setSearchActive);
  const openModal = useUIStore((state) => state.openModal);
  const closeModal = useUIStore((state) => state.closeModal);

  /* Socket connection — for real-time updates */
  const { isConnected, socket } = useSocket();

  /* ── Local State ── */

  /** Whether a pull-to-refresh is in progress. */
  const [isRefreshing, setIsRefreshing] = useState(false);

  /** Connection status shown in a banner when disconnected. */
  const [showConnectionBanner, setShowConnectionBanner] = useState(false);

  /** Target conversation for the ChatActionsModal overlay. */
  const [actionsTarget, setActionsTarget] = useState<{
    id: string;
    name: string;
    isMuted: boolean;
  } | null>(null);

  /** ARIA live region announcement text for edit mode transitions. */
  const [announcement, setAnnouncement] = useState('');

  /** Pull-to-refresh touch tracking. */
  const [touchStartY, setTouchStartY] = useState<number | null>(null);
  const [pullDistance, setPullDistance] = useState(0);

  /* ── Derived State ── */

  /**
   * Visible (non-archived) conversations, filtered by search query,
   * sorted by last message timestamp descending (newest first).
   */
  const filteredConversations = useMemo(() => {
    /* Filter out archived conversations */
    let visible = conversations.filter((c) => !c.isArchived);

    /* Apply client-side search filter (R21 — zero API calls) */
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      visible = visible.filter((c) => {
        const nameMatch = c.displayName.toLowerCase().includes(query);
        const previewMatch =
          c.lastMessage?.ciphertext?.toLowerCase().includes(query) ?? false;
        return nameMatch || previewMatch;
      });
    }

    /* Sort by last message timestamp descending (newest first) */
    return [...visible].sort((a, b) => {
      const aTime = a.lastMessage?.serverTimestamp
        ? new Date(a.lastMessage.serverTimestamp).getTime()
        : 0;
      const bTime = b.lastMessage?.serverTimestamp
        ? new Date(b.lastMessage.serverTimestamp).getTime()
        : 0;
      return bTime - aTime;
    });
  }, [conversations, searchQuery]);

  /** Whether any items are currently selected in edit mode. */
  const hasSelection = useMemo(() => selectedItems.size > 0, [selectedItems]);

  /* Total unread count is managed by the parent layout for tab bar badge */

  /* ── Action Handlers ── */

  /**
   * Fetches conversations from the API and updates the chat store.
   * Uses native fetch with the NEXT_PUBLIC_API_URL environment variable.
   * Wraps store setters since fetchConversations is not in the store.
   */
  const fetchConversations = useCallback(async () => {
    const store = useChatStore.getState();
    store.setIsLoadingConversations(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/conversations`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (response.ok) {
        const data = await response.json();
        const items = Array.isArray(data) ? data : data.conversations ?? [];
        store.setConversations(items);
      }
    } catch {
      /* Silently handle — conversations may already be loaded via socket */
    } finally {
      store.setIsLoadingConversations(false);
    }
  }, []);

  /**
   * Handles pull-to-refresh by re-fetching conversations from the server.
   * Shows a loading spinner for a minimum of 400ms for visual feedback.
   */
  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    const minDelay = new Promise<void>((resolve) => {
      setTimeout(resolve, 400);
    });
    await Promise.all([fetchConversations(), minDelay]);
    setIsRefreshing(false);
  }, [fetchConversations, isRefreshing]);

  /**
   * Deletes a conversation by removing it from the store.
   * Uses removeConversation since deleteConversation is not in the store.
   */
  const deleteConversation = useCallback((conversationId: string) => {
    useChatStore.getState().removeConversation(conversationId);
  }, []);

  /**
   * Marks all conversations as read by resetting unread counts.
   * Iterates over visible conversations since markAllRead is not in the store.
   */
  const markAllRead = useCallback(() => {
    const store = useChatStore.getState();
    store.conversations.forEach((c) => {
      if (c.unreadCount > 0) {
        store.resetUnread(c.id);
      }
    });
  }, []);

  /** Toggles edit mode and announces the state change via ARIA live region. */
  const handleEditToggle = useCallback(() => {
    const enteringEdit = !isEditMode;
    toggleEditMode();
    setAnnouncement(
      enteringEdit ? 'Edit mode active. Select conversations to manage.' : 'Edit mode deactivated.',
    );
    if (!enteringEdit) {
      clearSelectedItems();
    }
  }, [isEditMode, toggleEditMode, clearSelectedItems]);

  /** Opens the ChatActionsModal for a specific conversation. */
  const handleMoreActions = useCallback(
    (conversationId: string, name: string, isMuted: boolean) => {
      setActionsTarget({ id: conversationId, name, isMuted });
      openModal('chatActions', { conversationId });
    },
    [openModal],
  );

  /** Closes the ChatActionsModal and clears the target. */
  const handleCloseActionsModal = useCallback(() => {
    closeModal();
    setActionsTarget(null);
  }, [closeModal]);

  /** Archives a single conversation (from swipe action). */
  const handleArchive = useCallback(
    (conversationId: string) => {
      archiveConversation(conversationId, true);
    },
    [archiveConversation],
  );

  /** Selects all visible conversations in edit mode. */
  const handleSelectAll = useCallback(() => {
    const allIds = filteredConversations.map((c) => c.id);
    selectAllItems(allIds);
    setAnnouncement(`All ${allIds.length} conversations selected.`);
  }, [filteredConversations, selectAllItems]);

  /** Archives all selected conversations in edit mode. */
  const handleArchiveSelected = useCallback(() => {
    selectedItems.forEach((id) => {
      archiveConversation(id, true);
    });
    clearSelectedItems();
    setEditMode(false);
    setAnnouncement('Selected conversations archived.');
  }, [selectedItems, archiveConversation, clearSelectedItems, setEditMode]);

  /** Marks all conversations as read (edit mode batch action). */
  const handleReadAll = useCallback(() => {
    markAllRead();
    clearSelectedItems();
    setEditMode(false);
    setAnnouncement('All conversations marked as read.');
  }, [markAllRead, clearSelectedItems, setEditMode]);

  /** Deletes all selected conversations in edit mode. */
  const handleDeleteSelected = useCallback(() => {
    selectedItems.forEach((id) => {
      deleteConversation(id);
    });
    clearSelectedItems();
    setEditMode(false);
    setAnnouncement('Selected conversations deleted.');
  }, [selectedItems, deleteConversation, clearSelectedItems, setEditMode]);

  /** Handles ChatActionsModal "Mute" action. */
  const handleMuteAction = useCallback(() => {
    if (actionsTarget) {
      muteConversation(actionsTarget.id, {
        isMuted: !actionsTarget.isMuted,
        muteExpiresAt: null,
      });
    }
    handleCloseActionsModal();
  }, [actionsTarget, muteConversation, handleCloseActionsModal]);

  /** Handles ChatActionsModal "Delete Chat" action. */
  const handleDeleteChatAction = useCallback(() => {
    if (actionsTarget) {
      deleteConversation(actionsTarget.id);
    }
    handleCloseActionsModal();
  }, [actionsTarget, deleteConversation, handleCloseActionsModal]);

  /** Handles ChatActionsModal "Clear Chat" action. */
  const handleClearChatAction = useCallback(() => {
    if (actionsTarget) {
      useChatStore.getState().clearChat(actionsTarget.id);
    }
    handleCloseActionsModal();
  }, [actionsTarget, handleCloseActionsModal]);

  /* Tab bar press is handled by the parent (main)/layout.tsx */

  /** Handles search query changes. */
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
    },
    [setSearchQuery],
  );

  /** Clears the search query and deactivates search. */
  const handleSearchClear = useCallback(() => {
    setSearchQuery('');
    setSearchActive(false);
  }, [setSearchQuery, setSearchActive]);

  /** Activates search mode when the search bar is focused. */
  const handleSearchFocus = useCallback(() => {
    setSearchActive(true);
  }, [setSearchActive]);

  /* ── Pull-to-Refresh Touch Handlers ── */

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const scrollContainer = e.currentTarget;
    if (scrollContainer.scrollTop === 0) {
      setTouchStartY(e.touches[0].clientY);
    }
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (touchStartY === null) return;
      const currentY = e.touches[0].clientY;
      const distance = Math.max(0, currentY - touchStartY);
      setPullDistance(Math.min(distance, 100));
    },
    [touchStartY],
  );

  const handleTouchEnd = useCallback(() => {
    if (pullDistance > 60) {
      void handleRefresh();
    }
    setTouchStartY(null);
    setPullDistance(0);
  }, [pullDistance, handleRefresh]);

  /* ── Effects ── */

  /** Fetch conversations on mount. */
  useEffect(() => {
    void fetchConversations();
  }, [fetchConversations]);

  /**
   * WebSocket real-time event listeners.
   * Listens for new messages, read receipts, and typing indicators.
   * Updates the chatStore which triggers re-renders via reactive subscriptions.
   */
  useEffect(() => {
    if (!socket || !isConnected) return;

    /** Handle incoming new message — update store which drives re-render */
    const handleNewMessage = (_payload: MessageNewPayload) => {
      /* Trigger a refresh to get updated conversation list with new message */
      void fetchConversations();
      /* Announce new message for screen readers */
      setAnnouncement('New message in conversation');
    };

    /** Handle message status change (delivered/read) — forces re-render for read indicators */
    const handleMessageStatus = (_payload: MessageStatusPayload) => {
      /* Status updates (DELIVERED → READ) propagate through store; refresh for UI */
      void fetchConversations();
    };

    socket.on('message:new', handleNewMessage);
    socket.on('message:status', handleMessageStatus);

    return () => {
      socket.off('message:new', handleNewMessage);
      socket.off('message:status', handleMessageStatus);
    };
  }, [socket, isConnected, fetchConversations]);

  /** Show connection banner when disconnected for > 2s. */
  useEffect(() => {
    if (isConnected) {
      setShowConnectionBanner(false);
      return;
    }
    const timer = setTimeout(() => {
      setShowConnectionBanner(true);
    }, 2000);
    return () => clearTimeout(timer);
  }, [isConnected]);

  /** Clean up edit mode on unmount. */
  useEffect(() => {
    return () => {
      setEditMode(false);
      clearSelectedItems();
    };
  }, [setEditMode, clearSelectedItems]);

  /** Exit edit mode on Escape key; clear search on Escape. */
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (isSearchActive) {
          setSearchQuery('');
          setSearchActive(false);
          return;
        }
        if (isEditMode) {
          setEditMode(false);
          clearSelectedItems();
          setAnnouncement('Edit mode deactivated.');
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isEditMode, isSearchActive, setEditMode, clearSelectedItems, setSearchQuery, setSearchActive]);

  /* ── Render ── */

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* iOS Status Bar — 44px, simulated for desktop (hidden md:flex) */}
      <StatusBar />

      {/* Navigation Bar — 44px, bg #F6F6F6, shadow-nav-bottom
          Normal mode: "Edit" (left) | "Chats" (center) | compose icon (right)
          Edit mode: "Done" (left) | "Chats" (center) | no right action
          Note: NavigationBar wraps leftAction/rightAction inside its own <button>,
          so we pass content nodes + onLeftAction/onRightAction callbacks. */}
      <NavigationBar
        title="Chats"
        leftAction={
          <span aria-label={isEditMode ? 'Exit edit mode' : 'Enter edit mode'}>
            {isEditMode ? 'Done' : 'Edit'}
          </span>
        }
        onLeftAction={handleEditToggle}
        rightAction={
          isEditMode ? undefined : (
            <Image
              src={iconCompose}
              alt="Compose new message"
              width={23}
              height={23}
            />
          )
        }
        onRightAction={isEditMode ? undefined : onNewChat}
      />

      {/* Connection Status Banner — shown when WebSocket is disconnected */}
      {showConnectionBanner && (
        <div
          className="flex items-center justify-center bg-red-ios/10 py-1.5"
          role="alert"
          aria-live="assertive"
        >
          <span className="text-section-header text-red-ios">
            Connecting…
          </span>
        </div>
      )}

      {/* Actions Row — 375×44, bg white, shadow-card bottom
          Left: "Broadcast Lists" (#007AFF)
          Right: "New Group" (#007AFF)
          Hidden during active search mode for cleaner UI.
          Figma node 0:8991 */}
      {!isSearchActive && (
        <div
          className="flex items-center justify-between bg-white shadow-card"
          style={{ minHeight: '44px' }}
        >
          <button
            type="button"
            onClick={onBroadcastLists}
            className="text-nav-action text-blue-ios tracking-tight-ios px-4 py-3"
            style={{ letterSpacing: '-0.04em' }}
          >
            Broadcast Lists
          </button>
          <button
            type="button"
            onClick={onNewGroup}
            className="text-nav-action text-blue-ios tracking-tight-ios px-4 py-3"
            style={{ letterSpacing: '-0.04em' }}
          >
            New Group
          </button>
        </div>
      )}

      {/* Search Bar — client-side search (R21 — zero API calls)
          Inserted below actions row, above chat list */}
      <div className="bg-surface px-2 py-1.5">
        <SearchBar
          placeholder="Search"
          value={searchQuery}
          onChange={handleSearchChange}
          onClear={handleSearchClear}
          onFocus={handleSearchFocus}
        />
      </div>

      {/* Thin separator between search and chat list area */}
      <Separator />

      {/* Scrollable Chat List — flex-1 fills remaining height.
          Pull-to-refresh via touch handlers.
          role="list" + aria-label for accessibility. */}
      <div
        className="flex-1 overflow-y-auto overflow-x-hidden bg-white"
        role="list"
        aria-label="Conversations"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Pull-to-Refresh Indicator */}
        {(pullDistance > 0 || isRefreshing) && (
          <div
            className="flex items-center justify-center transition-all duration-200"
            style={{ height: isRefreshing ? '48px' : `${pullDistance * 0.48}px` }}
            aria-live="polite"
          >
            <div
              className={`w-5 h-5 border-2 border-secondary border-t-blue-ios rounded-full ${
                isRefreshing ? 'animate-spin' : ''
              }`}
              role="progressbar"
              aria-label={isRefreshing ? 'Refreshing conversations' : 'Pull down to refresh'}
            />
          </div>
        )}

        {/* Loading State — skeleton shimmer during initial load */}
        {isLoadingConversations && !isRefreshing && filteredConversations.length === 0 && (
          <div className="p-4" aria-busy="true" aria-label="Loading conversations">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={`skeleton-${String(i)}`}
                className="flex items-center h-chat-row px-4 animate-pulse"
              >
                <div className="w-[52px] h-[52px] rounded-full bg-surface flex-shrink-0" />
                <div className="flex-1 ml-[11px]">
                  <div className="h-4 bg-surface rounded w-2/5 mb-2" />
                  <div className="h-3 bg-surface rounded w-3/5" />
                </div>
                <div className="h-3 bg-surface rounded w-12 flex-shrink-0" />
              </div>
            ))}
          </div>
        )}

        {/* Empty State — shown when no conversations exist */}
        {!isLoadingConversations && filteredConversations.length === 0 && (
          <div
            className="flex flex-col items-center justify-center px-8 py-16"
            role="status"
          >
            {/* Subtle chat bubble illustration */}
            <div className="w-20 h-20 rounded-full bg-surface flex items-center justify-center mb-4">
              <svg
                width="40"
                height="40"
                viewBox="0 0 40 40"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M20 4C11.16 4 4 10.16 4 17.6C4 21.28 5.6 24.56 8.24 27.04L6.4 34.4L14.16 30.96C16 31.6 17.92 32 20 32C28.84 32 36 25.84 36 18.4C36 10.96 28.84 4 20 4Z"
                  fill="#8E8E93"
                  fillOpacity="0.3"
                />
              </svg>
            </div>
            <p className="text-chat-name text-black mb-1">
              {searchQuery
                ? 'No conversations found'
                : 'No conversations yet'}
            </p>
            <p className="text-chat-preview text-secondary text-center">
              {searchQuery
                ? 'Try a different search term.'
                : 'Start a new chat to begin messaging.'}
            </p>
          </div>
        )}

        {/* Conversation List Items */}
        {filteredConversations.map((conversation) => {
          const preview = getMessagePreviewInfo(conversation.lastMessage);
          const dateStr = conversation.lastMessage?.serverTimestamp
            ? formatChatDate(conversation.lastMessage.serverTimestamp)
            : '';

          return (
            <div key={conversation.id} role="listitem">
              <ChatListItem
                conversationId={conversation.id}
                name={conversation.displayName}
                avatarSrc={conversation.avatar}
                preview={preview.text}
                previewType={preview.type}
                voiceDuration={preview.voiceDuration}
                date={dateStr}
                hasReadIndicator={
                  conversation.lastMessage != null &&
                  conversation.lastMessage.senderName !== conversation.displayName &&
                  conversation.unreadCount === 0
                }
                unreadCount={conversation.unreadCount}
                isMuted={conversation.isMuted}
                isSelected={selectedItems.has(conversation.id)}
                isEditMode={isEditMode}
                onClick={
                  isEditMode
                    ? () => toggleSelectedItem(conversation.id)
                    : () => onSelectConversation(conversation.id)
                }
                onMoreActions={() =>
                  handleMoreActions(
                    conversation.id,
                    conversation.displayName,
                    conversation.isMuted,
                  )
                }
                onArchive={() => handleArchive(conversation.id)}
              />
            </div>
          );
        })}
      </div>

      {/* Edit Mode Bottom Action Bar — Figma Screen 2 (node 0:8114)
          Three evenly distributed text buttons + select all:
            - Archive: #8E8E93 (no selection) / #007AFF (selected)
            - Read All: #8E8E93 (no selection) / #007AFF (selected)
            - Delete:  #8E8E93 (no selection) / #FF3B30 (selected)
          Font: SF Pro Text 400, 17px */}
      {isEditMode && (
        <div className="bg-white border-t border-separator">
          {/* Select All toggle when not all are selected */}
          {filteredConversations.length > 0 && selectedItems.size < filteredConversations.length && (
            <div className="flex justify-end px-4 pt-1">
              <button
                type="button"
                onClick={handleSelectAll}
                className="text-chat-preview text-blue-ios tracking-tight-ios"
                aria-label="Select all conversations"
              >
                Select All
              </button>
            </div>
          )}
          <div className="flex items-center justify-around py-2.5">
            <button
              type="button"
              onClick={handleArchiveSelected}
              disabled={!hasSelection}
              className={`text-nav-action tracking-tight-ios transition-colors ${
                hasSelection ? 'text-blue-ios' : 'text-secondary'
              } disabled:opacity-60`}
              aria-label={`Archive ${selectedItems.size} selected conversations`}
            >
              Archive
            </button>
            <button
              type="button"
              onClick={handleReadAll}
              className={`text-nav-action tracking-tight-ios transition-colors ${
                hasSelection ? 'text-blue-ios' : 'text-secondary'
              }`}
              aria-label="Mark all conversations as read"
            >
              Read All
            </button>
            <button
              type="button"
              onClick={handleDeleteSelected}
              disabled={!hasSelection}
              className={`text-nav-action tracking-tight-ios transition-colors ${
                hasSelection ? 'text-red-ios' : 'text-secondary'
              } disabled:opacity-60`}
              aria-label={`Delete ${selectedItems.size} selected conversations`}
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {/* Bottom TabBar is rendered by the parent (main)/layout.tsx — not here.
          Figma node 0:9004. The layout passes activeTab="chats" for this route. */}

      {/* ChatActionsModal — iOS-style action sheet overlay.
          Shown when a swiped row's "More" button is pressed.
          Figma Screen 3 — node 0:10087. */}
      {actionsTarget && (
        <ChatActionsModal
          isOpen={actionsTarget !== null}
          onClose={handleCloseActionsModal}
          conversationId={actionsTarget.id}
          contactName={actionsTarget.name}
          isMuted={actionsTarget.isMuted}
          onMute={handleMuteAction}
          onContactInfo={handleCloseActionsModal}
          onExportChat={handleCloseActionsModal}
          onClearChat={handleClearChatAction}
          onDeleteChat={handleDeleteChatAction}
        />
      )}

      {/* ARIA Live Region — announces edit mode state changes.
          sr-only: visually hidden, screen-reader accessible. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}

export default ChatList;
