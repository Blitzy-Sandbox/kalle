/**
 * @module apps/web/src/stores/authStore
 *
 * Zustand 4.5.x authentication state store for the Kalle WhatsApp clone frontend.
 *
 * Manages JWT access token (memory-only), refresh token (memory-only mirror of
 * an httpOnly cookie under V2), user profile, login/logout state, token refresh,
 * and FOUC-prevention persistence of `user` + `isAuthenticated` only.
 *
 * Key design decisions and rule compliance:
 *
 * - **R7 — Token Storage (CRITICAL):** Access tokens live ONLY in JS memory
 *   (Zustand state). Refresh tokens live ONLY in an `httpOnly; Secure;
 *   SameSite=Strict` cookie under V2 (`AUTH_V2_ENABLED=true`); the in-memory
 *   `refreshToken` slice is `null` in V2 mode. Under legacy
 *   (`AUTH_V2_ENABLED=false`) mode, the refresh token is held in memory only.
 *   Neither token is persisted to `sessionStorage`, `localStorage`, or any
 *   non-httpOnly cookie. The `partialize` config below excludes both tokens.
 *
 * - **R9 — Authentication on All Protected Routes:** Provides `isAuthenticated`
 *   derived state and token accessors for the API client to attach Bearer header.
 *
 * - **R33 — Session Revocation:** `logout()` clears client-side state and
 *   sessionStorage. Backend revocation (blacklisting JTI in Redis) is the
 *   caller's responsibility BEFORE invoking `logout()`.
 *
 * - **R23 — Log Hygiene:** Zero logging of tokens, passwords, or sensitive fields.
 *   No `console.log`, `console.warn`, or `console.error` calls in this module.
 *
 * - **R12 — API Stability:** All existing actions (`login`, `logout`,
 *   `refreshTokens`, `updateProfile`, `setUser`, `setIsLoading`,
 *   `setIsInitialized`, `getAccessToken`, `getRefreshToken`) preserve their
 *   exact signatures. Two NEW additive actions (`setAccessToken`, `clear`)
 *   support the V2 PKCE callback flow without breaking legacy callers.
 *
 * Token Accessor Pattern:
 *   On module initialization (browser-only), registers token callbacks with the
 *   API client via `setTokenAccessor()` to avoid circular module dependencies.
 *   The API client reads/writes tokens through these callbacks rather than
 *   importing authStore directly.
 *
 * Persistence (POST-R7):
 *   ONLY `user` and `isAuthenticated` are persisted to `sessionStorage`
 *   (key `kalle-auth-storage`) using Zustand's `persist` middleware. Tokens
 *   are NEVER persisted; they live in memory only and are cleared on tab
 *   close by virtue of the page unloading. The `user` slice is persisted
 *   to prevent flash-of-unauthenticated-content (FOUC) on page reload —
 *   the access token is re-acquired via `POST /api/v1/auth/refresh` on the
 *   first 401 (legacy) or via the httpOnly refresh cookie (V2).
 *
 * @see AAP Section 0.4.1.2 — Direct Modifications Required — Kalle Web (authStore)
 * @see AAP Section 0.7.1 R7 — Token storage discipline
 * @see AAP Section 0.7.1 R12 — API stability
 * @see FR-8  — Web PKCE flow with httpOnly refresh-token cookie
 * @see R7   — Token storage (access in memory; refresh in cookie)
 * @see R9   — Authentication on all protected routes
 * @see R12  — API stability (existing action signatures preserved)
 * @see R23  — Log hygiene (no token logging)
 * @see R33  — Session revocation via Redis-backed token blacklist
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { UserResponse, TokenPair, UpdateProfileDTO } from '@kalle/shared';
import { setTokenAccessor, apiClient } from '../lib/api';

// =============================================================================
// State Interface
// =============================================================================

/**
 * Complete authentication state shape including properties and actions.
 *
 * State properties:
 * - `accessToken` — Short-lived JWT access token for API authentication
 * - `refreshToken` — Longer-lived opaque refresh token for obtaining new pairs
 *                    (LEGACY mode only; `null` in V2 mode where the refresh
 *                    token lives in an httpOnly cookie that JS cannot read)
 * - `user` — Authenticated user profile (UserResponse from @kalle/shared)
 * - `isAuthenticated` — True when both accessToken and user are present
 * - `isLoading` — Loading state for auth operations (login, register, refresh)
 * - `isInitialized` — True after initial hydration from sessionStorage completes
 *
 * Actions:
 * - `login()` — Stores tokens + user, sets isAuthenticated, re-registers accessor
 * - `logout()` — Clears all auth state and sessionStorage entry
 * - `refreshTokens()` — Updates only token pair (called by API refresh interceptor)
 * - `updateProfile()` — Partially merges user profile updates
 * - `setUser()` — Replaces entire user object
 * - `setAccessToken()` — Sets ONLY the access token (V2 PKCE callback path)
 * - `setIsLoading()` — Sets loading flag for auth operations
 * - `setIsInitialized()` — Marks store as initialized after rehydration
 * - `clear()` — Surgical state-clear primitive (no side effects, no storage I/O)
 *
 * Token Accessors (for lib/api.ts integration):
 * - `getAccessToken()` — Returns current access token
 * - `getRefreshToken()` — Returns current refresh token
 */
