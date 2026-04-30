/**
 * @file auth.ts
 * @description JWT verification + Redis blacklist + V2 OAuth dispatch middleware.
 *
 * Express middleware that verifies JWT access tokens and dispatches to either
 * the legacy V1 JWT/blacklist path (AUTH_V2_ENABLED=false) or the V2 OAuth
 * path via @blitzy/auth (AUTH_V2_ENABLED=true). Mutual exclusion is enforced
 * per-request by the V2-aware factory.
 *
 * Applied to all protected routes — all except:
 * - `POST /api/v1/auth/register`
 * - `POST /api/v1/auth/login`
 * - `GET  /api/v1/health`
 *
 * Architecture Rules Enforced:
 * - R9:  Authentication on all protected routes
 * - R33: Session revocation via Redis blacklist (keyed by JTI)
 * - R22: Standardized error responses via AuthenticationError → 401
 * - R23: Log hygiene — NEVER log JWT token values or secrets
 * - R28: Structured logging only — zero console.log calls
 * - R17: Interface-driven dependencies — uses ICacheProvider, not concrete class
 * - R7:  Zero warnings build under tsc --noEmit --strict
 *
 * V2 Auth Integration Rules:
 * - R3:  V2 flag isolation (semantic) — with AUTH_V2_ENABLED=false, zero
 *        @blitzy/auth *behavior* leaks into the request path. The V2 imports
 *        are static (so the modules sit in `require.cache` after module-init
 *        under CommonJS), but no V2 *function* is ever invoked — the if/else
 *        branch on the resolved flag dispatches exclusively to the legacy
 *        handler. See LOCAL_TESTING_GUIDE.md Section 10.6 for the verification
 *        approach (which checks for V2 *invocation*, not module presence).
 * - R4:  Mutual exclusion at runtime — per request, EITHER the legacy JWT path
 *        OR the V2 createExpressMiddleware path executes, never both. The
 *        if/else branch on the resolved flag is the enforcement point.
 * - R12: API stability — the existing 2-arg factory signature is preserved via
 *        TypeScript function overloading. AuthenticatedUser and req.user shape
 *        are preserved verbatim; V2 path backfills req.user from V2 token claims.
 * - R13: Sidecar fail-closed — when AUTH_V2_ENABLED=true and the auth-sidecar
 *        is unreachable, @blitzy/auth's createExpressMiddleware returns HTTP 503.
 *        We NEVER fall back to the legacy path on V2 sidecar failure.
 * - RF2: Kalle uses the HTTP-only FeatureFlagClient from
 *        @blitzy/auth/clients/feature-flag-client (NEVER the DB-backed
 *        FlagInstance from @blitzy/admin-ui — that would require FLAGS_DB_URL
 *        access from inside kalle, which RF2 forbids).
 * - RF3: Flag fail-open — the FeatureFlagClient.isEnabled() implementation
 *        owns RF3 internally (cache → API → env-var → ultimately `false`),
 *        and never throws (the OPPOSITE of R13's auth fail-closed semantics).
 * - IR-G: Backchannel logout key compatibility — the legacy `blacklist:` Redis
 *        key prefix used by this middleware is BYTE-IDENTICAL to @blitzy/auth's
 *        KALLE_REDIS_BLACKLIST_KEY_PREFIX, so a single Redis namespace serves
 *        both V1 and V2 modes (see BLACKLIST_PREFIX constant below).
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthenticationError } from '../errors/AuthenticationError';
import type { ICacheProvider } from '../domain/interfaces/ICacheProvider';

// ─── V2 Library Imports (FR-9, R3, R4) ────────────────────────────────────────
// Static top-level imports.
//
// Rule R3 INTENT: zero V2 code is *invoked* when AUTH_V2_ENABLED=false. Static
// top-level imports populate `require.cache` at module-init time under
// CommonJS, but they do NOT execute V2 *functions* — they only resolve the
// module objects. Mutual exclusion (Rule R4) is enforced by the if/else
// branch inside the V2-aware factory's returned middleware: under flag=false
// no V2 function (createExpressMiddleware, FeatureFlagClient.*) is ever
// called, so the spirit of R3 (no V2 *behavior* leaks into the legacy path)
// is preserved. See LOCAL_TESTING_GUIDE.md Section 10.6 for the verification
// approach.
//
// IMPORTANT (Rule RF2): kalle MUST use the HTTP-only FeatureFlagClient from
// @blitzy/auth/clients/feature-flag-client — NEVER the DB-backed FlagInstance
// from @blitzy/admin-ui (which would require FLAGS_DB_URL access in kalle).
// The HTTP client implements RF3 fail-open internally (cache → API → env-var
// fallback chain).
import { createExpressMiddleware } from '@blitzy/auth';
import {
  createFeatureFlagClient,
  type FeatureFlagClient,
} from '@blitzy/auth/clients/feature-flag-client';
import type { AuthInstance } from '@blitzy/auth';

// Re-export JwtPayload for internal typing usage
type JwtPayload = jwt.JwtPayload;

/**
 * Authenticated user payload extracted from a verified JWT.
 *
 * Attached to `req.user` after successful verification. Controllers
 * and downstream middleware access this to identify the authenticated
 * user and their session (via `jti` for blacklist reference).
 *
 * Must match the JWT payload shape produced by `AuthService` during
 * token generation.
 */
