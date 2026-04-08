/**
 * @file ValidationError.ts
 * @description Typed domain error class for HTTP 400 input validation failures.
 *
 * Thrown by the validation middleware (`middleware/validation.ts`) when Zod schema
 * validation fails on request body, query params, or path params per Rule R31.
 * Also thrown by services for business logic validation failures (e.g. message
 * edit window expiration).
 *
 * Caught by `middleware/error-handler.ts` which uses `instanceof ValidationError`
 * to return HTTP 400 with field-level validation details in the standardized
 * R22-compliant error response shape.
 *
 * Architecture Rules Enforced:
 * - R22: Standardized error response shape `{ error: { code, message, details? } }`
 * - R31: Field-level Zod validation errors carried in the `details` property
 * - R7:  Zero warnings under `tsc --noEmit --strict`
 * - R28: Zero `console.log` calls — structured Pino logging only
 * - R23: Log hygiene — `details` must never contain JWT tokens, passwords,
 *         plaintext message content, encryption keys, or prekey material.
 *
 * @example
 * ```typescript
 * // In validation middleware (wrapping Zod errors):
 * const zodResult = schema.safeParse(req.body);
 * if (!zodResult.success) {
 *   const fields = zodResult.error.issues.map(issue => ({
 *     field: issue.path.join('.'),
 *     message: issue.message,
 *     code: issue.code,
 *   }));
 *   throw new ValidationError('Validation failed', { fields });
 * }
 *
 * // In service layer (business logic validation):
 * throw new ValidationError('Message edit window expired', {
 *   fields: [{
 *     field: 'messageId',
 *     message: 'Message can only be edited within 15 minutes',
 *     code: 'edit_window_expired',
 *   }],
 * });
 * ```
 */

import { DomainError } from './DomainError';

/**
 * Domain error class representing HTTP 400 Bad Request — input validation failure.
 *
 * Extends `DomainError` with a fixed error code of `'VALIDATION_ERROR'` and HTTP
 * status code `400`. The optional `details` parameter is specifically designed to
 * carry field-level validation error structures produced by Zod `safeParse` failures,
 * aligning with the `ValidationErrorDetails` contract from `packages/shared/src/types/error.ts`.
 *
 * The `details.fields` array provides consumers with:
 * - `field`   — Dot-notated path to the invalid field (e.g. `'body.email'`)
 * - `message` — Human-readable description of the validation failure
 * - `code`    — Machine-readable Zod issue code (e.g. `'invalid_string'`, `'too_small'`)
 *
 * @example
 * ```typescript
 * throw new ValidationError('Validation failed', {
 *   fields: [
 *     { field: 'body.email', message: 'Invalid email format', code: 'invalid_string' },
 *     { field: 'body.password', message: 'String must contain at least 8 character(s)', code: 'too_small' },
 *   ],
 * });
 * ```
 */
export class ValidationError extends DomainError {
  /**
   * Creates a new ValidationError instance.
   *
   * @param message - Human-readable summary of the validation failure.
   *                  Defaults to `'Validation failed'` when omitted.
   * @param details - Optional structured context carrying field-level validation
   *                  errors. Typically contains a `fields` array with objects
   *                  having `field`, `message`, and `code` properties produced
   *                  by mapping Zod issue objects.
   */
  constructor(
    message: string = 'Validation failed',
    details?: Record<string, unknown>,
  ) {
    super(message, 'VALIDATION_ERROR', 400, details);

    /**
     * Override the error name for accurate identification in stack traces
     * and `instanceof` diagnostics. Without this, stack traces would show
     * the base class name `DomainError` instead of `ValidationError`.
     */
    this.name = 'ValidationError';
  }
}

export default ValidationError;
