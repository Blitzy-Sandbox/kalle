/**
 * @module @kalle/shared/types/error
 *
 * Standardized API Error Response Shape (R22)
 *
 * Defines the single consistent error response shape used by ALL API error
 * responses across the entire Kalle application. Every controller, middleware,
 * and error handler in the backend uses these types. The frontend API client
 * (`apps/web/src/lib/api.ts`) also uses these types to parse error responses.
 *
 * Rules enforced:
 * - R22: All API errors use `{ error: { code, message, details? } }` — no ad-hoc formats
 * - R23: Log hygiene — error.message and error.details MUST NOT contain JWT tokens,
 *         passwords, plaintext message content, encryption keys, or prekey material
 * - R31: Validation errors include field-level detail via ValidationErrorDetails
 *
 * This file has ZERO imports from other type files — no circular dependency risk.
 */

// ---------------------------------------------------------------------------
// Error Code String Literal Union
// ---------------------------------------------------------------------------

/**
 * Machine-readable error code type.
 *
 * Maps 1:1 to backend error classes in `apps/api/src/errors/`:
 * - `AUTHENTICATION_ERROR`    → AuthenticationError  (401)
 * - `AUTHORIZATION_ERROR`     → AuthorizationError   (403)
 * - `NOT_FOUND`               → NotFoundError        (404)
 * - `VALIDATION_ERROR`        → ValidationError      (400)
 * - `CONFLICT`                → ConflictError        (409)
 * - `PAYLOAD_TOO_LARGE`       → PayloadTooLargeError (413)
 * - `UNSUPPORTED_MEDIA_TYPE`  → UnsupportedMediaTypeError (415)
 * - `RATE_LIMIT_EXCEEDED`     → RateLimitError       (429)
 * - `INTERNAL_ERROR`          → (unexpected server errors) (500)
 * - `SERVICE_UNAVAILABLE`     → (dependency down: DB, Redis, etc.) (503)
 */
export type ErrorCode =
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMIT_EXCEEDED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

// ---------------------------------------------------------------------------
// Core Error Response Interface (R22)
// ---------------------------------------------------------------------------

/**
 * The ONE standardized error response shape for ALL API errors (R22).
 *
 * Controllers MUST NOT craft ad-hoc error responses. Every error returned by
 * the API conforms to this interface. The `error.details` field is optional and
 * carries contextual information such as field-level validation errors.
 *
 * @example
 * ```json
 * {
 *   "error": {
 *     "code": "VALIDATION_ERROR",
 *     "message": "Request validation failed",
 *     "details": {
 *       "fields": [
 *         { "field": "body.email", "message": "Invalid email format", "code": "invalid_string" }
 *       ]
 *     }
 *   }
 * }
 * ```
 *
 * SECURITY (R23): The `message` and `details` fields MUST NEVER contain:
 * - JWT tokens
 * - Passwords or password hashes
 * - Plaintext message content
 * - Encryption keys or prekey material
 */
export interface ApiErrorResponse {
  error: {
    /** Machine-readable error code from the ErrorCode union */
    code: string;
    /** Human-readable error message safe for client display */
    message: string;
    /** Optional contextual details (e.g., field-level validation errors) */
    details?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Validation Error Details (R31: Zod validation)
// ---------------------------------------------------------------------------

/**
 * Structured field-level validation error details.
 *
 * Attached to `ApiErrorResponse.error.details` when the error code is
 * `VALIDATION_ERROR`. Provides per-field error information produced by
 * Zod schema validation (R31).
 *
 * @example
 * ```json
 * {
 *   "fields": [
 *     { "field": "body.email", "message": "Invalid email address", "code": "invalid_string" },
 *     { "field": "body.password", "message": "String must contain at least 8 character(s)", "code": "too_small" }
 *   ]
 * }
 * ```
 */
export interface ValidationErrorDetails {
  /** Array of individual field validation errors */
  fields: ValidationFieldError[];
}

/**
 * A single field-level validation error.
 *
 * Represents one Zod validation issue, including the dot-notation path to
 * the offending field, a human-readable message, and the Zod error code.
 */
export interface ValidationFieldError {
  /** Dot-notation path to the invalid field (e.g., 'body.email', 'query.limit') */
  field: string;
  /** Human-readable error description for this field */
  message: string;
  /** Zod error code identifying the validation rule that failed (e.g., 'too_small', 'invalid_type', 'invalid_string') */
  code: string;
}

// ---------------------------------------------------------------------------
// HTTP Status Code Mapping
// ---------------------------------------------------------------------------

/**
 * Runtime constant mapping every `ErrorCode` to its corresponding HTTP status code.
 *
 * Used by the global error handler middleware (`apps/api/src/middleware/error-handler.ts`)
 * to translate domain errors into the correct HTTP response status.
 *
 * This is a `Record<ErrorCode, number>` ensuring compile-time completeness:
 * adding a new ErrorCode variant without updating this map produces a type error.
 */
export const HTTP_STATUS_MAP: Record<ErrorCode, number> = {
  AUTHENTICATION_ERROR: 401,
  AUTHORIZATION_ERROR: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMIT_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

// ---------------------------------------------------------------------------
// Error Response Factory Type
// ---------------------------------------------------------------------------

/**
 * Function type for constructing consistent `ApiErrorResponse` objects.
 *
 * Provides a typed signature that error handler utilities can implement to
 * guarantee every error response conforms to the R22 shape.
 *
 * @param code    - Machine-readable error code from the ErrorCode union
 * @param message - Human-readable error message (MUST NOT contain sensitive data per R23)
 * @param details - Optional contextual details (e.g., ValidationErrorDetails)
 * @returns A fully-formed ApiErrorResponse object
 */
export type ErrorResponseFactory = (
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
) => ApiErrorResponse;
