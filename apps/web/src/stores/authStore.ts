/**
 * @module apps/web/src/stores/authStore
 *
 * Zustand 4.5.x authentication state store for the Kalle WhatsApp clone frontend.
 *
 * Manages JWT token storage, user profile, login/logout state, token refresh,
 * and session persistence via the `persist` middleware with `sessionStorage`.
 *
 * Key design decisions and rule compliance:
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
 * Token Accessor Pattern:
 *   On module initialization (browser-only), registers token callbacks with the
 *   API client via `setTokenAccessor()` to avoid circular module dependencies.
 *   The API client reads/writes tokens through these callbacks rather than
 *   importing authStore directly.
 *
 * Persistence:
 *   Tokens and user profile are persisted to `sessionStorage` (not `localStorage`)
 *   using Zustand's `persist` middleware with `createJSONStorage`. Closing the
 *   browser tab clears auth state — a security best practice for session tokens.
 *   On page reload, state is automatically rehydrated from sessionStorage and
 *   `isInitialized` is set to `true` via the `onRehydrateStorage` callback.
 *
 * @see AAP Section 0.2.3 — Zustand auth state (tokens, user)
 * @see AAP Section 0.7.1 Group 16 — Frontend State Management
 * @see R9  — Authentication on all protected routes
 * @see R23 — Log hygiene (no token logging)
 * @see R33 — Session revocation via Redis-backed token blacklist
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { UserResponse, TokenPair, UpdateProfileDTO } from '@kalle/shared';
import { setTokenAccessor, apiClient } from '../lib/api';

// =============================================================================
// Local Token Set Type (V2 Cookie Compatibility)
// =============================================================================

/**
 * Token set passed to `refreshTokens()` and to the `setTokens` callback
 * registered with the API client via `setTokenAccessor`.
 *
 * Structurally mirrors the (internal, non-exported) `TokenSet` interface in
 * `lib/api.ts`. TypeScript's structural typing makes the two interfaces
 * cross-module compatible; no nominal binding is required.
 *
 * The key difference from `TokenPair` (in `@kalle/shared`) is that
 * `refreshToken` may be `null`. In **V2 mode** (per AAP FR-8 + Rule R7),
 * the refresh token lives in an `httpOnly; Secure; SameSite=Strict` cookie
 * that is invisible to JavaScript, so the JS state holds `refreshToken: null`
 * while the access token still lives in memory. In **legacy mode**
 * (`AUTH_V2_ENABLED=false`), `refreshToken` is the in-memory string
 * returned alongside the access token by `POST /api/v1/auth/login` and
 * `POST /api/v1/auth/refresh`.
 *
 * Why this lives in authStore.ts rather than @kalle/shared:
 *   The V2 work is constrained to the auth/flag codepath; modifying the
 *   shared types package is out of scope for this AAP. A local structural
 *   duplicate keeps cross-folder coordination minimal while satisfying the
 *   compile-time type contract with `lib/api.ts`.
 *
 * @see lib/api.ts — canonical TokenSet definition
 * @see R7   — Token storage policy (refresh in cookie, access in memory)
 * @see FR-8 — Web PKCE flow with httpOnly refresh-token cookie
 */
interface TokenSet {
  /** Short-lived JWT access token; ALWAYS present after a successful auth/refresh. */
  accessToken: string;

  /**
   * Opaque refresh token — string in legacy mode, null in V2 mode (cookie-only).
   * When null, the in-memory store MUST NOT persist any refresh-token value
   * (R7); the cookie alone authorizes the next refresh.
   */
  refreshToken: string | null;

  /** Access token TTL in seconds; 0 if absent from response (V2 may omit). */
  expiresIn: number;

  /** Refresh token TTL in seconds; 0 if absent from response (V2 omits). */
  refreshExpiresIn: number;
}

// =============================================================================
// State Interface
// =============================================================================

