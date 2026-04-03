'use client';

import Image from 'next/image';
import Avatar from '@/components/common/Avatar';
import iconBackChevron from '@/assets/icons/icon-back-chevron.svg';
import iconVideoCall from '@/assets/icons/icon-video-call.svg';
import iconPhoneCall from '@/assets/icons/icon-phone-call.svg';

/**
 * Props for the ChatHeader component.
 *
 * All callback props are required to ensure proper navigation and
 * action handling within the chat conversation view.
 */
export interface ChatHeaderProps {
  /** Display name of the contact */
  contactName: string;
  /** URL for the contact's avatar image */
  contactAvatar?: string;
  /** Subtitle text below the contact name. Defaults to "tap here for contact info" */
  subtitle?: string;
  /** Whether the contact is currently online — shows green indicator dot */
  isOnline?: boolean;
  /** Whether the contact is currently typing — overrides subtitle to "typing..." */
  isTyping?: boolean;
  /** Callback invoked when back button is pressed to navigate to chat list */
  onBack: () => void;
  /** Callback invoked when the contact info area (avatar + name) is pressed */
  onContactInfo: () => void;
  /** Callback invoked when the video call icon button is pressed */
  onVideoCall: () => void;
  /** Callback invoked when the phone call icon button is pressed */
  onPhoneCall: () => void;
}

/**
 * ChatHeader — Top header bar for an individual chat conversation.
 *
 * Renders a back-navigation chevron, the contact's avatar with an optional
 * online indicator, the contact name, a dynamic subtitle (typing / online /
 * custom text), and video-call / phone-call action icons.
 *
 * **Figma reference:** Node 0:8435 (Contact Actions Bar) inside
 * WhatsApp Chat screen (0:8257), file key miK1B6qEPrUnRZ9wwZNrW2.
 *
 * **Dimensions:** 375 × 88 px (44 px status-bar spacer + 44 px controls).
 *
 * **Responsive:** The back chevron is hidden on desktop (≥ 1280 px) where a
 * persistent sidebar provides navigation. On mobile / tablet the header spans
 * the full viewport width.
 *
 * BLITZY [COLOR]: Figma uses SF Pro Text (iOS system font). Snapped to
 * system-ui font stack (-apple-system, BlinkMacSystemFont, …) defined in
 * tailwind.config.ts. Exact glyph metrics may differ slightly on non-Apple
 * platforms.
 *
 * BLITZY [CONTRAST]: Subtitle text-secondary (#8E8E93) on bg-nav (#F6F6F6)
 * yields 3.02:1 contrast — below WCAG AA 4.5:1 for 12 px text. This matches
 * the Figma design token (fill_H2GVJJ); flagged, not overridden per DS7.
 */
export default function ChatHeader({
  contactName,
  contactAvatar,
  subtitle,
  isOnline = false,
  isTyping = false,
  onBack,
  onContactInfo,
  onVideoCall,
  onPhoneCall,
}: ChatHeaderProps) {
  /*
   * Subtitle text follows a strict priority order:
   *   1. isTyping  → "typing…"
   *   2. isOnline  → "online"
   *   3. explicit subtitle prop  → use it
   *   4. fallback  → "tap here for contact info"
   */
  const subtitleText: string = isTyping
    ? 'typing...'
    : isOnline
      ? 'online'
      : subtitle || 'tap here for contact info';

  return (
    <header
      className="w-full h-22 bg-nav shadow-nav-bottom flex flex-col flex-shrink-0"
      role="banner"
    >
      {/* ── Status-bar spacer — 44 px zone at top of the 88 px header ── */}
      <div className="h-status-bar flex-shrink-0" aria-hidden="true" />

      {/* ── Navigation controls — 44 px zone with flex layout ── */}
      <nav
        className="h-nav-bar flex items-center ps-[9px] pe-[19.5px] desktop:ps-4"
        aria-label="Chat navigation"
      >
        {/* Back button — hidden on desktop where the sidebar provides nav */}
        <button
          type="button"
          onClick={onBack}
          className="desktop:hidden flex items-center justify-start min-h-[44px] -ms-[9px] ps-[9px] pe-[23px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-1"
          aria-label="Go back to chat list"
        >
          <Image
            src={iconBackChevron}
            alt=""
            width={12}
            height={21}
            className="flex-shrink-0"
            aria-hidden="true"
          />
        </button>

        {/* Contact info area — avatar + name / subtitle column */}
        <button
          type="button"
          onClick={onContactInfo}
          className="flex items-center gap-2 flex-1 min-w-0 ms-[18px] desktop:ms-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-1"
          aria-label={`View contact info for ${contactName}`}
        >
          {/* Avatar with optional online indicator (green dot) */}
          <div className="relative flex-shrink-0">
            <Avatar
              src={contactAvatar}
              alt={contactName}
              size="sm"
            />
            {isOnline && (
              <span
                className="absolute bottom-0 end-0 block w-2.5 h-2.5 rounded-full bg-toggle-green border-[1.5px] border-nav"
                aria-hidden="true"
              />
            )}
          </div>

          {/* Name and subtitle column */}
          <div className="flex flex-col items-start min-w-0">
            <span className="font-semibold text-[16px] leading-[1.193em] tracking-tighter-ios text-black truncate max-w-[160px]">
              {contactName}
            </span>
            {/* BLITZY [CONTRAST]: Subtitle #8E8E93 on #F6F6F6 is 3.02:1 — below WCAG AA 4.5:1 for 12 px text. Matches Figma design intent; do not override system token. */}
            <span
              className="font-normal text-[12px] leading-[1.333em] text-secondary truncate max-w-[160px]"
              aria-live="polite"
            >
              {subtitleText}
            </span>
          </div>
        </button>

        {/* Call action icons — pushed to inline-end */}
        <div className="flex items-center gap-[24.5px] ms-auto flex-shrink-0">
          {/* Video call — padding extends 44 px tap area, negative margin preserves layout position */}
          <button
            type="button"
            onClick={onVideoCall}
            className="relative flex items-center justify-center px-[9.5px] py-[14px] -mx-[9.5px] -my-[14px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-1"
            aria-label={`Video call ${contactName}`}
          >
            <Image
              src={iconVideoCall}
              alt=""
              width={25}
              height={16}
              aria-hidden="true"
            />
          </button>

          {/* Phone call — padding extends 44 px tap area, negative margin preserves layout position */}
          <button
            type="button"
            onClick={onPhoneCall}
            className="relative flex items-center justify-center p-[11.5px] -m-[11.5px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-1"
            aria-label={`Call ${contactName}`}
          >
            <Image
              src={iconPhoneCall}
              alt=""
              width={21}
              height={21}
              aria-hidden="true"
            />
          </button>
        </div>
      </nav>
    </header>
  );
}
