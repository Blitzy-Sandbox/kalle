'use client';

import React from 'react';

/**
 * Props for the iOS-style NavigationBar component.
 *
 * Supports a centered title, optional left/right actions (text or icons),
 * a center content override for custom elements like SegmentedControl,
 * and a large title style variant.
 */
export interface NavigationBarProps {
  /** Center title text displayed in the navigation bar */
  title: string;

  /** Left action content — string for text button, ReactNode for custom (e.g., back chevron + label) */
  leftAction?: React.ReactNode;

  /** Click handler for the left action button */
  onLeftAction?: () => void;

  /** Right action content — string for text, ReactNode for icon or custom element */
  rightAction?: React.ReactNode;

  /** Click handler for the right action button */
  onRightAction?: () => void;

  /** When true, renders the title in large bold style (iOS large title mode, 34px bold) */
  largeTitleStyle?: boolean;

  /** Optional center content that replaces the title (e.g., SegmentedControl on Calls screen) */
  centerContent?: React.ReactNode;

  /** Additional CSS class names appended to the nav element */
  className?: string;
}

/**
 * iOS-style top navigation bar with centered title and optional left/right actions.
 *
 * Renders a 44px-tall navigation bar matching iOS Human Interface Guidelines
 * patterns derived from the Figma design (node 0:8995). The component uses a
 * three-column layout with the title absolutely centered for pixel-perfect
 * horizontal centering regardless of left/right action widths.
 *
 * Design tokens used:
 * - Background: bg-nav (#F6F6F6)
 * - Shadow: shadow-nav-bottom (0px 0.33px 0px rgba(166, 166, 170, 1))
 * - Title: text-nav-title (SF Pro Text 600, 17px, 1.29em line-height)
 * - Actions: text-nav-action (SF Pro Text 400, 17px, 1.29em line-height)
 * - Action color: text-blue-ios (#007AFF)
 * - Letter spacing: tracking-tight-ios (-0.04em)
 *
 * Variants across screens:
 * - Standard: text left action, center title, icon/no right action (Chats, Status, Settings)
 * - Back navigation: back chevron + label on left, center title, optional right action
 * - Edit mode: "Done" left, center title, "Clear" right
 * - Center override: "Edit" left, SegmentedControl center, icon right (Calls screen)
 *
 * @example Standard navigation bar
 * ```tsx
 * <NavigationBar
 *   title="Chats"
 *   leftAction="Edit"
 *   onLeftAction={handleEdit}
 *   rightAction={<ComposeIcon />}
 *   onRightAction={handleCompose}
 * />
 * ```
 *
 * @example Back navigation
 * ```tsx
 * <NavigationBar
 *   title="Contact Info"
 *   leftAction={<><BackChevron aria-hidden="true" /> Martha Craig</>}
 *   onLeftAction={handleBack}
 *   rightAction="Edit"
 *   onRightAction={handleEditContact}
 * />
 * ```
 *
 * @example With center content override
 * ```tsx
 * <NavigationBar
 *   title="Calls"
 *   leftAction="Edit"
 *   onLeftAction={handleEdit}
 *   centerContent={<SegmentedControl labels={['All', 'Missed']} activeIndex={0} onChange={setFilter} />}
 *   rightAction={<PhonePlusIcon />}
 *   onRightAction={handleNewCall}
 * />
 * ```
 */
export const NavigationBar: React.FC<NavigationBarProps> = ({
  title,
  leftAction,
  onLeftAction,
  rightAction,
  onRightAction,
  largeTitleStyle = false,
  centerContent,
  className = '',
}) => {
  /**
   * Shared Tailwind class list for left and right action buttons.
   * Uses text-nav-action for 17px/400 weight typography, blue-ios color,
   * tight-ios letter spacing, and focus-visible ring for keyboard accessibility.
   */
  const actionButtonClasses = [
    'text-nav-action',
    'text-blue-ios',
    'tracking-tight-ios',
    'focus:outline-none',
    'focus-visible:ring-2',
    'focus-visible:ring-blue-ios',
    'focus-visible:ring-offset-1',
    'rounded-sm',
  ].join(' ');

  return (
    <nav
      aria-label="Navigation"
      className={`relative flex items-center justify-between h-nav-bar bg-nav shadow-nav-bottom ${className}`}
    >
      {/* Left action zone — relative + z-10 + h-full stacks above the absolute-centered title;
          bg-nav provides visual masking for any title text that extends beneath on non-SF-Pro systems */}
      <div className="relative flex items-center z-10 min-w-[60px] h-full ps-4 bg-nav">
        {leftAction != null && (
          <button
            type="button"
            onClick={onLeftAction}
            className={actionButtonClasses}
          >
            {leftAction}
          </button>
        )}
      </div>

      {/* Center zone — absolute positioned for perfect iOS-style centering.
          px-[100px] constrains the title to the area between left/right action zones,
          preventing overlap on non-SF-Pro font systems where text renders wider.
          Left/right zones use z-10+bg-nav to mask any title extending beneath.
          pointer-events-none allows click-through to left/right actions beneath.
          Title truncates gracefully when the text exceeds the constrained width. */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-[100px]">
        {centerContent != null ? (
          <div className="pointer-events-auto">{centerContent}</div>
        ) : (
          <h1
            className={
              largeTitleStyle
                ? 'text-[34px] font-bold leading-[1.2em] text-black tracking-tight-ios truncate'
                : 'text-nav-title text-black tracking-tight-ios truncate'
            }
          >
            {title}
          </h1>
        )}
      </div>

      {/* Right action zone — relative + z-10 + h-full stacks above the absolute-centered title;
          bg-nav provides visual masking for any title text that extends beneath */}
      <div className="relative flex items-center z-10 min-w-[60px] h-full justify-end pe-4 bg-nav">
        {rightAction != null && (
          <button
            type="button"
            onClick={onRightAction}
            className={actionButtonClasses}
          >
            {rightAction}
          </button>
        )}
      </div>
    </nav>
  );
};

export default NavigationBar;
