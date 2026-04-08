/**
 * @file apps/api/src/middleware/error-handler.ts
 * @description Global Express error handler middleware (4-argument signature).
 *
 * Catches all thrown errors from controllers, services, and other middleware.
 * Maps typed DomainError subclasses to their corresponding HTTP status codes
 * and returns the standardized error response shape. Handles unknown errors
 * as 500 Internal Server Error. This is the LAST middleware in the chain.
 *
 * Architecture Rules Enforced:
 * - R22 (Standardized Error Responses): ALL API error responses use
 *        `{ error: { code: string, message: string, details?: object } }`.
 *        This middleware is the ONLY place where error responses are formatted.
 * - R28 (Structured Logging Only): Zero `console.log` calls. Error logging
 *        uses the Pino logger attached to the request via `req.log` from
 *        pino-http, with appropriate log levels per status code range.
 * - R23 (Log Hygiene): Error logs MUST NOT contain JWT tokens, passwords,
 *        plaintext message content, encryption keys, or prekey material.
 *        Only error code, message, status code, and correlation ID are logged.
 * - R29 (Correlation ID Propagation): Error responses include the correlation
 *        ID assigned by correlation-id middleware for client-side debugging.
 * - R7  (Zero Warnings Build): Compiles under `tsc --noEmit --strict` with
 *        zero warnings.
 */

import type { Request, Response, NextFunction } from 'express';
import { DomainError } from '../errors/DomainError';

/**
 * Augment the Express Request interface to include the correlationId property.
 *
 * This augmentation is also declared in middleware/correlation-id.ts and
 * middleware/auth.ts. TypeScript merges global namespace augmentations,
 * so declaring `correlationId` here ensures this middleware compiles
 * independently regardless of file processing order while remaining
 * fully compatible when all declarations are present.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** UUID v4 correlation ID assigned by the correlation-id middleware. */
      correlationId?: string;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helper interfaces for type-safe handling of Express-internal
// and third-party error shapes that don't have first-class TypeScript types.
// ---------------------------------------------------------------------------

/**
 * Express body-parser errors carry additional metadata (`type`, `status`)
 * not declared on the standard `Error` interface. This interface provides
 * type-safe access to those properties without using `(err as any)`.
 */
interface ExpressBodyParserError extends Error {
  /** Express-internal error type string (e.g. `'entity.parse.failed'`, `'entity.too.large'`). */
  type?: string;
  /** HTTP status code suggested by Express/body-parser (e.g. `400`, `413`). */
  status?: number;
}

/**
 * Minimal representation of a single Zod validation issue.
 * Used for the safety-net Zod error handler — normally the validation
 * middleware wraps ZodErrors into a DomainError before they reach here.
 */
interface ZodIssueLike {
  /** Property path that failed validation (e.g. `['body', 'email']`). */
  path: ReadonlyArray<string | number>;
  /** Human-readable validation failure message. */
  message: string;
  /** Zod issue code (e.g. `'invalid_type'`, `'too_small'`). */
  code: string;
}

/**
 * Minimal shape of a Zod validation error. Matches the structure of
 * `ZodError` from the `zod` package without importing it directly,
 * keeping this middleware dependency-light.
 */
interface ZodErrorLike extends Error {
  /** Array of individual validation issues that caused the error. */
  issues: ZodIssueLike[];
}

// ---------------------------------------------------------------------------
// Standardized error response field type — matches the shape clients expect.
// ---------------------------------------------------------------------------

/**
 * Individual field-level validation error included in the `details.fields`
 * array of a 400 validation error response.
 */
interface FieldError {
  /** Dot-notation path to the field that failed validation. */
  field: string;
  /** Human-readable description of the validation failure. */
  message: string;
  /** Machine-readable validation issue code from Zod. */
  code: string;
}

// ---------------------------------------------------------------------------
// Error handler implementation
// ---------------------------------------------------------------------------

