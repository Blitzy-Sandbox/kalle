/**
 * @file DomainError.ts
 * @description Base domain error class for the entire backend application.
 *
 * All typed error subclasses (AuthenticationError, AuthorizationError, NotFoundError,
 * ValidationError, ConflictError, PayloadTooLargeError, UnsupportedMediaTypeError,
 * RateLimitError) extend this class.
 *
 * The global error handler middleware (`middleware/error-handler.ts`) uses
 * `instanceof DomainError` as the primary check to determine if an error is a
 * known domain error, then uses the `statusCode` and `code` properties to
 * construct the standardized HTTP error response.
 *
 * Architecture Rules Enforced:
 * - R22: Standardized error response shape `{ error: { code, message, details? } }`
 * - R7:  Zero warnings under `tsc --noEmit --strict`
 * - R28: Zero `console.log` calls — structured Pino logging only
 * - R23: Log hygiene — `details` and `message` must never contain JWT tokens,
 *         passwords, plaintext message content, encryption keys, or prekey material.
 *         Enforced by convention in subclasses.
 */

/**
 * Standardized error response shape returned by `toJSON()`.
 * Aligns with Rule R22 — all API errors use this single consistent shape.
 */
export interface DomainErrorJSON {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Base domain error class that all typed application errors extend.
 *
 * Provides a consistent contract for the error handler middleware:
 * - `code` — Machine-readable error code (e.g. `'AUTHENTICATION_ERROR'`, `'NOT_FOUND'`)
 * - `statusCode` — HTTP status code for response mapping (e.g. 401, 404)
 * - `details` — Optional structured context (field-level errors, resource info, etc.)
 * - `toJSON()` — Serialises the error into the R22-compliant response shape
 *
 * @example
 * ```typescript
 * // In error-handler.ts middleware:
 * if (err instanceof DomainError) {
 *   res.status(err.statusCode).json(err.toJSON());
 * }
 * ```
 */
export class DomainError extends Error {
  /**
   * Machine-readable error code matching the `ErrorCode` type from
   * `packages/shared/src/types/error.ts`.
   *
   * Examples: `'AUTHENTICATION_ERROR'`, `'NOT_FOUND'`, `'VALIDATION_ERROR'`,
   * `'CONFLICT'`, `'PAYLOAD_TOO_LARGE'`, `'UNSUPPORTED_MEDIA_TYPE'`,
   * `'RATE_LIMIT_EXCEEDED'`, `'AUTHORIZATION_ERROR'`.
   */
  public readonly code: string;

  /**
   * HTTP status code used by the error handler middleware to set the
   * response status.
   *
   * Common values: 400, 401, 403, 404, 409, 413, 415, 429.
   */
  public readonly statusCode: number;

  /**
   * Optional structured additional context attached to the error response.
   *
   * Used for field-level validation errors, resource identification in
   * not-found errors, rate-limit metadata, MIME type information, etc.
   *
   * **Log Hygiene (R23):** Must never contain JWT tokens, passwords,
   * plaintext message content, encryption keys, or prekey material.
   */
  public readonly details?: Record<string, unknown>;

  /**
   * Creates a new DomainError instance.
   *
   * @param message    - Human-readable error message for the API response
   * @param code       - Machine-readable error code (e.g. `'NOT_FOUND'`)
   * @param statusCode - HTTP status code (e.g. `404`)
   * @param details    - Optional structured context for the error response
   */
  constructor(
    message: string,
    code: string,
    statusCode: number,
    details?: Record<string, unknown>,
  ) {
    super(message);

    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.name = 'DomainError';

    // CRITICAL: Ensure proper prototype chain for instanceof checks.
    // TypeScript classes extending built-in Error lose prototype information
    // after transpilation to ES5/ES2015. Without this line, `instanceof DomainError`
    // and `instanceof <Subclass>` checks in the error handler middleware will fail.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Serialises the error into the R22-compliant standardized response shape.
   *
   * The `details` field is conditionally included only when it is defined,
   * keeping the response payload clean for errors that carry no extra context.
   *
   * @returns The standardized error response object
   *
   * @example
   * ```typescript
   * const err = new DomainError('Not found', 'NOT_FOUND', 404, { resource: 'User' });
   * // err.toJSON() =>
   * // {
   * //   error: {
   * //     code: 'NOT_FOUND',
   * //     message: 'Not found',
   * //     details: { resource: 'User' }
   * //   }
   * // }
   * ```
   */
  public toJSON(): DomainErrorJSON {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined && { details: this.details }),
      },
    };
  }
}

export default DomainError;
