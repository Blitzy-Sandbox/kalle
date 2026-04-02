/**
 * @file PayloadTooLargeError.ts
 * @description Typed domain error class for HTTP 413 Payload Too Large responses.
 *
 * Thrown by MediaService when an uploaded file exceeds the maximum allowed size
 * (25 MB per Rule R8). The global error handler middleware
 * (`middleware/error-handler.ts`) catches this via `instanceof DomainError` and
 * maps the `statusCode` (413) to the HTTP response status, returning the
 * R22-compliant standardized error shape.
 *
 * Architecture Rules Enforced:
 * - R8:  25 MB size limit enforced server-side — this class represents the 413 case.
 * - R22: Standardized error response shape `{ error: { code, message, details? } }`.
 * - R7:  Zero warnings under `tsc --noEmit --strict`.
 * - R28: Zero `console.log` calls — structured Pino logging only.
 * - R23: Log hygiene — `details` must never contain JWT tokens, passwords,
 *         plaintext message content, encryption keys, or prekey material.
 */

import { DomainError } from './DomainError';

/**
 * Represents an HTTP 413 Payload Too Large error.
 *
 * Thrown when a client attempts to upload a file that exceeds the server-enforced
 * maximum file size of 25 MB (26 214 400 bytes). The `details` parameter can
 * carry structured context such as the maximum allowed size, the actual size
 * of the rejected payload, and the original file name.
 *
 * @example
 * ```typescript
 * // In MediaService — upload validation:
 * if (file.size > MAX_FILE_SIZE) {
 *   throw new PayloadTooLargeError('File size exceeds the 25MB limit', {
 *     maxSize: MAX_FILE_SIZE,
 *     actualSize: file.size,
 *     fileName: file.originalname,
 *   });
 * }
 * ```
 */
export class PayloadTooLargeError extends DomainError {
  /**
   * Creates a new PayloadTooLargeError instance.
   *
   * @param message - Human-readable error message. Defaults to a message
   *                  referencing the 25 MB limit per Rule R8.
   * @param details - Optional structured context for the error response
   *                  (e.g. `{ maxSize, actualSize, fileName }`).
   *                  **R23:** Must never contain sensitive data.
   */
  constructor(
    message: string = 'File size exceeds the 25MB limit',
    details?: Record<string, unknown>,
  ) {
    super(message, 'PAYLOAD_TOO_LARGE', 413, details);

    // Override the inherited name for accurate stack traces and
    // human-readable identification in logs.
    this.name = 'PayloadTooLargeError';
  }
}

export default PayloadTooLargeError;
