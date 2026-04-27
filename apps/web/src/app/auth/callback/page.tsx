'use client';

/* =============================================================================
 * OAuth 2.0 / OpenID Connect PKCE Callback Page
 * =============================================================================
 *
 * URL: /auth/callback (folder name is `callback` without parentheses, so it
 *      contributes a literal URL segment).
 *
 * This client-only Next.js 14 App Router page completes the OAuth 2.0 /
 * OpenID Connect Authorization Code + PKCE flow that was initiated by
 * `kalle/apps/web/src/app/(auth)/login/page.tsx`. It exchanges the
 * authorization code returned by Keycloak for an access token, refresh
 * token, and id_token, then persists each artifact according to Rule R7:
 *
 *   - Access token  → JS memory only (Zustand `useAuthStore`)
 *   - Refresh token → server-issued `httpOnly; Secure; SameSite=Strict`
 *                     cookie (forwarded via `POST /api/v1/auth/refresh-cookie`)
 *   - id_token      → decoded once (UI display only) and immediately discarded
 *
 * Authority:
 *   - AAP FR-8 (Kalle Web PKCE flow) — Section 0.1.1
 *   - AAP Section 0.4.1.2  — Direct Modifications Required — Kalle Web
 *   - AAP Section 0.5.1.4  — Group 4 Kalle Integration (CREATE)
 *   - AAP Section 0.5.2.2  — PKCE machinery is intentionally minimal; the
 *                            verifier lives in sessionStorage between the
 *                            redirect and the callback consumption — this is
 *                            NOT a token, so it is exempt from Rule R7.
 *
 * Rule compliance:
 *   - **R7 (Token Storage — CRITICAL)**: The access token is stored ONLY via
 *     `useAuthStore.getState().setAccessToken(...)` (memory). The refresh
 *     token is forwarded to `/api/v1/auth/refresh-cookie` and never stored
 *     client-side. The PKCE verifier and state are read from sessionStorage
 *     for a single round-trip and immediately removed (replay defense).
 *   - **R9 (Dual Validation)**: The id_token decode is UI display only. The
 *     server re-validates every access token via the sidecar's POST /validate
 *     on every protected request — the client decode is never trusted as an
 *     auth proof.
 *   - **R23 (Log Hygiene)**: No token, code, or verifier value is ever
 *     emitted to logs. The single `console.error` in the failure path emits
 *     ONLY the short error code (e.g., 'state_mismatch').
 *   - **R29 (Correlation ID Propagation)**: The refresh-cookie POST includes
 *     an `X-Correlation-ID` header generated identically to the existing
 *     `kalle/apps/web/src/lib/api.ts` helper.
 *
 * Boundary compliance:
 *   - No imports from `@blitzy/auth`, `@blitzy/admin-ui`, `kalle/apps/api/...`,
 *     or `blitzy-odoo/...` (the AAP labels `@blitzy/auth` types as OPTIONAL;
 *     intentionally omitted to keep the web bundle small and preserve
 *     dependency-direction purity).
 *
 * Accessibility (WCAG 2.1 AA):
 *   - Status message uses `role="status"` + `aria-live="polite"`.
 *   - Loading spinner uses `aria-hidden="true"` (purely decorative).
 *   - Single page-level `<h1>` landmark.
 * ========================================================================== */

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthStore } from '@/stores/authStore';
import type { UserResponse } from '@kalle/shared';
import { UserStatus } from '@kalle/shared';

/* =============================================================================
 * Constants
 * =============================================================================
 * The two sessionStorage keys MUST match the keys written by the login page
 * (`kalle/apps/web/src/app/(auth)/login/page.tsx`). That file writes:
 *   - 'kalle:pkce:verifier' (the PKCE code verifier — RFC 7636 §4)
 *   - 'kalle:pkce:state'    (the OAuth state parameter — CSRF defense)
 *
 * Per AAP cascade prompt: "Redirect to /login?error=callback_failed after a
 * brief 2-second setTimeout" — the 2000 ms delay gives users a brief moment
 * to observe the failure message before the automatic redirect.
 * ========================================================================== */
const VERIFIER_KEY = 'kalle:pkce:verifier';
const STATE_KEY = 'kalle:pkce:state';
const ERROR_REDIRECT_DELAY_MS = 2000;

/* =============================================================================
 * Local Type Definitions
 * =============================================================================
 * Defined locally (NOT imported from `@blitzy/auth`) to preserve
 * dependency-direction purity and keep the web bundle minimal.
 * ========================================================================== */

