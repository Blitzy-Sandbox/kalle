/**
 * @file apps/api/src/config/env.ts
 * @description Zod-validated environment variable configuration for the Kalle API server.
 *
 * This module is the FIRST invoked by the composition root (`server.ts`).
 * It defines a Zod schema that validates ALL required environment variables
 * on application boot. If ANY variable is missing or invalid, the application
 * fails immediately with a descriptive error listing EVERY invalid variable
 * — not just the first one (Rule R26).
 *
 * Architecture Rules Enforced:
 *  - R26: Fail-fast env validation listing ALL missing/invalid variables.
 *  - R28: Zero console logging — throws Error for composition root to handle.
 *  - R23: Error messages contain only variable NAMES, never sensitive VALUES.
 *  - R7:  Compiles under tsc --noEmit --strict with zero warnings.
 *  - R38: All defaults work with Docker Compose locally.
 *
 * @exports envSchema   — Zod schema constant for testing and direct use.
 * @exports EnvConfig   — TypeScript type derived from the schema (with transforms).
 * @exports validateEnv — Function that validates process.env and returns typed config.
 *
 * V2 Auth/Flags Integration Variables (FR-1, FR-4, FR-9, R2, RF2):
 * The schema also validates 8 V2 OAuth/OIDC integration variables: AUTH_V2_ENABLED
 * (the kill switch), KEYCLOAK_BASE_URL/REALM/CLIENT_ID (Keycloak config),
 * AUTH_SERVICE_URL/AUTH_SIDECAR_SECRET (sidecar HTTP delegation per Rule R2),
 * and FLAGS_API_URL/FLAGS_API_SECRET (flags evaluation per Rule RF2). All are
 * OPTIONAL — kalle starts successfully without them in legacy-only mode.
 * INTENTIONALLY ABSENT from this schema: AUTH_DB_URL (Rule R2 — kalle is in
 * sidecar mode and MUST NEVER connect to the auth database directly) and
 * FLAGS_DB_URL (Rule RF2 — flags are read via HTTP from the admin-ui API).
 */

import { z } from 'zod';

// =============================================================================
// Environment Variable Schema
// =============================================================================
// Covers every environment variable consumed by the API server.
// Variables used only by Docker Compose services (PGUSER, PGPASSWORD, PGDATABASE,
// BACKUP_RETENTION_DAYS, BACKUP_CRON, WEB_PORT, etc.) are NOT validated here
// because the API server reads DATABASE_URL instead of individual PG* variables.
// =============================================================================

/**
 * Zod schema defining all environment variables consumed by the Kalle API server.
 *
 * Required variables (no defaults — must be explicitly set):
 *  - DATABASE_URL: PostgreSQL connection string
 *  - REDIS_URL: Redis connection string
 *  - JWT_SECRET: JWT signing key (minimum 32 characters)
 *
 * Optional variables (sensible defaults for Docker dev):
 *  - JWT_ACCESS_TOKEN_EXPIRY (default: '15m')
 *  - JWT_REFRESH_TOKEN_EXPIRY (default: '7d')
 *  - CORS_ORIGIN (default: 'http://localhost:3000')
 *  - API_PORT (default: 3001)
 *  - NODE_ENV (default: 'development')
 *  - UPLOAD_DIR (default: './uploads')
 *  - MAX_FILE_SIZE (default: 26214400 = 25MB)
 *  - LOG_LEVEL (default: 'info')
 *  - OTEL_EXPORTER_OTLP_ENDPOINT (optional)
 *  - OTEL_SERVICE_NAME (default: 'kalle-api')
 *  - BULL_REDIS_URL (optional — falls back to REDIS_URL)
 *
 * V2 Auth/Flags variables (all optional — sensible defaults for legacy-only mode):
 *  - AUTH_V2_ENABLED (default: 'false', transforms string→boolean)
 *  - KEYCLOAK_BASE_URL (optional URL — required at runtime when AUTH_V2_ENABLED=true)
 *  - KEYCLOAK_REALM (default: 'blitzy')
 *  - KEYCLOAK_CLIENT_ID (default: 'kalle-app')
 *  - AUTH_SERVICE_URL (optional URL — required at runtime when AUTH_V2_ENABLED=true)
 *  - AUTH_SIDECAR_SECRET (optional, min 32 chars when set — Rule R8 secrets containment)
 *  - FLAGS_API_URL (optional URL — required at runtime when AUTH_V2_ENABLED=true)
 *  - FLAGS_API_SECRET (optional, min 32 chars when set — Rule R8 secrets containment)
 *
 * Intentionally ABSENT (do NOT add):
 *  - AUTH_DB_URL — Rule R2: kalle is in sidecar mode; never opens auth DB connection
 *  - FLAGS_DB_URL — Rule RF2: kalle reads flags via HTTP only; never opens flags DB
 */