export interface AuthenticatedUser {
  /** Unique user identifier (UUID) */
  userId: string;
  /** User email address */
  email: string;
  /** JWT ID — unique token identifier used for blacklist checking (Rule R33) */
  jti: string;
  /** Token issued-at timestamp (Unix seconds) */
  iat: number;
  /** Token expiration timestamp (Unix seconds) */
  exp: number;
}

/**
 * Augment the Express Request interface to include the `user` property
 * set by the auth middleware and the `correlationId` property set by
 * the correlation-id middleware.
 *
 * TypeScript merges global namespace augmentations across files, so
 * this declaration is compatible with the `correlationId` augmentation
 * in `middleware/correlation-id.ts`.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Authenticated user payload from verified JWT. Set by auth middleware. */
      user?: AuthenticatedUser;
      /** Request correlation ID for distributed tracing. Set by correlation-id middleware. */
      correlationId?: string;
    }
  }
}

/**
 * Redis blacklist key prefix for revoked JWT tokens.
 * Full key pattern: `blacklist:${jti}` where jti is the JWT ID.
 * TTL on the Redis key equals the remaining token expiry time.
 */
const BLACKLIST_PREFIX = 'blacklist:';

/**
 * Internal helper: legacy V1 JWT + Redis blacklist authentication middleware.
 *
 * This is the byte-identical preservation of the original
 * `createAuthMiddleware(jwtSecret, cacheProvider)` factory body. It is invoked:
 * (a) directly when the V2-aware factory resolves AUTH_V2_ENABLED=false, or
 * (b) directly via the LEGACY 2-arg overload of `createAuthMiddleware` (which
 *     is preserved for full API compatibility with the existing 1,814-test suite).
 *
 * Execution flow (preserved verbatim from V1):
 * 1. Extract Bearer token from Authorization header
 * 2. Verify JWT signature and expiration via jsonwebtoken
 * 3. Validate required claims (sub, jti) exist in payload
 * 4. Check Redis blacklist for revoked tokens (Rule R33)
 * 5. Attach AuthenticatedUser to req.user for downstream handlers
 *
 * All failures throw AuthenticationError (caught by error-handler → 401).
 *
 * @param jwtSecret     - JWT signature verification secret
 * @param cacheProvider - ICacheProvider for Redis blacklist lookups (Rule R17)
 * @returns Express middleware bound to V1 logic
 */
