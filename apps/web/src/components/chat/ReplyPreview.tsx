'use client';

import React from 'react';
import Image from 'next/image';

/**
 * Props for the ReplyPreview component.
 *
 * Renders a quoted/reply-to message preview inline above the current message
 * in a chat bubble, or inside the MessageInput composer area.
 */
export interface ReplyPreviewProps {
  /** Name of the original message sender */
  senderName: string;
  /** Preview text of the original message (decrypted) */
  content: string;
  /** If the original message had media */
  mediaType?: 'image' | 'video' | 'document' | 'voice';
  /** Thumbnail URL for media messages */
  thumbnailUrl?: string;
  /** Scroll to original message callback */
  onClick?: () => void;
  /** True when shown in MessageInput (has close button) */
  isInComposer?: boolean;
  /** Close/cancel reply (only in composer mode) */
  onClose?: () => void;
}

/**
 * Inline SVG icon for camera (image/video media type overlay).
 * Monochrome, uses currentColor for fill.
 */
function CameraIcon({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="10"
      viewBox="0 0 12 10"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M1.5 1.5H3L3.75 0.5H8.25L9 1.5H10.5C11.0523 1.5 11.5 1.94772 11.5 2.5V9C11.5 9.55228 11.0523 10 10.5 10H1.5C0.947715 10 0.5 9.55228 0.5 9V2.5C0.5 1.94772 0.947715 1.5 1.5 1.5Z"
        stroke="currentColor"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="5.5" r="2" stroke="currentColor" strokeWidth="0.8" />
    </svg>
  );
}

/**
 * Inline SVG icon for microphone (voice media type overlay).
 * Monochrome, uses currentColor for fill.
 */
function MicrophoneIcon({ className }: { className?: string }) {
  return (
    <svg
      width="10"
      height="14"
      viewBox="0 0 10 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="0.5" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="0.8" />
      <path
        d="M1 6.5C1 8.70914 2.79086 10.5 5 10.5C7.20914 10.5 9 8.70914 9 6.5"
        stroke="currentColor"
        strokeWidth="0.8"
        strokeLinecap="round"
      />
      <line x1="5" y1="10.5" x2="5" y2="13" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
      <line x1="3" y1="13" x2="7" y2="13" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Inline SVG icon for document media type overlay.
 * Monochrome, uses currentColor for fill.
 */
function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg
      width="10"
      height="12"
      viewBox="0 0 10 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M1 1.5C1 0.947715 1.44772 0.5 2 0.5H6.5L9.5 3.5V10.5C9.5 11.0523 9.05228 11.5 8.5 11.5H2C1.44772 11.5 1 11.0523 1 10.5V1.5Z"
        stroke="currentColor"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      <path d="M6.5 0.5V3.5H9.5" stroke="currentColor" strokeWidth="0.8" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Inline SVG close (×) button icon for composer mode.
 * Renders a circular close button.
 */
function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="8" fill="currentColor" opacity="0.3" />
      <path
        d="M5.17 5.17L10.83 10.83M10.83 5.17L5.17 10.83"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Returns the appropriate media type overlay icon component for the given media type.
 */
function getMediaOverlayIcon(mediaType: ReplyPreviewProps['mediaType']): React.ReactNode {
  switch (mediaType) {
    case 'image':
    case 'video':
      return <CameraIcon className="text-white" />;
    case 'voice':
      return <MicrophoneIcon className="text-white" />;
    case 'document':
      return <DocumentIcon className="text-white" />;
    default:
      return null;
  }
}

/**
 * Returns a human-readable media type label for accessibility.
 */
function getMediaLabel(mediaType: ReplyPreviewProps['mediaType']): string {
  switch (mediaType) {
    case 'image':
      return 'Photo';
    case 'video':
      return 'Video';
    case 'document':
      return 'Document';
    case 'voice':
      return 'Voice message';
    default:
      return '';
  }
}

/**
 * Truncates content string to a maximum length for aria-label usage.
 */
function truncateForAria(content: string, maxLength: number = 50): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength).trim() + '…';
}

/**
 * ReplyPreview — Quoted Message Inline Preview
 *
 * Renders a compact preview of a quoted/reply-to message with:
 * - Left accent border (blue #007AFF for contacts)
 * - Sender name in bold blue
 * - Message content preview (max 2 lines)
 * - Optional media thumbnail with type overlay icon
 * - Optional close button in composer mode
 *
 * Used in two contexts:
 * 1. Inside MessageBubble — shows the quoted message above the current message content
 * 2. Inside MessageInput (composer) — shows which message the user is replying to,
 *    with a close button to cancel the reply
 *
 * Design tokens derived from WhatsApp Chat screen (Figma 0:8257).
 */
