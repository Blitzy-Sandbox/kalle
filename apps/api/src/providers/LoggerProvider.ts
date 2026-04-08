/**
 * @file LoggerProvider.ts — Pino JSON Logger Factory with Correlation ID Injection
 *
 * Cross-cutting concern that provides a factory for creating Pino logger instances
 * with structured JSON output, configurable log levels, field-level redaction of
 * sensitive data, and correlation ID injection for request-scoped tracing.
 *
 * This is NOT interface-driven like other providers — no ILoggerProvider interface
 * exists. The LoggerProvider is used directly by name across the backend codebase.
 *
 * Architecture Rules Enforced:
 * - R28: Structured Logging Only — all logging through Pino, zero console.*
 * - R29: Correlation ID Propagation — createChildLogger injects correlation IDs
 * - R23: Log Hygiene — redaction of JWT tokens, passwords, encryption keys, message content
 * - R7:  Zero Warnings Build — compiles under tsc --noEmit --strict
 */

import pino from 'pino';
import type { Logger, LoggerOptions } from 'pino';

/**
 * Valid Pino log level strings.
 * Used for constructor parameter validation.
 */
const VALID_LOG_LEVELS = new Set<string>([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

/**
 * Comprehensive list of field paths that must be automatically redacted
 * from all log output to comply with Rule R23 (Log Hygiene).
 *
 * Categories:
 * - HTTP headers: authorization, cookies
 * - Credentials: passwords, password hashes
 * - JWT tokens: access tokens, refresh tokens, JWT secrets
 * - Encryption material: keys, IVs
 * - Signal Protocol key material: prekeys, identity key, signed prekey
 * - Message content: ciphertext, plaintext, message body
 * - Wildcard patterns: catch nested occurrences in any object
 */
const REDACTED_PATHS: string[] = [
  // HTTP headers containing sensitive tokens
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',

  // User credentials
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'confirmPassword',

  // JWT and session tokens
  'token',
  'accessToken',
  'refreshToken',
  'jwtSecret',
  'secret',

  // Encryption material (Rule R12 — E2E encryption integrity)
  'encryptionKey',
  'encryptionIv',
  'privateKey',
  'secretKey',

  // Signal Protocol key material
  'preKey',
  'preKeys',
  'identityKey',
  'signedPreKey',
  'senderKey',
  'chainKey',
  'rootKey',
  'sessionKey',

  // Message content (must never appear in server logs)
  'ciphertext',
  'plaintext',
  'messageContent',
  'body.ciphertext',
  'body.plaintext',

  // Wildcard patterns for nested occurrences in any object depth
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.encryptionKey',
  '*.encryptionIv',
  '*.privateKey',
  '*.secretKey',
  '*.ciphertext',
  '*.plaintext',
  '*.preKey',
  '*.identityKey',
  '*.signedPreKey',
  '*.senderKey',
  '*.messageContent',
];

/**
 * The censor string that replaces sensitive values in log output.
 * Visible in logs as "[REDACTED]" to indicate a field was sanitized.
 */
const CENSOR_VALUE = '[REDACTED]';

/**
 * LoggerProvider — Factory for creating Pino logger instances.
 *
 * Provides three core capabilities:
 * 1. Named component loggers via `createLogger(name)` — e.g., 'server', 'http', 'websocket'
 * 2. Request-scoped child loggers via `createChildLogger(parent, bindings)` — injects correlation ID
 * 3. Base logger access via `getBaseLogger()` — for bootstrap and pino-http configuration
 *
 * All loggers produced by this factory share:
 * - ISO 8601 timestamps for human-readable, sortable log entries
 * - Automatic field-level redaction of sensitive data (Rule R23)
 * - String level labels instead of numeric levels for readability
 * - Base `service: 'kalle-api'` binding for multi-service log aggregation
 *
 * @example
 * ```typescript
 * const loggerProvider = new LoggerProvider('info');
 * const serverLogger = loggerProvider.createLogger('server');
 * serverLogger.info({ port: 3001 }, 'Server started');
 * // Output: {"level":"info","time":"2026-03-30T12:00:00.000Z","service":"kalle-api","component":"server","port":3001,"msg":"Server started"}
 *
 * const requestLogger = loggerProvider.createChildLogger(serverLogger, {
 *   correlationId: 'abc-123',
 *   method: 'GET',
 *   path: '/api/v1/users',
 * });
 * requestLogger.info('Request received');
 * // Output: {"level":"info","time":"...","service":"kalle-api","component":"server","correlationId":"abc-123","method":"GET","path":"/api/v1/users","msg":"Request received"}
 * ```
 */
export class LoggerProvider {
  /**
   * The root Pino logger instance with all base configuration applied.
   * All child loggers are derived from this instance, inheriting its
   * level, redaction rules, formatters, and base bindings.
   */
  private readonly baseLogger: Logger;

  /**
   * Creates a new LoggerProvider with a base Pino logger configured
   * for production-grade structured JSON output.
   *
   * @param logLevel - Pino log level string. Valid values: 'fatal', 'error',
   *   'warn', 'info', 'debug', 'trace', 'silent'. Defaults to 'info'.
   *   Typically sourced from `env.LOG_LEVEL` environment variable.
   */
  constructor(logLevel: string = 'info') {
    // Validate the log level and fall back to 'info' for unrecognized values
    const resolvedLevel = VALID_LOG_LEVELS.has(logLevel) ? logLevel : 'info';

    const options: LoggerOptions = {
      // Set the minimum log level threshold
      level: resolvedLevel,

      // ISO 8601 timestamps for human-readable, sortable log entries
      // Format: "2026-03-30T12:00:00.000Z"
      timestamp: pino.stdTimeFunctions.isoTime,

      // Field-level redaction of sensitive data (Rule R23)
      // The censor value '[REDACTED]' is visible in log output to indicate
      // that a sensitive field was present but its value was sanitized.
      redact: {
        paths: REDACTED_PATHS,
        censor: CENSOR_VALUE,
      },

      // Output string level labels ("info") instead of numeric levels (30)
      // This improves human readability and log search/filtering
      formatters: {
        level(label: string): { level: string } {
          return { level: label };
        },
      },

      // Base bindings applied to ALL log entries from ALL child loggers.
      // Tags every entry with the service name for multi-service log aggregation
      // in environments where multiple services write to the same log sink.
      base: {
        service: 'kalle-api',
      },
    };

    this.baseLogger = pino(options);
  }

  /**
   * Creates a named child logger for a specific application component.
   *
   * The returned logger inherits all base configuration (level, redaction,
   * formatters, service tag) and adds a `component` field to every log entry
   * produced by it. This enables filtering logs by system component in
   * log aggregation tools (e.g., `component: "server"`, `component: "http"`).
   *
   * @param name - The component name to bind to all log entries.
   *   Common values: 'server', 'http', 'websocket', 'worker', 'auth',
   *   'messaging', 'media', 'encryption', 'health', 'metrics'.
   *
   * @returns A child Logger instance with the `component` field bound.
   *
   * @example
   * ```typescript
   * const httpLogger = loggerProvider.createLogger('http');
   * httpLogger.info({ statusCode: 200 }, 'Request completed');
   * // {"level":"info","time":"...","service":"kalle-api","component":"http","statusCode":200,"msg":"Request completed"}
   * ```
   */
  createLogger(name: string): Logger {
    return this.baseLogger.child({ component: name });
  }

  /**
   * Creates a child logger with additional bindings, typically used to inject
   * a correlation ID and request-specific context for tracing.
   *
   * This produces a "child of a child" — inheriting both the component name
   * from the parent logger AND the request-specific bindings. The correlation
   * ID flows through to ALL log entries for that request lifecycle, enabling
   * end-to-end request tracing (Rule R29).
   *
   * @param parentLogger - The parent logger to create a child from. Typically
   *   a named component logger created via `createLogger()`.
   * @param bindings - Key-value pairs to bind to every log entry from this
   *   child. Common bindings include `correlationId`, `method`, `path`,
   *   `userId`, `socketId`, `jobId`.
   *
   * @returns A child Logger instance with the additional bindings applied.
   *
   * @example
   * ```typescript
   * // In correlation ID middleware:
   * const requestLogger = loggerProvider.createChildLogger(httpLogger, {
   *   correlationId: 'abc-123-def-456',
   *   method: 'POST',
   *   path: '/api/v1/messages',
   *   userId: 'user-789',
   * });
   * requestLogger.info('Processing message send');
   * // {"level":"info","time":"...","service":"kalle-api","component":"http","correlationId":"abc-123-def-456","method":"POST","path":"/api/v1/messages","userId":"user-789","msg":"Processing message send"}
   * ```
   */
  createChildLogger(parentLogger: Logger, bindings: Record<string, unknown>): Logger {
    return parentLogger.child(bindings);
  }

  /**
   * Returns the root Pino logger instance.
   *
   * Use this for bootstrap-level logging before named component loggers are
   * created, or for direct integration with pino-http middleware configuration.
   *
   * @returns The base Logger instance with all configuration applied but no
   *   component binding.
   *
   * @example
   * ```typescript
   * // In server.ts bootstrap:
   * const baseLogger = loggerProvider.getBaseLogger();
   * baseLogger.info('Starting server bootstrap...');
   *
   * // For pino-http middleware:
   * const pinoHttpMiddleware = pinoHttp({
   *   logger: loggerProvider.getBaseLogger(),
   * });
   * ```
   */
  getBaseLogger(): Logger {
    return this.baseLogger;
  }
}

/**
 * Re-export the Pino Logger type for consumer typing convenience.
 *
 * This allows other modules to type their logger parameters as `Logger`
 * by importing from this module rather than directly from 'pino', maintaining
 * clean dependency boundaries. Components depend on the LoggerProvider module
 * rather than on the pino package directly.
 *
 * @example
 * ```typescript
 * import { Logger } from '../providers/LoggerProvider';
 *
 * class MyService {
 *   constructor(private logger: Logger) {}
 * }
 * ```
 */
export type { Logger } from 'pino';
