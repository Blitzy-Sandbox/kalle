'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/authStore';
import { NavigationBar } from '@/components/common/NavigationBar';
import Avatar from '@/components/common/Avatar';
import { Separator } from '@/components/common/Separator';

/**
 * EditProfilePage — WhatsApp Edit Profile screen (Figma Screen 15, node 0:10659).
 *
 * Renders a form-like page allowing the authenticated user to edit their profile:
 * - Avatar (tap to change via native file picker)
 * - Display name (editable text input, auto-saves on blur)
 * - Phone number (read-only display)
 * - About text (editable text input, auto-saves on blur)
 *
 * All data sourced from and persisted via the Zustand auth store's
 * `user` state and `updateProfile` action.
 *
 * Design spec: 375×812px iPhone X frame, #EFEFF4 page background,
 * iOS-style navigation bar with "Settings" back action.
 *
 * Tab bar is rendered by the parent (main) layout — NOT duplicated here.
 *
 * @see https://www.figma.com/design/miK1B6qEPrUnRZ9wwZNrW2/?node-id=0-10659
 */
export default function EditProfilePage() {
  const router = useRouter();
  const { user, updateProfile } = useAuthStore();

  /* ── Local controlled state for editable fields ── */
  const [name, setName] = useState(user?.displayName ?? '');
  const [about, setAbout] = useState(user?.about ?? '');

  /* ── Ref for hidden file input (avatar upload) ── */
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ────────────────────────────────────────────────
   * Event Handlers
   * ──────────────────────────────────────────────── */

  /**
   * Saves display name to auth store on blur when changed.
   * Reverts to the original value if the user clears the field
   * (empty display names are not allowed).
   */
  const handleNameBlur = () => {
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== (user?.displayName ?? '')) {
      updateProfile({ displayName: trimmedName });
    } else if (!trimmedName) {
      setName(user?.displayName ?? '');
    }
  };

  /**
   * Saves about text to auth store on blur when changed.
   * Empty about text is allowed (clears the about field).
   */
  const handleAboutBlur = () => {
    const trimmedAbout = about.trim();
    if (trimmedAbout !== (user?.about ?? '')) {
      updateProfile({ about: trimmedAbout });
    }
  };

  /**
   * Opens the native file picker for avatar image selection.
   * Triggered by both the avatar image and the "Edit" link below it.
   */
  const handleAvatarEdit = () => {
    fileInputRef.current?.click();
  };

  /**
   * Reads the selected avatar image file as a data URL and persists
   * it to the auth store. Only accepts image/* MIME types.
   * Resets the input value after read so re-selecting the same file
   * correctly triggers the change event again.
   */
  const handleAvatarChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) {
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      updateProfile({ avatar: dataUrl });
    };
    reader.readAsDataURL(file);

    /* Reset input so re-selecting the same file fires onChange */
    event.target.value = '';
  };

  /**
   * Navigates back to the Settings page.
   * Uses router.back() for natural history navigation; falls back
   * to router.push('/settings') when there is no browser history
   * (e.g., direct URL access).
   */
  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push('/settings');
    }
  };

  /* ────────────────────────────────────────────────
   * Render
   * ──────────────────────────────────────────────── */
  return (
    <div className="flex flex-col min-h-full bg-surface">
      {/* ── Navigation Bar (Figma node 0:10682) ── */}
      <NavigationBar
        title="Edit Profile"
        leftAction={
          <>
            {/* Back chevron — icon-back-chevron.svg, fill inherits blue-ios via currentColor */}
            <svg
              width="12"
              height="21"
              viewBox="0 0 12 21"
              fill="none"
              aria-hidden="true"
              className="shrink-0"
            >
              <path
                d="M3.60206 10.5L11.4062 2.55085C11.9866 1.9597 11.9778 1.00999 11.3867 0.429623C10.7955 -0.150747 9.84583 -0.142006 9.26546 0.449147L0.429623 9.44915C-0.143208 10.0326 -0.143208 10.9674 0.429623 11.5509L9.26546 20.5509C9.84583 21.142 10.7955 21.1507 11.3867 20.5704C11.9778 19.99 11.9866 19.0403 11.4062 18.4491L3.60206 10.5Z"
                fill="currentColor"
              />
            </svg>
            <span>Settings</span>
          </>
        }
        onLeftAction={handleBack}
      />

      {/* ── Scrollable content area ── */}
      <div className="flex-1 overflow-y-auto" role="region" aria-label="Edit profile">
        {/* Hidden file input for avatar upload — visually hidden but accessible */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleAvatarChange}
          className="sr-only"
          tabIndex={-1}
          aria-label="Upload profile picture"
        />

        {/* ═══════════════════════════════════════════
         *  EDIT NAME SECTION (Figma node 0:10661)
         *  375×212px, bg-white, bottom shadow-card
         * ═══════════════════════════════════════════ */}
        <section className="bg-white shadow-card" aria-label="Edit name">
          {/* Avatar + Instruction row — starts 55px from section top */}
          <div className="flex items-start pt-[55px] px-4">
            {/* Left column: Avatar (60×60) + "Edit" link centered below */}
            <div className="flex flex-col items-center shrink-0">
              <Avatar
                src={user?.avatar ?? null}
                alt={user?.displayName ?? 'Profile picture'}
                customSize={60}
                onClick={handleAvatarEdit}
              />
              <button
                type="button"
                onClick={handleAvatarEdit}
                className="mt-[5px] text-[14px] leading-[1.57em] tracking-[-0.02em] text-blue-ios font-normal rounded-sm focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2"
                aria-label="Edit profile picture"
              >
                Edit
              </button>
            </div>

            {/* Right column: Instruction text (Figma node 0:10664)
                Positioned 20px (ms-5) from avatar right edge,
                12px (mt-3) below avatar top. Max width 240px. */}
            <p className="ms-5 mt-3 text-[12px] leading-[1.5em] text-secondary font-normal max-w-[240px]">
              Enter your name and add an optional profile picture
            </p>
          </div>

          {/* 13px spacer: gap between Edit link bottom (y:142) and separator (y:155.5) */}
          <div className="h-[13px]" aria-hidden="true" />

          {/* Separator 1 (Figma node 0:10681) — inset at x:16, width 359px */}
          <Separator inset insetLeft={16} />

          {/* Name input row (Figma node 0:10665) — 40px tall */}
          <div className="h-10">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleNameBlur}
              className="w-full h-full bg-transparent outline-none px-4 text-[16px] leading-[1.375em] tracking-tighter-ios text-black font-normal rounded-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-inset"
              placeholder="Your name"
              aria-label="Display name"
            />
          </div>

          {/* Separator 2 (Figma node 0:10680) — inset at x:16, width 359px */}
          <Separator inset insetLeft={16} />

          {/* 16px bottom padding to reach 212px total section height */}
          <div className="h-4" aria-hidden="true" />
        </section>

        {/* ═══════════════════════════════════════════
         *  PHONE NUMBER SECTION (Figma node 0:10668)
         *  30px gap from Edit Name, 375×67px
         * ═══════════════════════════════════════════ */}
        <section className="mt-[30px]" aria-label="Phone number">
          {/* Section header — uppercase, #636366, 12px */}
          <h2 className="text-[12px] leading-[1.19em] text-[#636366] uppercase font-normal px-4">
            Phone number
          </h2>

          {/* Value row — 47px, white bg, top+bottom 0.33px hairline shadows */}
          <div className="mt-[6px] bg-white h-[47px] shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)] flex items-center px-4">
            <p className="text-[16px] leading-[1.375em] tracking-tighter-ios text-black font-normal">
              {user?.phoneNumber ?? '+998 90 943 32 00'}
            </p>
          </div>
        </section>

        {/* ═══════════════════════════════════════════
         *  ABOUT SECTION (Figma node 0:10674)
         *  30px gap from Phone Number, 375×67px
         * ═══════════════════════════════════════════ */}
        <section className="mt-[30px]" aria-label="About">
          {/* Section header — uppercase, #636366, 12px */}
          <h2 className="text-[12px] leading-[1.19em] text-[#636366] uppercase font-normal px-4">
            About
          </h2>

          {/* Value row — 47px, white bg, top+bottom 0.33px hairline shadows, editable */}
          <div className="mt-[6px] bg-white h-[47px] shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)] flex items-center px-4">
            <input
              type="text"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              onBlur={handleAboutBlur}
              className="w-full h-full bg-transparent outline-none text-[16px] leading-[1.375em] tracking-tighter-ios text-black font-normal rounded-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-inset"
              placeholder="Add about"
              aria-label="About"
            />
          </div>
        </section>
      </div>
    </div>
  );
}
