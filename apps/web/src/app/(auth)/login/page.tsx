'use client';

/* =============================================================================
 * Login/Registration Page — WhatsApp Authorization
 * =============================================================================
 *
 * Maps 1:1 to Figma Screen 0 — WhatsApp Authorization (node 0:11030)
 * URL: /login (within (auth) route group — parentheses excluded from URL)
 *
 * Entry point for unauthenticated users. Presents a phone number
 * registration/login interface with a custom numeric keyboard that feeds
 * digits into a read-only display (no native keyboard popup).
 *
 * Unauthenticated-only: redirects to /chat when user is already authenticated.
 * ========================================================================== */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/authStore';
import { apiClient, ApiError } from '@/lib/api';
import { StatusBar } from '@/components/common/StatusBar';
import { NavigationBar } from '@/components/common/NavigationBar';

/* =============================================================================
 * Local Type Definitions
 * =============================================================================
 * Define minimal interface types that structurally match the API response
 * shape from POST /api/v1/auth/register. The authStore.login() call uses
 * TypeScript structural typing to verify compatibility with the store's
 * TokenPair and UserResponse parameter types at the call site.
 * ========================================================================== */

/** Token pair from the authentication API — matches @kalle/shared TokenPair */
interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

/** User data from the authentication API — structurally compatible with
 *  @kalle/shared UserResponse for the authStore.login() call site. */
interface AuthUserData {
  id: string;
  email: string;
  displayName: string;
  avatar?: string;
  phoneNumber?: string;
  about?: string;
  status: string;
  lastSeen?: string;
  createdAt: string;
  updatedAt: string;
}

/** Full API response from POST /api/v1/auth/register */
interface AuthRegistrationResponse {
  tokens: AuthTokens;
  user: AuthUserData;
}

/* =============================================================================
 * Constants
 * ========================================================================== */

/** Maximum allowed phone number length per ITU-T E.164 standard */
const MAX_PHONE_LENGTH = 15;

/** Minimum phone number length required to enable the Done button */
const MIN_PHONE_LENGTH = 4;

/** Letter labels displayed below each numeric key on the keyboard */
const KEY_LABELS: Record<string, string> = {
  '2': 'ABC',
  '3': 'DEF',
  '4': 'GHI',
  '5': 'JKL',
  '6': 'MNO',
  '7': 'PQRS',
  '8': 'TUV',
  '9': 'WXYZ',
};

/**
 * Keyboard layout — 4 rows × 3 columns.
 * Empty string = invisible spacer (bottom-left).
 * 'delete' = backspace key (bottom-right).
 */
const KEYBOARD_ROWS: string[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['', '0', 'delete'],
];

/* =============================================================================
 * Inline SVG Sub-Components
 * ========================================================================== */

/**
 * Backspace/delete icon for the keyboard delete key.
 * Matches Figma node 0:11053 — 24×18px, fill #000000.
 */
