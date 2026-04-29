'use client';

/* =============================================================================
 * Login Page — Runtime-Flag-Aware Auth Mode Selection (V2 PKCE OR Legacy Form)
 * =============================================================================
 *
 * URL: /login (within (auth) route group — parentheses excluded from URL)
 *
 * **F-CRITICAL-3 (QA Checkpoint F2 final report):** Prior to this revision,
 * this page was hardcoded to a PKCE-redirect-only behavior with zero
 * references to any flag. The QA report identified this as a CRITICAL
 * defect because it broke the runtime kill-switch from a UX perspective:
 * with `AUTH_V2_ENABLED=false` in flags-db, the API correctly accepted
 * legacy email/password POSTs (verified HTTP 200 in Test 1) but the UI sent
 * users to Keycloak — a half-broken state from the user's perspective. The
 * legacy and V2 paths were mutually exclusive on the API side (Rule R4) but
 * the UI was V2-only, violating the spirit of R4 from the user perspective.
 *
 * **This revision resolves the defect** by fetching the runtime
 * `AUTH_V2_ENABLED` flag from `GET /api/v1/auth/feature-flags` on mount and
 * rendering one of three states based on the response:
 *   1. **Loading** (default while fetching the flag) — minimal spinner
 *      with `aria-busy="true"`, identical to the previous PKCE-redirect
 *      loading state for visual continuity.
 *   2. **V2 ENABLED** — initiate the OAuth 2.0 Authorization Code + PKCE
 *      flow against Keycloak's `authorization_endpoint`. After the user
 *      authenticates with Keycloak (and any federated identity provider,
 *      e.g. Google), the browser is redirected to `/auth/callback` with
 *      `code` and `state` parameters; the callback page exchanges the
 *      authorization code for tokens and persists them per Rule R7.
 *   3. **V2 DISABLED** — render the legacy email + password form that
 *      POSTs to `POST /api/v1/auth/login` (the existing legacy endpoint,
 *      preserved verbatim per Rule R12 API stability). On success, the
 *      response is `{ data: { user, tokens } }`; the user/tokens are
 *      persisted to the Zustand authStore (via `login(tokens, user)`)
 *      and the user is redirected to `/chat`.
 *
 * Authority:
 * - AAP FR-8  — Kalle Web PKCE flow (Section 0.1.1)
 * - AAP FR-9  — Kalle API middleware swap (Section 0.1.1)
 * - AAP FR-11 — Single Sign-On audience chain (scope `odoo:basic` ensures
 *               the issued token's `aud` claim is augmented with `odoo-app`
 *               by the Keycloak Audience Mapper, enabling cross-app SSO).
 * - AAP Section 0.4.1.2 — Direct Modifications Required — Kalle Web (login
 *               replace + callback create + 401 interceptor + token
 *               persistence)
 * - QA Checkpoint F2 final report — F-CRITICAL-3 resolution
 *
 * Security & rule compliance:
 * - **Rule R3 — Flag isolation:** With `AUTH_V2_ENABLED=false`, ZERO V2/PKCE
 *   code executes. The PKCE verifier/state generation is gated entirely by
 *   the `authV2Enabled === true` branch. The legacy form branch performs
 *   no PKCE work, no Keycloak interaction, and no `@blitzy/auth` dynamic
 *   import.
 * - **Rule R4 — Mutual exclusion:** The page renders EXACTLY one of the
 *   three states (loading | PKCE | legacy form). Branching is structural:
 *   no `useEffect` body crosses modes mid-flight. Once the flag is known,
 *   the page commits to one mode for the duration of the user's session
 *   on this page.
 * - **Rule R7 — Token storage discipline:** The PKCE branch does NOT touch
 *   access or refresh tokens (only the verifier and state, which are
 *   single-use auth-flow artifacts NOT credentials — RFC 7636 §4 mandates
 *   the verifier persists across the redirect; sessionStorage is the
 *   standard storage location). The legacy form branch persists tokens
 *   ONLY through `useAuthStore.login(tokens, user)`, which routes them to
 *   memory-only state per the partialize discipline established in
 *   `kalle/apps/web/src/stores/authStore.ts:473-476`.
 * - **Rule R12 — API stability:** The route URL `/login` is preserved (the
 *   `(auth)` route group contributes no URL segment). The component
 *   continues to be a default export named `LoginPage`. The
 *   already-authenticated guard (`isAuthenticated` → redirect to `/chat`)
 *   is preserved verbatim so deep-linked authenticated users still land
 *   on the chat page without a Keycloak round-trip OR a form fill. The
 *   legacy endpoint contract (POST `/api/v1/auth/login`) is unchanged —
 *   this page consumes the existing `{ data: { user, tokens } }` shape.
 * - **Rule R23 — Log hygiene:** No `console.log/warn/error` call in this
 *   module includes the verifier, state, challenge, password, email, or
 *   any token-like value. Error logs reference only the failure condition
 *   (and the missing env-var *name*, never its value).
 * - **Rule R29 — Correlation ID:** The flag-discovery fetch and the legacy
 *   login fetch are both routed through the existing `apiClient.get/post`
 *   helpers, which automatically attach `X-Correlation-ID` per
 *   `kalle/apps/web/src/lib/api.ts`. No additional propagation code is
 *   needed in this page.
 * - **Rule RF3 — Flag fail-open (server-side):** The
 *   `GET /api/v1/auth/feature-flags` endpoint never throws — it falls
 *   back through cache → API → env-var → `false` internally. If the API
 *   itself is unreachable (network error, server down), the catch block
 *   below treats the error as "V2 disabled" and renders the legacy form.
 *   This is the safest fallback because: (a) the legacy form is the
 *   pre-V2 default behavior, (b) it does not require Keycloak to be
 *   reachable, and (c) it preserves byte-identical behavior with the
 *   pre-V2 1,814-test kalle suite.
 *
 * Accessibility (WCAG 2.1 AA):
 * - Loading state uses `aria-busy="true"`, `aria-live="polite"`, and an
 *   `aria-label` on the `<main>` landmark plus an `sr-only` span for
 *   screen-reader announcement.
 * - Error state uses `role="alert"` with `aria-live="assertive"` so
 *   failures are announced immediately to assistive-technology users.
 * - The animated spinner has `role="status"` and an `aria-label` describing
 *   the in-progress operation.
 * - The legacy form uses semantic HTML (`<form>`, `<label>`, `<input>`,
 *   `<button>`) with proper `htmlFor`/`id` association, `autoComplete`
 *   hints, and visible focus indicators inherited from Tailwind defaults.
 *
 * Visual design tokens (from `kalle/apps/web/tailwind.config.ts`):
 * - `bg-surface`            → `#EFEFF4` (matches root `/` redirect page)
 * - `border-secondary`      → `#6D6D72`
 * - `border-t-blue-ios`     → `#0064D2`
 * - `bg-blue-ios`           → `#0064D2`
 * Standard Tailwind grays (`text-gray-900`, `text-gray-600`) are used for
 * text — these are part of Tailwind's default palette and require no token
 * configuration.
 * ========================================================================== */

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient, ApiError } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import type { TokenPair, UserResponse } from '@kalle/shared';

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
 * Type Definitions
 * =============================================================================
 * Local types for the page's mode discriminant and API response shapes. The
 * `AuthMode` discriminated union models the three mutually exclusive states
 * (Rule R4 enforcement at the type level — TypeScript will reject any code
 * that attempts to render in two modes simultaneously).
 * ========================================================================== */