interface AuthState {
  // ---- State Properties ----

  /** JWT access token (short-lived, e.g., 15min). Null if not authenticated. */
  accessToken: string | null;

  /**
   * Opaque refresh token (longer-lived, e.g., 7 days). Null if not
   * authenticated, AND null in V2 mode (the refresh value lives in an
   * httpOnly cookie that JS cannot read; per Rule R7).
   */
  refreshToken: string | null;

  /** Current authenticated user profile, or null if not logged in. */
  user: UserResponse | null;

  /** True when both accessToken and user are present — indicates active session. */
  isAuthenticated: boolean;

  /** Loading state for async auth operations (login, register, refresh). */
  isLoading: boolean;

  /** True after initial hydration from sessionStorage completes. Prevents FOUC. */
  isInitialized: boolean;

  // ---- Actions ----

  /**
   * Stores authentication credentials and user profile after successful login/register.
   *
   * Sets accessToken, refreshToken, user, and isAuthenticated to true.
   * Also re-registers the token accessor with the API client to ensure
   * the accessor callbacks reference the latest store instance.
   *
   * @param tokens - JWT access + refresh token pair from auth endpoint
   * @param user   - Authenticated user profile from auth response
   */
  login: (tokens: TokenPair, user: UserResponse) => void;

  /**
   * Clears all client-side auth state and removes the sessionStorage entry.
   *
   * IMPORTANT: This does NOT call the backend revoke API. The caller
   * (component/hook) should call the revoke endpoint BEFORE invoking
   * logout() if server-side session invalidation is needed (R33).
   */
  logout: () => void;

  /**
   * Updates only the token pair without affecting user or isAuthenticated.
   *
   * Called by the API client's token refresh interceptor when a 401 is
   * received and the refresh succeeds. The user remains authenticated
   * with fresh tokens.
   *
   * Legacy (R12) signature accepting a full TokenPair where refreshToken
   * is non-null. The V2 token-accessor callback bypasses this action and
   * writes directly via `useAuthStore.setState(...)` to support a `null`
   * refresh token (V2 mode — refresh value lives in httpOnly cookie).
   *
   * @param newTokens - Fresh token pair from the refresh endpoint
   */
  refreshTokens: (newTokens: TokenPair) => void;

  /**
   * Partially merges profile updates into the existing user object.
   *
   * Only updates fields present in the partial: displayName, avatar,
   * about, phoneNumber. If user is null (not authenticated), this is a no-op.
   *
   * @param partial - Partial profile update payload
   */
  updateProfile: (partial: Partial<UpdateProfileDTO> & { avatar?: string }) => void;

  /**
   * Replaces the entire user object with fresh data.
   *
   * Used when fetching fresh user data from the API (GET /api/v1/users/me)
   * to ensure the local profile is fully synchronized with the server.
   *
   * @param user - Complete user profile from the API
   */
  setUser: (user: UserResponse) => void;

