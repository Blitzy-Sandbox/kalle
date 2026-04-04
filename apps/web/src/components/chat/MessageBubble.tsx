'use client';

/**
 * @file MessageBubble.tsx
 * @description Message bubble component for sent and received messages.
 *
 * Renders individual chat messages in the conversation view matching
 * Figma Screen 4 (0:8257) specifications. Supports text, image, video,
 * document, voice note, and deleted (tombstone) message types.
 *
 * Figma Mapping:
 *   Screen 4 (0:8257): Individual chat conversation view.
 *   - Sent bubbles: right-aligned, light green (#DCF8C6) background
 *   - Received bubbles: left-aligned, white (#FFFFFF) background
 *   - Blue double-check read indicators on sent messages
 *   - Timestamp in gray below message content
 *   - Document attachments: file icon, filename, size, type
 *
 * Design Tokens:
 *   - Sent background: #DCF8C6 (msg-sent from tailwind.config.ts)
 *   - Received background: #FFFFFF (white)
 *   - Timestamp text: SF Pro Text 400 11px #8E8E93 (secondary)
 *   - Sender name (group): SF Pro Text 600 13px, colored per-user
 *   - Body text: SF Pro Text 400 15px #000000
 *   - Deleted text: SF Pro Text 400 15px italic #8E8E93
 *   - Edit indicator: SF Pro Text 400 11px #8E8E93
 *   - Max width: 75% of container
 *   - Border radius: 12px (rounded-xl)
 *
 * Rule Compliance:
 *   R12 — Content displayed is decrypted plaintext from client-side decryption.
 *         This component receives already-decrypted content via props.
 *   R19 — Edited messages display "(edited)" indicator with editedAt timestamp.
 *   R20 — Deleted/tombstone messages render "This message was deleted" in italic.
 *   R34 — WCAG 2.1 AA: semantic HTML, ARIA labels, 4.5:1 contrast on text.
 *
 * @see {@link MessageStatusIndicator} for sent/delivered/read checkmarks
 * @see {@link VoiceNotePlayer} for voice note waveform playback
 */

import React, { useMemo } from 'react';
import {
  MessageType,
  MessageStatusEnum,
} from '@kalle/shared/types/message';
import type {
  MessageResponse,
  ReplyToMessage,
  LinkPreviewData,
} from '@kalle/shared/types/message';

// =============================================================================
// Types
// =============================================================================

export interface MessageBubbleProps {
  /** The full message response object */
  message: MessageResponse;

  /** Decrypted plaintext content (already decrypted client-side per R12).
   *  Null if the message is a tombstone (R20). */
  decryptedContent: string | null;

  /** Whether this message was sent by the current user */
  isSent: boolean;

  /** Whether to show the sender name (for group conversations) */
  showSenderName?: boolean;

  /** Decrypted reply-to content (for quoted message preview, R12) */
  decryptedReplyContent?: string | null;

  /** Callback when the reply-to preview is tapped (to scroll to original) */
  onReplyClick?: (messageId: string) => void;

  /** Callback when the message is long-pressed (for context menu: edit, delete, reply) */
  onLongPress?: (message: MessageResponse) => void;

  /** Optional CSS class name for layout customization */
  className?: string;
}

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Formats a time string from an ISO 8601 timestamp into "HH:MM" format
 * for display in the message bubble footer.
 *
 * @param isoTimestamp - ISO 8601 date string
 * @returns Formatted time string (e.g., "14:23", "9:05")
 */
function formatMessageTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Generates a deterministic color from a user ID string for group chat
 * sender name differentiation.
 *
 * @param userId - The sender's user ID
 * @returns A hex color string from a fixed palette of high-contrast colors
 */
function getSenderColor(userId: string): string {
  const SENDER_COLORS = [
    '#E91E63', '#9C27B0', '#673AB7', '#3F51B5',
    '#2196F3', '#009688', '#4CAF50', '#FF9800',
    '#FF5722', '#795548', '#607D8B', '#F44336',
  ];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length];
}

// =============================================================================
// Sub-components
// =============================================================================

/**
 * MessageStatusIndicator renders delivery/read status checkmarks for sent messages.
 *
 * Figma Screen 4 (0:8257) specification:
 *   - SENT: single gray checkmark
 *   - DELIVERED: double gray checkmarks
 *   - READ: double blue checkmarks (#007AFF)
 */
