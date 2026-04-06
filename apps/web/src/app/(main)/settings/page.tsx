'use client';

// =============================================================================
// Settings Main Page — apps/web/src/app/(main)/settings/page.tsx
// =============================================================================
//
// Next.js 14 App Router page implementing the main Settings view.
// Maps to Figma Screen 13 (WhatsApp Settings, node 0:9198) and
// Screen 14 (WhatsApp Settings Modal / share action sheet, node 0:9778).
//
// Layout (375×812px base):
//   - NavigationBar with centered "Settings" title (no left/right actions)
//   - Profile row: 58×58px avatar, user display name, about text, right chevron
//   - Three settings row groups separated by 35px gaps on #EFEFF4 background:
//       Group 1: Starred Messages, WhatsApp Web/Desktop
//       Group 2: Account, Chats, Notifications, Data and Storage Usage
//       Group 3: Help, Tell a Friend
//   - Footer text: "WhatsApp from Facebook" centered in secondary gray
//   - Share modal (ActionSheet) opened by "Tell a Friend"
//
// Figma source: file miK1B6qEPrUnRZ9wwZNrW2, nodes 0:9198 and 0:9778.
// =============================================================================

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';

// Zustand stores
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';

// Common UI components
import { NavigationBar } from '@/components/common/NavigationBar';
import Avatar from '@/components/common/Avatar';
import { SettingsRow } from '@/components/common/SettingsRow';
import { Separator } from '@/components/common/Separator';
import { ActionSheet } from '@/components/common/ActionSheet';
import type { ActionSheetItem } from '@/components/common/ActionSheet';

// Static SVG icon imports — each icon is a self-contained 29×29px SVG
// with a colored background rect and white icon path, matching the exact
// Figma settings icon specifications (file miK1B6qEPrUnRZ9wwZNrW2, node 0:9198).
import iconSettingsStar from '@/assets/icons/icon-settings-star.svg';
import iconSettingsWeb from '@/assets/icons/icon-settings-web.svg';
import iconSettingsAccount from '@/assets/icons/icon-settings-account.svg';
import iconSettingsChats from '@/assets/icons/icon-settings-chats.svg';
import iconSettingsNotifications from '@/assets/icons/icon-settings-notifications.svg';
import iconSettingsData from '@/assets/icons/icon-settings-data.svg';
import iconSettingsHelp from '@/assets/icons/icon-settings-help.svg';
import iconSettingsTell from '@/assets/icons/icon-settings-tell.svg';
import iconArrowRight from '@/assets/icons/icon-arrow-right.svg';