/** Keycloak token-endpoint response (form-encoded POST result, JSON body). */
interface KeycloakTokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in: number;
  refresh_expires_in: number;
  token_type?: string;
  scope?: string;
}

/** id_token JWT payload subset — fields used for UI display only (Rule R9). */
interface IdTokenPayload {
  /** Subject identifier (Keycloak `sub` claim) */
  sub: string;
  /** Email claim (optional in OIDC base spec; required by Kalle Keycloak realm) */
  email?: string;
  /** Email verification flag */
  email_verified?: boolean;
  /** Display name (Keycloak full-name claim) */
  name?: string;
  /** Username (Keycloak preferred_username claim) */
  preferred_username?: string;
  /** Token expiration (epoch seconds) */
  exp?: number;
  /** Token issued-at (epoch seconds) */
  iat?: number;
}

/* =============================================================================
 * Helper Functions
 * ========================================================================== */

/**
 * Generates a UUID v4 correlation ID for the X-Correlation-ID header (R29).
 *
 * Uses the Web Crypto API's `randomUUID()` when available; falls back to a
 * `Math.random()`-based v4 implementation for older browsers or contexts
 * without the Web Crypto API. This pattern mirrors the existing
 * `generateCorrelationId` in `kalle/apps/web/src/lib/api.ts` for R29
 * consistency across the web app.
 */
function generateCorrelationId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  /* BLITZY [COMPATIBILITY]: Fallback UUID v4 for environments without crypto.randomUUID */
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Decodes a base64url-encoded string to UTF-8.
 *
 * Implementation uses native `atob` and `TextDecoder` — no external library.
 * The `TextDecoder('utf-8')` step is critical: it ensures multi-byte UTF-8
 * characters in claims (e.g., non-ASCII display names) are correctly decoded.
 * A naive `atob`-only decode would corrupt them.
 *
 * @param input - The base64url-encoded string (no padding, with `-`/`_` substitutions)
 * @returns The decoded UTF-8 string
 * @throws Throws on invalid base64 input — caller MUST guard with try/catch
 */
function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padding);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Decodes the payload section of a JWT (header.payload.signature).
 * Returns null on any parse error.
 *
 * Note: This decodes the payload WITHOUT signature verification. Signature
 * verification is the SERVER's responsibility per Rule R9 (the sidecar's
 * `POST /validate` is the authoritative validator). This client decode is
 * for UI display only — the user identity claims here are untrusted by the
 * server and only used to populate the user slice for immediate UI
 * rendering. The server re-validates on every protected request.
 */
function decodeIdToken(idToken: string): IdTokenPayload | null {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const payloadJson = base64UrlDecode(parts[1]);
    return JSON.parse(payloadJson) as IdTokenPayload;
  } catch {
    return null;
  }
}

/* =============================================================================
 * AuthCallbackContent — Inner component containing the PKCE exchange logic
 * =============================================================================
 *
 * Renders a Tailwind-styled "Completing sign-in…" status UI while the
 * PKCE token-exchange completes asynchronously. On success, navigates to
 * `/chat`. On failure, displays a brief error message and navigates to
 * `/login?error=<code>` after a 2-second delay.
 *
 * This component is wrapped in a `<Suspense>` boundary by the default-export
 * `AuthCallbackPage` because Next.js 14 requires any client component using
 * `useSearchParams()` to be enclosed in a Suspense boundary so the page can
 * still produce a static loading shell at build time
 * (https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout).
 *
 * Critical correctness invariants:
 *   1. **Single-execution gate**: A `useRef`-backed flag prevents the
 *      React 18 StrictMode dev double-invocation of `useEffect` from
 *      causing the second invocation to observe sessionStorage already
 *      cleared by the first invocation and incorrectly route to /login.
 *   2. **Atomic sessionStorage clear before validation**: The verifier and
 *      state are removed BEFORE state validation — this defends against
 *      replay attacks even if the legitimate flow is interrupted.
 *   3. **Cancellation checks**: After every async checkpoint, `cancelled`
 *      is checked before mutating component state or navigating, to avoid
 *      "set state on unmounted component" warnings.
 *   4. **`router.replace` not `push`**: Removes the callback URL from
 *      browser history so back-button navigation does not re-attempt the
 *      now-consumed authorization-code exchange.
 * ========================================================================== */
