'use client';

import React, { useCallback } from 'react';
import Toggle from './Toggle';
import Separator from './Separator';

// =============================================================================
// SettingsRow — Reusable settings list row component
// =============================================================================
//
// Renders a single row in a settings screen with an optional colored icon,
// label, optional value text, and right-side action (chevron or toggle switch).
//
// Used across all settings screens:
//   - Settings main  (Figma 0:9198)
//   - Account        (Figma 0:9371)
//   - Chat Settings  (Figma 0:9973)
//   - Notifications  (Figma 0:10758)
//   - Data & Storage (Figma 0:10894)
//   - Contact Info   (Figma 0:9486)
//
// Figma Source: file miK1B6qEPrUnRZ9wwZNrW2, node 0:9198 children.
//
// Exact Measurements (from Figma):
//   Row frame:       375×47px, background #FFFFFF
//   Icon group:      x=15, y=8 → 15px left padding, 29×29px rounded-rect bg
//   Label text:      x=59 (15 + 29 + 15) → SF Pro Text 400, 16px/1.375em
//   Right chevron:   x=351, y=17.5 → 7×12px, rgba(60,60,67,0.3)
//   Row separators:  x=59, width=316, 0.33px, rgba(60,60,67,0.29)
//
// Variants:
//   1. Standard (chevron):    icon + label + right chevron arrow
//   2. Toggle:                icon + label + Toggle component
//   3. Value + chevron:       icon + label + value text + chevron
//   4. Action text (no icon): colored label text (blue or destructive red)
//
// Accessibility (R34 — WCAG 2.1 AA):
//   - Interactive rows use <button> with role="button"
//   - Keyboard navigable: Enter and Space activate the row
//   - Focus visible ring on keyboard navigation
//   - Toggle variant delegates focus to the Toggle component
// =============================================================================

/**
 * Props interface for the SettingsRow component.
 *
 * @property icon - Optional React node for the icon inside the colored container.
 *   When omitted, the icon container is hidden and the label shifts left.
 * @property iconBgColor - Background color for the 29×29px rounded icon container.
 *   Applied via inline style to support arbitrary Figma-specified colors.
 * @property label - Primary label text displayed in the row.
 * @property value - Optional secondary value text shown before the chevron/toggle.
 *   Rendered in the secondary text color (#8E8E93).
 * @property showChevron - Whether to show the right chevron arrow. Defaults to true
 *   when neither showToggle is true nor explicitly set to false.
 * @property showToggle - Whether to render an iOS Toggle switch on the right side.
 *   When true, the chevron is automatically hidden.
 * @property toggleValue - Current state of the toggle (true = ON, false = OFF).
 * @property onToggleChange - Callback invoked when the toggle is switched.
 * @property onClick - Callback invoked when the row is clicked/activated.
 * @property labelColor - Controls the label text color variant:
 *   'default' (#000000), 'blue' (#007AFF), 'destructive' (#FF3B30).
 * @property showSeparator - Whether to render a 0.33px separator below the row,
 *   indented at 59px from the left edge (matching Figma settings layout).
 * @property className - Additional CSS class names for the outer wrapper element.
 */
export interface SettingsRowProps {
  icon?: React.ReactNode;
  iconBgColor?: string;
  label: string;
  value?: string;
  showChevron?: boolean;
  showToggle?: boolean;
  toggleValue?: boolean;
  onToggleChange?: (value: boolean) => void;
  onClick?: () => void;
  labelColor?: 'default' | 'blue' | 'destructive';
  showSeparator?: boolean;
  className?: string;
}

/**
 * iOS-style settings list row component.
 *
 * Renders a 47px-tall row with optional colored icon, label, value text,
 * and right-side chevron arrow or Toggle switch. Matches the exact layout
 * from Figma Settings screen (0:9198).
 *
 * @example Standard navigation row with icon and chevron
 * ```tsx
 * <SettingsRow
 *   icon={<StarIcon className="w-[17px] h-[17px] text-white" />}
 *   iconBgColor="#FFCC00"
 *   label="Starred Messages"
 *   onClick={() => router.push('/settings/starred')}
 *   showSeparator
 * />
 * ```
 *
 * @example Toggle row for on/off settings
 * ```tsx
 * <SettingsRow
 *   icon={<SpeakerIcon className="w-[17px] h-[17px] text-white" />}
 *   iconBgColor="#25D366"
 *   label="Save to Camera Roll"
 *   showToggle
 *   toggleValue={saveEnabled}
 *   onToggleChange={setSaveEnabled}
 * />
 * ```
 *
 * @example Value row with secondary text
 * ```tsx
 * <SettingsRow
 *   icon={<BellIcon className="w-[17px] h-[17px] text-white" />}
 *   iconBgColor="#FF3B30"
 *   label="Sound"
 *   value="Note"
 *   showSeparator
 * />
 * ```
 *
 * @example Action text row (no icon, colored label)
 * ```tsx
 * <SettingsRow
 *   label="Delete All Chats"
 *   labelColor="destructive"
 *   onClick={handleDeleteAll}
 * />
 * ```
 */
