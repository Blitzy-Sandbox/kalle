'use client';

/* =============================================================================
 * Login Page — PKCE Redirect Landing (V2 OAuth 2.0 / OIDC via Keycloak)
 * =============================================================================
 *
 * URL: /login (within (auth) route group — parentheses excluded from URL)
 *
 * REPLACES the previous email + password form with a redirect-only landing
 * page that initiates the OAuth 2.0 Authorization Code + PKCE flow against
 * Keycloak's `authorization_endpoint`. After the user authenticates with
 * Keycloak (and any federated identity provider, e.g. Google), the browser
 * is redirected to `/auth/callback` with `code` and `state` parameters; the
 * callback page exchanges the authorization code for tokens via the
 * Keycloak `token_endpoint` and persists them per Rule R7.
 *
 * Authority:
 * - AAP FR-8  — Kalle Web PKCE flow (Section 0.1.1)
 * - AAP FR-11 — Single Sign-On audience chain (scope `odoo:basic` ensures
 *               the issued token's `aud` claim is augmented with `odoo-app`
 *               by the Keycloak Audience Mapper, enabling cross-app SSO).
 * - AAP Section 0.4.1.2 — Direct Modifications Required — Kalle Web (login replace)
 *
 * Security & rule compliance:
 * - **Rule R7 — Token storage discipline:** This page does NOT touch access or
 *   refresh tokens. The only artifacts written here are the PKCE code verifier
 *   and the OAuth state parameter — single-use authorization-flow inputs that
 *   are NOT credentials and CANNOT impersonate the user without the
 *   corresponding authorization code. Per RFC 7636, the verifier MUST persist
 *   across the redirect; `sessionStorage` is the standard storage location:
 *   it is cleared when the tab closes, the values are short-lived (consumed
 *   within seconds at the callback), and they are bound to a single
 *   authorization code exchange. R7 explicitly governs token storage; PKCE
 *   verifier/state are exempt as they are not tokens.
 * - **Rule R12 — API stability:** The route URL `/login` is preserved
 *   (the `(auth)` route group contributes no URL segment). The component
 *   continues to be a default export named `LoginPage`. The
 *   already-authenticated guard (`isAuthenticated` → redirect to `/chat`)
 *   is preserved verbatim so deep-linked authenticated users still land on
 *   the chat page without a Keycloak round-trip.
 * - **Rule R23 — Log hygiene:** No `console.log/warn/error` call in this
 *   module includes the verifier, state, challenge, or any token-like value.
 *   Error logs reference only the failure condition (and the missing env-var
 *   *name*, never its value).
 *
 * Accessibility (WCAG 2.1 AA):
 * - Loading state uses `aria-busy="true"`, `aria-live="polite"`, and an
 *   `aria-label` on the `<main>` landmark plus an `sr-only` span for screen
 *   reader announcement.
 * - Error state uses `role="alert"` with `aria-live="assertive"` so failures
 *   are announced immediately to assistive technology users.
 * - The animated spinner has `role="status"` and an `aria-label` describing
 *   the in-progress operation.
 *
 * Visual design tokens (from `kalle/apps/web/tailwind.config.ts`):
 * - `bg-surface`            → `#EFEFF4` (matches root `/` redirect page)
 * - `border-secondary`      → `#6D6D72`
 * - `border-t-blue-ios`     → `#0064D2`
 * Standard Tailwind grays (`text-gray-900`, `text-gray-600`) are used for
 * text — these are part of Tailwind's default palette and require no token
 * configuration.
 * ========================================================================== */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/authStore';

/* =============================================================================
 * SessionStorage Keys (PKCE artifacts)
 * =============================================================================
 * These keys are CONSUMED by `/auth/callback` (created by a parallel agent at
 * `kalle/apps/web/src/app/auth/callback/page.tsx`). Both agents MUST agree on
 * these key names — that is the integration contract between the two pages.
 *
 * R7-EXEMPT: PKCE verifier/state are single-use authorization artifacts, NOT
 * tokens. RFC 7636 §4 mandates that the verifier persist across the redirect
 * to enable code-to-token exchange at the callback. `sessionStorage` is the
 * standard, OWASP-recommended storage for these short-lived flow values.
 * ========================================================================== */
const PKCE_VERIFIER_KEY = 'kalle:pkce:verifier';
const PKCE_STATE_KEY = 'kalle:pkce:state';

