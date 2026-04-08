/**
 * @file ConflictError.ts
 * @description Typed domain error class for HTTP 409 Conflict responses.
 *
 * Thrown by service-layer methods when an operation conflicts with existing
 * data — for example, when a user attempts to register with an email that
 * already exists, when adding a participant who is already a member of a
 * conversation, or when creating a resource that violates a uniqueness
 * constraint.
 *
 * The global error handler middleware (`middleware/error-handler.ts`) catches
 * instances of this class via `instanceof ConflictError` and responds with
 * HTTP 409 using the standardized error shape.
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
 * HTTP 409 Conflict error.
 *
 * Represents a request that could not be completed because it conflicts with
 * the current state of the target resource. Common scenarios include:
 *
 * - Duplicate email during user registration
 * - Adding a user who is already a conversation participant
 * - Creating a direct conversation that already exists between two users
 * - Any uniqueness constraint violation surfaced by the persistence layer
 *
 * Inherits `code`, `statusCode`, `details`, `message`, and `toJSON()` from
 * {@link DomainError}. The `toJSON()` method produces the R22-compliant
 * response shape consumed by the error handler middleware.
 *
 * @example
 * ```typescript
 * // Email uniqueness violation
 * throw new ConflictError('Email already registered', { field: 'email' });
 *
 * // Duplicate participant
 * throw new ConflictError('User is already a participant in this conversation', {
 *   userId: '...',
 *   conversationId: '...',
 * });
 *
 * // Default message
 * throw new ConflictError();
 * ```
 */
export class ConflictError extends DomainError {
  /**
   * Creates a new ConflictError instance.
   *
   * @param message - Human-readable description of the conflict.
   *                  Defaults to `'Resource conflict'` when omitted.
   * @param details - Optional structured context providing additional
   *                  information about the conflict (e.g. which field or
   *                  resource caused the collision). **Must never contain
   *                  sensitive data per R23.**
   */
  constructor(
    message: string = 'Resource conflict',
    details?: Record<string, unknown>,
  ) {
    super(message, 'CONFLICT', 409, details);

    // Set the error name for accurate stack traces and `instanceof` identification.
    this.name = 'ConflictError';
  }
}

export default ConflictError;