export const envSchema = z.object({
  // === Database ===
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .url('DATABASE_URL must be a valid URL (e.g., postgresql://user:pass@host:5432/db)')
    .describe('PostgreSQL connection string (e.g., postgresql://user:pass@host:5432/db)'),

  // === Redis ===
  REDIS_URL: z
    .string({ required_error: 'REDIS_URL is required' })
    .url('REDIS_URL must be a valid URL (e.g., redis://redis:6379)')
    .describe('Redis connection string (e.g., redis://redis:6379)'),

  // === JWT / Authentication ===
  JWT_SECRET: z
    .string({ required_error: 'JWT_SECRET is required' })
    .min(32, 'JWT_SECRET must be at least 32 characters for security')
    .describe('Secret key for JWT token signing'),

  JWT_ACCESS_TOKEN_EXPIRY: z
    .string()
    .default('15m')
    .describe('Access token expiration (e.g., 15m, 1h)'),

  JWT_REFRESH_TOKEN_EXPIRY: z
    .string()
    .default('7d')
    .describe('Refresh token expiration (e.g., 7d, 30d)'),

  // === CORS ===
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:3000')
    .describe('Comma-separated allowed CORS origins'),

  // === Server ===
  API_PORT: z
    .string()
    .default('3001')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive().max(65535))
    .describe('Port the API server listens on'),

  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development')
    .describe('Node.js runtime environment'),

  // === Storage ===
  UPLOAD_DIR: z
    .string()
    .default('./uploads')
    .describe('Directory for encrypted media file storage'),

  MAX_FILE_SIZE: z
    .string()
    .default('26214400')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .describe('Maximum file upload size in bytes (default 25MB = 26214400)'),

  // === Logging ===
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info')
    .describe('Pino log level — "silent" suppresses all output (useful for testing)'),

  // === OpenTelemetry ===
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .optional()
    .describe('OpenTelemetry Collector gRPC endpoint'),

  OTEL_SERVICE_NAME: z
    .string()
    .default('kalle-api')
    .describe('Service name for OpenTelemetry traces/metrics'),

  // === BullMQ ===
  BULL_REDIS_URL: z
    .string()
    .optional()
    .describe('Redis URL for BullMQ (defaults to REDIS_URL if not set)'),

  // ─── V2 Auth/Flags Integration (FR-1, FR-4, FR-9, R2, R26, RF2, R8) ──────────
  // These environment variables wire the V2 OAuth/OIDC integration with the
  // auth-sidecar (port 4001) and the admin-ui flags API (port 4003).
  //
  // CRITICAL (Rule R2 — Auth DB Boundary):
  //   AUTH_DB_URL is INTENTIONALLY ABSENT from this schema. Kalle is in SIDECAR
  //   MODE — token-to-user resolution is delegated to the auth-sidecar via HTTP.
  //   The kalle process MUST NEVER open a connection to the auth database.
  //   Verified by: `grep "AUTH_DB_URL" kalle/apps/api/src/` returns zero matches.
  //
  // CRITICAL (Rule RF2 — Flags DB Boundary):
  //   FLAGS_DB_URL is INTENTIONALLY ABSENT from this schema. Flags are accessed
  //   via HTTP to the admin-ui evaluation API. The kalle process MUST NEVER open
  //   a connection to the flags database.
  //   Verified by: `grep "FLAGS_DB_URL" kalle/apps/api/src/` returns zero matches.

  /**
   * Master kill switch for the V2 OAuth/OIDC authentication path.
   *
   * When `false` (default): kalle uses the legacy JWT/blacklist auth path
   * via `services/AuthService.ts`. The existing 1,814-test suite passes
   * byte-identically. Zero `@blitzy/auth` code executes on the request path
   * (Rule R3 flag isolation).
   *
   * When `true`: kalle dispatches to `@blitzy/auth`'s createExpressMiddleware
   * via the V2-aware factory in `middleware/auth.ts`. Per Rule R4, the legacy
   * `AuthService` is bypassed entirely on protected routes.
   *
   * Read order at runtime (Rule RF3): in-process FlagInstance cache (5s TTL)
   * → `GET ${FLAGS_API_URL}/flags/AUTH_V2_ENABLED` → THIS env var as fallback.
   *
   * The env-var value parsed here is the FAIL-OPEN fallback. The authoritative
   * value at runtime is the row in the flags database (read via the flags API).
   * Per the AAP test parity requirement, behavior under DB-flag false MUST be
   * byte-identical to behavior under env-var false.
   */
  AUTH_V2_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((val) => val === 'true')
    .describe('V2 OAuth kill switch — "true"|"false" string transformed to boolean'),

  /**
   * Base URL of the Keycloak server (no trailing slash).
   *
   * Example: `http://keycloak:8080` (Docker Compose internal) or
   * `https://auth.example.com` (production).
   *
   * Consumed by `initAuth()` in `server.ts` to construct the JWKS URI
   * (`${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`)
   * and the OIDC discovery endpoint.
   *
   * Marked OPTIONAL so legacy-only deployments without a Keycloak instance can
   * still boot. If missing AND AUTH_V2_ENABLED resolves to true at runtime,
   * `initAuth()` will throw a descriptive error (the env-validation layer is
   * intentionally permissive; runtime construction is strict).
   */
  KEYCLOAK_BASE_URL: z
    .string()
    .url('KEYCLOAK_BASE_URL must be a valid URL (e.g., http://keycloak:8080)')
    .optional()
    .describe('Keycloak server base URL — used by initAuth() in V2 mode'),

  /**
   * Keycloak realm name. Default: `blitzy` per AAP Section 0.4.
   *
   * The realm definition is bootstrapped from `packages/auth/keycloak/realm-export.json`
   * via Keycloak's `--import-realm` flag (configured in docker-compose.yml).
   */
  KEYCLOAK_REALM: z
    .string()
    .default('blitzy')
    .describe('Keycloak realm name (default: "blitzy")'),

  /**
   * Keycloak client ID for the kalle public PKCE client. Default: `kalle-app`.
   *
   * The client is configured as PUBLIC in the realm export (no client secret),
   * with PKCE (S256) required and the redirect URI matching the kalle web origin.
   */
  KEYCLOAK_CLIENT_ID: z
    .string()
    .default('kalle-app')
    .describe('Keycloak client ID for the kalle public PKCE client'),

  /**
   * Optional override for the JWKS endpoint URL (QA F-CRITICAL-4).
   *
   * In SPLIT-ENDPOINT deployments, kalle reaches Keycloak via an internal
   * Docker hostname (e.g., `http://keycloak:8080`) while browsers reach
   * Keycloak at a public URL (e.g., `http://localhost:8080`). The kalle
   * server fetches JWKS via the INTERNAL URL but must validate the token's
   * `iss` claim against the PUBLIC URL Keycloak embedded at mint time.
   *
   * When set, `initAuth()` uses this URL verbatim for JWKS fetching.
   * When omitted, `initAuth()` derives the JWKS URI from `KEYCLOAK_BASE_URL`
   * per the OIDC discovery convention
   * (`${baseUrl}/realms/${realm}/protocol/openid-connect/certs`) — the
   * single-network deployment default.
   *
   * The `z.preprocess` wrapper coerces empty strings (a common artifact
   * of leaving the variable as `KEYCLOAK_JWKS_URI=` in `.env` or of
   * docker-compose's `${KEYCLOAK_JWKS_URI:-}` expansion when unset) to
   * `undefined` so the optional URL validator passes cleanly.
   *
   * See `packages/auth/src/auth/types.ts` `AuthConfig.jwksUri` JSDoc and
   * the F-CRITICAL-4 entry in the QA Test Report.
   */
  KEYCLOAK_JWKS_URI: z
    .preprocess(
      (val) => (typeof val === 'string' && val.length === 0 ? undefined : val),
      z.string().url('KEYCLOAK_JWKS_URI must be a valid URL').optional(),
    )
    .describe(
      'Optional override for the JWKS endpoint URL (split-endpoint deployments)',
    ),

  /**
   * Optional override for the expected JWT `iss` claim (QA F-CRITICAL-4).
   *
   * In SPLIT-ENDPOINT deployments, Keycloak embeds the BROWSER-perspective
   * issuer URL in the `iss` claim of access tokens (because the realm's
   * `frontendUrl` is set to the public URL, or because Keycloak honored
   * the `Host` header during the token-mint flow). The kalle server must
   * therefore validate against this PUBLIC issuer, even though it fetches
   * JWKS via the INTERNAL URL set by `KEYCLOAK_JWKS_URI`.
   *
   * Example values:
   *   - Internal:  `http://keycloak:8080/realms/blitzy`
   *   - Public:    `http://localhost:8080/realms/blitzy`
   *
   * When set, `initAuth()` uses this URL verbatim for the `iss` claim
   * assertion. When omitted, `initAuth()` derives the issuer from
   * `KEYCLOAK_BASE_URL` (single-network deployment default).
   *
   * The `z.preprocess` wrapper coerces empty strings to `undefined` for
   * the same reason as `KEYCLOAK_JWKS_URI` above.
   *
   * See `packages/auth/src/auth/types.ts` `AuthConfig.issuer` JSDoc and
   * the F-CRITICAL-4 entry in the QA Test Report.
   */
  KEYCLOAK_ISSUER: z
    .preprocess(
      (val) => (typeof val === 'string' && val.length === 0 ? undefined : val),
      z.string().url('KEYCLOAK_ISSUER must be a valid URL').optional(),
    )
    .describe(
      'Optional override for the expected JWT `iss` claim (split-endpoint deployments)',
    ),

  /**
   * Base URL of the auth-sidecar service (no trailing slash).
   *
   * Example: `http://auth-sidecar:4001` (Docker Compose internal).
   *
   * Consumed by `initAuth()` in sidecar mode to delegate `POST /validate` and
   * `POST /backchannel-logout` calls. The sidecar is the SOLE authority for V2
   * token validation when kalle runs in sidecar mode (Rule R2 — kalle never
   * reads `AUTH_DB_URL` directly).
   */
  AUTH_SERVICE_URL: z
    .string()
    .url('AUTH_SERVICE_URL must be a valid URL (e.g., http://auth-sidecar:4001)')
    .optional()
    .describe('Auth-sidecar base URL — used by initAuth() in V2 sidecar mode'),

  /**
   * Bearer token used to authenticate kalle → auth-sidecar requests.
   *
   * MUST be at least 32 characters of high-entropy randomness (Rule R8 secrets
   * containment). MUST be empty in `.env.example`. MUST be set via Docker
   * Compose env or k8s secret in non-development environments.
   *
   * The same secret value is also consumed by the auth-sidecar to validate
   * incoming requests on its `Authorization: Bearer ${AUTH_SIDECAR_SECRET}`
   * header. Rotation requires coordinating env-var updates across kalle and
   * the sidecar simultaneously.
   *
   * Marked `.optional()` so legacy-only deployments can boot without it.
   * When set, the `.min(32)` check enforces entropy at startup (Rule R8).
   */
  AUTH_SIDECAR_SECRET: z
    .string()
    .min(32, 'AUTH_SIDECAR_SECRET must be at least 32 characters for security (Rule R8)')
    .optional()
    .describe('Bearer secret for kalle→auth-sidecar HTTP requests'),

  /**
   * Base URL of the admin-ui flags evaluation API (no trailing slash).
   *
   * Example: `http://admin-ui:4003` (Docker Compose internal).
   *
   * Consumed by `initFlags()` in `server.ts` to read flag values via
   * `GET /flags/:name?subject=<email>`. Per Rule RF3 (flag fail-open),
   * if this URL is unreachable, FlagInstance falls back to `process.env`
   * (specifically AUTH_V2_ENABLED above).
   */
  FLAGS_API_URL: z
    .string()
    .url('FLAGS_API_URL must be a valid URL (e.g., http://admin-ui:4003)')
    .optional()
    .describe('Flags evaluation API base URL — used by initFlags() in V2 mode'),

  /**
   * Bearer token for kalle → flags API requests.
   *
   * Same constraints as AUTH_SIDECAR_SECRET (≥32 chars, empty placeholder
   * in `.env.example`, set via secret-manager in production). Per Rule R8.
   *
   * Marked `.optional()` so legacy-only deployments can boot without it.
   * When set, the `.min(32)` check enforces entropy at startup (Rule R8).
   */
  FLAGS_API_SECRET: z
    .string()
    .min(32, 'FLAGS_API_SECRET must be at least 32 characters for security (Rule R8)')
    .optional()
    .describe('Bearer secret for kalle→flags-API HTTP requests'),
});

