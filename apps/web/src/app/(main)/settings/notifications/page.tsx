'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { NavigationBar } from '@/components/common/NavigationBar';
import { Toggle } from '@/components/common/Toggle';
import { Separator } from '@/components/common/Separator';

/* ============================================================
 * Inline SVG Icons
 *
 * BackChevron: 12×21px blue (#007AFF) back arrow matching Figma
 * node 0:10822 from icon-back-chevron.svg
 *
 * ChevronRight: 7×12px gray (rgba(60,60,67,0.3)) right arrow
 * matching Figma row disclosure indicator from icon-arrow-right.svg
 * ============================================================ */

/**
 * iOS-style back chevron arrow in blue (#007AFF).
 * Dimensions match Figma node 0:10822: 11.84×21px.
 */
const BackChevron = () => (
  <svg
    width="12"
    height="21"
    viewBox="0 0 12 21"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    className="flex-shrink-0"
  >
    <path
      d="M3.60206 10.5L11.4062 2.55085C11.9866 1.9597 11.9778 1.00999 11.3867 0.429623C10.7955 -0.150747 9.84583 -0.142006 9.26546 0.449147L0.429623 9.44915C-0.143208 10.0326 -0.143208 10.9674 0.429623 11.5509L9.26546 20.5509C9.84583 21.142 10.7955 21.1507 11.3867 20.5704C11.9778 19.99 11.9866 19.0403 11.4062 18.4491L3.60206 10.5Z"
      fill="#007AFF"
    />
  </svg>
);

/**
 * iOS-style right disclosure chevron in gray (rgba(60, 60, 67, 0.3)).
 * Dimensions match Figma row indicator: 7×12px.
 */
const ChevronRight = () => (
  <svg
    width="7"
    height="12"
    viewBox="0 0 7 12"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    className="flex-shrink-0"
  >
    <path
      d="M4.58579 6L0.292893 10.2929C-0.0976311 10.6834 -0.0976311 11.3166 0.292893 11.7071C0.683418 12.0976 1.31658 12.0976 1.70711 11.7071L6.70711 6.70711C7.09763 6.31658 7.09763 5.68342 6.70711 5.29289L1.70711 0.292893C1.31658 -0.0976311 0.683418 -0.0976311 0.292893 0.292893C-0.0976311 0.683418 -0.0976311 1.31658 0.292893 1.70711L4.58579 6Z"
      fill="#3C3C43"
      fillOpacity="0.3"
    />
  </svg>
);

/* ============================================================
 * Shared card shadow class — matches Figma combined top + bottom
 * 0.33px shadow: rgba(60, 60, 67, 0.29) used on all settings
 * card containers throughout Screen 19 (node 0:10758).
 * ============================================================ */
const CARD_SHADOW_CLASS =
  'shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)]';

/* ============================================================
 * NotificationSection — Reusable inner component
 *
 * MESSAGE NOTIFICATIONS (node 0:10759) and GROUP NOTIFICATIONS
 * (node 0:10776) share identical layout: section header → card
 * with toggle row + separator + sound row. Parameterized by
 * title and toggle state to avoid duplication.
 * ============================================================ */

interface NotificationSectionProps {
  /** Section header text displayed in uppercase above the card */
  title: string;
  /** Current toggle state for the "Show Notifications" switch */
  showNotifications: boolean;
  /** Callback when the "Show Notifications" toggle changes */
  onToggleNotifications: (value: boolean) => void;
  /** Accessible label for the toggle switch (WCAG R34) */
  toggleAriaLabel: string;
  /** Accessible label for the sound button (WCAG R34) */
  soundAriaLabel: string;
}

