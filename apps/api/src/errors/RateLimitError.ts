/**
 * @file RateLimitError.ts
 * @description Typed domain error class for HTTP 429 rate limit exceeded errors.
 *
 * Thrown by:
 * - HTTP rate limiter middleware (`middleware/rate-limiter.ts`) when a client
 *   exceeds the configured request rate.
 * - WebSocket rate limiter middleware (`websocket/middleware/ws-rate-limiter.ts`)
 *   when a connection exceeds per-event rate limits per Rule R25:
 *     • message:send — max 30/min
 *     • typing:start — max 10/min
 *     • all others   — max 60/min
 *
 * Caught by `middleware/error-handler.ts` which uses `instanceof RateLimitError`
 * to return HTTP 429. For WebSocket connections, exceeding the rate limit
 * disconnects the client with a rate-limit error code.
 *
 * Architecture Rules Enforced:
 * - R25: WebSocket rate limiting — structured error for both HTTP and WS contexts
 * - R22: Standardized error response shape `{ error: { code, message, details? } }`
 * - R7:  Zero warnings under `tsc --noEmit --strict`
 * - R28: Zero `console.log` calls — structured Pino logging only
 * - R23: Log hygiene — `details` must never contain JWT tokens, passwords,
 *         plaintext message content, encryption keys, or prekey material
 */

import { DomainError } from './DomainError';

/**
 * Domain error representing a 429 Too Many Requests response.
 *
 * Encapsulates rate limit context (retry-after interval, limit value,
 * time window, and event type) in the optional `details` property so that
 * consumers — including the HTTP error handler and WebSocket disconnect
 * logic — can convey actionable information to clients.
 *
 * @example
 * ```typescript
 * // HTTP rate limiter:
 * throw new RateLimitError('Too many requests', { retryAfter: 60 });
 *
 * // WebSocket rate limiter (message events):
 * throw new RateLimitError('WebSocket rate limit exceeded', {
 *   eventType: 'message:send',
 *   limit: 30,
 *   window: '1m',
 * });
 *
 * // WebSocket rate limiter (typing events):
 * throw new RateLimitError('Typing event rate limit exceeded', {
 *   eventType: 'typing:start',
 *   limit: 10,
 *   window: '1m',
 * });
 * ```
 */
export class RateLimitError extends DomainError {
  /**
   * Creates a new RateLimitError instance.
   *
   * @param message - Human-readable description of the rate limit violation.
   *                  Defaults to `'Rate limit exceeded'`.
   * @param details - Optional structured context for the error response.
   *                  Typical keys: `retryAfter` (seconds until the client may
   *                  retry), `limit` (max allowed requests/events in the
   *                  window), `window` (rate limit time window, e.g. `'1m'`),
   *                  `eventType` (WebSocket event name that was rate-limited).
   */
  constructor(
    message: string = 'Rate limit exceeded',
    details?: Record<string, unknown>,
  ) {
    super(message, 'RATE_LIMIT_EXCEEDED', 429, details);

    // Set the error name for accurate stack traces and debugging.
    // This ensures `error.name` reads 'RateLimitError' rather than
    // the parent class name in stack traces and serialized output.
    this.name = 'RateLimitError';
  }
}

export default RateLimitError;
