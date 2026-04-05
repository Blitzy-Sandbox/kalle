'use client';

// =============================================================================
// SettingsMenu — Main Settings Navigation Screen Component
// =============================================================================
//
// Reusable settings menu component mapping 1:1 to Figma Screen 13
// (WhatsApp Settings, node 0:9198, file miK1B6qEPrUnRZ9wwZNrW2).
//
// Layout (375×812px base, 1440px desktop via responsive):
//   - StatusBar (simulated iOS status bar for desktop fidelity)
//   - NavigationBar with centered "Settings" title (no left/right actions)
//   - Scrollable content area:
//       - Profile row: 58×58px avatar, user display name (20px), about text
//         (16px rgba(60,60,67,0.6)), right chevron — tappable to Edit Profile
//       - 35px gap
//       - Group 1 (2 rows): Starred Messages, WhatsApp Web/Desktop
//       - 35px gap
//       - Group 2 (4 rows): Account, Chats, Notifications, Data and Storage Usage
//       - 35px gap
//       - Group 3 (2 rows): Help, Tell a Friend
//       - Footer: "WhatsApp from Facebook" centered in #8E8E93
//   - TabBar with Settings tab active (blue #007AFF)
//
// Design Tokens:
//   Background: #EFEFF4 (bg-surface)
//   Row groups: white bg, dual 0.33px shadows rgba(60,60,67,0.29)
//   Profile card: white bg, single 0.33px bottom shadow
//   Group gaps: 35px
//   Separator inset: 59px from left (within icon rows)
//
// Figma source: file miK1B6qEPrUnRZ9wwZNrW2, node 0:9198
// =============================================================================

import React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';

// Internal component imports — all from depends_on_files whitelist
import { NavigationBar } from '@/components/common/NavigationBar';
import { TabBar } from '@/components/common/TabBar';
import { SettingsRow } from '@/components/common/SettingsRow';
import { Separator } from '@/components/common/Separator';
import { StatusBar } from '@/components/common/StatusBar';
import Avatar from '@/components/common/Avatar';

// Zustand auth store — provides current user profile (displayName, avatar, about)
import { useAuthStore } from '@/stores/authStore';

// Static SVG icon imports — each icon is a self-contained 29×29px SVG
// with a colored background rect (rx=6) and white icon path, exported
// directly from Figma file miK1B6qEPrUnRZ9wwZNrW2, node 0:9198.
import iconSettingsStar from '@/assets/icons/icon-settings-star.svg';
import iconSettingsWeb from '@/assets/icons/icon-settings-web.svg';
import iconSettingsAccount from '@/assets/icons/icon-settings-account.svg';
import iconSettingsChats from '@/assets/icons/icon-settings-chats.svg';
import iconSettingsNotifications from '@/assets/icons/icon-settings-notifications.svg';
import iconSettingsData from '@/assets/icons/icon-settings-data.svg';
import iconSettingsHelp from '@/assets/icons/icon-settings-help.svg';
import iconSettingsTell from '@/assets/icons/icon-settings-tell.svg';

// =============================================================================
// SettingsMenuProps — Public API for the SettingsMenu component
// =============================================================================

/**
 * Props interface for the SettingsMenu component.
 *
 * @property activeTab - Currently active tab identifier, always 'settings'
 *   for this screen. Passed through to the TabBar component.
 * @property onTabPress - Callback invoked when a tab bar item is pressed.
 *   Receives the tab identifier string. When omitted, uses router.push.
 * @property onNavigate - Callback invoked when a settings row or profile
 *   row is pressed. Receives the screen identifier string (e.g., 'profile',
 *   'starred', 'account'). When omitted, uses router.push for navigation.
 * @property className - Additional CSS class names applied to the outermost
 *   container element for layout composition.
 */
export interface SettingsMenuProps {
  activeTab?: 'settings';
  onTabPress?: (tab: string) => void;
  onNavigate?: (screen: string) => void;
  className?: string;
}

// =============================================================================
// ProfileChevron — Inline SVG for the profile row right arrow
// =============================================================================
//
// 7×12px chevron matching Figma node 0:9205 at (351,32).
// Color: rgba(60,60,67,0.3) — same fill as SettingsRow's built-in chevron.
// Rendered inline to avoid extra dependency (icon-arrow-right.svg is not in
// the depends_on_files whitelist for this component).
// =============================================================================

