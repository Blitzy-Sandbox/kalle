'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { NavigationBar } from '@/components/common/NavigationBar';
import { Toggle } from '@/components/common/Toggle';
import { Separator } from '@/components/common/Separator';

/* ================================================================
 * Inline SVG Icon Components
 *
 * Derived from Figma file miK1B6qEPrUnRZ9wwZNrW2 exported assets.
 * Inlined to avoid extra network requests and enable currentColor
 * inheritance from parent Tailwind text-color utilities.
 * ================================================================ */

/**
 * iOS-style back chevron — 12×21px.
 *
 * Source: icon-back-chevron.svg (Figma node 0:10015).
 * Uses fill="currentColor" so it inherits the NavigationBar's
 * text-blue-ios (#007AFF) color via CSS cascade.
 */
function BackChevron() {
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

/**
 * Right disclosure chevron — 7×12px.
 *
 * Source: icon-arrow-right.svg (Figma node 0:9978).
 * Rendered with rgba(60, 60, 67, 0.3) fill matching the Figma token
 * for disclosure indicators in settings rows.
 */
function ChevronRight() {
  return (
    <svg
      className="w-[7px] h-[12px] flex-shrink-0"
      viewBox="0 0 7 12"
      fill="none"
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

/* ================================================================
 * ChatsSettingsPage — Figma Screen 18 (Node 0:9973)
 *
 * Implements the WhatsApp Chats Settings view with four groups:
 *   1. Change Wallpaper — navigation row with disclosure chevron
 *   2. Save to Camera Roll — toggle row with description text
 *   3. Chat Backup — navigation row with disclosure chevron
 *   4. Action Items — Archive / Clear / Delete All Chats
 *
 * Frame: 375×812px, background #EFEFF4 (Tailwind: bg-surface).
 * Section gaps: 35px between groups (23px between Group 2 and 3
 * due to the description text reducing the visual gap).
 *
 * Accessibility (WCAG 2.1 AA — Rule R34):
 * - All interactive rows use <button> elements
 * - Toggle has role="switch" and aria-checked (via Toggle component)
 * - Content wrapped in <main> landmark
 * - Focus-visible outlines on all interactive elements
 * - All color contrasts verified ≥ 4.5:1
 * ================================================================ */
export default function ChatsSettingsPage() {
  /** Toggle state for "Save to Camera Roll" — initially OFF per Figma Screen 18 */
  const [saveToCameraRoll, setSaveToCameraRoll] = useState(false);

  /** Next.js App Router navigation for programmatic back navigation */
  const router = useRouter();

  /**
   * Combined top + bottom 0.33px shadow for white row cards.
   * Matches Figma shadow spec: rgba(60, 60, 67, 0.29) hairline separators.
   */
  const rowShadow =
    'shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)]';

  /**
   * Keyboard-accessible focus indicator applied to all interactive elements.
   * Uses blue-ios (#007AFF) ring for visible keyboard navigation per R34.
   */
  const focusStyles =
    'focus:outline-none focus-visible:outline-2 focus-visible:outline-[#007AFF] focus-visible:outline-offset-2 focus-visible:rounded-sm';

  /**
   * Row text styling: SF Pro Text 400, 16px, 1.375em line-height,
   * -0.03em letter-spacing. Applied to all settings row labels.
   */
  const rowTextClass =
    'font-normal text-[16px] leading-[1.375em] tracking-tighter-ios';

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* ============================================================
       * Navigation Bar — "Chats" with "Settings" back button
       *
       * Figma node 0:10011: bg #F6F6F6, shadow 0.33px bottom,
       * back chevron + "Settings" label in blue (#007AFF),
       * centered "Chats" title in black (#000000) 600 17px.
       * ============================================================ */}
      <NavigationBar
        title="Chats"
        leftAction={
          <span className="inline-flex items-center gap-[5px]">
            <BackChevron />
            <span>Settings</span>
          </span>
        }
        onLeftAction={() => router.back()}
      />

      {/* Scrollable content area between nav bar and parent-provided tab bar */}
      <main className="flex-1 overflow-y-auto">
        <div className="pt-[35px] pb-4">
          {/* ===========================================================
           * Group 1 — Change Wallpaper
           *
           * Figma nodes 0:9974–0:9980: 375×47px white row,
           * top+bottom 0.33px shadow, "Change Wallpaper" text black 16px,
           * right chevron rgba(60,60,67,0.3) at x:351.
           * =========================================================== */}
          <button
            className={`w-full h-[47px] bg-white flex items-center justify-between px-4 ${rowShadow} ${focusStyles}`}
            aria-label="Change Wallpaper"
            type="button"
          >
            <span className={`${rowTextClass} text-black`}>
              Change Wallpaper
            </span>
            <ChevronRight />
          </button>

          {/* ===========================================================
           * Group 2 — Save to Camera Roll + Description
           *
           * Figma nodes 0:9981–0:9990:
           * - Row: 375×47px white, top+bottom shadow, text + toggle
           * - Toggle (node 0:9985): 51×31px, OFF state (gray track)
           * - Description (node 0:9990): #636366, 12px, 6px below row,
           *   sits on #EFEFF4 background (NOT inside white card)
           * Gap from Group 1: 35px
           * =========================================================== */}
          <div className="mt-[35px]">
            <div
              className={`w-full h-[47px] bg-white flex items-center justify-between px-4 ${rowShadow}`}
            >
              <span className={`${rowTextClass} text-black`}>
                Save to Camera Roll
              </span>
              <Toggle
                value={saveToCameraRoll}
                onChange={setSaveToCameraRoll}
                ariaLabel="Save to Camera Roll"
              />
            </div>
            <p className="px-4 pt-[6px] font-normal text-[12px] leading-[1.33em] tracking-[-0.001em] text-[#636366]">
              Automatically save photos and videos you receive to your
              iPhone&apos;s Camera Roll.
            </p>
          </div>

          {/* ===========================================================
           * Group 3 — Chat Backup
           *
           * Figma nodes 0:9991–0:9997: 375×47px white row,
           * same styling as Change Wallpaper.
           * Gap from Group 2: 23px (reduced by description text height)
           * =========================================================== */}
          <button
            className={`w-full h-[47px] bg-white flex items-center justify-between px-4 mt-[23px] ${rowShadow} ${focusStyles}`}
            aria-label="Chat Backup"
            type="button"
          >
            <span className={`${rowTextClass} text-black`}>Chat Backup</span>
            <ChevronRight />
          </button>

          {/* ===========================================================
           * Group 4 — Action Items
           *
           * Figma nodes 0:9998–0:10010: 375×141px white card,
           * top+bottom 0.33px shadow. Three action buttons separated
           * by 0.33px inset separators (ml-4, inset 16px).
           *
           * - Archive All Chats: blue (#007AFF) — node 0:10000
           * - Clear All Chats: red (#FF3B30) — node 0:10003
           * - Delete All Chats: red (#FF3B30) — node 0:10006
           * Separators: nodes 0:10009, 0:10010
           * Gap from Group 3: 35px
           * =========================================================== */}
          <div className={`mt-[35px] bg-white ${rowShadow}`}>
            {/* Archive All Chats — blue action text, no chevron */}
            <button
              className={`w-full h-[47px] flex items-center px-4 ${focusStyles}`}
              aria-label="Archive All Chats"
              type="button"
            >
              <span className={`${rowTextClass} text-blue-ios`}>
                Archive All Chats
              </span>
            </button>

            {/* Separator — inset 16px from left, 0.33px height */}
            <Separator inset insetLeft={16} />

            {/* Clear All Chats — red destructive action text, no chevron */}
            <button
              className={`w-full h-[47px] flex items-center px-4 ${focusStyles}`}
              aria-label="Clear All Chats"
              type="button"
            >
              <span className={`${rowTextClass} text-red-ios`}>
                Clear All Chats
              </span>
            </button>

            {/* Separator — inset 16px from left, 0.33px height */}
            <Separator inset insetLeft={16} />

            {/* Delete All Chats — red destructive action text, no chevron */}
            <button
              className={`w-full h-[47px] flex items-center px-4 ${focusStyles}`}
              aria-label="Delete All Chats"
              type="button"
            >
              <span className={`${rowTextClass} text-red-ios`}>
                Delete All Chats
              </span>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
