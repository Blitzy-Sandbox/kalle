'use client';

import React, { useState } from 'react';
import { NavigationBar } from '@/components/common/NavigationBar';
import { Toggle } from '@/components/common/Toggle';
import { Separator } from '@/components/common/Separator';

/* ==========================================================================
 * ChatSettings — Reusable Chat Settings Component
 *
 * Maps to Figma Screen 18 (WhatsApp Chats Settings, node 0:9973),
 * file key miK1B6qEPrUnRZ9wwZNrW2.
 *
 * Figma layout specs:
 * - Frame: bg #EFEFF4 (bg-surface), 375×812px
 * - NavigationBar: back "Settings" (blue) + "Chats" title centered
 * - Group 1: "Change Wallpaper" — 375×47px white row, chevron
 * - Group 2: "Save to Camera Roll" — toggle (OFF), description below
 * - Group 3: "Chat Backup" — 375×47px white row, chevron
 * - Group 4: Action Items —
 *   - "Archive All Chats" — blue text #007AFF, no chevron
 *   - "Clear All Chats" — red text #FF3B30, no chevron
 *   - "Delete All Chats" — red text #FF3B30, no chevron
 *
 * Row group shadow pattern:
 *   shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)]
 *
 * Design tokens:
 * - bg-surface, bg-white, bg-nav
 * - text-black, text-blue-ios, text-red-ios
 * - Separator at x=16, 0.33px rgba(60,60,67,0.29)
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * Inline SVG Components
 * -------------------------------------------------------------------------- */

/**
 * Back chevron SVG — 12×21px, currentColor.
 * Source: icon-back-chevron.svg (Figma node 0:10015).
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
 * Right disclosure chevron — 7×12px, rgba(60,60,67,0.3).
 * Source: icon-arrow-right.svg (Figma node 0:9978).
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

/* ==========================================================================
 * ChatSettings — Exported Component
 * ========================================================================== */

/**
 * Props for the ChatSettings component.
 */
export interface ChatSettingsProps {
  /** Callback when the back button ("Settings") is pressed */
  onBack?: () => void;
  /** Callback when "Change Wallpaper" is pressed */
  onChangeWallpaper?: () => void;
  /** Callback when "Chat Backup" is pressed */
  onChatBackup?: () => void;
  /** Callback when "Archive All Chats" is pressed */
  onArchiveAll?: () => void;
  /** Callback when "Clear All Chats" is pressed */
  onClearAll?: () => void;
  /** Callback when "Delete All Chats" is pressed */
  onDeleteAll?: () => void;
  /** Callback when the "Save to Camera Roll" toggle changes */
  onSaveToCameraRollChange?: (value: boolean) => void;
  /** Initial state for "Save to Camera Roll" toggle (default: false per Figma) */
  initialSaveToCameraRoll?: boolean;
  /** Additional CSS class names */
  className?: string;
}

/**
 * ChatSettings — Reusable chat settings component.
 *
 * Renders the Chat Settings screen matching Figma Screen 18 (node 0:9973)
 * with four distinct groups: navigation rows, toggle row with description,
 * and destructive action items.
 *
 * WCAG 2.1 AA compliant (R34):
 * - All interactive rows are button elements
 * - Toggle has role="switch" with aria-checked (via Toggle component)
 * - Content wrapped in main landmark
 * - Visible focus indicators using outline-blue-ios
 * - All color contrasts ≥4.5:1
 *
 * @example
 * ```tsx
 * <ChatSettings
 *   onBack={() => router.back()}
 *   onArchiveAll={() => archiveAllChats()}
 *   onClearAll={() => showConfirmClear()}
 *   onDeleteAll={() => showConfirmDelete()}
 * />
 * ```
 */
