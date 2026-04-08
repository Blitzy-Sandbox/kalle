'use client';

// =============================================================================
// DataStorageUsagePage — WhatsApp Data and Storage Usage screen
// Figma Screen 20, node 0:10894, file key miK1B6qEPrUnRZ9wwZNrW2
//
// Layout sections (top-to-bottom):
//   1. NavigationBar with back chevron + "Settings" label
//   2. MEDIA AUTO-DOWNLOAD — Photos, Audio, Videos, Documents rows + Reset action
//   3. CALL SETTINGS — Low Data Usage toggle
//   4. Network & Storage Usage — two navigation rows
//
// Design tokens sourced from Figma Token Manifest § 0.5.2:
//   - Page bg: #EFEFF4 (surface), Card bg: #FFFFFF
//   - Section headers: #636366, 12px, uppercase
//   - Row labels: #000000, 16px; Values: text-secondary, 16px
//   - Card shadow: ±0.33px rgba(60,60,67,0.29)
//   - Separators: 0.33px rgba(60,60,67,0.29), inset 16px (no icon rows)
// =============================================================================

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { NavigationBar } from '@/components/common/NavigationBar';
import { SettingsRow } from '@/components/common/SettingsRow';
import { Toggle } from '@/components/common/Toggle';
import { Separator } from '@/components/common/Separator';

// -----------------------------------------------------------------------------
// BackChevron — Inline SVG for iOS-style back navigation arrow.
// Matches the established codebase pattern (AccountSettings, ChatsSettings, etc.)
// Figma node 0:10958: 11.84×21px, fill #007AFF (inherited via currentColor).
// viewBox 0 0 12 21 — dimensions controlled by parent className.
// -----------------------------------------------------------------------------
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

