'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { StatusBar } from '@/components/common/StatusBar';
import { useStoryStore } from '@/stores/storyStore';
import iconCloseX from '@/assets/icons/icon-close-x.svg';
import iconTextT from '@/assets/icons/icon-text-T.svg';
import iconPalette from '@/assets/icons/icon-palette.svg';

/* ==========================================================================
 * StatusComposer — Text Status Creation Screen
 *
 * Maps to Figma Screen 10 (WhatsApp Status View, node 0:9634),
 * file key miK1B6qEPrUnRZ9wwZNrW2.
 *
 * Figma layout specs:
 * - Frame: 375×812px, default bg #FF8A8C (coral/salmon pink), DYNAMIC bg
 * - StatusBar (dark variant, white icons)
 * - Top Actions Bar at (19, 60.5):
 *   - Close X (left): 19×19px white
 *   - "T" text icon (right): 19×23px white
 *   - Palette icon (right): 24×24px white, ~30px gap from T
 * - Text Input: centered, placeholder "Type a status",
 *   Helvetica Neue 500 38px, line-height 1.21em,
 *   placeholder rgba(255,255,255,0.4), text #FFFFFF
 * - Bottom: on-screen keyboard (system-provided)
 *
 * Design tokens used:
 * - Dynamic bg from STATUS_COLORS palette
 * - White text/icons on colored background
 *
 * Stories are NOT encrypted per R12.
 * ========================================================================== */

/**
 * Available background colors for text statuses.
 * First color is the default coral pink matching Figma Screen 10.
 */
const STATUS_COLORS: readonly string[] = [
  '#FF8A8C', // Coral/salmon pink (Figma default)
  '#4CD964', // Green
  '#007AFF', // iOS blue
  '#FF9500', // Orange
  '#5856D6', // Purple
  '#FF2D55', // Hot pink
  '#00BCD4', // Teal
  '#FFCC00', // Yellow
  '#8E8E93', // Gray
  '#000000', // Black
] as const;

/**
 * Human-readable color names for accessibility announcements.
 * Maps 1:1 with STATUS_COLORS indices.
 */
const COLOR_NAMES: readonly string[] = [
  'Coral pink',
  'Green',
  'Blue',
  'Orange',
  'Purple',
  'Hot pink',
  'Teal',
  'Yellow',
  'Gray',
  'Black',
] as const;

/**
 * Props for the StatusComposer component.
 *
 * @see Figma Screen 10 (node 0:9634) — Full-screen colored text status creator
 */
export interface StatusComposerProps {
  /** Callback to close the composer without posting */
  onClose: () => void;
  /** Callback when the user posts a status (text content, background color hex) */
  onPost?: (content: string, backgroundColor: string) => void;
  /** Initial background color hex (defaults to first STATUS_COLORS entry: #FF8A8C) */
  initialColor?: string;
  /** Additional CSS class names for the root container */
  className?: string;
}

/**
 * StatusComposer — Full-screen text status creation screen.
 *
 * Allows users to compose text-based status updates with customizable
 * background colors. The component presents a full-screen colored canvas
 * with a centered text input and color palette cycling.
 *
 * Behavior:
 * - Palette icon cycles through STATUS_COLORS on each click
 * - "T" icon toggles font style between regular and serif
 * - Text input auto-focuses on mount
 * - Enter (mobile keyboard "Go") submits the status (if non-empty)
 * - Close X or Escape key dismisses without posting
 * - Empty text submission is prevented
 * - Loading state shown while posting via store
 *
 * WCAG 2.1 AA compliant (R34):
 * - role="dialog" with aria-modal="true"
 * - Focus trapped within the composer
 * - All interactive elements labeled with aria-label
 * - Color changes announced via aria-live region
 * - Escape to dismiss
 *
 * @example
 * ```tsx
 * <StatusComposer
 *   onClose={() => router.back()}
 *   onPost={(text, color) => handleStatusCreated(text, color)}
 *   initialColor="#007AFF"
 * />
 * ```
 */