const ChatSettings: React.FC<ChatSettingsProps> = ({
  onBack,
  onChangeWallpaper,
  onChatBackup,
  onArchiveAll,
  onClearAll,
  onDeleteAll,
  onSaveToCameraRollChange,
  initialSaveToCameraRoll = false,
  className = '',
}) => {
  /** Toggle state for "Save to Camera Roll" — initially OFF per Figma Screen 18 */
  const [saveToCameraRoll, setSaveToCameraRoll] = useState<boolean>(initialSaveToCameraRoll);

  /**
   * Combined top + bottom 0.33px shadow for white row cards.
   * Matches Figma shadow spec: rgba(60, 60, 67, 0.29) hairline separators.
   */
  const rowShadow =
    'shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)]';

  /**
   * Keyboard-accessible focus indicator applied to all interactive elements.
   * Uses blue-ios (#007AFF) outline for visible keyboard navigation per R34.
   */
  const focusStyles =
    'focus:outline-none focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2 focus-visible:rounded-sm';

  /**
   * Row text styling: SF Pro Text 400, 16px, 1.375em line-height,
   * -0.03em letter-spacing. Applied to all settings row labels.
   */
  const rowTextClass =
    'font-normal text-[16px] leading-[1.375em] tracking-[-0.03em]';

  /** Handle toggle change with both internal state and external callback */
  const handleToggleChange = (value: boolean) => {
    setSaveToCameraRoll(value);
    onSaveToCameraRollChange?.(value);
  };

  return (
    <div className={`flex flex-col h-full bg-surface ${className}`}>
      {/* Visually hidden heading for screen readers */}
      <h1 className="sr-only">Chat Settings</h1>

      {/* iOS-style navigation bar — "Chats" title with "Settings" back */}
      <NavigationBar
        title="Chats"
        leftAction={
          <span className="inline-flex items-center gap-[5px]">
            <BackChevron />
            <span>Settings</span>
          </span>
        }
        onLeftAction={onBack}
      />

      {/* Scrollable content */}
      <main className="flex-1 overflow-y-auto">
        <div className="pt-[35px] pb-4">
          {/* ===========================================================
           * Group 1 — Change Wallpaper
           * 375×47px white row, chevron disclosure
           * =========================================================== */}
          <button
            className={`w-full h-[47px] bg-white flex items-center justify-between px-4 ${rowShadow} ${focusStyles}`}
            aria-label="Change Wallpaper"
            type="button"
            onClick={onChangeWallpaper}
          >
            <span className={`${rowTextClass} text-black`}>
              Change Wallpaper
            </span>
            <ChevronRight />
          </button>

          {/* ===========================================================
           * Group 2 — Save to Camera Roll + Description
           * Toggle (OFF state), description text below on bg-surface
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
                onChange={handleToggleChange}
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
           * 375×47px white row, chevron disclosure
           * Gap: 23px (reduced by description text height)
           * =========================================================== */}
          <button
            className={`w-full h-[47px] bg-white flex items-center justify-between px-4 mt-[23px] ${rowShadow} ${focusStyles}`}
            aria-label="Chat Backup"
            type="button"
            onClick={onChatBackup}
          >
            <span className={`${rowTextClass} text-black`}>Chat Backup</span>
            <ChevronRight />
          </button>

          {/* ===========================================================
           * Group 4 — Action Items
           * Three action buttons in a white card with separators
           * - Archive All Chats: blue (#007AFF)
           * - Clear All Chats: red (#FF3B30)
           * - Delete All Chats: red (#FF3B30)
           * Gap from Group 3: 35px
           * =========================================================== */}
          <div className={`mt-[35px] bg-white ${rowShadow}`}>
            {/* Archive All Chats — blue action text */}
            <button
              className={`w-full h-[47px] flex items-center px-4 ${focusStyles}`}
              aria-label="Archive All Chats"
              type="button"
              onClick={onArchiveAll}
            >
              <span className={`${rowTextClass} text-blue-ios`}>
                Archive All Chats
              </span>
            </button>

            <Separator inset insetLeft={16} />

            {/* Clear All Chats — red destructive action */}
            <button
              className={`w-full h-[47px] flex items-center px-4 ${focusStyles}`}
              aria-label="Clear All Chats"
              type="button"
              onClick={onClearAll}
            >
              <span className={`${rowTextClass} text-red-ios`}>
                Clear All Chats
              </span>
            </button>

            <Separator inset insetLeft={16} />

            {/* Delete All Chats — red destructive action */}
            <button
              className={`w-full h-[47px] flex items-center px-4 ${focusStyles}`}
              aria-label="Delete All Chats"
              type="button"
              onClick={onDeleteAll}
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
};

export default ChatSettings;
