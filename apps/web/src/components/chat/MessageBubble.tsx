'use client';

import React, { useCallback, useRef } from 'react';
import MessageStatus from './MessageStatus';
import ReplyPreview from './ReplyPreview';
import LinkPreviewCard from './LinkPreviewCard';
import MediaMessage from './MediaMessage';
import VoiceNotePlayer from './VoiceNotePlayer';

/* ─── Constants ─────────────────────────────────────────────────────────── */

/** Long-press threshold in milliseconds for triggering context menu */
const LONG_PRESS_MS = 500;

/** Minimum horizontal swipe distance (px) to trigger swipe-to-reply */
const SWIPE_THRESHOLD_PX = 80;

/** Maximum vertical movement (px) before a horizontal gesture is cancelled */
const SWIPE_VERTICAL_TOLERANCE_PX = 30;

/* ─── Exported Interface ────────────────────────────────────────────────── */

/**
 * Props for the MessageBubble component.
 *
 * Covers text, media, document, voice-note, link-preview, and reply-to
 * content types. Supports edit/delete indicators, read receipts, grouping,
 * long-press context menus, and swipe-to-reply gestures.
 */
export interface MessageBubbleProps {
  /** Unique message identifier */
  id: string;
  /** Decrypted plaintext message content */
  content: string;
  /** Formatted display time, e.g. "10:10" */
  timestamp: string;
  /** True → sent bubble (right-aligned, green); False → received (left-aligned, light) */
  isOwnMessage: boolean;
  /** Delivery status – only meaningful when isOwnMessage is true */
  status?: 'sending' | 'sent' | 'delivered' | 'read';
  /** Part of a consecutive sequence from the same sender (reduces top radius) */
  isConnected?: boolean;
  /** First message in a sender-group (renders speech-bubble tail) */
  isFirstInGroup?: boolean;
  /** Last message in a sender-group (renders timestamp row) */
  isLastInGroup?: boolean;
  /** Image / video / document attachment */
  mediaAttachment?: {
    type: 'image' | 'video' | 'document';
    fileName: string;
    fileSize: string;
    fileExtension: string;
    thumbnailUrl?: string;
    fullUrl?: string;
  };
  /** Voice-note audio payload */
  voiceNote?: {
    audioUrl: string;
    duration: number;
    waveformData?: number[];
  };
  /** OG-metadata link preview */
  linkPreview?: {
    url: string;
    title: string;
    description?: string;
    image?: string;
    siteName?: string;
  };
  /** Quoted / reply-to message reference */
  replyTo?: {
    senderName: string;
    content: string;
    mediaType?: 'image' | 'video' | 'document' | 'voice';
    thumbnailUrl?: string;
  };
  /** Whether the message was edited (shows "(edited)" label) */
  isEdited?: boolean;
  /** Deleted-message tombstone (replaces content with italicised notice) */
  isDeleted?: boolean;
  /** Long-press / right-click context-menu callback */
  onLongPress?: () => void;
  /** Tap-on-reply-preview callback (scroll to original message) */
  onReply?: () => void;
  /** Horizontal swipe-to-reply gesture callback */
  onSwipeReply?: () => void;
}

/* ─── Bubble Tail SVG ───────────────────────────────────────────────────── */

/**
 * Small speech-bubble tail rendered only for the first message in a group.
 * Sent: points top-right; Received: points top-left.
 * Fill colour matches the parent bubble background.
 */
const BubbleTail: React.FC<{ isOwnMessage: boolean }> = ({ isOwnMessage }) => {
  /* BLITZY [COLOR]: Figma #DCF7C5 sent, #FAFAFA received (authoritative). */
  const fill = isOwnMessage ? '#DCF7C5' : '#FAFAFA';
  const positionClass = isOwnMessage
    ? 'absolute -right-[6px] top-0'
    : 'absolute -left-[6px] top-0';

  return (
    <div className={positionClass} aria-hidden="true">
      <svg
        width="6"
        height="10"
        viewBox="0 0 6 10"
        fill="none"
        className="block"
      >
        {isOwnMessage ? (
          <path d="M0 0H6C2.69 0 0 2.69 0 6V0Z" fill={fill} />
        ) : (
          <path d="M6 0H0C3.31 0 6 2.69 6 6V0Z" fill={fill} />
        )}
      </svg>
    </div>
  );
};

/* ─── Main Component ────────────────────────────────────────────────────── */

