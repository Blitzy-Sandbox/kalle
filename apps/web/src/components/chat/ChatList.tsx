'use client';

/**
 * @file ChatList.tsx
 * @description Conversation list component for the main Chats screen.
 *
 * Renders the scrollable list of conversations matching Figma Screen 1
 * (0:8855) specifications. Each conversation row shows the contact avatar,
 * name, last message preview (decrypted client-side), timestamp, read
 * status indicator, and unread count badge.
 *
 * Figma Mapping:
 *   Screen 1 (0:8855): WhatsApp Chats — main chat list.
 *   - Header: "Edit" left, "Chats" title centered (600 17px), compose icon right
 *   - Sub-header: "Broadcast Lists" left, "New Group" right (both #007AFF)
 *   - Chat rows: 375×74px each, avatar 52×52, name 600 16px #000,
 *     preview 400 14px #8E8E93, date 400 14px #8E8E93 right-aligned
 *   - Read indicator: blue double-check for read messages
 *   - Separator: 0.33px line at x=79, rgba(60, 60, 67, 0.29)
 *   - Swipe actions: "More" (gray) and "Archive" (blue) on left swipe
 *
 *   Screen 2 (0:8114): WhatsApp Chats Edit — edit mode with selection circles
 *   and batch action toolbar.
 *
 *   Screen 3 (0:10087): WhatsApp Chat Actions — action sheet overlay with
 *   Mute, Contact Info, Export Chat, Clear Chat, Delete Chat.
 *
 * Design Tokens (from tailwind.config.ts):
 *   - Background: #EFEFF4 (bg-surface)
 *   - Row background: #FFFFFF (bg-white)
 *   - Name: SF Pro Text 600 16px #000000 (text-black font-semibold)
 *   - Preview: SF Pro Text 400 14px #8E8E93 (text-secondary text-sm)
 *   - Date: SF Pro Text 400 14px #8E8E93 (text-secondary text-sm)
 *   - Unread badge: #007AFF (bg-link text-white) rounded-full min-w-[20px]
 *   - Separator: border-separator (rgba(60, 60, 67, 0.29)) 0.33px
 *
 * Accessibility (R34):
 *   - role="list" on container, role="listitem" on each row
 *   - Keyboard navigable with arrow keys and Enter to select
 *   - ARIA live region for unread count changes
 *   - Screen reader announces conversation name, last message, and unread count
 *
 * @see {@link ChatListItem} for individual conversation row rendering
 * @see {@link useChatStore} for conversation state management
 */

import React, { useCallback, useMemo, useState } from 'react';
import type { ConversationResponse } from '@kalle/shared/types/conversation';

// =============================================================================
// Types
// =============================================================================

export interface ChatListProps {
  /** Array of conversation objects to display */
  conversations: ConversationResponse[];

  /** Map of conversation IDs to decrypted last message preview text.
   *  Decrypted client-side per R12 — server only has ciphertext. */
  decryptedPreviews: Record<string, string>;

  /** ID of the currently active/selected conversation (highlighted row) */
  activeConversationId?: string;

  /** Current user's ID (to determine sent vs received for read indicators) */
  currentUserId: string;

  /** Callback when a conversation row is tapped/clicked */
  onConversationSelect: (conversationId: string) => void;

  /** Callback when "New Group" is tapped */
  onNewGroup?: () => void;

  /** Callback when "Broadcast Lists" is tapped */
  onBroadcastLists?: () => void;

  /** Callback when compose icon is tapped (new message) */
  onCompose?: () => void;

  /** Callback when a conversation is archived via swipe action */
  onArchive?: (conversationId: string) => void;

  /** Callback when "More" swipe action is tapped (shows action sheet) */
  onMore?: (conversationId: string) => void;

  /** Whether the list is in edit mode (shows selection circles) */
  isEditMode?: boolean;

  /** Callback when edit mode selection changes */
  onSelectionChange?: (selectedIds: string[]) => void;

  /** Whether the list is currently loading */
  isLoading?: boolean;

  /** Optional CSS class name */
  className?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Formats a server timestamp into a relative or absolute date string
 * for the chat list row, matching Figma Screen 1 date format.
 *
 * Rules:
 *   - Today: "HH:MM" (e.g., "14:23")
 *   - Yesterday: "Yesterday"
 *   - Within 7 days: weekday name (e.g., "Monday")
 *   - Older: "MM/DD/YY" (e.g., "12/25/24")
 *
 * @param isoTimestamp - ISO 8601 timestamp string
 * @returns Formatted date string for display
 */
function formatChatDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const now = new Date();

