'use client';

import React, { FC, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { NavigationBar } from '../common/NavigationBar';
import { TabBar } from '../common/TabBar';
import type { TabId } from '../common/TabBar';
import { SettingsRow } from '../common/SettingsRow';
import { Separator } from '../common/Separator';
import { StatusBar } from '../common/StatusBar';

// =============================================================================
// NotificationSettings — Figma Screen 19 (WhatsApp Notifications)
// =============================================================================
//
// Maps 1:1 to Figma node 0:10758 from file miK1B6qEPrUnRZ9wwZNrW2.
// Renders the full notification settings screen with:
//   - Warning banner about disabled push notifications
//   - MESSAGE NOTIFICATIONS section (Show Notifications toggle, Sound row)
//   - GROUP NOTIFICATIONS section (identical layout)
//   - In-App Notifications row with subtitle
//   - Show Preview toggle with description text
//   - Reset Notification Settings destructive action with description
//
// Design tokens (from AAP Section 0.5.2 / 0.6.3):
//   Background:       #EFEFF4  → bg-surface
//   Section headers:   #636366  → text-[#636366], uppercase, 12px
//   Row backgrounds:   #FFFFFF  → bg-white
//   Row card shadows:  0px ±0.33px rgba(60,60,67,0.29) → combined shadow
//   Toggle on:         #4CD964  → (handled by Toggle inside SettingsRow)
//   Destructive text:  #FF3B30  → labelColor='destructive' on SettingsRow
//   Description text:  #8E8E93  → text-secondary, 12px
//   Separators:        rgba(60,60,67,0.29) → bg-separator, insetLeft=16
//
// Accessibility (R34 — WCAG 2.1 AA):
//   - All toggles have aria-label (via SettingsRow's Toggle component)
//   - Keyboard navigable rows and toggles
//   - Warning text uses role="alert" for screen reader announcement
//   - Descriptive section headers for context
//   - Focus visible indicators on all interactive elements
// =============================================================================

/**
 * Props interface for the NotificationSettings component.
 *
 * @property onBack - Optional callback for back navigation. Falls back to router.back().
 * @property activeTab - Currently active tab identifier. Defaults to 'settings'.
 * @property onTabPress - Callback when a tab bar tab is pressed.
 * @property className - Additional CSS class names for the root container.
 */
export interface NotificationSettingsProps {
  /** Callback for back navigation. Falls back to router.back() when not provided. */
  onBack?: () => void;
  /** Active tab identifier for the bottom TabBar. Defaults to 'settings'. */
  activeTab?: 'settings';
  /** Callback fired when a tab in the bottom TabBar is pressed. */
  onTabPress?: (tab: string) => void;
  /** Additional CSS class names appended to the root container element. */
  className?: string;
}

/**
 * Back chevron icon — inline SVG matching iOS back navigation pattern.
 *
 * Renders a blue (#007AFF) left-pointing chevron arrow used in NavigationBar
 * leftAction alongside the "Settings" back label text. Dimensions: 10×18px.
 */
const BackChevronIcon: FC = () => (
  <svg
    width="10"
    height="18"
    viewBox="0 0 10 18"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    className="inline-block mr-1"
  >
    <path
      d="M9 1L1 9L9 17"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * NotificationSettings — Full notification settings screen.
 *
 * Renders the complete WhatsApp Notifications settings page matching
 * Figma Screen 19 (node 0:10758). The screen includes warning banner,
 * message/group notification toggles, in-app notification options,
 * show preview toggle, and reset action.
 *
 * State management:
 * - messageNotifications: Controls "Show Notifications" toggle in MESSAGE section
 * - groupNotifications: Controls "Show Notifications" toggle in GROUP section
 * - showPreview: Controls "Show Preview" toggle
 *
 * All toggles default to ON (true) matching the Figma default state.
 *
 * @example
 * ```tsx
 * <NotificationSettings
 *   onBack={() => router.push('/settings')}
 *   activeTab="settings"
 *   onTabPress={(tab) => router.push(`/${tab}`)}
 * />
 * ```
 */
export const NotificationSettings: FC<NotificationSettingsProps> = ({
  onBack,
  activeTab = 'settings',
  onTabPress,
  className = '',
}) => {
  const router = useRouter();

  /* ---- Toggle state: all default ON per Figma default frame ---- */
  const [messageNotifications, setMessageNotifications] = useState<boolean>(true);
  const [groupNotifications, setGroupNotifications] = useState<boolean>(true);
  const [showPreview, setShowPreview] = useState<boolean>(true);

  /* ---- Navigation handlers ---- */
  const handleBack = useCallback(() => {
    if (onBack) {
      onBack();
    } else {
      router.back();
    }
  }, [onBack, router]);

  const handleTabPress = useCallback(
    (tab: TabId) => {
      onTabPress?.(tab);
    },
    [onTabPress],
  );

  /* ---- Toggle change handlers (memoized) ---- */
  const handleMessageNotifToggle = useCallback((value: boolean) => {
    setMessageNotifications(value);
  }, []);

  const handleGroupNotifToggle = useCallback((value: boolean) => {
    setGroupNotifications(value);
  }, []);

  const handleShowPreviewToggle = useCallback((value: boolean) => {
    setShowPreview(value);
  }, []);

  /* ---- Shared class for row group white cards with dual 0.33px hairline shadows ---- */
  const rowGroupClasses =
    'bg-white shadow-[0px_-0.33px_0px_rgba(60,60,67,0.29),0px_0.33px_0px_rgba(60,60,67,0.29)]';

  /* ---- Shared class for section header text ---- */
  /* Figma style_UMCZ9W: SF Pro Text 400, 12px, lineHeight 1.19em, uppercase, #636366 */
  /* pt varies per section — applied inline; pb-[6px] for gap between header and card */
  const sectionHeaderClasses =
    'px-4 pb-[6px] text-[12px] leading-[1.19em] font-normal text-[#636366] uppercase tracking-[-0.01em]';

  /* ---- Shared class for description text below row groups ---- */
  /* Figma style_JCH9M0: SF Pro Text 400, 12px, lineHeight 1.33em, #636366 */
  const descriptionClasses =
    'px-4 pt-[7px] text-[12px] leading-[1.33em] font-normal text-[#636366]';

  return (
    <div
      className={[
        'min-h-screen bg-surface flex flex-col',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* ================================================================
       * iOS Status Bar — decorative, hidden on mobile (md:flex)
       * Figma: 375×44px, bg #F7F7F7
       * ================================================================ */}
      <StatusBar />

      {/* ================================================================
       * Navigation Bar — "Settings" back + "Notifications" title
       * Figma: bg #F6F6F6, shadow 0px 0.33px, title 600/17px centered
       * ================================================================ */}
      <NavigationBar
        title="Notifications"
        leftAction={
          <span className="flex items-center">
            <BackChevronIcon />
            Settings
          </span>
        }
        onLeftAction={handleBack}
      />

      {/* ================================================================
       * Scrollable Content Area
       * Bottom padding accounts for fixed TabBar (83px) + safe area
       * ================================================================ */}
      <div className="flex-1 overflow-y-auto pb-[117px]" role="region" aria-label="Notification settings">
        {/* ==============================================================
         * Warning Banner
         * Figma node 0:10793 — frame at y=103, 343×78, centered
         * Text: 14px, centered, rgba(84,84,88,0.65)
         * Line separator at bottom: 1px, rgba(84,84,88,0.65)
         * ============================================================== */}
        <div className="mt-[15px] mx-4" role="alert">
          <p
            className="text-[14px] leading-[1.5em] font-normal text-center tracking-[-0.01em]"
            style={{ color: 'rgba(84, 84, 88, 0.65)' }}
          >
            WARNING: Push Notifications are disabled. To enable visit:
            <br />
            iPhone Settings &gt; Notifications &gt; WhatsApp
          </p>
          {/* Warning bottom separator — 1px, rgba(84,84,88,0.65) per Figma node 0:10795 */}
          <div
            className="mt-[14px] h-px w-full"
            style={{ backgroundColor: 'rgba(84, 84, 88, 0.65)' }}
          />
        </div>

        {/* ==============================================================
         * MESSAGE NOTIFICATIONS Section
         * Figma node 0:10759 — y=210, 375×114
         * Gap from warning bottom: 29px
         * ============================================================== */}
        <h2 className={`${sectionHeaderClasses} mt-[29px]`}>
          Message notifications
        </h2>
        <div className={rowGroupClasses}>
          <SettingsRow
            label="Show Notifications"
            showToggle
            toggleValue={messageNotifications}
            onToggleChange={handleMessageNotifToggle}
            showChevron={false}
          />
          <Separator inset insetLeft={16} />
          <SettingsRow
            label="Sound"
            value="Note"
            showChevron
          />
        </div>

        {/* ==============================================================
         * GROUP NOTIFICATIONS Section
         * Figma node 0:10776 — y=355, 375×114
         * Gap from message section bottom: 31px
         * ============================================================== */}
        <h2 className={`${sectionHeaderClasses} mt-[31px]`}>
          Group notifications
        </h2>
        <div className={rowGroupClasses}>
          <SettingsRow
            label="Show Notifications"
            showToggle
            toggleValue={groupNotifications}
            onToggleChange={handleGroupNotifToggle}
            showChevron={false}
          />
          <Separator inset insetLeft={16} />
          <SettingsRow
            label="Sound"
            value="Note"
            showChevron
          />
        </div>

        {/* ==============================================================
         * IN-APP NOTIFICATIONS
         * Figma node 0:10796 — y=504, 375×61
         * Gap from group section bottom: 35px
         * Label + subtitle row with chevron
         * ============================================================== */}
        <div className="mt-[35px]">
          <div className={rowGroupClasses}>
            {/* BLITZY [LAYOUT]: Figma node 0:10796 is a 61px two-line stacked
              * layout (label y:10, subtitle y:36, 11px). SettingsRow renders
              * label + value side-by-side, causing truncation. Custom row
              * used for Figma fidelity. */}
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-[10px] bg-white text-start"
              style={{ minHeight: '61px' }}
            >
              <div className="flex flex-col">
                <span className="text-[16px] font-normal leading-[1.375em] tracking-[-0.02em] text-black">
                  In-App Notifications
                </span>
                <span className="mt-[4px] text-[11px] font-normal leading-[1.182em] tracking-[0.005em] text-black">
                  Banners, Sounds, Vibrate
                </span>
              </div>
              {/* Right chevron — matches Figma Arrow Right 7×12 at x:351 */}
              <svg
                width="7"
                height="12"
                viewBox="0 0 7 12"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
                className="shrink-0 ms-2"
              >
                <path
                  d="M1 1L6 6L1 11"
                  stroke="rgba(60,60,67,0.3)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* ==============================================================
         * SHOW PREVIEW Section
         * Figma node 0:10808 — y=600, 375×70
         * Gap from In-App bottom: 35px
         * Toggle row + description inside the section frame
         * ============================================================== */}
        <div className="mt-[35px]">
          <div className={rowGroupClasses}>
            <SettingsRow
              label="Show Preview"
              showToggle
              toggleValue={showPreview}
              onToggleChange={handleShowPreviewToggle}
              showChevron={false}
            />
          </div>
          {/* Figma node 0:10817 — description at y=54 within frame */}
          <p className={descriptionClasses}>
            Preview message text inside new message notifications.
          </p>
        </div>

        {/* ==============================================================
         * RESET NOTIFICATION SETTINGS
         * Figma node 0:10803 — y=692, 375×47
         * Gap from Show Preview bottom: 22px
         * Destructive action row (red #FF3B30). No icon, no chevron.
         * ============================================================== */}
        <div className="mt-[22px]">
          <div className={rowGroupClasses}>
            <SettingsRow
              label="Reset Notification Settings"
              labelColor="destructive"
              showChevron={false}
            />
          </div>
          {/* BLITZY [CONTENT]: Reset description specified in AAP but absent from
            * Figma node 0:10803 static frame (row extends past tab bar y:729).
            * Included per AAP requirement. */}
          <p className={descriptionClasses}>
            Reset notification tone and vibrate settings.
          </p>
        </div>
      </div>

      {/* ================================================================
       * Tab Bar — Settings tab active
       * Fixed bottom, 5 tabs, 83px total height (49px + 34px safe area)
       * ================================================================ */}
      <TabBar
        activeTab={activeTab}
        onTabPress={handleTabPress}
      />
    </div>
  );
};

export default NotificationSettings;
