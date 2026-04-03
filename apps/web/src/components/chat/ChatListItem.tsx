'use client';

import React from 'react';
import Image from 'next/image';
import Avatar from '@/components/common/Avatar';
import { Separator } from '@/components/common/Separator';
import MessageStatus from '@/components/chat/MessageStatus';
import SwipeActions from '@/components/chat/SwipeActions';
import iconArrowRight from '@/assets/icons/icon-arrow-right.svg';
import iconPhoto from '@/assets/icons/icon-photo.svg';
import iconVoiceRecord from '@/assets/icons/icon-voice-record.svg';
import iconSelectionCircle from '@/assets/icons/icon-selection-circle.svg';

/* ==========================================================================
 * ChatListItem — Individual Conversation Row in Chat List
 *
 * Maps to Figma node 0:8873 (WhatsApp Chats screen 0:8855),
 * file key miK1B6qEPrUnRZ9wwZNrW2.
 *
 * Figma layout specs (single chat row):
 * - Row: 375×74px, bg #FFFFFF, padding-left 16px
 * - Avatar: 52×52px circular at (16, 11)
 * - Name: at (80, 7-8), SF Pro Text 600 16px, #000000, letter-spacing -2.06%
 * - Preview: at (80, 40), SF Pro Text 400 14px, #8E8E93, single-line truncate
 * - Date: right-aligned at (287-291, 10), SF Pro Text 400 14px, #8E8E93
 * - Right chevron: 7×12px at (350, 31), rgba(60,60,67,0.3)
 * - Separator: at x=79, width 296, 0.33px, rgba(60,60,67,0.29)
 *
 * Variants:
 * - default: standard text preview
 * - photo: camera icon + "Photo" text
 * - voice: green microphone icon + duration text
 * - multiline: 2-line message preview with line-clamp-2
 *
 * Edit mode: selection circle (gray outline) on left, content shifted right.
 * Swipe: wraps content in SwipeActions for "More" and "Archive" reveal.
 *
 * Design tokens used (from tailwind.config.ts):
 * - text-black, text-secondary (#8E8E93), bg-white
 * - separator color rgba(60,60,67,0.29)
 * ========================================================================== */

/**
 * Preview type determines how the message preview area is rendered.
 * Maps to the 4 Figma variants for chat row content:
 * - 'text': standard message preview text
 * - 'photo': camera icon + "Photo" label (node 0:8936)
 * - 'voice': microphone icon + duration (node 0:8964)
 * - 'multiline': 2-line message preview with line-clamp-2
 */
export type PreviewType = 'text' | 'photo' | 'voice' | 'multiline';

/**
 * Props for the ChatListItem component.
 */
export interface ChatListItemProps {
  /** Unique conversation identifier */
  conversationId: string;
  /** Contact or group display name */
  name: string;
  /** Avatar image URL (optional — falls back to initials) */
  avatarSrc?: string;
  /** Message preview text content */
  preview: string;
  /** Preview variant controlling the left-side indicator */
  previewType: PreviewType;
  /** Duration string for voice notes (e.g., "0:14") — only used when previewType='voice' */
  voiceDuration?: string;
  /** Date or time string displayed on the right (e.g., "10/7/18" or "2:13 PM") */
  date: string;
  /** Whether to show the blue read receipt indicator before the preview text */
  hasReadIndicator: boolean;
  /** Number of unread messages — renders a blue badge when > 0 */
  unreadCount?: number;
  /** Whether the conversation is muted — muted icon next to date if true */
  isMuted?: boolean;
  /** Whether this item is selected in edit mode */
  isSelected?: boolean;
  /** Whether the chat list is in edit/select mode */
  isEditMode?: boolean;
  /** Click handler when the chat row is tapped */
  onClick: () => void;
  /** "More" swipe action callback — opens ChatActionsModal */
  onMoreActions: () => void;
  /** "Archive" swipe action callback */
  onArchive: () => void;
  /** Toggle selection in edit mode */
  onToggleSelect?: () => void;
}

/**
 * ChatListItem — Renders a single conversation row in the chat list.
 *
 * Implements Figma Screen 1 (WhatsApp Chats) chat row specifications at
 * 375×74px with avatar, name, preview, date, and read indicators.
 *
 * Features:
 * - 4 preview type variants: text, photo, voice, multiline
 * - Blue read receipt indicator (via MessageStatus component)
 * - Edit mode with selection circles
 * - Swipe-to-reveal "More" and "Archive" actions (via SwipeActions)
 * - WCAG 2.1 AA: keyboard navigable, focus-visible ring, aria-labels
 *
 * @example
 * ```tsx
 * <ChatListItem
 *   conversationId="conv-123"
 *   name="Martha Craig"
 *   avatarSrc="/avatars/martha.jpg"
 *   preview="Hey! Are you coming tonight?"
 *   previewType="text"
 *   date="10/7/18"
 *   hasReadIndicator={true}
 *   onClick={() => router.push('/chat/conv-123')}
 *   onMoreActions={() => openModal('chatActions')}
 *   onArchive={() => archiveConversation('conv-123')}
 * />
 * ```
 */
