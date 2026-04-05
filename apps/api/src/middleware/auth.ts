/**
 * @file auth.ts
 * @description JWT verification + Redis token blacklist check middleware.
 *
 * Express middleware that verifies JWT access tokens from the
 * `Authorization: Bearer <token>` header, checks the Redis-backed
 * blacklist for revoked tokens (by JTI), and attaches the decoded user
 * payload to `req.user` for downstream controllers and services.
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
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthenticationError } from '../errors/AuthenticationError';
import type { ICacheProvider } from '../domain/interfaces/ICacheProvider';

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
 * Factory function that creates an Express middleware for JWT authentication.
 *
 * Accepts dependencies via function parameters (Rule R17: interface-driven
 * dependencies) and returns a standard Express middleware function. The
 * composition root (`server.ts`) creates the middleware instance:
 *
 * ```typescript
 * const authMiddleware = createAuthMiddleware(env.JWT_SECRET, cacheProvider);
 * ```
 *
 * @param jwtSecret     - The secret key used to verify JWT signatures.
 *                        Obtained from validated environment config.
 * @param cacheProvider - Cache provider interface (ICacheProvider) for
 *                        checking the Redis-backed token blacklist.
 *                        Rule R17: NEVER pass a concrete CacheProvider class.
 * @returns Express middleware that authenticates requests via JWT + blacklist check.
 */
export function createAuthMiddleware(
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
