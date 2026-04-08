'use client';

// =============================================================================
// CallItem — Individual Call Row Component
// =============================================================================
//
// Renders a single call entry in the call history list matching:
//   - Normal mode: Figma Screen 11 (WhatsApp Calls, node 0:10395)
//   - Edit mode:   Figma Screen 12 (WhatsApp Calls Edit, node 0:8597)
//
// From Figma file: miK1B6qEPrUnRZ9wwZNrW2
//
// Row Specification (Normal Mode):
//   Container:        375×56px, bg #FFFFFF, flex row
//   Avatar:           x=16, 40×40px circular (Avatar component, customSize=40)
//   Name text:        x=68, SF Pro Text 400 16px/1.193em, -0.04em tracking
//                     Normal: #000000, Missed: #FF3B30
//   Direction icon:   x=67.5, 15×15px, #8E8E93 — phone-outgoing/incoming/missed
//   Direction text:   x=89, SF Pro Text 400 14px/1.193em, -0.04em tracking, #8E8E93
//   Date text:        right-aligned, SF Pro Text 400 14px/1.193em, -0.02em tracking, #8E8E93
//   Info circle:      x=337, 22×22px, #007AFF — tappable, NOT visible in edit mode
//
// Row Specification (Edit Mode):
//   Delete circle:    x=17, 21×21px, red #FF3B30 — tappable
//   All content:      shifted +31px right (avatar at x=47, name at x=99)
//   Info circle:      hidden
//
// Accessibility (WCAG 2.1 AA — Rule R34):
//   - Row is keyboard navigable (role="button", tabIndex=0, Enter/Space)
//   - Info and delete buttons have descriptive aria-labels
//   - Focus-visible outlines for keyboard navigation
//   - Color contrast: #000000/#FFFFFF = 21:1, #FF3B30/#FFFFFF = 4.53:1
// =============================================================================

import React from 'react';
import Image from 'next/image';
import Avatar from '../common/Avatar';

/* Static SVG icon imports — resolved at build time by Next.js bundler.
 * Icons sourced from Figma file miK1B6qEPrUnRZ9wwZNrW2, exported to src/assets/icons/.
 * Each SVG has colors baked in (#8E8E93 for direction, #007AFF for info, #FF3B30 for delete). */
import iconPhoneOutgoing from '@/assets/icons/icon-phone-outgoing.svg';
import iconPhoneIncoming from '@/assets/icons/icon-phone-incoming.svg';
import iconPhoneMissed from '@/assets/icons/icon-phone-missed.svg';
import iconInfoCircle from '@/assets/icons/icon-info-circle.svg';
import iconDeleteCircle from '@/assets/icons/icon-delete-circle.svg';

// =============================================================================
// Exported Interfaces
// =============================================================================

/**
 * Data shape for an individual call entry.
 *
 * Maps to the row data visible in Figma Screens 11 (0:10395) and 12 (0:8597).
 *
 * @property id        — Unique identifier for the call record
 * @property name      — Contact display name (e.g. "Martin Randolph")
 * @property avatar    — Optional URL to the contact's avatar image
 * @property direction — Call direction: 'outgoing' | 'incoming' | 'missed'
 *                       Controls name color (missed = #FF3B30) and direction icon variant
 * @property date      — Display date string (e.g. "10/13/19")
 * @property phoneType — Optional phone type label (e.g. "mobile", "home")
 */
export interface CallItemCall {
  id: string;
  name: string;
  avatar?: string;
  direction: 'outgoing' | 'incoming' | 'missed';
  date: string;
  phoneType?: string;
}

/**
 * Props interface for the CallItem component.
 *
 * @property call        — Call data to render in the row
 * @property isEditMode  — When true, shows delete circle at left and hides info icon
 * @property onPress     — Handler for tapping the entire row
 * @property onInfoPress — Handler for tapping the blue info circle (normal mode only)
 * @property onDelete    — Handler for tapping the red delete circle (edit mode only)
 * @property className   — Additional Tailwind classes for the outermost container
 */