/* =============================================================================
 * PKCE Helper Functions
 * =============================================================================
 * Implementation of the PKCE machinery per RFC 7636 (S256 code challenge
 * method). All helpers are pure (no side effects until the component invokes
 * them inside the `useEffect` redirect orchestration).
 * ========================================================================== */

/**
 * RFC 4648 §5 base64url encoding (URL-safe alphabet, no padding).
 *
 * Converts the input byte buffer to standard base64 via `btoa`, then maps
 * `+` → `-`, `/` → `_`, and strips trailing `=` padding. For 32 random
 * bytes the output is exactly 43 characters — the canonical PKCE verifier
 * length per RFC 7636 §4.1 (43 ≤ length ≤ 128).
 *
 * @param buffer - The bytes to encode (`ArrayBuffer` from `crypto.subtle`
 *                 or `Uint8Array` from `crypto.getRandomValues`).
 * @returns Base64url-encoded string with no trailing `=` padding.
 */
function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generates a cryptographically random PKCE code verifier per RFC 7636 §4.1.
 *
 * Uses 32 random bytes from `crypto.getRandomValues`, base64url-encoded to
 * yield a 43-character verifier. The verifier is the high-entropy secret
 * proving the original PKCE-initiating client is the same client redeeming
 * the authorization code.
 *
 * @returns A 43-character base64url-encoded verifier.
 */
function generateCodeVerifier(): string {
  const buffer = new Uint8Array(32);
  crypto.getRandomValues(buffer);
  return base64UrlEncode(buffer);
}

/**
 * Generates a cryptographically random OAuth `state` parameter for CSRF
 * defense per RFC 6749 §10.12. Uses 16 random bytes (≈22 base64url chars),
 * sufficient for the threat model (single-use, validated at callback).
 *
 * @returns A base64url-encoded state nonce.
 */
function generateState(): string {
  const buffer = new Uint8Array(16);
  crypto.getRandomValues(buffer);
  return base64UrlEncode(buffer);
}

/**
 * Computes the S256 PKCE code challenge per RFC 7636 §4.2:
 *   challenge = BASE64URL(SHA-256(ASCII(verifier)))
 *
 * The challenge is sent in the authorization request; the verifier is
 * exchanged at the token endpoint. The authorization server recomputes
 * SHA-256 of the verifier and compares to the stored challenge.
 *
 * @param verifier - The PKCE code verifier produced by `generateCodeVerifier`.
 * @returns A Promise resolving to the base64url-encoded SHA-256 challenge.
 */
async function computeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(digest);
}

/**
 * Builds the Keycloak authorization endpoint URL with all required PKCE
 * and OIDC query parameters.
 *
 * Scope `kalle:basic odoo:basic` triggers Keycloak's Audience Mapper
 * (configured on the `odoo:basic` client scope per AAP FR-11) to add
 * `odoo-app` to the issued token's `aud` claim, enabling cross-app SSO
 * without requiring Odoo to initiate its own OAuth flow.
 *
 * `URLSearchParams` performs all URL encoding, so callers MUST NOT
 * pre-encode any value.
 *
 * @param opts - Authorization request inputs.
 * @returns The fully-qualified authorization URL ready for `window.location`.
 */
function buildAuthUrl(opts: {
  keycloakBaseUrl: string;
  realm: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: 'openid email profile kalle:basic odoo:basic',
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    state: opts.state,
  });
  return `${opts.keycloakBaseUrl}/realms/${opts.realm}/protocol/openid-connect/auth?${params.toString()}`;
}

/* =============================================================================
 * LoginPage Component
 * =============================================================================
 *
 * Initiates the PKCE redirect to Keycloak on mount. Renders one of two
 * mutually exclusive states:
 *   1. Loading — minimal spinner while the redirect is in flight (default).
 *   2. Error  — accessible alert message when configuration is missing or
 *               the Web Crypto API is unavailable.
 *
 * The component intentionally renders no form, no inputs, and no submit
 * button: it is a pure auth-bootstrap landing page.
 * ========================================================================== */