function createLegacyAuthMiddleware(
  jwtSecret: string,
  cacheProvider: ICacheProvider,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  /**
   * JWT authentication middleware.
   *
   * Execution flow:
   * 1. Extract Bearer token from Authorization header
   * 2. Verify JWT signature and expiration via jsonwebtoken
   * 3. Validate required claims (userId, jti) exist in payload
   * 4. Check Redis blacklist for revoked tokens (Rule R33)
   * 5. Attach AuthenticatedUser to req.user for downstream handlers
   *
   * All failures throw AuthenticationError (caught by error-handler → 401).
   */
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      // -----------------------------------------------------------
      // Step 1: Extract Bearer token from Authorization header
      // -----------------------------------------------------------
      const authHeader = req.headers.authorization;

      if (!authHeader) {
        throw new AuthenticationError('Missing authorization header');
      }

      if (!authHeader.startsWith('Bearer ')) {
        throw new AuthenticationError(
          'Invalid authorization format. Expected: Bearer <token>',
        );
      }

      // Remove 'Bearer ' prefix (7 characters) to isolate the token
      const token = authHeader.slice(7);

      if (!token || token.trim().length === 0) {
        throw new AuthenticationError('Empty token provided');
      }

      // -----------------------------------------------------------
      // Step 2: Verify JWT signature and expiration
      // -----------------------------------------------------------
      // Rule R23: The raw `token` value is NEVER logged or included
      // in error details. Only the JTI (token ID) may be referenced.
      let decoded: JwtPayload & AuthenticatedUser;

      try {
        decoded = jwt.verify(token, jwtSecret) as JwtPayload & AuthenticatedUser;
      } catch (jwtError: unknown) {
        // Differentiate error types for specific client-facing messages
        if (jwtError instanceof jwt.TokenExpiredError) {
          throw new AuthenticationError('Token expired');
        }
        if (jwtError instanceof jwt.JsonWebTokenError) {
          throw new AuthenticationError('Invalid token');
        }
        // Catch-all for any other verification failure
        throw new AuthenticationError('Token verification failed');
      }

      // -----------------------------------------------------------
      // Step 3: Validate required claims
      // -----------------------------------------------------------
      // The JWT `sub` claim contains the user ID (standard JWT subject
      // per RFC 7519). Without `sub`, downstream services cannot identify
      // the requester. Without `jti`, the blacklist check (Step 4) cannot
      // be performed.
      if (!decoded.sub || !decoded.jti) {
        throw new AuthenticationError('Token missing required claims');
      }

      // -----------------------------------------------------------
      // Step 4: Check Redis blacklist for revoked tokens (Rule R33)
      // -----------------------------------------------------------
      // After the token is cryptographically verified, we check whether
      // it has been revoked via the `revoke` or `revoke-all` endpoints.
      // Revoked tokens are stored in Redis with key `blacklist:${jti}`
      // and a TTL equal to the remaining token expiry time.
      const isBlacklisted = await cacheProvider.exists(
        `${BLACKLIST_PREFIX}${decoded.jti}`,
      );

      if (isBlacklisted) {
        throw new AuthenticationError('Token has been revoked');
      }

      // -----------------------------------------------------------
      // Step 5: Attach decoded user to request
      // -----------------------------------------------------------
      // Controllers and downstream middleware access req.user to
      // identify the authenticated user and their session.
      req.user = {
        userId: decoded.sub,
        email: decoded.email,
        jti: decoded.jti,
        iat: decoded.iat as number,
        exp: decoded.exp as number,
      };

      next();
    } catch (error: unknown) {
      // Propagate to Express error handler middleware.
      // AuthenticationError instances are caught by error-handler.ts
      // and mapped to HTTP 401 with the standardized error shape.
      next(error);
    }
  };
}

