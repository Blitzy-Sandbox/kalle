/**
 * @module apps/web/src/lib/api
 *
 * Fetch-based REST API client with JWT authentication interceptors.
 *
 * Provides a configured REST API client using the Fetch API with:
 * - Automatic JWT access token attachment on every request (R9)
 * - Token refresh interceptor on 401 responses with single-flight dedup
 * - Standardized error handling matching backend shape (R22)
 * - Correlation ID propagation via X-Correlation-ID header (R29)
 * - All requests target /api/v1/ endpoints (R30)
 * - Multipart upload support with progress tracking via XMLHttpRequest
 *
 * Token accessor pattern avoids circular imports with authStore:
 * authStore registers its getAccessToken/getRefreshToken/setTokens/clearTokens
 * callbacks via setTokenAccessor() during app initialization.
 *
 * @see AAP Section 0.2.3 — REST API client with auth interceptors
 * @see AAP Section 0.7.1 Group 16 — Fetch wrapper with JWT auth headers
 * @see R9   — Authentication on all protected routes
 * @see R22  — Standardized error responses
 * @see R29  — Correlation ID propagation
 * @see R30  — API versioning (/api/v1/)
 * @see R38  — Zero external dependencies (localhost default)
 */

import type { ApiErrorResponse, TokenPair } from '@kalle/shared';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Base URL for all API requests.
 *
 * Sourced from the NEXT_PUBLIC_API_URL environment variable with a fallback
 * to http://localhost:3001 for local Docker development (R38).
 */
export const API_BASE_URL: string =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Custom Error Class (R22)
// ---------------------------------------------------------------------------

/**
 * Custom error class mirroring the backend standardized error response shape.
 *
 * Every API error is parsed into this class, providing machine-readable `code`,
 * human-readable `message`, HTTP `status`, and optional `details` (e.g.,
 * field-level validation errors from Zod).
 *
 * @example
 * ```typescript
 * try {
 *   await apiClient.post('/api/v1/auth/register', payload);
 * } catch (err) {
 *   if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
 *     // Access field-level errors via err.details
 *   }
 * }
 * ```
 */
export class ApiError extends Error {
  /** Machine-readable error code (e.g., 'AUTHENTICATION_ERROR', 'VALIDATION_ERROR') */
  public readonly code: string;

  /** HTTP status code of the failed response */
  public readonly status: number;