export default function LoginPage(): JSX.Element {
  /* ─── Local State ──────────────────────────────────────────────────── */
  const [error, setError] = useState<string | null>(null);

  /* ─── Store & Router ───────────────────────────────────────────────── */
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isInitialized = useAuthStore((state) => state.isInitialized);
  const router = useRouter();

  /* ─── PKCE Redirect Orchestration ──────────────────────────────────── */
  useEffect(() => {
    /* SSR guard — no-op on the server; all PKCE machinery requires
       browser-only globals (`crypto.subtle`, `sessionStorage`, `window`). */
    if (typeof window === 'undefined') {
      return;
    }

    /* Hydration guard — wait for the auth store to finish rehydrating from
       sessionStorage. Without this, `isAuthenticated` is the default `false`
       on first render and we would always initiate the PKCE redirect even
       for users with a valid persisted session. Mirrors the pattern used by
       `kalle/apps/web/src/app/page.tsx`. */
    if (!isInitialized) {
      return;
    }

    /* Already-authenticated guard — deep-linked users with an active session
       skip the Keycloak round-trip entirely (Rule R12 — preserves the
       behavior of the legacy login page). */
    if (isAuthenticated) {
      router.replace('/chat');
      return;
    }

    /* Web Crypto guard — `crypto.subtle` is only available in secure
       contexts (HTTPS or localhost). Inform the user accessibly rather
       than throwing an opaque error. */
    if (!window.crypto?.subtle) {
      setError(
        'Your browser does not support secure authentication. Please use a modern browser over HTTPS.',
      );
      return;
    }

    /* Env guard — the Keycloak base URL is the only required env var; realm
       and client ID have safe defaults matching the AAP-specified values
       (`blitzy` realm, `kalle-app` client). When the base URL is missing,
       the deployment is misconfigured and we MUST NOT redirect. Per Rule
       R23 we log only the variable *name*, never any value. */
    const keycloakBaseUrl = process.env.NEXT_PUBLIC_KEYCLOAK_BASE_URL;
    if (!keycloakBaseUrl) {
      // eslint-disable-next-line no-console -- R23-compliant: logs env-var name, no values
      console.error('[login] NEXT_PUBLIC_KEYCLOAK_BASE_URL is not set');
      setError(
        'Authentication is not configured. Please contact your administrator.',
      );
      return;
    }
    const realm = process.env.NEXT_PUBLIC_KEYCLOAK_REALM ?? 'blitzy';
    const clientId =
      process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID ?? 'kalle-app';

    /* Async PKCE redirect — generate verifier+state, compute challenge,
       persist verifier+state to sessionStorage (consumed at /auth/callback),
       construct the authorization URL, and navigate. Wrapped in try/catch
       so any unexpected failure (e.g. quota-exceeded sessionStorage on
       hardened browsers) surfaces as an accessible error rather than an
       unhandled rejection. */
    const runPkceRedirect = async (): Promise<void> => {
      try {
        const verifier = generateCodeVerifier();
        const state = generateState();
        const challenge = await computeChallenge(verifier);

        sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
        sessionStorage.setItem(PKCE_STATE_KEY, state);

        const redirectUri = `${window.location.origin}/auth/callback`;
        const authUrl = buildAuthUrl({
          keycloakBaseUrl,
          realm,
          clientId,
          redirectUri,
          challenge,
          state,
        });

        window.location.href = authUrl;
      } catch (err) {
        /* R23-compliant: log only the error object (which by default contains
           only its message and stack — no token values flow through this
           catch). Never log `verifier`, `state`, or `challenge`. */
        // eslint-disable-next-line no-console -- R23-compliant: logs error object only, no PKCE artifacts
        console.error('[login] failed to initiate PKCE redirect', err);
        setError('Failed to initiate sign-in. Please try again.');
      }
    };

    void runPkceRedirect();
  }, [isAuthenticated, isInitialized, router]);

  /* ─── Render: Error State ──────────────────────────────────────────── */
  if (error) {
    return (
      <main
        className="flex min-h-screen items-center justify-center bg-surface px-4"
        role="alert"
        aria-live="assertive"
      >
        <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          <h1 className="text-xl font-semibold text-gray-900">
            Sign-in unavailable
          </h1>
          <p className="text-sm text-gray-600">{error}</p>
        </div>
      </main>
    );
  }

  /* ─── Render: Loading State (default — redirect in progress) ───────── */
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-surface px-4"
      aria-busy="true"
      aria-live="polite"
      aria-label="Redirecting to sign-in"
    >
      <div className="flex flex-col items-center gap-3">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-secondary border-t-blue-ios"
          role="status"
          aria-label="Redirecting to authentication provider"
        />
        <p className="text-sm text-gray-600">Redirecting to sign-in…</p>
        <span className="sr-only">Redirecting to the authentication provider</span>
      </div>
    </main>
  );
}