function ProfileChevron(): React.ReactElement {
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

// =============================================================================
// SettingsMenu — Main Settings Menu Component
// =============================================================================

/**
 * Main settings navigation screen component.
 *
 * Renders the complete WhatsApp Settings screen (Figma Screen 13) as a
 * reusable component. The screen consists of a profile row at the top,
 * three groups of settings rows with colored icons, a footer, and the
 * bottom tab bar with the Settings tab active.
 *
 * Navigation is handled via the `onNavigate` prop callback or falls back
 * to Next.js router.push for programmatic client-side routing.
 *
 * @example Basic usage in a page
 * ```tsx
 * <SettingsMenu
 *   onTabPress={(tab) => router.push(`/${tab}`)}
 *   onNavigate={(screen) => router.push(`/settings/${screen}`)}
 * />
 * ```
 */
const SettingsMenu: React.FC<SettingsMenuProps> = ({
  activeTab = 'settings',
  onTabPress,
  onNavigate,
  className,
}) => {
  // ---------------------------------------------------------------------------
  // Hooks — navigation and state
  // ---------------------------------------------------------------------------
  const router = useRouter();
  const user = useAuthStore((state) => state.user);

  // ---------------------------------------------------------------------------
  // Navigation helpers
  // ---------------------------------------------------------------------------

  /**
   * Navigate to a settings sub-screen. Uses onNavigate callback if provided,
   * otherwise falls back to Next.js router for client-side navigation.
   */
  const handleNavigate = (screen: string): void => {
    if (onNavigate) {
      onNavigate(screen);
    } else {
      router.push(`/settings/${screen}`);
    }
  };

  /**
   * Handle tab bar presses. Uses onTabPress callback if provided,
   * otherwise falls back to Next.js router for navigation.
   */
  const handleTabPress = (tab: string): void => {
    if (onTabPress) {
      onTabPress(tab);
    } else {
      // Map tab identifiers to their corresponding routes
      const tabRoutes: Record<string, string> = {
        status: '/status',
        calls: '/calls',
        camera: '/camera',
        chats: '/chat',
        settings: '/settings',
      };
      router.push(tabRoutes[tab] || `/${tab}`);
    }
  };

  // ---------------------------------------------------------------------------
  // Render — Settings Main Screen
  //
  // Layout order (top to bottom, matching Figma Screen 13):
  //   1. StatusBar (simulated iOS — hidden on mobile via StatusBar internals)
  //   2. NavigationBar (title="Settings", no left/right actions)
  //   3. Scrollable content:
  //      a. Profile row (custom layout — NOT SettingsRow)
  //      b. Group 1 (Starred Messages, WhatsApp Web/Desktop)
  //      c. Group 2 (Account, Chats, Notifications, Data and Storage)
  //      d. Group 3 (Help, Tell a Friend)
  //      e. Footer ("WhatsApp from Facebook")
  //   4. TabBar (Settings active)
  // ---------------------------------------------------------------------------
  return (
    <div
      className={[
        'flex flex-col min-h-screen bg-surface',
        className || '',
      ].join(' ').trim()}
      role="main"
      aria-label="Settings"
    >
      {/* ================================================================== */}
      {/* Status Bar — Simulated iOS status bar for desktop fidelity          */}
      {/* Figma node 0:9350 — bg #F7F7F7, time "9:41", hidden on mobile     */}
      {/* ================================================================== */}
      <StatusBar />

      {/* ================================================================== */}
      {/* Navigation Bar — "Settings" centered title, no actions              */}
      {/* Figma node 0:9298 — bg #F6F6F6, shadow 0.33px bottom              */}
      {/* No back button (top-level screen), no right action                  */}
      {/* ================================================================== */}
      <NavigationBar title="Settings" />

      {/* ================================================================== */}
      {/* Scrollable Content Area                                            */}
      {/* Fills space between NavigationBar and TabBar with vertical scroll  */}
      {/* ================================================================== */}
      <div className="flex-1 overflow-y-auto">
        {/* ================================================================ */}
        {/* Profile Section — Custom layout (NOT SettingsRow)                 */}
        {/* Figma node 0:9200 — (0,88), 375×76px, bg white                  */}
        {/* Shadow: 0px 0.33px 0px rgba(60,60,67,0.29) (single bottom)       */}
        {/* ================================================================ */}
        <button
          type="button"
          onClick={() => handleNavigate('profile')}
          className={[
            'w-full h-[76px] bg-white flex items-start',
            'ps-4 pe-4 pt-2 pb-2',
            'shadow-[0_0.33px_0_rgba(60,60,67,0.29)]',
            'cursor-pointer',
            'active:bg-gray-100',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-inset',
          ].join(' ')}
          aria-label={`Edit profile for ${user?.displayName || 'User'}`}
        >
          {/* Avatar — 58×58px circular image, Figma node 0:9202 */}
          <Avatar
            src={user?.avatar ?? null}
            alt={user?.displayName || 'User avatar'}
            customSize={58}
          />

          {/* Name and description text block */}
          <div className="flex flex-col flex-1 min-w-0 ms-[12px] mt-[5px]">
            {/* Name — SF Pro Text 400, 20px, line-height 1.19em */}
            {/* Figma node 0:9203: "Sabohiddin", tracking -1.25% → -0.013em */}
            <span
              className={[
                'font-sans font-normal text-[20px] leading-[1.19em] tracking-[-0.013em]',
                'text-black truncate text-start',
              ].join(' ')}
            >
              {user?.displayName || 'User'}
            </span>

            {/* About / description text */}
            {/* Figma node 0:9204: "Digital goodies designer - Pixsellz" */}
            {/* SF Pro Text 400, 16px, line-height 1.25em, tracking -4.37% → -0.044em */}
            {/* Color: rgba(60,60,67,0.6) — NOT #8E8E93 */}
            <span
              className={[
                'font-sans font-normal text-[16px] leading-[1.25em] tracking-[-0.044em]',
                'text-[rgba(60,60,67,0.6)] truncate text-start',
              ].join(' ')}
            >
              {user?.about || 'Hey there! I am using WhatsApp.'}
            </span>
          </div>

          {/* Right chevron arrow — 7×12px, Figma node 0:9205 */}
          {/* Color: rgba(60,60,67,0.3), self-centered vertically */}
          <div className="flex-shrink-0 ms-2 self-center">
            <ProfileChevron />
          </div>
        </button>

        {/* ================================================================ */}
        {/* Settings Group 1 — Starred Messages + WhatsApp Web/Desktop       */}
        {/* Figma node 0:9207 — (0,199), 375×94px, bg white                 */}
        {/* Dual shadow: top + bottom 0.33px rgba(60,60,67,0.29)             */}
        {/* Gap from profile: 35px                                            */}
        {/* ================================================================ */}
        <div
          className="relative mt-[35px]"
          role="group"
          aria-label="Quick access settings"
        >
          {/* Top separator line (0.33px) */}
          <div className="absolute top-0 inset-x-0 z-[1]">
            <Separator />
          </div>
          <div className="bg-white">
            {/* Starred Messages — Figma node 0:9209 */}
            {/* Icon: 29×29px yellow star SVG (#FBB500 baked into SVG) */}
            <SettingsRow
              icon={
                <Image
                  src={iconSettingsStar}
                  alt=""
                  width={29}
                  height={29}
                  className="rounded-[6px]"
                />
              }
              iconBgColor="transparent"
              label="Starred Messages"
              showChevron
              onClick={() => handleNavigate('starred')}
              showSeparator
            />

            {/* WhatsApp Web/Desktop — Figma node 0:9217 */}
            {/* Icon: 29×29px teal monitor SVG (#07AD9F baked into SVG) */}
            <SettingsRow
              icon={
                <Image
                  src={iconSettingsWeb}
                  alt=""
                  width={29}
                  height={29}
                  className="rounded-[6px]"
                />
              }
              iconBgColor="transparent"
              label="WhatsApp Web/Desktop"
              showChevron
              onClick={() => handleNavigate('web-desktop')}
            />
          </div>
          {/* Bottom separator line (0.33px) */}
          <div className="absolute bottom-0 inset-x-0 z-[1]">
            <Separator />
          </div>
        </div>

        {/* ================================================================ */}
        {/* Settings Group 2 — Account, Chats, Notifications, Data & Storage */}
        {/* Figma node 0:9252 — (0,328), 375×188px (4 × 47px), bg white     */}
        {/* Dual shadow: top + bottom 0.33px rgba(60,60,67,0.29)             */}
        {/* Gap from Group 1: 35px                                            */}
        {/* ================================================================ */}
        <div
          className="relative mt-[35px]"
          role="group"
          aria-label="App settings"
        >
          <div className="absolute top-0 inset-x-0 z-[1]">
            <Separator />
          </div>
          <div className="bg-white">
            {/* Account — Figma node 0:9254 */}
            {/* Icon: 29×29px blue key SVG (#397AFE baked into SVG) */}
            <SettingsRow
              icon={
                <Image
                  src={iconSettingsAccount}
                  alt=""
                  width={29}
                  height={29}
                  className="rounded-[6px]"
                />
              }
              iconBgColor="transparent"
              label="Account"
              showChevron
              onClick={() => handleNavigate('account')}
              showSeparator
            />

            {/* Chats — Figma node 0:9264 */}
            {/* Icon: 29×29px green WhatsApp SVG (#4BD763 baked into SVG) */}
            <SettingsRow
              icon={
                <Image
                  src={iconSettingsChats}
                  alt=""
                  width={29}
                  height={29}
                  className="rounded-[6px]"
                />
              }
              iconBgColor="transparent"
              label="Chats"
              showChevron
              onClick={() => handleNavigate('chats')}
              showSeparator
            />

            {/* Notifications — Figma node 0:9285 */}
            {/* Icon: 29×29px red bell SVG (#FF3B2F baked into SVG) */}
            <SettingsRow
              icon={
                <Image
                  src={iconSettingsNotifications}
                  alt=""
                  width={29}
                  height={29}
                  className="rounded-[6px]"
                />
              }
              iconBgColor="transparent"
              label="Notifications"
              showChevron
              onClick={() => handleNavigate('notifications')}
              showSeparator
            />

            {/* Data and Storage Usage — Figma node 0:9275 */}
            {/* Icon: 29×29px green arrows SVG (#4BD763 baked into SVG) */}
            <SettingsRow
              icon={
                <Image
                  src={iconSettingsData}
                  alt=""
                  width={29}
                  height={29}
                  className="rounded-[6px]"
                />
              }
              iconBgColor="transparent"
              label="Data and Storage Usage"
              showChevron
              onClick={() => handleNavigate('storage')}
            />
          </div>
          <div className="absolute bottom-0 inset-x-0 z-[1]">
            <Separator />
          </div>
        </div>

        {/* ================================================================ */}
        {/* Settings Group 3 — Help + Tell a Friend                          */}
        {/* Figma node 0:9229 — (0,551), 375×94px, bg white                 */}
        {/* Dual shadow: top + bottom 0.33px rgba(60,60,67,0.29)             */}
        {/* Gap from Group 2: 35px                                            */}
        {/* ================================================================ */}
        <div
          className="relative mt-[35px]"
          role="group"
          aria-label="Support and sharing"
        >
          <div className="absolute top-0 inset-x-0 z-[1]">
            <Separator />
          </div>
          <div className="bg-white">
            {/* Help — Figma node 0:9231 */}
            {/* Icon: 29×29px blue info SVG (#4BA0FE baked into SVG) */}
            <SettingsRow
              icon={
                <Image
                  src={iconSettingsHelp}
                  alt=""
                  width={29}
                  height={29}
                  className="rounded-[6px]"
                />
              }
              iconBgColor="transparent"
              label="Help"
              showChevron
              onClick={() => handleNavigate('help')}
              showSeparator
            />

            {/* Tell a Friend — Figma node 0:9241 */}
            {/* Icon: 29×29px purple heart SVG (#FF2C55 baked into SVG) */}
            <SettingsRow
              icon={
                <Image
                  src={iconSettingsTell}
                  alt=""
                  width={29}
                  height={29}
                  className="rounded-[6px]"
                />
              }
              iconBgColor="transparent"
              label="Tell a Friend"
              showChevron
              onClick={() => handleNavigate('tell-a-friend')}
            />
          </div>
          <div className="absolute bottom-0 inset-x-0 z-[1]">
            <Separator />
          </div>
        </div>

        {/* ================================================================ */}
        {/* Footer — "WhatsApp from Facebook" centered text                  */}
        {/* Figma node 0:9199 — at (114,680), 147×18px                       */}
        {/* SF Pro Text 400, 12px, line-height 1.5em, tracking -0.08%        */}
        {/* Color: #8E8E93 (text-secondary), centered                        */}
        {/* Gap from Group 3: 35px                                            */}
        {/* ================================================================ */}
        <p
          className={[
            'mt-[35px] pb-4 text-center',
            'font-sans font-normal text-[12px] leading-[1.5em] tracking-[-0.001em]',
            'text-secondary',
          ].join(' ')}
          aria-label="WhatsApp from Facebook"
        >
          WhatsApp from Facebook
        </p>
      </div>

      {/* ================================================================== */}
      {/* Tab Bar — 5-tab bottom navigation                                  */}
      {/* Figma node 0:9301 — bg #F6F6F6, shadow -0.33px top                */}
      {/* Tab 5 "Settings" ACTIVE: fill #007AFF (blue)                       */}
      {/* Tabs 1-4 INACTIVE: fill rgba(84,84,88,0.65)                        */}
      {/* ================================================================== */}
      <TabBar
        activeTab={activeTab || 'settings'}
        onTabPress={(tab) => handleTabPress(tab)}
      />
    </div>
  );
};

export { SettingsMenu };
export default SettingsMenu;