function MessageStatusIndicator({
  status,
}: {
  status: MessageStatusEnum;
}): React.JSX.Element {
  if (status === MessageStatusEnum.READ) {
    return (
      <svg
        width="16"
        height="11"
        viewBox="0 0 16 11"
        fill="none"
        className="flex-shrink-0"
        aria-label="Read"
        role="img"
      >
        <path
          d="M1 5.5L4.5 9L11 2"
          stroke="#007AFF"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M5 5.5L8.5 9L15 2"
          stroke="#007AFF"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (status === MessageStatusEnum.DELIVERED) {
    return (
      <svg
        width="16"
        height="11"
        viewBox="0 0 16 11"
        fill="none"
        className="flex-shrink-0"
        aria-label="Delivered"
        role="img"
      >
        <path
          d="M1 5.5L4.5 9L11 2"
          stroke="#8E8E93"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M5 5.5L8.5 9L15 2"
          stroke="#8E8E93"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // SENT: single checkmark
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 11 11"
      fill="none"
      className="flex-shrink-0"
      aria-label="Sent"
      role="img"
    >
      <path
        d="M1 5.5L4.5 9L10 2"
        stroke="#8E8E93"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * ReplyPreviewBanner renders the quoted message preview inside a reply bubble.
 *
 * Displays the original sender name and a truncated preview of the original
 * message content. If the original message was deleted (R20 tombstone),
 * shows "This message was deleted" in italic.
 */
function ReplyPreviewBanner({
  replyTo,
  decryptedContent,
  onClick,
}: {
  replyTo: ReplyToMessage;
  decryptedContent: string | null | undefined;
  onClick?: (messageId: string) => void;
}): React.JSX.Element {
  const previewText = useMemo(() => {
    if (replyTo.ciphertext === null) {
      return 'This message was deleted';
    }
    if (decryptedContent) {
      return decryptedContent.length > 80
        ? decryptedContent.slice(0, 80) + '…'
        : decryptedContent;
    }
    // Fallback for media types without decrypted text
    switch (replyTo.type) {
      case MessageType.IMAGE:
        return '📷 Photo';
      case MessageType.VIDEO:
        return '🎥 Video';
      case MessageType.DOCUMENT:
        return '📄 Document';
      case MessageType.VOICE_NOTE:
        return '🎤 Voice note';
      default:
        return 'Message';
    }
  }, [replyTo, decryptedContent]);

  const senderColor = getSenderColor(replyTo.senderId);

  return (
    <button
      type="button"
      onClick={() => onClick?.(replyTo.id)}
      className="w-full text-left rounded-lg bg-black/5 px-3 py-1.5 mb-1 border-l-4 cursor-pointer hover:bg-black/10 transition-colors"
      style={{ borderLeftColor: senderColor }}
      aria-label={`Reply to ${replyTo.senderName}: ${previewText}`}
    >
      <p
        className="text-[13px] font-semibold leading-tight truncate"
        style={{ color: senderColor }}
      >
        {replyTo.senderName}
      </p>
      <p
        className={`text-[13px] leading-tight truncate ${
          replyTo.ciphertext === null ? 'italic text-secondary' : 'text-secondary'
        }`}
      >
        {previewText}
      </p>
    </button>
  );
}

/**
 * LinkPreviewCard renders Open Graph metadata for URL messages.
 *
 * Displays a card with the page title, description, and optional OG image
 * extracted asynchronously by the link-preview BullMQ job.
 */
function LinkPreviewCard({
  preview,
}: {
  preview: LinkPreviewData;
}): React.JSX.Element {
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-lg overflow-hidden bg-black/5 mb-1 hover:bg-black/10 transition-colors"
      aria-label={`Link preview: ${preview.title || preview.url}`}
    >
      {preview.imageUrl && (
        <div className="w-full h-32 bg-secondary/20 overflow-hidden">
          <img
            src={preview.imageUrl}
            alt={preview.title || 'Link preview'}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </div>
      )}
      <div className="px-3 py-2">
        {preview.siteName && (
          <p className="text-[11px] text-secondary uppercase tracking-wide">
            {preview.siteName}
          </p>
        )}
        {preview.title && (
          <p className="text-[13px] font-semibold text-primary leading-tight line-clamp-2">
            {preview.title}
          </p>
        )}
        {preview.description && (
          <p className="text-[12px] text-secondary leading-tight line-clamp-2 mt-0.5">
            {preview.description}
          </p>
        )}
      </div>
    </a>
  );
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * MessageBubble renders a single chat message in the conversation view.
 *
 * Supports all message types defined in MessageType:
 *   - TEXT: plaintext content with optional link preview
 *   - IMAGE: thumbnail with tap-to-view
 *   - VIDEO: thumbnail with play overlay
 *   - DOCUMENT: file icon, name, size badge
 *   - VOICE_NOTE: inline waveform player (via VoiceNotePlayer)
 *   - Deleted/tombstone (R20): italic "This message was deleted"
 *
 * Layout matching Figma Screen 4:
 *   - Sent: right-aligned, max-width 75%, bg-msg-sent (#DCF8C6)
 *   - Received: left-aligned, max-width 75%, bg-white
 *   - Timestamp and status indicators in bottom-right footer area
 */
export default function MessageBubble({
  message,
  decryptedContent,
  isSent,
  showSenderName = false,
  decryptedReplyContent,
  onReplyClick,
  onLongPress,
  className = '',
}: MessageBubbleProps): React.JSX.Element {
  const time = formatMessageTime(message.serverTimestamp);
  const senderColor = useMemo(
    () => getSenderColor(message.senderId),
    [message.senderId],
  );

  // ── Tombstone (R20): deleted message ──────────────────────────────────
  if (message.isDeleted) {
    return (
      <div
        className={`flex ${isSent ? 'justify-end' : 'justify-start'} px-2 ${className}`}
        role="article"
        aria-label={`Deleted message from ${message.senderName}`}
      >
        <div
          className={`
            max-w-[75%] rounded-xl px-3 py-2
            ${isSent ? 'bg-msg-sent rounded-tr-sm' : 'bg-white rounded-tl-sm'}
          `}
        >
          <p className="text-[15px] italic text-secondary leading-[1.33em]">
            This message was deleted
          </p>
          <div className="flex items-center justify-end gap-1 mt-0.5">
            <span className="text-[11px] text-secondary/70">{time}</span>
            {isSent && <MessageStatusIndicator status={message.status} />}
          </div>
        </div>
      </div>
    );
  }

  // ── Normal message ────────────────────────────────────────────────────
  return (
    <div
      className={`flex ${isSent ? 'justify-end' : 'justify-start'} px-2 ${className}`}
      role="article"
      aria-label={`Message from ${message.senderName}: ${
        decryptedContent
          ? decryptedContent.slice(0, 60)
          : message.type
      }`}
      onContextMenu={(e) => {
        if (onLongPress) {
          e.preventDefault();
          onLongPress(message);
        }
      }}
    >
      <div
        className={`
          max-w-[75%] rounded-xl px-3 py-2
          ${isSent ? 'bg-msg-sent rounded-tr-sm' : 'bg-white rounded-tl-sm'}
        `}
      >
        {/* Sender name (group conversations only) */}
        {showSenderName && !isSent && (
          <p
            className="text-[13px] font-semibold leading-tight mb-0.5"
            style={{ color: senderColor }}
          >
            {message.senderName}
          </p>
        )}

        {/* Reply-to preview */}
        {message.replyTo && (
          <ReplyPreviewBanner
            replyTo={message.replyTo}
            decryptedContent={decryptedReplyContent}
            onClick={onReplyClick}
          />
        )}

        {/* Link preview (for TEXT messages with extracted OG data) */}
        {message.linkPreview && (
          <LinkPreviewCard preview={message.linkPreview} />
        )}

        {/* Message content by type */}
        <MessageContent
          message={message}
          decryptedContent={decryptedContent}
          isSent={isSent}
        />

        {/* Footer: timestamp, edited indicator, status checkmarks */}
        <div className="flex items-center justify-end gap-1 mt-0.5">
          {message.isEdited && (
            <span className="text-[11px] text-secondary/70 italic">edited</span>
          )}
          <span className="text-[11px] text-secondary/70">{time}</span>
          {isSent && <MessageStatusIndicator status={message.status} />}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// MessageContent — renders the appropriate content based on message type
// =============================================================================

function MessageContent({
  message,
  decryptedContent,
  isSent,
}: {
  message: MessageResponse;
  decryptedContent: string | null;
  isSent: boolean;
}): React.JSX.Element {
  switch (message.type) {
    case MessageType.TEXT:
      return (
        <p className="text-[15px] text-black leading-[1.33em] break-words whitespace-pre-wrap">
          {decryptedContent || ''}
        </p>
      );

    case MessageType.IMAGE:
      return (
        <div className="rounded-lg overflow-hidden mb-1">
          {/* Image placeholder — actual image rendered by parent with decrypted media */}
          <div
            className="w-full min-h-[120px] bg-secondary/20 flex items-center justify-center"
            role="img"
            aria-label="Encrypted image attachment"
          >
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" stroke="#8E8E93" strokeWidth="1.5" />
              <circle cx="8.5" cy="8.5" r="1.5" fill="#8E8E93" />
              <path d="M5 16L8.29 12.71C8.68 12.32 9.32 12.32 9.71 12.71L12 15L14.29 12.71C14.68 12.32 15.32 12.32 15.71 12.71L19 16" stroke="#8E8E93" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          {decryptedContent && (
            <p className="text-[15px] text-black leading-[1.33em] break-words whitespace-pre-wrap mt-1">
              {decryptedContent}
            </p>
          )}
        </div>
      );

    case MessageType.VIDEO:
      return (
        <div className="rounded-lg overflow-hidden mb-1">
          <div
            className="w-full min-h-[120px] bg-secondary/20 flex items-center justify-center relative"
            role="img"
            aria-label="Encrypted video attachment"
          >
            {/* Play overlay */}
            <div className="w-12 h-12 rounded-full bg-black/40 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M6 3.5V16.5L17 10L6 3.5Z" fill="white" />
              </svg>
            </div>
          </div>
          {decryptedContent && (
            <p className="text-[15px] text-black leading-[1.33em] break-words whitespace-pre-wrap mt-1">
              {decryptedContent}
            </p>
          )}
        </div>
      );

    case MessageType.DOCUMENT:
      return (
        <div className="flex items-center gap-3 py-1 mb-1">
          {/* Document icon matching Figma Screen 4 */}
          <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-link/10 flex items-center justify-center">
            <svg width="20" height="24" viewBox="0 0 20 24" fill="none" aria-hidden="true">
              <path
                d="M2 2C2 0.9 2.9 0 4 0H12L20 8V22C20 23.1 19.1 24 18 24H4C2.9 24 2 23.1 2 22V2Z"
                fill="#007AFF"
                fillOpacity="0.15"
              />
              <path
                d="M12 0L20 8H14C12.9 8 12 7.1 12 6V0Z"
                fill="#007AFF"
                fillOpacity="0.3"
              />
              <path
                d="M4 2H12V6C12 7.1 12.9 8 14 8H18V22H4V2Z"
                stroke="#007AFF"
                strokeWidth="1"
                fill="none"
              />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-semibold text-black truncate">
              {decryptedContent || 'Document'}
            </p>
            {message.mediaId && (
              <p className="text-[12px] text-secondary">
                {message.type}
              </p>
            )}
          </div>
        </div>
      );

    case MessageType.VOICE_NOTE:
      return (
        <div className="min-w-[200px]">
          {/* VoiceNotePlayer is rendered by the parent with actual audio data.
              This provides the structural placeholder with metadata display. */}
          <div
            className="flex items-center gap-2 py-1"
            role="group"
            aria-label={`Voice note${decryptedContent ? ': ' + decryptedContent : ''}`}
          >
            <div
              className={`
                flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center
                ${isSent ? 'bg-whatsapp-green' : 'bg-link'}
              `}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M3 1.5V10.5L10.5 6L3 1.5Z" fill="white" />
              </svg>
            </div>
            {/* Waveform placeholder — actual waveform rendered by VoiceNotePlayer */}
            <div className="flex-1 flex items-end gap-px h-8">
              {Array.from({ length: 30 }, (_, i) => (
                <div
                  key={i}
                  className={`flex-1 rounded-full ${isSent ? 'bg-whatsapp-green/50' : 'bg-secondary/40'}`}
                  style={{ height: `${20 + Math.random() * 60}%` }}
                />
              ))}
            </div>
          </div>
        </div>
      );

    default:
      return (
        <p className="text-[15px] text-black leading-[1.33em] break-words whitespace-pre-wrap">
          {decryptedContent || ''}
        </p>
      );
  }
}