const ReplyPreview: React.FC<ReplyPreviewProps> = ({
  senderName,
  content,
  mediaType,
  thumbnailUrl,
  onClick,
  isInComposer = false,
  onClose,
}) => {
  /** Determine if the component should be interactive (clickable to scroll to original) */
  const isInteractive = typeof onClick === 'function';

  /** Build content display string — include media type label when content is empty */
  const displayContent = content || (mediaType ? getMediaLabel(mediaType) : '');

  /** Build aria-label for accessibility */
  const ariaLabel = `Reply to ${senderName}: ${truncateForAria(displayContent)}`;

  /**
   * Determine background color based on composer mode.
   * Composer: bg-file-bg maps to rgba(118, 118, 128, 0.12) — Figma fill_8R37EY token.
   * Normal: bg-[rgba(118,118,128,0.08)] — subtle overlay, 0.08 opacity.
   * BLITZY [DESIGN_SYSTEM_GAP]: Normal-mode bg rgba(118,118,128,0.08) has no dedicated
   * config token. Nearest: file-bg (0.12 opacity). Chose literal for correct opacity.
   */
  const bgColor = isInComposer
    ? 'bg-file-bg'
    : 'bg-[rgba(118,118,128,0.08)]';

  /**
   * Handle keyboard activation for interactive mode.
   * Supports Enter and Space keys for button-like behavior.
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isInteractive && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onClick?.();
    }
  };

  /**
   * Handle close button click in composer mode.
   * Stops propagation to prevent triggering the parent onClick.
   */
  const handleClose = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onClose?.();
  };

  /**
   * Handle close button keyboard activation.
   */
  const handleCloseKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation();
      e.preventDefault();
      onClose?.();
    }
  };

  return (
    <div
      className={`
        relative flex items-stretch
        w-full max-h-13 overflow-hidden
        ${bgColor}
        rounded-md
        mb-1
        ${isInteractive ? 'cursor-pointer' : ''}
      `}
      {...(isInteractive
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-label': ariaLabel,
            onClick,
            onKeyDown: handleKeyDown,
          }
        : {
            'aria-label': ariaLabel,
          })}
    >
      {/* Left accent border — 3px wide, full height, blue for contacts */}
      <div
        className="flex-shrink-0 w-[3px] rounded-[1.5px] bg-blue-ios self-stretch"
        aria-hidden="true"
      />

      {/* Content area */}
      <div
        className="
          flex-1 min-w-0
          flex flex-col justify-center
          py-1.5 pl-2.5 pr-2
        "
      >
        {/* Sender name — bold blue, single line truncated
            Uses text-section-header (13px/1.23em) with font-semibold override (400→600) */}
        <span
          className="
            block
            text-section-header font-semibold
            text-blue-ios
            truncate
          "
        >
          {senderName}
        </span>

        {/* Preview text — regular weight, max 2 lines
            Uses text-section-header (13px/1.23em/400) — weight matches directly.
            line-clamp-2 handles multi-line truncation (Tailwind v3.3+ built-in). */}
        <span
          className="
            block
            text-section-header
            text-file-name
            line-clamp-2
          "
        >
          {displayContent}
        </span>
      </div>

      {/* Media thumbnail — 40×40px on the right side */}
      {mediaType && thumbnailUrl && (
        <div
          className="
            relative flex-shrink-0
            w-10 h-10
            my-auto mr-2
            rounded overflow-hidden
          "
        >
          <Image
            src={thumbnailUrl}
            alt={`${getMediaLabel(mediaType)} thumbnail`}
            className="w-full h-full object-cover"
            width={40}
            height={40}
            loading="lazy"
            unoptimized
          />
          {/* Media type overlay icon */}
          <div
            className="
              absolute inset-0
              flex items-center justify-center
              bg-black/30
            "
            aria-hidden="true"
          >
            {getMediaOverlayIcon(mediaType)}
          </div>
        </div>
      )}

      {/* Media type indicator (no thumbnail) — show icon only.
          BLITZY [DESIGN_SYSTEM_GAP]: rgba(0,0,0,0.5) not in token config.
          Nearest: text-file-name (0.7 opacity). Chose literal for reduced emphasis. */}
      {mediaType && !thumbnailUrl && (
        <div
          className="
            flex-shrink-0
            flex items-center
            pr-2
            text-[rgba(0,0,0,0.5)]
          "
          aria-hidden="true"
        >
          {mediaType === 'image' || mediaType === 'video' ? (
            <CameraIcon />
          ) : mediaType === 'voice' ? (
            <MicrophoneIcon />
          ) : mediaType === 'document' ? (
            <DocumentIcon />
          ) : null}
        </div>
      )}

      {/* Close button — only visible in composer mode */}
      {isInComposer && onClose && (
        <button
          type="button"
          onClick={handleClose}
          onKeyDown={handleCloseKeyDown}
          aria-label="Cancel reply"
          className="
            absolute top-1 right-1
            flex items-center justify-center
            w-4 h-4
            text-secondary
            rounded-full
            focus:outline-none
            focus-visible:ring-2 focus-visible:ring-blue-ios
          "
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
};

export default ReplyPreview;