/**
 * Discriminated union representing the three mutually exclusive states of
 * this page. The mode is determined by the runtime AUTH_V2_ENABLED flag
 * fetched from `GET /api/v1/auth/feature-flags` on mount.
 */
type AuthMode = 'loading' | 'pkce' | 'legacy';

/**
 * Response shape for `GET /api/v1/auth/feature-flags` (F-CRITICAL-3).
 *
 * **Wire payload:** The HTTP endpoint returns
 * `{ "data": { "authV2Enabled": boolean } }` per the standardized kalle
 * response envelope (Rule R22).
 *
 * **Caller-visible shape:** `apiClient.get<T>` (in
 * `kalle/apps/web/src/lib/api.ts`) unwraps the outer `data` field at line
 * `return json.data;` and returns `T` directly to the caller. Therefore
 * the type parameter passed to `apiClient.get<...>(...)` MUST describe the
 * INNER object — i.e., `{ authV2Enabled: boolean }` — not the outer
 * envelope. Specifying the outer envelope would result in
 * `response.data?.authV2Enabled` being `undefined` (because the outer
 * `data` field has already been stripped), which silently falls back to
 * the legacy form even when the flag is enabled. This bug was identified
 * in QA Checkpoint F2 follow-up runtime verification of F-CRITICAL-3.
 */