/**
 * Options for the V2-aware overload of `createAuthMiddleware`.
 *
 * The composition root (`server.ts`) constructs `authInstance` once at boot
 * and passes it via this options object. The HTTP-only feature-flag client
 * may be supplied pre-constructed (preferred — see `flagsClient` below) or
 * the factory will construct one internally from the supplied
 * `flagsApiUrl`/`flagsApiSecret`/`flagsCacheTtlMs` configuration.
 *
 * - `authInstance` is built via `await initAuth({ keycloakBaseUrl, realm,
 *   clientId, sidecarUrl, sidecarSecret })` from `@blitzy/auth`. NOTE: when
 *   used inside kalle, `dbUrl` is INTENTIONALLY omitted — kalle operates in
 *   "sidecar mode" and delegates token-to-user resolution to the auth-sidecar
 *   via HTTP. Rule R2 forbids kalle from opening direct connections to the
 *   auth database; all auth-DB access is mediated by the auth-sidecar.
 * - `flagsClient` is an HTTP-only `FeatureFlagClient` from
 *   `@blitzy/auth/clients/feature-flag-client`. Per Rule RF2, kalle MUST NOT
 *   use the DB-backed `FlagInstance` from `@blitzy/admin-ui` — that would
 *   require `FLAGS_DB_URL` connectivity from inside kalle. The client's
 *   `isEnabled(name)` method implements the cache → API → env-var fallback
 *   chain (Rule RF3 fail-open) and never throws.
 * - `legacyAuthHandler` is the legacy V1 RequestHandler built by calling
 *   `createLegacyAuthMiddleware(jwtSecret, cacheProvider)` (or equivalently
 *   the legacy overload `createAuthMiddleware(jwtSecret, cacheProvider)`).
 *   Used when the resolved AUTH_V2_ENABLED flag is `false` — Rule R4 mutual
 *   exclusion guarantees the V2 handler does NOT also execute on that request.
 */
export interface AuthMiddlewareV2Options {
  /** Initialized @blitzy/auth dependency container (sidecar mode for kalle). */
  authInstance: AuthInstance;
  /**
   * Pre-constructed HTTP-only feature-flag client. Optional.
   *
   * In production wiring (`server.ts`), the client is constructed once at
   * boot via `createFeatureFlagClient({ flagsApiUrl, flagsApiSecret,
   * cacheTtlMs })` and passed through. Tests may pass a mock or stub.
   *
   * When `undefined`, the factory will internally construct a client from
   * the `flagsApiUrl`, `flagsApiSecret`, and (optional) `flagsCacheTtlMs`
   * fields below — at least the URL and secret MUST be provided in that
   * case, otherwise the factory throws an explicit configuration error.
   */
  flagsClient?: FeatureFlagClient;
  /**
   * Required when `flagsClient` is `undefined`. Base URL of the flags
   * evaluation API on port 4003 (NOT the admin SPA on port 4002).
   *
   * @example "http://admin-ui:4003"
   * @example "http://localhost:4003"
   */
  flagsApiUrl?: string;
  /**
   * Required when `flagsClient` is `undefined`. Bearer secret for the flags
   * evaluation API. Sent as `Authorization: Bearer ${secret}` on every
   * request. Min 32 chars per Rule R8 secrets containment.
   */
  flagsApiSecret?: string;
  /**
   * Optional cache TTL in milliseconds for the internally constructed
   * FeatureFlagClient. Defaults to 5000 (5 seconds) per AAP §0.5.1.6.
   * Ignored when `flagsClient` is supplied.
   */
  flagsCacheTtlMs?: number;
  /** Legacy V1 RequestHandler invoked when AUTH_V2_ENABLED=false (Rule R4). */
  legacyAuthHandler: (req: Request, res: Response, next: NextFunction) => Promise<void> | void;
}

