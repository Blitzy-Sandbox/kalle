'use client';

/* ==========================================================================
 * ChatSettings — Chat-Specific Settings Screen Component
 *
 * Maps 1:1 to Figma Screen 18 (WhatsApp Chats Settings, node 0:9973),
 * file key miK1B6qEPrUnRZ9wwZNrW2.
 *
 * Layout sections (top to bottom):
 *   StatusBar (decorative iOS chrome, hidden on mobile)
 *   NavigationBar — back "Settings" (blue) + "Chats" title centered
 *   Content area:
 *     1. "Change Wallpaper" — white row card, right chevron
 *     2. "Save to Camera Roll" — toggle (OFF default), description below
 *     3. "Chat Backup" — white row card, right chevron
 *     4. Action items — Archive (blue), Clear (red), Delete (red)
 *   TabBar — Settings tab active
 *
 * Design tokens (Figma Section 0.5.2):
 *   bg-surface (#EFEFF4), bg-white, bg-nav (#F6F6F6)
 *   text-black, text-blue-ios (#007AFF), text-red-ios (#FF3B30)
 *   text-secondary (#8E8E93), separator rgba(60,60,67,0.29)
 *   Row group shadow: dual 0.33px rgba(60,60,67,0.29) top + bottom
 *
 * WCAG 2.1 AA compliance (Rule R34):
 *   - sr-only <h1> for screen readers
 *   - All rows keyboard-accessible via SettingsRow built-in focus ring
 *   - Toggle has aria-label via SettingsRow delegation to Toggle component
 *   - <main> landmark wraps scrollable content
 *   - <nav> landmarks from NavigationBar and TabBar
 * ========================================================================== */