/**
 * Complete authentication state shape including properties and actions.
 *
 * State properties:
 * - `accessToken` — Short-lived JWT access token for API authentication
 * - `refreshToken` — Longer-lived opaque refresh token for obtaining new pairs
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
 * - `setIsLoading()` — Sets loading flag for auth operations
 * - `setIsInitialized()` — Marks store as initialized after rehydration
 *
 * Token Accessors (for lib/api.ts integration):
 * - `getAccessToken()` — Returns current access token
 * - `getRefreshToken()` — Returns current refresh token
 */
interface AuthState {
  // ---- State Properties ----

  /** JWT access token (short-lived, e.g., 15min). Null if not authenticated. */
  accessToken: string | null;

  /** Opaque refresh token (longer-lived, e.g., 7 days). Null if not authenticated. */
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
   * In V2 mode (per AAP FR-8 + Rule R7) the `refreshToken` field is `null`
   * because the refresh token lives in an httpOnly cookie that JavaScript
   * cannot read; the in-memory state correctly stores `null` to avoid
   * holding any stale value. In legacy mode the field is the opaque refresh
   * token string returned by the API.
   *
   * @param newTokens - Fresh token set from the refresh endpoint
   */
  refreshTokens: (newTokens: TokenSet) => void;

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
   * token refresh when a 401 response is received.
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
 * - Storage type: sessionStorage (tokens cleared on tab close)
 * - Partialized: only accessToken, refreshToken, user, isAuthenticated
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
        //
        // The `setTokens` callback accepts `TokenSet` (broader than TokenPair)
        // so V2 mode can pass `refreshToken: null` when the refresh token
        // lives in the httpOnly cookie and is intentionally absent from the
        // refresh response body (per AAP FR-8 + Rule R7).
        setTokenAccessor({
          getAccessToken: () => useAuthStore.getState().accessToken,
          getRefreshToken: () => useAuthStore.getState().refreshToken,
          setTokens: (newTokens: TokenSet) =>
            useAuthStore.getState().refreshTokens(newTokens),
          clearTokens: () => useAuthStore.getState().logout(),
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
        // tokens from being rehydrated on next page load.
        if (typeof sessionStorage !== 'undefined') {
          try {
            sessionStorage.removeItem('kalle-auth-storage');
          } catch {
            // Silently ignore storage errors (e.g., private browsing restrictions)
          }
        }
      },

      refreshTokens: (newTokens: TokenSet): void => {
        // In V2 mode, `newTokens.refreshToken` is `null` (the value lives in
        // the httpOnly cookie, not in JS). The state's `refreshToken` field
        // is `string | null`, so the assignment is type-safe in both modes.
        // In legacy mode, `newTokens.refreshToken` is the opaque string from
        // the API response and is stored in memory as before.
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

      setIsLoading: (loading: boolean): void => {
        set({ isLoading: loading });
      },

      setIsInitialized: (): void => {
        set({ isInitialized: true });
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
       * Use sessionStorage (not localStorage) for security — tokens are
       * cleared when the browser tab closes, preventing session persistence
       * across browser restarts.
       */
      storage: createJSONStorage(() => sessionStorage),

      /**
       * Only persist authentication-critical state. Transient UI state
       * (isLoading, isInitialized) is NOT persisted — they reset to
       * defaults on page load and are set appropriately during hydration.
       */
      partialize: (state: AuthState) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
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
  // The `setTokens` callback accepts `TokenSet` (broader than TokenPair) so
  // V2 mode can pass `refreshToken: null` when the refresh token lives in
  // the httpOnly cookie and is intentionally absent from the refresh
  // response body (per AAP FR-8 + Rule R7).
  setTokenAccessor({
    getAccessToken: () => useAuthStore.getState().accessToken,
    getRefreshToken: () => useAuthStore.getState().refreshToken,
    setTokens: (tokens: TokenSet) =>
      useAuthStore.getState().refreshTokens(tokens),
    clearTokens: () => useAuthStore.getState().logout(),
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
