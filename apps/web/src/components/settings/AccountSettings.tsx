'use client';

import React from 'react';
import { NavigationBar } from '@/components/common/NavigationBar';
import { Separator } from '@/components/common/Separator';

/* ==========================================================================
 * AccountSettings — Reusable Account Settings Component
 *
 * Maps to Figma Screen 17 (WhatsApp Account, node 0:9371),
 * file key miK1B6qEPrUnRZ9wwZNrW2.
 *
 * Figma layout specs:
 * - Frame: bg #EFEFF4 (bg-surface), min-height fills parent
 * - NavigationBar: back "Settings" (blue #007AFF) + "Account" centered
 * - Row Group 1 (375×188px, y=123, 35px below nav):
 *   - Privacy, Security, Two-Step Verification, Change Number
 *   - White bg, dual shadow, rows 47px each, no icon squares
 *   - Label at x=16 (no icon offset), chevron at x=351
 *   - SF Pro Text 400 16px / 1.375em / -0.03em, #000000
 * - Row Group 2 (375×94px, y=346, 35px gap):
 *   - Request Account Info, Delete My Account
 * - Separators: x=16, 0.33px, rgba(60,60,67,0.29)
 *
 * KEY DISTINCTION: No colored icon squares — text aligns at x=16.
 * ========================================================================== */

/**
 * Group 1 menu items: Privacy, Security, Two-Step Verification, Change Number.
 */
const GROUP_1_ITEMS: ReadonlyArray<{ readonly label: string }> = [
  { label: 'Privacy' },
  { label: 'Security' },
  { label: 'Two-Step Verification' },
  { label: 'Change Number' },
] as const;

/**
 * Group 2 menu items: Request Account Info, Delete My Account.
 */
const GROUP_2_ITEMS: ReadonlyArray<{ readonly label: string }> = [
  { label: 'Request Account Info' },
  { label: 'Delete My Account' },
] as const;

/* --------------------------------------------------------------------------
 * Inline SVG Components
 * -------------------------------------------------------------------------- */

/**
 * Back chevron SVG — 12×21px, currentColor, rendered in NavigationBar
 * back button. Source: icon-back-chevron.svg (Figma node 0:8257).
 */