  /** Optional contextual details (e.g., field-level validation errors) */
  public readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Token Accessor Interface
// ---------------------------------------------------------------------------

/**
 * Interface for token management callbacks registered by authStore.
 *
 * This indirection avoids circular imports between api.ts and authStore.ts.
 * The auth store calls setTokenAccessor() once during initialization to
 * register these callbacks.
 */
interface TokenAccessor {
  /** Returns the current JWT access token, or null if not authenticated */
  getAccessToken: () => string | null;
  /** Returns the current refresh token, or null if not authenticated */
  getRefreshToken: () => string | null;
  /** Persists a new token pair after successful refresh */
  setTokens: (tokens: TokenPair) => void;
  /** Clears all stored tokens (forces logout) */
  clearTokens: () => void;
}

/** Module-level reference to the registered token accessor */
let tokenAccessor: TokenAccessor | null = null;

/**
 * Registers token management callbacks from the auth store.
 *
 * Must be called once during application initialization before any
 * authenticated API requests are made. This wires the API client to the
 * auth store without creating circular module dependencies.
 *
 * @param accessor - Object providing token read/write callbacks
 */
export function setTokenAccessor(accessor: TokenAccessor): void {
  tokenAccessor = accessor;
}

// ---------------------------------------------------------------------------
// Correlation ID Generation (R29)
// ---------------------------------------------------------------------------

/**
 * Generates a UUID v4 correlation ID for request tracing.
 *
 * Uses the Web Crypto API's randomUUID() when available (modern browsers),
 * falling back to a Math.random()-based implementation for older environments.
 *
 * Every API request includes this as the X-Correlation-ID header (R29).
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

// ---------------------------------------------------------------------------
// Token Refresh State Management
// ---------------------------------------------------------------------------

/**
 * Whether a token refresh is currently in-flight.
 * Prevents multiple concurrent refresh attempts when multiple 401s arrive.
 */
let isRefreshing = false;

/**
 * Shared promise for the in-flight refresh request.
 * Multiple callers awaiting refresh receive the same resolved value.
 */
let refreshPromise: Promise<TokenPair> | null = null;

/**
 * Refreshes the JWT access token using the stored refresh token.
 *
 * Uses raw fetch (NOT the `request()` function) to avoid infinite loops.
 * Implements single-flight deduplication: if a refresh is already in progress,
 * returns the existing promise instead of issuing a duplicate request.
 *
 * On success, persists the new token pair via the token accessor.
 * On failure, clears all tokens to force re-authentication.
 *
 * @returns The new TokenPair containing fresh access and refresh tokens
 * @throws {ApiError} If refresh fails or no refresh token is available
 */
async function refreshAccessToken(): Promise<TokenPair> {
  if (isRefreshing && refreshPromise) {
    return refreshPromise;
  }

  isRefreshing = true;

  refreshPromise = (async (): Promise<TokenPair> => {
    try {
      const currentRefreshToken = tokenAccessor?.getRefreshToken();
      if (!currentRefreshToken) {
        tokenAccessor?.clearTokens();
        throw new ApiError(
          'AUTHENTICATION_ERROR',
          'No refresh token available',
          401,
        );
      }

      const response = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-ID': generateCorrelationId(),
        },
        body: JSON.stringify({ refreshToken: currentRefreshToken }),
      });

      if (!response.ok) {
        const errorBody: ApiErrorResponse | null = await response
          .json()
          .catch(() => null) as ApiErrorResponse | null;
        tokenAccessor?.clearTokens();
        throw new ApiError(
          errorBody?.error?.code ?? 'AUTHENTICATION_ERROR',
          errorBody?.error?.message ?? 'Token refresh failed',
          response.status,
          errorBody?.error?.details,
        );
      }

      // Response follows ApiResponse shape: { data: { tokens: TokenPair } }
      const json = (await response.json()) as {
        data: { tokens: TokenPair };
      };
      const newTokens: TokenPair = json.data.tokens;

      // Verify essential fields are present before persisting
      if (!newTokens.accessToken || !newTokens.refreshToken) {
        tokenAccessor?.clearTokens();
        throw new ApiError(
          'INTERNAL_ERROR',
          'Invalid token pair received from refresh endpoint',
          500,
        );
      }

      tokenAccessor?.setTokens(newTokens);
      return newTokens;
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// ---------------------------------------------------------------------------
// Header Utilities
// ---------------------------------------------------------------------------

/**
 * Merges incoming HeadersInit (Headers object, array, or record) into
 * a mutable string record used as the base headers for a request.
 *
 * @param base     - Mutable base header record to merge into
 * @param incoming - Optional HeadersInit from caller RequestInit
 * @returns The mutated base record with merged headers
 */
function mergeHeaders(
  base: Record<string, string>,
  incoming?: HeadersInit,
): Record<string, string> {
  if (!incoming) {
    return base;
  }
  if (incoming instanceof Headers) {
    incoming.forEach((value, key) => {
      base[key] = value;
    });
  } else if (Array.isArray(incoming)) {
    for (const [key, value] of incoming) {
      base[key] = value;
    }
  } else {
    Object.assign(base, incoming);
  }
  return base;
}

// ---------------------------------------------------------------------------
// Core Request Function
// ---------------------------------------------------------------------------

/**
 * Executes an HTTP request with automatic JWT attachment and error handling.
 *
 * This is the internal workhorse for all API calls. It:
 * 1. Constructs the full URL from API_BASE_URL + endpoint
 * 2. Sets Content-Type: application/json and X-Correlation-ID headers
 * 3. Attaches Authorization: Bearer <token> when a token is available (R9)
 * 4. Handles successful responses by extracting the `data` field
 * 5. On 401: attempts one token refresh then retries the original request
 * 6. On other errors: parses the ApiErrorResponse body and throws ApiError
 *
 * @typeParam T - Expected type of the response payload (unwrapped from `data`)
 * @param endpoint - API endpoint path (e.g., '/api/v1/users/me')
 * @param options  - Standard RequestInit options (method, body, headers, etc.)
 * @param isRetry  - Internal flag preventing infinite retry loops
 * @returns The parsed response payload of type T
 * @throws {ApiError} On HTTP errors, network failures, or invalid responses
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {},
  isRetry = false,
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  // Build base headers with correlation ID (R29) and JSON content type
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Correlation-ID': generateCorrelationId(),
  };

  // Merge any caller-provided headers (preserves Content-Type overrides)
  mergeHeaders(headers, options.headers);

  // Attach JWT auth header when token is available (R9)
  const accessToken = tokenAccessor?.getAccessToken();
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  // Execute the fetch request with merged configuration
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (networkError: unknown) {
    // Network-level failures (offline, DNS, CORS preflight, etc.)
    const errorMessage =
      networkError instanceof Error
        ? networkError.message
        : 'Network request failed';
    throw new ApiError('INTERNAL_ERROR', errorMessage, 0);
  }

  // Handle successful responses (2xx)
  if (response.ok) {
    // 204 No Content has no body to parse
    if (response.status === 204) {
      return undefined as T;
    }
    const json = (await response.json()) as { data: T };
    return json.data;
  }

  // Handle 401 Unauthorized — attempt token refresh (once only)
  if (response.status === 401 && !isRetry && tokenAccessor) {
    try {
      await refreshAccessToken();
      return request<T>(endpoint, options, true);
    } catch {
      // Refresh failed — fall through to throw the original 401 error
    }
  }

  // Parse error body matching standardized ApiErrorResponse shape (R22)
  const errorBody: ApiErrorResponse | null = await response
    .json()
    .catch(() => null) as ApiErrorResponse | null;

  throw new ApiError(
    errorBody?.error?.code ?? 'INTERNAL_ERROR',
    errorBody?.error?.message ?? `Request failed with status ${response.status}`,
    response.status,
    errorBody?.error?.details,
  );
}

// ---------------------------------------------------------------------------
// HTTP Method Convenience Functions
// ---------------------------------------------------------------------------

/**
 * Pre-configured API client with typed HTTP method helpers.
 *
 * All methods target /api/v1/ endpoints (R30) and automatically handle:
 * - JWT token attachment (R9)
 * - Correlation ID headers (R29)
 * - Token refresh on 401
 * - Standardized error parsing (R22)
 *
 * @example
 * ```typescript
 * // GET request
 * const user = await apiClient.get<UserResponse>('/api/v1/users/me');
 *
 * // POST with body
 * const result = await apiClient.post<AuthResponse>('/api/v1/auth/login', {
 *   email: 'user@example.com',
 *   password: 'secret',
 * });
 *
 * // DELETE
 * await apiClient.delete<void>('/api/v1/conversations/123');
 * ```
 */
export const apiClient = {
  /**
   * Sends an HTTP GET request.
   * @typeParam T - Expected response payload type
   * @param endpoint - API endpoint path
   * @param options  - Optional RequestInit overrides
   */
  get<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return request<T>(endpoint, { method: 'GET', ...options });
  },

  /**
   * Sends an HTTP POST request with a JSON body.
   * @typeParam T - Expected response payload type
   * @param endpoint - API endpoint path
   * @param body     - Request payload (will be JSON.stringify'd)
   * @param options  - Optional RequestInit overrides
   */
  post<T>(endpoint: string, body?: unknown, options?: RequestInit): Promise<T> {
    return request<T>(endpoint, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...options,
    });
  },