  /**
   * Sets ONLY the access token (memory-only — Rule R7).
   *
   * Used by the V2 PKCE callback page (`app/auth/callback/page.tsx`) after
   * successful authorization-code exchange. The callback receives the access
   * token from `POST /realms/.../protocol/openid-connect/token` and writes
   * it to memory via this action. The refresh token is set server-side as
   * an httpOnly cookie and is NOT touched by this action.
   *
   * Setting `null` clears the access token without affecting the user or
   * isAuthenticated state — useful for transitional states.
   *
   * @param token - The new access token (or null to clear)
   * @see FR-8
   * @see R7
   */
  setAccessToken: (token: string | null) => void;

  /**
   * Sets the isLoading flag for UI loading indicators.
   *
   * Used during login/register/refresh operations to show spinners or
   * disable form controls.
   *
   * @param loading - Whether an auth operation is in progress
   */
  setIsLoading: (loading: boolean) => void;

  /**
   * Marks the store as initialized after rehydration from sessionStorage.
   *
   * Called by the `onRehydrateStorage` callback. UI components check
   * `isInitialized` to avoid rendering unauthenticated content before
   * hydration completes (prevents flash of login page on reload).
   */
  setIsInitialized: () => void;

  /**
   * Clears all in-memory auth state (used on logout/error).
   *
   * Sets `accessToken`, `refreshToken`, `user` to null and `isAuthenticated`
   * to false. Distinct from `logout()` which (in legacy flow) ALSO removes
   * the sessionStorage entry. `clear()` is the surgical, side-effect-free
   * primitive used by the V2 token-accessor `clearTokens` callback to avoid
   * recursive logout side effects when called from the api.ts 401 interceptor.
   *
   * Does NOT call any backend endpoint. The caller is responsible for any
   * server-side cleanup (e.g., the api.ts 401 interceptor calls
   * `POST /api/v1/auth/logout` to clear the httpOnly refresh cookie before
   * invoking `clear()`).
   *
   * @see FR-8
   * @see R7
   */
  clear: () => void;

  /**
   * Returns the current JWT access token, or null if not authenticated.
   *
   * Used by the API client (via setTokenAccessor) to attach the
   * Authorization: Bearer header to every protected API request (R9).
   */
  getAccessToken: () => string | null;

  /**
   * Returns the current refresh token, or null if not authenticated.
   *
   * Used by the API client (via setTokenAccessor) for transparent
   * token refresh when a 401 response is received. In V2 mode this
   * always returns `null` because the refresh token lives in an httpOnly
   * cookie that JavaScript cannot read; api.ts handles the null case
   * gracefully by sending an empty refresh body and relying on
   * `credentials: 'include'` to forward the cookie.
   */
  getRefreshToken: () => string | null;
}

// =============================================================================
// Store Creation with Persistence Middleware
// =============================================================================

