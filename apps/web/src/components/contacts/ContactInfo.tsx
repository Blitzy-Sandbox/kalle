'use client';

import React, { FC, useCallback } from 'react';
import Image from 'next/image';
import { NavigationBar } from '../common/NavigationBar';
import Avatar from '../common/Avatar';
import { SettingsRow } from '../common/SettingsRow';
import { Separator } from '../common/Separator';
import { StatusBar } from '../common/StatusBar';

/* ===== Static SVG asset imports ===== */
import iconVideoCall from '@/assets/icons/icon-video-call.svg';
import iconPhoneCall from '@/assets/icons/icon-phone-call.svg';
import iconMediaDocs from '@/assets/icons/icon-media-docs.svg';
import iconStar from '@/assets/icons/icon-star.svg';
import iconSearch from '@/assets/icons/icon-search.svg';
import iconMuteSpeaker from '@/assets/icons/icon-mute-speaker.svg';

/* ==========================================================================
 * ContactInfo — Contact Detail Screen Component
 *
 * Maps 1:1 to Figma Screen 6 (WhatsApp Contact Info, node 0:9486)
 * from Figma file miK1B6qEPrUnRZ9wwZNrW2.
 *
 * Full screen layout (top→bottom, y-positions from Figma):
 *   1. StatusBar (0:9610):        y=0,    375×44px
 *   2. NavigationBar (0:9603):    y=0,    within 88px frame
 *   3. Profile Photo (0:9602):    y=88,   375×375px
 *   4. Info & Actions (0:9487):   y=463,  375×126.5px
 *   5. Rows Group 1 (0:9513):    y=608.5, 375×141px
 *   6. Rows Group 2 (0:9548):    y=768.5, 375×215px
 *   7. Home Indicator (0:9631):   y=778,  375×34px
 *
 * Frame: 375×812px (iPhone X), background #EFEFF4 (bg-surface).
 *
 * WCAG 2.1 AA compliant (Rule R34):
 * - Action buttons are <button> elements with aria-labels
 * - Visible :focus-visible outlines on all interactive elements
 * - Semantic landmarks (<main>), heading for screen readers
 * - Decorative icons use aria-hidden="true"
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * Inline SVG — Back Chevron (12×21px)
 *
 * Replicates icon-back-chevron.svg as an inline component for the
 * NavigationBar left-action slot. Rendered with currentColor to inherit
 * the blue-ios (#007AFF) text colour from the parent span.
 * Source: Figma node 0:9608, 11.84×21px, fill #007AFF.
 * -------------------------------------------------------------------------- */
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

/* --------------------------------------------------------------------------
 * Inline SVG — Message Action Icon (chat bubble)
 *
 * Extracted from the composite icon-message-action.svg (132×36px) which
 * contains all three action-circle icons in one file. Since we need
 * separate click targets per button, we render the chat-bubble path
 * standalone. The original path is centred at (18,18) in a 36×36 space;
 * we crop the viewBox to the bubble bounds for correct sizing.
 *
 * Figma node 0:9498, fill #007AFF.
 * -------------------------------------------------------------------------- */
function MessageBubbleIcon() {
  return (
    <svg
      width="18"
      height="17"
      viewBox="9 10 18 17"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M18 10.5C22.9706 10.5 27 13.7459 27 17.75C27 21.7541 22.9706 25 18 25C17.0973 25 16.2253 24.8756 15.4 24.6416L12 27V23.0279C10.0967 21.7127 9 19.8381 9 17.75C9 13.7459 13.0294 10.5 18 10.5Z"
        fill="#007AFF"
      />
    </svg>
  );
}

/* --------------------------------------------------------------------------
 * Inline SVG — Custom Tone Bell Icon (29×29px)
 *
 * No dedicated bell/tone SVG exists in the asset inventory. The only
 * available notification icon (icon-settings-notifications.svg) has a
 * red (#FF3B2F) background baked in, but Figma specifies pink (#EC72D7)
 * for the Custom Tone row icon (node 0:9568).
 *
 * BLITZY [ASSET]: Custom Tone bell icon missing from Figma export.
 * Created inline with pink background per Figma spec.
 * -------------------------------------------------------------------------- */
