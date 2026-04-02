'use client';

import React from 'react';

/**
 * Possible delivery status values for a message.
 *
 * - `sending`: Message is being transmitted (opacity-reduced single check)
 * - `sent`: Message reached the server (single gray checkmark)
 * - `delivered`: Message delivered to recipient (double gray checkmarks)
 * - `read`: Recipient has read the message (double blue checkmarks)
 */
export type MessageDeliveryStatus = 'sending' | 'sent' | 'delivered' | 'read';

/**
 * Props for the MessageStatus component.
 */
export interface MessageStatusProps {
  /** Current delivery status of the message */
  status: MessageDeliveryStatus;
  /**
   * Optional additional CSS classes applied to the root SVG element.
   * Use to override dimensions for different contexts:
   * - Chat list default: 17×11px (double) / 12×11px (single)
   * - Message bubble: pass `className="w-[13.5px] h-[8px]"` for smaller variant
   */
  className?: string;
}

/**
 * Accessibility labels for each delivery status, used as aria-label on the SVG.
 */
const STATUS_ARIA_LABELS: Record<MessageDeliveryStatus, string> = {
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
};

/**
 * Single checkmark SVG path data.
 *
 * Extracted from Figma node 0:8882 (Path child within Read indicator group).
 * Figma file key: miK1B6qEPrUnRZ9wwZNrW2
 * Original dimensions: 11.37×10.09px within 12×11 viewBox.
 */
const SINGLE_CHECK_PATH =
  'M11.3433 0L12 0.656669L4.89391 10.6452L0 5.71118L1.09275 4.61843L4.89391 7.00604L11.3433 0Z';

/**
 * Double checkmark SVG path data (two sub-paths composing the overlapping checks).
 *
 * Extracted from Figma node 0:8881 (Shape / Boolean Operation within Read indicator group).
 * Figma file key: miK1B6qEPrUnRZ9wwZNrW2
 * Original dimensions: 16.84×10.23px within 17×11 viewBox.
 * Sub-path 1 (right check): 9.46×10.09px from node 0:8880
 * Sub-path 2 (left check): 11.37×10.09px from node 0:8882
 */
const DOUBLE_CHECK_PATH =
  'M16.3717 0.14064L17 0.768975L10.2005 10.3265L7.44431 7.5362L8.61153 5.89442L10.2005 6.84438L16.3717 0.14064ZM10.8539 0L11.4822 0.628334L4.68274 10.1858L0 5.46475L1.0456 4.41915L4.68274 6.70374L10.8539 0Z';

/**
 * MessageStatus — Displays message delivery checkmark indicators.
 *
 * Renders sent/delivered/read status as inline SVG checkmarks with dynamic
 * colors mapped to Tailwind design tokens via `fill="currentColor"`.
 *
 * **Consumers:**
 * - `ChatListItem` — 17×11px read receipt in message preview area
 * - `MessageBubble` — 13.5×8px indicator after timestamp at bottom-right
 *
 * **Figma References:**
 * - Node 0:8879 (Read indicator group) in WhatsApp Chats screen (0:8855)
 * - Node 0:8879 within WhatsApp Chat screen (0:8257) message bubbles
 * - File key: miK1B6qEPrUnRZ9wwZNrW2
 *
 * **Color Tokens (via Tailwind):**
 * - `text-read-blue` → #3497F9 (Figma fill_LTKHBX)
 * - `text-secondary` → #8E8E93 (Figma color-text-secondary)
 *
 * @example
 * ```tsx
 * // Chat list — read receipt at default 17×11px size
 * <MessageStatus status="read" />
 *
 * // Message bubble — delivered indicator at smaller 13.5×8px size
 * <MessageStatus status="delivered" className="w-[13.5px] h-[8px]" />
 *
 * // Sending state — single gray check at half opacity
 * <MessageStatus status="sending" />
 * ```
 */
const MessageStatus: React.FC<MessageStatusProps> = ({ status, className }) => {
  const isDoubleCheck = status === 'delivered' || status === 'read';
  const isSending = status === 'sending';

  /*
   * Tailwind text-color classes drive the SVG fill via `currentColor`.
   * Token mapping (from tailwind.config.ts):
   *   read-blue: #3497F9 — Figma fill_ABWHTQ / fill_V3CQ5B / fill_LTKHBX
   *   secondary: #8E8E93 — Figma color-text-secondary
   */
  const colorClass = status === 'read' ? 'text-read-blue' : 'text-secondary';

  const classes = [
    'inline-block',
    'shrink-0',
    colorClass,
    isSending ? 'opacity-50' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  if (isDoubleCheck) {
    /* Double checkmark: delivered (gray) or read (blue) — viewBox 0 0 17 11 */
    return (
      <svg
        width={17}
        height={11}
        viewBox="0 0 17 11"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label={STATUS_ARIA_LABELS[status]}
        className={classes}
      >
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d={DOUBLE_CHECK_PATH}
          fill="currentColor"
        />
      </svg>
    );
  }

  /* Single checkmark: sending (gray + opacity-50) or sent (gray) — viewBox 0 0 12 11 */
  return (
    <svg
      width={12}
      height={11}
      viewBox="0 0 12 11"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={STATUS_ARIA_LABELS[status]}
      className={classes}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={SINGLE_CHECK_PATH}
        fill="currentColor"
      />
    </svg>
  );
};

export default MessageStatus;
