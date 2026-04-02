'use client';

import React, { useCallback } from 'react';

/**
 * Props interface for the iOS-style Toggle switch component.
 *
 * Follows iOS HIG toggle dimensions (51×31px) and behavior.
 * Used in settings screens: Notifications, Chats Settings, Data & Storage Usage.
 */
export interface ToggleProps {
  /** Current toggle state — true = ON (green), false = OFF (gray) */
  value: boolean;
  /** Callback invoked with the new toggle state when toggled */
  onChange: (value: boolean) => void;
  /** When true, the toggle is non-interactive and visually dimmed */
  disabled?: boolean;
  /** Accessible label for screen readers (WCAG 2.1 AA compliance — R34) */
  ariaLabel?: string;
  /** Additional CSS class names for the outer button element */
  className?: string;
}

/**
 * iOS-style toggle switch component.
 *
 * Renders an accessible `<button>` with `role="switch"` and `aria-checked`
 * for proper screen-reader announcement. Visual appearance matches the
 * exact iOS toggle specification from Figma file miK1B6qEPrUnRZ9wwZNrW2:
 *
 * - Track: 51×31px, fully rounded (border-radius: 15.5px)
 *   - ON: #4CD964 (toggle-green)
 *   - OFF: #E5E5EA (standard iOS gray)
 * - Thumb: 27×27px white circle with iOS native shadow
 *   - OFF position: translateX(2px)
 *   - ON position: translateX(22px)
 * - Transition: 200ms ease-in-out for both track color and thumb position
 *
 * @example
 * ```tsx
 * const [enabled, setEnabled] = useState(false);
 * <Toggle value={enabled} onChange={setEnabled} ariaLabel="Enable notifications" />
 * ```
 */
export const Toggle: React.FC<ToggleProps> = ({
  value,
  onChange,
  disabled = false,
  ariaLabel,
  className = '',
}) => {
  /**
   * Memoized click handler that inverts the current value.
   * The disabled check is a safety guard — the native `disabled` attribute
   * on the <button> already prevents click events, but this ensures
   * programmatic calls also respect the disabled state.
   */
  const handleClick = useCallback(() => {
    if (!disabled) {
      onChange(!value);
    }
  }, [value, onChange, disabled]);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={handleClick}
      className={[
        /* Base layout: fixed iOS toggle dimensions, flex-shrink-0 prevents compression in flex parents */
        'relative inline-flex flex-shrink-0',
        'w-[51px] h-[31px]',
        /* Fully rounded track (border-radius = height / 2 = 15.5px) */
        'rounded-full',
        /* Smooth 200ms transition on track background color */
        'transition-colors duration-200 ease-in-out',
        /* Remove default button outline; show focus ring only on keyboard navigation (WCAG R34) */
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-2',
        /* BLITZY [COLOR]: Figma ON color #34C759 snapped to system toggle-green (#4CD964). */
        /* Track background color: ON = green, OFF = standard iOS gray */
        value ? 'bg-toggle-green' : 'bg-[#E5E5EA]',
        /* Disabled state: reduced opacity + not-allowed cursor */
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        /* Allow consumer className overrides */
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/*
       * Thumb circle — 27×27px white circle with iOS native two-layer shadow.
       * pointer-events-none ensures clicks always hit the parent <button>.
       * The translateX values position the thumb at:
       *   - OFF: 2px from left edge
       *   - ON:  22px from left edge (51 - 27 - 2 = 22)
       * mt-[2px] vertically centers the 27px thumb within the 31px track.
       */}
      <span
        aria-hidden="true"
        className={[
          'pointer-events-none inline-block',
          'w-[27px] h-[27px]',
          'rounded-full bg-white',
          /* iOS native toggle shadow — two-layer composite per Figma nodes 0:10763, 0:9985 */
          'shadow-[0px_3px_1px_0px_rgba(0,0,0,0.1),0px_3px_8px_0px_rgba(0,0,0,0.2)]',
          /* Smooth 200ms transition on thumb position */
          'transform transition-transform duration-200 ease-in-out',
          /* Horizontal position based on toggle state */
          value ? 'translate-x-[22px]' : 'translate-x-[2px]',
          /* Vertical centering: (31 - 27) / 2 = 2px top margin */
          'mt-[2px]',
        ].join(' ')}
      />
    </button>
  );
};

export default Toggle;
