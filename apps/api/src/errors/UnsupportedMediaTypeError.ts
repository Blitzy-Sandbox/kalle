/**
 * @file UnsupportedMediaTypeError.ts
 * @description Typed domain error class for HTTP 415 Unsupported Media Type responses.
 *
 * Thrown by MediaService when an uploaded file's declared MIME type is not present
 * in the server-side `ALLOWED_MIME_TYPES` allowlist (per Rule R8). The global error
 * handler middleware (`middleware/error-handler.ts`) catches this via
 * `instanceof UnsupportedMediaTypeError` and maps it to an HTTP 415 response with
 * the R22-compliant standardized error shape.
 *
 * Architecture Rules Enforced:
 * - R8:  Server verifies declared MIME type against allowlist — rejects with 415.
 * - R22: Standardized error response shape `{ error: { code, message, details? } }`.
 * - R7:  Zero warnings under `tsc --noEmit --strict`.
 * - R28: Zero `console.log` calls — structured Pino logging only.
 * - R23: Log hygiene — `details` must never contain JWT tokens, passwords,
 *         plaintext message content, encryption keys, or prekey material.
 */

import { DomainError } from './DomainError';

/**
 * Domain error representing an HTTP 415 Unsupported Media Type failure.
 *
 * This error is raised when a client uploads a file whose MIME type is not
 * in the server's allowed MIME type list. The `details` property can carry
 * contextual information such as the rejected MIME type and the full list
 * of allowed types, enabling callers to construct actionable error messages.
 *
 * @example
 * ```typescript
 * throw new UnsupportedMediaTypeError('MIME type not allowed', {
 *   mimeType: 'application/exe',
 *   allowedTypes: ['image/jpeg', 'image/png', 'application/pdf'],
 * });
 * ```
 */
export class UnsupportedMediaTypeError extends DomainError {
  /**
   * Creates a new UnsupportedMediaTypeError instance.
   *
   * @param message - Human-readable error message for the API response.
   *                  Defaults to `'Unsupported media type'` when not provided.
   * @param details - Optional structured context for the error response.
   *                  Typically includes the rejected `mimeType` and the
   *                  `allowedTypes` list so clients can display actionable
   *                  feedback. Must comply with R23 log hygiene rules.
   */
  constructor(
    message: string = 'Unsupported media type',
    details?: Record<string, unknown>,
  ) {
    super(message, 'UNSUPPORTED_MEDIA_TYPE', 415, details);

    this.name = 'UnsupportedMediaTypeError';
  }
}

export default UnsupportedMediaTypeError;