interface FeatureFlagsResponse {
  authV2Enabled: boolean;
}

/**
 * Response shape for `POST /api/v1/auth/login` (legacy).
 * The endpoint returns `{ data: { user, tokens } }` per `AuthResponse`
 * defined in `@kalle/shared/types/auth`.
 */
interface LegacyLoginResponse {
  data: {
    user: UserResponse;
    tokens: TokenPair;
  };
}

/* =============================================================================
 * LoginPage Component
 * =============================================================================
 *
 * Renders ONE of three mutually exclusive states determined at runtime by
 * the AUTH_V2_ENABLED flag:
 *   1. Loading — minimal spinner while the flag is being fetched OR while
 *      the PKCE redirect is in flight (default initial state).
 *   2. PKCE   — V2 mode: initiates the Keycloak PKCE redirect on mount.
 *               Renders a spinner with "Redirecting to sign-in…" caption
 *               while `window.location.href` navigates to Keycloak.
 *   3. Legacy — V2-disabled mode: renders the email + password form that
 *               POSTs to the legacy `/api/v1/auth/login` endpoint.
 *
 * Mode transitions are one-way: the page commits to a mode after the flag
 * resolves, and never switches modes mid-flight. This enforces Rule R4
 * mutual exclusion at the UI level (matching the API-side enforcement in
 * `apps/api/src/middleware/auth.ts`).
 * ========================================================================== */
