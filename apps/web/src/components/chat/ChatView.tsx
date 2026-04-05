'use client';

/**
 * @file ChatView.tsx
 * @description Chat message view container — the core conversation screen.
 *
 * Renders the full conversation view matching Figma Screen 4 (0:8257):
 * chat header, scrollable message area with wallpaper background, date
 * separators between message groups, message bubbles (sent/received),
 * typing indicator, new-message scroll-to-bottom banner, and the message
 * input bar at the bottom.
 *
 * Figma Mapping:
 *   Screen 4 (0:8257): WhatsApp Chat — individual chat conversation view.
 *   - Top header: back chevron, avatar, contact name, subtitle, call icons
 *   - Chat area: repeating wallpaper-pattern beige/tan background
 *   - Sent messages: light green (#DCF8C6) bubbles right-aligned
 *   - Received messages: white bubbles left-aligned
 *   - Date separator: "Fri, Jul 26" centered gray pill
 *   - Bottom input bar: "+" attachment, text input, emoji, camera, mic
 *
 * Key Rule Compliance:
 *   - R4:  Messages displayed in serverTimestamp ascending order (oldest first)
 *   - R12: Decryption happens outside this component; receives decrypted text via prop
 *   - R13: Offline reconciliation via onSync callback when WebSocket reconnects
 *   - R15: Mobile push/pop navigation — ChatView fully replaces ChatList at ≤767px
 *   - R19: Edited messages show "edited" indicator via MessageBubble
 *   - R20: Deleted messages show tombstone "This message was deleted" via MessageBubble
 *   - R34: ARIA live region for new messages, keyboard navigable, focus management
 *
 * Design Tokens (from tailwind.config.ts):
 *   - Chat wallpaper: bg-chat-wallpaper (or fallback image)
 *   - Message area padding: px-4 (16px)
 *   - Scroll container: flex-1 overflow-y-auto
 *
 * @see {@link ChatHeader} for top navigation bar
 * @see {@link MessageBubble} for individual message rendering
 * @see {@link MessageInput} for bottom composer bar
 * @see {@link DateSeparator} for date grouping
 * @see {@link TypingIndicator} for typing animation
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { MessageResponse } from '@kalle/shared';
import { MessageType, MessageStatusEnum } from '@kalle/shared';
import ChatHeader from './ChatHeader';
import MessageBubble from './MessageBubble';
import MessageInput from './MessageInput';
import DateSeparator from './DateSeparator';

// =============================================================================
// Types
// =============================================================================

/**
 * Decrypted message content mapped by message ID.
 * Populated by the encryption layer (R12 — client-side only).
 */
export type DecryptedMessageMap = Record<string, string>;

export interface ChatViewProps {
  /** Unique conversation identifier */
  conversationId: string;

  /** Display name of the contact or group */
  contactName: string;

  /** Avatar URL for the contact or group */
  contactAvatar?: string;

  /** Whether the conversation is a group chat */
  isGroup?: boolean;

  /** Whether the other participant is online (DIRECT chats) */
  isOnline?: boolean;

  /** Array of users currently typing in this conversation */
  typingUsers?: string[];

  /** Messages array sorted by serverTimestamp ascending (R4) */
  messages: MessageResponse[];

  /** Map of messageId → decrypted plaintext (R12) */
  decryptedMessages: DecryptedMessageMap;

  /** Map of messageId → decrypted reply preview text */
  decryptedReplies?: DecryptedMessageMap;

  /** Current authenticated user's ID */
  currentUserId: string;

  /** Whether older messages are being loaded (pagination in progress) */
  isLoadingMore?: boolean;

  /** Whether there are more older messages to load */
  hasMoreMessages?: boolean;

  /** Callback to load older messages for infinite scroll */
  onLoadMore?: () => void;

  /** Callback when user sends a text message */
  onSendMessage: (text: string) => void;

  /** Callback when user sends a media file */
  onSendMedia: (file: File) => void;

  /** Callback when voice recording starts */
  onStartVoiceNote: () => void;

  /** Callback when voice recording stops */
  onStopVoiceNote: () => void;

  /** Callback when camera shortcut button is tapped in message input */
  onCameraCapture?: () => void;

  /** Callback when back button is pressed (R15 mobile navigation) */
  onBack: () => void;

  /** Callback when contact info area is pressed */
  onContactInfo: () => void;

  /** Callback when video call icon is pressed */
  onVideoCall?: () => void;

  /** Callback when phone call icon is pressed */
  onPhoneCall?: () => void;

  /** Callback when a reply-to message is tapped */
  onReplyClick?: (messageId: string) => void;

  /** Callback when a message is long-pressed (context menu) */
  onMessageLongPress?: (message: MessageResponse) => void;

  /** Callback to trigger offline sync (R13) */
  onSync?: () => void;