import React, { FC, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { NavigationBar } from '@/components/common/NavigationBar';
import { SettingsRow } from '@/components/common/SettingsRow';
import { Separator } from '@/components/common/Separator';
import { StatusBar } from '@/components/common/StatusBar';

/* --------------------------------------------------------------------------
 * Back Chevron — Inline SVG (12×21px, currentColor)
 *
 * Rendered inside the NavigationBar leftAction slot alongside "Settings" text.
 * SVG path sourced from Figma navigation back chevron, stroke-based.
 * -------------------------------------------------------------------------- */

/**
 * iOS-style back chevron arrow used in the NavigationBar.
 * 12×21px, fill=currentColor inherits text-blue-ios from the parent button.
 */
function BackChevron(): React.JSX.Element {
  return (
    <svg
      className="w-[12px] h-[21px] flex-shrink-0"
      viewBox="0 0 12 21"
      fill="none"
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
 * RowGroup — White card wrapper with dual 0.33px box-shadow
 *
 * Reusable helper for the white background row group pattern shared across
 * all four content sections. Shadow matches Figma row group containers:
 *   top:    0px -0.33px 0px rgba(60,60,67,0.29)
 *   bottom: 0px  0.33px 0px rgba(60,60,67,0.29)
 * -------------------------------------------------------------------------- */

/**
 * White card container with dual hairline box-shadow matching Figma
 * settings screen row group containers.
 */
const RowGroup: FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className,
}) => (
  <div
    className={`bg-white shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)] ${className ?? ''}`}
  >
    {children}
  </div>
);

/* ==========================================================================
 * ChatSettingsProps — Exported Interface
 * ========================================================================== */

/**
 * Props interface for the ChatSettings component.
 *
 * All props are optional to support both controlled (page-level routing)
 * and standalone (component preview) usage patterns.
 *
 * @property onBack - Callback when the "Settings" back button is pressed.
 *   Falls back to router.back() when not provided.
 * @property activeTab - Active tab identifier for TabBar. Defaults to 'settings'.
 * @property onTabPress - Callback when a TabBar tab is pressed.
 * @property className - Additional CSS class names for the root container.
 */
export interface ChatSettingsProps {
  /** Callback when the back button ("Settings") is pressed */
  onBack?: () => void;
  /** Currently active tab for the bottom TabBar (defaults to 'settings') */
  activeTab?: 'settings';
  /** Callback fired when any tab in the bottom TabBar is pressed */
  onTabPress?: (tab: string) => void;
  /** Additional CSS class names for the root container element */
  className?: string;
}

/* ==========================================================================
 * ChatSettings — Exported Component (Default Export)
 * ========================================================================== */

/**
 * ChatSettings — Chat-specific settings screen component.
 *
 * Renders the full Chat Settings screen matching Figma Screen 18 (node 0:9973)
 * with four distinct content groups inside white row group cards:
 *
 * 1. **Change Wallpaper** — standard navigation row with right chevron
 * 2. **Save to Camera Roll** — toggle row (OFF by default) with
 *    descriptive text below explaining the feature
 * 3. **Chat Backup** — standard navigation row with right chevron
 * 4. **Action Items** — three action rows separated by hairline separators:
 *    - Archive All Chats (blue text)
 *    - Clear All Chats (red destructive text)
 *    - Delete All Chats (red destructive text)
 *
 * The screen is framed by StatusBar (top, decorative), NavigationBar
 * (back navigation to Settings), and TabBar (bottom, Settings active).
 *
 * @example Page-level usage with routing
 * ```tsx
 * <ChatSettings
 *   onBack={() => router.push('/settings')}
 *   onTabPress={(tab) => router.push(`/${tab}`)}
 * />
 * ```
 *
 * @example Standalone preview
 * ```tsx
 * <ChatSettings />
 * ```
 */
const ChatSettings: FC<ChatSettingsProps> = ({
  onBack,
  activeTab: _activeTab = 'settings',
  onTabPress: _onTabPress,
  className = '',
}) => {
  // Note: activeTab and onTabPress retained in the interface for backward
  // compatibility but no longer used — parent (main) layout owns TabBar (Issue #11 fix).
  void _activeTab;
  void _onTabPress;
  /* Next.js App Router navigation — fallback for onBack when prop not provided */
  const router = useRouter();

  /* Toggle state for "Save to Camera Roll" — initially OFF per Figma Screen 18 */
  const [saveToCameraRoll, setSaveToCameraRoll] = useState<boolean>(false);

  /**
   * Handles back navigation to the Settings screen.
   * Prefers the provided onBack callback; falls back to router.back().
   * Wrapped in useCallback for referential stability.
   */
  const handleBack = useCallback(() => {
    if (onBack) {
      onBack();
    } else {
      router.back();
    }
  }, [onBack, router]);

  /**
   * Handles toggle change for "Save to Camera Roll".
   * Updates local state. Wrapped in useCallback for stable reference
   * passed to SettingsRow → Toggle component tree.
   */
  const handleToggleChange = useCallback((value: boolean) => {
    setSaveToCameraRoll(value);
  }, []);

  return (
    <div className={`flex flex-col min-h-screen bg-surface ${className}`}>
      {/* Visually hidden heading — <h2> because NavigationBar owns the page-level <h1> (R34) */}
      <h2 className="sr-only">Chat Settings</h2>

      {/* Simulated iOS status bar — decorative, hidden on small viewports */}
      <StatusBar />

      {/* iOS-style navigation bar — "Chats" title with "Settings" back action */}
      <NavigationBar
        title="Chats"
        leftAction={
          <span className="inline-flex items-center gap-[5px]">
            <BackChevron />
            <span>Settings</span>
          </span>
        }
        onLeftAction={handleBack}
      />

      {/* Scrollable content area — pb-[83px] accounts for fixed TabBar height */}
      <div className="flex-1 overflow-y-auto pb-[83px]" role="region" aria-label="Chat settings options">
        <div className="pt-[35px]">
          {/* ===========================================================
           * Group 1 — Change Wallpaper
           *
           * Single SettingsRow in white card: label + right chevron.
           * Figma: 375×47px, label at x=16, chevron at x=351.
           * =========================================================== */}
          <RowGroup>
            <SettingsRow label="Change Wallpaper" />
          </RowGroup>

          {/* ===========================================================
           * Group 2 — Save to Camera Roll + Description
           *
           * SettingsRow with iOS toggle (OFF state = gray #E5E5EA track).
           * Descriptive text below on bg-surface background.
           * Figma gap from Group 1: 35px.
           * =========================================================== */}
          <div className="mt-[35px]">
            <RowGroup>
              <SettingsRow
                label="Save to Camera Roll"
                showToggle
                toggleValue={saveToCameraRoll}
                onToggleChange={handleToggleChange}
              />
            </RowGroup>
            {/* Description text: SF Pro Text 400, 12px
              * BLITZY [COLOR]: Figma #636366 has no matching system color token.
              * Nearest is text-secondary (#8E8E93) but difference is clearly visible.
              * Using arbitrary Figma value for visual fidelity. */}
            <p className="px-4 pt-[6px] font-sans font-normal text-[12px] leading-[1.33em] tracking-[-0.001em] text-[#636366]">
              Automatically save photos and videos you receive to your
              iPhone&apos;s Camera Roll.
            </p>
          </div>

          {/* ===========================================================
           * Group 3 — Chat Backup
           *
           * Single SettingsRow in white card: label + right chevron.
           * Figma gap from description: ~23px (visually measured).
           * =========================================================== */}
          <RowGroup className="mt-[23px]">
            <SettingsRow label="Chat Backup" />
          </RowGroup>

          {/* ===========================================================
           * Group 4 — Action Items
           *
           * Three action rows in a single white card:
           *   1. "Archive All Chats" — blue text (#007AFF)
           *   2. "Clear All Chats" — red text (#FF3B30)
           *   3. "Delete All Chats" — red text (#FF3B30)
           * No icons, no chevrons. Hairline separators between rows
           * at x=16 (insetLeft=16), width=359.
           * Figma gap from Group 3: 35px.
           * =========================================================== */}
          <RowGroup className="mt-[35px]">
            <SettingsRow
              label="Archive All Chats"
              labelColor="blue"
              showChevron={false}
            />
            <Separator inset insetLeft={16} />
            <SettingsRow
              label="Clear All Chats"
              labelColor="destructive"
              showChevron={false}
            />
            <Separator inset insetLeft={16} />
            <SettingsRow
              label="Delete All Chats"
              labelColor="destructive"
              showChevron={false}
            />
          </RowGroup>
        </div>
      </div>

    </div>
  );
};

export default ChatSettings;
