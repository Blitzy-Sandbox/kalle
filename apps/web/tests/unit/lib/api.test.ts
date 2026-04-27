/**
 * @file api.test.ts
 *
 * Unit tests for the REST API client (apps/web/src/lib/api.ts).
 *
 * Covers:
 * - R9:  Auth header injection — Bearer token present when available
 * - R22: Standardized error parsing — { error: { code, message, details? } }
 * - R29: Correlation ID header — X-Correlation-ID on every request
 * - Token refresh interceptor: 401 triggers refresh, retries original request
 * - Concurrent refresh prevention: multiple 401s → single refresh call
 * - Failed refresh: clearTokens called, ApiError thrown
 * - HTTP methods: get/post/patch/put/delete send correct method
 * - Content-Type: JSON body sets application/json
 * - Base URL: uses NEXT_PUBLIC_API_URL or defaults to http://localhost:3001
 * - setTokenAccessor: registers token getters/setters for auth integration
 * - ApiError class: code, message, status, details fields
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock globals BEFORE importing the module under test.
// The api.ts module reads these at call-time (not module-load) so hoisting
// is safe — stubs are in place before any test-initiated request fires.
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockRandomUUID = vi.fn<[], string>().mockReturnValue('test-correlation-id-uuid');
vi.stubGlobal('crypto', { randomUUID: mockRandomUUID });

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import {
  apiClient,
  setTokenAccessor,
  ApiError,
  API_BASE_URL,
} from '@/lib/api';

// ---------------------------------------------------------------------------
// Helper: create a mock Response object for mockFetch return values
// ---------------------------------------------------------------------------

function createMockResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText:
      status === 200
        ? 'OK'
        : status === 204
          ? 'No Content'
          : status === 401
            ? 'Unauthorized'
            : 'Error',
    headers: new Headers(headers ?? {}),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    clone: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Token accessor mocks — re-created per test for isolation
// ---------------------------------------------------------------------------

let mockGetAccessToken: ReturnType<typeof vi.fn<[], string | null>>;
let mockGetRefreshToken: ReturnType<typeof vi.fn<[], string | null>>;
let mockSetTokens: ReturnType<typeof vi.fn>;
let mockClearTokens: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGetAccessToken = vi.fn<[], string | null>().mockReturnValue('mock-access-token-jwt');
  mockGetRefreshToken = vi.fn<[], string | null>().mockReturnValue('mock-refresh-token');
  mockSetTokens = vi.fn();
  mockClearTokens = vi.fn();

  setTokenAccessor({
    getAccessToken: mockGetAccessToken,
    getRefreshToken: mockGetRefreshToken,
    setTokens: mockSetTokens,
    clearTokens: mockClearTokens,
  });

  mockFetch.mockReset();
  mockRandomUUID.mockReturnValue('test-correlation-id-uuid');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =========================================================================
// Suite 1: ApiError class
// =========================================================================

describe('ApiError class', () => {
  it('should populate code, message, status, and details correctly', () => {
    const error = new ApiError('TEST_CODE', 'Test message', 422, {
      key: 'value',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.name).toBe('ApiError');
    expect(error.code).toBe('TEST_CODE');
    expect(error.message).toBe('Test message');
    expect(error.status).toBe(422);
    expect(error.details).toEqual({ key: 'value' });
  });

  it('should work without the optional details field', () => {
    const error = new ApiError('CODE', 'msg', 400);

    expect(error.code).toBe('CODE');
    expect(error.message).toBe('msg');
    expect(error.status).toBe(400);
    expect(error.details).toBeUndefined();
  });

  it('should preserve the error stack trace', () => {
    const error = new ApiError('STACK', 'trace test', 500);

    expect(error.stack).toBeDefined();
    expect(typeof error.stack).toBe('string');
  });
});

// =========================================================================
// Suite 2: Auth header injection (R9)
// =========================================================================

describe('auth header injection (R9)', () => {
  it('should include Authorization: Bearer <token> header when token is available', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: { id: '1' } }),
    );

    await apiClient.get('/api/v1/users/me');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = fetchOptions.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer mock-access-token-jwt');
  });

  it('should omit Authorization header when no token is available', async () => {
    mockGetAccessToken.mockReturnValue(null);
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: 'ok' }),
    );

    await apiClient.get('/api/v1/auth/login');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = fetchOptions.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('should call getAccessToken from the registered accessor', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: 'ok' }),
    );

    await apiClient.get('/api/v1/conversations');

    expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================
// Suite 3: Correlation ID header (R29)
// =========================================================================

describe('correlation ID header (R29)', () => {
  it('should include X-Correlation-ID header on every request', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: 'ok' }),
    );

    await apiClient.get('/api/v1/users');

    const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = fetchOptions.headers as Record<string, string>;
    expect(headers['X-Correlation-ID']).toBe('test-correlation-id-uuid');
  });

  it('should generate a correlation ID per request via crypto.randomUUID', async () => {
    mockFetch.mockResolvedValue(
      createMockResponse(200, { data: 'ok' }),
    );

    await apiClient.get('/api/v1/a');
    await apiClient.get('/api/v1/b');

    expect(mockRandomUUID).toHaveBeenCalledTimes(2);
  });

  it('should use distinct correlation IDs for different requests', async () => {
    let callCount = 0;
    mockRandomUUID.mockImplementation(() => {
      callCount += 1;
      return `uuid-${callCount}`;
    });
    mockFetch.mockResolvedValue(
      createMockResponse(200, { data: 'ok' }),
    );

    await apiClient.get('/api/v1/first');
    await apiClient.get('/api/v1/second');

    const headers1 = (mockFetch.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    const headers2 = (mockFetch.mock.calls[1]![1] as RequestInit)
      .headers as Record<string, string>;

    expect(headers1['X-Correlation-ID']).toBe('uuid-1');
    expect(headers2['X-Correlation-ID']).toBe('uuid-2');
  });
});

// =========================================================================
// Suite 4: Token refresh interceptor
// =========================================================================

describe('token refresh interceptor', () => {
  const refreshTokens = {
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token',
    expiresIn: 3600,
    refreshExpiresIn: 604800,
  };

  it('should trigger refresh via POST /api/v1/auth/refresh on 401 and retry', async () => {
    // 1. Original request → 401
    mockFetch.mockResolvedValueOnce(
      createMockResponse(401, {
        error: { code: 'TOKEN_EXPIRED', message: 'Token expired' },
      }),
    );
    // 2. Refresh → 200 with new tokens
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: { tokens: refreshTokens } }),
    );
    // 3. Retry original → 200
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: { user: 'me' } }),
    );

    const result = await apiClient.get('/api/v1/users/me');

    // Verify result from retried request
    expect(result).toEqual({ user: 'me' });

    // Verify setTokens was called with new token pair
    expect(mockSetTokens).toHaveBeenCalledTimes(1);
    expect(mockSetTokens).toHaveBeenCalledWith(refreshTokens);

    // Verify fetch call sequence: initial, refresh, retry
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Second call should be the refresh endpoint
    const [refreshUrl, refreshOpts] = mockFetch.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(refreshUrl).toBe(`${API_BASE_URL}/api/v1/auth/refresh`);
    expect(refreshOpts.method).toBe('POST');
    expect(JSON.parse(refreshOpts.body as string)).toEqual({
      refreshToken: 'mock-refresh-token',
    });
  });

  it('should prevent concurrent refresh — multiple 401s result in single refresh call', async () => {
    // 3 initial requests all return 401
    mockFetch.mockResolvedValueOnce(
      createMockResponse(401, {
        error: { code: 'TOKEN_EXPIRED', message: 'expired' },
      }),
    );
    mockFetch.mockResolvedValueOnce(
      createMockResponse(401, {
        error: { code: 'TOKEN_EXPIRED', message: 'expired' },
      }),
    );
    mockFetch.mockResolvedValueOnce(
      createMockResponse(401, {
        error: { code: 'TOKEN_EXPIRED', message: 'expired' },
      }),
    );
    // 1 refresh returns 200
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: { tokens: refreshTokens } }),
    );
    // 3 retry requests return 200
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: 'result-a' }),
    );
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: 'result-b' }),
    );
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: 'result-c' }),
    );

    const [a, b, c] = await Promise.all([
      apiClient.get('/api/v1/a'),
      apiClient.get('/api/v1/b'),
      apiClient.get('/api/v1/c'),
    ]);

    expect(a).toBe('result-a');
    expect(b).toBe('result-b');
    expect(c).toBe('result-c');

    // Count refresh calls — must be exactly 1
    const refreshCalls = mockFetch.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('/api/v1/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);

    // setTokens called exactly once
    expect(mockSetTokens).toHaveBeenCalledTimes(1);
  });

  it('should call clearTokens and throw ApiError when refresh itself fails', async () => {
    // Original request → 401
    mockFetch.mockResolvedValueOnce(
      createMockResponse(401, {
        error: { code: 'TOKEN_EXPIRED', message: 'Token expired' },
      }),
    );
    // Refresh also → 401 (invalid refresh token)
    mockFetch.mockResolvedValueOnce(
      createMockResponse(401, {
        error: { code: 'REFRESH_INVALID', message: 'Refresh failed' },
      }),
    );

    try {
      await apiClient.get('/api/v1/users/me');
      expect.unreachable('Should have thrown ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(401);
    }

    // clearTokens must have been called during failed refresh
    expect(mockClearTokens).toHaveBeenCalled();
  });

  it('should bail to logout-and-redirect on retry-401 with no second refresh (FR-8 + FR-9)', async () => {
    // Original → 401, refresh → 200, retry → another 401, logout → 204.
    //
    // Per AAP FR-8 + FR-9 + Rule R7: when the retry (isRetry === true) ALSO
    // returns 401, the V2 client does NOT attempt a second refresh (anti-
    // infinite-loop invariant); instead it issues a best-effort
    // POST /api/v1/auth/logout to clear the httpOnly refresh cookie, then
    // calls clearTokens() and redirects to /login. The original retry-401
    // response code (e.g. 'STILL_UNAUTHORIZED') is intentionally NOT
    // propagated; the surface error is the consolidated session-expired
    // 'AUTHENTICATION_ERROR' so callers/UX uniformly handle session loss.
    mockFetch.mockResolvedValueOnce(
      createMockResponse(401, {
        error: { code: 'TOKEN_EXPIRED', message: 'expired' },
      }),
    );
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: { tokens: refreshTokens } }),
    );
    mockFetch.mockResolvedValueOnce(
      createMockResponse(401, {
        error: { code: 'STILL_UNAUTHORIZED', message: 'still bad' },
      }),
    );
    // Best-effort logout fetch (FR-9): server returns HTTP 204 on success.
    mockFetch.mockResolvedValueOnce(createMockResponse(204, null));

    try {
      await apiClient.get('/api/v1/protected');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('AUTHENTICATION_ERROR');
      expect(apiErr.status).toBe(401);
    }

    // Anti-infinite-loop invariant: exactly ONE refresh attempt per outer request.
    const refreshCalls = mockFetch.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('/api/v1/auth/refresh'),
    );
    expect(refreshCalls).toHaveLength(1);

    // FR-9: best-effort logout fetch was issued before in-memory clear.
    const logoutCalls = mockFetch.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('/api/v1/auth/logout'),
    );
    expect(logoutCalls).toHaveLength(1);
    const [, logoutOpts] = logoutCalls[0] as [string, RequestInit];
    expect(logoutOpts.method).toBe('POST');
    expect(logoutOpts.credentials).toBe('include');

    // In-memory state cleared (R7) for redirect to /login.
    expect(mockClearTokens).toHaveBeenCalled();

    // Total fetch sequence: initial 401, refresh 200, retry 401, logout 204.
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('should not attempt refresh when no token accessor is registered', async () => {
    // Clear the token accessor
    setTokenAccessor(null as unknown as Parameters<typeof setTokenAccessor>[0]);

    mockFetch.mockResolvedValueOnce(
      createMockResponse(401, {
        error: { code: 'TOKEN_EXPIRED', message: 'expired' },
      }),
    );

    try {
      await apiClient.get('/api/v1/users/me');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
    }

    // Only 1 fetch call — no refresh attempt
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// =========================================================================
// Suite 5: Error handling — standardized error parsing (R22)
// =========================================================================

describe('error handling — standardized error parsing (R22)', () => {
  it('should parse 400 errors with code, message, and details', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
          details: { field: 'email' },
        },
      }),
    );

    try {
      await apiClient.post('/api/v1/auth/register', { email: '' });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('VALIDATION_ERROR');
      expect(apiErr.message).toBe('Invalid input');
      expect(apiErr.status).toBe(400);
      expect(apiErr.details).toEqual({ field: 'email' });
    }
  });

  it('should handle 404 errors correctly', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse(404, {
        error: { code: 'NOT_FOUND', message: 'User not found' },
      }),
    );

    try {
      await apiClient.get('/api/v1/users/unknown');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('NOT_FOUND');
      expect(apiErr.message).toBe('User not found');
      expect(apiErr.status).toBe(404);
    }
  });

  it('should handle 500 errors correctly', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse(500, {
        error: { code: 'INTERNAL_ERROR', message: 'Server error' },
      }),
    );

    try {
      await apiClient.get('/api/v1/health');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(500);
      expect((err as ApiError).code).toBe('INTERNAL_ERROR');
    }
  });

  it('should handle network errors (fetch throws TypeError)', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    try {
      await apiClient.get('/api/v1/users/me');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('INTERNAL_ERROR');
      expect(apiErr.message).toBe('Failed to fetch');
      expect(apiErr.status).toBe(0);
    }
  });

  it('should fallback to INTERNAL_ERROR when response body is not JSON', async () => {
    const badResponse = {
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: new Headers(),
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
      text: vi.fn().mockResolvedValue('<html>Bad Gateway</html>'),
      clone: vi.fn().mockReturnThis(),
    } as unknown as Response;

    mockFetch.mockResolvedValueOnce(badResponse);

    try {
      await apiClient.get('/api/v1/health');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('INTERNAL_ERROR');
      expect(apiErr.status).toBe(502);
    }
  });

  it('should handle 204 No Content response correctly', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse(204, null),
    );

    const result = await apiClient.delete('/api/v1/messages/123');

    expect(result).toBeUndefined();
  });
});

// =========================================================================
// Suite 6: HTTP methods
// =========================================================================

describe('apiClient HTTP methods', () => {
  beforeEach(() => {
    mockFetch.mockResolvedValue(
      createMockResponse(200, { data: 'ok' }),
    );
  });

  it('apiClient.get() should send GET request', async () => {
    await apiClient.get('/api/v1/users');

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/api/v1/users`);
    expect(opts.method).toBe('GET');
  });

  it('apiClient.post() should send POST request with JSON-stringified body', async () => {
    await apiClient.post('/api/v1/messages', { content: 'hello' });

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/api/v1/messages`);
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body as string)).toEqual({ content: 'hello' });
  });

  it('apiClient.patch() should send PATCH request with body', async () => {
    await apiClient.patch('/api/v1/users/me', { name: 'New Name' });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body as string)).toEqual({ name: 'New Name' });
  });

  it('apiClient.put() should send PUT request with body', async () => {
    await apiClient.put('/api/v1/keys/bundle', { bundle: {} });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body as string)).toEqual({ bundle: {} });
  });

  it('apiClient.delete() should send DELETE request', async () => {
    await apiClient.delete('/api/v1/messages/123');

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE_URL}/api/v1/messages/123`);
    expect(opts.method).toBe('DELETE');
  });

  it('apiClient.post() should omit body when body argument is undefined', async () => {
    await apiClient.post('/api/v1/action');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('POST');
    expect(opts.body).toBeUndefined();
  });
});

// =========================================================================
// Suite 7: Content-Type header
// =========================================================================

describe('Content-Type header', () => {
  it('should set Content-Type: application/json on all requests', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: 'ok' }),
    );

    await apiClient.post('/api/v1/auth/login', {
      email: 'a@b.com',
      password: 'p',
    });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should include Content-Type even for GET requests', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: 'ok' }),
    );

    await apiClient.get('/api/v1/users');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });
});

// =========================================================================
// Suite 8: Base URL configuration
// =========================================================================

describe('base URL configuration', () => {
  it('should default API_BASE_URL to http://localhost:3001', () => {
    expect(API_BASE_URL).toBe('http://localhost:3001');
  });

  it('should construct request URLs as API_BASE_URL + endpoint', async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: 'ok' }),
    );

    await apiClient.get('/api/v1/health');

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/v1/health');
  });

  it('should prepend base URL for all HTTP methods', async () => {
    mockFetch.mockResolvedValue(
      createMockResponse(200, { data: 'ok' }),
    );

    await apiClient.get('/api/v1/a');
    await apiClient.post('/api/v1/b', {});
    await apiClient.patch('/api/v1/c', {});
    await apiClient.put('/api/v1/d', {});
    await apiClient.delete('/api/v1/e');

    for (let i = 0; i < 5; i++) {
      const [url] = mockFetch.mock.calls[i] as [string, RequestInit];
      expect(url).toMatch(/^http:\/\/localhost:3001\/api\/v1\//);
    }
  });
});

// =========================================================================
// Suite 9: setTokenAccessor
// =========================================================================

describe('setTokenAccessor', () => {
  it('should register token getters/setters for auth integration', async () => {
    const customGetAccessToken = vi.fn().mockReturnValue('custom-jwt-token');
    setTokenAccessor({
      getAccessToken: customGetAccessToken,
      getRefreshToken: vi.fn().mockReturnValue(null),
      setTokens: vi.fn(),
      clearTokens: vi.fn(),
    });

    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: 'ok' }),
    );

    await apiClient.get('/api/v1/users');

    expect(customGetAccessToken).toHaveBeenCalled();

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer custom-jwt-token');
  });

  it('should allow replacing the token accessor at runtime', async () => {
    // First accessor returns token-A
    setTokenAccessor({
      getAccessToken: vi.fn().mockReturnValue('token-A'),
      getRefreshToken: vi.fn(),
      setTokens: vi.fn(),
      clearTokens: vi.fn(),
    });

    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: 'ok' }),
    );
    await apiClient.get('/api/v1/users');

    let headers = (mockFetch.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer token-A');

    // Replace with accessor returning token-B
    setTokenAccessor({
      getAccessToken: vi.fn().mockReturnValue('token-B'),
      getRefreshToken: vi.fn(),
      setTokens: vi.fn(),
      clearTokens: vi.fn(),
    });

    mockFetch.mockResolvedValueOnce(
      createMockResponse(200, { data: 'ok' }),
    );
    await apiClient.get('/api/v1/users');

    headers = (mockFetch.mock.calls[1]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer token-B');
  });
});
