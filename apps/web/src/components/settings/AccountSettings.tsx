'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { NavigationBar } from '@/components/common/NavigationBar';
import { TabBar } from '@/components/common/TabBar';
import { SettingsRow } from '@/components/common/SettingsRow';
import { Separator } from '@/components/common/Separator';
import { StatusBar } from '@/components/common/StatusBar';

/* ==========================================================================
 * AccountSettings — Account Settings Screen Component
 *
 * Maps 1:1 to Figma Screen 17 (WhatsApp Account, node 0:9371),
 * file key miK1B6qEPrUnRZ9wwZNrW2.
 *
 * Figma layout specifications:
 * - Frame: 375×812px, background #EFEFF4 (bg-surface)
 * - NavigationBar: back chevron + "Settings" (blue #007AFF), "Account" centered
 * - Row Group 1 (y=123, 375×188px): Privacy, Security, Two-Step Verification,
 *   Change Number — white bg, dual 0.33px shadow, rows 47px each
 * - Row Group 2 (y=346, 375×94px): Request Account Info, Delete My Account
 * - Tab Bar (y=729): "Settings" tab active (#007AFF)
 *
 * KEY DISTINCTION FROM SETTINGS MENU:
 * These rows have NO colored icon squares. Text labels begin at x=16
 * (standard page margin) instead of x=59 (icon offset). All rows use
 * SettingsRow WITHOUT icon prop.
 *
 * Separators between rows use insetLeft=16px (not the default 59px
 * that SettingsRow's built-in separator uses).
 *
 * WCAG 2.1 AA (R34):
 * - Screen-reader-only heading for landmark navigation
 * - All rows are keyboard-accessible via SettingsRow's button role
 * - Visible focus indicators on all interactive elements
 * - Semantic grouping of row sections
 * ========================================================================== */

/**
 * Props for the AccountSettings component.
 *
 * All props are optional — the component provides sensible defaults
 * using Next.js router for navigation and 'settings' as the active tab.
 */
export interface AccountSettingsProps {
  /** Callback when the back button ("Settings") is pressed. Falls back to router.back(). */
  onBack?: () => void;
  /** Currently active tab identifier. Defaults to 'settings'. */
  activeTab?: 'settings';
  /** Callback when a tab bar item is pressed. Falls back to router.push(). */
  onTabPress?: (tab: string) => void;
  /** Additional CSS class names for the root container element. */
  className?: string;
}

/* --------------------------------------------------------------------------
 * BackChevron — Inline SVG for iOS-style back navigation arrow
 *
 * Figma node 0:9414 — Back chevron shape:
 * - Dimensions: 11.84×21px (rendered at 12×21px viewBox)
 * - Fill: currentColor (inherits #007AFF from NavigationBar action button)
 * -------------------------------------------------------------------------- */
