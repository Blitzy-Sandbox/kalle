/**
 * @file AuthenticationError.ts
 * @description Typed domain error class for HTTP 401 authentication failures.
 *
 * Thrown by AuthService and auth middleware when:
 * - Credentials are invalid (wrong email/password)
 * - Access tokens are expired or malformed
 * - Tokens have been revoked (blacklisted in Redis)
 * - Authorization header is missing or improperly formatted
 *
 * Caught by the global error handler middleware (`middleware/error-handler.ts`)
 * which uses `instanceof AuthenticationError` to return HTTP 401 with the
 * standardized error response shape.
 *
 * Architecture Rules Enforced:
 * - R22: Standardized error response shape `{ error: { code, message, details? } }`
 * - R7:  Zero warnings under `tsc --noEmit --strict`
 * - R28: Zero `console.log` calls — structured Pino logging only
 * - R23: Log hygiene — error messages and details must NEVER contain JWT tokens,
 *         passwords, plaintext message content, encryption keys, or prekey material.
 */

import { DomainError } from './DomainError';

/**
 * Authentication error class representing HTTP 401 failures.
 *
 * Provides a fixed `code` of `'AUTHENTICATION_ERROR'` and `statusCode` of `401`,
 * ensuring consistent API response mapping via the global error handler.
 *
 * @example
 * ```typescript
 * // Invalid credentials during login:
 * throw new AuthenticationError('Invalid credentials');
 *
 * // Expired token with context:
 * throw new AuthenticationError('Token expired', { tokenType: 'access' });
 *
 * // Missing authorization header:
 * throw new AuthenticationError('Missing authorization header');
 *
 * // Revoked token (JTI is safe to include; actual token value is NOT):
 * throw new AuthenticationError('Token revoked', { jti: 'abc-123' });
 * ```
 */
export class AuthenticationError extends DomainError {
  /**
   * Creates a new AuthenticationError instance.
   *
   * @param message - Human-readable error message for the API response.
   *                  Defaults to `'Authentication failed'` when not specified.
   *                  **R23:** Must NEVER contain JWT tokens, passwords, or encryption keys.
   * @param details - Optional structured context for the error response.
   *                  Useful for indicating token type, reason codes, or non-sensitive
   *                  identifiers. **R23:** Must NEVER contain sensitive credential data.
   */
  constructor(
    message: string = 'Authentication failed',
    details?: Record<string, unknown>,
  ) {
    super(message, 'AUTHENTICATION_ERROR', 401, details);

    // Set the error name for proper stack traces and instanceof reliability.
    // This ensures Error.prototype.name reflects the specific subclass,
    // which aids debugging in structured Pino log output.
    this.name = 'AuthenticationError';
  }
}

export default AuthenticationError;