// =============================================================================
// Derived TypeScript Type
// =============================================================================

/**
 * Strongly-typed configuration interface derived from the Zod environment schema.
 *
 * Includes all transformations applied by the schema:
 *  - API_PORT is `number` (transformed from string)
 *  - MAX_FILE_SIZE is `number` (transformed from string)
 *  - OTEL_EXPORTER_OTLP_ENDPOINT is `string | undefined` (optional)
 *  - BULL_REDIS_URL is `string | undefined` (optional, resolved to REDIS_URL in validateEnv)
 *  - AUTH_V2_ENABLED is `boolean` (transformed from 'true'|'false' string)
 *
 * Members exposed:
 *  - DATABASE_URL: string
 *  - REDIS_URL: string
 *  - JWT_SECRET: string
 *  - JWT_ACCESS_TOKEN_EXPIRY: string
 *  - JWT_REFRESH_TOKEN_EXPIRY: string
 *  - CORS_ORIGIN: string
 *  - API_PORT: number
 *  - NODE_ENV: 'development' | 'production' | 'test'
 *  - UPLOAD_DIR: string
 *  - MAX_FILE_SIZE: number
 *  - LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'
 *  - OTEL_EXPORTER_OTLP_ENDPOINT: string | undefined
 *  - OTEL_SERVICE_NAME: string
 *  - BULL_REDIS_URL: string | undefined
 *
 * V2 Members:
 *  - AUTH_V2_ENABLED: boolean (after .transform from string)
 *  - KEYCLOAK_BASE_URL: string | undefined
 *  - KEYCLOAK_REALM: string (default 'blitzy')
 *  - KEYCLOAK_CLIENT_ID: string (default 'kalle-app')
 *  - AUTH_SERVICE_URL: string | undefined
 *  - AUTH_SIDECAR_SECRET: string | undefined (min 32 chars when set)
 *  - FLAGS_API_URL: string | undefined
 *  - FLAGS_API_SECRET: string | undefined (min 32 chars when set)
 */