  /** Optional CSS class name */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Distance from bottom (px) within which auto-scroll stays active */
const AUTO_SCROLL_THRESHOLD = 150;

/** Scroll position from top (px) that triggers loading more messages */
const LOAD_MORE_THRESHOLD = 100;

/** Minimum interval (ms) between loadMore calls to prevent rapid firing */
const LOAD_MORE_DEBOUNCE_MS = 500;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Format an ISO-8601 timestamp to a short "HH:MM" display string for
 * message bubble timestamps (Figma: 11px, bottom-right of bubble).
 */
function formatMessageTime(isoTimestamp: string): string {
  try {
    const d = new Date(isoTimestamp);
    if (Number.isNaN(d.getTime())) return '';
    const h = d.getHours();
    const m = d.getMinutes();
    return `${h}:${m.toString().padStart(2, '0')}`;
  } catch {
    return '';
  }
}

/**
 * Map the shared-package `MessageStatusEnum` to the lowercase string union
 * expected by `MessageBubbleProps.status`.
 */
function mapMessageStatus(
  status: MessageStatusEnum,
): 'sent' | 'delivered' | 'read' {
  switch (status) {
    case MessageStatusEnum.READ:
      return 'read';
    case MessageStatusEnum.DELIVERED:
      return 'delivered';
    case MessageStatusEnum.SENT:
    default:
      return 'sent';
  }
}

/**
 * Map `MessageType` to the `replyTo.mediaType` union expected by
 * `MessageBubbleProps`.
 */
function mapMediaType(
  type: MessageType,
): 'image' | 'video' | 'document' | 'voice' | undefined {
  switch (type) {
    case MessageType.IMAGE:
      return 'image';
    case MessageType.VIDEO:
      return 'video';
    case MessageType.DOCUMENT:
      return 'document';
    case MessageType.VOICE_NOTE:
      return 'voice';
    default:
      return undefined;
  }
}

/**
 * Groups messages by date for rendering DateSeparator components between
 * message groups. Returns an ordered array of [dateLabel, messages[]] tuples.
 *
 * @param messages - Messages sorted by serverTimestamp ascending (R4)
 * @returns Array of [dateLabel, MessageResponse[]] tuples
 */
function groupMessagesByDate(
  messages: MessageResponse[],
): [string, MessageResponse[]][] {
  const groups: [string, MessageResponse[]][] = [];
  let currentDateLabel = '';
  let currentGroup: MessageResponse[] = [];

  for (const msg of messages) {
    const date = new Date(msg.serverTimestamp);
    const dateLabel = formatDateLabel(date);

    if (dateLabel !== currentDateLabel) {
      if (currentGroup.length > 0) {
        groups.push([currentDateLabel, currentGroup]);
      }
      currentDateLabel = dateLabel;
      currentGroup = [msg];
    } else {
      currentGroup.push(msg);
    }
  }

  if (currentGroup.length > 0) {
    groups.push([currentDateLabel, currentGroup]);
  }

  return groups;
}

/**
 * Formats a Date into a human-readable label for date separators.
 * Matches Figma Screen 4 date pill format: "Fri, Jul 26" or "Today"/"Yesterday".
 *
 * @param date - The date to format
 * @returns Formatted date label string
 */
function formatDateLabel(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor(
    (today.getTime() - msgDay.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${weekdays[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}`;
}

// =============================================================================
// Component
// =============================================================================

/**
 * ChatView renders the full chat conversation interface.
 *
 * Features:
 *   - Scrollable message area with wallpaper background per Figma Screen 4
 *   - Messages grouped by date with DateSeparator components
 *   - Sent (right, green) and received (left, white) MessageBubble components
 *   - Auto-scroll to bottom on new messages (when near bottom)
 *   - Infinite scroll upward for loading older message history
 *   - Typing indicator for participants currently typing
 *   - New messages indicator when scrolled up and new messages arrive
 *   - ChatHeader with back navigation (R15), contact info, call actions
 *   - MessageInput bar for text, media, and voice notes
 *   - ARIA live region announces new messages to screen readers (R34)
 *   - Keyboard accessible with focus management
 */
export default function ChatView({
  conversationId,
  contactName,
  contactAvatar,
  isGroup = false,
  isOnline = false,
  typingUsers = [],
  messages,
  decryptedMessages,
  decryptedReplies = {},
  currentUserId,
  isLoadingMore = false,
  hasMoreMessages = false,
  onLoadMore,
  onSendMessage,
  onSendMedia,
  onStartVoiceNote,
  onStopVoiceNote,
  onCameraCapture,
  onBack,
  onContactInfo,
  onVideoCall,
  onPhoneCall,
  onReplyClick,
  onMessageLongPress,
  onSync,
  className = '',
}: ChatViewProps): React.JSX.Element {
  // ── Refs ────────────────────────────────────────────────────────────
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const lastLoadMoreRef = useRef<number>(0);
  const prevMessageCountRef = useRef<number>(messages.length);

  // ── State ───────────────────────────────────────────────────────────
  const [showNewMessagesBanner, setShowNewMessagesBanner] = useState(false);
  const [lastLiveMessage, setLastLiveMessage] = useState('');

  // ── Derived typing subtitle ─────────────────────────────────────────
  const typingSubtitle = useMemo((): string | undefined => {
    if (typingUsers.length === 0) return undefined;
    if (typingUsers.length === 1) {
      return isGroup ? `${typingUsers[0]} is typing…` : 'typing…';
    }
    if (typingUsers.length === 2) {
      return `${typingUsers[0]} and ${typingUsers[1]} are typing…`;
    }
    return `${typingUsers[0]} and ${typingUsers.length - 1} others are typing…`;
  }, [typingUsers, isGroup]);

  // ── Auto-scroll logic ───────────────────────────────────────────────

  /**
   * Determines if the user is scrolled near the bottom of the message area.
   * Used to decide whether to auto-scroll on new messages.
   */
  const isNearBottom = useCallback((): boolean => {
    const container = scrollContainerRef.current;
    if (!container) return true;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < AUTO_SCROLL_THRESHOLD;
  }, []);

  /**
   * Scrolls the message area to the bottom.
   * Uses smooth scrolling for new messages, instant for initial load.
   */
  const scrollToBottom = useCallback((smooth = true): void => {
    bottomAnchorRef.current?.scrollIntoView({
      behavior: smooth ? 'smooth' : 'instant',
      block: 'end',
    });
  }, []);

  // ── New message detection and auto-scroll ───────────────────────────
  useEffect(() => {
    const newCount = messages.length;
    const prevCount = prevMessageCountRef.current;

    if (newCount > prevCount) {
      // New messages arrived
      const latestMessage = messages[messages.length - 1];

      if (latestMessage) {
        // Update ARIA live region with latest message preview
        const decrypted = decryptedMessages[latestMessage.id];
        if (decrypted) {
          const sender = latestMessage.senderId === currentUserId
            ? 'You'
            : latestMessage.senderName;
          setLastLiveMessage(`${sender}: ${decrypted}`);
        }
      }

      if (
        latestMessage?.senderId === currentUserId ||
        isNearBottom()
      ) {
        // Auto-scroll if user sent the message or is near bottom
        requestAnimationFrame(() => scrollToBottom(true));
        setShowNewMessagesBanner(false);
      } else {
        // Show "new messages" banner when scrolled up
        setShowNewMessagesBanner(true);
      }
    }

    prevMessageCountRef.current = newCount;
  }, [messages, decryptedMessages, currentUserId, isNearBottom, scrollToBottom]);

  // ── Initial scroll to bottom on conversation change ─────────────────
  useEffect(() => {
    prevMessageCountRef.current = messages.length;
    requestAnimationFrame(() => scrollToBottom(false));
    setShowNewMessagesBanner(false);
    // Trigger offline sync on conversation open (R13)
    onSync?.();
  }, [conversationId]); // Only re-run when conversation changes

  // ── Infinite scroll: load older messages ────────────────────────────
  const handleScroll = useCallback((): void => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // Hide new messages banner when scrolled to bottom
    if (isNearBottom()) {
      setShowNewMessagesBanner(false);
    }

    // Load more messages when scrolled near top
    if (
      container.scrollTop < LOAD_MORE_THRESHOLD &&
      hasMoreMessages &&
      !isLoadingMore
    ) {
      const now = Date.now();
      if (now - lastLoadMoreRef.current > LOAD_MORE_DEBOUNCE_MS) {
        lastLoadMoreRef.current = now;
        const prevScrollHeight = container.scrollHeight;
        onLoadMore?.();
        // Maintain scroll position after older messages load
        requestAnimationFrame(() => {
          const newScrollHeight = container.scrollHeight;
          container.scrollTop = newScrollHeight - prevScrollHeight;
        });
      }
    }
  }, [hasMoreMessages, isLoadingMore, onLoadMore, isNearBottom]);

  // ── Group messages by date for rendering ────────────────────────────
  const messageGroups = useMemo(
    () => groupMessagesByDate(messages),
    [messages],
  );

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div
      className={`flex flex-col h-full bg-white ${className}`}
      role="main"
      aria-label={`Conversation with ${contactName}`}
    >
      {/* ─── Chat Header ──────────────────────────────────────────────── */}
      <ChatHeader
        contactName={contactName}
        contactAvatar={contactAvatar}
        subtitle={typingSubtitle || (isOnline ? 'online' : 'tap here for contact info')}
        isOnline={isOnline}
        isTyping={typingUsers.length > 0}
        onBack={onBack}
        onContactInfo={onContactInfo}
        onVideoCall={onVideoCall || (() => {})}
        onPhoneCall={onPhoneCall || (() => {})}
      />

      {/* ─── Message Area ─────────────────────────────────────────────── */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto bg-chat-wallpaper bg-repeat bg-center"
        onScroll={handleScroll}
        role="log"
        aria-label="Messages"
        aria-live="polite"
        aria-relevant="additions"
      >
        {/* Loading indicator for older messages */}
        {isLoadingMore && (
          <div className="flex items-center justify-center py-4">
            <div className="flex gap-1">
              <div className="w-2 h-2 rounded-full bg-secondary animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-2 h-2 rounded-full bg-secondary animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-2 h-2 rounded-full bg-secondary animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}

        {/* "Load earlier messages" hint when at top with more available */}
        {hasMoreMessages && !isLoadingMore && messages.length > 0 && (
          <div className="flex items-center justify-center py-3">
            <button
              type="button"
              onClick={onLoadMore}
              className="text-xs text-link font-normal focus:outline-none focus-visible:ring-2 focus-visible:ring-link rounded px-3 py-1"
              aria-label="Load earlier messages"
            >
              ↑ Load earlier messages
            </button>
          </div>
        )}

        {/* Message groups with date separators */}
        <div className="px-2 py-2">
          {messageGroups.map(([dateLabel, groupMessages]) => (
            <div key={dateLabel} className="mb-1">
              <DateSeparator date={dateLabel} />
              <div className="space-y-1">
                {groupMessages.map((message) => {
                  const isSent = message.senderId === currentUserId;
                  const decryptedContent = decryptedMessages[message.id] || '';
                  const decryptedReply = message.replyTo
                    ? decryptedReplies[message.replyTo.id] || ''
                    : undefined;

                  return (
                    <MessageBubble
                      key={message.id}
                      id={message.id}
                      content={decryptedContent}
                      timestamp={formatMessageTime(message.serverTimestamp)}
                      isOwnMessage={isSent}
                      status={isSent ? mapMessageStatus(message.status) : undefined}
                      isEdited={message.isEdited}
                      isDeleted={message.isDeleted}
                      replyTo={
                        message.replyTo
                          ? {
                              senderName: message.replyTo.senderName,
                              content: decryptedReply ?? '',
                              mediaType: mapMediaType(message.replyTo.type),
                            }
                          : undefined
                      }
                      linkPreview={
                        message.linkPreview
                          ? {
                              url: message.linkPreview.url,
                              title: message.linkPreview.title ?? '',
                              description: message.linkPreview.description,
                              image: message.linkPreview.imageUrl,
                              siteName: message.linkPreview.siteName,
                            }
                          : undefined
                      }
                      onLongPress={
                        onMessageLongPress
                          ? () => onMessageLongPress(message)
                          : undefined
                      }
                      onReply={
                        onReplyClick
                          ? () => onReplyClick(message.id)
                          : undefined
                      }
                      onSwipeReply={
                        onReplyClick
                          ? () => onReplyClick(message.id)
                          : undefined
                      }
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Typing indicator at bottom of messages */}
        {typingUsers.length > 0 && (
          <div className="px-4 pb-2" aria-hidden="true">
            <div className="inline-flex items-center gap-1 bg-white rounded-2xl px-4 py-2 shadow-sm max-w-[75%]">
              <div className="flex gap-0.5">
                <span
                  className="w-2 h-2 rounded-full bg-secondary animate-bounce"
                  style={{ animationDelay: '0ms' }}
                />
                <span
                  className="w-2 h-2 rounded-full bg-secondary animate-bounce"
                  style={{ animationDelay: '200ms' }}
                />
                <span
                  className="w-2 h-2 rounded-full bg-secondary animate-bounce"
                  style={{ animationDelay: '400ms' }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Bottom anchor for auto-scroll */}
        <div ref={bottomAnchorRef} aria-hidden="true" />
      </div>

      {/* ─── ARIA Live Region for screen readers (R34) ────────────────── */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {lastLiveMessage}
      </div>

      {/* ─── New Messages Banner ──────────────────────────────────────── */}
      {showNewMessagesBanner && (
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              scrollToBottom(true);
              setShowNewMessagesBanner(false);
            }}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-white text-link text-xs font-semibold px-4 py-1.5 rounded-full shadow-md border border-separator z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-link"
            aria-label="Scroll to new messages"
          >
            ↓ New messages
          </button>
        </div>
      )}

      {/* ─── Message Input Bar ────────────────────────────────────────── */}
      <MessageInput
        onSendMessage={onSendMessage}
        onSendMedia={onSendMedia}
        onStartVoiceNote={onStartVoiceNote}
        onStopVoiceNote={onStopVoiceNote}
        onCameraCapture={onCameraCapture ?? (() => {})}
      />
    </div>
  );
}
