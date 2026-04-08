/**
 * @file NotFoundError.ts
 * @description Typed domain error class for HTTP 404 not found errors.
 *
 * Thrown by repositories or services when a requested resource does not exist
 * (e.g., user not found, conversation not found, message not found). The global
 * error handler middleware (`middleware/error-handler.ts`) catches this via
 * `instanceof NotFoundError` and returns an HTTP 404 response.
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
 * Domain error representing a 404 Not Found condition.
 *
 * Carries a fixed error code of `'NOT_FOUND'` and HTTP status `404`.
 * The optional `details` parameter allows callers to attach structured
 * context such as the resource type and identifier that was not found.
 *
 * @example
 * ```typescript
 * // In UserService / UserRepository:
 * throw new NotFoundError('User not found', { resource: 'User', id: userId });
 *
 * // In ConversationService:
 * throw new NotFoundError('Conversation not found', {
 *   resource: 'Conversation',
 *   id: conversationId,
 * });
 *
 * // With default message:
 * throw new NotFoundError();
 * ```
 */
export class NotFoundError extends DomainError {
  /**
   * Creates a new NotFoundError instance.
   *
   * @param message - Human-readable error message for the API response.
   *                  Defaults to `'Resource not found'` when not provided.
   * @param details - Optional structured context for the error response.
   *                  Commonly includes `{ resource: string, id: string }` to
   *                  identify which resource was not located.
   */
  constructor(
    message: string = 'Resource not found',
    details?: Record<string, unknown>,
  ) {
    super(message, 'NOT_FOUND', 404, details);

    /**
     * Override the inherited name property to `'NotFoundError'` so that
     * stack traces and error serialisation correctly identify this subclass.
     */
    this.name = 'NotFoundError';
  }
}

export default NotFoundError;