function BackChevron() {
  return (
    <svg
      className="w-[12px] h-[21px]"
      viewBox="0 0 12 21"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M3.60206 10.5L11.4062 2.55085C11.9866 1.9597 11.9778 1.00999 11.3867 0.429623C10.7955 -0.150747 9.84583 -0.142006 9.26546 0.449147L0.429623 9.44915C-0.143208 10.0326 -0.143208 10.9674 0.429623 11.5509L9.26546 20.5509C9.84583 21.142 10.7955 21.1507 11.3867 20.5704C11.9778 19.99 11.9866 19.0403 11.4062 18.4491L3.60206 10.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * Right chevron disclosure arrow — 7×12px, rgba(60,60,67,0.3).
 * Source: icon-arrow-right.svg (Figma node 0:8883).
 */
function ChevronRight() {
  return (
    <svg
      className="w-[7px] h-[12px] flex-shrink-0"
      viewBox="0 0 7 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M4.58579 6L0.292893 10.2929C-0.0976311 10.6834 -0.0976311 11.3166 0.292893 11.7071C0.683418 12.0976 1.31658 12.0976 1.70711 11.7071L6.70711 6.70711C7.09763 6.31658 7.09763 5.68342 6.70711 5.29289L1.70711 0.292893C1.31658 -0.0976311 0.683418 -0.0976311 0.292893 0.292893C-0.0976311 0.683418 -0.0976311 1.31658 0.292893 1.70711L4.58579 6Z"
        fill="#3C3C43"
        fillOpacity="0.3"
      />
    </svg>
  );
}

/* --------------------------------------------------------------------------
 * RowGroup — Renders a white card group of account settings rows
 *
 * Figma specs per row (node 0:9374 pattern):
 * - Height: 47px, background: #FFFFFF
 * - Text: x:16, SF Pro Text 400 16px/1.375em/-0.03em, #000000
 * - Chevron: x:351, 7×12px, rgba(60,60,67,0.3)
 * - Separator: x:16, 0.33px between rows only
 * -------------------------------------------------------------------------- */

interface RowGroupProps {
  readonly items: ReadonlyArray<{ readonly label: string }>;
  /** Callback when a row is clicked */
  readonly onRowClick?: (label: string) => void;
}

/**
 * Renders a group of settings rows inside a white iOS card container.
 */
function RowGroup({ items, onRowClick }: RowGroupProps) {
  return (
    <div
      className="bg-white shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)]"
      role="group"
    >
      {items.map((item, index) => (
        <React.Fragment key={item.label}>
          <button
            type="button"
            onClick={() => onRowClick?.(item.label)}
            className={[
              'w-full h-[47px] bg-white',
              'flex items-center justify-between',
              'ps-4 pe-4',
              'active:bg-gray-100 motion-safe:transition-colors motion-safe:duration-150',
              'focus-visible:outline focus-visible:outline-2',
              'focus-visible:outline-blue-ios focus-visible:outline-offset-[-2px]',
            ].join(' ')}
            aria-label={item.label}
          >
            <span className="font-normal text-[16px] leading-[1.375em] tracking-[-0.03em] text-black">
              {item.label}
            </span>
            <ChevronRight />
          </button>
          {index < items.length - 1 && (
            <Separator inset insetLeft={16} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

/* ==========================================================================
 * AccountSettings — Exported Component
 * ========================================================================== */

/**
 * Props for the AccountSettings component.
 */
export interface AccountSettingsProps {
  /** Callback when the back button ("Settings") is pressed */
  onBack?: () => void;
  /** Callback when a settings row is clicked, receiving the label text */
  onRowClick?: (label: string) => void;
  /** Additional CSS class names */
  className?: string;
}

/**
 * AccountSettings — Reusable account settings component.
 *
 * Renders the Account settings screen matching Figma Screen 17 (node 0:9371)
 * with two groups of plain-text menu rows. This component is a standalone
 * reusable module that can be used in both the page route and in modal or
 * layout contexts.
 *
 * Key architectural note: Rows have NO colored icon squares — labels
 * align at x=16 directly, differentiating this from the main Settings
 * menu which uses colored icon backgrounds.
 *
 * WCAG 2.1 AA compliant (R34):
 * - Rows are button elements for keyboard accessibility
 * - Visible focus indicators (outline-blue-ios)
 * - Screen-reader-only heading for landmark navigation
 * - Semantic group roles on row containers
 *
 * @example
 * ```tsx
 * <AccountSettings
 *   onBack={() => router.back()}
 *   onRowClick={(label) => navigateToSetting(label)}
 * />
 * ```
 */
const AccountSettings: React.FC<AccountSettingsProps> = ({
  onBack,
  onRowClick,
  className = '',
}) => {
  return (
    <div className={`flex flex-col h-full bg-surface ${className}`}>
      {/* Visually hidden page heading for screen readers (WCAG landmark) */}
      <h1 className="sr-only">Account Settings</h1>

      {/* iOS-style navigation bar — centered "Account" title with back nav */}
      <NavigationBar
        title="Account"
        leftAction={
          <span className="inline-flex items-center gap-[5px]">
            <BackChevron />
            <span>Settings</span>
          </span>
        }
        onLeftAction={onBack}
      />

      {/* Scrollable content area */}
      <main className="flex-1 overflow-y-auto">
        {/* Group 1 — Privacy / Security / Two-Step Verification / Change Number
            Figma: y=123, 35px below NavigationBar bottom edge */}
        <div className="mt-[35px]">
          <RowGroup items={GROUP_1_ITEMS} onRowClick={onRowClick} />
        </div>

        {/* Group 2 — Request Account Info / Delete My Account
            Figma: y=346, 35px gap from Group 1 bottom edge */}
        <div className="mt-[35px]">
          <RowGroup items={GROUP_2_ITEMS} onRowClick={onRowClick} />
        </div>
      </main>
    </div>
  );
};

export default AccountSettings;