/**
 * Zustand auth store hook providing authentication state and actions.
 *
 * Usage in React components:
 * ```tsx
 * const { user, isAuthenticated, login, logout } = useAuthStore();
 * // Or with selectors for performance:
 * const isAuth = useAuthStore((s) => s.isAuthenticated);
 * ```
 *
 * Persistence:
 * - Storage key: 'kalle-auth-storage'
 * - Storage type: sessionStorage (cleared on tab close)
 * - Partialized: ONLY `user` and `isAuthenticated` (tokens NEVER persisted — R7)
 * - Rehydration: sets isInitialized to true after hydration completes
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      // ---- Initial State ----
      accessToken: null,
      refreshToken: null,
      user: null,
      isAuthenticated: false,
      isLoading: false,
      isInitialized: false,

      // ---- Actions ----

      login: (tokens: TokenPair, user: UserResponse): void => {
        set({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          user,
          isAuthenticated: true,
          isLoading: false,
        });

        // Re-register token accessor with the API client after login to
        // ensure callbacks reference the latest store instance. Uses
        // getState() to always retrieve fresh values on each API call.
        setTokenAccessor({
          getAccessToken: () => useAuthStore.getState().accessToken,
          getRefreshToken: () => useAuthStore.getState().refreshToken,
          // FR-8 + R7: setTokens accepts TokenSet (refreshToken may be null in
          // V2 mode — refresh value lives in httpOnly cookie). Write directly
          // via setState to bypass the legacy refreshTokens(TokenPair) signature
          // which requires refreshToken: string. The new partialize excludes
          // both tokens, so they remain memory-only regardless of mode.
          setTokens: ({ accessToken, refreshToken }) =>
            useAuthStore.setState({ accessToken, refreshToken }),
          // R7: clearTokens uses clear() to avoid recursive logout() side effects
          // when invoked from api.ts 401 interceptor (the interceptor itself
          // already issues POST /api/v1/auth/logout before invoking clearTokens).
          clearTokens: () => useAuthStore.getState().clear(),
        });
      },

      logout: (): void => {
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          isAuthenticated: false,
          isLoading: false,
        });

        // Explicitly clear the sessionStorage entry to prevent stale
        // user state from being rehydrated on next page load.
        if (typeof sessionStorage !== 'undefined') {
          try {
            sessionStorage.removeItem('kalle-auth-storage');
          } catch {
            // Silently ignore storage errors (e.g., private browsing restrictions)
          }
        }
      },

      refreshTokens: (newTokens: TokenPair): void => {
        set({
          accessToken: newTokens.accessToken,
          refreshToken: newTokens.refreshToken,
        });
        // user and isAuthenticated remain unchanged — only tokens are rotated
      },

      updateProfile: (
        partial: Partial<UpdateProfileDTO> & { avatar?: string },
      ): void => {
        const { user } = get();
        if (!user) {
          // No-op when not authenticated — should not occur in normal flow
          return;
        }

        // Build a clean update object containing only defined fields from
        // the partial. This prevents overwriting existing user fields with
        // undefined values when only a subset of fields is provided.
        const updates: Partial<UserResponse> = {};

        if (partial.displayName !== undefined) {
          updates.displayName = partial.displayName;
        }
        if (partial.avatar !== undefined) {
          updates.avatar = partial.avatar;
        }
        if (partial.about !== undefined) {
          updates.about = partial.about;
        }
        if (partial.phoneNumber !== undefined) {
          updates.phoneNumber = partial.phoneNumber;
        }

        // Optimistic local update — immediately reflects in the UI.
        set({
          user: {
            ...user,
            ...updates,
          },
        });

        // Persist to backend via PATCH /api/v1/users/me (R5 + R6).
        // Fire-and-forget: the backend call runs in the background.
        // On failure, revert the local optimistic update.
        // Note: apiClient.patch<T> already unwraps the `data` envelope
        // from the API response, so the returned value is UserResponse.
        apiClient
          .patch<UserResponse>('/api/v1/users/me', partial)
          .then((serverUser) => {
            // Sync with server response to ensure consistency
            if (serverUser) {
              set({ user: serverUser });
            }
          })
          .catch(() => {
            // Revert to the original user state on backend failure
            set({ user });
          });
      },

      setUser: (user: UserResponse): void => {
        set({
          user,
          isAuthenticated: true,
        });
      },

      setAccessToken: (token: string | null): void => {
        // R7: access token lives in memory only; never persisted (excluded from partialize).
        set({ accessToken: token });
      },

      setIsLoading: (loading: boolean): void => {
        set({ isLoading: loading });
      },

      setIsInitialized: (): void => {
        set({ isInitialized: true });
      },

      clear: (): void => {
        // R7: clear all in-memory auth state without side effects.
        // Caller (e.g., api.ts 401 interceptor) handles any server-side
        // cleanup (cookie clear via POST /api/v1/auth/logout) BEFORE invoking this.
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          isAuthenticated: false,
        });
      },

      getAccessToken: (): string | null => {
        return get().accessToken;
      },

      getRefreshToken: (): string | null => {
        return get().refreshToken;
      },
    }),
    {
      /** Storage key used in sessionStorage */
      name: 'kalle-auth-storage',

      /**
       * Use sessionStorage (not localStorage) for security — persisted state is
       * cleared when the browser tab closes, preventing session persistence
       * across browser restarts. Note that NO tokens are written here (R7) —
       * only `user` and `isAuthenticated` for FOUC prevention.
       */
      storage: createJSONStorage(() => sessionStorage),

      /**
       * Persist ONLY user-display state for FOUC prevention. Tokens are NEVER
       * persisted (Rule R7) — they live in memory only and are cleared on tab
       * close. On page reload, the access token is re-acquired via the API
       * refresh flow (`POST /api/v1/auth/refresh`) which uses either the
       * in-memory refresh token (legacy mode) or the httpOnly refresh cookie
       * (V2 mode). The persisted `user` + `isAuthenticated` state allows the
       * UI to render the authenticated shell immediately on reload, then the
       * first protected API call triggers a silent refresh that obtains a
       * fresh access token.
       *
       * The persistence key `kalle-auth-storage` is preserved (existing test
       * fixtures and external integrations rely on this key).
       *
       * @see R7 — Tokens never persisted to any client-side storage
       */
      partialize: (state: AuthState) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),

      /**
       * After rehydration from sessionStorage completes, mark the store
       * as initialized. This signals to UI components that auth state is
       * ready and prevents the flash-of-unauthenticated-content (FOUC)
       * that would occur if components rendered before hydration.
       */
      onRehydrateStorage: () => {
        return (state: AuthState | undefined): void => {
          if (state) {
            state.setIsInitialized();
          }
        };
      },
    },
  ),
);

