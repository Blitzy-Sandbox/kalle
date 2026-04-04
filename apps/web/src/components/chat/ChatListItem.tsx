'use client';

import React from 'react';
import Image from 'next/image';
import Avatar from '@/components/common/Avatar';
import MessageStatus from '@/components/chat/MessageStatus';
import SwipeActions from '@/components/chat/SwipeActions';
import iconArrowRight from '@/assets/icons/icon-arrow-right.svg';
import iconPhoto from '@/assets/icons/icon-photo.svg';
import iconVoiceRecord from '@/assets/icons/icon-voice-record.svg';
import iconSelectionCircle from '@/assets/icons/icon-selection-circle.svg';

/* ==========================================================================
 * ChatListItem — Individual Conversation Row in Chat List
 *
 * Maps to Figma node 0:8873 (Maximillian Jacobson row as canonical example)
 * within WhatsApp Chats screen (0:8855), file key miK1B6qEPrUnRZ9wwZNrW2.
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
 * - default (text): standard text preview
 * - photo: camera icon 14×11px (#8E8E93) + "Photo" text with 5.5px gap
 * - voice: green mic icon 9×15px (#60BB58) + duration text with 5px gap
 * - multiline: 2-line message preview with line-clamp-2, leading-[1.5em]
 *
 * Edit mode: selection circle (gray outline) on left, content shifted right.
 * Swipe: wraps content in SwipeActions for "More" and "Archive" reveal.
 *
 * Design tokens (from tailwind.config.ts):
 * - text-chat-name: SF Pro Text 600 16px / 1.31em
 * - text-chat-preview: SF Pro Text 400 14px / 1.19em
 * - text-chat-date: SF Pro Text 400 14px / 1.19em
 * - text-secondary: #8E8E93
 * - border-separator: rgba(60,60,67,0.29)
 * - border-b-hairline: 0.33px
 * ========================================================================== */

/**
 * Preview type determines how the message preview area is rendered.
 * Maps to the 4 Figma variants for chat row content:
 * - 'text': standard single-line message preview text
 * - 'photo': camera icon + "Photo" label (Figma node 0:8936)
 * - 'voice': green microphone icon + duration (Figma node 0:8964)
 * - 'multiline': 2-line message preview with line-clamp-2 (Figma node 0:8909)
 */
export type PreviewType = 'text' | 'photo' | 'voice' | 'multiline';

/**
 * Props for the ChatListItem component.
 * Each property maps to a visual element in the Figma chat row design.
 */