function BackChevron(): React.ReactNode {
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

/* --------------------------------------------------------------------------
 * Row Group Data Constants
 *
 * Static row labels for each account settings group, matching Figma
 * Screen 17 exactly (verbatim text from design).
 * -------------------------------------------------------------------------- */

/** Group 1: Privacy, Security, Two-Step Verification, Change Number */
const GROUP_1_ROWS: ReadonlyArray<string> = [
  'Privacy',
  'Security',
  'Two-Step Verification',
  'Change Number',
] as const;

/** Group 2: Request Account Info, Delete My Account */
const GROUP_2_ROWS: ReadonlyArray<string> = [
  'Request Account Info',
  'Delete My Account',
] as const;

/* --------------------------------------------------------------------------
 * Dual shadow CSS value for row group containers
 *
 * Figma: 0px -0.33px 0px rgba(60,60,67,0.29) top edge +
 *         0px 0.33px 0px rgba(60,60,67,0.29) bottom edge
 *
 * Combined as a single Tailwind arbitrary shadow value.
 * -------------------------------------------------------------------------- */
const ROW_GROUP_SHADOW =
  'shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)]';

/* ==========================================================================
 * AccountSettings Component
 * ========================================================================== */

/**
 * Account settings screen matching Figma Screen 17 (node 0:9371).
 *
 * Renders two groups of plain-text navigation rows without colored icon
 * squares. Each row displays a label at x=16 with a right disclosure
 * chevron at x=351. Groups are separated by a 35px vertical gap on
 * the #EFEFF4 surface background.
 *
 * @example Usage in a Next.js page
 * ```tsx
 * export default function AccountPage() {
 *   return <AccountSettings />;
 * }
 * ```
 *
 * @example Usage with custom callbacks
 * ```tsx
 * <AccountSettings
 *   onBack={() => router.push('/settings')}
 *   onTabPress={(tab) => router.push(`/${tab}`)}
 * />
 * ```
 */
const AccountSettings: React.FC<AccountSettingsProps> = ({
  onBack,
  activeTab = 'settings',
  onTabPress,
  className = '',
}) => {
  const router = useRouter();

  /**
   * Back navigation handler.
   * Uses the onBack prop callback if provided, otherwise falls back
   * to Next.js router.back() for standard browser history navigation.
   */
  const handleBack = (): void => {
    if (onBack) {
      onBack();
    } else {
      router.back();
    }
  };

  /**
   * Tab bar press handler.
   * Bridges the component's string-typed onTabPress callback to the
   * TabBar's TabId-typed onTabPress prop. Falls back to router.push()
   * when no callback is provided.
   */
  const handleTabPress = (tab: string): void => {
    if (onTabPress) {
      onTabPress(tab);
    } else {
      router.push(`/${tab}`);
    }
  };

  return (
    <div className={`flex flex-col min-h-screen bg-surface ${className}`.trim()}>
      {/* Simulated iOS status bar — hidden on mobile, visible on desktop (md+) */}
      <StatusBar />

      {/* iOS-style navigation bar — centered "Account" title, back to Settings */}
      <NavigationBar
        title="Account"
        leftAction={
          <span className="inline-flex items-center gap-[5px]">
            <BackChevron />
            <span>Settings</span>
          </span>
        }
        onLeftAction={handleBack}
      />

      {/* Visually hidden heading for screen readers (WCAG landmark navigation) */}
      <h1 className="sr-only">Account Settings</h1>

      {/* Scrollable content area with bottom padding for fixed tab bar (83px) */}
      <main className="flex-1 overflow-y-auto pb-[83px]">
        {/* ================================================================
         * Row Group 1 — Account Options
         *
         * Figma: node 0:9372, position (0, 123), size 375×188px
         * 4 rows × 47px each, white bg, dual 0.33px shadow
         * 35px gap below NavigationBar (123px - 88px nav area = 35px)
         * Separators at x=16, 0.33px, rgba(60,60,67,0.29)
         * ================================================================ */}
        <div
          className={`mt-[35px] bg-white ${ROW_GROUP_SHADOW}`}
          role="group"
          aria-label="Account options"
        >
          {GROUP_1_ROWS.map((label, index) => (
            <React.Fragment key={label}>
              <SettingsRow label={label} />
              {index < GROUP_1_ROWS.length - 1 && (
                <Separator inset insetLeft={16} />
              )}
            </React.Fragment>
          ))}
        </div>

        {/* ================================================================
         * Row Group 2 — Account Actions
         *
         * Figma: node 0:9397, position (0, 346), size 375×94px
         * 2 rows × 47px each, same styling as Group 1
         * 35px gap from Group 1 bottom (346 - (123 + 188) = 35px)
         * ================================================================ */}
        <div
          className={`mt-[35px] bg-white ${ROW_GROUP_SHADOW}`}
          role="group"
          aria-label="Account actions"
        >
          {GROUP_2_ROWS.map((label, index) => (
            <React.Fragment key={label}>
              <SettingsRow label={label} />
              {index < GROUP_2_ROWS.length - 1 && (
                <Separator inset insetLeft={16} />
              )}
            </React.Fragment>
          ))}
        </div>
      </main>

      {/* Fixed bottom tab bar — "Settings" tab active (blue #007AFF) */}
      <TabBar
        activeTab={activeTab}
        onTabPress={handleTabPress}
      />
    </div>
  );
};

export default AccountSettings;