function CustomToneBellIcon() {
  return (
    <svg
      width="29"
      height="29"
      viewBox="0 0 29 29"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="29" height="29" rx="6" fill="#EC72D7" />
      <path
        d="M14.5 7C11.739 7 9.5 9.239 9.5 12V15.382L8.176 17.368C8.062 17.539 8 17.742 8 17.95C8 18.531 8.469 19 9.05 19H19.95C20.531 19 21 18.531 21 17.95C21 17.742 20.938 17.539 20.824 17.368L19.5 15.382V12C19.5 9.239 17.261 7 14.5 7ZM12.5 20C12.5 21.105 13.395 22 14.5 22C15.605 22 16.5 21.105 16.5 20H12.5Z"
        fill="white"
      />
    </svg>
  );
}

/* --------------------------------------------------------------------------
 * Inline SVG — Save to Camera Roll Icon (29×29px)
 *
 * No dedicated camera-roll SVG exists in the asset inventory.
 * Figma node 0:9577 specifies a 29×29 icon with amber (#FBB500) bg.
 *
 * BLITZY [ASSET]: Camera-roll icon missing from Figma export.
 * Created inline with amber background per Figma spec.
 * -------------------------------------------------------------------------- */
function CameraRollIcon() {
  return (
    <svg
      width="29"
      height="29"
      viewBox="0 0 29 29"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="29" height="29" rx="6" fill="#FBB500" />
      <path
        d="M8.5 11.5H11L12.25 9.5H16.75L18 11.5H20.5C21.052 11.5 21.5 11.948 21.5 12.5V20C21.5 20.552 21.052 21 20.5 21H8.5C7.948 21 7.5 20.552 7.5 20V12.5C7.5 11.948 7.948 11.5 8.5 11.5ZM14.5 19C16.157 19 17.5 17.657 17.5 16C17.5 14.343 16.157 13 14.5 13C12.843 13 11.5 14.343 11.5 16C11.5 17.657 12.843 19 14.5 19Z"
        fill="white"
      />
    </svg>
  );
}

/* --------------------------------------------------------------------------
 * Inline SVG — Encryption Lock Icon (29×29px)
 *
 * No dedicated lock SVG exists in the asset inventory.
 * Figma node 0:9588 specifies a 29×29 icon with blue (#3396FD) bg
 * for the Encryption row in Rows Group 2.
 *
 * BLITZY [ASSET]: Lock icon missing from Figma export.
 * Created inline with blue background per Figma spec.
 * -------------------------------------------------------------------------- */
function EncryptionLockIcon() {
  return (
    <svg
      width="29"
      height="29"
      viewBox="0 0 29 29"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="29" height="29" rx="6" fill="#3396FD" />
      <path
        d="M11 13V11.5C11 9.567 12.567 8 14.5 8C16.433 8 18 9.567 18 11.5V13H19C19.552 13 20 13.448 20 14V21C20 21.552 19.552 22 19 22H10C9.448 22 9 21.552 9 21V14C9 13.448 9.448 13 10 13H11ZM12.5 13H16.5V11.5C16.5 10.395 15.605 9.5 14.5 9.5C13.395 9.5 12.5 10.395 12.5 11.5V13Z"
        fill="white"
      />
    </svg>
  );
}

/* --------------------------------------------------------------------------
 * Inline SVG — Chevron Right (7×12px)
 *
 * Disclosure indicator arrow used in the custom Encryption row.
 * Colour: rgba(60,60,67,0.3), matching Figma and SettingsRow pattern.
 * -------------------------------------------------------------------------- */
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

/* ==========================================================================
 * ContactInfoProps Interface
 * ========================================================================== */

/**
 * Props for the ContactInfo component.
 *
 * All optional callback handlers follow React event convention — undefined
 * means the action is not available. All display props use sensible defaults
 * when omitted to ensure the component always renders a valid UI state.
 */
