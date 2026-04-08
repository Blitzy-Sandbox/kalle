/**
 * @file AuthorizationError.ts
 * @description Typed domain error class for HTTP 403 authorization failures.
 *
 * Thrown by service methods when an authenticated user lacks the required
 * permissions to perform an action. Common scenarios include:
 * - A non-admin attempting to remove a group member
 * - A user attempting to edit or delete another user's message
 * - A user attempting to modify a conversation they are not a participant of
 * - A user attempting to access resources they are blocked from
 *
 * Caught by `middleware/error-handler.ts` which uses
 * `instanceof AuthorizationError` to return HTTP 403 with the standardized
 * error response shape.
 *
 * Architecture Rules Enforced:
 * - R22: Standardized error response shape `{ error: { code, message, details? } }`
 * - R7:  Zero warnings under `tsc --noEmit --strict`
 * - R28: Zero `console.log` calls — structured Pino logging only
 * - R23: Log hygiene — `details` must never contain JWT tokens, passwords,
 *         plaintext message content, encryption keys, or prekey material.
 */

import { DomainError } from './DomainError';

/**
 * Authorization error for HTTP 403 responses.
 *
 * Represents a permission denial where the user is authenticated but does not
 * have the required access level or role to perform the requested action.
 *
 * Inherits `code`, `statusCode`, `details`, `message`, and `toJSON()` from
 * `DomainError`. The error handler middleware uses `instanceof AuthorizationError`
 * to map this to HTTP 403 status.
 *
 * @example
 * ```typescript
 * // Deny non-admin group member removal:
 * throw new AuthorizationError('Only group admins can remove members');
 *
 * // Deny message edit by non-sender with context:
 * throw new AuthorizationError('Only the sender can edit this message', {
 *   messageId: 'msg-123',
 *   senderId: 'user-456',
 * });
 *
 * // Use default message:
 * throw new AuthorizationError();
 * ```
 */
export class AuthorizationError extends DomainError {
  /**
   * Creates a new AuthorizationError instance.
   *
   * @param message - Human-readable error message describing the permission denial.
   *                  Defaults to `'Insufficient permissions'` when not provided.
   * @param details - Optional structured context for the error response.
   *                  May include resource identifiers, required roles, or other
   *                  non-sensitive metadata to aid debugging.
   *                  **Must never contain** JWT tokens, passwords, plaintext message
   *                  content, encryption keys, or prekey material (R23).
   */
  constructor(
    message: string = 'Insufficient permissions',
    details?: Record<string, unknown>,
  ) {
    super(message, 'AUTHORIZATION_ERROR', 403, details);

    // Override the name property for accurate stack traces and instanceof
    // identification in error logging and monitoring systems.
    this.name = 'AuthorizationError';
  }
}

export default AuthorizationError;