export interface ChatListItemProps {
  /** Unique conversation identifier — used for data attribute and navigation */
  conversationId: string;
  /** Contact or group display name — SF Pro Text 600 16px at position (80, 7-8) */
  name: string;
  /** Avatar image URL — falls back to initials via Avatar component when undefined */
  avatarSrc?: string;
  /** Message preview text content (decrypted) — shown in preview area */
  preview: string;
  /** Preview variant controlling icon and layout of the preview area */
  previewType: PreviewType;
  /** Duration string for voice notes (e.g., "0:14") — only used when previewType='voice' */
  voiceDuration?: string;
  /** Date or time string displayed at right (e.g., "11/19/19" or "2:13 PM") */
  date: string;
  /** Whether to show the blue read receipt indicator before the preview text */
  hasReadIndicator: boolean;
  /** Number of unread messages — renders a blue badge when > 0 */
  unreadCount?: number;
  /** Whether the conversation is muted — shows muted speaker icon next to date */
  isMuted?: boolean;
  /** Whether this item is selected in edit mode — drives aria-checked and blue circle */
  isSelected?: boolean;
  /** Whether the chat list is in edit/select mode — toggles selection UI and disables swipe */
  isEditMode?: boolean;
  /** Click handler — navigates to conversation view in normal mode, toggles selection in edit mode */
  onClick: () => void;
  /** "More" swipe action callback — opens ChatActionsModal (swipe action on More button) */
  onMoreActions: () => void;
  /** "Archive" swipe action callback — archives conversation (swipe action on Archive button) */
  onArchive: () => void;
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
 * - Edit mode with selection circles (outline gray / filled blue)
 * - Swipe-to-reveal "More" and "Archive" actions (via SwipeActions wrapper)
 * - Inline 0.33px separator at x=79 (indented past avatar)
 *
 * Accessibility:
 * - role="listitem" in normal mode, role="checkbox" in edit mode
 * - Keyboard navigable (Enter/Space activates click)
 * - focus-visible ring for keyboard users
 * - Descriptive aria-label with name, preview, date, and unread count
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
}) => {
  /**
   * Keyboard handler: Enter or Space activates the row click.
   * Prevents default to stop scroll on Space.
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  /**
   * Renders the blue double-check read receipt indicator when hasReadIndicator
   * is true, followed by a 2.5px spacer matching Figma gap between indicator
   * and preview content (indicator at x=81, 17px wide → 2.5px gap → content).
   */
  const renderReadIndicator = () => {
    if (!hasReadIndicator) return null;
    return (
      <>
        <span className="flex-shrink-0 flex items-center">
          <MessageStatus status="read" />
        </span>
        {/* 2.5px gap between read indicator and preview content per Figma */}
        <span className="w-[2.5px] flex-shrink-0" aria-hidden="true" />
      </>
    );
  };

  /**
   * Renders the message preview area based on previewType.
   * Each variant matches its Figma counterpart exactly:
   *
   * - text: [read indicator?] → single-line truncated text
   * - photo: [read indicator?] → camera icon 14×11 → 5.5px gap → "Photo"
   * - voice: [read indicator?] → mic icon 9×15 → 5px gap → duration
   * - multiline: [read indicator?] → 2-line text with line-clamp-2
   */
  const renderPreview = () => {
    switch (previewType) {
      case 'photo':
        return (
          <span className="flex items-center min-w-0">
            {renderReadIndicator()}
            <Image
              src={iconPhoto}
              alt=""
              width={14}
              height={11}
              className="flex-shrink-0"
              aria-hidden="true"
            />
            {/* 5.5px gap between camera icon and "Photo" text per Figma */}
            <span className="w-[5.5px] flex-shrink-0" aria-hidden="true" />
            <span className="truncate text-secondary text-chat-preview tracking-[-0.01em]">
              Photo
            </span>
          </span>
        );

      case 'voice':
        return (
          <span className="flex items-center min-w-0">
            {renderReadIndicator()}
            <Image
              src={iconVoiceRecord}
              alt=""
              width={9}
              height={15}
              className="flex-shrink-0"
              aria-hidden="true"
            />
            {/* 5px gap between voice icon and duration text per Figma */}
            <span className="w-[5px] flex-shrink-0" aria-hidden="true" />
            <span className="truncate text-secondary text-chat-preview tracking-[-0.01em]">
              {voiceDuration ?? '0:00'}
            </span>
          </span>
        );

      case 'multiline':
        return (
          <span className="flex items-start min-w-0">
            {hasReadIndicator && (
              <>
                <span className="flex-shrink-0 mt-[1px] flex items-center">
                  <MessageStatus status="read" />
                </span>
                <span className="w-[2.5px] flex-shrink-0" aria-hidden="true" />
              </>
            )}
            {/* Multiline uses 1.5em line-height (Figma style_JAK7GS)
                instead of the standard 1.19em single-line height */}
            <span
              className="text-secondary text-[14px] font-normal leading-[1.5em] tracking-[-0.01em] line-clamp-2"
            >
              {preview}
            </span>
          </span>
        );

      default:
        /* text preview — single line truncated */
        return (
          <span className="flex items-center min-w-0">
            {renderReadIndicator()}
            <span className="truncate text-secondary text-chat-preview tracking-[-0.01em]">
              {preview}
            </span>
          </span>
        );
    }
  };

  /**
   * Builds the composite aria-label for screen reader announcements.
   * Format: "{name}, {preview context}, {date}[, {unreadCount} unread messages]"
   */
  const ariaLabel = [
    name,
    previewType === 'voice'
      ? `Voice note ${voiceDuration ?? '0:00'}`
      : previewType === 'photo'
        ? 'Photo'
        : preview,
    date,
    unreadCount > 0 ? `${unreadCount} unread messages` : '',
  ]
    .filter(Boolean)
    .join(', ');

  /** Whether preview type uses 2-line layout — affects vertical padding and gap */
  const isMultiline = previewType === 'multiline';

  /**
   * Inner row content — avatar, name/preview column, right indicators.
   * This element receives focus, keyboard, and click handling.
   * Wrapped in SwipeActions when not in edit mode.
   *
   * Layout uses items-start (not items-center) to allow explicit vertical
   * positioning that matches the Figma specs exactly:
   * - Avatar at y=11 via mt-[11px]
   * - Name at y=8 via pt-[8px] on content column (pt-[5px] for multiline)
   * - Preview at y=40 via mt-[11px] gap (mt-px for multiline)
   * - Chevron vertically centered via self-center at y=(74-12)/2=31
   */
  const rowContent = (
    <div
      role={isEditMode ? 'checkbox' : 'listitem'}
      tabIndex={0}
      aria-label={ariaLabel}
      aria-checked={isEditMode ? isSelected : undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={[
        'flex items-start h-[74px] bg-white cursor-pointer',
        'active:bg-gray-100',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-ios',
        'motion-safe:transition-colors motion-safe:duration-150',
        isEditMode ? 'pl-0' : 'pl-4',
      ].join(' ')}
    >
      {/* Edit mode selection circle — Figma Screen 2 (node 0:8114).
          self-center vertically centers the 21×21 circle within the 74px row. */}
      {isEditMode && (
        <div className="flex-shrink-0 w-8 self-center flex items-center justify-center ml-2">
          {isSelected ? (
            /* Filled blue circle with white checkmark for selected state */
            <div
              className="w-[21px] h-[21px] rounded-full bg-blue-ios flex items-center justify-center"
            >
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
            /* Gray outline circle for unselected state — icon-selection-circle.svg (21×21) */
            <Image
              src={iconSelectionCircle}
              alt=""
              width={21}
              height={21}
              aria-hidden="true"
            />
          )}
        </div>
      )}

      {/* Avatar — 52×52px circular at position (16, 11) within the row.
          mt-[11px] positions the avatar top at y=11 per Figma spec. */}
      <div className={`flex-shrink-0 mt-[11px] ${isEditMode ? 'ml-2' : ''}`}>
        <Avatar src={avatarSrc} alt={name} size="md" />
      </div>

      {/* Name, preview, date column — flex-1 fills remaining width.
          ml-3 (12px) gap: avatar at x=16, width 52 → right edge at 68, + 12 = name at x=80.
          Top padding positions name at y=8 (standard) or y=5 (multiline). */}
      <div
        className={[
          'flex-1 min-w-0 ml-3 flex flex-col',
          isMultiline ? 'pt-[5px]' : 'pt-[8px]',
        ].join(' ')}
      >
        {/* Top row: name (left) + date (right) */}
        <div className="flex items-baseline justify-between">
          {/* Contact name — SF Pro Text 600 16px, #000000, tracking -2.06% ≈ -0.02em.
              min-w-0 enables flex truncation; no fixed max-width so flex layout
              naturally truncates when the name approaches the date area. */}
          <span
            className="text-chat-name tracking-[-0.02em] text-black truncate min-w-0"
          >
            {name}
          </span>

          {/* Date area — right-aligned, with optional muted speaker icon */}
          <span className="flex-shrink-0 flex items-center gap-1 ml-2">
            {/* BLITZY [ASSET]: Muted speaker icon is inline SVG — not from Figma export.
                The isMuted prop is part of the required ChatListItemProps schema but no
                Figma screen shows a muted row. Replace with Figma-sourced asset when available. */}
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
            {/* Date text — SF Pro Text 400 14px, #8E8E93, tracking -1.07% ≈ -0.01em */}
            <span className="text-chat-date tracking-[-0.01em] text-secondary">
              {date}
            </span>
          </span>
        </div>

        {/* Bottom row: preview content (left) + unread badge (right).
            Gap: 11px for standard rows (name bottom at y≈29, preview at y=40),
            1px for multiline rows (name bottom at y≈26, preview at y=27). */}
        <div className={[
          'flex items-start',
          isMultiline ? 'mt-px' : 'mt-[11px]',
        ].join(' ')}>
          {/* Preview area — flex-1 fills available width */}
          <div className="min-w-0 flex-1">
            {renderPreview()}
          </div>

          {/* Unread message count badge — blue pill when unreadCount > 0.
              Positioned in the preview row flow, to the left of the chevron. */}
          {unreadCount > 0 && (
            <span
              className="min-w-[20px] h-5 rounded-full bg-blue-ios text-white text-[12px] font-semibold flex items-center justify-center px-1.5 flex-shrink-0 ml-2"
              aria-label={`${unreadCount} unread messages`}
            >
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </div>
      </div>

      {/* Right chevron arrow — 7×12px, rgba(60,60,67,0.3) fill baked into SVG.
          self-center vertically centers the chevron at y=(74-12)/2=31 per Figma.
          Hidden in edit mode per Figma Screen 2 spec. */}
      {!isEditMode && (
        <div className="self-center flex-shrink-0 ml-2 mr-[18px]">
          <Image
            src={iconArrowRight}
            alt=""
            width={7}
            height={12}
            aria-hidden="true"
          />
        </div>
      )}
    </div>
  );

  return (
    <div data-conversation-id={conversationId}>
      {/* In edit mode, disable swipe actions — show row content directly.
          In normal mode, wrap in SwipeActions for "More" and "Archive" reveal. */}
      {isEditMode ? (
        rowContent
      ) : (
        <SwipeActions onMore={onMoreActions} onArchive={onArchive}>
          {rowContent}
        </SwipeActions>
      )}

      {/* Separator — 0.33px horizontal line starting at x=79
          (16px padding + 52px avatar + 11px gap = 79px from left edge).
          Color: rgba(60,60,67,0.29) per Figma stroke_CCBBM1. */}
      <div
        className="h-[0.33px] bg-separator ml-[79px]"
        aria-hidden="true"
      />
    </div>
  );
};

export default ChatListItem;