export interface ContactInfoProps {
  /** Unique contact identifier */
  contactId: string;
  /** Contact display name — rendered as heading and in nav-bar back link */
  name: string;
  /** Contact phone number with country code (e.g. "+1 202 555 0181") */
  phone: string;
  /** URL for the contact's profile photo. Falls back to Avatar initials when omitted */
  avatarUrl?: string;
  /** Status / bio text shown below name and phone */
  statusText?: string;
  /** Date the status was set (e.g. "Dec 18, 2018") */
  statusDate?: string;
  /** Number of shared media items — shown in "Media, Links, and Docs" row */
  mediaCount?: number;
  /** Whether this contact is currently muted */
  isMuted?: boolean;
  /** Navigate back (tapping back chevron / contact name in nav bar) */
  onBack?: () => void;
  /** Navigate to edit contact screen (tapping "Edit" in nav bar) */
  onEdit?: () => void;
  /** Start a chat with this contact (tapping message action circle) */
  onMessage?: () => void;
  /** Start a video call (tapping video action circle) */
  onVideoCall?: () => void;
  /** Start a phone call (tapping phone action circle) */
  onPhoneCall?: () => void;
  /** Additional CSS class names for the root container */
  className?: string;
}

/* ==========================================================================
 * ContactInfo Component
 * ========================================================================== */

/**
 * ContactInfo renders the full contact detail / info screen.
 *
 * Structure mirrors the Figma Screen 6 layout precisely:
 * StatusBar → NavigationBar → Profile Photo → Name/Phone/Actions →
 * Bio Section → Row Group 1 (Media/Starred/Search) →
 * Row Group 2 (Mute/Tone/CameraRoll/Encryption).
 *
 * The screen is vertically scrollable since total content height (≈978px)
 * exceeds the 812px viewport. StatusBar and NavigationBar stay at the top
 * of the natural flow while the <main> area scrolls independently.
 */