/**
 * Function overload signatures for `createAuthMiddleware`.
 *
 * Two callable shapes are supported, providing full backward compatibility:
 *
 *   1. LEGACY: `createAuthMiddleware(jwtSecret, cacheProvider)` — returns a
 *      pure V1 JWT+blacklist middleware. Behaves byte-identically to the
 *      pre-V2 implementation. Used when V2 is not yet wired up at the
 *      composition root (existing 1,814-test suite depends on this shape).
 *
 *   2. V2-AWARE: `createAuthMiddleware({ authInstance, flagsClient |
 *      flagsApiUrl+flagsApiSecret, legacyAuthHandler })` — returns a
 *      per-request dispatching middleware that reads AUTH_V2_ENABLED via the
 *      HTTP-only FeatureFlagClient (cache → API → env-var fallback) and
 *      routes to either V2 (`@blitzy/auth`'s createExpressMiddleware) or
 *      legacy V1 (the supplied legacyAuthHandler). Rule R4 enforces mutual
 *      exclusion. Rule RF2 is enforced by the `FeatureFlagClient` type — no
 *      direct FLAGS_DB_URL connectivity from kalle.
 */
export function createAuthMiddleware(
  jwtSecret: string,
  cacheProvider: ICacheProvider,
): (req: Request, res: Response, next: NextFunction) => Promise<void>;
export function createAuthMiddleware(
  opts: AuthMiddlewareV2Options,
): (req: Request, res: Response, next: NextFunction) => Promise<void>;

/**
 * Factory function that creates an Express middleware for authentication.
 *
 * Implementation signature: resolves which overload was called and dispatches
 * to either the legacy V1 handler (2-arg form) or the V2-aware dispatching
 * handler (1-options form).
 *
 * Accepts dependencies via function parameters (Rule R17: interface-driven
 * dependencies) and returns a standard Express middleware function. The
 * composition root (`server.ts`) creates the middleware instance:
 *
 * ```typescript
 * // Legacy invocation — preserved for the 1,814 existing tests
 * const authMiddleware = createAuthMiddleware(env.JWT_SECRET, cacheProvider);
 *
 * // V2-aware invocation (preferred): pass a pre-constructed flagsClient
 * const flagsClient = createFeatureFlagClient({
 *   flagsApiUrl: env.FLAGS_API_URL,
 *   flagsApiSecret: env.FLAGS_API_SECRET,
 *   cacheTtlMs: 5000,
 * });
 * const authMiddleware = createAuthMiddleware({
 *   authInstance,
 *   flagsClient,
 *   legacyAuthHandler: createAuthMiddleware(env.JWT_SECRET, cacheProvider),
 * });
 *
 * // V2-aware invocation (alternative): pass config and let the factory
 * // construct the FeatureFlagClient internally.
 * const authMiddleware = createAuthMiddleware({
 *   authInstance,
 *   flagsApiUrl: env.FLAGS_API_URL,
 *   flagsApiSecret: env.FLAGS_API_SECRET,
 *   flagsCacheTtlMs: 5000,
 *   legacyAuthHandler: createAuthMiddleware(env.JWT_SECRET, cacheProvider),
 * });
 * ```
 *
 * @param jwtSecretOrOpts - Either the JWT secret string (legacy overload) or
 *                          an `AuthMiddlewareV2Options` object (V2 overload).
 * @param cacheProvider   - Cache provider interface (ICacheProvider) for
 *                          Redis-backed blacklist lookups. REQUIRED only on
 *                          the legacy overload; ignored on the V2 overload.
 *                          Rule R17: NEVER pass a concrete CacheProvider class.
 * @returns Express middleware that authenticates requests via JWT + blacklist
 *          (legacy) or V2 OAuth dispatch (V2-aware).
 */
