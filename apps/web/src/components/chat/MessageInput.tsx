'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import Image from 'next/image';
import ReplyPreview from '@/components/chat/ReplyPreview';
import iconAttachPlus from '@/assets/icons/icon-attach-plus.svg';
import iconEmoji from '@/assets/icons/icon-emoji.svg';
import iconCameraInput from '@/assets/icons/icon-camera-input.svg';
import iconMicrophone from '@/assets/icons/icon-microphone.svg';

/* ==========================================================================
 * MessageInput — Bottom Message Composer Bar
 *
 * Maps to Figma node 0:8452 (Send Message Bar) within WhatsApp Chat
 * screen (0:8257), file key miK1B6qEPrUnRZ9wwZNrW2.
 *
 * Figma layout specs:
 * - Container: 375×80px (min), bg #F6F6F6 (bg-nav)
 * - Top shadow: 0px -0.33px 0px rgba(166,166,170,1) (shadow-tab)
 * - Add/Attach: 19×19px at (14,14), blue #007AFF icon
 * - Text field: 228×32px at (47,7), bg #FFFFFF, border 0.5px #8E8E93
 *   opacity 0.45, border-radius 16px, placeholder "Message" 16px
 * - Emoji icon: 18×18px inside text field right edge, #007AFF
 * - Camera icon: 22×19px at (295,13), #007AFF
 * - Mic icon: 16×24px at (341,12), #007AFF
 *
 * Behavior:
 * - Typing text hides camera + mic icons, shows send button
 * - Enter sends message (unless Shift held for newline)
 * - Textarea auto-grows up to 4 lines
 * - Mic tap starts voice recording (hold-to-record optional)
 * - When replyTo is provided, ReplyPreview appears above input
 *
 * Design tokens (from tailwind.config.ts):
 * - bg-nav (#F6F6F6), shadow-tab, text-blue-ios (#007AFF)
 * - text-secondary (#8E8E93), bg-white
 * ========================================================================== */

/**
 * Reply context passed to MessageInput when replying to a message.
 * Rendered as a ReplyPreview bar above the text input.
 */
export interface ReplyContext {
  /** ID of the message being replied to */
  messageId: string;
  /** Display name of the original sender */
  senderName: string;
  /** Preview text of the original message */
  content: string;
  /** Media type of original message if applicable */
  mediaType?: 'image' | 'video' | 'document' | 'voice';
}

/**
 * Props for the MessageInput component.
 */
export interface MessageInputProps {
  /** Callback when a text message is sent */
  onSendMessage: (text: string) => void;
  /** Callback to open attachment picker modal */
  onSendMedia?: () => void;
  /** Callback when voice recording starts */
  onStartVoiceNote?: () => void;
  /** Callback when voice recording stops */
  onStopVoiceNote?: () => void;
  /** Callback when camera shortcut is tapped */
  onCameraCapture?: () => void;
  /** Reply context when replying to a message */
  replyTo?: ReplyContext;
  /** Callback to cancel the reply */
  onCancelReply?: () => void;
  /** Whether the input is disabled (e.g., during encryption key exchange) */
  disabled?: boolean;
  /** Whether voice recording is currently active */
  isRecordingVoice?: boolean;
}

/**
 * Inline SVG send arrow icon displayed when text is being composed.
 * White upward arrow inside blue circle (32×32px).
 */