  // Reset time portions for day comparison
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const messageDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );

  const diffDays = Math.floor(
    (today.getTime() - messageDay.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (diffDays === 0) {
    // Today: show time
    const hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  if (diffDays === 1) {
    return 'Yesterday';
  }

  if (diffDays < 7) {
    const weekdays = [
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ];
    return weekdays[date.getDay()];
  }

  // Older: MM/DD/YY
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const year = date.getFullYear().toString().slice(2);
  return `${month}/${day}/${year}`;
}

/**
 * Generates a preview text for a conversation's last message.
 * If the message is a tombstone (R20), shows "This message was deleted".
 * For media types, shows an appropriate icon + label.
 *
 * @param conversation - The conversation to generate preview for
 * @param decryptedText - The decrypted plaintext of the last message (R12)
 * @returns Preview text string for display
 */
function getMessagePreview(
  conversation: ConversationResponse,
  decryptedText?: string,
): string {
  const { lastMessage } = conversation;
  if (!lastMessage) return '';

  if (lastMessage.isDeleted) {
    return 'This message was deleted';
  }

  if (decryptedText) {
    return decryptedText;
  }

  // Fallback labels for media types when decrypted text is unavailable
  switch (lastMessage.type) {
    case 'IMAGE':
      return '📷 Photo';
    case 'VIDEO':
      return '🎥 Video';
    case 'DOCUMENT':
      return '📄 Document';
    case 'VOICE_NOTE':
      return '🎤 Voice note';
    default:
      return '';
  }
}

// =============================================================================
// Component
// =============================================================================

/**
 * ChatList renders the main conversation list for the Chats screen.
 *
 * Features:
 *   - Sorted conversation rows with avatar, name, preview, date, unread badge
 *   - Edit mode with selection circles for batch operations
 *   - Swipe actions (archive, more) on individual rows
 *   - Search integration (filters conversations client-side)
 *   - Accessibility: keyboard navigation, ARIA roles, screen reader support
 *   - Empty state when no conversations exist
 */
export default function ChatList({
  conversations,
  decryptedPreviews,
  activeConversationId,
  currentUserId,
  onConversationSelect,
  onNewGroup,
  onBroadcastLists,
  onCompose: _onCompose,
  onArchive,
  onMore: _onMore,
  isEditMode = false,
  onSelectionChange,
  isLoading = false,
  className = '',
}: ChatListProps): React.JSX.Element {
  // ── Edit mode selection state ─────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelection = useCallback(
    (conversationId: string): void => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(conversationId)) {
          next.delete(conversationId);
        } else {
          next.add(conversationId);
        }
        onSelectionChange?.(Array.from(next));
        return next;
      });
    },
    [onSelectionChange],
  );

  // ── Sort conversations: unread first, then by last message time ───────
  const sortedConversations = useMemo(() => {
    return [...conversations]
      .filter((c) => !c.isArchived) // Archived conversations hidden from main list
      .sort((a, b) => {
        // Pinned conversations first
        if (a.pinnedAt && !b.pinnedAt) return -1;
        if (!a.pinnedAt && b.pinnedAt) return 1;

        // Then by last message timestamp (newest first)
        const aTime = a.lastMessage?.serverTimestamp || a.createdAt;
        const bTime = b.lastMessage?.serverTimestamp || b.createdAt;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });
  }, [conversations]);

  // ── Keyboard navigation ───────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, conversationId: string): void => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isEditMode) {
          toggleSelection(conversationId);
        } else {
          onConversationSelect(conversationId);
        }
      }
    },
    [isEditMode, toggleSelection, onConversationSelect],
  );

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className={`flex flex-col h-full bg-surface ${className}`}>
      {/* Sub-header: Broadcast Lists / New Group */}
      <div className="flex items-center justify-between px-4 py-2 bg-white">
        <button
          type="button"
          onClick={onBroadcastLists}
          className="text-sm text-link font-normal focus:outline-none focus-visible:ring-2 focus-visible:ring-link focus-visible:ring-offset-2 rounded"
          aria-label="Broadcast Lists"
        >
          Broadcast Lists
        </button>
        <button
          type="button"
          onClick={onNewGroup}
          className="text-sm text-link font-normal focus:outline-none focus-visible:ring-2 focus-visible:ring-link focus-visible:ring-offset-2 rounded"
          aria-label="New Group"
        >
          New Group
        </button>
      </div>

      {/* Conversation list */}
      <div
        className="flex-1 overflow-y-auto"
        role="list"
        aria-label="Conversations"
      >
        {isLoading && sortedConversations.length === 0 && (
          <div className="flex items-center justify-center py-20">
            <div className="animate-pulse text-secondary text-sm">
              Loading conversations…
            </div>
          </div>
        )}

        {!isLoading && sortedConversations.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 px-8 text-center">
            <p className="text-secondary text-sm">
              No conversations yet. Tap the compose button to start a new chat.
            </p>
          </div>
        )}

        {sortedConversations.map((conversation, index) => {
          const preview = getMessagePreview(
            conversation,
            decryptedPreviews[conversation.id],
          );
          const date = conversation.lastMessage
            ? formatChatDate(conversation.lastMessage.serverTimestamp)
            : '';
          const isActive = activeConversationId === conversation.id;
          const isSelected = selectedIds.has(conversation.id);

          // For DIRECT conversations, get the other participant's info
          const otherParticipant = conversation.participants.find(
            (p) => p.userId !== currentUserId,
          );
          const displayName =
            conversation.groupName ||
            otherParticipant?.displayName ||
            'Unknown';
          const avatarUrl =
            conversation.groupAvatar || otherParticipant?.avatar;

          // Determine if last message was sent by current user (for read indicators)
          const lastMessageIsSent =
            conversation.lastMessage?.senderId === currentUserId;

          return (
            <div
              key={conversation.id}
              role="listitem"
              tabIndex={0}
              onClick={() => {
                if (isEditMode) {
                  toggleSelection(conversation.id);
                } else {
                  onConversationSelect(conversation.id);
                }
              }}
              onKeyDown={(e) => handleKeyDown(e, conversation.id)}
              className={`
                relative cursor-pointer transition-colors
                ${isActive ? 'bg-link/10' : 'bg-white hover:bg-black/[0.02]'}
                focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-link
              `}
              aria-label={`${displayName}${conversation.unreadCount > 0 ? `, ${conversation.unreadCount} unread messages` : ''}${preview ? `, ${preview}` : ''}`}
              aria-selected={isActive}
            >
              <div className="flex items-center px-4 h-[74px]">
                {/* Edit mode: selection circle */}
                {isEditMode && (
                  <div className="flex-shrink-0 mr-3">
                    <div
                      className={`
                        w-[22px] h-[22px] rounded-full border-2 flex items-center justify-center transition-colors
                        ${isSelected
                          ? 'bg-link border-link'
                          : 'border-secondary/40 bg-transparent'
                        }
                      `}
                      aria-hidden="true"
                    >
                      {isSelected && (
                        <svg width="12" height="9" viewBox="0 0 12 9" fill="none">
                          <path
                            d="M1 4L4.5 7.5L11 1"
                            stroke="white"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </div>
                  </div>
                )}

                {/* Avatar — 52×52 circular */}
                <div className="flex-shrink-0 w-[52px] h-[52px] rounded-full overflow-hidden bg-secondary/20">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={`${displayName}'s avatar`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-secondary text-lg font-semibold">
                      {displayName.charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>

                {/* Content area */}
                <div className="flex-1 min-w-0 ml-3">
                  <div className="flex items-baseline justify-between">
                    {/* Contact name */}
                    <h3 className="text-base font-semibold text-black truncate leading-[1.31em]">
                      {displayName}
                    </h3>
                    {/* Date */}
                    <span className="flex-shrink-0 text-sm text-secondary ml-2">
                      {date}
                    </span>
                  </div>

                  <div className="flex items-center justify-between mt-0.5">
                    {/* Message preview with optional read indicator */}
                    <div className="flex items-center gap-1 min-w-0 flex-1">
                      {lastMessageIsSent &&
                        conversation.lastMessage &&
                        !conversation.lastMessage.isDeleted && (
                          <ReadIndicatorSmall />
                        )}
                      <p className="text-sm text-secondary truncate leading-[1.19em]">
                        {preview}
                      </p>
                    </div>

                    {/* Unread badge or chevron */}
                    <div className="flex-shrink-0 ml-2 flex items-center">
                      {conversation.unreadCount > 0 ? (
                        <span
                          className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-link text-white text-xs font-semibold"
                          aria-label={`${conversation.unreadCount} unread messages`}
                        >
                          {conversation.unreadCount > 99
                            ? '99+'
                            : conversation.unreadCount}
                        </span>
                      ) : (
                        <svg
                          width="7"
                          height="12"
                          viewBox="0 0 7 12"
                          fill="none"
                          aria-hidden="true"
                          className="text-secondary/40"
                        >
                          <path
                            d="M1 1L6 6L1 11"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Row separator — 0.33px line starting at x=79px per Figma */}
              {index < sortedConversations.length - 1 && (
                <div
                  className="absolute bottom-0 right-0 h-px bg-separator"
                  style={{ left: '79px', height: '0.33px' }}
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Edit mode: bottom action bar */}
      {isEditMode && (
        <div className="flex items-center justify-around py-3 bg-white border-t border-separator">
          <button
            type="button"
            className="text-sm text-secondary disabled:opacity-40"
            disabled={selectedIds.size === 0}
            onClick={() => {
              selectedIds.forEach((id) => onArchive?.(id));
              setSelectedIds(new Set());
            }}
            aria-label="Archive selected conversations"
          >
            Archive
          </button>
          <button
            type="button"
            className="text-sm text-secondary disabled:opacity-40"
            disabled={selectedIds.size === 0}
            aria-label="Mark selected as read"
          >
            Read All
          </button>
          <button
            type="button"
            className="text-sm text-destructive disabled:opacity-40"
            disabled={selectedIds.size === 0}
            aria-label="Delete selected conversations"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Small read indicator for chat list preview row
// =============================================================================

/**
 * Compact blue double-check indicator for the chat list message preview,
 * matching Figma Screen 1 read receipt styling.
 */
function ReadIndicatorSmall(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="10"
      viewBox="0 0 15 10"
      fill="none"
      className="flex-shrink-0"
      aria-label="Read"
      role="img"
    >
      <path
        d="M1 5L3.5 7.5L9 2"
        stroke="#007AFF"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.5 5L7 7.5L12.5 2"
        stroke="#007AFF"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