// =============================================================================
// DataStorageUsagePage — Default export
// Renders the complete Data and Storage Usage settings screen.
// State: lowDataUsage (boolean) for the Call Settings toggle.
// =============================================================================
export default function DataStorageUsagePage() {
  const router = useRouter();

  // Toggle state for the "Low Data Usage" setting in Call Settings section.
  // Default OFF per Figma node 0:10934 (thumb at left position).
  const [lowDataUsage, setLowDataUsage] = useState(false);

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Accessible heading — visually hidden, provides page landmark for SR */}
      <h1 className="sr-only">Data and Storage Usage</h1>

      {/* ------------------------------------------------------------------
          Navigation Bar — Figma node 0:10954
          Title: "Data and Storage Usage", centered, semibold 17px
          Left: back chevron (blue) + "Settings" text (blue)
          ------------------------------------------------------------------ */}
      <NavigationBar
        title="Data and Storage Usage"
        leftAction={
          <span className="inline-flex items-center gap-[5px]">
            <BackChevron />
            <span>Settings</span>
          </span>
        }
        onLeftAction={() => router.push('/settings')}
      />

      {/* Scrollable content area with bottom padding for tab bar safe area */}
      <div className="flex-1 overflow-y-auto pb-[100px]" role="region" aria-label="Data and storage settings">
        {/* ================================================================
            Section 1: MEDIA AUTO-DOWNLOAD
            Figma node 0:10895 — 375×294px, y:117
            Gap from nav bar bottom: 29px
            ================================================================ */}
        <section
          className="mt-[29px]"
          aria-labelledby="media-auto-download-heading"
        >
          {/* Section Header — Figma node 0:10924 */}
          <h2
            id="media-auto-download-heading"
            className="font-sans font-normal text-[12px] leading-[1.19em] tracking-[-0.001em] text-[#636366] uppercase px-4"
          >
            Media auto-download
          </h2>

          {/* Card container — Figma node 0:10896, 375×235px */}
          <div
            className="mt-[6px] bg-white shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)]"
            role="group"
            aria-label="Media auto-download settings"
          >
            {/* Row: Photos — Figma node 0:10912 */}
            <SettingsRow label="Photos" value="Wi-Fi and Cellular" />
            <Separator inset insetLeft={16} />

            {/* Row: Audio — Figma node 0:10897 */}
            <SettingsRow label="Audio" value="Wi-Fi" />
            <Separator inset insetLeft={16} />

            {/* Row: Videos — Figma node 0:10918 */}
            <SettingsRow label="Videos" value="Wi-Fi" />
            <Separator inset insetLeft={16} />

            {/* Row: Documents — Figma node 0:10903 */}
            <SettingsRow label="Documents" value="Wi-Fi" />
            <Separator inset insetLeft={16} />

            {/* Row: Reset Auto-Download Settings — Figma node 0:10909
                Custom element: gray muted text rgba(60,60,67,0.6), no chevron.
                SettingsRow labelColor doesn't support this shade — renders inline.
                Per DS2-h, no business logic behind the action. */}
            <div
              role="button"
              tabIndex={0}
              className="flex items-center h-[47px] bg-white pl-4 pr-4 cursor-pointer active:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-inset"
              aria-label="Reset Auto-Download Settings"
              onClick={() => {
                /* Presentational only — no business logic per DS2-h */
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  /* Presentational only — no business logic per DS2-h */
                }
              }}
            >
              <span className="font-sans font-normal text-[16px] leading-[1.375em] tracking-[-0.033em] text-[rgba(60,60,67,0.6)]">
                Reset Auto-Download Settings
              </span>
            </div>
          </div>

          {/* Voice Messages description — Figma node 0:10929
              7px below card bottom edge. 12px, #636366. */}
          <p className="font-sans font-normal text-[12px] leading-[1.33em] text-[#636366] px-4 mt-[7px]">
            Voice Messages are always automatically downloaded for the best
            communication experience.
          </p>
        </section>

        {/* ================================================================
            Section 2: CALL SETTINGS
            Figma node 0:10930 — 375×106px, y:436
            Gap from Section 1: 25px
            ================================================================ */}
        <section
          className="mt-[25px]"
          aria-labelledby="call-settings-heading"
        >
          {/* Section Header — Figma node 0:10939 */}
          <h2
            id="call-settings-heading"
            className="font-sans font-normal text-[12px] leading-[1.19em] tracking-[-0.001em] text-[#636366] uppercase px-4"
          >
            Call Settings
          </h2>

          {/* Card container — Figma node 0:10931, single row */}
          <div
            className="mt-[6px] bg-white shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)]"
            role="group"
            aria-label="Call settings"
          >
            {/* Row: Low Data Usage — Figma node 0:10932
                47px tall row with label left, toggle right.
                Toggle OFF by default (Figma node 0:10934, thumb at left).
                Uses Toggle component directly for explicit import usage. */}
            <div className="flex items-center justify-between h-[47px] bg-white pl-4 pr-4">
              <span className="font-sans font-normal text-[16px] leading-[1.375em] tracking-[-0.033em] text-black">
                Low Data Usage
              </span>
              <Toggle
                value={lowDataUsage}
                onChange={setLowDataUsage}
                ariaLabel="Toggle Low Data Usage"
              />
            </div>
          </div>

          {/* Description text — Figma node 0:10940
              7px below card. 12px, #636366.
              Note: Figma contains typo "WhatsAoo" — corrected to "WhatsApp". */}
          <p className="font-sans font-normal text-[12px] leading-[1.33em] text-[#636366] px-4 mt-[7px]">
            Lower the amount of data used during a WhatsApp call on cellular.
          </p>
        </section>

        {/* ================================================================
            Section 3: NETWORK & STORAGE USAGE
            Figma node 0:10941 — 375×94px, y:567
            Gap from Section 2: 25px. NO section header.
            ================================================================ */}
        <section className="mt-[25px]" aria-label="Network and storage usage">
          {/* Card container — Figma node 0:10942 */}
          <div
            className="bg-white shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)]"
            role="group"
            aria-label="Network and storage usage options"
          >
            {/* Row: Network Usage — Figma node 0:10943 */}
            <SettingsRow label="Network Usage" />
            <Separator inset insetLeft={16} />

            {/* Row: Storage Usage — Figma node 0:10948 */}
            <SettingsRow label="Storage Usage" />
          </div>
        </section>
      </div>
    </div>
  );
}
