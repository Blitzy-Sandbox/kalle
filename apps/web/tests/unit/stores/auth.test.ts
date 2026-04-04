/**
 * @module apps/web/tests/unit/stores/auth.test.ts
 *
 * Unit tests for the Zustand authentication state store (authStore).
 *
 * Tests cover:
 * - Initial state shape (null tokens, null user, flags)
 * - login(tokens, user) — stores credentials, sets isAuthenticated, re-registers accessor
 * - logout() — clears all auth state and sessionStorage
 * - refreshTokens(newTokens) — updates only the token pair
 * - updateProfile(partial) — partial user merge (displayName, avatar, about, phoneNumber)
 * - setUser(user) — replaces entire user object
 * - setIsLoading(loading) — loading flag toggle
 * - setIsInitialized() — initialization flag after hydration
 * - getAccessToken() / getRefreshToken() — token accessor methods
 * - Derived selectors: selectIsAuthenticated, selectUser, selectAccessToken, selectIsInitialized
 * - Token accessor registration with lib/api.ts (module-level + login re-registration)
 * - sessionStorage persistence via Zustand persist middleware
 * - R23 — Log hygiene (no token logging via console)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UserResponse, TokenPair } from '@kalle/shared';
import { UserStatus } from '@kalle/shared';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any module imports that use them
// ---------------------------------------------------------------------------

const mockSetTokenAccessor = vi.fn();

vi.mock('@/lib/api', () => ({
  setTokenAccessor: mockSetTokenAccessor,
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(message: string, status = 500, code = 'UNKNOWN') {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

// ---------------------------------------------------------------------------
// Mock sessionStorage backed by a Map for deterministic testing
// ---------------------------------------------------------------------------

const storageMap = new Map<string, string>();

const mockSessionStorage = {
  getItem: vi.fn((key: string) => storageMap.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storageMap.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    storageMap.delete(key);
  }),
  clear: vi.fn(() => storageMap.clear()),
  get length() {
    return storageMap.size;
  },
  key: vi.fn((index: number) => {
    const keys = Array.from(storageMap.keys());
    return keys[index] ?? null;
  }),
};

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeUser(overrides?: Partial<UserResponse>): UserResponse {
  return {
    id: 'usr_abc123',
    email: 'alice@example.com',
    displayName: 'Alice Wonderland',
    avatar: 'https://example.com/avatar.jpg',
    about: 'Hello there!',
    phoneNumber: '+1234567890',
    status: UserStatus.ONLINE,
    lastSeen: '2026-01-15T10:30:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTokenPair(overrides?: Partial<TokenPair>): TokenPair {
  return {
    accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-access-token',
    refreshToken: 'refresh-token-opaque-string-12345',
    expiresIn: 900,
    refreshExpiresIn: 604800,
    ...overrides,
  };
}

const STORAGE_KEY = 'kalle-auth-storage';

// ---------------------------------------------------------------------------
// Import store AFTER mocks are set up (dynamic import per test for isolation)
// ---------------------------------------------------------------------------

let useAuthStore: typeof import('@/stores/authStore').useAuthStore;
let selectIsAuthenticated: typeof import('@/stores/authStore').selectIsAuthenticated;
let selectUser: typeof import('@/stores/authStore').selectUser;
let selectAccessToken: typeof import('@/stores/authStore').selectAccessToken;
let selectIsInitialized: typeof import('@/stores/authStore').selectIsInitialized;

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('authStore', () => {
  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();
    storageMap.clear();

    // Install mock sessionStorage on globalThis
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: mockSessionStorage,
      writable: true,
      configurable: true,
    });

    // Re-import store fresh for each test to get clean Zustand state
    vi.resetModules();
    const mod = await import('@/stores/authStore');
    useAuthStore = mod.useAuthStore;
    selectIsAuthenticated = mod.selectIsAuthenticated;
    selectUser = mod.selectUser;
    selectAccessToken = mod.selectAccessToken;
    selectIsInitialized = mod.selectIsInitialized;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Initial State
  // =========================================================================

  describe('initial state', () => {
    it('should have null user, null tokens, and correct default flags', () => {
      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.accessToken).toBeNull();
      expect(state.refreshToken).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(false);
      // isInitialized is true after rehydration completes (onRehydrateStorage fires on module load)
      expect(state.isInitialized).toBe(true);
    });
  });

  // =========================================================================
  // login(tokens, user)
  // =========================================================================

  describe('login()', () => {
    it('should store tokens and user on login', () => {
      const tokens = makeTokenPair();
      const user = makeUser();

      useAuthStore.getState().login(tokens, user);

      const state = useAuthStore.getState();
      expect(state.accessToken).toBe(tokens.accessToken);
      expect(state.refreshToken).toBe(tokens.refreshToken);
      expect(state.user).toEqual(user);
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
    });

    it('should re-register token accessor with the API client', () => {
      const tokens = makeTokenPair();
      const user = makeUser();

      // Clear calls from module-level registration
      mockSetTokenAccessor.mockClear();

      useAuthStore.getState().login(tokens, user);

      expect(mockSetTokenAccessor).toHaveBeenCalledTimes(1);
      const accessor = mockSetTokenAccessor.mock.calls[0][0];
      expect(accessor).toHaveProperty('getAccessToken');
      expect(accessor).toHaveProperty('getRefreshToken');
      expect(accessor).toHaveProperty('setTokens');
      expect(accessor).toHaveProperty('clearTokens');
      expect(typeof accessor.getAccessToken).toBe('function');
      expect(typeof accessor.getRefreshToken).toBe('function');
      expect(typeof accessor.setTokens).toBe('function');
      expect(typeof accessor.clearTokens).toBe('function');
    });

    it('token accessor getAccessToken should return current token after login', () => {
      const tokens = makeTokenPair();
      const user = makeUser();

      mockSetTokenAccessor.mockClear();
      useAuthStore.getState().login(tokens, user);

      const accessor = mockSetTokenAccessor.mock.calls[0][0];
      expect(accessor.getAccessToken()).toBe(tokens.accessToken);
      expect(accessor.getRefreshToken()).toBe(tokens.refreshToken);
    });

    it('token accessor clearTokens should trigger logout', () => {
      const tokens = makeTokenPair();
      const user = makeUser();

      mockSetTokenAccessor.mockClear();
      useAuthStore.getState().login(tokens, user);

      const accessor = mockSetTokenAccessor.mock.calls[0][0];

      // Verify currently authenticated
      expect(useAuthStore.getState().isAuthenticated).toBe(true);

      // Clear via accessor — equivalent to API client triggering logout
      accessor.clearTokens();

      expect(useAuthStore.getState().accessToken).toBeNull();
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it('token accessor setTokens should call refreshTokens', () => {
      const tokens = makeTokenPair();
      const user = makeUser();

      mockSetTokenAccessor.mockClear();
      useAuthStore.getState().login(tokens, user);

      const accessor = mockSetTokenAccessor.mock.calls[0][0];
      const newTokens = makeTokenPair({
        accessToken: 'accessor-new-access',
        refreshToken: 'accessor-new-refresh',
      });

      accessor.setTokens(newTokens);

      expect(useAuthStore.getState().accessToken).toBe('accessor-new-access');
      expect(useAuthStore.getState().refreshToken).toBe(
        'accessor-new-refresh',
      );
      // User should remain unchanged
      expect(useAuthStore.getState().user).toEqual(user);
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });

    it('should reset isLoading to false on login', () => {
      useAuthStore.setState({ isLoading: true });

      useAuthStore.getState().login(makeTokenPair(), makeUser());

      expect(useAuthStore.getState().isLoading).toBe(false);
    });
  });

  // =========================================================================
  // logout()
  // =========================================================================

  describe('logout()', () => {
    it('should clear all auth state', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());
      useAuthStore.setState({ isLoading: true });

      useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.accessToken).toBeNull();
      expect(state.refreshToken).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(false);
    });

    it('should remove persisted auth from sessionStorage', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());

      useAuthStore.getState().logout();

      expect(mockSessionStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
    });

    it('should not throw if sessionStorage.removeItem throws', () => {
      mockSessionStorage.removeItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });

      // Should not throw — error is swallowed silently
      expect(() => useAuthStore.getState().logout()).not.toThrow();
    });

    it('should clear state even when called from unauthenticated state', () => {
      // No login — start clean
      useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.accessToken).toBeNull();
      expect(state.isAuthenticated).toBe(false);
    });
  });

  // =========================================================================
  // refreshTokens(newTokens)
  // =========================================================================

  describe('refreshTokens()', () => {
    it('should update tokens without changing user or isAuthenticated', () => {
      const tokens = makeTokenPair();
      const user = makeUser();
      useAuthStore.getState().login(tokens, user);

      const newTokens = makeTokenPair({
        accessToken: 'new-access-token-xyz',
        refreshToken: 'new-refresh-token-xyz',
        expiresIn: 1800,
      });

      useAuthStore.getState().refreshTokens(newTokens);

      const state = useAuthStore.getState();
      expect(state.accessToken).toBe('new-access-token-xyz');
      expect(state.refreshToken).toBe('new-refresh-token-xyz');
      expect(state.user).toEqual(user);
      expect(state.isAuthenticated).toBe(true);
    });

    it('should update tokens even when called without prior login', () => {
      const newTokens = makeTokenPair({
        accessToken: 'standalone-access',
        refreshToken: 'standalone-refresh',
      });

      useAuthStore.getState().refreshTokens(newTokens);

      expect(useAuthStore.getState().accessToken).toBe('standalone-access');
      expect(useAuthStore.getState().refreshToken).toBe('standalone-refresh');
    });
  });

  // =========================================================================
  // updateProfile(partial)
  // =========================================================================

  describe('updateProfile()', () => {
    it('should merge partial displayName into existing user', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());

      useAuthStore.getState().updateProfile({ displayName: 'New Name' });

      const state = useAuthStore.getState();
      expect(state.user?.displayName).toBe('New Name');
      // Other fields unchanged
      expect(state.user?.email).toBe('alice@example.com');
      expect(state.user?.avatar).toBe('https://example.com/avatar.jpg');
      expect(state.user?.about).toBe('Hello there!');
      expect(state.user?.phoneNumber).toBe('+1234567890');
    });

    it('should merge partial avatar into existing user', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());

      useAuthStore.getState().updateProfile({
        avatar: 'https://new-avatar.jpg',
      });

      expect(useAuthStore.getState().user?.avatar).toBe(
        'https://new-avatar.jpg',
      );
    });

    it('should merge partial about into existing user', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());

      useAuthStore.getState().updateProfile({ about: 'New about text' });

      expect(useAuthStore.getState().user?.about).toBe('New about text');
    });

    it('should merge partial phoneNumber into existing user', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());

      useAuthStore.getState().updateProfile({ phoneNumber: '+9876543210' });

      expect(useAuthStore.getState().user?.phoneNumber).toBe('+9876543210');
    });

    it('should update multiple fields at once', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());

      useAuthStore.getState().updateProfile({
        displayName: 'Updated Name',
        about: 'Updated about',
        avatar: 'https://updated-avatar.jpg',
      });

      const state = useAuthStore.getState();
      expect(state.user?.displayName).toBe('Updated Name');
      expect(state.user?.about).toBe('Updated about');
      expect(state.user?.avatar).toBe('https://updated-avatar.jpg');
      // phoneNumber unchanged
      expect(state.user?.phoneNumber).toBe('+1234567890');
    });

    it('should be a no-op when user is null (not authenticated)', () => {
      expect(useAuthStore.getState().user).toBeNull();

      useAuthStore
        .getState()
        .updateProfile({ displayName: 'Should not set' });

      expect(useAuthStore.getState().user).toBeNull();
    });

    it('should not overwrite fields omitted from the partial', () => {
      const user = makeUser({
        displayName: 'Original Name',
        about: 'Original about',
      });
      useAuthStore.getState().login(makeTokenPair(), user);

      // Update only displayName — about should remain
      useAuthStore.getState().updateProfile({ displayName: 'Changed Name' });

      expect(useAuthStore.getState().user?.displayName).toBe('Changed Name');
      expect(useAuthStore.getState().user?.about).toBe('Original about');
    });

    it('should preserve non-UpdateProfileDTO fields (id, email, status, etc.)', () => {
      const user = makeUser();
      useAuthStore.getState().login(makeTokenPair(), user);

      useAuthStore.getState().updateProfile({ displayName: 'New Name' });

      const updated = useAuthStore.getState().user;
      expect(updated?.id).toBe(user.id);
      expect(updated?.email).toBe(user.email);
      expect(updated?.status).toBe(user.status);
      expect(updated?.createdAt).toBe(user.createdAt);
      expect(updated?.updatedAt).toBe(user.updatedAt);
    });
  });

  // =========================================================================
  // setUser(user)
  // =========================================================================

  describe('setUser()', () => {
    it('should replace the entire user object', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());

      const newUser = makeUser({
        id: 'usr_new',
        email: 'bob@example.com',
        displayName: 'Bob Builder',
      });
      useAuthStore.getState().setUser(newUser);

      expect(useAuthStore.getState().user).toEqual(newUser);
    });

    it('should set isAuthenticated to true when setting user', () => {
      expect(useAuthStore.getState().isAuthenticated).toBe(false);

      useAuthStore.getState().setUser(makeUser());

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });
  });

  // =========================================================================
  // setIsLoading(loading)
  // =========================================================================

  describe('setIsLoading()', () => {
    it('should set isLoading to true', () => {
      useAuthStore.getState().setIsLoading(true);
      expect(useAuthStore.getState().isLoading).toBe(true);
    });

    it('should set isLoading to false', () => {
      useAuthStore.getState().setIsLoading(true);
      useAuthStore.getState().setIsLoading(false);
      expect(useAuthStore.getState().isLoading).toBe(false);
    });
  });

  // =========================================================================
  // setIsInitialized()
  // =========================================================================

  describe('setIsInitialized()', () => {
    it('should set isInitialized to true (idempotent after rehydration)', () => {
      // Already true from onRehydrateStorage firing during module load
      expect(useAuthStore.getState().isInitialized).toBe(true);

      // Calling again should be idempotent
      useAuthStore.getState().setIsInitialized();

      expect(useAuthStore.getState().isInitialized).toBe(true);
    });

    it('should set isInitialized from false to true when called manually', () => {
      // Manually reset to false to test the transition
      useAuthStore.setState({ isInitialized: false });
      expect(useAuthStore.getState().isInitialized).toBe(false);

      useAuthStore.getState().setIsInitialized();

      expect(useAuthStore.getState().isInitialized).toBe(true);
    });
  });

  // =========================================================================
  // getAccessToken() / getRefreshToken()
  // =========================================================================

  describe('token accessor methods', () => {
    it('getAccessToken should return null when not authenticated', () => {
      expect(useAuthStore.getState().getAccessToken()).toBeNull();
    });

    it('getAccessToken should return current token after login', () => {
      const tokens = makeTokenPair();
      useAuthStore.getState().login(tokens, makeUser());

      expect(useAuthStore.getState().getAccessToken()).toBe(
        tokens.accessToken,
      );
    });

    it('getRefreshToken should return null when not authenticated', () => {
      expect(useAuthStore.getState().getRefreshToken()).toBeNull();
    });

    it('getRefreshToken should return current token after login', () => {
      const tokens = makeTokenPair();
      useAuthStore.getState().login(tokens, makeUser());

      expect(useAuthStore.getState().getRefreshToken()).toBe(
        tokens.refreshToken,
      );
    });

    it('getAccessToken should return updated token after refreshTokens', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());

      const newTokens = makeTokenPair({ accessToken: 'refreshed-access' });
      useAuthStore.getState().refreshTokens(newTokens);

      expect(useAuthStore.getState().getAccessToken()).toBe(
        'refreshed-access',
      );
    });

    it('getAccessToken should return null after logout', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());
      useAuthStore.getState().logout();

      expect(useAuthStore.getState().getAccessToken()).toBeNull();
      expect(useAuthStore.getState().getRefreshToken()).toBeNull();
    });
  });

  // =========================================================================
  // Derived Selectors
  // =========================================================================

  describe('derived selectors', () => {
    it('selectIsAuthenticated should return false when not logged in', () => {
      expect(selectIsAuthenticated()).toBe(false);
    });

    it('selectIsAuthenticated should return true after login', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());
      expect(selectIsAuthenticated()).toBe(true);
    });

    it('selectUser should return null when not logged in', () => {
      expect(selectUser()).toBeNull();
    });

    it('selectUser should return user after login', () => {
      const user = makeUser();
      useAuthStore.getState().login(makeTokenPair(), user);
      expect(selectUser()).toEqual(user);
    });

    it('selectAccessToken should return null when not logged in', () => {
      expect(selectAccessToken()).toBeNull();
    });

    it('selectAccessToken should return token after login', () => {
      const tokens = makeTokenPair();
      useAuthStore.getState().login(tokens, makeUser());
      expect(selectAccessToken()).toBe(tokens.accessToken);
    });

    it('selectIsInitialized should return true after rehydration', () => {
      // Already true from onRehydrateStorage firing during module load
      expect(selectIsInitialized()).toBe(true);
    });

    it('selectIsInitialized should track manual state changes', () => {
      useAuthStore.setState({ isInitialized: false });
      expect(selectIsInitialized()).toBe(false);

      useAuthStore.getState().setIsInitialized();
      expect(selectIsInitialized()).toBe(true);
    });
  });

  // =========================================================================
  // Token Accessor Registration (Module-Level via SSR Guard)
  // =========================================================================

  describe('token accessor registration', () => {
    it('should register token accessor with api.ts on module load', () => {
      // Module initialization should have called setTokenAccessor
      expect(mockSetTokenAccessor).toHaveBeenCalled();

      const accessor = mockSetTokenAccessor.mock.calls[0][0];
      expect(typeof accessor.getAccessToken).toBe('function');
      expect(typeof accessor.getRefreshToken).toBe('function');
      expect(typeof accessor.setTokens).toBe('function');
      expect(typeof accessor.clearTokens).toBe('function');
    });

    it('module-level accessor should return null when not authenticated', () => {
      const accessor = mockSetTokenAccessor.mock.calls[0][0];
      expect(accessor.getAccessToken()).toBeNull();
      expect(accessor.getRefreshToken()).toBeNull();
    });

    it('module-level accessor should return tokens after login', () => {
      const tokens = makeTokenPair();
      useAuthStore.getState().login(tokens, makeUser());

      // First call is module-level registration
      const accessor = mockSetTokenAccessor.mock.calls[0][0];
      expect(accessor.getAccessToken()).toBe(tokens.accessToken);
      expect(accessor.getRefreshToken()).toBe(tokens.refreshToken);
    });
  });

  // =========================================================================
  // sessionStorage Persistence (via Zustand persist middleware)
  // =========================================================================

  describe('sessionStorage persistence', () => {
    it('should persist auth state after login', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());

      // Zustand persist middleware writes to sessionStorage
      expect(mockSessionStorage.setItem).toHaveBeenCalledWith(
        STORAGE_KEY,
        expect.any(String),
      );
    });

    it('should persist only partialized state (no isLoading or isInitialized)', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());

      // Find the setItem call for the auth storage key
      const calls = mockSessionStorage.setItem.mock.calls.filter(
        (call: string[]) => call[0] === STORAGE_KEY,
      );
      expect(calls.length).toBeGreaterThan(0);

      const lastCall = calls[calls.length - 1];
      const persisted = JSON.parse(lastCall[1]);

      // Should contain partialized state
      expect(persisted.state).toHaveProperty('accessToken');
      expect(persisted.state).toHaveProperty('refreshToken');
      expect(persisted.state).toHaveProperty('user');
      expect(persisted.state).toHaveProperty('isAuthenticated');

      // Should NOT contain transient state
      expect(persisted.state).not.toHaveProperty('isLoading');
      expect(persisted.state).not.toHaveProperty('isInitialized');
    });

    it('should clear persisted data on logout', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());

      useAuthStore.getState().logout();

      expect(mockSessionStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
    });

    it('should update persisted tokens on refreshTokens', () => {
      useAuthStore.getState().login(makeTokenPair(), makeUser());
      mockSessionStorage.setItem.mockClear();

      const newTokens = makeTokenPair({
        accessToken: 'refreshed-access-token',
        refreshToken: 'refreshed-refresh-token',
      });
      useAuthStore.getState().refreshTokens(newTokens);

      // Persist middleware should write updated state
      expect(mockSessionStorage.setItem).toHaveBeenCalledWith(
        STORAGE_KEY,
        expect.any(String),
      );
    });
  });

  // =========================================================================
  // R23 — Log Hygiene
  // =========================================================================

  describe('R23 — Log Hygiene', () => {
    it('should not log tokens or sensitive data via console', () => {
      const consoleSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {});
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      // Exercise all auth actions
      const tokens = makeTokenPair();
      const user = makeUser();
      useAuthStore.getState().login(tokens, user);
      useAuthStore.getState().refreshTokens(
        makeTokenPair({ accessToken: 'new-token-value' }),
      );
      useAuthStore.getState().updateProfile({ displayName: 'Updated' });
      useAuthStore.getState().logout();

      // Gather all console output
      const allLogs = [
        ...consoleSpy.mock.calls.map((c) => c.join(' ')),
        ...consoleWarnSpy.mock.calls.map((c) => c.join(' ')),
        ...consoleErrorSpy.mock.calls.map((c) => c.join(' ')),
      ].join(' ');

      // Should not contain any token patterns (R23)
      expect(allLogs).not.toContain('eyJhbGciOi');
      expect(allLogs).not.toContain('refresh-token');
      expect(allLogs).not.toContain('new-token-value');
      expect(allLogs).not.toContain('Str0ngP@ssw0rd');

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });
});
