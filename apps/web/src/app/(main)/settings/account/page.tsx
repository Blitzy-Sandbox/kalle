'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { NavigationBar } from '@/components/common/NavigationBar';
import { Separator } from '@/components/common/Separator';

/* ============================================================
 * Row Data — Account Settings Menu Items
 *
 * Two groups matching Figma Screen 17 (node 0:9371, file key
 * miK1B6qEPrUnRZ9wwZNrW2). Each row is a plain text label
 * with a right chevron — no colored icons.
 * ============================================================ */

/** Group 1: Privacy, Security, Two-Step Verification, Change Number */
const group1Items: ReadonlyArray<{ readonly label: string }> = [
  { label: 'Privacy' },
  { label: 'Security' },
  { label: 'Two-Step Verification' },
  { label: 'Change Number' },
] as const;

/** Group 2: Request Account Info, Delete My Account */
const group2Items: ReadonlyArray<{ readonly label: string }> = [
  { label: 'Request Account Info' },
  { label: 'Delete My Account' },
] as const;

/* ============================================================
 * Inline SVG Components
 *
 * Extracted from Figma asset exports to avoid external file
 * dependencies within the page component. Uses currentColor
 * for theme-aware coloring where appropriate.
 * ============================================================ */

/**
 * Back chevron SVG — 12×21px viewBox, rendered at the navigation
 * bar's back button position. Uses currentColor to inherit
 * text-blue-ios (#007AFF) from the NavigationBar action button.
 *
 * Source: icon-back-chevron.svg (Figma node 0:8257)
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
 * Right chevron arrow SVG — 7×12px viewBox, rendered at the
 * trailing edge of each settings row. Color matches Figma
 * separator opacity: rgba(60, 60, 67, 0.3).
 *
 * Source: icon-arrow-right.svg (Figma node 0:8883)
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

/* ============================================================
 * RowGroup — Reusable settings group renderer
 *
 * Renders a white card container with top+bottom 0.33px shadow
 * borders and inset separators between rows. Each row is a
 * <button> for keyboard accessibility (WCAG 2.1 AA R34).
 *
 * Figma specs per row (node 0:9374 pattern):
 * - Height: 47px
 * - Background: #FFFFFF
 * - Text: x:16, y:12, SF Pro Text 400 16px/1.375em/-0.03em, #000000
 * - Chevron: x:351, y:17.5, 7×12px, rgba(60,60,67,0.3)
 * - Separator: x:16, 0.33px, rgba(60,60,67,0.29) — between rows only
 * ============================================================ */

interface RowGroupProps {
  /** Array of row items with label text */
  readonly items: ReadonlyArray<{ readonly label: string }>;
}

/**
 * Renders a group of account settings rows inside a white card
 * with combined top+bottom hairline shadow borders matching Figma.
 */
function RowGroup({ items }: RowGroupProps) {
  return (
    <div
      className="bg-white shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)]"
      role="group"
    >
      {items.map((item, index) => (
        <React.Fragment key={item.label}>
          {/* Settings row button — 47px height, full width */}
          <button
            type="button"
            className={[
              'w-full h-[47px] bg-white',
              'flex items-center justify-between',
              'ps-4 pe-4',
              'focus-visible:outline focus-visible:outline-2',
              'focus-visible:outline-blue-ios focus-visible:outline-offset-[-2px]',
            ].join(' ')}
            aria-label={item.label}
          >
            {/* Row label text — SF Pro Text 400 16px/1.375em, tracking -0.03em, #000000 */}
            <span className="font-normal text-[16px] leading-[1.375em] tracking-tighter-ios text-black">
              {item.label}
            </span>
            {/* Right chevron disclosure indicator */}
            <ChevronRight />
          </button>

          {/* Inset separator between rows — not after the last row */}
          {index < items.length - 1 && (
            <Separator inset insetLeft={16} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

/* ============================================================
 * AccountSettingsPage — Figma Screen 17 (node 0:9371)
 *
 * Implements the WhatsApp Account settings sub-page with:
 * - NavigationBar: "Account" title, "Settings" back button
 * - Group 1: Privacy, Security, Two-Step Verification, Change Number
 * - Group 2: Request Account Info, Delete My Account
 *
 * All spacing derived from Figma gap analysis:
 * - 35px between NavigationBar and Group 1
 * - 35px between Group 1 and Group 2
 *
 * Tab bar rendered by parent (main)/layout.tsx — NOT here.
 * ============================================================ */

/**
 * Account settings page component.
 *
 * Renders a navigational settings sub-page with two groups of
 * menu items. All rows use `<button>` elements for keyboard
 * accessibility and include visible focus indicators per WCAG
 * 2.1 AA (Rule R34). No business logic — purely presentational.
 */
export default function AccountSettingsPage() {
  const router = useRouter();

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Visually hidden page heading for screen readers (WCAG landmark) */}
      <h1 className="sr-only">Account Settings</h1>

      {/* iOS-style navigation bar — centered "Account" title with back navigation */}
      <NavigationBar
        title="Account"
        leftAction={
          <span className="inline-flex items-center gap-[5px]">
            <BackChevron />
            <span>Settings</span>
          </span>
        }
        onLeftAction={() => router.back()}
      />

      {/* Scrollable content area */}
      <main className="flex-1 overflow-y-auto">
        {/* Group 1 — Privacy / Security / Two-Step Verification / Change Number
            Figma node 0:9372: y=123 (35px below nav bar bottom) */}
        <div className="mt-[35px]">
          <RowGroup items={group1Items} />
        </div>

        {/* Group 2 — Request Account Info / Delete My Account
            Figma node 0:9397: y=346 (35px below Group 1 bottom) */}
        <div className="mt-[35px]">
          <RowGroup items={group2Items} />
        </div>
      </main>
    </div>
  );
}