function NotificationSection({
  title,
  showNotifications,
  onToggleNotifications,
  toggleAriaLabel,
  soundAriaLabel,
}: NotificationSectionProps) {
  return (
    <section aria-label={title}>
      {/* Section header — uppercase 12px #636366
       * Figma: SF Pro Text 400, 12px, 1.19em, letter-spacing -0.08%
       * Tailwind: text-[12px] leading-[1.19em] tracking-[-0.001em] */}
      <p className="uppercase text-[12px] leading-[1.19em] tracking-[-0.001em] text-[#636366] px-4 pb-[6px]">
        {title}
      </p>

      {/* Card container — white bg with top + bottom 0.33px shadow */}
      <div className={`bg-white ${CARD_SHADOW_CLASS}`}>
        {/* Show Notifications row — 375×47px
         * Figma: text at x:16 y:12, toggle at x:308 y:8 */}
        <div className="flex items-center justify-between h-[47px] px-4">
          <span className="text-[16px] leading-[1.375em] tracking-[-0.03em] text-black">
            Show Notifications
          </span>
          <Toggle
            value={showNotifications}
            onChange={onToggleNotifications}
            ariaLabel={toggleAriaLabel}
          />
        </div>

        {/* Separator — indented from left 16px, width 359px
         * Figma: node 0:10775 / 0:10792, x:16, 0.33px rgba(60,60,67,0.29) */}
        <Separator inset insetLeft={16} />

        {/* Sound row — 375×47px
         * Figma: "Sound" at x:16, "Note" at x:303, chevron at x:351 */}
        <button
          type="button"
          className="flex items-center justify-between h-[47px] px-4 w-full text-start focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-1 rounded-sm"
          aria-label={soundAriaLabel}
        >
          <span className="text-[16px] leading-[1.375em] tracking-[-0.03em] text-black">
            Sound
          </span>
          <span className="flex items-center gap-2">
            <span className="text-[16px] leading-[1.375em] tracking-[-0.04em] text-[rgba(60,60,67,0.6)]">
              Note
            </span>
            <ChevronRight />
          </span>
        </button>
      </div>
    </section>
  );
}

/* ============================================================
 * NotificationsPage — Figma Screen 19 (Node 0:10758)
 *
 * Implements the WhatsApp Notifications settings screen from
 * Figma file miK1B6qEPrUnRZ9wwZNrW2. Renders notification
 * preference controls: warning banner, MESSAGE / GROUP
 * notification sections with toggles, in-app notifications
 * row, show preview toggle, and reset button.
 *
 * State: Three toggles (message notifications, group
 * notifications, show preview) — all default to ON per Figma.
 *
 * Layout: Vertical scroll between fixed NavigationBar (top)
 * and TabBar (bottom, rendered by parent layout).
 *
 * Design tokens reference: Section 0.5.2 Token Manifest,
 * Section 0.6.3 Token Mapping.
 * ============================================================ */
