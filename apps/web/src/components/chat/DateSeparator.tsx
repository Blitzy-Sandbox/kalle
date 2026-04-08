'use client';

import React from 'react';

/**
 * Props for the DateSeparator component.
 *
 * @property date — The formatted date string to display inside the pill
 *   (e.g. "Fri, Jul 26", "Today", "Yesterday").
 */
export interface DateSeparatorProps {
  /** Formatted date string displayed inside the separator pill */
  date: string;
}

/**
 * DateSeparator — A centered date pill that separates message groups by date
 * in the chat conversation view.
 *
 * Renders a horizontally-centered pill with the date text, matching the Figma
 * specification from node 0:8423 within WhatsApp Chat screen (0:8257),
 * file key miK1B6qEPrUnRZ9wwZNrW2.
 *
 * Design specs (reconciled from Figma):
 * - Pill background: #DDDDE9 (token: date-separator-bg)
 * - Text color: #3C3C43 (token: date-separator-text)
 * - Typography: SF Pro Text (font-sans), 600 weight, 12px, line-height 1.193em
 * - Border radius: 8px (rounded-lg)
 * - Dual shadow: 0px -0.4px 0px rgba(238,238,244,1),
 *               0px 0.4px 0px rgba(98,98,98,0.2)
 * - Vertical margin: 8px above and below
 *
 * Accessibility:
 * - role="separator" on the outer container
 * - aria-label with the date text for screen readers
 * - #3C3C43 on #DDDDE9 passes WCAG 2.1 AA 4.5:1 contrast requirement
 */
const DateSeparator: React.FC<DateSeparatorProps> = ({ date }) => {
  return (
    <div
      className="flex justify-center my-2"
      role="separator"
      aria-label={date}
    >
      <div
        className={[
          'bg-date-separator-bg',
          'rounded-lg',
          'px-5',
          'h-[21px]',
          'flex',
          'items-center',
          'shadow-[0px_-0.4px_0px_rgba(238,238,244,1),0px_0.4px_0px_rgba(98,98,98,0.2)]',
        ].join(' ')}
      >
        <span
          className={[
            'font-sans',
            'font-semibold',
            'text-xs',
            'leading-[1.193em]',
            'text-date-separator-text',
          ].join(' ')}
        >
          {date}
        </span>
      </div>
    </div>
  );
};

export default DateSeparator;
