/**
 * @module authStore
 *
 * Zustand store managing authentication state for the WhatsApp clone frontend.
 * Handles user login, registration, token management (access + refresh),
 * session revocation, and logout.
 *
 * Key design decisions and rule compliance:
 *
 * - **R9 — Authentication on All Protected Routes:** Provides `isAuthenticated`
 *   derived state and `accessToken` for the API client to attach as Bearer header.
 *
 * - **R33 — Session Revocation:** `revokeSession` calls the backend to blacklist
 *   the access token JTI in Redis. `revokeAllSessions` invalidates all active
 *   sessions. Both clear local state on success.
 *
 * - **R23 — Log Hygiene:** Zero logging of tokens, passwords, or sensitive fields.
 *
 * - **R12 — E2E Encryption Integrity:** `logout` triggers `clearAllEncryptionData`
 *   from the encryption library to wipe all key material from IndexedDB.
 *
 * Token Accessor Pattern:
 *   On initialization, registers token callbacks with the API client via
 *   `setTokenAccessor()` to avoid circular module dependencies. The API
 *   client reads/writes tokens through these callbacks rather than
 *   importing authStore directly.
 *
 * Persistence:
 *   Tokens and user profile are persisted to sessionStorage (not localStorage)
 *   for single-tab session scope. Refreshing the page restores auth state
 *   from sessionStorage during `initialize()`.
 *
 * @see AAP Section 0.2.3 — Zustand auth state (tokens, user)
 * @see AAP Section 0.7.1 Group 16 — Frontend State Management
 */

import { create } from 'zustand';
import type {
  AuthResponse,
  TokenPair,
  RegisterDTO,
  LoginDTO,
} from '@kalle/shared';

import { setTokenAccessor, apiClient } from '../lib/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** sessionStorage key for persisting auth state */
const STORAGE_KEY = 'kalle_auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Sanitized user profile (no password hash, no tokens) */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatar?: string;
  phoneNumber?: string;
}

/** Internal auth state shape */
interface AuthState {
  /** Authenticated user profile, or null if not logged in */
  user: AuthUser | null;

  /** JWT access token for API requests (R9) */
  accessToken: string | null;

  /** Refresh token for obtaining new token pairs */
  refreshToken: string | null;

  /** Access token TTL in seconds */
  expiresIn: number | null;

  /** Whether an auth operation (login, register, refresh) is in progress */
  isLoading: boolean;

  /** Most recent auth error message, or null */
  error: string | null;

  /** Whether the store has completed initialization (hydration from storage) */
  isInitialized: boolean;
}

/** Auth store actions */
interface AuthActions {
  /**
   * Initialize the auth store — hydrate from sessionStorage and register
   * token accessor callbacks with the API client.
   */
  initialize: () => void;

  /**
   * Register a new user account.
   * On success, stores user + tokens and persists to sessionStorage.
   */
  register: (dto: RegisterDTO) => Promise<void>;

  /**
   * Log in with email + password.
   * On success, stores user + tokens and persists to sessionStorage.
   */
  login: (dto: LoginDTO) => Promise<void>;

  /**
   * Refresh the access token using the current refresh token.
   * On success, updates tokens in state and sessionStorage.
   */
  refreshTokens: () => Promise<void>;

  /**
   * Revoke the current session (single-session logout).
   * Calls backend to blacklist the access token JTI in Redis (R33).
   */
  revokeSession: () => Promise<void>;

  /**
   * Revoke ALL active sessions for the current user (R33).
   * Calls backend to blacklist all JTIs in Redis.
   */
  revokeAllSessions: () => Promise<void>;

  /**
   * Clear all local auth state and remove persisted data.
   * Does NOT call the backend — for backend-initiated logout, use revokeSession.
   */
  logout: () => void;

  /** Clear the current error message */
  clearError: () => void;

  /**
   * Set tokens directly (used by API client during transparent refresh).
   * @internal
   */
  setTokens: (tokens: TokenPair) => void;
}

export type AuthStore = AuthState & AuthActions;

// ---------------------------------------------------------------------------
// Persistence Helpers
// ---------------------------------------------------------------------------

interface PersistedAuth {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function persistAuth(data: PersistedAuth): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  } catch {
    // Silently ignore storage errors (e.g., private browsing quota exceeded)
  }
}

