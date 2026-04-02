/**
 * @module apps/api/src/config/cors.ts
 * @description CORS Configuration Factory
 *
 * Parses a comma-separated list of allowed origins (typically sourced from the
 * CORS_ORIGIN environment variable) and returns a fully configured
 * `CorsOptions` object consumed by the Express `cors` middleware.
 *
 * This module is a **pure configuration factory** — it does not read
 * `process.env` directly. The composition root (`server.ts`) validates the
 * environment via `config/env.ts` and passes the resulting `CORS_ORIGIN`
 * string here.
 *
 * Architecture rules enforced:
 * - Rule R38 (Zero External Dependencies): default origin is
 *   `http://localhost:3000` for Docker development — no cloud accounts needed.
 * - Rule R28 (Structured Logging Only): zero `console.log` calls.
 * - Rule R7  (Zero Warnings Build): compiles under `tsc --noEmit --strict`
 *   with zero warnings.
 * - Rule R29 (Correlation ID Propagation): `X-Correlation-ID` is included in
 *   both `allowedHeaders` and `exposedHeaders`.
 * - Rule R9  (Authentication on All Protected Routes): `Authorization` header
 *   is listed in `allowedHeaders` for JWT bearer tokens.
 */

import type { CorsOptions } from 'cors';

/**
 * Default origin used when no `corsOrigin` argument is provided.
 * Matches the frontend Docker Compose service port (AAP §0.4.6).
 */
const DEFAULT_ORIGIN = 'http://localhost:3000';

/**
 * Preflight response cache duration in seconds.
 * 86 400 s = 24 hours — minimises OPTIONS round-trips from the browser.
 */
const PREFLIGHT_MAX_AGE_SECONDS = 86400;

/**
 * HTTP methods permitted by the REST API.
 * Includes every verb used across all `/api/v1/*` route definitions.
 */
const ALLOWED_METHODS: string[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
];

/**
 * Request headers the server accepts from cross-origin callers.
 *
 * - `Content-Type`      — standard JSON body indicator
 * - `Authorization`     — JWT bearer token (Rule R9)
 * - `X-Correlation-ID`  — client-supplied correlation ID (Rule R29)
 * - `X-Requested-With`  — XHR indicator for legacy compatibility
 */
const ALLOWED_HEADERS: string[] = [
  'Content-Type',
  'Authorization',
  'X-Correlation-ID',
  'X-Requested-With',
];

/**
 * Response headers exposed to the browser (readable via JS).
 *
 * - `X-Correlation-ID` — allows the frontend to read the server-assigned
 *   correlation ID from every response (Rule R29).
 */
const EXPOSED_HEADERS: string[] = ['X-Correlation-ID'];

/**
 * Builds a `CorsOptions` configuration object from a raw origin string.
 *
 * @param corsOrigin - Comma-separated list of allowed origins
 *   (e.g. `"http://localhost:3000"` or
 *   `"http://localhost:3000, http://localhost:3001"`).
 *   When `undefined`, empty, or blank, falls back to {@link DEFAULT_ORIGIN}.
 * @returns A fully populated `CorsOptions` object ready for the Express
 *   `cors()` middleware.
 *
 * @example
 * ```ts
 * // Single origin (default Docker dev)
 * const opts = getCorsOptions();
 * // opts.origin === 'http://localhost:3000'
 *
 * // Multiple origins from env
 * const opts = getCorsOptions('http://localhost:3000, http://localhost:4000');
 * // opts.origin === ['http://localhost:3000', 'http://localhost:4000']
 * ```
 */
export function getCorsOptions(corsOrigin?: string): CorsOptions {
  // ---------------------------------------------------------------------------
  // 1. Parse comma-separated origins — trim whitespace, discard empties.
  // ---------------------------------------------------------------------------
  const origins: string[] = corsOrigin
    ? corsOrigin
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : [];

  // Fall back to the default when no valid origins were resolved.
  if (origins.length === 0) {
    origins.push(DEFAULT_ORIGIN);
  }

  // ---------------------------------------------------------------------------
  // 2. Build and return the CorsOptions object.
  // ---------------------------------------------------------------------------
  return {
    /**
     * When a single origin is configured, pass it as a string for a marginal
     * efficiency gain (avoids array iteration inside the cors middleware).
     * When multiple origins are present, pass the array so the middleware
     * checks each incoming `Origin` header against all entries.
     */
    origin: origins.length === 1 ? origins[0] : origins,

    /**
     * Required for JWT-based authentication: the browser must include
     * credentials (cookies / Authorization header) in cross-origin requests.
     */
    credentials: true,

    /** All HTTP methods used across the v1 REST API. */
    methods: ALLOWED_METHODS,

    /** Headers the server accepts on cross-origin requests. */
    allowedHeaders: ALLOWED_HEADERS,

    /** Headers exposed to JavaScript running in the browser. */
    exposedHeaders: EXPOSED_HEADERS,

    /**
     * 24-hour preflight cache — browsers may reuse the preflight response
     * for up to this many seconds without issuing another OPTIONS request.
     */
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  };
}