const ChatListItem: React.FC<ChatListItemProps> = ({
  conversationId,
  name,
  avatarSrc,
  preview,
  previewType,
  voiceDuration,
  date,
  hasReadIndicator,
  unreadCount = 0,
  isMuted = false,
  isSelected = false,
  isEditMode = false,
  onClick,
  onMoreActions,
  onArchive,
  onToggleSelect,
}) => {
  /**
   * Keyboard handler: Enter/Space activates click in normal mode,
   * toggles selection in edit mode.
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isEditMode && onToggleSelect) {
        onToggleSelect();
      } else {
        onClick();
      }
    }
  };

  /**
   * Click handler: delegates to selection toggle in edit mode,
   * otherwise opens the conversation.
   */
  const handleClick = () => {
    if (isEditMode && onToggleSelect) {
      onToggleSelect();
    } else {
      onClick();
    }
  };

  /**
   * Renders the message preview area based on previewType.
   * Each variant matches its Figma counterpart in the Chats screen.
   */
  const renderPreview = () => {
    switch (previewType) {
      case 'photo':
        return (
          <span className="flex items-center gap-1 min-w-0">
            {hasReadIndicator && (
              <MessageStatus status="read" className="flex-shrink-0" />
            )}
            <Image
              src={iconPhoto}
              alt=""
              width={14}
              height={11}
              className="flex-shrink-0 opacity-60"
              aria-hidden="true"
            />
            <span className="truncate text-secondary">Photo</span>
          </span>
        );

      case 'voice':
        return (
          <span className="flex items-center gap-1 min-w-0">
            {hasReadIndicator && (
              <MessageStatus status="read" className="flex-shrink-0" />
            )}
            <Image
              src={iconVoiceRecord}
              alt=""
              width={9}
              height={15}
              className="flex-shrink-0"
              aria-hidden="true"
            />
            <span className="truncate text-secondary">
              {voiceDuration ?? '0:00'}
            </span>
          </span>
        );

      case 'multiline':
        return (
          <span className="flex items-start gap-1 min-w-0">
            {hasReadIndicator && (
              <MessageStatus status="read" className="flex-shrink-0 mt-0.5" />
            )}
            <span className="text-secondary line-clamp-2 leading-[1.5em]">
              {preview}
            </span>
          </span>
        );

      default:
        /* text preview — single line truncated */
        return (
          <span className="flex items-center gap-1 min-w-0">
            {hasReadIndicator && (
              <MessageStatus status="read" className="flex-shrink-0" />
            )}
            <span className="truncate text-secondary">{preview}</span>
          </span>
        );
    }
  };

  /**
   * Inner row content — avatar, name/preview column, date/chevron.
   * Wrapped in SwipeActions when not in edit mode.
   */
  const rowContent = (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Chat with ${name}. ${previewType === 'voice' ? `Voice note ${voiceDuration}` : preview}. ${date}${unreadCount > 0 ? `. ${unreadCount} unread messages` : ''}`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={[
        'flex items-center h-[74px] bg-white cursor-pointer',
        'active:bg-gray-100',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-ios',
        'motion-safe:transition-colors motion-safe:duration-150',
        isEditMode ? 'pl-0' : 'pl-4',
      ].join(' ')}
    >
      {/* Edit mode selection circle */}
      {isEditMode && (
        <div className="flex-shrink-0 w-8 flex items-center justify-center ml-2">
          {isSelected ? (
            /* Filled blue circle for selected state */
            <div className="w-[22px] h-[22px] rounded-full bg-blue-ios flex items-center justify-center">
              <svg
                width="12"
                height="9"
                viewBox="0 0 12 9"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M1 4L4.5 7.5L11 1"
                  stroke="white"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          ) : (
            /* Gray outline circle for unselected state */
            <Image
              src={iconSelectionCircle}
              alt=""
              width={22}
              height={22}
              aria-hidden="true"
            />
          )}
        </div>
      )}

      {/* Avatar — 52×52px circular */}
      <div className={`flex-shrink-0 ${isEditMode ? 'ml-2' : ''}`}>
        <Avatar src={avatarSrc} alt={name} size="md" />
      </div>

      {/* Name, preview, date column */}
      <div className="flex-1 min-w-0 ml-3 mr-2 flex flex-col justify-center">
        {/* Top row: name + date */}
        <div className="flex items-baseline justify-between">
          <span
            className="font-semibold text-[16px] leading-[1.31em] tracking-[-0.02em] text-black truncate max-w-[180px]"
          >
            {name}
          </span>
          <span className="flex-shrink-0 flex items-center gap-1 ml-2">
            {isMuted && (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                aria-label="Muted"
                className="text-secondary"
              >
                <path
                  d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"
                  fill="currentColor"
                />
              </svg>
            )}
            <span className="text-[14px] leading-[1.19em] tracking-[-0.01em] text-secondary">
              {date}
            </span>
          </span>
        </div>

        {/* Bottom row: preview + chevron/badge */}
        <div className="flex items-center justify-between mt-0.5">
          <div
            className={[
              'text-[14px] leading-[1.19em] tracking-[-0.01em] min-w-0 flex-1',
              previewType === 'multiline' ? '' : 'truncate',
            ].join(' ')}
          >
            {renderPreview()}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
            {/* Unread badge */}
            {unreadCount > 0 && (
              <span
                className="min-w-[20px] h-5 rounded-full bg-blue-ios text-white text-[12px] font-semibold flex items-center justify-center px-1.5"
                aria-label={`${unreadCount} unread messages`}
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}

            {/* Right chevron — 7×12px, muted gray */}
            {!isEditMode && (
              <Image
                src={iconArrowRight}
                alt=""
                width={7}
                height={12}
                className="opacity-30"
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div data-conversation-id={conversationId}>
      {/* In edit mode, no swipe actions — just the row content */}
      {isEditMode ? (
        rowContent
      ) : (
        <SwipeActions onMore={onMoreActions} onArchive={onArchive}>
          {rowContent}
        </SwipeActions>
      )}

      {/* Separator — indented at 79px from left edge per Figma (16px padding + 52px avatar + 11px gap) */}
      <Separator inset insetLeft={79} />
    </div>
  );
};

export default ChatListItem;