  /**
   * Sends an HTTP PATCH request with a JSON body.
   * @typeParam T - Expected response payload type
   * @param endpoint - API endpoint path
   * @param body     - Partial update payload (will be JSON.stringify'd)
   * @param options  - Optional RequestInit overrides
   */
  patch<T>(
    endpoint: string,
    body?: unknown,
    options?: RequestInit,
  ): Promise<T> {
    return request<T>(endpoint, {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...options,
    });
  },

  /**
   * Sends an HTTP PUT request with a JSON body.
   * @typeParam T - Expected response payload type
   * @param endpoint - API endpoint path
   * @param body     - Full replacement payload (will be JSON.stringify'd)
   * @param options  - Optional RequestInit overrides
   */
  put<T>(endpoint: string, body?: unknown, options?: RequestInit): Promise<T> {
    return request<T>(endpoint, {
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...options,
    });
  },

  /**
   * Sends an HTTP DELETE request.
   * @typeParam T - Expected response payload type
   * @param endpoint - API endpoint path
   * @param options  - Optional RequestInit overrides
   */
  delete<T>(endpoint: string, options?: RequestInit): Promise<T> {
    return request<T>(endpoint, { method: 'DELETE', ...options });
  },
};

// ---------------------------------------------------------------------------
// Multipart Upload with Progress Tracking
// ---------------------------------------------------------------------------

