'use client';

import React, { useState, useCallback } from 'react';
import type { FC } from 'react';
import { useRouter } from 'next/navigation';
import { NavigationBar } from '../common/NavigationBar';
import { TabBar } from '../common/TabBar';
import { SettingsRow } from '../common/SettingsRow';
import { Separator } from '../common/Separator';
import { StatusBar } from '../common/StatusBar';

/* ==========================================================================
   DataStorageSettings — Data and Storage Usage settings screen
   Figma Screen 20: WhatsApp Data and Storage Usage
   File key: miK1B6qEPrUnRZ9wwZNrW2 | Node: 0:10894 | 375×812px (iPhone X)
   ========================================================================== */

/**
 * Props interface for the DataStorageSettings component.
 * Defines optional callbacks and configuration for navigation and tab behavior.
 */
export interface DataStorageSettingsProps {
  /** Callback invoked when the back button is pressed. Falls back to router.back() if omitted. */
  onBack?: () => void;
  /** Active tab identifier for the bottom TabBar. Defaults to 'settings'. */
  activeTab?: 'settings';
  /** Callback invoked when a bottom tab is pressed. Receives the tab identifier string. */
  onTabPress?: (tab: string) => void;
  /** Additional CSS class names to apply to the root container element. */
  className?: string;
}

/**
 * Inline back chevron SVG matching the iOS-style navigation back arrow.
 * Figma node 0:10958 — Shape at (9, 55), 11.84×21px, fill #007AFF.
 * Uses stroke="currentColor" to inherit the parent button's text-blue-ios color.
 */
