'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import Image from 'next/image';
import AttachmentModal from '@/components/chat/AttachmentModal';
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
 * Figma layout specs (reconciled from structural data + rendered image):
 * - Container: full-width × auto (min ~80px), bg #F6F6F6 (bg-nav token)
 * - Top shadow: 0px -0.33px 0px rgba(166,166,170,1) (shadow-tab token)
 * - Add/Attach "+" icon: 19×19px, #007AFF, left side
 * - Text field: flex-1, 32px height, bg #FFFFFF, border 0.5px #8E8E93
 *   at 0.45 opacity, border-radius 16px, placeholder "Message" #8E8E93
 * - Emoji icon: 18×18px inside text field right edge, #007AFF
 * - Camera icon: 22×19px right of text field, #007AFF
 * - Mic icon: 16×24px rightmost, #007AFF
 *
 * Behavior:
 * - Typing text hides camera + mic icons, shows send button (blue circle)
 * - Enter sends message (Shift+Enter for newline)
 * - Textarea auto-grows up to 4 lines, then scrolls
 * - Mic button: tap-and-hold to record, release to stop
 * - Attach "+" button: opens AttachmentModal overlay
 * - When replyTo is provided, ReplyPreview appears above input
 *
 * Design tokens (from tailwind.config.ts):
 * - bg-nav (#F6F6F6), shadow-tab, blue-ios (#007AFF)
 * - text-secondary (#8E8E93), bg-white
 *
 * WCAG 2.1 AA (Rule R34):
 * - All buttons have aria-labels
 * - Focus-visible ring on all interactive elements
 * - Keyboard: Enter sends, Shift+Enter inserts newline
 * - All icons decorative (aria-hidden="true")
 * ========================================================================== */

/**
 * Props for the MessageInput component.
 *
 * Defines all callbacks for message composition, media attachment,
 * voice recording, and reply context management.
 */
export interface MessageInputProps {
  /** Callback when a text message is sent (trimmed, non-empty) */
  onSendMessage: (text: string) => void;
  /** Callback when a media file is selected via attachment or photo picker */
  onSendMedia: (file: File) => void;
  /** Callback when voice recording starts (mic press/hold) */
  onStartVoiceNote: () => void;
  /** Callback when voice recording stops (mic release) */
  onStopVoiceNote: () => void;
  /** Callback when camera shortcut button is tapped */
  onCameraCapture: () => void;
  /** Reply context — when set, ReplyPreview renders above input */
  replyTo?: {
    /** Display name of the original message sender */
    senderName: string;
    /** Preview text of the original message (decrypted) */
    content: string;
    /** Media type of original message if applicable */
    mediaType?: 'image' | 'video' | 'document' | 'voice';
  };
  /** Callback to cancel the reply (close ReplyPreview) */
  onCancelReply?: () => void;
  /** Whether the input is disabled (e.g., during encryption key exchange) */
  disabled?: boolean;
  /** Whether voice recording is currently active */
  isRecordingVoice?: boolean;
}

/**
 * Inline SVG send arrow icon displayed when text is being composed.
 * White upward arrow inside blue circle — 32×32px.
 * Matches WhatsApp send button visual pattern.
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

/** Maximum number of lines before the textarea stops growing and scrolls */
const MAX_LINES = 4;
/** Line height in px for calculating textarea max height */
const LINE_HEIGHT_PX = 20;
/** Vertical padding inside the textarea (top + bottom combined) */
const TEXTAREA_PADDING_PX = 12;
/** Accepted MIME types for photo/video library picker */
const PHOTO_VIDEO_ACCEPT = 'image/*,video/*';
/** Accepted MIME types for document file picker */
const DOCUMENT_ACCEPT = '*/*';

/**
 * MessageInput — Bottom message composer bar for chat conversations.
 *
 * Implements the Figma Screen 4 (WhatsApp Chat, 0:8257) input bar with:
 * - Attachment "+" button to open AttachmentModal (Figma Screen 5, 0:9072)
 * - Auto-growing textarea (up to 4 lines) with rounded border
 * - Emoji toggle icon inside the text field (right edge)
 * - Camera shortcut and microphone icons (hidden when typing)
 * - Send button (blue circle with white arrow, appears when text is non-empty)
 * - Reply preview bar above input when replying to a message
 * - Hidden file inputs for photo/document selection from AttachmentModal
 *
 * @example
 * ```tsx
 * <MessageInput
 *   onSendMessage={(text) => sendEncryptedMessage(text)}
 *   onSendMedia={(file) => uploadEncryptedMedia(file)}
 *   onStartVoiceNote={() => startRecording()}
 *   onStopVoiceNote={() => stopRecording()}
 *   onCameraCapture={() => openCamera()}
 *   replyTo={{ senderName: 'Martha', content: 'Hello!' }}
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
  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */
  const [text, setText] = useState('');
  const [showAttachmentModal, setShowAttachmentModal] = useState(false);

  /* ------------------------------------------------------------------ */
  /* Refs                                                                */
  /* ------------------------------------------------------------------ */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);

  /** Derived: whether the input has non-whitespace text */
  const hasText = text.trim().length > 0;

  /* ------------------------------------------------------------------ */
  /* Textarea auto-resize                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Auto-resize textarea height based on scrollHeight.
   * Grows from 1 line up to MAX_LINES, then enables overflow scroll.
   */
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    /* Reset to auto to get accurate scrollHeight measurement */
    textarea.style.height = 'auto';
    const maxHeight = LINE_HEIGHT_PX * MAX_LINES + TEXTAREA_PADDING_PX;
    const newHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${newHeight}px`;
  }, []);

  /** Re-adjust height whenever text content changes */
  useEffect(() => {
    adjustTextareaHeight();
  }, [text, adjustTextareaHeight]);

  /* ------------------------------------------------------------------ */
  /* Event handlers                                                      */
  /* ------------------------------------------------------------------ */

  /** Handle textarea input change — update state */
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
    },
    [],
  );

  /**
   * Send the composed text message.
   * Trims whitespace, calls parent callback, resets input and height.
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

  /**
   * Handle keyboard shortcuts:
   * - Enter (no modifier): send message
   * - Shift+Enter: insert newline (default textarea behavior)
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  /* ------------------------------------------------------------------ */
  /* AttachmentModal callbacks                                           */
  /* ------------------------------------------------------------------ */

  /** Open the AttachmentModal when "+" button is pressed */
  const handleOpenAttachment = useCallback(() => {
    if (disabled) return;
    setShowAttachmentModal(true);
  }, [disabled]);

  /** Close the AttachmentModal */
  const handleCloseAttachment = useCallback(() => {
    setShowAttachmentModal(false);
  }, []);

  /** AttachmentModal → Camera: close modal and trigger camera capture */
  const handleAttachCamera = useCallback(() => {
    setShowAttachmentModal(false);
    onCameraCapture();
  }, [onCameraCapture]);

  /** AttachmentModal → Photo & Video Library: close modal and open file picker */
  const handleAttachPhoto = useCallback(() => {
    setShowAttachmentModal(false);
    /* Trigger hidden file input for photo/video selection */
    requestAnimationFrame(() => {
      photoInputRef.current?.click();
    });
  }, []);

  /** AttachmentModal → Document: close modal and open document picker */
  const handleAttachDocument = useCallback(() => {
    setShowAttachmentModal(false);
    /* Trigger hidden file input for document selection */
    requestAnimationFrame(() => {
      documentInputRef.current?.click();
    });
  }, []);

  /** AttachmentModal → Location: close modal (location sharing placeholder) */
  const handleAttachLocation = useCallback(() => {
    setShowAttachmentModal(false);
    /* Location sharing — requires geolocation API integration */
  }, []);

  /** AttachmentModal → Contact: close modal (contact sharing placeholder) */
  const handleAttachContact = useCallback(() => {
    setShowAttachmentModal(false);
    /* Contact sharing — requires contacts API integration */
  }, []);

  /* ------------------------------------------------------------------ */
  /* File input handlers                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Handle file selection from hidden photo/video or document input.
   * Validates a file was selected, then calls onSendMedia.
   * Resets the input value to allow re-selecting the same file.
   */
  const handleFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        onSendMedia(file);
      }
      /* Reset input so the same file can be re-selected */
      e.target.value = '';
    },
    [onSendMedia],
  );

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */
  return (
    <div className="bg-nav shadow-tab">
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

      {/* Main input row — flex row with items aligned to bottom */}
      {/* Figma: ps=14px (icon at x=14), pe=16px, py=8px               */}
      <div className="flex items-end ps-3.5 pe-4 py-2">
        {/* ------------------------------------------------------------ */}
        {/* Attachment "+" button                                         */}
        {/* Figma: 19×19px icon at (14, 14), #007AFF                     */}
        {/* Touch target: 44×44px (WCAG 2.1 AA minimum)                  */}
        {/* ------------------------------------------------------------ */}
        <button
          type="button"
          onClick={handleOpenAttachment}
          disabled={disabled}
          aria-label="Add attachment"
          className={[
            'relative flex-shrink-0 flex items-center justify-center',
            'self-center rounded-full',
            /* Invisible 44px+ touch target via ::before pseudo-element */
            "before:content-[''] before:absolute before:-inset-[14px]",
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
            'motion-safe:transition-colors',
            disabled
              ? 'opacity-50 pointer-events-none'
              : 'cursor-pointer active:bg-black/5',
          ].join(' ')}
        >
          <Image
            src={iconAttachPlus}
            alt=""
            width={19}
            height={19}
            aria-hidden="true"
            style={{ height: 'auto' }}
          />
        </button>

        {/* ------------------------------------------------------------ */}
        {/* Text input field with emoji toggle icon                      */}
        {/* Figma: bg #FFFFFF, border 0.5px #8E8E93 @ 0.45 opacity,     */}
        {/* border-radius 16px, placeholder "Message" in #8E8E93         */}
        {/* ------------------------------------------------------------ */}
        {/* Figma: gap between + and input = 14px (47 - 33)           */}
        <div className="flex-1 relative flex items-end ms-3.5">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Message"
            disabled={disabled}
            rows={1}
            aria-label="Message input"
            aria-multiline="true"
            className={[
              'w-full resize-none rounded-2xl bg-white',
              'border-[0.5px] border-secondary/45',
              'ps-3 pe-9 py-1.5',
              'text-[16px] leading-[1.25] text-black',
              'placeholder:text-secondary',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
              disabled ? 'opacity-50 pointer-events-none' : '',
            ].join(' ')}
            style={{
              minHeight: `${LINE_HEIGHT_PX + TEXTAREA_PADDING_PX}px`,
              maxHeight: `${LINE_HEIGHT_PX * MAX_LINES + TEXTAREA_PADDING_PX}px`,
            }}
          />

          {/* Emoji toggle icon — inside text field, near right edge */}
          {/* Figma: 18×18px, #007AFF, positioned at right edge of input */}
          <button
            type="button"
            aria-label="Emoji and stickers"
            disabled={disabled}
            className={[
              'absolute end-2 bottom-1.5',
              'flex items-center justify-center',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:rounded',
              disabled
                ? 'opacity-50 pointer-events-none'
                : 'cursor-pointer',
            ].join(' ')}
          >
            <Image
              src={iconEmoji}
              alt=""
              width={18}
              height={19}
              aria-hidden="true"
              style={{ height: 'auto' }}
            />
          </button>
        </div>

        {/* ------------------------------------------------------------ */}
        {/* Right side: Send button (when typing) or Camera + Mic        */}
        {/* ------------------------------------------------------------ */}
        {hasText ? (
          /* Send button — 32×32px blue circle with white up-arrow   */
          /* Figma: gap = 20px matching camera position               */
          <button
            type="button"
            onClick={handleSend}
            disabled={disabled}
            aria-label="Send message"
            className={[
              'relative flex-shrink-0 flex items-center justify-center',
              'ms-5 self-center rounded-full',
              /* Invisible 44px touch target for 32px send circle */
              "before:content-[''] before:absolute before:-inset-[6px]",
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
              'motion-safe:transition-opacity',
              disabled
                ? 'opacity-50 pointer-events-none'
                : 'cursor-pointer active:opacity-80',
            ].join(' ')}
          >
            <SendIcon />
          </button>
        ) : (
          <>
            {/* Camera shortcut icon */}
            {/* Figma: 22×19px at x=295, gap from input = 20px     */}
            <button
              type="button"
              onClick={onCameraCapture}
              disabled={disabled}
              aria-label="Take photo"
              className={[
                'relative flex-shrink-0 flex items-center justify-center',
                'ms-5 self-center rounded-full',
                /* Invisible 44px+ touch target via ::before */
                "before:content-[''] before:absolute before:-inset-[14px]",
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
                'motion-safe:transition-colors',
                disabled
                  ? 'opacity-50 pointer-events-none'
                  : 'cursor-pointer active:bg-black/5',
              ].join(' ')}
            >
              <Image
                src={iconCameraInput}
                alt=""
                width={22}
                height={19}
                aria-hidden="true"
                style={{ height: 'auto' }}
              />
            </button>

            {/* Microphone / voice recording icon */}
            {/* Figma: 16×24px at x=341, gap from camera = 24px    */}
            {/* Behavior: press-and-hold to record, release to stop */}
            <button
              type="button"
              onMouseDown={onStartVoiceNote}
              onMouseUp={onStopVoiceNote}
              onTouchStart={onStartVoiceNote}
              onTouchEnd={onStopVoiceNote}
              disabled={disabled}
              aria-label={
                isRecordingVoice
                  ? 'Stop voice recording'
                  : 'Record voice message'
              }
              className={[
                'relative flex-shrink-0 flex items-center justify-center',
                'ms-6 self-center rounded-full',
                /* Invisible 44px touch target via ::before */
                "before:content-[''] before:absolute before:-inset-[14px]",
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
                'motion-safe:transition-colors',
                isRecordingVoice ? 'bg-red-ios/10' : '',
                disabled
                  ? 'opacity-50 pointer-events-none'
                  : 'cursor-pointer active:bg-black/5',
              ].join(' ')}
            >
              <Image
                src={iconMicrophone}
                alt=""
                width={16}
                height={24}
                aria-hidden="true"
                style={{ height: 'auto' }}
              />
            </button>
          </>
        )}
      </div>

      {/* iOS safe area padding for home indicator */}
      <div className="pb-safe" aria-hidden="true" />

      {/* ---------------------------------------------------------------- */}
      {/* Hidden file inputs for AttachmentModal media selection            */}
      {/* These inputs are visually hidden but programmatically triggered   */}
      {/* when the user selects Photo Library or Document in the modal.     */}
      {/* ---------------------------------------------------------------- */}
      <input
        ref={photoInputRef}
        type="file"
        accept={PHOTO_VIDEO_ACCEPT}
        onChange={handleFileSelected}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={DOCUMENT_ACCEPT}
        onChange={handleFileSelected}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* ---------------------------------------------------------------- */}
      {/* AttachmentModal — iOS-style action sheet (Figma Screen 5, 0:9072)*/}
      {/* Opened by the "+" attachment button. Each option either triggers  */}
      {/* a file input or a parent callback, then closes the modal.        */}
      {/* ---------------------------------------------------------------- */}
      <AttachmentModal
        isOpen={showAttachmentModal}
        onClose={handleCloseAttachment}
        onCamera={handleAttachCamera}
        onPhotoLibrary={handleAttachPhoto}
        onDocument={handleAttachDocument}
        onLocation={handleAttachLocation}
        onContact={handleAttachContact}
      />
    </div>
  );
};

export default MessageInput;