/**
 * Uploads multipart form data with optional progress tracking.
 *
 * Uses XMLHttpRequest instead of fetch to access upload progress events,
 * which are not available in the Fetch API. This is required for media
 * uploads (R8, R27) where progress feedback improves UX.
 *
 * Automatically attaches:
 * - Authorization header with JWT access token (R9)
 * - X-Correlation-ID header (R29)
 * - Content-Type is NOT set — the browser adds the correct multipart
 *   boundary automatically
 *
 * Response bodies are parsed using the same ApiResponse<T> / ApiErrorResponse
 * shapes as the fetch-based methods.
 *
 * @typeParam T - Expected response payload type (unwrapped from `data`)
 * @param endpoint - API endpoint path (e.g., '/api/v1/media/upload')
 * @param formData - FormData instance containing files and metadata
 * @param options  - Optional configuration with progress callback
 * @returns The parsed response payload of type T
 * @throws {ApiError} On HTTP errors, network failures, or aborted uploads
 *
 * @example
 * ```typescript
 * const form = new FormData();
 * form.append('file', encryptedBlob, 'image.enc');
 * form.append('mimeType', 'image/jpeg');
 *
 * const media = await uploadFormData<MediaResponse>(
 *   '/api/v1/media/upload',
 *   form,
 *   { onProgress: (pct) => setProgress(pct) },
 * );
 * ```
 */
export function uploadFormData<T>(
  endpoint: string,
  formData: FormData,
  options?: { onProgress?: (percent: number) => void },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `${API_BASE_URL}${endpoint}`;

    xhr.open('POST', url);

    // Attach JWT auth header (R9)
    const accessToken = tokenAccessor?.getAccessToken();
    if (accessToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
    }

    // Attach correlation ID for request tracing (R29)
    xhr.setRequestHeader('X-Correlation-ID', generateCorrelationId());

    // Content-Type is intentionally NOT set — the browser sets the correct
    // multipart/form-data boundary automatically when sending FormData

    // Wire up progress tracking if callback is provided
    if (options?.onProgress) {
      const progressCallback = options.onProgress;
      xhr.upload.addEventListener('progress', (event: ProgressEvent) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          progressCallback(percent);
        }
      });
    }

    // Handle completed request (success or HTTP error)
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const json = JSON.parse(xhr.responseText) as { data: T };
          resolve(json.data);
        } catch {
          reject(
            new ApiError(
              'INTERNAL_ERROR',
              'Invalid JSON response from upload endpoint',
              xhr.status,
            ),
          );
        }
      } else {
        try {
          const errorBody = JSON.parse(
            xhr.responseText,
          ) as ApiErrorResponse;
          reject(
            new ApiError(
              errorBody.error.code,
              errorBody.error.message,
              xhr.status,
              errorBody.error.details,
            ),
          );
        } catch {
          reject(
            new ApiError(
              'INTERNAL_ERROR',
              `Upload failed with status ${xhr.status}`,
              xhr.status,
            ),
          );
        }
      }
    });

    // Handle network-level errors (offline, CORS, etc.)
    xhr.addEventListener('error', () => {
      reject(
        new ApiError('INTERNAL_ERROR', 'Network error during upload', 0),
      );
    });

    // Handle user-initiated or programmatic abort
    xhr.addEventListener('abort', () => {
      reject(new ApiError('INTERNAL_ERROR', 'Upload was aborted', 0));
    });

    // Send the form data
    xhr.send(formData);
  });
}
