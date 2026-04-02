'use client';

import { useState, useEffect, useCallback } from 'react';

/**
 * Props for the NewMessagesIndicator component.
 *
 * @property count - Number of new unread messages while the user is scrolled up.
 * @property onClick - Callback invoked when the badge is activated (click or
 *   Enter/Space) to scroll the message list to the bottom.
 */
export interface NewMessagesIndicatorProps {
  /** Number of new unread messages */
  count: number;
  /** Scroll-to-bottom callback */
  onClick: () => void;
}

/**
 * Floating "new messages" badge that appears at the bottom-center of the chat
 * area when the user is scrolled up and new messages arrive. Clicking (or
 * pressing Enter / Space) scrolls to the latest message.
 *
 * **Visual specification** (no direct Figma node — behavioural component
 * styled using design tokens from WhatsApp Chat screen, Figma 0:8257):
 *
 * | Property       | Value                                       |
 * |----------------|---------------------------------------------|
 * | Background     | #007AFF  (blue-ios)                         |
 * | Text           | #FFFFFF  (white)                             |
 * | Shadow         | 0 2px 8px rgba(0,0,0,0.15)                  |
 * | Font           | SF Pro Text · 500 · 13px · 1.23em           |
 * | Height         | 32px                                        |
 * | Min-width      | 120px                                       |
 * | Border-radius  | 16px  (full pill via rounded-full)           |
 * | z-index        | 10                                          |
 * | Animation      | slide-up / slide-down + opacity, 200ms ease-out |
 *
 * **Accessibility**: `role="button"`, `tabIndex={0}`, dynamic `aria-label`,
 * keyboard activation (Enter / Space), `focus-visible` ring.
 */
const NewMessagesIndicator: React.FC<NewMessagesIndicatorProps> = ({
  count,
  onClick,
}) => {
  /* ─────────────────────────────────────────────────────────────
   * Animation state machine
   * ─────────────────────────────────────────────────────────────
   * visible  — controls whether the DOM node is rendered.
   * animateIn — controls the CSS transition state:
   *   false → translateY(8px) + opacity(0)   (hidden / exiting)
   *   true  → translateY(0)   + opacity(1)   (visible / entering)
   *
   * Flow on count change:
   *   count > 0 → setVisible(true) → next frame → setAnimateIn(true)
   *   count === 0 → setAnimateIn(false) → after 200ms → setVisible(false)
   * ───────────────────────────────────────────────────────────── */
  const [visible, setVisible] = useState<boolean>(false);
  const [animateIn, setAnimateIn] = useState<boolean>(false);

  useEffect(() => {
    let rafId: number | undefined;
    let timerId: ReturnType<typeof setTimeout> | undefined;

    if (count > 0) {
      /* Show the element in its off-screen position, then trigger the
         entrance transition on the next animation frame so the browser
         paints the initial (hidden) state first. */
      setVisible(true);
      rafId = requestAnimationFrame(() => {
        setAnimateIn(true);
      });
    } else {
      /* Begin the exit transition immediately, then remove the DOM node
         once the 200ms transition has finished. */
      setAnimateIn(false);
      timerId = setTimeout(() => {
        setVisible(false);
      }, 200);
    }

    return () => {
      if (rafId !== undefined) {
        cancelAnimationFrame(rafId);
      }
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    };
  }, [count]);

  /** Memoised click handler forwarding to the parent scroll callback. */
  const handleClick = useCallback((): void => {
    onClick();
  }, [onClick]);

  /**
   * Memoised keyboard handler supporting Enter and Space activation
   * per WAI-ARIA button pattern.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onClick();
      }
    },
    [onClick],
  );

  /* Nothing to render when the badge is fully dismissed. */
  if (!visible) {
    return null;
  }

  /* Pluralise the visible label. */
  const messageText =
    count === 1 ? '1 new message' : `${count} new messages`;

  return (
    /*
     * Positioning wrapper — absolutely centred at the bottom of the chat
     * scroll area, 16px (bottom-4) above the message input bar.
     * pointer-events-none ensures the transparent wrapper does not block
     * interaction with messages beneath it.
     */
    <div
      className="absolute inset-x-0 bottom-4 z-10 flex justify-center pointer-events-none"
    >
      {/*
       * The pill itself restores pointer-events so it remains clickable.
       *
       * BLITZY [DESIGN_SYSTEM_GAP]: Shadow 0px 2px 8px rgba(0,0,0,0.15)
       * is not present in the Tailwind boxShadow presets. Using an
       * arbitrary-value class. Nearest system shadow is shadow-card
       * (0px 0.33px 0px rgba(60,60,67,0.29)) which is visually different.
       */}
      <div
        role="button"
        tabIndex={0}
        aria-label={`Scroll to ${count} new ${count === 1 ? 'message' : 'messages'}`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={[
          /* Re-enable interaction on the pill */
          'pointer-events-auto',
          /* Layout */
          'inline-flex items-center justify-center',
          'min-w-[120px] h-8 px-4',
          /* Colours — blue-ios bg, white text */
          'bg-blue-ios text-white',
          /* Shape — full pill (border-radius ≥ half height) */
          'rounded-full',
          /* Typography — SF Pro Text (font-sans), medium 500, 13px */
          'font-sans font-medium text-[13px] leading-[1.23em]',
          /* Elevation — subtle drop shadow for float affordance */
          'shadow-[0px_2px_8px_rgba(0,0,0,0.15)]',
          /* Interaction affordance */
          'cursor-pointer select-none',
          /* Transition — gated behind prefers-reduced-motion */
          'motion-safe:transition-[transform,opacity]',
          'motion-safe:duration-200',
          'motion-safe:ease-out',
          'motion-reduce:transition-none',
          /* Focus ring for keyboard users (focus-visible only) */
          'focus-visible:outline-none',
          'focus-visible:ring-2',
          'focus-visible:ring-blue-ios',
          'focus-visible:ring-offset-2',
          /* Slide-up (in) / slide-down (out) animation state */
          animateIn
            ? 'translate-y-0 opacity-100'
            : 'translate-y-2 opacity-0',
        ].join(' ')}
      >
        <span>{messageText}</span>
        {/* Decorative down-arrow chevron — hidden from assistive tech */}
        <span className="ms-1" aria-hidden="true">
          ↓
        </span>
      </div>
    </div>
  );
};

export default NewMessagesIndicator;