export default function LoginPage(): JSX.Element {
  /* ─── Local State ──────────────────────────────────────────────────── */
  /**
   * Auth mode discriminant. Initial value `'loading'` reflects the moment
   * between mount and the first response of `GET /api/v1/auth/feature-flags`.
   * Once the flag resolves, this transitions to either `'pkce'` (V2=true)
   * or `'legacy'` (V2=false). The transition is one-way per Rule R4.
   */
  const [mode, setMode] = useState<AuthMode>('loading');

  /**
   * Top-level error message shown to the user when:
   *   - The browser does not support Web Crypto API (V2 mode only)
   *   - The Keycloak base URL env var is missing (V2 mode only)
   *   - The PKCE redirect orchestration throws unexpectedly (V2 mode only)
   *   - The legacy login submission returns a non-401 server error (e.g.,
   *     500, network failure)
   *
   * 401 from the legacy login is handled separately via `formError` so the
   * user sees an inline form error rather than a top-level page error.
   */
  const [error, setError] = useState<string | null>(null);

  /**
   * Form-level error message shown ABOVE the legacy form's submit button.
   * Reserved for credential-validation failures (HTTP 401 from
   * `/api/v1/auth/login`). Distinct from the top-level `error` state above
   * because the user can recover by entering correct credentials — no need
   * to show a page-blocking error.
   */
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * Form input states. These are intentionally local (not in any global
   * store) and exist only for the lifetime of this page. They are
   * controlled inputs per React best practice.
   *
   * R23 (log hygiene): These values are NEVER logged — see the `try/catch`
   * in `handleLegacySubmit` which logs only the error type/code, never any
   * field value.
   */
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  /**
   * Submission-in-flight indicator for the legacy form. Disables the
   * submit button to prevent double-submission and shows visual feedback.
   */
  const [submitting, setSubmitting] = useState(false);

  /* ─── Store & Router ───────────────────────────────────────────────── */
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isInitialized = useAuthStore((state) => state.isInitialized);
  const loginToStore = useAuthStore((state) => state.login);
  const router = useRouter();

  /* ─── Step 1: Already-Authenticated Guard ──────────────────────────── */
  /**
   * Runs as soon as the auth store finishes hydrating. If the user already
   * has an active session, redirect to `/chat` immediately — no flag fetch,
   * no Keycloak round-trip, no form interaction. This preserves the legacy
   * behavior of the pre-V2 login page (Rule R12 API stability).
   */
  useEffect(() => {
    /* SSR guard — no-op on the server. */
    if (typeof window === 'undefined') {
      return;
    }
    /* Hydration guard — wait for sessionStorage rehydration. */
    if (!isInitialized) {
      return;
    }
    if (isAuthenticated) {
      router.replace('/chat');
    }
  }, [isAuthenticated, isInitialized, router]);

  /* ─── Step 2: Flag Discovery (F-CRITICAL-3) ────────────────────────── */
  /**
   * Fetches `GET /api/v1/auth/feature-flags` on mount to determine the
   * runtime auth mode. Only fires AFTER the auth store has hydrated
   * (avoids racing with the already-authenticated guard) AND the user is
   * not already authenticated (no point fetching if we're about to
   * redirect to /chat).
   *
   * **Failure handling (Rule RF3 fail-open):**
   * If the fetch throws (network error, server unreachable, malformed
   * response), the catch block sets `mode = 'legacy'`. Rationale:
   *   - The legacy form is the pre-V2 default behavior.
   *   - It does not require Keycloak to be reachable.
   *   - It preserves byte-identical behavior with the pre-V2 1,814-test
   *     kalle suite.
   *   - Falling back to the form is strictly safer than locking users out
   *     entirely.
   *
   * **Mode transition is one-way (Rule R4):**
   * Once `setMode('pkce')` or `setMode('legacy')` is called, this effect
   * does NOT re-fire (the dependency array is `[isAuthenticated,
   * isInitialized]`, both of which are guards above). The `setMode` calls
   * are protected by an early-return when `mode !== 'loading'` so
   * subsequent renders don't re-trigger the effect body.
   */
  useEffect(() => {
    /* SSR guard. */
    if (typeof window === 'undefined') {
      return;
    }
    /* Hydration guard. */
    if (!isInitialized) {
      return;
    }
    /* Already-authenticated guard — Step 1 above will redirect us. */
    if (isAuthenticated) {
      return;
    }
    /* One-way transition guard — flag has already been resolved. */
    if (mode !== 'loading') {
      return;
    }

    let cancelled = false;
    const fetchFlag = async (): Promise<void> => {
      try {
        /* `apiClient.get<T>(...)` already strips the outer `{ data: ... }`
           envelope and returns `T` (the inner object) directly. So the
           `response` value here is `{ authV2Enabled: boolean }` — NOT
           `{ data: { authV2Enabled: boolean } }`. We therefore read the
           field directly off `response`. See the JSDoc on
           `FeatureFlagsResponse` above for the full rationale. */
        const response = await apiClient.get<FeatureFlagsResponse>(
          '/api/v1/auth/feature-flags',
        );
        if (cancelled) {
          return;
        }
        const enabled = response.authV2Enabled === true;
        setMode(enabled ? 'pkce' : 'legacy');
      } catch (err) {
        /* RF3 fail-open: any failure → legacy form (the safer default).
           R23-compliant: log only the error type, never the body or any
           token-like value. The error type is sufficient for diagnosis. */
        if (cancelled) {
          return;
        }
        // eslint-disable-next-line no-console -- R23-compliant: error type only, no values
        console.error(
          '[login] feature-flag discovery failed; falling back to legacy mode',
          err instanceof ApiError
            ? { code: err.code, status: err.status }
            : err instanceof Error
              ? { name: err.name }
              : { type: typeof err },
        );
        setMode('legacy');
      }
    };
    void fetchFlag();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, isInitialized, mode]);

  /* ─── Step 3: PKCE Redirect Orchestration (V2 mode only) ───────────── */
  /**
   * Initiates the Keycloak PKCE redirect when `mode === 'pkce'`. This
   * effect intentionally has `mode` in its dependency array so it fires
   * exactly once when the mode transitions from `'loading'` to `'pkce'`.
   *
   * The body is identical to the pre-F-CRITICAL-3 implementation, just
   * gated by the mode discriminant. All R7/R23 compliance notes from the
   * original implementation continue to apply — verifier and state are
   * generated and stored in sessionStorage; never logged; never persisted
   * beyond the round-trip to /auth/callback.
   */
  useEffect(() => {
    /* SSR guard. */
    if (typeof window === 'undefined') {
      return;
    }
    /* Mode guard — only run when V2 is active. */
    if (mode !== 'pkce') {
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
  }, [mode]);

  /* ─── Legacy Login Submit Handler (V2-disabled mode only) ──────────── */
  /**
   * Handles submission of the legacy email/password form. Performs:
   *   1. Form-level validation (non-empty email, non-empty password). The
   *      server also validates via Zod (`loginSchema`) and returns 400 on
   *      malformed input; this client-side check is just for UX.
   *   2. POST `/api/v1/auth/login` with `{ email, password }` body.
   *   3. On 200: persist tokens + user to authStore via `login(tokens, user)`.
   *      The store's `login` action sets `isAuthenticated: true`, which is
   *      observed by the already-authenticated guard above, but we also
   *      `router.replace('/chat')` directly for an immediate redirect.
   *   4. On 401: show `formError` ("Invalid email or password") so the user
   *      can correct credentials and retry. The form remains visible.
   *   5. On any other error: show top-level `error` ("Login failed. Please
   *      try again."). The user must reload to retry.
   *
   * **Rule R23 — log hygiene:** The catch block logs ONLY the error code
   * and HTTP status. The email, password, response body, and any token
   * value are NEVER logged.
   *
   * @param e - Form submission event (we call `preventDefault` to suppress
   *            the browser's default form-POST behavior so we can submit
   *            via fetch instead).
   */
  const handleLegacySubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setFormError(null);

    /* UX validation — server also validates, this is just for fast feedback. */
    if (email.trim().length === 0 || password.length === 0) {
      setFormError('Please enter your email and password.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await apiClient.post<LegacyLoginResponse>(
        '/api/v1/auth/login',
        { email: email.trim(), password },
      );

      /* Persist tokens + user to authStore (memory-only per R7 partialize). */
      loginToStore(response.data.tokens, response.data.user);

      /* Immediate redirect — the authStore.login() side effect is observed
         by the already-authenticated guard, but we also navigate directly
         so the redirect feels instant. */
      router.replace('/chat');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setFormError('Invalid email or password.');
      } else if (err instanceof ApiError && err.status === 429) {
        setFormError('Too many attempts. Please wait a moment and try again.');
      } else {
        // eslint-disable-next-line no-console -- R23-compliant: error type/status only, no field values
        console.error(
          '[login] legacy submit failed',
          err instanceof ApiError
            ? { code: err.code, status: err.status }
            : err instanceof Error
              ? { name: err.name }
              : { type: typeof err },
        );
        setError('Sign-in failed. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  /* ─── Render: Top-Level Error State ────────────────────────────────── */
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

  /* ─── Render: Legacy Email/Password Form (V2 disabled) ─────────────── */
  if (mode === 'legacy') {
    return (
      <main
        className="flex min-h-screen items-center justify-center bg-surface px-4"
        aria-label="Sign in to Kalle"
      >
        <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md">
          <h1 className="mb-6 text-center text-2xl font-semibold text-gray-900">
            Sign in to Kalle
          </h1>
          <form onSubmit={handleLegacySubmit} noValidate>
            {/* Email field */}
            <div className="mb-4">
              <label
                htmlFor="login-email"
                className="mb-1 block text-sm font-medium text-gray-700"
              >
                Email
              </label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.com"
                disabled={submitting}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus:border-blue-ios focus:outline-none focus:ring-1 focus:ring-blue-ios disabled:bg-gray-100 disabled:text-gray-500"
              />
            </div>

            {/* Password field */}
            <div className="mb-4">
              <label
                htmlFor="login-password"
                className="mb-1 block text-sm font-medium text-gray-700"
              >
                Password
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                disabled={submitting}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus:border-blue-ios focus:outline-none focus:ring-1 focus:ring-blue-ios disabled:bg-gray-100 disabled:text-gray-500"
              />
            </div>

            {/* Inline form error (recoverable — credential failure or rate limit) */}
            {formError !== null && (
              <div
                role="alert"
                aria-live="polite"
                className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              >
                {formError}
              </div>
            )}

            {/* Submit button */}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-blue-ios px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-ios focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-400"
              aria-busy={submitting}
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          {/* Register link */}
          <p className="mt-4 text-center text-sm text-gray-600">
            Don&apos;t have an account?{' '}
            <a
              href="/register"
              className="font-medium text-blue-ios hover:underline"
            >
              Create one
            </a>
          </p>
        </div>
      </main>
    );
  }

  /* ─── Render: Loading State (default — flag fetching OR PKCE redirect in progress) ── */
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-surface px-4"
      aria-busy="true"
      aria-live="polite"
      aria-label={
        mode === 'pkce' ? 'Redirecting to sign-in' : 'Loading sign-in page'
      }
    >
      <div className="flex flex-col items-center gap-3">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-secondary border-t-blue-ios"
          role="status"
          aria-label={
            mode === 'pkce'
              ? 'Redirecting to authentication provider'
              : 'Loading sign-in page'
          }
        />
        <p className="text-sm text-gray-600">
          {mode === 'pkce' ? 'Redirecting to sign-in…' : 'Loading…'}
        </p>
        <span className="sr-only">
          {mode === 'pkce'
            ? 'Redirecting to the authentication provider'
            : 'Loading the sign-in page'}
        </span>
      </div>
    </main>
  );
}