export default function NotificationsPage() {
  /* ----------------------------------------------------------
   * Local state — all toggles default ON per Figma Screen 19.
   * In production, these would connect to a Zustand settings
   * store for persistence.
   * ---------------------------------------------------------- */
  const [showMessageNotifications, setShowMessageNotifications] = useState(true);
  const [showGroupNotifications, setShowGroupNotifications] = useState(true);
  const [showPreview, setShowPreview] = useState(true);
  const router = useRouter();

  /**
   * Handles back navigation to the Settings page.
   * Uses router.back() for natural stack navigation (R15).
   */
  const handleBack = () => {
    router.back();
  };

  /**
   * Resets all notification settings to their default ON state.
   * Matches "Reset Notification Settings" behavior in iOS WhatsApp.
   */
  const handleResetNotifications = () => {
    setShowMessageNotifications(true);
    setShowGroupNotifications(true);
    setShowPreview(true);
  };

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Navigation Bar — 44px height
       * Figma: bg #F6F6F6, shadow 0.33px, "Settings" back (#007AFF),
       * "Notifications" centered (600, 17px) */}
      <NavigationBar
        title="Notifications"
        leftAction={
          <span className="flex items-center gap-1">
            <BackChevron />
            <span>Settings</span>
          </span>
        }
        onLeftAction={handleBack}
      />

      {/* Scrollable content area — fills space between nav bar and tab bar */}
      <div className="flex-1 overflow-y-auto bg-surface" role="region" aria-label="Notification settings">
        {/* ========================================================
         * Warning Section — Figma node 0:10793
         * Position: x:16 y:103, 343×78px
         * Gap from nav bar (y:88): 15px → mt-[15px]
         * ======================================================== */}
        <div className="mx-4 mt-[15px]" role="alert">
          <p className="text-center text-[14px] leading-[1.5em] tracking-[-0.02em] text-[rgba(84,84,88,0.65)] px-[7px]">
            WARNING: Push Notifications are disabled. To enable visit:
            <br />
            iPhone Settings {'>'} Notifications {'>'} WhatsApp
          </p>
          {/* Warning bottom line — 1px (not standard 0.33px)
           * Figma: node 0:10795, stroke rgba(84,84,88,0.65) */}
          <div className="mt-[14px] border-b border-[rgba(84,84,88,0.65)]" />
        </div>

        {/* ========================================================
         * MESSAGE NOTIFICATIONS Section — Figma node 0:10759
         * Position: y:210, 375×114px
         * Gap from warning end (y:181): 29px → mt-[29px]
         * ======================================================== */}
        <div className="mt-[29px]">
          <NotificationSection
            title="MESSAGE NOTIFICATIONS"
            showNotifications={showMessageNotifications}
            onToggleNotifications={setShowMessageNotifications}
            toggleAriaLabel="Show message notifications"
            soundAriaLabel="Message notification sound, currently Note"
          />
        </div>

        {/* ========================================================
         * GROUP NOTIFICATIONS Section — Figma node 0:10776
         * Position: y:355, 375×114px
         * Gap from MESSAGE end (y:324): 31px → mt-[31px]
         * Identical layout to MESSAGE NOTIFICATIONS.
         * ======================================================== */}
        <div className="mt-[31px]">
          <NotificationSection
            title="GROUP NOTIFICATIONS"
            showNotifications={showGroupNotifications}
            onToggleNotifications={setShowGroupNotifications}
            toggleAriaLabel="Show group notifications"
            soundAriaLabel="Group notification sound, currently Note"
          />
        </div>

        {/* ========================================================
         * In-App Notifications Row — Figma node 0:10796
         * Position: y:504, 375×61px
         * Gap from GROUP end (y:469): 35px → mt-[35px]
         *
         * Two-line row: "In-App Notifications" (16px) +
         * "Banners, Sounds, Vibrate" subtitle (11px) + chevron
         * ======================================================== */}
        <button
          type="button"
          className={`w-full mt-[35px] bg-white ${CARD_SHADOW_CLASS} flex items-center justify-between h-[61px] px-4 text-start focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-1 rounded-sm`}
          aria-label="In-App Notifications settings: Banners, Sounds, Vibrate"
        >
          <div>
            {/* Primary label — Figma: 16px, 1.375em, -2.06% tracking */}
            <p className="text-[16px] leading-[1.375em] tracking-[-0.03em] text-black">
              In-App Notifications
            </p>
            {/* Subtitle — Figma: 11px, 1.18em, 0.55% tracking */}
            <p className="text-[11px] leading-[1.18em] tracking-[0.006em] text-black mt-[4px]">
              Banners, Sounds, Vibrate
            </p>
          </div>
          <ChevronRight />
        </button>

        {/* ========================================================
         * Show Preview Section — Figma node 0:10808
         * Position: y:600, 375×70px
         * Gap from In-App end (y:565): 35px → mt-[35px]
         *
         * Toggle row (47px) + description text below
         * ======================================================== */}
        <div className="mt-[35px]">
          <div className={`bg-white ${CARD_SHADOW_CLASS}`}>
            <div className="flex items-center justify-between h-[47px] px-4">
              <span className="text-[16px] leading-[1.375em] tracking-[-0.03em] text-black">
                Show Preview
              </span>
              <Toggle
                value={showPreview}
                onChange={setShowPreview}
                ariaLabel="Show notification preview"
              />
            </div>
          </div>
          {/* Description text — Figma: node 0:10817
           * 12px, 1.33em, -0.08% tracking, #636366, mt-[7px] */}
          <p className="text-[12px] leading-[1.33em] tracking-[-0.001em] text-[#636366] px-4 mt-[7px]">
            Preview message text inside new message notifications.
          </p>
        </div>

        {/* ========================================================
         * Reset Notification Settings — Figma node 0:10803
         * Position: y:692, 375×47px
         * Gap from Show Preview end (y:670): 22px → mt-[22px]
         *
         * Destructive red text button (#FF3B30)
         * ======================================================== */}
        <button
          type="button"
          className={`w-full mt-[22px] bg-white ${CARD_SHADOW_CLASS} h-[47px] flex items-center px-4 text-start focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-1 rounded-sm`}
          onClick={handleResetNotifications}
          aria-label="Reset Notification Settings"
        >
          <span className="text-[16px] leading-[1.375em] tracking-[-0.03em] text-red-ios">
            Reset Notification Settings
          </span>
        </button>

        {/* Bottom padding — clearance beneath tab bar rendered by parent layout */}
        <div className="h-8" aria-hidden="true" />
      </div>
    </div>
  );
}