const ContactInfo: FC<ContactInfoProps> = ({
  contactId,
  name,
  phone,
  avatarUrl,
  statusText,
  statusDate,
  mediaCount,
  isMuted = false,
  onBack,
  onEdit,
  onMessage,
  onVideoCall,
  onPhoneCall,
  className,
}) => {
  /* Memoised callback wrappers for event handlers */
  const handleBack = useCallback(() => onBack?.(), [onBack]);
  const handleEdit = useCallback(() => onEdit?.(), [onEdit]);
  const handleMessage = useCallback(() => onMessage?.(), [onMessage]);
  const handleVideoCall = useCallback(() => onVideoCall?.(), [onVideoCall]);
  const handlePhoneCall = useCallback(() => onPhoneCall?.(), [onPhoneCall]);

  return (
    <div
      className={`flex flex-col h-full bg-surface ${className ?? ''}`.trim()}
      data-contact-id={contactId}
    >
      {/* Screen-reader-only heading for landmark navigation (WCAG) */}
      <h1 className="sr-only">{`${name} — Contact Info`}</h1>

      {/* ---- Simulated iOS Status Bar (desktop only, hidden on mobile) ---- */}
      <StatusBar />

      {/* ---- Navigation Bar ----
           Figma node 0:9603: bg #F6F6F6, shadow-nav
           Left: back chevron (0:9608) + contact name in blue
           Centre: "Contact Info" (600 17px, #000)
           Right: "Edit" (400 17px, #007AFF) */}
      <NavigationBar
        title="Contact Info"
        leftAction={
          <span className="inline-flex items-center gap-[5px] text-blue-ios">
            <BackChevron />
            <span className="font-sans font-normal text-[17px] leading-[1.294em] tracking-[-0.04em] max-w-[90px] truncate">
              {name}
            </span>
          </span>
        }
        onLeftAction={handleBack}
        rightAction={
          <span className="font-sans font-normal text-[17px] leading-[1.294em] tracking-[-0.04em] text-blue-ios">
            Edit
          </span>
        }
        onRightAction={handleEdit}
      />

      {/* ---- Scrollable Content Area ---- */}
      <main className="flex-1 overflow-y-auto">

        {/* ==== Profile Photo (node 0:9602) ====
             375×375px, full width, objectFit cover.
             Bottom shadow: 0px 0.33px rgba(60,60,67,0.29). */}
        <div className="relative w-full aspect-square max-w-[375px] mx-auto shadow-card bg-white overflow-hidden">
          {avatarUrl ? (
            <Image
              src={avatarUrl}
              alt={`${name} profile photo`}
              fill
              className="object-cover"
              sizes="(max-width: 375px) 100vw, 375px"
              priority
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gray-200">
              <Avatar alt={name} size="lg" customSize={120} />
            </div>
          )}
        </div>

        {/* ==== Info & Actions Section (node 0:9487) ====
             y=463, 375×126.5px, bg #FFFFFF, bottom shadow-card.
             Sub-sections: Name/Phone + Action Btns → Separator → Bio. */}
        <div className="bg-white shadow-card">
          {/* ---- Name, Phone & Action Buttons (node 0:9490, 375×66px) ---- */}
          <div className="relative flex items-start justify-between pl-[15px] pr-[15px] pt-[11px] h-[66px]">
            {/* Left: Name + Phone */}
            <div className="flex flex-col min-w-0">
              <span className="font-sans font-medium text-[18px] leading-[1.278em] tracking-[-0.04em] text-black truncate">
                {name}
              </span>
              <span className="font-sans font-normal text-[12px] leading-[1.333em] text-secondary mt-[6px]">
                {phone}
              </span>
            </div>

            {/* Right: Action Buttons (node 0:9491, 132×36px, gap 12px)
                 Three circular buttons at 36×36px each, bg #EDEDFF.
                 Positioned at y=15 within the 66px row (centred vertically). */}
            <div className="flex items-center gap-[12px] mt-[4px] flex-shrink-0">
              {/* Message (node 0:9498) */}
              <button
                type="button"
                onClick={handleMessage}
                className="w-[36px] h-[36px] rounded-full bg-[#EDEDFF] flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-ios motion-safe:transition-colors motion-safe:duration-150"
                aria-label="Send message"
              >
                <MessageBubbleIcon />
              </button>

              {/* Video Call (node 0:9492) */}
              <button
                type="button"
                onClick={handleVideoCall}
                className="w-[36px] h-[36px] rounded-full bg-[#EDEDFF] flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-ios motion-safe:transition-colors motion-safe:duration-150"
                aria-label="Start video call"
              >
                <Image
                  src={iconVideoCall}
                  alt=""
                  width={20}
                  height={12}
                  aria-hidden="true"
                />
              </button>

              {/* Phone Call (node 0:9502) */}
              <button
                type="button"
                onClick={handlePhoneCall}
                className="w-[36px] h-[36px] rounded-full bg-[#EDEDFF] flex items-center justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-ios motion-safe:transition-colors motion-safe:duration-150"
                aria-label="Start phone call"
              >
                <Image
                  src={iconPhoneCall}
                  alt=""
                  width={18}
                  height={18}
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>

          {/* ---- Separator (node 0:9512, x=16, 359px wide) ---- */}
          <Separator inset insetLeft={16} />

          {/* ---- Bio / Status Section (node 0:9509, 375×60px) ----
               Status text at (15,11.5): 14px/1.143em/-0.02em, #000
               Date at (15,34.5): 12px/1.333em, #8E8E93 */}
          <div className="px-[15px] pt-[11px] pb-[14px]">
            {statusText ? (
              <p className="font-sans font-normal text-[14px] leading-[1.143em] tracking-[-0.02em] text-black">
                {statusText}
              </p>
            ) : (
              <p className="font-sans font-normal text-[14px] leading-[1.143em] tracking-[-0.02em] text-secondary">
                No status
              </p>
            )}
            {statusDate && (
              <p className="font-sans font-normal text-[12px] leading-[1.333em] text-secondary mt-[7px]">
                {statusDate}
              </p>
            )}
          </div>
        </div>

        {/* ==== Section Gap (19px, bg-surface shows through) ==== */}
        <div className="h-[19px]" aria-hidden="true" />

        {/* ==== Rows Group 1 (node 0:9513) ====
             y=608.5, 375×141px, bg #FFFFFF.
             Dual shadow: top + bottom 0.33px rgba(60,60,67,0.29).
             3 rows × 47px: Media / Starred Messages / Chat Search.
             Icon SVGs have baked-in coloured backgrounds — pass iconBgColor="transparent"
             so SettingsRow's hasIcon guard is truthy while not adding a second bg. */}
        <div
          className="bg-white shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)]"
          role="group"
          aria-label="Contact media and search options"
        >
          {/* Row 1 — Media, Links, and Docs (node 0:9515)
               Icon bg: #3396FD (built into SVG), label + value "12" + chevron */}
          <SettingsRow
            icon={
              <Image
                src={iconMediaDocs}
                alt=""
                width={29}
                height={29}
                aria-hidden="true"
              />
            }
            iconBgColor="transparent"
            label="Media, Links, and Docs"
            value={String(mediaCount ?? 0)}
            showChevron
            showSeparator
          />

          {/* Row 2 — Starred Messages (node 0:9527)
               Icon bg: #FBB500 (built into SVG), value "None" */}
          <SettingsRow
            icon={
              <Image
                src={iconStar}
                alt=""
                width={29}
                height={29}
                aria-hidden="true"
              />
            }
            iconBgColor="transparent"
            label="Starred Messages"
            value="None"
            showChevron
            showSeparator
          />

          {/* Row 3 — Chat Search (node 0:9536)
               Icon bg: #FE8D35 (built into SVG), no value text */}
          <SettingsRow
            icon={
              <Image
                src={iconSearch}
                alt=""
                width={29}
                height={29}
                aria-hidden="true"
              />
            }
            iconBgColor="transparent"
            label="Chat Search"
            showChevron
          />
        </div>

        {/* ==== Section Gap ==== */}
        <div className="h-[19px]" aria-hidden="true" />

        {/* ==== Rows Group 2 (node 0:9548) ====
             y=768.5, 375×215px, bg #FFFFFF, dual shadow.
             4 rows: Mute / Custom Tone / Save to Camera Roll / Encryption.
             Encryption row is custom (74px tall with description text). */}
        <div
          className="bg-white shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)]"
          role="group"
          aria-label="Contact notification and security settings"
        >
          {/* Row 1 — Mute (node 0:9550)
               Icon bg: #1FC434 (built into SVG), value: "No" / "Yes" */}
          <SettingsRow
            icon={
              <Image
                src={iconMuteSpeaker}
                alt=""
                width={29}
                height={29}
                aria-hidden="true"
              />
            }
            iconBgColor="transparent"
            label="Mute"
            value={isMuted ? 'Yes' : 'No'}
            showChevron
            showSeparator
          />

          {/* Row 2 — Custom Tone (node 0:9563)
               Icon bg: #EC72D7 (inline SVG — no dedicated asset exists)
               BLITZY [DESIGN_SYSTEM_GAP]: Custom Tone bell icon not in Figma asset
               export. Created inline SVG with pink (#EC72D7) background. */}
          <SettingsRow
            icon={<CustomToneBellIcon />}
            iconBgColor="transparent"
            label="Custom Tone"
            value="Default (Note)"
            showChevron
            showSeparator
          />

          {/* Row 3 — Save to Camera Roll (node 0:9572)
               Icon bg: #FBB500 (inline SVG — no dedicated asset exists)
               BLITZY [DESIGN_SYSTEM_GAP]: Camera-roll icon not in Figma asset
               export. Created inline SVG with amber (#FBB500) background. */}
          <SettingsRow
            icon={<CameraRollIcon />}
            iconBgColor="transparent"
            label="Save to Camera Roll"
            value="Default"
            showChevron
            showSeparator
          />

          {/* Row 4 — Encryption (node 0:9583, CUSTOM — 74px tall)
               Not using SettingsRow: taller row with description text.
               Icon: 29×29 lock on blue #3396FD bg (inline SVG).
               Label: "Encryption" (16px, #000)
               Desc: 11px, #8E8E93, multi-line
               Chevron at right, vertically centred.
               BLITZY [DESIGN_SYSTEM_GAP]: Lock icon not in Figma asset export.
               Created inline SVG with blue (#3396FD) background. */}
          <button
            type="button"
            className="w-full h-[74px] bg-white flex items-center px-[15px] gap-[15px] active:bg-gray-100 motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-[-2px]"
            aria-label="Encryption details — messages secured with end-to-end encryption"
          >
            {/* Lock icon container */}
            <div className="flex-shrink-0">
              <EncryptionLockIcon />
            </div>

            {/* Label + description, stacked vertically */}
            <div className="flex-1 min-w-0">
              <span className="block font-sans font-normal text-[16px] leading-[1.375em] tracking-[-0.033em] text-black">
                Encryption
              </span>
              <span className="block font-sans font-normal text-[11px] leading-[1.273em] tracking-[-0.002em] text-secondary mt-[2px]">
                Messages to this chat and calls are secured with
                end-to-end encryption. Tap to verify.
              </span>
            </div>

            {/* Disclosure chevron */}
            <ChevronRight />
          </button>
        </div>

        {/* Bottom safe-area spacer for tab bar (83px) */}
        <div className="h-[83px]" aria-hidden="true" />
      </main>
    </div>
  );
};

export default ContactInfo;
