/**
 * @file apps/api/src/middleware/logger.ts
 * @description Pino HTTP request/response logging middleware factory.
 *
 * Creates and configures pino-http middleware for structured HTTP request/response
 * logging. Integrates with the LoggerProvider to share a single Pino logger instance
 * across the application. Logs request method, URL, status code, response time, and
 * correlation ID for every HTTP request.
 *
 * Architecture Rules Enforced:
 *  - R28 (Structured Logging Only): Zero console.log calls — all logging via Pino.
 *  - R23 (Log Hygiene): Sensitive fields (JWT, passwords, ciphertext, keys) are
 *    redacted from log output via custom serializers and pino redaction.
 *  - R29 (Correlation ID Propagation): Each log entry includes the correlation ID
 *    assigned by the correlation-id middleware earlier in the chain.
 *  - R7 (Zero Warnings Build): Compiles under tsc --noEmit --strict with zero warnings.
 */

import pinoHttp from 'pino-http';
import type { Logger } from 'pino';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Factory function that creates a configured pino-http Express middleware.
 *
 * The middleware automatically logs every HTTP request with method, URL, status code,
 * and response time. It uses the provided Pino logger instance (from LoggerProvider)
 * to ensure consistent logging configuration across the entire application.
 *
 * @param logger - Pino Logger instance from LoggerProvider.createLogger('http')
 * @returns Configured pino-http middleware ready for Express use
 *
 * @example
 * ```typescript
 * // In server.ts (composition root):
 * const httpLogger = loggerProvider.createLogger('http');
 * const pinoHttpMiddleware = createLoggerMiddleware(httpLogger);
 *
 * // In app.ts (middleware chain):
 * app.use(correlationIdMiddleware); // Step 7 — assigns req.correlationId
 * app.use(pinoHttpMiddleware);      // Step 8 — THIS middleware
 * app.use(metricsMiddleware);       // Step 9
 * ```
 */
export function createLoggerMiddleware(logger: Logger) {
  return pinoHttp({
    // Reuse the provided Pino logger instance from LoggerProvider
    logger,

    // Automatically log every request/response cycle
    autoLogging: true,

    /**
     * Custom log level based on HTTP response status code.
     * - 5xx or errors → 'error' (server errors always logged at error level)
     * - 4xx → 'warn' (client errors are warnings, not server failures)
     * - 3xx → 'silent' (redirects are noise — suppress them)
     * - 2xx and 1xx → 'info' (successful requests logged at info level)
     */
    customLogLevel: (
      _req: IncomingMessage,
      res: ServerResponse,
      err?: Error
    ) => {
      if (res.statusCode >= 500 || err) return 'error';
      if (res.statusCode >= 400) return 'warn';
      if (res.statusCode >= 300) return 'silent';
      return 'info';
    },

    /**
     * Custom success message format for completed requests.
     * Format: "GET /api/v1/users 200 42ms"
     */
    customSuccessMessage: (
      req: IncomingMessage,
      res: ServerResponse,
      responseTime: number
    ): string => {
      return `${req.method} ${req.url} ${res.statusCode} ${Math.round(responseTime)}ms`;
    },

    /**
     * Custom error message format for failed requests.
     * Format: "POST /api/v1/auth/login 500 - Internal server error"
     */
    customErrorMessage: (
      req: IncomingMessage,
      res: ServerResponse,
      err: Error
    ): string => {
      return `${req.method} ${req.url} ${res.statusCode} - ${err.message}`;
    },

    /**
     * Custom attribute keys for cleaner, more readable log output.
     * Maps pino-http's default keys to more descriptive names:
     *  - req → request
     *  - res → response
     *  - err → error
     *  - responseTime → duration
     */
    customAttributeKeys: {
      req: 'request',
      res: 'response',
      err: 'error',
      responseTime: 'duration',
    },

    /**
     * Redact sensitive data from log output (Rule R23 — Log Hygiene).
     *
     * This serves as a secondary defense layer alongside custom serializers.
     * Even if serializers are bypassed, these paths will be censored.
     * Covers: authorization headers, cookies, passwords, tokens, encryption
     * keys, ciphertext, and prekey material.
     */
    redact: {
      paths: [
        'request.headers.authorization',
        'request.headers.cookie',
        'request.body.password',
        'request.body.passwordConfirm',
        'request.body.currentPassword',
        'request.body.newPassword',
        'request.body.token',
        'request.body.refreshToken',
        'request.body.accessToken',
        'request.body.ciphertext',
        'request.body.plaintext',
        'request.body.encryptionKey',
        'request.body.identityKey',
        'request.body.signedPreKey',
        'request.body.preKeys',
      ],
      censor: '[REDACTED]',
    },

    /**
     * Custom serializers to ensure only safe fields appear in logs (Rule R23).
     *
     * Request serializer: Only outputs method, URL, and correlationId.
     * Response serializer: Only outputs statusCode.
     *
     * This is the PRIMARY defense against logging sensitive data.
     * Headers (including Authorization), body content, cookies, and all
     * other request/response details are intentionally excluded.
     */
    serializers: {
      req(req: IncomingMessage) {
        // Extract correlation ID from the raw request object.
        // pino-http passes the serialized request; access raw for correlationId.
        const raw = (req as unknown as { raw?: { correlationId?: string } }).raw;
        return {
          method: (req as unknown as { method?: string }).method,
          url: (req as unknown as { url?: string }).url,
          correlationId: raw?.correlationId ?? (req as unknown as { id?: string }).id,
          // INTENTIONALLY OMITTED: headers, body, query, params, cookies
        };
      },
      res(res: ServerResponse) {
        return {
          statusCode: res.statusCode,
          // INTENTIONALLY OMITTED: headers, body
        };
      },
    },

    /**
     * Generate request ID using the correlation ID from correlation-id middleware.
     *
     * The correlation-id middleware (earlier in the chain) assigns req.correlationId
     * (UUID v4). This function bridges that value into pino-http's request ID system,
     * ensuring every log entry includes the correlation ID (Rule R29).
     *
     * Falls back to pino-http's built-in ID if correlation ID is not available.
     */
    genReqId: (req: IncomingMessage, _res: ServerResponse) => {
      // Access correlationId set by correlation-id middleware on the Express request
      const correlationId = (req as unknown as { correlationId?: string }).correlationId;
      return correlationId ?? (req as unknown as { id?: string | number }).id ?? '';
    },
  });
}
