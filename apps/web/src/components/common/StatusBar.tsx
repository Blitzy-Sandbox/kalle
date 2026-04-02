'use client';

import React from 'react';

/**
 * Props for the simulated iOS status bar component.
 *
 * This component is purely decorative — it simulates the iOS system
 * status bar (time, signal, WiFi, battery) for Figma fidelity on desktop.
 * On mobile viewports, this component is hidden (native status bar visible).
 */
export interface StatusBarProps {
  /** Time string to display. Defaults to "9:41" matching Apple's standard demo time from Figma. */
  time?: string;
  /** Whether to use the dark variant (white icons/text on dark background) — used for camera and status view screens. */
  dark?: boolean;
  /** Additional CSS class names for the container element. */
  className?: string;
}

/**
 * MobileSignalIcon — Inline SVG rendering 4 ascending signal bars.
 *
 * Figma node 0:9063 — Mobile Signal:
 * - Dimensions: 17×10.67px
 * - Fill: #060606 (icon-dark)
 * - 4 bars (3px wide each): heights 4, 6, 8.33, 10.67px
 * - Bars have ~1.33px gap between them (17px total / 4 bars of 3px = 5px gaps / 3 = ~1.67px per gap)
 */
const MobileSignalIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    width="17"
    height="10.67"
    viewBox="0 0 17 10.67"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    {/* Bar 1 (shortest): 3×4px, bottom-aligned */}
    <rect x="0" y="6.67" width="3" height="4" rx="0.5" fill="currentColor" />
    {/* Bar 2: 3×6px, bottom-aligned */}
    <rect x="4.67" y="4.67" width="3" height="6" rx="0.5" fill="currentColor" />
    {/* Bar 3: 3×8.33px, bottom-aligned */}
    <rect x="9.33" y="2.34" width="3" height="8.33" rx="0.5" fill="currentColor" />
    {/* Bar 4 (tallest): 3×10.67px, bottom-aligned */}
    <rect x="14" y="0" width="3" height="10.67" rx="0.5" fill="currentColor" />
  </svg>
);

/**
 * WifiIcon — Inline SVG rendering 3 concentric WiFi arcs with a dot.
 *
 * Figma node 0:9059 — Wifi:
 * - Dimensions: 15.27×10.97px
 * - Fill: #060606
 * - 3 concentric arc paths
 */
const WifiIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    width="15.27"
    height="10.97"
    viewBox="0 0 15.27 10.97"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    {/* Outer arc */}
    <path
      d="M0.64 3.07C3.52 0.51 7.64 -0.01 11.05 1.21C12.17 1.63 13.21 2.24 14.12 3.02"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
    {/* Middle arc */}
    <path
      d="M3.34 5.87C5.12 4.19 7.64 3.53 10.01 4.1C10.8 4.3 11.55 4.64 12.21 5.1"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
    {/* Inner arc */}
    <path
      d="M6.08 8.53C6.81 7.88 7.79 7.59 8.76 7.76C9.24 7.84 9.69 8.03 10.08 8.31"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
    {/* Center dot */}
    <circle cx="7.95" cy="10.27" r="0.7" fill="currentColor" />
  </svg>
);

/**
 * BatteryIcon — Inline SVG rendering the iOS battery indicator.
 *
 * Figma node 0:9050 — Battery:
 * - Dimensions: 25×11px
 * - Body outline: 22×10.5px, borderRadius 2.5px, fill #ABABAB
 * - Charge fill: 18×6.5px at (2,2), borderRadius 1px, fill #060606
 * - Cap: 1.5×3.87px connector at (23, 3.5)
 */
const BatteryIcon: React.FC<{ className?: string; dark?: boolean }> = ({ className, dark = false }) => (
  <svg
    width="25"
    height="11"
    viewBox="0 0 25 11"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    {/* Battery body outline */}
    <rect
      x="0"
      y="0"
      width="22"
      height="10.5"
      rx="2.5"
      ry="2.5"
      fill={dark ? 'rgba(255, 255, 255, 0.35)' : '#ABABAB'}
    />
    {/* Inner cutout (creates the outline effect) */}
    <rect
      x="1"
      y="1"
      width="20"
      height="8.5"
      rx="1.5"
      ry="1.5"
      fill={dark ? '#000000' : '#F7F7F7'}
    />
    {/* Charge fill level */}
    <rect
      x="2"
      y="2"
      width="18"
      height="6.5"
      rx="1"
      ry="1"
      fill="currentColor"
    />
    {/* Battery cap (right-side connector) */}
    <rect
      x="23"
      y="3.5"
      width="1.5"
      height="3.87"
      rx="0.5"
      ry="0.5"
      fill={dark ? 'rgba(255, 255, 255, 0.4)' : '#ABABAB'}
    />
  </svg>
);

/**
 * StatusBar — Simulated iOS status bar for desktop Figma fidelity.
 *
 * Renders a decorative iOS-style status bar showing time (left), and
 * signal strength, WiFi, and battery indicators (right). Used at the
 * top of every screen in the WhatsApp clone UI.
 *
 * Figma source: node 0:9048 (Bars / Status Bar / iPhone X)
 * - Appears on ALL 21 screens at position (0, 0), 375×44px
 * - Background: #F7F7F7 (light) / transparent dark bg (dark variant)
 *
 * Accessibility: `aria-hidden="true"` — purely decorative, screen
 * readers skip this element entirely (R34).
 *
 * Responsive: Hidden on small viewports (`hidden md:flex`) where the
 * native mobile status bar is visible. Shown on tablet+ as part of
 * the simulated iOS chrome.
 */
export const StatusBar: React.FC<StatusBarProps> = ({
  time = '9:41',
  dark = false,
  className = '',
}) => {
  /* Resolve color classes based on dark/light variant */
  const bgClass = dark ? 'bg-black' : 'bg-statusbar';
  const textColorClass = dark ? 'text-white' : 'text-[#171717]';
  const iconColorClass = dark ? 'text-white' : 'text-icon-dark';

  return (
    <div
      aria-hidden="true"
      className={[
        'hidden md:flex',
        'items-center justify-between',
        'w-full h-status-bar',
        'pl-[21px] pr-[14px]',
        bgClass,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Left side — Time display */}
      <div className="flex items-center">
        <span
          className={[
            'font-semibold text-[15px] leading-[1.193em] tracking-[-0.02em]',
            'text-center',
            'min-w-[54px]',
            textColorClass,
          ].join(' ')}
        >
          {time}
        </span>
      </div>

      {/* Right side — Signal, WiFi, Battery icons */}
      <div className="flex items-center gap-[5px]">
        <MobileSignalIcon className={iconColorClass} />
        <WifiIcon className={iconColorClass} />
        <BatteryIcon className={iconColorClass} dark={dark} />
      </div>
    </div>
  );
};

export default StatusBar;