const MessageBubble: React.FC<MessageBubbleProps> = ({
  id,
  content,
  timestamp,
  isOwnMessage,
  status,
  isConnected = false,
  isFirstInGroup = true,
  isLastInGroup = true,
  mediaAttachment,
  voiceNote,
  linkPreview,
  replyTo,
  isEdited = false,
  isDeleted = false,
  onLongPress,
  onReply,
  onSwipeReply,
}) => {
  /* ── Refs for touch-gesture tracking ─────────────────────────────── */
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartXRef = useRef<number>(0);
  const touchStartYRef = useRef<number>(0);
  const isSwipingRef = useRef<boolean>(false);
  const bubbleRef = useRef<HTMLDivElement>(null);

  /* ── Timer cleanup ───────────────────────────────────────────────── */
  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  /* ── Touch: start (begin long-press countdown) ───────────────────── */
  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const touch = e.touches[0];
      touchStartXRef.current = touch.clientX;
      touchStartYRef.current = touch.clientY;
      isSwipingRef.current = false;

      clearLongPressTimer();
      longPressTimerRef.current = setTimeout(() => {
        onLongPress?.();
        longPressTimerRef.current = null;
      }, LONG_PRESS_MS);
    },
    [onLongPress, clearLongPressTimer],
  );

  /* ── Touch: move (cancel long-press; detect swipe-to-reply) ──────── */
  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const touch = e.touches[0];
      const dx = touch.clientX - touchStartXRef.current;
      const dy = Math.abs(touch.clientY - touchStartYRef.current);

      /* Any movement cancels long-press */
      clearLongPressTimer();

      /* Swipe-right on received messages → reply */
      if (
        !isOwnMessage &&
        dx > SWIPE_THRESHOLD_PX &&
        dy < SWIPE_VERTICAL_TOLERANCE_PX &&
        !isSwipingRef.current
      ) {
        isSwipingRef.current = true;
        onSwipeReply?.();
      }
    },
    [isOwnMessage, onSwipeReply, clearLongPressTimer],
  );

  /* ── Touch: end / cancel ─────────────────────────────────────────── */
  const handleTouchEnd = useCallback(() => {
    clearLongPressTimer();
    isSwipingRef.current = false;
  }, [clearLongPressTimer]);

  /* ── Desktop right-click → context menu ──────────────────────────── */
  const handleContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (onLongPress) {
        e.preventDefault();
        onLongPress();
      }
    },
    [onLongPress],
  );

  /* ── Computed styles ─────────────────────────────────────────────── */

  /**
   * Background colour derived from Figma node 0:8257.
   * BLITZY [COLOR]: Figma #DCF7C5 sent (not AAP #DCF8C6). Authoritative.
   * BLITZY [COLOR]: Figma #FAFAFA received (not AAP #FFFFFF). Authoritative.
   */
  const bgClass = isOwnMessage ? 'bg-[#DCF7C5]' : 'bg-[#FAFAFA]';

  /**
   * Border-radius logic:
   *  - connected (middle/last in group): flat top corners (0 px)
   *  - first-in-group + own:   tail at top-right  → top-right 0
   *  - first-in-group + other: tail at top-left   → top-left  0
   *  - default:                8 px all round
   */
  const borderRadiusClass = (() => {
    if (isConnected) {
      return 'rounded-t-none rounded-b-lg';
    }
    if (isFirstInGroup) {
      return isOwnMessage
        ? 'rounded-tl-lg rounded-tr-none rounded-b-lg'
        : 'rounded-tl-none rounded-tr-lg rounded-b-lg';
    }
    return 'rounded-lg';
  })();

  /** Inner padding: received bubbles add extra left padding for the tail area */
  const paddingClass = isOwnMessage
    ? 'px-2 pt-[5px] pb-[3px]'
    : 'pl-4 pr-2 pt-[5px] pb-[3px]';

  /** Horizontal alignment of the row within the chat area */
  const alignmentClass = isOwnMessage ? 'justify-end' : 'justify-start';

  /** Vertical gap between consecutive bubbles (parent may also control this) */
  const gapClass = isConnected ? 'mt-[2px]' : 'mt-1';

  /** Bubble shadow from Figma: blur 1.63 px, rgba(0,0,0,0.4), offset 1 px 1 px */
  const shadowClass = 'shadow-[1px_1px_1.63px_rgba(0,0,0,0.4)]';

  /* ── Accessibility label ─────────────────────────────────────────── */
  const ariaLabel = isDeleted
    ? 'Deleted message'
    : `${isOwnMessage ? 'You' : 'Contact'}: ${content || 'Media message'}, ${timestamp}${status ? `, ${status}` : ''}`;

  /* ────────────────────────────────────────────────────────────────── */
  /*  Deleted-message tombstone                                        */
  /* ────────────────────────────────────────────────────────────────── */
  if (isDeleted) {
    return (
      <div
        className={`flex ${alignmentClass} ${gapClass}`}
        data-message-id={id}
        role="article"
        aria-label={ariaLabel}
      >
        <div
          className={[
            'relative max-w-[75%]',
            bgClass,
            borderRadiusClass,
            paddingClass,
            shadowClass,
            'opacity-70',
          ].join(' ')}
        >
          {/* Tail (first in group only) */}
          {isFirstInGroup && !isConnected && (
            <BubbleTail isOwnMessage={isOwnMessage} />
          )}

          <p
            className="
              text-[16px] font-normal italic
              leading-[1.193em] tracking-[-0.01875em]
              text-secondary
            "
          >
            This message was deleted
          </p>
        </div>
      </div>
    );
  }

  /* ────────────────────────────────────────────────────────────────── */
  /*  Normal message                                                   */
  /* ────────────────────────────────────────────────────────────────── */
  return (
    <div
      className={`flex ${alignmentClass} ${gapClass}`}
      data-message-id={id}
      role="article"
      aria-label={ariaLabel}
      aria-haspopup={onLongPress ? 'menu' : undefined}
    >
      <div
        ref={bubbleRef}
        className={[
          'relative max-w-[75%]',
          bgClass,
          borderRadiusClass,
          paddingClass,
          shadowClass,
        ].join(' ')}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onContextMenu={handleContextMenu}
      >
        {/* ── Tail (first in group only) ────────────────────────────── */}
        {isFirstInGroup && !isConnected && (
          <BubbleTail isOwnMessage={isOwnMessage} />
        )}

        {/* ── 1. Reply Preview ──────────────────────────────────────── */}
        {replyTo && (
          <div className="mb-1">
            <ReplyPreview
              senderName={replyTo.senderName}
              content={replyTo.content}
              mediaType={replyTo.mediaType}
              thumbnailUrl={replyTo.thumbnailUrl}
              onClick={onReply}
            />
          </div>
        )}

        {/* ── 2a. Media Attachment (image / video / document) ───────── */}
        {mediaAttachment && !voiceNote && (
          <div className="mb-1">
            <MediaMessage
              type={mediaAttachment.type}
              fileName={mediaAttachment.fileName}
              fileSize={mediaAttachment.fileSize}
              fileExtension={mediaAttachment.fileExtension}
              thumbnailUrl={mediaAttachment.thumbnailUrl}
              fullUrl={mediaAttachment.fullUrl}
              isOwnMessage={isOwnMessage}
            />
          </div>
        )}

        {/* ── 2b. Voice Note (alternative to media) ─────────────────── */}
        {voiceNote && (
          <div className="mb-1">
            <VoiceNotePlayer
              audioUrl={voiceNote.audioUrl}
              duration={voiceNote.duration}
              waveformData={voiceNote.waveformData}
              isOwnMessage={isOwnMessage}
            />
          </div>
        )}

        {/* ── 3. Link Preview ───────────────────────────────────────── */}
        {linkPreview && (
          <div className="mb-1">
            <LinkPreviewCard
              preview={{
                url: linkPreview.url,
                title: linkPreview.title,
                description: linkPreview.description,
                image: linkPreview.image,
                siteName: linkPreview.siteName,
              }}
            />
          </div>
        )}

        {/* ── 4. Text Content ───────────────────────────────────────── */}
        {/* BLITZY [TYPOGRAPHY]: tracking-[-0.01875em] is the correct -1.875% value per Figma.
            Config token tighter-ios (-0.03em = -3%) has a label mismatch — not used. */}
        {content && (
          <p
            className="
              text-[16px] font-normal
              leading-[1.193em] tracking-[-0.01875em]
              text-black
              break-words whitespace-pre-wrap
            "
          >
            {content}
          </p>
        )}

        {/* ── 5. Timestamp Row (visible on last-in-group only) ──────── */}
        {/* BLITZY [CONTRAST]: text-timestamp rgba(0,0,0,0.25) on bubble bg has low WCAG contrast (~2.4:1).
            This is the exact Figma value — per DS7, flagged but not altered. */}
        {isLastInGroup && (
          <div className="flex items-center justify-end gap-[3px] mt-[2px]">
            {isEdited && (
              <span
                className="
                  text-[11px] font-normal
                  leading-[1.193em] tracking-[0.0455em]
                  text-timestamp
                "
              >
                (edited)
              </span>
            )}
            <span
              className="
                text-[11px] font-normal
                leading-[1.193em] tracking-[0.0455em]
                text-timestamp
              "
            >
              {timestamp}
            </span>
            {isOwnMessage && status && (
              <MessageStatus
                status={status}
                className="w-[13.5px] h-[8px]"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageBubble;

/* ═══════════════════════════════════════════════════════════════════════════
 * BLITZY FLAG MANIFEST — MessageBubble.tsx
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. BLITZY [COLOR] (line ~97, ~220-221): Sent bubble bg #DCF7C5 diverges
 *    from Tailwind config token msg-sent (#DCF8C6). Figma fill_T2NMTH is
 *    authoritative per agent prompt. ΔE ≈ 0.3 (imperceptible).
 *
 * 2. BLITZY [COLOR] (line ~97, ~220-221): Received bubble bg #FAFAFA diverges
 *    from Tailwind config token msg-received (#FFFFFF). Figma fill_VTU3AE is
 *    authoritative per agent prompt.
 *
 * 3. BLITZY [TYPOGRAPHY] (line ~391): tracking-[-0.01875em] (= -1.875%) is
 *    the correct Figma value. Config token tighter-ios is -0.03em (= -3%),
 *    labelled as -1.875% but numerically wrong. Arbitrary value used.
 *
 * 4. BLITZY [CONTRAST] (line ~407): text-timestamp rgba(0,0,0,0.25) on
 *    either bubble bg has WCAG contrast ratio ~2.4:1 (fails AA for both
 *    normal and large text). Value is exact Figma spec — flagged per DS7,
 *    not altered.
 * ═══════════════════════════════════════════════════════════════════════════ */
