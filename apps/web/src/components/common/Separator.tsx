'use client';

import React from 'react';

/**
 * Props for the Separator component.
 *
 * @property inset - Whether to indent from the left edge (for list rows with avatars).
 *   Default is false, which renders a full-width separator.
 * @property insetLeft - Custom left inset in pixels when `inset` is true.
 *   Defaults to 79px, matching Figma chat list separators
 *   (16px row padding + 52px avatar + 11px gap).
 *   Use 68px for calls list (16px + 40px + 12px).
 *   Use 59px for settings rows (matching settings separator alignment).
 * @property className - Additional CSS class overrides. Useful for changing the
 *   separator color (e.g., `bg-[#C6C6C8]` for action sheet separators).
 */
export interface SeparatorProps {
  /** Whether to indent from left (for list rows with avatars). Default false = full-width */
  inset?: boolean;
  /** Custom left inset in pixels. Defaults to 79px for chat lists */
  insetLeft?: number;
  /** Additional className overrides */
  className?: string;
}

/**
 * Thin line separator component following iOS Human Interface Guidelines.
 *
 * Renders a 0.33px horizontal line using the Tailwind `separator` color token
 * (`rgba(60, 60, 67, 0.29)`). Used extensively across chat lists, settings screens,
 * calls lists, and action sheets to visually divide rows and sections.
 *
 * Figma Source (file `miK1B6qEPrUnRZ9wwZNrW2`):
 * - Chat list separators (0:8855): 0.33px, rgba(60,60,67,0.29), x=79
 * - Calls list separators (0:10395): 0.33px, rgba(60,60,67,0.29), x=68
 * - Action sheet separators (0:10087): 0.33px, #C6C6C8, full width
 * - Settings separators: full-width gray dividers
 *
 * Uses a `<div>` with `h-[0.33px]` rather than `<hr>` for precise sub-pixel
 * rendering control. Browser default `<hr>` styles interfere with 0.33px fidelity.
 *
 * @example
 * ```tsx
 * // Full-width separator (settings section divider)
 * <Separator />
 *
 * // Indented separator for chat list (79px default inset)
 * <Separator inset />
 *
 * // Custom inset for calls list (68px)
 * <Separator inset insetLeft={68} />
 *
 * // Action sheet separator with different color
 * <Separator className="bg-[#C6C6C8]" />
 * ```
 */
export const Separator: React.FC<SeparatorProps> = ({
  inset = false,
  insetLeft = 79,
  className = '',
}) => {
  /* When the consumer supplies a background-color override via className
     (e.g., `bg-[#C6C6C8]` for action-sheet separators), we must omit the
     default `bg-separator` utility.  Tailwind CSS does NOT resolve
     specificity by HTML class-attribute order — both utilities compile to
     the same CSS property and the one generated later in the stylesheet
     wins.  Detecting a `bg-` prefix lets us yield to the override
     without requiring `!important` or tailwind-merge.  */
  const hasBackgroundOverride = className.includes('bg-');
  const colorClass = hasBackgroundOverride ? '' : 'bg-separator';

  return (
    <div
      className={['h-[0.33px]', colorClass, className].filter(Boolean).join(' ')}
      style={inset ? { marginInlineStart: `${insetLeft}px` } : undefined}
      role="separator"
      aria-orientation="horizontal"
    />
  );
};

export default Separator;
