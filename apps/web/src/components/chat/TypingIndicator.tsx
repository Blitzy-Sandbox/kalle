'use client';

import { type FC } from 'react';
import Avatar from '@/components/common/Avatar';

/* ============================================================
 * TypingIndicator — Animated three-dot typing indicator
 *
 * Displays a received-message-style bubble with three bouncing dots
 * when another user is actively typing in a conversation. Consistent
 * with the received message bubble pattern from WhatsApp Chat screen
 * (Figma node 0:8257, file key miK1B6qEPrUnRZ9wwZNrW2).
 *
 * Design tokens:
 * - Bubble background: #FAFAFA (Figma fill_VTU3AE)
 * - Dot color: #8E8E93 (color-text-secondary)
 * - Bubble border-radius: 8px (rounded-lg)
 * - Bubble shadow: 1px 1px 1.63px rgba(0,0,0,0.4) — received message shadow
 * - Left padding: 16px (ps-4) — matches received message indentation
 * ============================================================ */

/**
 * Props for the TypingIndicator component.
 *
 * Both props are optional. When rendered without props, the indicator
 * shows a generic "Someone is typing" accessible announcement.
 * Providing `avatarSrc` renders a 36px circular avatar to the left
 * of the bubble, useful for identifying the typing user in group chats.
 */
export interface TypingIndicatorProps {
  /**
   * Display name of the user who is currently typing.
   * Used exclusively for the accessible `aria-label` announcement:
   * - When provided: "{userName} is typing"
   * - When omitted: "Someone is typing"
   */
  userName?: string;

  /**
   * Optional avatar image URL for the typing user.
   * When provided, renders a 36px (size="sm") circular Avatar
   * component to the left of the typing bubble, helping identify
   * who is typing in group conversations.
   */
  avatarSrc?: string;
}

/**
 * Animated typing indicator component.
 *
 * Shows three bouncing dots inside a left-aligned bubble that matches
 * the received message visual pattern. The dots animate sequentially
 * with a 150ms stagger between each, creating a fluid "wave" effect.
 *
 * Accessibility:
 * - `role="status"` + `aria-live="polite"` announces typing to screen readers
 * - Dots hidden from assistive technology via `aria-hidden="true"`
 * - Respects `prefers-reduced-motion` — disables animation for users who prefer it
 *
 * @example
 * ```tsx
 * // Basic usage — anonymous typing
 * <TypingIndicator />
 *
 * // Named user typing (screen reader says "Martha Craig is typing")
 * <TypingIndicator userName="Martha Craig" />
 *
 * // With avatar for group chat context
 * <TypingIndicator
 *   userName="Martha Craig"
 *   avatarSrc="/avatars/martha.jpg"
 * />
 * ```
 */
const TypingIndicator: FC<TypingIndicatorProps> = ({ userName, avatarSrc }) => {
  /* Construct the accessible label based on whether a user name is provided */
  const ariaLabel = userName ? `${userName} is typing` : 'Someone is typing';

  return (
    <>
      {/*
        Component-scoped keyframe animation for the bouncing dots.
        Uses :nth-child selectors for staggered animation-delay (0s, 0.15s, 0.3s).
        prefers-reduced-motion media query disables animation entirely — dots
        render at static 0.8 opacity instead.
      */}
      <style>{`
        @keyframes typingBounce {
          0%, 60%, 100% {
            transform: translateY(0);
            opacity: 0.6;
          }
          30% {
            transform: translateY(-4px);
            opacity: 1;
          }
        }

        .typing-indicator-dot {
          animation: typingBounce 1.4s ease-in-out infinite;
        }

        .typing-indicator-dot:nth-child(2) {
          animation-delay: 0.15s;
        }

        .typing-indicator-dot:nth-child(3) {
          animation-delay: 0.3s;
        }

        @media (prefers-reduced-motion: reduce) {
          .typing-indicator-dot {
            animation: none;
            opacity: 0.8;
          }
        }
      `}</style>

      {/* Outer container — left-aligned row with optional avatar + bubble */}
      <div
        role="status"
        aria-live="polite"
        aria-label={ariaLabel}
        className="flex items-end gap-2 ps-4"
      >
        {/* Optional avatar — renders only when avatarSrc is provided */}
        {avatarSrc != null && avatarSrc.length > 0 && (
          <Avatar
            src={avatarSrc}
            alt={userName || 'User'}
            size="sm"
          />
        )}

        {/*
          Typing bubble — styled as a received message bubble.
          - bg-[#FAFAFA]: Figma fill_VTU3AE received message color
            BLITZY [COLOR]: Figma #FAFAFA not in system tokens. Used arbitrary value.
          - rounded-lg: 8px border-radius
          - px-2 py-[10px]: 8px horizontal, 10px vertical padding
          - Box shadow via inline style for the precise Figma blur value (1.63px)
        */}
        <div
          className="inline-flex items-center gap-1 rounded-lg bg-[#FAFAFA] px-2 py-[10px]"
          style={{
            boxShadow: '1px 1px 1.63px rgba(0, 0, 0, 0.4)',
          }}
          aria-hidden="true"
        >
          {/* Three animated dots — each 8px (w-2 h-2) circles in secondary color */}
          <span
            className="typing-indicator-dot inline-block h-2 w-2 rounded-full bg-secondary"
          />
          <span
            className="typing-indicator-dot inline-block h-2 w-2 rounded-full bg-secondary"
          />
          <span
            className="typing-indicator-dot inline-block h-2 w-2 rounded-full bg-secondary"
          />
        </div>
      </div>
    </>
  );
};

export default TypingIndicator;