const BackChevron: FC = () => (
  <svg
    width="12"
    height="21"
    viewBox="0 0 12 21"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    className="inline-block align-middle"
  >
    <path
      d="M10.5 1L1.5 10.5L10.5 20"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/* Shared CSS class for section header text.
   Figma style_ZV74W0: SF Pro Text 400, 12px, lineHeight 1.193em, textCase UPPER.
   Figma fill_KN32HN: #636366.
   BLITZY [DESIGN_SYSTEM_GAP]: Color #636366 has no system token. Nearest token
   text-secondary (#8E8E93) differs by ~6 channel units. Using arbitrary value. */
const SECTION_HEADER_CLASS =
  'font-sans font-normal text-[12px] leading-[1.193em] text-[#636366] uppercase px-4';

/* Shared CSS class for description/footnote text below row groups.
   Figma style_OZO8AP: SF Pro Text 400, 12px, lineHeight 1.333em.
   Figma fill_KN32HN: #636366. Same gap as section headers. */
const DESCRIPTION_CLASS =
  'font-sans font-normal text-[12px] leading-[1.333em] text-[#636366] px-4';

/* Shared box-shadow value for white row-group cards.
   Figma effect_2L15D6: dual 0.33px inner shadows (top + bottom). */
const CARD_SHADOW =
  'shadow-[0px_-0.33px_0px_0px_rgba(60,60,67,0.29),0px_0.33px_0px_0px_rgba(60,60,67,0.29)]';

/**
 * DataStorageSettings — full-screen settings component for Data and Storage Usage.
 *
 * Maps 1:1 to Figma Screen 20 (node 0:10894). Renders three content sections:
 *   1. MEDIA AUTO-DOWNLOAD — Photos, Audio, Videos, Documents rows + Reset action.
 *   2. CALL SETTINGS — Low Data Usage toggle.
 *   3. Network Usage and Storage Usage navigation rows.
 *
 * Layout hierarchy: StatusBar → NavigationBar → scrollable content → fixed TabBar.
 */
const DataStorageSettings: FC<DataStorageSettingsProps> = ({
  onBack,
  activeTab = 'settings',
  onTabPress,
  className = '',
}) => {
  const router = useRouter();

  /** Local state for the Low Data Usage toggle — OFF by default per Figma. */
  const [lowDataUsage, setLowDataUsage] = useState<boolean>(false);

  /**
   * Navigates back to the Settings screen.
   * Delegates to onBack prop when provided; otherwise falls back to router.back().
   */
  const handleBack = useCallback(() => {
    if (onBack) {
      onBack();
    } else {
      router.back();
    }
  }, [onBack, router]);

  /**
   * Updates local Low Data Usage toggle state.
   */
  const handleToggleChange = useCallback((value: boolean) => {
    setLowDataUsage(value);
  }, []);

  /**
   * Delegates bottom tab press events to the parent via onTabPress prop.
   */
  const handleTabPress = useCallback(
    (tab: string) => {
      onTabPress?.(tab);
    },
    [onTabPress],
  );

  return (
    <div className={`min-h-screen bg-surface flex flex-col ${className}`.trim()}>
      {/* iOS Status Bar — simulated for desktop viewports (375×44px, bg #F7F7F7) */}
      <StatusBar />

      {/* Navigation Bar — "< Settings" back action + centered title
          Figma: y=0, 375×88px, bg #F6F6F6, shadow 0.33px bottom */}
      <NavigationBar
        title="Data and Storage Usage"
        leftAction={
          <span className="flex items-center gap-[5px]">
            <BackChevron />
            Settings
          </span>
        }
        onLeftAction={handleBack}
      />

      {/* Scrollable content area — between nav bar and fixed tab bar.
          pb-[83px] accounts for the fixed TabBar height (49px tabs + 34px safe area). */}
      <main
        className="flex-1 overflow-y-auto pb-[83px]"
        role="main"
        aria-label="Data and Storage Usage settings"
      >
        {/* pt-[29px] matches the Figma gap from nav bar bottom (y=88) to first section (y=117). */}
        <div className="pt-[29px]">

          {/* ================================================================
              SECTION 1: MEDIA AUTO-DOWNLOAD
              Figma: "Group Notifications" frame at y=117, 375×294px.
              Contains: section header, 5-row white card, description text.
              ================================================================ */}
          <section aria-labelledby="media-auto-download-header">
            <h2
              id="media-auto-download-header"
              className={SECTION_HEADER_CLASS}
            >
              Media auto-download
            </h2>

            {/* White row group card — Photos, Audio, Videos, Documents, Reset.
                Figma: Rectangle at y=20, 375×235px, effect_2L15D6 dual shadow. */}
            <div className={`mt-[6px] ${CARD_SHADOW}`}>
              {/* Row 1: Photos — value "Wi-Fi and Cellular"
                  Figma: row at y=20, label x=16, value x=211 */}
              <SettingsRow
                label="Photos"
                value="Wi-Fi and Cellular"
              />
              {/* Separator — Figma: x=16, y=66.5, w=359 */}
              <Separator inset insetLeft={16} />

              {/* Row 2: Audio — value "Wi-Fi"
                  Figma: row at y=67, label x=16, value x=300 */}
              <SettingsRow
                label="Audio"
                value="Wi-Fi"
              />
              <Separator inset insetLeft={16} />

              {/* Row 3: Videos — value "Wi-Fi"
                  Figma: row at y=114, label x=16, value x=300 */}
              <SettingsRow
                label="Videos"
                value="Wi-Fi"
              />
              <Separator inset insetLeft={16} />

              {/* Row 4: Documents — value "Wi-Fi"
                  Figma: row at y=161, label x=16, value x=300 */}
              <SettingsRow
                label="Documents"
                value="Wi-Fi"
              />
              {/* Separator between Documents and Reset — Figma: x=16, y=207.5 */}
              <Separator inset insetLeft={16} />

              {/* Row 5: Reset Auto-Download Settings — no chevron, gray text.
                  Figma: row at y=208, fill_NJ2FJ6 = rgba(60,60,67,0.6).
                  BLITZY [COLOR]: Figma rgba(60,60,67,0.6) ≈ #8A8A8E snapped to
                  system text-secondary (#8E8E93). ΔE < 5 channel units. */}
              <SettingsRow
                label="Reset Auto-Download Settings"
                showChevron={false}
                className="[&>div>span]:text-secondary"
              />
            </div>

            {/* Description — Figma text node 0:10929 at y=262, 343×32px,
                style_OZO8AP (12px/1.333em), fill_KN32HN (#636366). */}
            <p className={`mt-[7px] ${DESCRIPTION_CLASS}`}>
              Voice Messages are always automatically downloaded for the best
              communication experience.
            </p>
          </section>

          {/* ================================================================
              SECTION 2: CALL SETTINGS
              Figma: "Group Notifications" frame at y=436, 375×106px.
              Gap from section 1 bottom (y=411) to section 2 top (y=436) = 25px.
              ================================================================ */}
          <section
            aria-labelledby="call-settings-header"
            className="mt-[25px]"
          >
            <h2
              id="call-settings-header"
              className={SECTION_HEADER_CLASS}
            >
              Call Settings
            </h2>

            {/* White row card — Low Data Usage with toggle (OFF by default).
                Figma: Rectangle at y=20, 375×47px, Switch at (308, 8). */}
            <div className={`mt-[6px] ${CARD_SHADOW}`}>
              <SettingsRow
                label="Low Data Usage"
                showToggle
                toggleValue={lowDataUsage}
                onToggleChange={handleToggleChange}
              />
            </div>

            {/* Description — Figma text node 0:10940 at y=74, 343×32px.
                BLITZY [CONTENT]: Figma source text reads "WhatsAoo" — corrected
                to "WhatsApp" (apparent typo in source design file). */}
            <p className={`mt-[7px] ${DESCRIPTION_CLASS}`}>
              Lower the amount of data used during a WhatsApp call on cellular.
            </p>
          </section>

          {/* ================================================================
              SECTION 3: NETWORK & STORAGE USAGE
              Figma: "Rows" group at y=567, 375×94px.
              Gap from section 2 bottom (y=542) to section 3 top (y=567) = 25px.
              No section header — just two navigation rows.
              ================================================================ */}
          <div
            className={`mt-[25px] ${CARD_SHADOW}`}
            role="group"
            aria-label="Usage statistics"
          >
            {/* Row: Network Usage — Figma: row at y=0, label x=16, chevron at x=351. */}
            <SettingsRow label="Network Usage" />
            {/* Separator — Figma: x=16, y=46.5, w=359 */}
            <Separator inset insetLeft={16} />
            {/* Row: Storage Usage — Figma: row at y=47, label x=16, chevron at x=351. */}
            <SettingsRow label="Storage Usage" />
          </div>
        </div>
      </main>

      {/* Bottom tab bar — Settings tab active (blue #007AFF).
          Figma: y=729, 375×83px, fixed at bottom. */}
      <TabBar
        activeTab={activeTab}
        onTabPress={handleTabPress}
      />
    </div>
  );
};

export { DataStorageSettings };
export default DataStorageSettings;