// =============================================================================
// SettingsPage — Main settings view component
// =============================================================================
//
// Default export. Renders the full Settings screen (Figma Screen 13) with an
// iOS-style action sheet overlay for the "Tell a Friend" share modal
// (Figma Screen 14).
//
// State:
//   - showShareModal: boolean — controls share action sheet visibility
//
// Navigation (via next/navigation useRouter):
//   - Profile row      → /settings/profile
//   - Starred Messages → /settings/starred
//   - Account          → /settings/account
//   - Chats            → /settings/chats
//   - Notifications    → /settings/notifications
//   - Data & Storage   → /settings/storage
// =============================================================================
export default function SettingsPage() {
  // ---------------------------------------------------------------------------
  // Local state — share modal visibility toggle (Figma Screen 14, node 0:9778)
  // ---------------------------------------------------------------------------
  const [showShareModal, setShowShareModal] = useState(false);

  // ---------------------------------------------------------------------------
  // Next.js App Router navigation — programmatic routing to settings sub-pages
  // ---------------------------------------------------------------------------
  const router = useRouter();

  // ---------------------------------------------------------------------------
  // Zustand stores — authenticated user profile for the profile row display,
  // and UI store for global modal conflict detection
  // ---------------------------------------------------------------------------
  const { user } = useAuthStore();
  const { activeModal } = useUIStore();

  // ---------------------------------------------------------------------------
  // Share modal action items (Figma Screen 14, node 0:9778)
  //
  // Three options: Mail, Message, More — all blue text (#007AFF) per Figma.
  // Each item triggers a share action. Currently presentational only per R38
  // (no external dependencies) — actions log intent without external services.
  // ---------------------------------------------------------------------------
  const shareModalItems: ActionSheetItem[] = [
    {
      label: 'Mail',
      onPress: () => {
        setShowShareModal(false);
      },
    },
    {
      label: 'Message',
      onPress: () => {
        setShowShareModal(false);
      },
    },
    {
      label: 'More',
      onPress: () => {
        setShowShareModal(false);
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // Navigation handlers — wrapped in useCallback for referential stability.
  // Each handler navigates to the corresponding settings sub-page.
  // ---------------------------------------------------------------------------
  const handleProfilePress = useCallback(() => {
    router.push('/settings/profile');
  }, [router]);

  const handleStarredPress = useCallback(() => {
    router.push('/settings/starred');
  }, [router]);

  const handleAccountPress = useCallback(() => {
    router.push('/settings/account');
  }, [router]);

  const handleChatsPress = useCallback(() => {
    router.push('/settings/chats');
  }, [router]);

  const handleNotificationsPress = useCallback(() => {
    router.push('/settings/notifications');
  }, [router]);

  const handleStoragePress = useCallback(() => {
    router.push('/settings/storage');
  }, [router]);

  const handleTellAFriendPress = useCallback(() => {
    // Guard: prevent opening share modal when another global modal is active
    if (!activeModal) {
      setShowShareModal(true);
    }
  }, [activeModal]);

  const handleCloseShareModal = useCallback(() => {
    setShowShareModal(false);
  }, []);

  // ---------------------------------------------------------------------------
  // Render — Settings Main Page
  //
  // Layout structure (top to bottom):
  //   1. NavigationBar (title="Settings", no actions)
  //   2. Profile row (58px avatar, name, description, chevron)
  //   3. Settings Group 1 (Starred Messages, WhatsApp Web/Desktop)
  //   4. Settings Group 2 (Account, Chats, Notifications, Data & Storage)
  //   5. Settings Group 3 (Help, Tell a Friend)
  //   6. Footer ("WhatsApp from Facebook")
  //   7. Share ActionSheet (conditional)
  //
  // Background: #EFEFF4 (Tailwind: bg-surface) per Figma Screen 13.
  // All groups are white (#FFFFFF) cards with 0.33px top+bottom shadows.
  // Groups separated by 35px vertical gaps.
  // ---------------------------------------------------------------------------
  return (
    <div
      className="flex flex-col flex-1 min-h-0 bg-surface"
      role="region"
      aria-label="Settings"
    >
      {/* ================================================================== */}
      {/* Navigation Bar — "Settings" centered title, no actions             */}
      {/* Figma node 0:9298 — bg #F6F6F6, shadow 0.33px bottom              */}
      {/* ================================================================== */}
      <NavigationBar title="Settings" />

      {/* ================================================================== */}
      {/* Scrollable content area                                            */}
      {/* Positioned between NavigationBar (top) and TabBar (bottom, from    */}
      {/* parent layout). Scrolls vertically for content overflow.           */}
      {/* ================================================================== */}
      <div className="flex-1 overflow-y-auto">
        {/* ================================================================ */}
        {/* Profile Row — Figma node 0:9200                                  */}
        {/* Full width × 76px, bg white, bottom shadow, flex layout          */}
        {/* Avatar 58×58px, name 20px, description 16px, right chevron       */}
        {/* ================================================================ */}
        <button
          type="button"
          onClick={handleProfilePress}
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
          <div className="flex flex-col flex-1 min-w-0 ml-[12px] mt-[5px]">
            {/* Name — SF Pro Text 400, 20px, line-height 1.19em, tracking -0.02em */}
            {/* Figma node 0:9203: "Sabohiddin" */}
            <span
              className={[
                'font-sans font-normal text-[20px] leading-[1.19em] tracking-[-0.013em]',
                'text-black truncate text-start',
              ].join(' ')}
            >
              {user?.displayName || 'User'}
            </span>

            {/* Description / about text */}
            {/* Figma node 0:9204: "Digital goodies designer - Pixsellz" */}
            {/* SF Pro Text 400, 16px, line-height 1.25em, tracking -0.07em */}
            {/* Color: rgba(60,60,67,0.6) */}
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
          <Image
            src={iconArrowRight}
            alt=""
            width={7}
            height={12}
            className="flex-shrink-0 ml-2 self-center"
            aria-hidden="true"
          />
        </button>

        {/* ================================================================ */}
        {/* Settings Group 1 — Starred Messages + WhatsApp Web/Desktop       */}
        {/* Figma node 0:9207: y=199, 375×94px, bg white, borders top+bottom */}
        {/* Gap from profile row: 35px                                       */}
        {/* ================================================================ */}
        <div className="relative mt-[35px]" role="group" aria-label="Quick access settings">
          <div className="absolute top-0 inset-x-0 z-[1]"><Separator /></div>
          <div className="bg-white">
            {/* Starred Messages — Figma node 0:9209 */}
            {/* Icon bg: #FBB500 (yellow star icon) */}
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
              onClick={handleStarredPress}
              showSeparator
            />

            {/* WhatsApp Web/Desktop — Figma node 0:9217 */}
            {/* Icon bg: #07AD9F (teal desktop icon) */}
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
            />
          </div>
          <div className="absolute bottom-0 inset-x-0 z-[1]"><Separator /></div>
        </div>

        {/* ================================================================ */}
        {/* Settings Group 2 — Account, Chats, Notifications, Data & Storage */}
        {/* Figma node 0:9252: y=328, 375×188px, bg white, borders top+bottom */}
        {/* Gap from Group 1: 35px                                           */}
        {/* ================================================================ */}
        <div className="relative mt-[35px]" role="group" aria-label="App settings">
          <div className="absolute top-0 inset-x-0 z-[1]"><Separator /></div>
          <div className="bg-white">
            {/* Account — Figma node 0:9254 */}
            {/* Icon bg: #397AFE (blue key icon) */}
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
              onClick={handleAccountPress}
              showSeparator
            />

            {/* Chats — Figma node 0:9264 */}
            {/* Icon bg: #4BD763 (green WhatsApp icon) */}
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
              onClick={handleChatsPress}
              showSeparator
            />

            {/* Notifications — Figma node 0:9285 */}
            {/* Icon bg: #FF3B2F (red notification icon) */}
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
              onClick={handleNotificationsPress}
              showSeparator
            />

            {/* Data and Storage Usage — Figma node 0:9275 */}
            {/* Icon bg: #4BD763 (green arrows icon) */}
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
              onClick={handleStoragePress}
            />
          </div>
          <div className="absolute bottom-0 inset-x-0 z-[1]"><Separator /></div>
        </div>

        {/* ================================================================ */}
        {/* Settings Group 3 — Help + Tell a Friend                          */}
        {/* Figma node 0:9229: y=551, 375×94px, bg white, borders top+bottom */}
        {/* Gap from Group 2: 35px                                           */}
        {/* ================================================================ */}
        <div className="relative mt-[35px]" role="group" aria-label="Support and sharing">
          <div className="absolute top-0 inset-x-0 z-[1]"><Separator /></div>
          <div className="bg-white">
            {/* Help — Figma node 0:9231 */}
            {/* Icon bg: #4BA0FE (blue info icon) */}
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
              showSeparator
            />

            {/* Tell a Friend — Figma node 0:9241 */}
            {/* Icon bg: #FF2C55 (pink heart icon) */}
            {/* Opens the share action sheet (Screen 14, node 0:9778) */}
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
              onClick={handleTellAFriendPress}
            />
          </div>
          <div className="absolute bottom-0 inset-x-0 z-[1]"><Separator /></div>
        </div>

        {/* ================================================================ */}
        {/* Footer — "WhatsApp from Facebook"                                */}
        {/* Figma node 0:9199: centered, x=114, y=680                        */}
        {/* SF Pro Text 400, 12px, line-height 1.5em, color #8E8E93          */}
        {/* ================================================================ */}
        <p
          className={[
            'font-sans font-normal text-[12px] leading-[1.5em] tracking-[-0.001em]',
            'text-secondary text-center',
            'mt-[35px] pb-4',
          ].join(' ')}
        >
          WhatsApp from Facebook
        </p>
      </div>

      {/* ==================================================================== */}
      {/* Share Action Sheet Modal — Figma Screen 14, node 0:9778              */}
      {/*                                                                      */}
      {/* Overlay: rgba(0,0,0,0.4) (bg-overlay-dark)                           */}
      {/* Actions card: 355×229px, bg #ECECED, rounded 15px                    */}
      {/* Items: Mail, Message, More — each 355×57px, white bg, blue text      */}
      {/* Cancel button: 355×57px, white bg, rounded 14px, bold blue text      */}
      {/* ==================================================================== */}
      <ActionSheet
        isOpen={showShareModal}
        onClose={handleCloseShareModal}
        items={shareModalItems}
        cancelLabel="Cancel"
      />
    </div>
  );
}