const StatusComposer: React.FC<StatusComposerProps> = ({
  onClose,
  onPost,
  initialColor,
  className = '',
}) => {
  /* -------------------------------------------------------------------
   * Store — story state management
   * ----------------------------------------------------------------- */
  const addStory = useStoryStore((state) => state.addStory);

  /* -------------------------------------------------------------------
   * State
   * ----------------------------------------------------------------- */
  const resolvedInitialIndex = initialColor
    ? STATUS_COLORS.indexOf(initialColor)
    : 0;

  const [colorIndex, setColorIndex] = useState<number>(
    resolvedInitialIndex >= 0 ? resolvedInitialIndex : 0,
  );
  const [text, setText] = useState<string>('');
  const [isPosting, setIsPosting] = useState<boolean>(false);
  const [fontStyleToggle, setFontStyleToggle] = useState<boolean>(false);

  /** Derive current background color from index */
  const bgColor = STATUS_COLORS[colorIndex];

  /* Refs */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  /* -------------------------------------------------------------------
   * Effects
   * ----------------------------------------------------------------- */

  /** Auto-focus the textarea on mount */
  useEffect(() => {
    const timer = setTimeout(() => {
      textareaRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  /** Focus trap and Escape key handling */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      /* Focus trap: Tab cycles within the composer */
      if (e.key === 'Tab' && composerRef.current) {
        const focusable = composerRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  /* -------------------------------------------------------------------
   * Handlers
   * ----------------------------------------------------------------- */

  /** Cycle to next background color */
  const handleCycleColor = useCallback(() => {
    setColorIndex((current) => (current + 1) % STATUS_COLORS.length);
  }, []);

  /** Toggle font style (regular sans-serif vs serif) */
  const handleToggleFont = useCallback(() => {
    setFontStyleToggle((prev) => !prev);
  }, []);

  /** Submit the status (non-empty text required) */
  const handlePost = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || isPosting) return;

    setIsPosting(true);

    /* Create an optimistic story entry for local state update via store */
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    addStory({
      id: `temp-${now.getTime()}`,
      authorId: '',
      authorName: '',
      type: 'TEXT' as never,
      content: trimmed,
      backgroundColor: bgColor,
      fontStyle: fontStyleToggle ? 'serif' : undefined,
      duration: 5,
      viewCount: 0,
      expiresAt: expiresAt.toISOString(),
      isExpired: false,
      createdAt: now.toISOString(),
    });

    /* Notify parent handler for API persistence */
    onPost?.(trimmed, bgColor);

    /* Close the composer */
    onClose();
  }, [text, bgColor, isPosting, fontStyleToggle, addStory, onPost, onClose]);

  /** Handle keydown on the textarea — Enter submits, Shift+Enter newline */
  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handlePost();
      }
    },
    [handlePost],
  );

  /** Current color label for accessibility announcements */
  const colorLabel = COLOR_NAMES[colorIndex] ?? `Color ${colorIndex + 1}`;
  const colorAnnouncement = `${colorLabel}, ${colorIndex + 1} of ${STATUS_COLORS.length}`;

  /** Dynamic font family based on toggle state */
  const fontFamily = fontStyleToggle
    ? "'Georgia', 'Times New Roman', serif"
    : "'Helvetica Neue', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";

  return (
    /* Outer positioning layer — full-screen on mobile, centered backdrop on desktop */
    <div
      className={[
        'fixed inset-0 z-50',
        'md:flex md:items-center md:justify-center md:bg-black/50',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        ref={composerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Create text status"
        className={[
          'w-full h-full flex flex-col',
          'md:max-w-[420px] md:h-[calc(100vh-4rem)]',
          'md:rounded-2xl md:overflow-hidden',
          'motion-safe:transition-colors motion-safe:duration-300',
        ].join(' ')}
        style={{ backgroundColor: bgColor }}
      >
      {/* ============================================================
       * iOS Status Bar — dark variant for colored background
       * BLITZY [COLOR]: StatusBar dark variant uses bg-black.
       * On this screen, ideally transparent over the colored bg.
       * ============================================================ */}
      <StatusBar dark className="!bg-transparent" />

      {/* ============================================================
       * Top Action Bar
       * Figma: 338×24px at (19, 60.5) — below status bar + 16px gap
       * Close X (left), "T" text icon + Palette icon (right)
       * ============================================================ */}
      <div className="flex items-center justify-between px-[19px] pt-[16px]">
        {/* Close button — 19×19px white X icon */}
        <button
          type="button"
          onClick={onClose}
          disabled={isPosting}
          aria-label="Close status composer"
          className={[
            'flex items-center justify-center',
            'min-h-[44px] min-w-[44px]',
            'rounded-full',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-white',
            'active:bg-white/20 motion-safe:transition-colors',
          ].join(' ')}
        >
          <Image
            src={iconCloseX}
            alt=""
            width={19}
            height={19}
            className="brightness-0 invert"
            aria-hidden="true"
          />
        </button>

        {/* Right action group — T icon and Palette icon
           * Figma visual gap between icon edges: 29.5px
           * 44px touch targets add (44-19)/2=12.5px + (44-24)/2=10px = 22.5px
           * CSS gap needed: 29.5 - 22.5 ≈ 7px to match Figma visual gap */}
        <div className="flex items-center gap-[7px]">
          {/* "T" text formatting toggle */}
          <button
            type="button"
            onClick={handleToggleFont}
            aria-label={`Change text font. Currently ${fontStyleToggle ? 'serif' : 'sans-serif'}`}
            aria-pressed={fontStyleToggle}
            className={[
              'flex items-center justify-center',
              'min-h-[44px] min-w-[44px]',
              'rounded-full',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-white',
              'active:bg-white/20 motion-safe:transition-colors',
            ].join(' ')}
          >
            <Image
              src={iconTextT}
              alt=""
              width={19}
              height={23}
              className="brightness-0 invert"
              aria-hidden="true"
            />
          </button>

          {/* Palette icon — cycle background color */}
          <button
            type="button"
            onClick={handleCycleColor}
            aria-label={`Change background color. Currently ${colorAnnouncement}`}
            className={[
              'flex items-center justify-center',
              'min-h-[44px] min-w-[44px]',
              'rounded-full',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-white',
              'active:bg-white/20 motion-safe:transition-colors',
            ].join(' ')}
          >
            <Image
              src={iconPalette}
              alt=""
              width={24}
              height={24}
              className="brightness-0 invert"
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      {/* Accessible live region for color change announcements */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {`Background color: ${colorLabel}`}
      </div>

      {/* ============================================================
       * Text Input Area — centered on the screen
       * Figma: Helvetica Neue 500 38px, line-height 1.21em,
       * letter-spacing -0.26%, placeholder rgba(255,255,255,0.4),
       * text #FFFFFF, bg transparent
       * Position: centered in remaining vertical space (flex-1)
       * ============================================================ */}
      <div className="flex-1 flex items-center justify-center px-[50px]">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleTextareaKeyDown}
          placeholder="Type a status"
          aria-label="Status text"
          aria-placeholder="Type a status"
          disabled={isPosting}
          maxLength={700}
          rows={1}
          className={[
            'w-full text-center resize-none',
            'bg-transparent border-none outline-none',
            'font-medium text-[38px] leading-[1.21em] tracking-[-0.003em]',
            'text-white placeholder:text-white/40',
            'caret-white',
            'min-h-[48px] max-h-[400px]',
            isPosting ? 'opacity-50' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ fontFamily }}
        />
      </div>

      {/* ============================================================
       * Bottom Area — submit hint + safe area
       * On mobile, the native keyboard appears here.
       * On desktop, show a submit button when text is non-empty.
       * ============================================================ */}
      <div className="px-5 pb-6 pt-2">
        {text.trim().length > 0 && (
          <button
            type="button"
            onClick={handlePost}
            disabled={isPosting}
            aria-label={isPosting ? 'Posting status...' : 'Post status'}
            className={[
              'w-full py-3 rounded-full',
              'bg-white/20 text-white font-semibold text-[17px] leading-[1.29em]',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-white',
              'active:bg-white/30 motion-safe:transition-colors',
              isPosting ? 'opacity-60 cursor-not-allowed' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {isPosting ? 'Posting…' : 'Post Status'}
          </button>
        )}
      </div>

      {/* Safe area inset for devices with home indicators */}
      <div
        className="pb-[env(safe-area-inset-bottom,0px)]"
        aria-hidden="true"
      />
      </div>
    </div>
  );
};

export default StatusComposer;
