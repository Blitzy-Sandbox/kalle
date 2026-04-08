'use client';

import React, { type FC, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

import { NavigationBar } from '../common/NavigationBar';
import { TabBar } from '../common/TabBar';
import { Separator } from '../common/Separator';
import { StatusBar } from '../common/StatusBar';
import Avatar from '../common/Avatar';
import { useAuthStore } from '../../stores/authStore';

/* ============================================================
 * ProfileEditorProps — Public interface for the ProfileEditor component
 *
 * Exposes configuration for initial field values, save callback,
 * navigation, and tab bar integration. Fields not supplied fall
 * back to values from the Zustand auth store.
 * ============================================================ */

/**
 * Props for the ProfileEditor component.
 *
 * @property onBack - Optional callback for navigating back. Falls back to router.back().
 * @property activeTab - Active tab identifier for the bottom tab bar. Defaults to 'settings'.
 * @property onTabPress - Callback fired when a tab bar button is pressed.
 * @property className - Additional CSS class names for the root container.
 * @property initialName - Initial display name value. Falls back to auth store user.displayName.
 * @property initialPhone - Initial phone number display value. Falls back to auth store user.phoneNumber.
 * @property initialAbout - Initial about/status text value. Falls back to auth store user.about.
 * @property initialAvatar - Initial avatar URL. Falls back to auth store user.avatar.
 * @property onSave - Callback fired when the user saves profile changes.
 */
export interface ProfileEditorProps {
  onBack?: () => void;
  activeTab?: 'settings';
  onTabPress?: (tab: string) => void;
  className?: string;
  initialName?: string;
  initialPhone?: string;
  initialAbout?: string;
  initialAvatar?: string;
  onSave?: (data: { name: string; about: string }) => void;
}

/* ============================================================
 * BackChevron — Inline SVG for iOS-style back navigation arrow
 *
 * Figma node 0:10686: 11.84×21px, fill #007AFF
 * Rendered as an inline SVG with fill="currentColor" so the
 * parent NavigationBar action button color (#007AFF) controls it.
 * ============================================================ */
const BackChevron: React.FC = () => (
  <svg
    width="12"
    height="21"
    viewBox="0 0 12 21"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    className="inline-block -mt-px"
  >
    <path
      d="M10.5 1L1.5 10.5L10.5 20"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/* ============================================================
 * DUAL_SHADOW — Combined top + bottom 0.33px shadows for
 * iOS-style form rows (Phone Number, About sections).
 *
 * Figma spec: dual shadow 0px -0.33px / 0px 0.33px rgba(60,60,67,0.29)
 * Tailwind's shadow utilities cannot combine two box-shadows,
 * so we use an inline style constant.
 * ============================================================ */
const DUAL_SHADOW =
  '0px -0.33px 0px rgba(60, 60, 67, 0.29), 0px 0.33px 0px rgba(60, 60, 67, 0.29)';

/**
 * ProfileEditor — Edit Profile screen component.
 *
 * Maps 1:1 to Figma Screen 15 (WhatsApp Edit Profile), node 0:10659,
 * file key miK1B6qEPrUnRZ9wwZNrW2. Dimensions: 375×812px.
 *
 * Layout structure (top to bottom):
 * 1. StatusBar — Simulated iOS status bar (hidden on mobile viewport)
 * 2. NavigationBar — "< Settings" back action + centered "Edit Profile" title
 * 3. Profile Card (white, 212px) — Avatar, "Edit" link, description, name input
 * 4. Phone Number Section — Uppercase label + read-only phone display row
 * 5. About Section — Uppercase label + editable about text row
 * 6. TabBar — Bottom tab bar with Settings tab active
 *
 * State:
 * - `name` — Controlled text input for display name
 * - `about` — Controlled text input for about/status text
 * - Values initialized from props or Zustand auth store
 *
 * Accessibility (R34):
 * - Name input: aria-label="Name"
 * - About input: aria-label="About"
 * - Phone display: aria-label="Phone number"
 * - "Edit" link for avatar: keyboard-accessible button
 * - All interactive elements have visible :focus-visible outlines
 *
 * @example
 * ```tsx
 * <ProfileEditor
 *   onBack={() => router.push('/settings')}
 *   onSave={(data) => api.updateProfile(data)}
 *   activeTab="settings"
 *   onTabPress={(tab) => router.push(`/${tab}`)}
 * />
 * ```
 */
const ProfileEditor: FC<ProfileEditorProps> = ({
  onBack,
  activeTab = 'settings',
  onTabPress,
  className = '',
  initialName,
  initialPhone,
  initialAbout,
  initialAvatar,
  onSave,
}) => {
  const router = useRouter();
  const { user, updateProfile } = useAuthStore();

  /* ----------------------------------------------------------------
   * Local Form State
   *
   * Initialized from props first (explicit overrides), then from
   * the auth store user profile, with sensible defaults.
   * ---------------------------------------------------------------- */
  const [name, setName] = useState<string>(
    initialName ?? user?.displayName ?? '',
  );
  const [about, setAbout] = useState<string>(
    initialAbout ?? user?.about ?? '',
  );

  /* Read-only values — not editable on this screen per Figma spec */
  const phone = initialPhone ?? user?.phoneNumber ?? '';
  const avatarUrl = initialAvatar ?? user?.avatar ?? '';

  /* ----------------------------------------------------------------
   * Event Handlers
   * ---------------------------------------------------------------- */

  /** Navigate back to the Settings screen */
  const handleBack = useCallback(() => {
    if (onBack) {
      onBack();
    } else {
      router.back();
    }
  }, [onBack, router]);

  /** Handle tab bar press — delegate to parent or navigate */
  const handleTabPress = useCallback(
    (tab: string) => {
      if (onTabPress) {
        onTabPress(tab);
      }
    },
    [onTabPress],
  );

  /** Persist profile changes via callback and store */
  const handleSave = useCallback(() => {
    const data = { name: name.trim(), about: about.trim() };

    /* Update local Zustand store */
    updateProfile({ displayName: data.name, about: data.about });

    /* Fire external save callback if provided */
    if (onSave) {
      onSave(data);
    }
  }, [name, about, updateProfile, onSave]);

  /** Handle name input blur — auto-save on field exit */
  const handleNameBlur = useCallback(() => {
    handleSave();
  }, [handleSave]);

  /** Handle about input blur — auto-save on field exit */
  const handleAboutBlur = useCallback(() => {
    handleSave();
  }, [handleSave]);

  /* ----------------------------------------------------------------
   * Render
   * ---------------------------------------------------------------- */
  return (
    <div
      className={`flex flex-col min-h-screen bg-surface ${className}`}
    >
      {/* ============================================================
       * Status Bar — Simulated iOS chrome (hidden on mobile)
       * Figma: 375×44px, bg #F7F7F7
       * ============================================================ */}
      <StatusBar />

      {/* ============================================================
       * Navigation Bar — Back to Settings + Edit Profile title
       * Figma node 0:10682: 375×44px (within 88px header zone)
       * Back group: chevron + "Settings" text in blue (#007AFF)
       * Title: "Edit Profile" centered, SF Pro Text 600, 17px, black
       * ============================================================ */}
      <NavigationBar
        title="Edit Profile"
        leftAction={
          <span className="flex items-center gap-1">
            <BackChevron />
            <span>Settings</span>
          </span>
        }
        onLeftAction={handleBack}
      />

      {/* ============================================================
       * Scrollable Content Area
       * Extends from below nav bar to above tab bar.
       * pb-[83px] reserves space for the fixed-position tab bar.
       * ============================================================ */}
      <div className="flex-1 overflow-y-auto pb-[83px]">
        {/* ============================================================
         * Profile Card — Avatar, Edit, Description, Name Input
         * Figma node 0:10661: (0, 88), 375×212px
         * Background: #FFFFFF, shadow-card at bottom
         * ============================================================ */}
        <div className="bg-white shadow-card">
          {/* Avatar + Description Row
           * Figma layout: avatar at (16, 55) relative to card,
           * description at (96, 67) relative to card.
           * Use flex row with padding-top to match Figma positioning. */}
          <div className="flex items-start pt-[55px] px-4 pb-[14px]">
            {/* Left column: Avatar + "Edit" link */}
            <div className="flex flex-col items-center flex-shrink-0">
              <Avatar
                src={avatarUrl || undefined}
                alt={name || 'Profile'}
                customSize={60}
              />
              {/* "Edit" link — Figma node 0:10662:
               * SF Pro Text 400, 14px, lineHeight 1.571em, letterSpacing -1.43%, fill #007AFF
               * At y=120, avatar bottom y=115 → 5px gap */}
              <button
                type="button"
                className="mt-[5px] text-[14px] leading-[1.571em] tracking-[-0.01em] text-blue-ios focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:rounded-sm"
                aria-label="Edit profile picture"
              >
                Edit
              </button>
            </div>

            {/* Right column: Description text
             * Figma node 0:10664: at (96, 67) relative to card, 240×36px
             * SF Pro Text 400, 12px, lineHeight 1.5em, fill #8E8E93
             * Avatar at y=55, description at y=67 → offset 12px (mt-3) */}
            <p className="ml-5 mt-3 text-[12px] leading-[1.5em] text-secondary max-w-[240px]">
              Enter your name and add an optional profile picture
            </p>
          </div>

          {/* Separator above name field
           * Figma node 0:10681: at x=16, width=359px */}
          <Separator inset insetLeft={16} />

          {/* Name Input Field
           * Figma node 0:10665: 375×40px, "Sabohiddin" text
           * SF Pro Text 400, 16px, lineHeight 1.375em, letterSpacing -2.06%, fill #000000 */}
          <div className="h-[40px] flex items-center">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleNameBlur}
              aria-label="Name"
              className="w-full h-full px-4 text-[16px] leading-[1.375em] tracking-[-0.02em] text-black bg-transparent border-none outline-none focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-inset"
              placeholder="Your name"
            />
          </div>

          {/* Separator below name field
           * Figma node 0:10680: at x=16, width=359px, at y≈195.5 in card */}
          <Separator inset insetLeft={16} />

          {/* Bottom spacer: card is 212px total; content fills to ~196px;
           * remaining ~16px preserves the clean bottom edge before the surface bg */}
          <div className="h-4" aria-hidden="true" />
        </div>

        {/* ============================================================
         * Phone Number Section
         * Figma node 0:10668: (0, 330), 375×67px
         * Gap from profile card: 30px
         * ============================================================ */}
        <div className="mt-[30px]">
          {/* Section label — "PHONE NUMBER"
           * Figma node 0:10673: SF Pro Text 400, 12px, fill #636366
           * Uppercase per AAP and Figma render */}
          <p className="px-4 pb-[6px] text-[12px] leading-[1.193em] tracking-[-0.001em] text-[#636366] uppercase">
            PHONE NUMBER
          </p>

          {/* Phone value row — white with dual 0.33px shadows
           * Figma node 0:10670: 375×47px, bg #FFFFFF
           * "+998 90 943 32 00" at (16, 12) */}
          <div
            className="h-[47px] flex items-center bg-white px-4"
            style={{ boxShadow: DUAL_SHADOW }}
            aria-label="Phone number"
          >
            <span className="text-[16px] leading-[1.375em] tracking-[-0.02em] text-black">
              {phone || '+998 90 943 32 00'}
            </span>
          </div>
        </div>

        {/* ============================================================
         * About Section
         * Figma node 0:10674: (0, 427), 375×67px
         * Gap from phone section: 30px
         * ============================================================ */}
        <div className="mt-[30px]">
          {/* Section label — "ABOUT"
           * Figma node 0:10679: SF Pro Text 400, 12px, fill #636366
           * Uppercase per AAP and Figma render */}
          <p className="px-4 pb-[6px] text-[12px] leading-[1.193em] tracking-[-0.001em] text-[#636366] uppercase">
            ABOUT
          </p>

          {/* About value row — white with dual 0.33px shadows
           * Figma node 0:10676: 375×47px, bg #FFFFFF
           * Editable text */}
          <div
            className="h-[47px] flex items-center bg-white"
            style={{ boxShadow: DUAL_SHADOW }}
          >
            <input
              type="text"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              onBlur={handleAboutBlur}
              aria-label="About"
              className="w-full h-full px-4 text-[16px] leading-[1.375em] tracking-[-0.02em] text-black bg-transparent border-none outline-none focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-inset"
              placeholder="About"
            />
          </div>
        </div>
      </div>

      {/* ============================================================
       * Tab Bar — Bottom navigation, Settings active
       * Figma: y=729, 375×83px, Tab 5 "Settings" fill #007AFF
       * ============================================================ */}
      <TabBar
        activeTab={activeTab}
        onTabPress={(tab) => handleTabPress(tab)}
      />
    </div>
  );
};

export { ProfileEditor };
export default ProfileEditor;