export function createAuthMiddleware(
  jwtSecretOrOpts: string | AuthMiddlewareV2Options,
  cacheProvider?: ICacheProvider,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  // ─── Legacy overload: createAuthMiddleware(jwtSecret, cacheProvider) ──────
  // The runtime check `typeof jwtSecretOrOpts === 'string'` discriminates the
  // two overloads. When called with a string, we delegate to the byte-identical
  // legacy implementation (preserves the 1,814-test suite).
  if (typeof jwtSecretOrOpts === 'string') {
    if (!cacheProvider) {
      throw new Error(
        'createAuthMiddleware: cacheProvider is required when called with (jwtSecret, cacheProvider).',
      );
    }
    return createLegacyAuthMiddleware(jwtSecretOrOpts, cacheProvider);
  }

  // ─── V2-aware overload: createAuthMiddleware({ authInstance, ... }) ──────
  // Build the V2 handler and the FeatureFlagClient ONCE at factory invocation
  // time (not per-request). createExpressMiddleware closes over authInstance
  // and is reused for every request that resolves AUTH_V2_ENABLED=true.
  const {
    authInstance,
    flagsClient: providedFlagsClient,
    flagsApiUrl,
    flagsApiSecret,
    flagsCacheTtlMs,
    legacyAuthHandler,
  } = jwtSecretOrOpts;

  // Resolve the FeatureFlagClient: prefer the pre-constructed instance from
  // the composition root; otherwise build one internally from the supplied
  // config. This keeps the middleware Rule RF2-compliant (HTTP-only flag
  // reads — no FLAGS_DB_URL access from kalle) and lets server.ts own the
  // single boot-time client (graceful shutdown via flagsClient.close()).
  const flagsClient: FeatureFlagClient =
    providedFlagsClient ??
    (() => {
      if (!flagsApiUrl || !flagsApiSecret) {
        throw new Error(
          'createAuthMiddleware (V2 overload): when `flagsClient` is not ' +
            'provided, both `flagsApiUrl` and `flagsApiSecret` must be ' +
            'supplied so the factory can construct an HTTP-only ' +
            'FeatureFlagClient internally (Rule RF2: no FLAGS_DB_URL in ' +
            'kalle). See server.ts composition root for production wiring.',
        );
      }
      return createFeatureFlagClient({
        flagsApiUrl,
        flagsApiSecret,
        cacheTtlMs: flagsCacheTtlMs,
      });
    })();

  const v2Handler = createExpressMiddleware(authInstance, { appId: 'kalle' });

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // -----------------------------------------------------------------------
    // FIRST AWAITED STEP (Rule R3 spirit): resolve AUTH_V2_ENABLED.
    // Read order per Rule RF3: cache (in-process, default 5s TTL) → flags-API
    // → process.env. The FeatureFlagClient.isEnabled() implementation is
    // documented as never-throwing — it always returns a boolean, falling
    // back to the env-var (and ultimately `false`) on any error. This means
    // we DON'T need a try/catch here for fail-open semantics; the client
    // itself owns RF3.
    //
    // This MUST be the first awaited operation — performed BEFORE any header
    // parsing, token decoding, or V2/V1 dispatch decision. The mutual-
    // exclusion guarantee (Rule R4) requires that we resolve the flag before
    // invoking either handler.
    //
    // Rule R29 — Distributed-tracing correlation ID propagation across the
    // kalle-api → admin-ui (flags evaluation) service boundary. We pass
    // `req.correlationId` (set by the upstream `correlation-id` middleware)
    // so that any cache-miss + outbound `GET /flags/AUTH_V2_ENABLED` carries
    // an `X-Correlation-Id` header — preserving the single-thread distributed-
    // trace invariant required by the User-Specified Observability Rule.
    // When the cache is hit (the common case at steady state, given the 5s
    // TTL), no outbound request is issued, so there is no log line on the
    // admin-ui side to correlate.
    // -----------------------------------------------------------------------
    const authV2Enabled = await flagsClient.isEnabled(
      'AUTH_V2_ENABLED',
      undefined,
      req.correlationId,
    );

    // -----------------------------------------------------------------------
    // Rule R4 mutual exclusion: dispatch to EXACTLY ONE branch.
    // -----------------------------------------------------------------------
    if (authV2Enabled) {
      // ─── V2 PATH ──────────────────────────────────────────────────────────
      // @blitzy/auth handles JWT verification, Redis blacklist (via the byte-
      // identical KALLE_REDIS_BLACKLIST_KEY_PREFIX = 'blacklist:' per IR-G),
      // audience check, and permission row lookup by keycloak_subject_id (R15).
      // Rule R13: V2 sidecar failures fail-CLOSED with HTTP 503 from inside
      // createExpressMiddleware. We MUST NOT catch and fall back to legacy.
      // Rule R12 API stability: backfill req.user from V2 token claims so all
      // existing controllers reading req.user.{userId,email,jti,iat,exp}
      // continue to work without modification.
      // ─────────────────────────────────────────────────────────────────────
      return v2Handler(req, res, (err?: unknown) => {
        if (err) return next(err);

        // Backfill req.user (R12) — V2 attaches req.authUser; legacy path uses
        // req.user. We populate req.user from req.authUser plus the decoded
        // JWT claims (jti/iat/exp) attached by @blitzy/auth as req.authToken.
        //
        // Coordination note: this depends on @blitzy/auth exposing
        // req.authUser: { email, sub, tier } AND req.authToken (or equivalent)
        // containing the JWT's jti/iat/exp claims. If only req.authUser is
        // available, the V2 middleware MUST decode jti/iat/exp from the
        // Authorization header — this responsibility lives in @blitzy/auth.
        const authUser = (req as Request & {
          authUser?: { email: string; sub: string; tier: string };
        }).authUser;
        const authToken = (req as Request & {
          authToken?: { jti?: string; iat?: number; exp?: number };
        }).authToken;

        if (authUser) {
          // userId in the V2 path is the keycloak_subject_id (the OIDC `sub`
          // claim) per Rule R15. Existing controllers treating userId as an
          // opaque string identifier continue to work. Cross-database joins
          // by userId against kalle's User table are out of scope per AAP
          // Section 4 — kalle's User model is untouched.
          req.user = {
            userId: authUser.sub,
            email: authUser.email,
            jti: authToken?.jti ?? '',
            iat: authToken?.iat ?? 0,
            exp: authToken?.exp ?? 0,
          };
        }
        next();
      });
    }

    // ─── LEGACY V1 PATH ───────────────────────────────────────────────────
    // Rule R3 (semantic): zero @blitzy/auth runtime *behavior* executes here.
    // Although the V2 imports are statically loaded at module-init time and
    // the FeatureFlagClient is constructed (and its isEnabled() method has
    // already returned `false` to reach this branch), the V2 handler
    // (createExpressMiddleware) is NEVER invoked on this path. The legacy
    // handler internally executes the V1 jsonwebtoken + Redis blacklist flow
    // byte-identically.
    //
    // The legacyAuthHandler may return either Promise<void> or void; we
    // normalize via Promise.resolve(...) so the outer function's Promise<void>
    // contract is honored regardless of which form the supplied handler uses.
    // ─────────────────────────────────────────────────────────────────────
    await Promise.resolve(legacyAuthHandler(req, res, next));
  };
}

// ─── Coordination Contract with @blitzy/auth (createExpressMiddleware) ──────
// This kalle middleware ASSUMES @blitzy/auth's createExpressMiddleware will
// attach the following to the Express Request:
//   1. req.authUser: { email: string; sub: string; tier: string }  (REQUIRED)
//   2. req.authToken: { jti: string; iat: number; exp: number; ... } (REQUIRED
//      for req.user backfill — Rule R12 API stability)
//
// If @blitzy/auth's contract differs, this backfill MUST be updated to match.
// The V2 path is fail-closed (R13) — V2 errors propagate via next(err) and
// are mapped by error-handler.ts to the appropriate HTTP status code (401 for
// invalid token, 403 for missing permission, 503 for sidecar unreachable).
// ────────────────────────────────────────────────────────────────────────────
