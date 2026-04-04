/**
 * @module auth.test
 *
 * Unit tests for the authStore Zustand store.
 *
 * Covers:
 * - Initial state verification
 * - initialize() — hydrates from sessionStorage, registers token accessor
 * - register() — success stores user+tokens+persists; error sets error state
 * - login() — success stores user+tokens+persists; error sets error state
 * - refreshTokens() — success updates tokens; missing refresh triggers logout;
 *   failure triggers logout
 * - revokeSession() — R33 single-session revoke, always clears local state
 * - revokeAllSessions() — R33 multi-session revoke, always clears local state
 * - logout() — clears state + sessionStorage
 * - clearError() — clears error
 * - setTokens() — updates tokens in state + persists
 * - sessionStorage persistence and hydration
 *
 * @see AAP Section 0.7.1 Group 16 — Frontend State Management
 * @see AAP Rule R9 — Authentication on All Protected Routes
 * @see AAP Rule R33 — Session Revocation
 * @see AAP Rule R23 — Log Hygiene
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AuthResponse, TokenPair, RegisterDTO, LoginDTO } from '@kalle/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPost = vi.fn();
const mockSetTokenAccessor = vi.fn();

vi.mock('@/lib/api', () => ({
  apiClient: {
    post: (...args: unknown[]) => mockPost(...args),
    get: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  setTokenAccessor: (...args: unknown[]) => mockSetTokenAccessor(...args),
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(message: string, code: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  API_BASE_URL: 'http://localhost:3001/api/v1',
}));

// ---------------------------------------------------------------------------
// Mock sessionStorage (jsdom provides one but we want to spy on it)
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
  key: vi.fn((_index: number) => null),
};

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

function makeAuthUser() {
  return {
    id: 'user-001',
    email: 'alice@example.com',
    displayName: 'Alice Wonderland',
    avatar: 'https://cdn.example.com/alice.png',
    phoneNumber: '+1234567890',
  };
}

function makeTokenPair(overrides?: Partial<TokenPair>): TokenPair {
  return {
    accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-access',
    refreshToken: 'refresh-token-abc-123',
    expiresIn: 3600,
    refreshExpiresIn: 86400,
    ...overrides,
  };
}

function makeAuthResponse(): AuthResponse {
  const user = makeAuthUser();
  const tokens = makeTokenPair();
  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatar: user.avatar,
      phoneNumber: user.phoneNumber,
    },
    tokens,
  };
}

function makeRegisterDTO(): RegisterDTO {
  return {
    email: 'alice@example.com',
    password: 'Str0ngP@ssw0rd!',
    displayName: 'Alice Wonderland',
    phoneNumber: '+1234567890',
  };
}

function makeLoginDTO(): LoginDTO {
  return {
    email: 'alice@example.com',
    password: 'Str0ngP@ssw0rd!',
  };
}

const STORAGE_KEY = 'kalle_auth';

// ---------------------------------------------------------------------------
// Import store AFTER mocks are set up
// ---------------------------------------------------------------------------

let useAuthStore: typeof import('@/stores/authStore').useAuthStore;

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

    // Re-import store fresh for each test to get clean state
    vi.resetModules();
    const mod = await import('@/stores/authStore');
    useAuthStore = mod.useAuthStore;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Initial State
  // =========================================================================

  describe('initial state', () => {
    it('should have null user, null tokens, and isInitialized false', () => {
      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.accessToken).toBeNull();
      expect(state.refreshToken).toBeNull();
      expect(state.expiresIn).toBeNull();
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
      expect(state.isInitialized).toBe(false);
    });
  });

  // =========================================================================
  // initialize()
  // =========================================================================

  describe('initialize()', () => {
    it('should register token accessor with the API client', () => {
      useAuthStore.getState().initialize();

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

    it('should set isInitialized to true when no persisted data exists', () => {
      useAuthStore.getState().initialize();
      expect(useAuthStore.getState().isInitialized).toBe(true);
      expect(useAuthStore.getState().user).toBeNull();
    });

    it('should hydrate state from sessionStorage if data is persisted', () => {
      const user = makeAuthUser();
      const tokens = makeTokenPair();
      storageMap.set(
        STORAGE_KEY,
        JSON.stringify({
          user,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresIn: tokens.expiresIn,
        }),
      );

      useAuthStore.getState().initialize();

      const state = useAuthStore.getState();
      expect(state.isInitialized).toBe(true);
      expect(state.user).toEqual(user);
      expect(state.accessToken).toBe(tokens.accessToken);
      expect(state.refreshToken).toBe(tokens.refreshToken);
      expect(state.expiresIn).toBe(tokens.expiresIn);
    });

    it('should handle invalid JSON in sessionStorage gracefully', () => {
      storageMap.set(STORAGE_KEY, '{invalid-json!!}');

      // Should not throw
      useAuthStore.getState().initialize();

      const state = useAuthStore.getState();
      expect(state.isInitialized).toBe(true);
      expect(state.user).toBeNull();
    });

    it('token accessor getAccessToken should return current access token', () => {
      useAuthStore.getState().initialize();
      const accessor = mockSetTokenAccessor.mock.calls[0][0];

      // Initially null
      expect(accessor.getAccessToken()).toBeNull();

      // After setting tokens
      const tokens = makeTokenPair();
      useAuthStore.getState().setTokens(tokens);
      expect(accessor.getAccessToken()).toBe(tokens.accessToken);
    });

    it('token accessor clearTokens should trigger logout', () => {
      useAuthStore.getState().initialize();
      const accessor = mockSetTokenAccessor.mock.calls[0][0];

      // Set some state first
      const tokens = makeTokenPair();
      useAuthStore.getState().setTokens(tokens);
      expect(useAuthStore.getState().accessToken).toBe(tokens.accessToken);

      // Clear via accessor
      accessor.clearTokens();
      expect(useAuthStore.getState().accessToken).toBeNull();
      expect(useAuthStore.getState().user).toBeNull();
    });
  });

  // =========================================================================
  // register()
  // =========================================================================

  describe('register()', () => {
    it('should set isLoading during registration', async () => {
      const authResponse = makeAuthResponse();

      // Use a deferred promise to control timing
      let resolveApi: (value: AuthResponse) => void;
      mockPost.mockImplementation(
        () =>
          new Promise<AuthResponse>((resolve) => {
            resolveApi = resolve;
          }),
      );

      const dto = makeRegisterDTO();
      const promise = useAuthStore.getState().register(dto);

      // While pending
      expect(useAuthStore.getState().isLoading).toBe(true);
      expect(useAuthStore.getState().error).toBeNull();

      // Resolve
      resolveApi!(authResponse);
      await promise;

      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('should store user and tokens on successful registration', async () => {
      const authResponse = makeAuthResponse();
      mockPost.mockResolvedValue(authResponse);

      await useAuthStore.getState().register(makeRegisterDTO());

      const state = useAuthStore.getState();
      expect(state.user).toEqual({
        id: authResponse.user.id,
        email: authResponse.user.email,
        displayName: authResponse.user.displayName,
        avatar: authResponse.user.avatar,
        phoneNumber: authResponse.user.phoneNumber,
      });
      expect(state.accessToken).toBe(authResponse.tokens.accessToken);
      expect(state.refreshToken).toBe(authResponse.tokens.refreshToken);
      expect(state.expiresIn).toBe(authResponse.tokens.expiresIn);
      expect(state.error).toBeNull();
    });

    it('should persist to sessionStorage on successful registration', async () => {
      const authResponse = makeAuthResponse();
      mockPost.mockResolvedValue(authResponse);

      await useAuthStore.getState().register(makeRegisterDTO());

      expect(mockSessionStorage.setItem).toHaveBeenCalledWith(
        STORAGE_KEY,
        expect.any(String),
      );
      const persisted = JSON.parse(
        mockSessionStorage.setItem.mock.calls[0][1],
      );
      expect(persisted.user.id).toBe(authResponse.user.id);
      expect(persisted.accessToken).toBe(authResponse.tokens.accessToken);
    });

    it('should call POST /auth/register with the DTO', async () => {
      const authResponse = makeAuthResponse();
      mockPost.mockResolvedValue(authResponse);

      const dto = makeRegisterDTO();
      await useAuthStore.getState().register(dto);

      expect(mockPost).toHaveBeenCalledWith('/auth/register', dto);
    });

    it('should set error state and re-throw on registration failure', async () => {
      const error = new Error('Email already exists');
      mockPost.mockRejectedValue(error);

      await expect(
        useAuthStore.getState().register(makeRegisterDTO()),
      ).rejects.toThrow('Email already exists');

      const state = useAuthStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.error).toBe('Email already exists');
      expect(state.user).toBeNull();
    });

    it('should set generic error for non-Error rejections', async () => {
      mockPost.mockRejectedValue('network failure');

      await expect(
        useAuthStore.getState().register(makeRegisterDTO()),
      ).rejects.toBe('network failure');

      expect(useAuthStore.getState().error).toBe('Registration failed');
    });
  });

  // =========================================================================
  // login()
  // =========================================================================

  describe('login()', () => {
    it('should store user and tokens on successful login', async () => {
      const authResponse = makeAuthResponse();
      mockPost.mockResolvedValue(authResponse);

      await useAuthStore.getState().login(makeLoginDTO());

      const state = useAuthStore.getState();
      expect(state.user?.id).toBe(authResponse.user.id);
      expect(state.user?.email).toBe(authResponse.user.email);
      expect(state.user?.displayName).toBe(authResponse.user.displayName);
      expect(state.accessToken).toBe(authResponse.tokens.accessToken);
      expect(state.refreshToken).toBe(authResponse.tokens.refreshToken);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('should call POST /auth/login with the DTO', async () => {
      mockPost.mockResolvedValue(makeAuthResponse());

      const dto = makeLoginDTO();
      await useAuthStore.getState().login(dto);

      expect(mockPost).toHaveBeenCalledWith('/auth/login', dto);
    });

    it('should persist to sessionStorage on successful login', async () => {
      mockPost.mockResolvedValue(makeAuthResponse());

      await useAuthStore.getState().login(makeLoginDTO());

      expect(mockSessionStorage.setItem).toHaveBeenCalledWith(
        STORAGE_KEY,
        expect.any(String),
      );
    });

    it('should set error state and re-throw on login failure', async () => {
      mockPost.mockRejectedValue(new Error('Invalid credentials'));

      await expect(
        useAuthStore.getState().login(makeLoginDTO()),
      ).rejects.toThrow('Invalid credentials');

      expect(useAuthStore.getState().error).toBe('Invalid credentials');
      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('should clear previous error before starting login', async () => {
      // Set an error first
      mockPost.mockRejectedValueOnce(new Error('First error'));
      await useAuthStore.getState().login(makeLoginDTO()).catch(() => {});

      expect(useAuthStore.getState().error).toBe('First error');

      // Second login should clear error on start
      mockPost.mockResolvedValue(makeAuthResponse());
      await useAuthStore.getState().login(makeLoginDTO());

      expect(useAuthStore.getState().error).toBeNull();
    });
  });

  // =========================================================================
  // refreshTokens()
  // =========================================================================

  describe('refreshTokens()', () => {
    it('should update tokens on successful refresh', async () => {
      // Set initial state with a refresh token
      const initial = makeTokenPair();
      useAuthStore.setState({
        user: makeAuthUser(),
        accessToken: initial.accessToken,
        refreshToken: initial.refreshToken,
        expiresIn: initial.expiresIn,
      });

      const newTokens = makeTokenPair({
        accessToken: 'new-access-token-xyz',
        refreshToken: 'new-refresh-token-xyz',
        expiresIn: 7200,
      });
      mockPost.mockResolvedValue(newTokens);

      await useAuthStore.getState().refreshTokens();

      const state = useAuthStore.getState();
      expect(state.accessToken).toBe('new-access-token-xyz');
      expect(state.refreshToken).toBe('new-refresh-token-xyz');
      expect(state.expiresIn).toBe(7200);
    });

    it('should call POST /auth/refresh with the current refresh token', async () => {
      useAuthStore.setState({ refreshToken: 'my-refresh-token' });
      mockPost.mockResolvedValue(makeTokenPair());

      await useAuthStore.getState().refreshTokens();

      expect(mockPost).toHaveBeenCalledWith('/auth/refresh', {
        refreshToken: 'my-refresh-token',
      });
    });

    it('should persist updated tokens to sessionStorage', async () => {
      useAuthStore.setState({
        user: makeAuthUser(),
        refreshToken: 'old-refresh',
      });
      const newTokens = makeTokenPair();
      mockPost.mockResolvedValue(newTokens);

      await useAuthStore.getState().refreshTokens();

      expect(mockSessionStorage.setItem).toHaveBeenCalledWith(
        STORAGE_KEY,
        expect.any(String),
      );
    });

    it('should trigger logout if no refresh token is available', async () => {
      useAuthStore.setState({
        user: makeAuthUser(),
        refreshToken: null,
      });

      await useAuthStore.getState().refreshTokens();

      expect(mockPost).not.toHaveBeenCalled();
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().accessToken).toBeNull();
    });

    it('should trigger logout if refresh API call fails', async () => {
      useAuthStore.setState({
        user: makeAuthUser(),
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
      });
      mockPost.mockRejectedValue(new Error('Token expired'));

      await useAuthStore.getState().refreshTokens();

      // Should have logged out silently (not thrown)
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().accessToken).toBeNull();
      expect(useAuthStore.getState().refreshToken).toBeNull();
    });
  });

  // =========================================================================
  // revokeSession() — R33 Single Session Revocation
  // =========================================================================

  describe('revokeSession() — R33', () => {
    it('should call POST /auth/revoke with refresh token', async () => {
      useAuthStore.setState({
        user: makeAuthUser(),
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
      });
      mockPost.mockResolvedValue({});

      await useAuthStore.getState().revokeSession();

      expect(mockPost).toHaveBeenCalledWith('/auth/revoke', {
        refreshToken: 'refresh-456',
      });
    });

    it('should clear all local state after successful revocation', async () => {
      useAuthStore.setState({
        user: makeAuthUser(),
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
        expiresIn: 3600,
      });
      mockPost.mockResolvedValue({});

      await useAuthStore.getState().revokeSession();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.accessToken).toBeNull();
      expect(state.refreshToken).toBeNull();
      expect(state.expiresIn).toBeNull();
    });

    it('should clear local state even if API call fails (R33 always-clear)', async () => {
      useAuthStore.setState({
        user: makeAuthUser(),
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
      });
      mockPost.mockRejectedValue(new Error('Network error'));

      // Should NOT throw — try/finally in implementation
      await useAuthStore.getState().revokeSession();

      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().accessToken).toBeNull();
    });

    it('should clear sessionStorage after revocation', async () => {
      // Persist some data first
      storageMap.set(STORAGE_KEY, JSON.stringify({ user: makeAuthUser() }));
      useAuthStore.setState({ refreshToken: 'refresh-456' });
      mockPost.mockResolvedValue({});

      await useAuthStore.getState().revokeSession();

      expect(mockSessionStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
    });

    it('should trigger logout without API call if no refresh token', async () => {
      useAuthStore.setState({
        user: makeAuthUser(),
        refreshToken: null,
      });

      await useAuthStore.getState().revokeSession();

      expect(mockPost).not.toHaveBeenCalled();
      expect(useAuthStore.getState().user).toBeNull();
    });
  });

  // =========================================================================
  // revokeAllSessions() — R33 Multi-Session Revocation
  // =========================================================================

  describe('revokeAllSessions() — R33', () => {
    it('should call POST /auth/revoke-all', async () => {
      useAuthStore.setState({
        user: makeAuthUser(),
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
      });
      mockPost.mockResolvedValue({});

      await useAuthStore.getState().revokeAllSessions();

      expect(mockPost).toHaveBeenCalledWith('/auth/revoke-all', {});
    });

    it('should clear all local state after successful revocation', async () => {
      useAuthStore.setState({
        user: makeAuthUser(),
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
        expiresIn: 3600,
      });
      mockPost.mockResolvedValue({});

      await useAuthStore.getState().revokeAllSessions();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.accessToken).toBeNull();
      expect(state.refreshToken).toBeNull();
    });

    it('should clear local state even if API call fails (R33 always-clear)', async () => {
      useAuthStore.setState({
        user: makeAuthUser(),
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
      });
      mockPost.mockRejectedValue(new Error('Server down'));

      await useAuthStore.getState().revokeAllSessions();

      expect(useAuthStore.getState().user).toBeNull();
    });
  });

  // =========================================================================
  // logout()
  // =========================================================================

  describe('logout()', () => {
    it('should clear all auth state', () => {
      useAuthStore.setState({
        user: makeAuthUser(),
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
        expiresIn: 3600,
        isLoading: true,
        error: 'some error',
      });

      useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.accessToken).toBeNull();
      expect(state.refreshToken).toBeNull();
      expect(state.expiresIn).toBeNull();
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('should remove persisted auth from sessionStorage', () => {
      storageMap.set(STORAGE_KEY, JSON.stringify({ user: makeAuthUser() }));

      useAuthStore.getState().logout();

      expect(mockSessionStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
    });

    it('should not throw if sessionStorage is unavailable', () => {
      // Temporarily make removeItem throw
      mockSessionStorage.removeItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });

      // Should not throw
      expect(() => useAuthStore.getState().logout()).not.toThrow();
    });
  });

  // =========================================================================
  // clearError()
  // =========================================================================

  describe('clearError()', () => {
    it('should set error to null', () => {
      useAuthStore.setState({ error: 'Something went wrong' });

      useAuthStore.getState().clearError();

      expect(useAuthStore.getState().error).toBeNull();
    });

    it('should be a no-op if error is already null', () => {
      useAuthStore.setState({ error: null });

      useAuthStore.getState().clearError();

      expect(useAuthStore.getState().error).toBeNull();
    });
  });

  // =========================================================================
  // setTokens()
  // =========================================================================

  describe('setTokens()', () => {
    it('should update tokens in state', () => {
      const tokens = makeTokenPair();
      useAuthStore.getState().setTokens(tokens);

      const state = useAuthStore.getState();
      expect(state.accessToken).toBe(tokens.accessToken);
      expect(state.refreshToken).toBe(tokens.refreshToken);
      expect(state.expiresIn).toBe(tokens.expiresIn);
    });

    it('should persist tokens to sessionStorage if user exists', () => {
      useAuthStore.setState({ user: makeAuthUser() });
      const tokens = makeTokenPair();

      useAuthStore.getState().setTokens(tokens);

      expect(mockSessionStorage.setItem).toHaveBeenCalledWith(
        STORAGE_KEY,
        expect.any(String),
      );
      const persisted = JSON.parse(
        mockSessionStorage.setItem.mock.calls[0][1],
      );
      expect(persisted.accessToken).toBe(tokens.accessToken);
      expect(persisted.user.id).toBe(makeAuthUser().id);
    });

    it('should NOT persist if user is null (no complete auth state)', () => {
      useAuthStore.setState({ user: null });
      const tokens = makeTokenPair();

      useAuthStore.getState().setTokens(tokens);

      expect(mockSessionStorage.setItem).not.toHaveBeenCalled();
      // But state should still be updated
      expect(useAuthStore.getState().accessToken).toBe(tokens.accessToken);
    });
  });

  // =========================================================================
  // sessionStorage Persistence Integration
  // =========================================================================

  describe('sessionStorage persistence', () => {
    it('should persist full user + token data after login', async () => {
      const authResponse = makeAuthResponse();
      mockPost.mockResolvedValue(authResponse);

      await useAuthStore.getState().login(makeLoginDTO());

      const raw = storageMap.get(STORAGE_KEY);
      expect(raw).toBeDefined();
      const persisted = JSON.parse(raw!);
      expect(persisted.user.email).toBe(authResponse.user.email);
      expect(persisted.accessToken).toBe(authResponse.tokens.accessToken);
      expect(persisted.refreshToken).toBe(authResponse.tokens.refreshToken);
      expect(persisted.expiresIn).toBe(authResponse.tokens.expiresIn);
    });

    it('should clear persisted data on logout', async () => {
      const authResponse = makeAuthResponse();
      mockPost.mockResolvedValue(authResponse);

      await useAuthStore.getState().login(makeLoginDTO());
      expect(storageMap.has(STORAGE_KEY)).toBe(true);

      useAuthStore.getState().logout();
      expect(mockSessionStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
    });

    it('should update persisted tokens on setTokens with existing user', async () => {
      const authResponse = makeAuthResponse();
      mockPost.mockResolvedValue(authResponse);

      await useAuthStore.getState().login(makeLoginDTO());

      // Now update tokens
      const newTokens = makeTokenPair({
        accessToken: 'refreshed-access-token',
        refreshToken: 'refreshed-refresh-token',
      });
      useAuthStore.getState().setTokens(newTokens);

      const raw = storageMap.get(STORAGE_KEY);
      const persisted = JSON.parse(raw!);
      expect(persisted.accessToken).toBe('refreshed-access-token');
      expect(persisted.refreshToken).toBe('refreshed-refresh-token');
      // User should remain unchanged
      expect(persisted.user.email).toBe(authResponse.user.email);
    });
  });

  // =========================================================================
  // R23 — Log Hygiene
  // =========================================================================

  describe('R23 — Log Hygiene', () => {
    it('should not log tokens or passwords via console', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      mockPost.mockResolvedValue(makeAuthResponse());
      await useAuthStore.getState().login(makeLoginDTO());
      useAuthStore.getState().logout();

      // Gather all console output
      const allLogs = [
        ...consoleSpy.mock.calls.map((c) => c.join(' ')),
        ...consoleWarnSpy.mock.calls.map((c) => c.join(' ')),
      ].join(' ');

      // Should not contain any token or password patterns
      expect(allLogs).not.toContain('eyJhbGciOi');
      expect(allLogs).not.toContain('Str0ngP@ssw0rd');
      expect(allLogs).not.toContain('refresh-token');

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });
  });
});