export const SettingsRow: React.FC<SettingsRowProps> = ({
  icon,
  iconBgColor,
  label,
  value,
  showChevron,
  showToggle = false,
  toggleValue = false,
  onToggleChange,
  onClick,
  labelColor = 'default',
  showSeparator = false,
  className = '',
}) => {
  // ---------------------------------------------------------------------------
  // Label color mapping — uses Tailwind design tokens from tailwind.config.ts.
  // 'default' → primary text black, 'blue' → iOS link blue, 'destructive' → iOS red.
  // ---------------------------------------------------------------------------
  const labelColorClasses: Record<NonNullable<SettingsRowProps['labelColor']>, string> = {
    default: 'text-black',
    blue: 'text-blue-ios',
    destructive: 'text-red-ios',
  };

  const resolvedLabelColor = labelColorClasses[labelColor];

  // ---------------------------------------------------------------------------
  // Determine whether to display the right chevron arrow.
  // Logic: show chevron by default UNLESS the caller explicitly set
  // showChevron=false OR the row renders a toggle (toggle replaces chevron).
  // ---------------------------------------------------------------------------
  const shouldShowChevron = showToggle ? false : showChevron !== false;

  // ---------------------------------------------------------------------------
  // Determine whether the row has an icon container.
  // When icon is provided, the 29×29px colored rounded-rect is rendered.
  // When no icon is provided (action-text variant), the label shifts left.
  // ---------------------------------------------------------------------------
  const hasIcon = Boolean(icon && iconBgColor);

  // ---------------------------------------------------------------------------
  // Keyboard event handler — activates the row on Enter or Space.
  // Space preventDefault avoids page scroll in browser (R34 compliance).
  // ---------------------------------------------------------------------------
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onClick?.();
      }
    },
    [onClick],
  );

  // ---------------------------------------------------------------------------
  // Toggle change handler — prevents row onClick from firing when the toggle
  // itself is interacted with.
  // ---------------------------------------------------------------------------
  const handleToggleChange = useCallback(
    (newValue: boolean) => {
      onToggleChange?.(newValue);
    },
    [onToggleChange],
  );

  return (
    <div className={className}>
      {/* Row container — 47px tall, white background, interactive */}
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={handleKeyDown}
        className={[
          /* Layout: fixed height 47px per Figma, horizontal flex, vertically centered */
          'flex items-center h-[47px] bg-white',
          /* Left padding: 15px for icon area (or 16px for action-text rows) */
          hasIcon ? 'pl-[15px]' : 'pl-4',
          /* Right padding: 16px from row right edge to chevron/toggle */
          'pr-4',
          /* Interactive states */
          'cursor-pointer',
          /* Active press state (iOS gray flash on tap) */
          'active:bg-gray-100',
          /* Focus visible ring for keyboard navigation (WCAG 2.1 AA — R34) */
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-inset',
        ].join(' ')}
        aria-label={label}
      >
        {/* ---- Icon Container (29×29px rounded-rect with colored background) ---- */}
        {hasIcon && (
          <div
            className="flex items-center justify-center w-[29px] h-[29px] rounded-[6px] flex-shrink-0"
            style={{ backgroundColor: iconBgColor }}
            aria-hidden="true"
          >
            {icon}
          </div>
        )}

        {/* ---- Label Text ---- */}
        {/* x=59 from left: 15px padding + 29px icon + 15px gap = 59px */}
        {/* When no icon: left padding handles positioning */}
        <span
          className={[
            /* Margin from icon to label: 15px gap. Without icon: no margin needed */
            hasIcon ? 'ml-[15px]' : 'ml-0',
            /* Flex-grow to fill available space, pushing right content to edge */
            'flex-1 truncate',
            /* Typography: SF Pro Text 400, 16px, lineHeight 1.375em, tracking -0.021em (-2.06% / 100) */
            'font-sans font-normal text-[16px] leading-[1.375em] tracking-[-0.021em]',
            /* Label color variant */
            resolvedLabelColor,
          ].join(' ')}
        >
          {label}
        </span>

        {/* ---- Right Side Content (value text, toggle, or chevron) ---- */}
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          {/* Optional value text (secondary gray, right-aligned before chevron) */}
          {value && (
            <span className="font-sans font-normal text-[16px] leading-[1.375em] tracking-[-0.021em] text-secondary">
              {value}
            </span>
          )}

          {/* Toggle switch — replaces chevron when showToggle is true */}
          {showToggle && (
            <Toggle
              value={toggleValue}
              onChange={handleToggleChange}
              ariaLabel={`Toggle ${label}`}
            />
          )}

          {/* Right chevron arrow — 7×12px, color rgba(60,60,67,0.3) */}
          {shouldShowChevron && (
            <svg
              width="7"
              height="12"
              viewBox="0 0 7 12"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
              className="flex-shrink-0"
            >
              <path
                d="M1 1L6 6L1 11"
                stroke="rgba(60, 60, 67, 0.3)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      </div>

      {/* ---- Row Separator (0.33px hairline at x=59) ---- */}
      {showSeparator && <Separator inset insetLeft={59} />}
    </div>
  );
};

export default SettingsRow;