// =============================================================================
// API Client Token Accessor Registration
// =============================================================================

/**
 * Register token accessor with the API client at module initialization time.
 *
 * This avoids circular imports: api.ts cannot import authStore directly
 * (because authStore imports setTokenAccessor from api.ts). Instead, api.ts
 * defines setTokenAccessor() as a registration function, and authStore calls
 * it here to inject token read/write callbacks.
 *
 * The accessor uses useAuthStore.getState() to always get fresh values on
 * each API call, rather than capturing stale references at registration time.
 *
 * SSR guard: Only runs in the browser (typeof window !== 'undefined') to
 * prevent errors during Next.js server-side rendering where sessionStorage
 * and other browser APIs are unavailable.
 */
if (typeof window !== 'undefined') {
  setTokenAccessor({
    getAccessToken: () => useAuthStore.getState().accessToken,
    // R7: returns null in V2 mode (refresh value lives in httpOnly cookie);
    // api.ts handles this gracefully by sending an empty refresh body and
    // relying on `credentials: 'include'` to forward the cookie.
    getRefreshToken: () => useAuthStore.getState().refreshToken,
    // FR-8 + R7: see in-login setTokens above for rationale.
    setTokens: ({ accessToken, refreshToken }) =>
      useAuthStore.setState({ accessToken, refreshToken }),
    // R7: see in-login clearTokens above for rationale.
    clearTokens: () => useAuthStore.getState().clear(),
  });
}

// =============================================================================
// Derived Selectors
// =============================================================================

/**
 * Imperative selector returning the current isAuthenticated state.
 *
 * For use outside React components (e.g., route guards, middleware, utility
 * functions) where the hook API is unavailable. Returns a snapshot — not
 * reactive. For reactive use in components, use:
 * `useAuthStore((state) => state.isAuthenticated)`
 *
 * @returns Current authentication status
 */
export const selectIsAuthenticated = (): boolean =>
  useAuthStore.getState().isAuthenticated;

/**
 * Imperative selector returning the current user profile.
 *
 * For use outside React components where the hook API is unavailable.
 * Returns a snapshot — not reactive. For reactive use in components, use:
 * `useAuthStore((state) => state.user)`
 *
 * @returns Current user profile or null if not authenticated
 */
export const selectUser = (): UserResponse | null =>
  useAuthStore.getState().user;

/**
 * Imperative selector returning the current JWT access token.
 *
 * For use outside React components (e.g., WebSocket connection setup).
 * Returns a snapshot — not reactive. For reactive use in components, use:
 * `useAuthStore((state) => state.accessToken)`
 *
 * @returns Current access token or null if not authenticated
 */
export const selectAccessToken = (): string | null =>
  useAuthStore.getState().accessToken;

/**
 * Imperative selector returning whether auth state is fully initialized.
 *
 * For use outside React components to check if hydration from sessionStorage
 * has completed. Returns a snapshot — not reactive.
 *
 * @returns True if the store has completed initialization (rehydration)
 */
export const selectIsInitialized = (): boolean =>
  useAuthStore.getState().isInitialized;