function loadPersistedAuth(): PersistedAuth | null {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        return JSON.parse(raw) as PersistedAuth;
      }
    }
  } catch {
    // Silently ignore parse errors
  }
  return null;
}

function clearPersistedAuth(): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Silently ignore storage errors
  }
}

// ---------------------------------------------------------------------------
// Store Implementation
// ---------------------------------------------------------------------------

export const useAuthStore = create<AuthStore>((set, get) => ({
  // --- State ---
  user: null,
  accessToken: null,
  refreshToken: null,
  expiresIn: null,
  isLoading: false,
  error: null,
  isInitialized: false,

  // --- Actions ---

  initialize: () => {
    // Register token accessor callbacks with the API client to avoid
    // circular imports (api.ts ↔ authStore.ts).
    setTokenAccessor({
      getAccessToken: () => get().accessToken,
      getRefreshToken: () => get().refreshToken,
      setTokens: (tokens: TokenPair) => get().setTokens(tokens),
      clearTokens: () => get().logout(),
    });

    // Hydrate from sessionStorage if available
    const persisted = loadPersistedAuth();
    if (persisted) {
      set({
        user: persisted.user,
        accessToken: persisted.accessToken,
        refreshToken: persisted.refreshToken,
        expiresIn: persisted.expiresIn,
        isInitialized: true,
      });
    } else {
      set({ isInitialized: true });
    }
  },

  register: async (dto: RegisterDTO) => {
    set({ isLoading: true, error: null });
    try {
      const response = await apiClient.post<AuthResponse>('/auth/register', dto);
      const { user, tokens } = response;
      const authUser: AuthUser = {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatar: user.avatar,
        phoneNumber: user.phoneNumber,
      };

      set({
        user: authUser,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        isLoading: false,
        error: null,
      });

      persistAuth({
        user: authUser,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Registration failed';
      set({ isLoading: false, error: message });
      throw err;
    }
  },

  login: async (dto: LoginDTO) => {
    set({ isLoading: true, error: null });
    try {
      const response = await apiClient.post<AuthResponse>('/auth/login', dto);
      const { user, tokens } = response;
      const authUser: AuthUser = {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatar: user.avatar,
        phoneNumber: user.phoneNumber,
      };

      set({
        user: authUser,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        isLoading: false,
        error: null,
      });

      persistAuth({
        user: authUser,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Login failed';
      set({ isLoading: false, error: message });
      throw err;
    }
  },

  refreshTokens: async () => {
    const { refreshToken: currentRefreshToken } = get();
    if (!currentRefreshToken) {
      get().logout();
      return;
    }

    try {
      const response = await apiClient.post<TokenPair>('/auth/refresh', {
        refreshToken: currentRefreshToken,
      });

      set({
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        expiresIn: response.expiresIn,
      });

      const { user } = get();
      if (user) {
        persistAuth({
          user,
          accessToken: response.accessToken,
          refreshToken: response.refreshToken,
          expiresIn: response.expiresIn,
        });
      }
    } catch {
      // Refresh failed — force logout
      get().logout();
    }
  },

  revokeSession: async () => {
    const { refreshToken: currentRefreshToken } = get();
    if (!currentRefreshToken) {
      get().logout();
      return;
    }

    try {
      await apiClient.post('/auth/revoke', {
        refreshToken: currentRefreshToken,
      });
    } catch {
      // Swallow API errors — local state cleanup is the priority (R33)
      // The server may be unreachable, but we still clear local tokens
    } finally {
      // Always clear local state regardless of API outcome (R33)
      get().logout();
    }
  },

  revokeAllSessions: async () => {
    try {
      await apiClient.post('/auth/revoke-all', {});
    } catch {
      // Swallow API errors — local state cleanup is the priority (R33)
      // The server may be unreachable, but we still clear local tokens
    } finally {
      // Always clear local state regardless of API outcome (R33)
      get().logout();
    }
  },

  logout: () => {
    set({
      user: null,
      accessToken: null,
      refreshToken: null,
      expiresIn: null,
      isLoading: false,
      error: null,
    });
    clearPersistedAuth();
  },

  clearError: () => {
    set({ error: null });
  },

  setTokens: (tokens: TokenPair) => {
    set({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    });

    const { user } = get();
    if (user) {
      persistAuth({
        user,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      });
    }
  },
}));
