/**
 * @file validation.ts
 * @description Zod schema validation middleware factory for Express.
 *
 * Returns Express middleware that validates `req.body`, `req.query`, and/or
 * `req.params` against provided Zod schemas. On validation failure, throws a
 * `ValidationError` with field-level error details. On success, replaces the
 * request data with Zod-parsed (coerced/transformed) values so downstream
 * handlers receive clean, typed data.
 *
 * This is the primary enforcement mechanism for Rule R31 (Input Validation via
 * Zod) — no raw user input reaches the service layer.
 *
 * Architecture Rules Enforced:
 * - R31: Every controller endpoint validates request body, query params, and
 *        path params via Zod schemas BEFORE invoking service methods.
 * - R22: Validation failures return standardized error shape
 *        `{ error: { code: 'VALIDATION_ERROR', message, details: { fields } } }`
 *        via `ValidationError` caught by the global error handler.
 * - R28: Zero `console.log` calls — structured Pino logging only.
 * - R7:  Zero warnings under `tsc --noEmit --strict`.
 *
 * @example
 * ```typescript
 * import { validate, validateBody } from '../middleware/validation';
 * import { z } from 'zod';
 *
 * // Body-only validation (most common):
 * router.post('/login', validateBody(z.object({
 *   email: z.string().email(),
 *   password: z.string().min(8),
 * })), authController.login);
 *
 * // Multi-target validation:
 * router.get('/messages',
 *   validate({
 *     params: z.object({ conversationId: z.string().uuid() }),
 *     query: z.object({
 *       limit: z.coerce.number().int().min(1).max(100).default(50),
 *       cursor: z.string().uuid().optional(),
 *     }),
 *   }),
 *   messageController.getHistory
 * );
 * ```
 */

import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError, ZodIssue } from 'zod';

import { ValidationError } from '../errors/ValidationError';

/**
 * Configuration options for the `validate` middleware factory.
 *
 * Each property is an optional Zod schema that, when provided, triggers
 * validation of the corresponding part of the Express request object.
 *
 * - `body`   — Validates `req.body` (parsed JSON body)
 * - `query`  — Validates `req.query` (URL query parameters)
 * - `params` — Validates `req.params` (URL path parameters)
 */
export interface ValidateOptions {
  /** Zod schema to validate the request body (`req.body`). */
  body?: ZodSchema;
  /** Zod schema to validate URL query parameters (`req.query`). */
  query?: ZodSchema;
  /** Zod schema to validate URL path parameters (`req.params`). */
  params?: ZodSchema;
}

/**
 * Converts a `ZodError` into an array of standardised field-level error objects.
 *
 * Each error entry includes:
 * - `field`   — Dot-notated path prefixed with the source (e.g. `'body.email'`,
 *               `'query.page'`, `'params.conversationId'`)
 * - `message` — Human-readable Zod validation failure description
 * - `code`    — Machine-readable Zod issue code (e.g. `'invalid_string'`,
 *               `'too_small'`, `'invalid_type'`)
 *
 * @param zodError - The `ZodError` returned by `safeParse` on failure
 * @param source   - Which part of the request failed (`'body'`, `'query'`, or `'params'`)
 * @returns Array of field-level error objects for the standardised error response
 */
function formatZodErrors(
  zodError: ZodError,
  source: 'body' | 'query' | 'params',
): Array<{ field: string; message: string; code: string }> {
  return zodError.issues.map((issue: ZodIssue) => ({
    field: `${source}.${issue.path.join('.')}`,
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Primary validation middleware factory.
 *
 * Accepts a `ValidateOptions` object specifying which parts of the request to
 * validate (body, query, params). Returns Express middleware that:
 *
 * 1. Runs `safeParse` on each specified part to collect ALL validation errors
 *    (not just the first).
 * 2. On success, **replaces** `req.body` / `req.query` / `req.params` with the
 *    Zod-parsed output (handles coercion, defaults, and transforms).
 * 3. On failure, passes a `ValidationError` to `next()` with aggregated
 *    field-level errors from all sources.
 *
 * @param schemas - Object specifying which Zod schemas to validate against
 * @returns Express middleware function
 */
export function validate(
  schemas: ValidateOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const errors: Array<{ field: string; message: string; code: string }> = [];

    // Validate request body if schema provided
    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        errors.push(...formatZodErrors(result.error, 'body'));
      } else {
        // Replace req.body with parsed (coerced/transformed) data
        req.body = result.data;
      }
    }

    // Validate query parameters if schema provided
    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        errors.push(...formatZodErrors(result.error, 'query'));
      } else {
        // Replace req.query with parsed data — double assertion required
        // because Express types `req.query` as `ParsedQs` which is read-only
        // and does not overlap with `Record<string, unknown>` directly.
        (req as unknown as { query: unknown }).query = result.data;
      }
    }

    // Validate path parameters if schema provided
    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        errors.push(...formatZodErrors(result.error, 'params'));
      } else {
        req.params = result.data;
      }
    }

    // If any validation errors were collected, propagate ValidationError
    // to the global error handler via next()
    if (errors.length > 0) {
      next(new ValidationError('Validation failed', { fields: errors }));
      return;
    }

    next();
  };
}

/**
 * Convenience middleware factory for body-only validation.
 *
 * Equivalent to `validate({ body: schema })`. This is the most commonly used
 * form — applied to POST/PUT/PATCH endpoints that accept a JSON request body.
 *
 * @param schema - Zod schema to validate `req.body` against
 * @returns Express middleware function
 */
export function validateBody(
  schema: ZodSchema,
): (req: Request, res: Response, next: NextFunction) => void {
  return validate({ body: schema });
}

/**
 * Convenience middleware factory for params-only validation.
 *
 * Equivalent to `validate({ params: schema })`. Applied to routes with
 * dynamic URL segments (e.g. `/conversations/:id`).
 *
 * @param schema - Zod schema to validate `req.params` against
 * @returns Express middleware function
 */
export function validateParams(
  schema: ZodSchema,
): (req: Request, res: Response, next: NextFunction) => void {
  return validate({ params: schema });
}

/**
 * Convenience middleware factory for query-only validation.
 *
 * Equivalent to `validate({ query: schema })`. Applied to GET endpoints with
 * pagination, filtering, or search query parameters.
 *
 * @param schema - Zod schema to validate `req.query` against
 * @returns Express middleware function
 */
export function validateQuery(
  schema: ZodSchema,
): (req: Request, res: Response, next: NextFunction) => void {
  return validate({ query: schema });
}