/**
 * Express global error handler middleware.
 *
 * **CRITICAL:** This function uses the 4-argument signature
 * `(err, req, res, next)` which Express uses to identify error-handling
 * middleware. The `_next` parameter is intentionally unused but MUST be
 * present — removing it causes Express to treat this as regular middleware
 * and skip error routing. The underscore prefix satisfies TypeScript's
 * `noUnusedParameters` strict check.
 *
 * **Error handling chain (priority order):**
 * 1. Known domain errors (`DomainError` and all subclasses) → mapped HTTP status
 * 2. Uncaught Zod validation errors (safety net) → 400
 * 3. Express JSON parse errors (malformed body) → 400
 * 4. Express body-parser size limit errors → 413
 * 5. All other unknown errors → 500 (generic message, never expose internals)
 *
 * **Response shape (Rule R22):**
 * ```json
 * {
 *   "error": {
 *     "code": "MACHINE_READABLE_CODE",
 *     "message": "Human-readable description",
 *     "details": {},
 *     "correlationId": "uuid-v4"
 *   }
 * }
 * ```
 *
 * @param err   - The error thrown or passed via `next(err)` from upstream middleware
 * @param req   - Express request (used for correlationId and Pino logger)
 * @param res   - Express response (used to send standardized JSON error response)
 * @param _next - Express next function (required for 4-arg signature; intentionally unused)
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // ------------------------------------------------------------------
  // Step 1: Extract correlation ID for response and logging (Rule R29).
  //
  // Priority: req.correlationId (set by correlation-id middleware)
  //         → X-Correlation-ID header (client-provided fallback)
  //         → undefined (no correlation ID available)
  // ------------------------------------------------------------------
  const headerValue = req.headers['x-correlation-id'];
  const headerCorrelationId: string | undefined = Array.isArray(headerValue)
    ? headerValue[0]
    : headerValue;

  const correlationId: string | undefined =
    req.correlationId || headerCorrelationId || undefined;

  // ------------------------------------------------------------------
  // Step 2: Known domain errors — DomainError and all subclasses.
  //
  // All typed domain errors (AuthenticationError, AuthorizationError,
  // NotFoundError, ValidationError, ConflictError, PayloadTooLargeError,
  // UnsupportedMediaTypeError, RateLimitError) extend DomainError and
  // inherit statusCode, code, message, and details properties.
  //
  // The instanceof check covers the entire hierarchy — no need to
  // import or check each subclass individually.
  // ------------------------------------------------------------------
  if (err instanceof DomainError) {
    // Build log payload — includes only safe fields (Rule R23)
    const logPayload: Record<string, unknown> = {
      correlationId,
      errorCode: err.code,
      statusCode: err.statusCode,
      message: err.message,
    };

    // Include details only if present — details are already sanitized
    // by error constructors per the DomainError contract (Rule R23).
    if (err.details !== undefined) {
      logPayload.details = err.details;
    }

    // Log at appropriate level via pino-http request logger (Rule R28).
    // req.log is injected by pino-http middleware earlier in the chain.
    if (req.log) {
      if (err.statusCode >= 500) {
        req.log.error(logPayload, 'Domain error (server)');
      } else if (err.statusCode >= 400) {
        req.log.warn(logPayload, 'Domain error (client)');
      }
    }

    // Return standardized error response with correlation ID (Rule R22, R29)
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined && { details: err.details }),
        ...(correlationId !== undefined && { correlationId }),
      },
    });
    return;
  }

  // ------------------------------------------------------------------
  // Step 3: Handle Prisma unique constraint violation (P2002).
  //
  // When concurrent requests bypass the service-layer uniqueness check
  // (e.g., two simultaneous registrations with the same email), the
  // database enforces the unique constraint and Prisma throws a
  // PrismaClientKnownRequestError with code 'P2002'. Without this
  // handler, such errors fall through to the generic 500 catch-all.
  //
  // We detect the error by class name and `code` property to avoid
  // importing @prisma/client in this middleware, keeping it
  // dependency-light and framework-agnostic.
  // ------------------------------------------------------------------
  const prismaErr = err as Error & { code?: string; meta?: { target?: string[] } };
  if (
    (err.constructor?.name === 'PrismaClientKnownRequestError' ||
     err.name === 'PrismaClientKnownRequestError') &&
    prismaErr.code === 'P2002'
  ) {
    // Extract the constraint field(s) from Prisma error metadata
    const targetFields = Array.isArray(prismaErr.meta?.target)
      ? prismaErr.meta!.target
      : [];
    const fieldDescription = targetFields.length > 0
      ? targetFields.join(', ')
      : 'unknown field';

    if (req.log) {
      req.log.warn(
        { correlationId, constraint: fieldDescription },
        'Unique constraint violation (P2002)'
      );
    }

    res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: `A record with the same ${fieldDescription} already exists`,
        ...(correlationId !== undefined && { correlationId }),
      },
    });
    return;
  }

  // ------------------------------------------------------------------
  // Step 4: Safety-net for uncaught Zod validation errors.
  //
  // Normally, the validation middleware wraps ZodErrors into a
  // ValidationError (DomainError subclass) before they propagate.
  // This branch provides defense-in-depth for any ZodError that
  // escapes the validation middleware pipeline.
  // ------------------------------------------------------------------
  if (err.name === 'ZodError') {
    const zodErr = err as ZodErrorLike;
    const fields: FieldError[] = Array.isArray(zodErr.issues)
      ? zodErr.issues.map((issue: ZodIssueLike): FieldError => ({
          field: Array.isArray(issue.path) ? issue.path.join('.') || 'unknown' : 'unknown',
          message: issue.message,
          code: issue.code,
        }))
      : [];

    if (req.log) {
      req.log.warn(
        { correlationId, fieldCount: fields.length },
        'Uncaught Zod validation error'
      );
    }

    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: { fields },
        ...(correlationId !== undefined && { correlationId }),
      },
    });
    return;
  }

  // ------------------------------------------------------------------
  // Step 4: Handle Express JSON parse errors (malformed request body).
  //
  // Express body-parser throws errors with `type: 'entity.parse.failed'`
  // when JSON.parse fails on the request body. We also catch status-400
  // errors whose message references JSON as a secondary heuristic.
  // ------------------------------------------------------------------
  const bodyParserErr = err as ExpressBodyParserError;

  if (
    bodyParserErr.type === 'entity.parse.failed' ||
    (bodyParserErr.status === 400 && typeof err.message === 'string' && err.message.includes('JSON'))
  ) {
    if (req.log) {
      req.log.warn({ correlationId }, 'Malformed JSON in request body');
    }

    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Malformed JSON in request body',
        ...(correlationId !== undefined && { correlationId }),
      },
    });
    return;
  }

  // ------------------------------------------------------------------
  // Step 5: Handle Express body-parser size limit errors.
  //
  // When the request body exceeds the limit set in `express.json({ limit })`,
  // body-parser throws an error with `type: 'entity.too.large'` or
  // `status: 413`. Returns a clean 413 instead of a raw Express error.
  // ------------------------------------------------------------------
  if (bodyParserErr.type === 'entity.too.large' || bodyParserErr.status === 413) {
    if (req.log) {
      req.log.warn({ correlationId }, 'Request payload too large');
    }

    res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request payload exceeds the maximum allowed size',
        ...(correlationId !== undefined && { correlationId }),
      },
    });
    return;
  }

  // ------------------------------------------------------------------
  // Step 5b: Handle Multer file-size limit errors (Rule R8).
  //
  // When a multipart file upload exceeds the `limits.fileSize` value
  // configured on the multer instance (26 MB — see media.routes.ts),
  // multer throws a `MulterError` with `code === 'LIMIT_FILE_SIZE'`.
  //
  // Unlike Express body-parser errors (which carry `type` and `status`
  // properties), Multer errors are instances of `multer.MulterError`
  // identified by `err.name === 'MulterError'` and a machine-readable
  // `code` string. We detect them by name+code to avoid importing
  // the multer package directly, keeping this middleware dependency-light.
  //
  // Maps to HTTP 413 with the R22-compliant standardized error shape.
  // ------------------------------------------------------------------
  const multerErr = err as Error & { code?: string };
  if (multerErr.name === 'MulterError' && multerErr.code === 'LIMIT_FILE_SIZE') {
    if (req.log) {
      req.log.warn({ correlationId }, 'File upload exceeds size limit (multer)');
    }

    res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'File size exceeds 25MB limit',
        ...(correlationId !== undefined && { correlationId }),
      },
    });
    return;
  }

  // ------------------------------------------------------------------
  // Step 6: Unknown / unexpected errors → 500 Internal Server Error.
  //
  // CRITICAL SECURITY (Rule R23): NEVER expose internal error details,
  // stack traces, file paths, or database details to the client.
  // Stack trace is logged server-side only for debugging.
  // ------------------------------------------------------------------
  if (req.log) {
    req.log.error(
      {
        correlationId,
        errorName: err.name,
        errorMessage: err.message,
        // Stack trace logged server-side only — NEVER included in response
        stack: err.stack,
      },
      'Unexpected internal error'
    );
  }

  // Return generic 500 response — NEVER expose internal error details to client
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      ...(correlationId !== undefined && { correlationId }),
    },
  });
}
