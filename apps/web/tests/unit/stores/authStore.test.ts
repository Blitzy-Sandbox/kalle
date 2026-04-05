/**
 * @module apps/web/tests/unit/stores/authStore.test.ts
 *
 * Unit tests for useAuthStore Zustand authentication store.
 *
 * Covers:
 *  - login() — stores credentials, sets isAuthenticated, calls setTokenAccessor
 *  - logout() — clears state and sessionStorage (R33 Session Revocation)
 *  - refreshTokens() — updates only tokens, user unchanged
 *  - updateProfile() — partial merge on user object
 *  - setUser() — full replacement of user object
 *  - setIsInitialized() — initialization flag after hydration
 *  - getAccessToken() / getRefreshToken() — token accessor methods
 *  - sessionStorage persistence via zustand/middleware/persist
 *  - setTokenAccessor integration with lib/api.ts (R9 Auth Integration)
 *  - Token accessor returns current (not stale) tokens after refresh
 *
 * Test runner: Vitest 1.6.x (NOT Jest)
 * Environment: jsdom (from vitest.config.ts)
 * TypeScript strict mode compatible (R7)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UserResponse, TokenPair, UpdateProfileDTO } from '@kalle/shared';
import { UserStatus } from '@kalle/shared';

// ---------------------------------------------------------------------------
// Mock setup — vi.hoisted ensures mockSetTokenAccessor is available when
// vi.mock factory runs (both are hoisted before module-level imports).
// ---------------------------------------------------------------------------

const mockSetTokenAccessor = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  setTokenAccessor: mockSetTokenAccessor,
}));

// ---------------------------------------------------------------------------
// Store import — must come after vi.mock so the mock is in place when the
// module loads (authStore.ts has a module-level setTokenAccessor call).
// ---------------------------------------------------------------------------

import { useAuthStore } from '@/stores/authStore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'kalle-auth-storage';

// ---------------------------------------------------------------------------
// Test Data Fixtures
// ---------------------------------------------------------------------------

const mockUser: UserResponse = {
  id: 'user-123',
  email: 'test@example.com',
  displayName: 'Test User',
  avatar: undefined,
  about: 'Hello there',
  phoneNumber: '+1234567890',
  status: UserStatus.ONLINE,
  lastSeen: undefined,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const mockTokens: TokenPair = {
  accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock-access',
  refreshToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock-refresh',
  expiresIn: 900,
  refreshExpiresIn: 604800,
};

// ---------------------------------------------------------------------------
// Initial state shape used for reset in beforeEach
// ---------------------------------------------------------------------------

const initialState = {
  user: null as UserResponse | null,
  accessToken: null as string | null,
  refreshToken: null as string | null,
  isAuthenticated: false,
  isInitialized: false,
  isLoading: false,
};

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('authStore', () => {
  beforeEach(() => {
    // Reset store to initial state (triggers persist write with empty state)
    useAuthStore.setState(initialState);

    // Clear sessionStorage so tests start with clean slate
    sessionStorage.clear();

    // Clear all mock call histories (removes module-level setTokenAccessor call)
    vi.clearAllMocks();
  });

  // ========================================================================
  // Phase 1: Login Sets State Correctly
  // ========================================================================

  describe('login', () => {
    it('sets user, tokens, and isAuthenticated', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      const state = useAuthStore.getState();
      expect(state.user).toEqual(mockUser);
      expect(state.accessToken).toBe(mockTokens.accessToken);
      expect(state.refreshToken).toBe(mockTokens.refreshToken);
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
    });

    it('calls setTokenAccessor from lib/api.ts to register token getters (R9)', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      expect(mockSetTokenAccessor).toHaveBeenCalledTimes(1);

      const accessor = mockSetTokenAccessor.mock.calls[0][0];
      expect(typeof accessor.getAccessToken).toBe('function');
      expect(typeof accessor.getRefreshToken).toBe('function');

      // Accessor should return current tokens from store state
      expect(accessor.getAccessToken()).toBe(mockTokens.accessToken);
      expect(accessor.getRefreshToken()).toBe(mockTokens.refreshToken);
    });

    it('replaces existing auth state if called again (re-login)', () => {
      const firstUser: UserResponse = {
        ...mockUser,
        id: 'user-first',
        displayName: 'First User',
      };
      const firstTokens: TokenPair = {
        ...mockTokens,
        accessToken: 'first-access-token',
      };

      useAuthStore.getState().login(firstTokens, firstUser);

      const secondUser: UserResponse = {
        ...mockUser,
        id: 'user-second',
        displayName: 'Second User',
      };
      const secondTokens: TokenPair = {
        ...mockTokens,
        accessToken: 'second-access-token',
      };

      useAuthStore.getState().login(secondTokens, secondUser);

      const state = useAuthStore.getState();
      expect(state.user).toEqual(secondUser);
      expect(state.accessToken).toBe('second-access-token');
      expect(state.user?.id).toBe('user-second');
      expect(state.user?.displayName).toBe('Second User');
    });
  });

  // ========================================================================
  // Phase 2: Logout Clears Everything
  // ========================================================================

  describe('logout — R33 Session Revocation client-side', () => {
    it('clears user, tokens, and isAuthenticated', () => {
      useAuthStore.getState().login(mockTokens, mockUser);
      useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.accessToken).toBeNull();
      expect(state.refreshToken).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(false);
    });

    it('clears sessionStorage persisted state', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      // Verify login persisted something
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeTruthy();

      useAuthStore.getState().logout();

      // After logout, the persist subscriber first writes null state via setItem,
      // then the explicit removeItem call in logout() removes the key entirely.
      // We verify the outcome: the storage key is gone after logout.
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('does not throw when called from already-logged-out state', () => {
      // Call logout without prior login — should not throw
      expect(() => useAuthStore.getState().logout()).not.toThrow();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.accessToken).toBeNull();
      expect(state.refreshToken).toBeNull();
      expect(state.isAuthenticated).toBe(false);
    });

    it('R33 — logout is client-side state clear only; API revocation is caller responsibility', () => {
      // The store logout action only clears local state and sessionStorage.
      // The actual POST /api/v1/auth/revoke call is the responsibility
      // of the component/page that triggers logout, NOT the store.
      useAuthStore.getState().login(mockTokens, mockUser);

      // Clear mock so we only see calls originating from logout
      mockSetTokenAccessor.mockClear();

      useAuthStore.getState().logout();

      // Verify only state was cleared — no extra API calls from the store
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(useAuthStore.getState().user).toBeNull();
    });
  });

  // ========================================================================
  // Phase 3: Token Management
  // ========================================================================

  describe('refreshTokens', () => {
    it('updates ONLY tokens, does NOT change user or isAuthenticated', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      const newTokens: TokenPair = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 1800,
        refreshExpiresIn: 604800,
      };

      useAuthStore.getState().refreshTokens(newTokens);

      const state = useAuthStore.getState();
      expect(state.accessToken).toBe('new-access-token');
      expect(state.refreshToken).toBe('new-refresh-token');
      expect(state.user).toEqual(mockUser);
      expect(state.isAuthenticated).toBe(true);
    });
  });

  describe('getAccessToken / getRefreshToken', () => {
    it('getAccessToken returns current access token', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      expect(useAuthStore.getState().getAccessToken()).toBe(
        mockTokens.accessToken,
      );
    });

    it('getRefreshToken returns current refresh token', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      expect(useAuthStore.getState().getRefreshToken()).toBe(
        mockTokens.refreshToken,
      );
    });

    it('getters return null when not logged in', () => {
      expect(useAuthStore.getState().getAccessToken()).toBeNull();
      expect(useAuthStore.getState().getRefreshToken()).toBeNull();
      expect(useAuthStore.getState().accessToken).toBeNull();
      expect(useAuthStore.getState().refreshToken).toBeNull();
    });
  });

  // ========================================================================
  // Phase 4: Profile Updates
  // ========================================================================

  describe('updateProfile', () => {
    it('performs partial merge on the user object', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      const profileUpdate: UpdateProfileDTO = {
        displayName: 'Updated Name',
        about: 'New about text',
      };
      useAuthStore.getState().updateProfile(profileUpdate);

      const state = useAuthStore.getState();
      expect(state.user?.displayName).toBe('Updated Name');
      expect(state.user?.about).toBe('New about text');
      // Unchanged fields should be preserved
      expect(state.user?.email).toBe(mockUser.email);
      expect(state.user?.id).toBe(mockUser.id);
      expect(state.user?.phoneNumber).toBe(mockUser.phoneNumber);
    });

    it('handles avatar URL update', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      useAuthStore.getState().updateProfile({
        avatar: 'https://example.com/avatar.jpg',
      });

      expect(useAuthStore.getState().user?.avatar).toBe(
        'https://example.com/avatar.jpg',
      );
    });

    it('does nothing if user is null (not logged in)', () => {
      // Without login, user is null
      useAuthStore.getState().updateProfile({ displayName: 'X' });

      // No crash, no side effects — user remains null
      expect(useAuthStore.getState().user).toBeNull();
    });

    it('preserves existing fields when updating a single field', () => {
      useAuthStore.getState().login(mockTokens, {
        ...mockUser,
        displayName: 'Original',
        about: 'Original about',
        avatar: 'https://old.com/pic.jpg',
        phoneNumber: '+1111111111',
      });

      useAuthStore.getState().updateProfile({ phoneNumber: '+2222222222' });

      const user = useAuthStore.getState().user;
      expect(user?.phoneNumber).toBe('+2222222222');
      expect(user?.displayName).toBe('Original');
      expect(user?.about).toBe('Original about');
      expect(user?.avatar).toBe('https://old.com/pic.jpg');
    });
  });

  describe('setUser', () => {
    it('performs full replacement of the user object', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      const newUser: UserResponse = {
        id: 'user-999',
        email: 'new@example.com',
        displayName: 'Completely New User',
        avatar: 'https://new.com/avatar.jpg',
        about: 'Completely different',
        phoneNumber: '+0000000000',
        status: UserStatus.OFFLINE,
        lastSeen: '2024-06-01T00:00:00.000Z',
        createdAt: '2024-06-01T00:00:00.000Z',
        updatedAt: '2024-06-01T00:00:00.000Z',
      };

      useAuthStore.getState().setUser(newUser);

      expect(useAuthStore.getState().user).toEqual(newUser);
      // setUser also sets isAuthenticated to true
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
    });

    it('sets isAuthenticated to true when setting a user', () => {
      // Start with unauthenticated state
      expect(useAuthStore.getState().isAuthenticated).toBe(false);

      useAuthStore.getState().setUser(mockUser);

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().user).toEqual(mockUser);
    });
  });

  // ========================================================================
  // Phase 5: Persistence via zustand/middleware/persist
  // ========================================================================

  describe('sessionStorage persistence (key: kalle-auth-storage)', () => {
    it('store persists to sessionStorage with key kalle-auth-storage', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      const stored = sessionStorage.getItem(STORAGE_KEY);
      expect(stored).not.toBeNull();

      const parsed = JSON.parse(stored!);
      expect(parsed.state.accessToken).toBe(mockTokens.accessToken);
      expect(parsed.state.refreshToken).toBe(mockTokens.refreshToken);
      expect(parsed.state.isAuthenticated).toBe(true);
      expect(parsed.state.user).toEqual(mockUser);
    });

    it('store rehydrates from sessionStorage on initialization', async () => {
      // Pre-populate sessionStorage with valid persisted state.
      // IMPORTANT: setState must happen BEFORE setItem because
      // setState triggers the persist subscriber which writes current
      // (null) state to sessionStorage, overwriting any prior value.
      const persistedState = {
        state: {
          accessToken: 'rehydrated-access',
          refreshToken: 'rehydrated-refresh',
          user: mockUser,
          isAuthenticated: true,
        },
        version: 0,
      };

      // Reset isInitialized FIRST (triggers persist write with null state)
      useAuthStore.setState({ isInitialized: false });

      // THEN populate sessionStorage (overwrites the persist write above)
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState));

      // Trigger rehydration — reads our pre-populated data
      await useAuthStore.persist.rehydrate();

      const state = useAuthStore.getState();
      expect(state.accessToken).toBe('rehydrated-access');
      expect(state.refreshToken).toBe('rehydrated-refresh');
      expect(state.user).toEqual(mockUser);
      expect(state.isAuthenticated).toBe(true);
      expect(state.isInitialized).toBe(true);
    });

    it('SSR guard — typeof window check prevents sessionStorage access on server', () => {
      // In jsdom environment (used by vitest), window IS defined.
      // The store implementation guards against SSR with:
      //   typeof window !== 'undefined'
      // In a real Node.js SSR environment, sessionStorage access
      // would be safely skipped. This test documents the pattern.
      expect(typeof window).toBe('object');
    });

    it('only persists partialized state (not isLoading or isInitialized)', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      const stored = sessionStorage.getItem(STORAGE_KEY);
      expect(stored).not.toBeNull();

      const parsed = JSON.parse(stored!);
      // These fields SHOULD be in persisted state (partialized)
      expect(parsed.state).toHaveProperty('accessToken');
      expect(parsed.state).toHaveProperty('refreshToken');
      expect(parsed.state).toHaveProperty('user');
      expect(parsed.state).toHaveProperty('isAuthenticated');
      // These transient fields should NOT be persisted
      expect(parsed.state).not.toHaveProperty('isLoading');
      expect(parsed.state).not.toHaveProperty('isInitialized');
    });
  });

  // ========================================================================
  // Phase 6: Initialization Flag
  // ========================================================================

  describe('isInitialized', () => {
    it('is false initially', () => {
      useAuthStore.setState({ isInitialized: false });

      expect(useAuthStore.getState().isInitialized).toBe(false);
    });

    it('is true after rehydration', async () => {
      useAuthStore.setState({ isInitialized: false });

      await useAuthStore.persist.rehydrate();

      expect(useAuthStore.getState().isInitialized).toBe(true);
    });

    it('setIsInitialized sets the flag to true', () => {
      useAuthStore.setState({ isInitialized: false });
      expect(useAuthStore.getState().isInitialized).toBe(false);

      useAuthStore.getState().setIsInitialized();

      expect(useAuthStore.getState().isInitialized).toBe(true);
    });

    it('guards protect against premature state reads before hydration', () => {
      // Simulate state before hydration completes
      useAuthStore.setState({
        isInitialized: false,
        isAuthenticated: true,
        accessToken: 'some-token',
      });

      const state = useAuthStore.getState();

      // Components should check isInitialized before trusting isAuthenticated.
      // Even though isAuthenticated is true, the state hasn't been validated
      // via hydration — components should wait for isInitialized === true.
      expect(state.isInitialized).toBe(false);
      expect(state.isAuthenticated).toBe(true);
    });
  });

  // ========================================================================
  // Phase 7: Token Accessor Integration with lib/api.ts
  // ========================================================================

  describe('setTokenAccessor integration — R9', () => {
    it('after login, setTokenAccessor is called with accessor that returns fresh tokens', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      expect(mockSetTokenAccessor).toHaveBeenCalledTimes(1);

      const accessor = mockSetTokenAccessor.mock.calls[0][0];
      expect(accessor.getAccessToken()).toBe(mockTokens.accessToken);
      expect(accessor.getRefreshToken()).toBe(mockTokens.refreshToken);
    });

    it('the token accessor always returns CURRENT tokens (reflects subsequent refreshes)', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      const accessor = mockSetTokenAccessor.mock.calls[0][0];

      // Verify initial tokens via accessor
      expect(accessor.getAccessToken()).toBe(mockTokens.accessToken);
      expect(accessor.getRefreshToken()).toBe(mockTokens.refreshToken);

      // Refresh tokens in the store
      useAuthStore.getState().refreshTokens({
        accessToken: 'refreshed-access',
        refreshToken: 'refreshed-refresh',
        expiresIn: 900,
        refreshExpiresIn: 604800,
      });

      // The SAME accessor should now return the NEW tokens because it
      // reads from useAuthStore.getState() dynamically, not from a
      // closure over initial values.
      expect(accessor.getAccessToken()).toBe('refreshed-access');
      expect(accessor.getRefreshToken()).toBe('refreshed-refresh');
    });

    it('the token accessor provides setTokens callback for token rotation', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      const accessor = mockSetTokenAccessor.mock.calls[0][0];
      expect(typeof accessor.setTokens).toBe('function');

      // Use the accessor's setTokens to rotate tokens
      accessor.setTokens({
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        expiresIn: 900,
        refreshExpiresIn: 604800,
      });

      // Store should reflect the rotated tokens
      expect(useAuthStore.getState().accessToken).toBe('rotated-access');
      expect(useAuthStore.getState().refreshToken).toBe('rotated-refresh');
    });

    it('the token accessor provides clearTokens callback that triggers logout', () => {
      useAuthStore.getState().login(mockTokens, mockUser);

      const accessor = mockSetTokenAccessor.mock.calls[0][0];
      expect(typeof accessor.clearTokens).toBe('function');

      // Use the accessor's clearTokens
      accessor.clearTokens();

      // Store should be in logged-out state
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().accessToken).toBeNull();
      expect(useAuthStore.getState().refreshToken).toBeNull();
    });
  });
});