export interface CallItemProps {
  call: CallItemCall;
  isEditMode?: boolean;
  onPress?: () => void;
  onInfoPress?: () => void;
  onDelete?: () => void;
  className?: string;
}

// =============================================================================
// Direction Icon Mapping
// =============================================================================

/**
 * Returns the correct static SVG import for the given call direction.
 *
 * All three icons are phone shapes with baked-in #8E8E93 fill, sourced from
 * Figma node 0:10395 (Calls screen).
 */
const DIRECTION_ICON_MAP: Record<CallItemCall['direction'], typeof iconPhoneOutgoing> = {
  outgoing: iconPhoneOutgoing,
  incoming: iconPhoneIncoming,
  missed: iconPhoneMissed,
};

// =============================================================================
// CallItem Component
// =============================================================================

/**
 * Individual call history row component.
 *
 * Renders a 56px-tall white row with avatar, contact name, direction indicator
 * (icon + text), date, and an info circle button. In edit mode, a red delete
 * circle appears at the left and all content shifts right by 31px while the
 * info icon is hidden.
 *
 * @example
 * ```tsx
 * <CallItem
 *   call={{ id: '1', name: 'Martin Randolph', direction: 'outgoing', date: '10/13/19' }}
 *   onPress={() => console.log('row tapped')}
 *   onInfoPress={() => console.log('info tapped')}
 * />
 * ```
 */