function SendIcon({ className }: { className?: string }) {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="16" className="fill-blue-ios" />
      <path
        d="M16 8L16 24M16 8L10 14M16 8L22 14"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Maximum number of lines before the textarea stops growing */
const MAX_LINES = 4;
/** Line height in pixels for calculating textarea height */
const LINE_HEIGHT_PX = 20;
/** Base padding inside textarea */
const TEXTAREA_PADDING_PX = 12;

/**
 * MessageInput — Bottom message composer bar for chat conversations.
 *
 * Implements the Figma Screen 4 input bar with:
 * - Attachment "+" button to open AttachmentModal
 * - Auto-growing textarea (up to 4 lines) with rounded border
 * - Emoji toggle icon inside the text field
 * - Camera shortcut and microphone icons (hidden when typing)
 * - Send button (blue circle with arrow, appears when text is non-empty)
 * - Reply preview bar above input when replying to a message
 *
 * WCAG 2.1 AA compliant (R34):
 * - All buttons have aria-labels
 * - Focus-visible ring on interactive elements
 * - Keyboard: Enter sends, Shift+Enter newline
 *
 * @example
 * ```tsx
 * <MessageInput
 *   onSendMessage={(text) => sendEncryptedMessage(text)}
 *   onSendMedia={() => openAttachmentModal()}
 *   onStartVoiceNote={() => startRecording()}
 *   onStopVoiceNote={() => stopRecording()}
 *   onCameraCapture={() => openCamera()}
 *   replyTo={{ messageId: 'msg-1', senderName: 'Martha', content: 'Hello!' }}
 *   onCancelReply={() => clearReply()}
 * />
 * ```
 */
const MessageInput: React.FC<MessageInputProps> = ({
  onSendMessage,
  onSendMedia,
  onStartVoiceNote,
  onStopVoiceNote,
  onCameraCapture,
  replyTo,
  onCancelReply,
  disabled = false,
  isRecordingVoice = false,
}) => {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasText = text.trim().length > 0;

  /**
   * Auto-resize textarea height based on content.
   * Grows from 1 line up to MAX_LINES, then scrolls.
   */
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    /* Reset height to auto to get accurate scrollHeight */
    textarea.style.height = 'auto';
    const maxHeight = LINE_HEIGHT_PX * MAX_LINES + TEXTAREA_PADDING_PX;
    const newHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${newHeight}px`;
  }, []);

  /** Re-adjust height whenever text changes */
  useEffect(() => {
    adjustTextareaHeight();
  }, [text, adjustTextareaHeight]);

  /**
   * Handle text input change — update state and auto-resize.
   */
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
  };

  /**
   * Handle keyboard shortcuts:
   * - Enter (no modifier): send message
   * - Shift+Enter: insert newline
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /**
   * Send the composed text message.
   * Trims whitespace, resets input, and notifies parent.
   */
  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || disabled) return;

    onSendMessage(trimmed);
    setText('');

    /* Reset textarea height after clearing */
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    });
  }, [text, disabled, onSendMessage]);

  return (
    <div className="bg-nav shadow-[0px_-0.33px_0px_rgba(166,166,170,1)]">
      {/* Reply preview — appears above input when replying to a message */}
      {replyTo && (
        <div className="px-4 pt-2">
          <ReplyPreview
            senderName={replyTo.senderName}
            content={replyTo.content}
            mediaType={replyTo.mediaType}
            isInComposer
            onClose={onCancelReply}
          />
        </div>
      )}

      {/* Main input row */}
      <div className="flex items-end gap-2 px-3 py-2">
        {/* Attachment "+" button */}
        <button
          type="button"
          onClick={onSendMedia}
          disabled={disabled}
          aria-label="Add attachment"
          className={[
            'flex-shrink-0 w-[36px] h-[36px] flex items-center justify-center rounded-full',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
            'active:bg-gray-200 motion-safe:transition-colors',
            disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
          ].join(' ')}
        >
          <Image
            src={iconAttachPlus}
            alt=""
            width={19}
            height={19}
            aria-hidden="true"
          />
        </button>

        {/* Text input field with emoji icon */}
        <div className="flex-1 relative flex items-end">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Message"
            disabled={disabled}
            rows={1}
            aria-label="Type a message"
            className={[
              'w-full resize-none rounded-2xl border border-secondary/45 bg-white',
              'pl-3 pr-9 py-1.5',
              'text-[16px] leading-[1.25em] text-black placeholder:text-secondary/60',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
              disabled ? 'opacity-50 cursor-not-allowed' : '',
            ].join(' ')}
            style={{
              minHeight: `${LINE_HEIGHT_PX + TEXTAREA_PADDING_PX}px`,
              maxHeight: `${LINE_HEIGHT_PX * MAX_LINES + TEXTAREA_PADDING_PX}px`,
            }}
          />

          {/* Emoji toggle icon — inside text field, right edge */}
          <button
            type="button"
            aria-label="Toggle emoji picker"
            className={[
              'absolute right-2 bottom-1.5 flex items-center justify-center',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:rounded',
              disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
            ].join(' ')}
            disabled={disabled}
          >
            <Image
              src={iconEmoji}
              alt=""
              width={18}
              height={18}
              aria-hidden="true"
            />
          </button>
        </div>

        {/* Right side: Camera + Mic when empty, Send button when typing */}
        {hasText ? (
          /* Send button — 32×32px blue circle with white arrow */
          <button
            type="button"
            onClick={handleSend}
            disabled={disabled}
            aria-label="Send message"
            className={[
              'flex-shrink-0 w-[36px] h-[36px] flex items-center justify-center rounded-full',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
              'active:opacity-80 motion-safe:transition-opacity',
              disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
            ].join(' ')}
          >
            <SendIcon />
          </button>
        ) : (
          <>
            {/* Camera shortcut icon */}
            <button
              type="button"
              onClick={onCameraCapture}
              disabled={disabled}
              aria-label="Take photo"
              className={[
                'flex-shrink-0 w-[36px] h-[36px] flex items-center justify-center rounded-full',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
                'active:bg-gray-200 motion-safe:transition-colors',
                disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
              ].join(' ')}
            >
              <Image
                src={iconCameraInput}
                alt=""
                width={22}
                height={19}
                aria-hidden="true"
              />
            </button>

            {/* Microphone icon for voice recording */}
            <button
              type="button"
              onMouseDown={onStartVoiceNote}
              onMouseUp={onStopVoiceNote}
              onTouchStart={onStartVoiceNote}
              onTouchEnd={onStopVoiceNote}
              disabled={disabled}
              aria-label={isRecordingVoice ? 'Stop voice recording' : 'Record voice note'}
              className={[
                'flex-shrink-0 w-[36px] h-[36px] flex items-center justify-center rounded-full',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
                'active:bg-gray-200 motion-safe:transition-colors',
                isRecordingVoice ? 'bg-red-ios/10' : '',
                disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
              ].join(' ')}
            >
              <Image
                src={iconMicrophone}
                alt=""
                width={16}
                height={24}
                aria-hidden="true"
              />
            </button>
          </>
        )}
      </div>

      {/* Safe area padding for iOS home indicator */}
      <div className="h-[env(safe-area-inset-bottom,0px)]" aria-hidden="true" />
    </div>
  );
};

export default MessageInput;
