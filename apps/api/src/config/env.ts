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