function BackspaceIcon(): JSX.Element {
  return (
    <svg
      width="24"
      height="18"
      viewBox="0 0 24 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M8.4 1C7.9 1 7.4 1.2 7.1 1.6L1.3 8.3C1.1 8.5 1 8.7 1 9C1 9.3 1.1 9.5 1.3 9.7L7.1 16.4C7.4 16.8 7.9 17 8.4 17H21C22.1 17 23 16.1 23 15V3C23 1.9 22.1 1 21 1H8.4Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18 6L12 12M12 6L18 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Right chevron arrow for the country selector row.
 * Matches Figma node 0:11041 — 9×14px, fill rgba(60, 60, 67, 0.3).
 */
function ChevronRightIcon(): JSX.Element {
  return (
    <svg
      width="9"
      height="14"
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

/* =============================================================================
 * LoginPage Component
 * =============================================================================
 *
 * Figma: Screen 0 — WhatsApp Authorization (node 0:11030, 375×812)
 *
 * Sections (top → bottom):
 *   1. StatusBar — simulated iOS status bar (hidden on mobile, shown on tablet+)
 *   2. NavigationBar — centered "Phone number" title, right-aligned "Done" button
 *   3. Instructional text — centered guidance copy
 *   4. Form card — country selector + phone number input with custom keyboard
 *   5. Numeric keyboard — 3×4 grid with letter labels, delete key
 *   6. Home indicator — centered black bar at bottom
 *
 * Responsive: mobile (full-width), tablet+desktop (centered 375px column).
 * WCAG 2.1 AA: ARIA labels, keyboard navigation, focus indicators, live regions.
 * ========================================================================== */

export default function LoginPage(): JSX.Element {
  /* ─── Local State ──────────────────────────────────────────────────── */
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [countryCode] = useState<string>('+1');
  const [countryName] = useState<string>('United States');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  /* ─── Store & Router ───────────────────────────────────────────────── */
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const login = useAuthStore((state) => state.login);
  const router = useRouter();

  /* ─── Derived State ────────────────────────────────────────────────── */
  const isPhoneValid = phoneNumber.length >= MIN_PHONE_LENGTH;
  const isDoneEnabled = isPhoneValid && !isSubmitting;

  /* ─── Auth Redirect — unauthenticated-only page ────────────────────── */
  useEffect(() => {
    if (isAuthenticated) {
      router.replace('/chat');
    }
  }, [isAuthenticated, router]);

  /* ─── Keyboard Handlers ────────────────────────────────────────────── */
  const handleKeyPress = useCallback((digit: string) => {
    setPhoneNumber((prev) => {
      if (prev.length >= MAX_PHONE_LENGTH) return prev;
      return prev + digit;
    });
    setError(null);
  }, []);

  const handleDelete = useCallback(() => {
    setPhoneNumber((prev) => prev.slice(0, -1));
    setError(null);
  }, []);

  /* ─── Done/Submit Handler ──────────────────────────────────────────── */
  const handleDone = useCallback(async () => {
    if (!isPhoneValid || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const fullPhone = `${countryCode}${phoneNumber}`;
      const sanitizedDigits = phoneNumber.replace(/\D/g, '');

      /* Backend uses email+password auth (AAP §0.8.2 — "registration uses
         email+password, not phone OTP"). Derive demo credentials from the
         phone number so the Figma phone-entry UI stays accurate while the
         API call succeeds against the real backend. */
      const response = await apiClient.post<AuthRegistrationResponse>(
        '/api/v1/auth/register',
        {
          email: `${sanitizedDigits}@kalle.demo`,
          password: fullPhone,
          displayName: `User ${fullPhone}`,
          phoneNumber: fullPhone,
        },
      );

      /* Store tokens and user data (two-arg signature per authStore).
         Type assertion bridges local AuthRegistrationResponse types with the
         store's TokenPair / UserResponse types from @kalle/shared — both are
         structurally compatible, but the enum nominal type for UserStatus
         requires an explicit cast at the module boundary. */
      login(
        response.tokens as Parameters<typeof login>[0],
        response.user as Parameters<typeof login>[1],
      );

      router.replace('/chat');
    } catch (err: unknown) {
      /* If registration returns 409 Conflict (user already exists),
         fall back to login with the same derived credentials so that
         existing seed users and returning users can authenticate
         through the UI without a dead-end error. */
      if (err instanceof ApiError && err.status === 409) {
        try {
          const fullPhone = `${countryCode}${phoneNumber}`;
          const sanitizedDigits = phoneNumber.replace(/\D/g, '');

          const loginResponse = await apiClient.post<AuthRegistrationResponse>(
            '/api/v1/auth/login',
            {
              email: `${sanitizedDigits}@kalle.demo`,
              password: fullPhone,
            },
          );

          login(
            loginResponse.tokens as Parameters<typeof login>[0],
            loginResponse.user as Parameters<typeof login>[1],
          );

          router.replace('/chat');
          return;
        } catch {
          setError('Invalid credentials. Please try again.');
        }
      } else {
        setError('Failed to register. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [phoneNumber, countryCode, isPhoneValid, isSubmitting, login, router]);

  /* ─── Render ───────────────────────────────────────────────────────── */
  return (
    <main
      className="flex min-h-screen w-full flex-col bg-white tablet:items-center tablet:bg-surface"
    >
      {/* Skip navigation link — WCAG 2.1 AA */}
      <a
        href="#phone-input"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded focus:bg-white focus:px-4 focus:py-2 focus:text-blue-ios focus:shadow-lg"
      >
        Skip to phone input
      </a>

      {/* ── Phone frame container ──────────────────────────────────────
           375px max on tablet+, full-width on mobile, centered.
           Provides the "phone mockup" column on larger screens. ──────── */}
      <div className="relative flex w-full min-h-screen flex-col tablet:max-w-[375px] tablet:shadow-lg">

        {/* ═══════════════════════════════════════════════════════════════
            Section 1: Status Bar (Figma node 0:11106)
            375×44, bg #F7F7F7, time "9:41" + icons.
            Hidden on mobile (StatusBar component default), shown on tablet+.
            ════════════════════════════════════════════════════════════ */}
        <StatusBar />

        {/* ═══════════════════════════════════════════════════════════════
            Section 2: Navigation Bar (Figma node 0:11102)
            375×44, bg #F6F6F6, shadow 0.33px rgba(166,166,170,1).
            Title: "Phone number" — centered, SF Pro Text 600 17px #000.
            Right action: "Done" — disabled (#D1D1D6) / active (#007AFF).
            ════════════════════════════════════════════════════════════ */}
        <NavigationBar
          title="Phone number"
          rightAction="Done"
          onRightAction={isDoneEnabled ? handleDone : undefined}
          rightActionDisabled={!isDoneEnabled}
        />

        {/* ═══════════════════════════════════════════════════════════════
            Section 3: Instructional Text (Figma node 0:11045)
            At y=107 (19px below nav bar end). 300×40, centered.
            SF Pro Text 400 15px, line-height 1.333em, letter-spacing -1.47%.
            ════════════════════════════════════════════════════════════ */}
        <p
          className="mx-auto mt-[19px] w-[300px] text-center font-sans text-[15px] font-normal leading-[1.333em] tracking-[-0.015em] text-black"
        >
          {'Please confirm your country code and enter your phone number '}
        </p>

        {/* ═══════════════════════════════════════════════════════════════
            Section 4: Form Card (Figma node 0:11031)
            At y=166 (19px below text end). 375×90, bg #FFF.
            Shadow: top + bottom 0.33px rgba(60,60,67,0.29).
            ════════════════════════════════════════════════════════════ */}
        <div
          className="mt-[19px] w-full bg-white shadow-[0px_-0.33px_0px_0px_rgba(60,60,67,0.29),0px_0.33px_0px_0px_rgba(60,60,67,0.29)]"
        >
          {/* ─── Country Selector Row (Figma node 0:11039) ────────── */}
          {/* Height 44px. "United States" in #007AFF at 16px left. Chevron right. */}
          <button
            type="button"
            className="flex h-[44px] w-full items-center justify-between bg-white px-4"
            aria-label={`Select country, currently ${countryName}`}
          >
            <span className="font-sans text-[17px] font-normal leading-[1.19em] tracking-[-0.026em] text-blue-ios">
              {countryName}
            </span>
            <ChevronRightIcon />
          </button>

          {/* ─── Separator within form (Figma node 0:11044) ──────── */}
          {/* At x=16, y=43.5 within form. 359×1. Stroke 0.5px rgba(60,60,67,0.29). */}
          <div
            className="ml-4 border-b-[0.5px] border-separator"
            role="separator"
            aria-hidden="true"
          />

          {/* ─── Phone Number Input Row (Figma node 0:11033) ─────── */}
          {/* Height 46px. "+1" | vertical sep | phone number input. */}
          <div className="flex h-[46px] w-full items-center bg-white">
            {/* Country code prefix — Figma node 0:11035 */}
            {/* At (29, 5.5). SF Pro Text 300 27px, color #000. */}
            <span
              className="pl-[29px] font-sans text-[27px] font-light leading-[1.19em] tracking-[-0.024em] text-black"
              aria-hidden="true"
            >
              {countryCode}
            </span>

            {/* Vertical separator — Figma node 0:11038 */}
            {/* At (86.5, 0.5). 1×45. Stroke rgba(60,60,67,0.29) 0.5px. */}
            <div
              className="ml-[28.5px] h-[45px] w-[0.5px] bg-separator"
              role="separator"
              aria-hidden="true"
            />

            {/* Phone number display / pseudo-input — Figma node 0:11036 */}
            {/* At (97, 7). Placeholder: 26px/300 #C7C7CC. Value: 26px/300 #000. */}
            <div
              id="phone-input"
              className="relative ml-[10px] flex flex-1 items-center overflow-hidden"
              role="textbox"
              tabIndex={0}
              aria-label={`Phone number input, ${countryCode} ${phoneNumber || 'empty'}`}
              aria-describedby="phone-error"
              onKeyDown={(e) => {
                /* Allow physical keyboard input as a fallback */
                if (e.key >= '0' && e.key <= '9') {
                  handleKeyPress(e.key);
                } else if (e.key === 'Backspace' || e.key === 'Delete') {
                  handleDelete();
                } else if (e.key === 'Enter' && isDoneEnabled) {
                  handleDone();
                }
              }}
            >
              {phoneNumber ? (
                <span className="font-sans text-[26px] font-light leading-[1.19em] tracking-[-0.031em] text-black">
                  {phoneNumber}
                </span>
              ) : (
                <span className="font-sans text-[26px] font-light leading-[1.19em] tracking-[-0.031em] text-[#C7C7CC]">
                  phone number
                </span>
              )}
              {/* Blinking cursor — Figma node 0:11037 */}
              {/* At (98, 5). 2×34. #007AFF. Border-radius 2px. */}
              <span
                className="ml-px inline-block h-[34px] w-[2px] flex-shrink-0 rounded-sm bg-blue-ios"
                style={{ animation: 'kalle-cursor-blink 1s step-end infinite' }}
                aria-hidden="true"
              />
            </div>
          </div>
        </div>

        {/* ─── Error Message (ARIA live region) ──────────────────────── */}
        <div
          id="phone-error"
          className="px-4 pt-2"
          role="status"
          aria-live="polite"
        >
          {error && (
            <p className="text-center font-sans text-sm text-red-ios">
              {error}
            </p>
          )}
        </div>

        {/* ─── Flexible Spacer — pushes keyboard to bottom ───────────── */}
        <div className="flex-1" aria-hidden="true" />

        {/* ═══════════════════════════════════════════════════════════════
            Section 5: Numeric Keyboard (Figma node 0:11046)
            At y=521. 375×291. Gray keyboard bg with 3×4 key grid.
            Keys: 117×46-47px, bg #FCFCFE, shadow 0 1px, radius 5px.
            Number text: SF Pro Display 400 25px. Labels: 700 10px 20% spacing.
            ════════════════════════════════════════════════════════════ */}
        <div
          className="w-full bg-[#D1D5DB]"
          role="group"
          aria-label="Phone number keypad"
        >
          {/* Keys grid — 6px inset from keyboard bg edges */}
          <div className="px-[6px] pt-[6px]">
            <div className="grid grid-cols-3 gap-x-[6px] gap-y-[7px]">
              {KEYBOARD_ROWS.map((row, rowIndex) =>
                row.map((key, colIndex) => {
                  /* ── Empty spacer (bottom-left) ──────────────────── */
                  if (key === '') {
                    return (
                      <div
                        key={`spacer-${rowIndex}-${colIndex}`}
                        className="h-[46px]"
                        aria-hidden="true"
                      />
                    );
                  }

                  /* ── Delete / backspace key (bottom-right) ──────── */
                  if (key === 'delete') {
                    return (
                      <button
                        key="delete"
                        type="button"
                        className="flex h-[46px] items-center justify-center text-black active:opacity-50"
                        onClick={handleDelete}
                        aria-label="Delete"
                      >
                        <BackspaceIcon />
                      </button>
                    );
                  }

                  /* ── Number key ─────────────────────────────────── */
                  const label = KEY_LABELS[key];
                  /* First row (1-2-3) is 46px; rows 2-4 are 47px per Figma */
                  const keyHeight = rowIndex === 0 ? 'h-[46px]' : 'h-[47px]';

                  return (
                    <button
                      key={key}
                      type="button"
                      className={`flex flex-col items-center justify-center rounded-[5px] bg-[#FCFCFE] ${keyHeight} shadow-[0px_1px_0px_0px_rgba(137,138,141,1)] active:bg-[#BABCBE]`}
                      onClick={() => handleKeyPress(key)}
                      aria-label={`${key}${label ? `, ${label}` : ''}`}
                    >
                      <span className="font-sans text-[25px] font-normal leading-[1.19em] tracking-[0.012em] text-black">
                        {key}
                      </span>
                      {label ? (
                        <span className="mt-[-2px] font-sans text-[10px] font-bold uppercase leading-[1.19em] tracking-[0.2em] text-black">
                          {label}
                        </span>
                      ) : null}
                    </button>
                  );
                }),
              )}
            </div>
          </div>

          {/* Bottom padding below keys — includes home indicator space */}
          {/* Total: 78px (from keys bottom to keyboard bg bottom) */}
          <div className="h-[78px]" aria-hidden="true" />
        </div>

        {/* ═══════════════════════════════════════════════════════════════
            Section 6: Home Indicator (Figma node 0:11127)
            At y=778. 375×34. Centered black bar 134×5 at y-offset 20px.
            Overlays the keyboard bottom padding area.
            ════════════════════════════════════════════════════════════ */}
        <div
          className="absolute bottom-0 left-0 right-0 flex h-[34px] items-center justify-center pt-[20px] pb-[9px]"
          aria-hidden="true"
        >
          <div className="h-[5px] w-[134px] rounded-full bg-black" />
        </div>
      </div>

      {/* Cursor blink keyframe — namespaced to avoid collisions.
         Plain <style> renders a global CSS rule; this is intentional for
         the inline animation reference on the cursor span. */}
      <style dangerouslySetInnerHTML={{ __html: '@keyframes kalle-cursor-blink{0%,100%{opacity:1}50%{opacity:0}}' }} />
    </main>
  );
}
