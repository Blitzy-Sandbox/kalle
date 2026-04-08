'use client';

import React, { useCallback } from 'react';

/**
 * Props for the SegmentedControl component.
 *
 * Used on the Calls screen (Figma 0:10395) for "All | Missed" filtering.
 * Implements iOS HIG segmented control pattern with proper ARIA tablist semantics.
 */
export interface SegmentedControlProps {
  /** Array of exactly 2 segment labels */
  labels: [string, string];
  /** Index of currently active segment (0 or 1) */
  activeIndex: 0 | 1;
  /** Change handler receiving new active index */
  onChange: (index: 0 | 1) => void;
  /** Additional className for the outer container */
  className?: string;
}

/**
 * iOS-style two-segment tab control component.
 *
 * Figma Source: WhatsApp Calls screen (0:10395), Tabs group (0:10622).
 * - Container: 151×28px, borderRadius 8px, border 1px #007AFF at ~75.6% opacity
 * - Active segment: bg #007AFF, text white
 * - Inactive segment: transparent bg, text #007AFF
 * - Typography: SF Pro Text 500, 13px, lineHeight 1.193em, letterSpacing -1.1%
 *
 * Accessibility (WCAG 2.1 AA — Rule R34):
 * - role="tablist" on container, role="tab" on each segment
 * - aria-selected on active tab
 * - Arrow key navigation between segments
 * - Only active tab has tabIndex=0 (roving tabindex pattern)
 * - Visible :focus-visible ring for keyboard users
 */
export const SegmentedControl: React.FC<SegmentedControlProps> = ({
  labels,
  activeIndex,
  onChange,
  className = '',
}) => {
  /**
   * Keyboard handler implementing roving tabindex arrow key navigation.
   * ArrowLeft selects the first segment, ArrowRight selects the second.
   * Focus follows selection per WAI-ARIA Tabs pattern.
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && activeIndex === 1) {
        e.preventDefault();
        onChange(0);
      } else if (e.key === 'ArrowRight' && activeIndex === 0) {
        e.preventDefault();
        onChange(1);
      }
    },
    [activeIndex, onChange],
  );

  return (
    <div
      role="tablist"
      aria-label="Filter options"
      className={`inline-flex w-[151px] h-[28px] rounded-lg border border-blue-ios/[0.756] overflow-hidden ${className}`}
      onKeyDown={handleKeyDown}
    >
      {labels.map((label, index) => {
        const isActive = activeIndex === index;

        return (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(index as 0 | 1)}
            className={[
              'flex-1 text-[13px] font-medium leading-[1.193em] tracking-[-0.011em]',
              'text-center transition-colors duration-150 ease-in-out',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-inset',
              isActive
                ? 'bg-blue-ios text-white'
                : 'bg-transparent text-blue-ios',
            ].join(' ')}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
};

export default SegmentedControl;