function AuthCallbackContent(): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [statusMessage, setStatusMessage] = useState<string>(
    'Completing sign-in…',
  );
  const [hasFailed, setHasFailed] = useState<boolean>(false);

  /**
   * Single-execution gate. React 18 StrictMode (Next.js dev default per
   * `next.config.js: reactStrictMode: true`) double-invokes effects to
   * verify cleanup correctness. Without this gate, the second invocation
   * would observe sessionStorage already cleared by the first invocation
   * and incorrectly redirect to `/login?error=missing_verifier`.
   *
   * `useRef.current` persists across StrictMode's mount/unmount/remount
   * sequence per React 18 documentation, so this gate ensures the
   * exchange logic runs exactly once per page mount.
   */
  const hasInitiatedRef = useRef<boolean>(false);

  useEffect(() => {
    if (hasInitiatedRef.current) return;
    hasInitiatedRef.current = true;

    let cancelled = false;

    /**
     * Records a failure, clears in-memory auth state, and schedules a
     * redirect to the login page after a brief delay. The order is
     * deliberate: state mutation BEFORE the timeout so the user observes
     * the failure message during the 2-second pause.
     *
     * R7: clear in-memory auth state (does NOT touch the httpOnly cookie,
     * which only exists post-success; on failure no cookie is set).
     * R23: error code only — never log token, code, or verifier values.
     */
    const failAndRedirect = (errorCode: string): void => {
      if (cancelled) return;
      useAuthStore.getState().clear();
      setHasFailed(true);
      setStatusMessage('Sign-in failed. Redirecting to login…');
      // eslint-disable-next-line no-console
      console.error(`[auth/callback] Sign-in failed: ${errorCode}`);
      window.setTimeout(() => {
        if (cancelled) return;
        router.replace(`/login?error=${encodeURIComponent(errorCode)}`);
      }, ERROR_REDIRECT_DELAY_MS);
    };

    const run = async (): Promise<void> => {
      /* ── Step 1: Read URL search params ──────────────────────────────── */
      const code = searchParams.get('code');
      const state = searchParams.get('state');
      const oauthError = searchParams.get('error');

      /* ── Step 2: Handle OAuth-level error returned by Keycloak ────────
       * If Keycloak rejected the authorization request (e.g., the user
       * declined consent, the realm is misconfigured, or the IdP
       * federation failed), it redirects with `?error=<code>` per
       * RFC 6749 §4.1.2.1. We bail out immediately. */
      if (oauthError) {
        failAndRedirect(`oauth_${oauthError}`);
        return;
      }

      /* ── Step 3: Validate required params ─────────────────────────────
       * A legitimate Keycloak success redirect always includes both
       * `code` and `state`. If either is missing the user likely arrived
       * here via direct navigation (bookmark, manual URL) or the redirect
       * was tampered with. */
      if (!code || !state) {
        failAndRedirect('missing_params');
        return;
      }

      /* ── Step 4: Retrieve PKCE artifacts from sessionStorage ──────────
       * Keys MUST match the values written by the login page:
       *   - 'kalle:pkce:verifier' — RFC 7636 §4 code verifier
       *   - 'kalle:pkce:state'    — RFC 6749 §10.12 CSRF token */
      const expectedState = sessionStorage.getItem(STATE_KEY);
      const verifier = sessionStorage.getItem(VERIFIER_KEY);

      /* ── Step 5: Atomically clear sessionStorage (replay defense) ─────
       * Removing the verifier and state BEFORE validation guarantees
       * that even if the legitimate flow is interrupted at any later
       * step, a replay of the same callback URL cannot succeed. */
      sessionStorage.removeItem(STATE_KEY);
      sessionStorage.removeItem(VERIFIER_KEY);

      /* ── Step 6: CSRF state parity check ─────────────────────────────
       * RFC 6749 §10.12: the value of `state` returned by the
       * authorization server MUST equal the value the client supplied
       * in the original authorization request. */
      if (!expectedState || expectedState !== state) {
        failAndRedirect('state_mismatch');
        return;
      }

      /* ── Step 7: Verifier presence check ──────────────────────────── */
      if (!verifier) {
        failAndRedirect('missing_verifier');
        return;
      }

      /* ── Step 8: Resolve runtime configuration ────────────────────────
       * Defaults match the values documented in `kalle/.env.example`
       * for the local-development bootstrap and ensure the page works
       * out-of-the-box when only the Keycloak base URL is configured. */
      const keycloakBaseUrl = process.env.NEXT_PUBLIC_KEYCLOAK_BASE_URL;
      const realm = process.env.NEXT_PUBLIC_KEYCLOAK_REALM ?? 'blitzy';
      const clientId =
        process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID ?? 'kalle-app';
      const apiBaseUrl =
        process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

      if (!keycloakBaseUrl) {
        failAndRedirect('missing_config');
        return;
      }

      const redirectUri = `${window.location.origin}/auth/callback`;

      try {
        /* ── Step 9: Exchange authorization code for tokens ─────────────
         * FR-8: form-encoded POST to Keycloak's token endpoint. NO
         * `client_secret` — `kalle-app` is a public PKCE client per
         * `packages/auth/keycloak/realm-export.json`. The `code_verifier`
         * binds this exchange to the original authorization request
         * (RFC 7636 §4.5) — without it, an attacker who intercepts the
         * code cannot exchange it. */
        const tokenEndpoint = `${keycloakBaseUrl}/realms/${realm}/protocol/openid-connect/token`;
        const tokenResponse = await fetch(tokenEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: verifier,
          }).toString(),
        });

        if (!tokenResponse.ok) {
          failAndRedirect('token_exchange_failed');
          return;
        }

        const tokenData = (await tokenResponse.json()) as Partial<KeycloakTokenResponse>;

        /* ── Step 10: Validate response shape ───────────────────────────
         * Defensive type-narrowing: a malformed Keycloak response could
         * return `null`, missing fields, or empty strings. We only
         * proceed if we received non-empty access and refresh tokens. */
        if (
          typeof tokenData.access_token !== 'string' ||
          tokenData.access_token.length === 0 ||
          typeof tokenData.refresh_token !== 'string' ||
          tokenData.refresh_token.length === 0
        ) {
          failAndRedirect('invalid_token_response');
          return;
        }

        if (cancelled) return;

        /* ── Step 11: Persist access token in memory (Rule R7) ─────────
         * The Zustand store's `setAccessToken` action writes the token
         * into the in-memory state slice; the store's `partialize`
         * config explicitly excludes both tokens from sessionStorage
         * persistence. */
        useAuthStore.getState().setAccessToken(tokenData.access_token);

        /* ── Step 12: Decode id_token for UI display (Rule R9) ──────────
         * UI display only. The server re-validates every access token
         * via the sidecar's `POST /validate` on every protected request
         * — the client decode is never trusted as auth proof. The
         * decoded claims are used purely to populate the user slice
         * synchronously so /chat can render without a flash of
         * "loading…". The canonical user record will be fetched on the
         * next protected request. */
        if (typeof tokenData.id_token === 'string') {
          const decoded = decodeIdToken(tokenData.id_token);
          if (decoded) {
            const nowIso = new Date().toISOString();
            const userResponse: UserResponse = {
              id: decoded.sub,
              email: decoded.email ?? '',
              displayName:
                decoded.name ??
                decoded.preferred_username ??
                decoded.email ??
                '',
              status: UserStatus.ONLINE,
              createdAt: nowIso,
              updatedAt: nowIso,
            };
            useAuthStore.getState().setUser(userResponse);
          }
        }

        /* ── Step 13: Forward refresh token to API for cookie storage ──
         * FR-8 + R7: the API server writes the refresh token as an
         * `httpOnly; Secure; SameSite=Strict` cookie on its origin.
         *
         *   - `credentials: 'include'` — required so the browser stores
         *     the response Set-Cookie header on the API origin.
         *   - `X-Correlation-ID` — Rule R29 propagation.
         *   - NO `Authorization: Bearer` — the endpoint authenticates by
         *     trusting the body's refresh-token JWT shape; adding the
         *     bearer header would conflict with the body-based scheme.
         *
         * Note: the Keycloak token-endpoint POST above intentionally
         * does NOT include the X-Correlation-ID header — Keycloak is an
         * external third party that doesn't follow Kalle's correlation
         * conventions. The sidecar validates the refresh-token shape
         * server-side. */
        const cookieResponse = await fetch(
          `${apiBaseUrl}/api/v1/auth/refresh-cookie`,
          {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'X-Correlation-ID': generateCorrelationId(),
            },
            body: JSON.stringify({ refreshToken: tokenData.refresh_token }),
          },
        );

        if (!cookieResponse.ok) {
          failAndRedirect('refresh_cookie_failed');
          return;
        }

        if (cancelled) return;

        /* ── Step 14: Success — navigate to main app ────────────────────
         * `router.replace('/chat')` rather than `router.push('/chat')`:
         * `replace` removes /auth/callback from browser history so the
         * back button does not re-attempt the now-consumed code+verifier
         * exchange. */
        router.replace('/chat');
      } catch {
        /* Network error, JSON parse error, or any unexpected exception.
         * R23: do NOT include the caught error value in any log because
         * it might contain token-bearing URLs or response bodies. */
        failAndRedirect('callback_failed');
      }
    };

    void run();

    return (): void => {
      cancelled = true;
    };
  }, [router, searchParams]);

  /* ─── Render ─────────────────────────────────────────────────────────
   * Tailwind classes mirror the styling tokens from
   * `kalle/apps/web/src/app/(auth)/login/page.tsx`:
   *   - flex min-h-screen w-full items-center justify-center bg-white
   *     px-4 — full-viewport centered layout
   *   - w-full max-w-md text-center — same max-width as login form
   *   - text-2xl font-semibold text-gray-900 — same heading typography
   *   - text-sm text-gray-600 (success) and text-red-500 (failure) —
   *     matches login error text
   *   - #25D366 (WhatsApp green) — same accent color
   *
   * Accessibility:
   *   - `role="status"` + `aria-live="polite"` for screen-reader
   *     announcement of progress.
   *   - `aria-hidden="true"` on the decorative spinner.
   *   - Single page-level `<h1>` landmark.
   * ────────────────────────────────────────────────────────────────── */
  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-white px-4">
      <div className="w-full max-w-md text-center">
        <h1 className="mb-4 text-2xl font-semibold text-gray-900">
          {hasFailed ? 'Sign-in Failed' : 'Completing sign-in…'}
        </h1>

        <div role="status" aria-live="polite" className="min-h-[1.5rem]">
          <p
            className={`text-sm ${hasFailed ? 'text-red-500' : 'text-gray-600'}`}
          >
            {statusMessage}
          </p>
        </div>

        {!hasFailed && (
          <div className="mt-6 flex justify-center">
            <div
              className="h-8 w-8 animate-spin rounded-full border-2 border-[#25D366] border-t-transparent"
              aria-hidden="true"
            />
          </div>
        )}
      </div>
    </main>
  );
}