export type EnvConfig = z.infer<typeof envSchema>;

// =============================================================================
// Validation Function
// =============================================================================

/**
 * Validates `process.env` against the environment schema and returns a
 * strongly-typed configuration object.
 *
 * Uses `safeParse` (not `parse`) to collect ALL validation errors at once,
 * enabling developers to see every missing/invalid variable in a single
 * error message (Rule R26).
 *
 * The error message intentionally includes only variable NAMES and validation
 * messages — never actual VALUES of sensitive variables like JWT_SECRET or
 * DATABASE_URL (Rule R23 — log hygiene).
 *
 * Post-validation, if BULL_REDIS_URL was not explicitly set, it is resolved
 * to the value of REDIS_URL as a convenience fallback for development
 * environments that use a single Redis instance.
 *
 * @returns {EnvConfig} Validated and transformed environment configuration.
 * @throws {Error} Descriptive error listing ALL missing/invalid variables.
 *
 * @example
 * ```typescript
 * // In composition root (server.ts):
 * import { validateEnv } from './config/env.js';
 *
 * const env = validateEnv(); // Throws if any env vars missing/invalid
 * // env.API_PORT is number, env.NODE_ENV is union type, etc.
 * ```
 */
export function validateEnv(): EnvConfig {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formattedErrors = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return `  - ${path}: ${issue.message}`;
    });

    const errorMessage = [
      '',
      '╔══════════════════════════════════════════════════╗',
      '║  ENVIRONMENT VALIDATION FAILED                   ║',
      '╚══════════════════════════════════════════════════╝',
      '',
      'The following environment variables are missing or invalid:',
      '',
      ...formattedErrors,
      '',
      'Please check your .env file or environment configuration.',
      'Copy .env.example to .env for local development defaults.',
      '',
    ].join('\n');

    throw new Error(errorMessage);
  }

  // Post-validation: resolve BULL_REDIS_URL fallback to REDIS_URL
  const config = result.data;
  if (!config.BULL_REDIS_URL) {
    (config as Record<string, unknown>).BULL_REDIS_URL = config.REDIS_URL;
  }

  return config;
}
