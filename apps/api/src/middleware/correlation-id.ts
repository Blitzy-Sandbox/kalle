import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Augment the Express Request interface to include the correlationId property.
 *
 * This augmentation is also declared in middleware/auth.ts (with additional
 * properties like `user`). TypeScript merges global namespace augmentations,
 * so declaring `correlationId` here ensures this middleware compiles
 * independently regardless of processing order while remaining fully
 * compatible when both declarations are present.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

/**
 * Correlation ID header name used for both request extraction and response
 * header assignment. Centralised to avoid duplication and typo risk.
 */
const CORRELATION_ID_HEADER = 'X-Correlation-ID';

/**
 * Maximum allowed length for a client-provided correlation ID.
 * Prevents log injection and resource abuse from excessively long headers.
 */
const MAX_CORRELATION_ID_LENGTH = 128;

/**
 * Regular expression defining valid correlation ID characters.
 * Allows UUID-style IDs (hexadecimal + dashes), plus underscores, dots,
 * colons, and alphanumeric characters. Rejects HTML/script characters
 * such as `<`, `>`, `"`, `'`, `&` to prevent XSS reflection when the
 * correlation ID appears in JSON error responses or HTTP headers.
 */
const SAFE_CORRELATION_ID_PATTERN = /^[a-zA-Z0-9\-_.:]+$/;

/**
 * Express middleware that assigns a UUID v4 correlation ID to every incoming
 * HTTP request. This is the **first step** in the correlation ID propagation
 * chain defined by Rule R29:
 *
 * ```
 * 1. correlationIdMiddleware   → assigns req.correlationId, sets response header
 * 2. loggerMiddleware (pino)   → uses req.correlationId as the log request ID
 * 3. Controller handlers       → pass req.correlationId to service methods
 * 4. Services                  → include correlationId in BullMQ job payloads
 * 5. Error handler             → includes correlationId in error response body
 * 6. WebSocket handlers        → extract correlationId from event metadata
 * ```
 *
 * **Client-provided ID support:**
 * If the client sends an `X-Correlation-ID` request header (e.g. for
 * cross-service tracing or retry correlation), the middleware reuses it.
 * Otherwise, a fresh UUID v4 is generated. This supports both
 * frontend-initiated and server-initiated correlation.
 *
 * **Ordering requirement:**
 * This middleware MUST be registered in the Express chain *before* the
 * pino-http logger middleware so that `req.correlationId` is available
 * when `genReqId` produces the log entry's request identifier.
 *
 * @param req  - Express request object; used to read the incoming header
 *               and attach `req.correlationId` for downstream consumers.
 * @param res  - Express response object; used to set the `X-Correlation-ID`
 *               response header (exposed to the browser via CORS
 *               `exposedHeaders` configured in `config/cors.ts`).
 * @param next - Express next function; always invoked to continue the
 *               middleware chain. This middleware never short-circuits.
 */
export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // ------------------------------------------------------------------
  // Step 1: Extract any client-supplied correlation ID from the request
  // header. Express normalises header names to lower-case, so we use
  // the lower-case key for reading. The value can be a string, an array
  // of strings (when the header appears multiple times), or undefined.
  // ------------------------------------------------------------------
  const headerValue = req.headers['x-correlation-id'];
  const existingCorrelationId: string | undefined = Array.isArray(headerValue)
    ? headerValue[0]
    : headerValue;

  // ------------------------------------------------------------------
  // Step 2: Validate the existing value — accept only non-empty strings
  // composed of safe characters (alphanumeric, dash, underscore, dot,
  // colon) within a reasonable length limit. If the header is present
  // but blank, too long, or contains unsafe characters (e.g. `<script>`),
  // discard it and generate a fresh UUID v4 to prevent XSS reflection
  // in JSON error responses and log output.
  // ------------------------------------------------------------------
  const trimmedExisting =
    typeof existingCorrelationId === 'string'
      ? existingCorrelationId.trim()
      : '';

  const isValidExisting =
    trimmedExisting.length > 0 &&
    trimmedExisting.length <= MAX_CORRELATION_ID_LENGTH &&
    SAFE_CORRELATION_ID_PATTERN.test(trimmedExisting);

  const correlationId: string = isValidExisting
    ? trimmedExisting
    : uuidv4();

  // ------------------------------------------------------------------
  // Step 3: Attach the correlation ID to the request object for
  // downstream middleware and route handlers. All consumers (logger,
  // error-handler, controllers, QueueProvider) read from req.correlationId.
  // ------------------------------------------------------------------
  req.correlationId = correlationId;

  // ------------------------------------------------------------------
  // Step 4: Set the correlation ID on the response so the frontend
  // (and any intermediary proxy) can read it. The CORS configuration in
  // config/cors.ts includes this header in both `allowedHeaders` and
  // `exposedHeaders`.
  // ------------------------------------------------------------------
  res.setHeader(CORRELATION_ID_HEADER, correlationId);

  // ------------------------------------------------------------------
  // Always continue to the next middleware — this middleware never
  // terminates the request/response cycle.
  // ------------------------------------------------------------------
  next();
}