/* =============================================================================
 * AuthCallbackFallback — Suspense fallback shell
 * =============================================================================
 *
 * Rendered by the Suspense boundary while `AuthCallbackContent` is
 * suspended (e.g., during the initial client-side hydration when
 * `useSearchParams()` triggers a CSR bailout). Visually identical to the
 * "Completing sign-in…" success state in the inner component so the
 * transition between fallback and content is seamless. Pure presentational —
 * no hooks, no effects, no router/search-params access.
 *
 * Tailwind tokens are kept in lock-step with the inner component's render so
 * no visual flash occurs when Suspense unwraps.
 * ========================================================================== */
function AuthCallbackFallback(): JSX.Element {
  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-white px-4">
      <div className="w-full max-w-md text-center">
        <h1 className="mb-4 text-2xl font-semibold text-gray-900">
          Completing sign-in…
        </h1>

        <div role="status" aria-live="polite" className="min-h-[1.5rem]">
          <p className="text-sm text-gray-600">Loading…</p>
        </div>

        <div className="mt-6 flex justify-center">
          <div
            className="h-8 w-8 animate-spin rounded-full border-2 border-[#25D366] border-t-transparent"
            aria-hidden="true"
          />
        </div>
      </div>
    </main>
  );
}

/* =============================================================================
 * AuthCallbackPage — Default export
 * =============================================================================
 *
 * Next.js 14 App Router page entry point at the URL path `/auth/callback`.
 *
 * Wraps the inner `AuthCallbackContent` component in a `<Suspense>` boundary
 * because `AuthCallbackContent` calls `useSearchParams()` from
 * `next/navigation`. Per Next.js 14 prerender semantics, any client component
 * that reads search params MUST be enclosed in a Suspense boundary so the
 * page can produce a static loading shell at build time. Without this, the
 * production build emits the error
 * "useSearchParams() should be wrapped in a suspense boundary at page
 * '/auth/callback'" and the page export fails (CSR bailout).
 *
 * The `<Suspense>` fallback is `<AuthCallbackFallback />`, a pure
 * presentational component visually identical to the inner component's
 * "Completing sign-in…" state so the user sees a smooth, seamless
 * transition — the fallback is shown for at most a single render tick
 * during initial hydration, after which `AuthCallbackContent` takes over
 * and begins the PKCE token-exchange logic.
 *
 * Why a separate inner component rather than putting the logic inline?
 *   - `useSearchParams()` MUST be inside the Suspense boundary, but
 *     `<Suspense>` itself MUST be outside it. The cleanest way to satisfy
 *     both constraints is the inner-component pattern: the outer
 *     component renders Suspense; the inner component reads search params.
 *   - Keeps the default export shallow and free of business logic,
 *     simplifying tree-shaking and improving readability.
 *
 * Reference:
 *   https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout
 * ========================================================================== */
export default function AuthCallbackPage(): JSX.Element {
  return (
    <Suspense fallback={<AuthCallbackFallback />}>
      <AuthCallbackContent />
    </Suspense>
  );
}