export const CallItem: React.FC<CallItemProps> = ({
  call,
  isEditMode = false,
  onPress,
  onInfoPress,
  onDelete,
  className = '',
}) => {
  const isMissed = call.direction === 'missed';
  const directionIcon = DIRECTION_ICON_MAP[call.direction];

  /**
   * Keyboard activation handler for the row container.
   * Enter and Space trigger onPress (WCAG 2.1 AA keyboard operability).
   */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPress?.();
    }
  };

  /**
   * Stops event propagation for nested interactive elements (info and delete buttons)
   * so their clicks don't bubble to the row's onClick handler.
   */
  const handleInfoClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onInfoPress?.();
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete?.();
  };

  /**
   * Keyboard handler for nested buttons — prevents row activation when
   * pressing Enter/Space on the info or delete button.
   */
  const handleNestedKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.stopPropagation();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPress}
      onKeyDown={handleKeyDown}
      aria-label={`Call from ${call.name}, ${call.direction}, ${call.date}`}
      className={[
        /* Row container: 56px height, white background, flex row centered */
        'flex items-center w-full h-[56px] bg-white cursor-pointer',
        /* Focus-visible outline for keyboard navigation (WCAG 2.1 AA — R34) */
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-[-2px]',
        /* Smooth transition for edit mode content shift */
        'transition-[padding] duration-200 ease-out',
        className,
      ].filter(Boolean).join(' ')}
    >
      {/* ── Edit Mode: Delete Circle (red minus) ──────────────────────── */}
      {/* Position: x=17, size 21×21px. Visible only in edit mode.
       * Figma node 0:8606 from Screen 12 (Calls Edit, 0:8597).
       * SVG has baked-in #FF3B30 circle with white horizontal dash. */}
      {isEditMode && (
        <button
          type="button"
          onClick={handleDeleteClick}
          onKeyDown={handleNestedKeyDown}
          className={[
            'flex-shrink-0 flex items-center justify-center',
            'ml-[17px] p-0 border-0 bg-transparent cursor-pointer',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2',
          ].join(' ')}
          aria-label={`Delete call from ${call.name}`}
        >
          <Image
            src={iconDeleteCircle}
            alt=""
            width={21}
            height={21}
            aria-hidden="true"
          />
        </button>
      )}

      {/* ── Avatar ─────────────────────────────────────────────────────── */}
      {/* Normal mode: x=16 (ml-16px), Edit mode: x=47 (ml-9px after delete icon).
       * Delete icon consumes 17px margin + 21px width = 38px. Avatar gap = 9px → 38+9 = 47px.
       * Size: 40×40px circular via Avatar component's customSize prop.
       * Figma node 0:10397. */}
      <div
        className={[
          'flex-shrink-0',
          isEditMode ? 'ml-[9px]' : 'ml-[16px]',
          'transition-[margin] duration-200 ease-out',
        ].join(' ')}
      >
        <Avatar
          src={call.avatar}
          alt={call.name}
          customSize={40}
        />
      </div>

      {/* ── Content Area: Name + Direction ──────────────────────────── */}
      {/* Flex column containing the name on top and direction row below.
       * Gap from avatar: 12px (68 - 16 - 40 = 12 in normal mode).
       * min-w-0 enables text truncation within flex children. */}
      <div className="flex-1 ml-[12px] min-w-0 flex flex-col justify-center">
        {/* Name text — SF Pro Text 400 16px / 1.193em / -0.04em tracking.
         * Color: #000000 for normal, #FF3B30 for missed calls.
         * Truncated with ellipsis to prevent overflow. */}
        <span
          className={[
            'text-[16px] font-normal leading-[1.193em] tracking-tight-ios truncate',
            isMissed ? 'text-red-ios' : 'text-black',
          ].join(' ')}
        >
          {call.name}
        </span>

        {/* Direction row: phone icon + direction label.
         * Gap between icon and text: ~6.5px (Figma: 89 - 67.5 - 15 = 6.5).
         * Vertical gap from name: 4px (Figma: direction y=32 - name bottom y=28). */}
        <div className="flex items-center gap-[6.5px] mt-[4px]">
          {/* Direction phone icon — 15×15px rendered size.
           * SVG has baked-in #8E8E93 fill. Decorative — hidden from screen readers. */}
          <Image
            src={directionIcon}
            alt=""
            width={15}
            height={15}
            className="flex-shrink-0"
            aria-hidden="true"
          />
          {/* Direction text label — "outgoing", "incoming", or "missed" (lowercase).
           * SF Pro Text 400 14px / 1.193em / -0.04em tracking, #8E8E93. */}
          <span className="text-[14px] font-normal leading-[1.193em] tracking-tight-ios text-secondary">
            {call.direction}
          </span>
        </div>
      </div>

      {/* ── Date Text (right-aligned) ──────────────────────────────── */}
      {/* SF Pro Text 400 14px / 1.193em / -0.02em tracking (note: different
       * from direction text which uses -0.04em). Color: #8E8E93.
       * Right-aligned within the row. Figma style_8IWR8V / style_QM3KDS.
       * Normal mode: right edge at 327px → gap to info icon (337px) = 10px → mr-[10px].
       * Edit mode: right edge at 355px → 375 - 355 = 20px → mr-[20px]. */}
      <span
        className={[
          'flex-shrink-0 text-[14px] font-normal leading-[1.193em] tracking-[-0.02em]',
          'text-right text-secondary whitespace-nowrap',
          isEditMode ? 'mr-[20px]' : 'mr-[10px]',
        ].join(' ')}
      >
        {call.date}
      </span>

      {/* ── Info Circle Icon (Normal Mode Only) ────────────────────── */}
      {/* Position: x=337, size 22×22px. Color: #007AFF (baked into SVG).
       * Figma node 0:10404. Tappable — calls onInfoPress.
       * Hidden in edit mode per Figma Screen 12 specification. */}
      {!isEditMode && (
        <button
          type="button"
          onClick={handleInfoClick}
          onKeyDown={handleNestedKeyDown}
          className={[
            'flex-shrink-0 flex items-center justify-center',
            'mr-[16px] p-0 border-0 bg-transparent cursor-pointer',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2',
          ].join(' ')}
          aria-label={`Info for ${call.name}`}
        >
          <Image
            src={iconInfoCircle}
            alt=""
            width={22}
            height={22}
            aria-hidden="true"
          />
        </button>
      )}
    </div>
  );
};

export default CallItem;
