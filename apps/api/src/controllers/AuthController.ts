/**
 * @file AuthController.ts
 * @description Thin delegation controller for the authentication lifecycle.
 *
 * Handles user registration (email+password, NOT phone OTP per AAP 0.8.2),
 * login, JWT token refresh with rotation, single session revocation, and
 * all-sessions force logout.
 *
 * This controller receives {@link AuthService} via constructor injection (R17)
 * and delegates ALL authentication business logic to it (R16). The controller:
 * - Extracts request parameters (body, user, authorization header)
 * - Delegates to AuthService methods
 * - Formats and returns HTTP responses
 * - Forwards errors to the global error handler via next(error)
 *
 * Endpoints:
 * - `POST /api/v1/auth/register`    → {@link AuthController.register}   (PUBLIC)
 * - `POST /api/v1/auth/login`       → {@link AuthController.login}      (PUBLIC)
 * - `POST /api/v1/auth/refresh`     → {@link AuthController.refresh}    (with refresh token)
 * - `POST /api/v1/auth/revoke`      → {@link AuthController.revoke}     (authenticated)
 * - `POST /api/v1/auth/revoke-all`  → {@link AuthController.revokeAll}  (authenticated)
 *
 * Architecture Rules Enforced:
 * - R16 (Thin Delegation): ZERO business logic — no password hashing, no JWT
 *   signing, no blacklist management, no token validation.
 * - R17 (Constructor Injection): `new AuthController(authService)` wired in
 *   the composition root (server.ts).
 * - R9  (Auth on Protected Routes): `register` and `login` are PUBLIC (no auth
 *   middleware). `refresh`, `revoke`, `revokeAll` require authentication.
 * - R33 (Session Revocation): Revoked tokens blacklisted in Redis (by JTI).
 *   `revoke` invalidates single session. `revokeAll` invalidates ALL active
 *   sessions. ALL handled by AuthService — controller only delegates.
 * - R22 (Standardized Error Responses): Errors thrown as typed DomainError
 *   subclasses, caught by the global error handler middleware.
 * - R23 (Log Hygiene): NEVER logs passwords, JWT tokens, or refresh tokens.
 * - R28 (Structured Logging Only): ZERO console.log/warn/error calls.
 * - R31 (Input Validation): Zod validation applied at route level — controller
 *   receives pre-validated request bodies.
 * - R7  (Zero Warnings Build): TypeScript strict mode with zero warnings.
 * - R29 (Correlation ID): Controller accesses `req.correlationId` for tracing.
 *
 * @see apps/api/src/services/AuthService.ts  — business logic implementation
 * @see apps/api/src/middleware/auth.ts        — JWT verification + blacklist check
 * @see apps/api/src/middleware/error-handler.ts — global error handler
 * @see packages/shared/src/types/auth.ts      — shared DTOs and response types
 * @see packages/shared/src/types/user.ts      — UserResponse interface
 */

import { Request, Response, NextFunction } from 'express';
import type { AuthService, RequestContext } from '../services/AuthService.js';
import type {
  RegisterDTO,
  LoginDTO,
  RefreshTokenDTO,
  AuthResponse,
  TokenPair,
} from '@kalle/shared';

// =============================================================================
// Helper — Extract RequestContext from Express Request
// =============================================================================

/**
 * Builds a {@link RequestContext} from the Express request to propagate
 * correlation ID, client IP, and user-agent into audit log entries (R29, R32).
 *
 * @param req - The Express request object (with correlationId set by middleware)
 * @returns A RequestContext with correlationId, ipAddress, and userAgent fields
 */
function extractRequestContext(req: Request): RequestContext {
  return {
    correlationId: req.correlationId,
    ipAddress: req.ip || req.socket?.remoteAddress || '',
    userAgent: req.headers['user-agent'] || '',
  };
}

// NOTE: AuthResponse.user conforms to a subset of the UserResponse interface
// from @kalle/shared/types/user (id, email, displayName, avatar, phoneNumber).
// UserResponse is not imported directly since AuthResponse already encapsulates
// the user shape and unused type imports trigger ESLint no-unused-vars errors.

// =============================================================================
// AuthController Class
// =============================================================================

/**
 * AuthController — thin delegation controller for authentication REST endpoints.
 *
 * All methods follow the same pattern:
 * 1. Extract parameters from the request (body, user, headers)
 * 2. Delegate to AuthService (zero business logic per R16)
 * 3. Return standardized JSON response wrapped in `{ data: ... }`
 * 4. Forward any errors to the global error handler via `next(error)`
 *
 * @example
 * ```typescript
 * // Composition root (server.ts):
 * const authController = new AuthController(authService);
 *
 * // Route registration (auth.routes.ts):
 * router.post('/register', validate(registerSchema), authController.register);
 * router.post('/login', validate(loginSchema), authController.login);
 * router.post('/refresh', validate(refreshSchema), authController.refresh);
 * router.post('/revoke', authMiddleware, authController.revoke);
 * router.post('/revoke-all', authMiddleware, authController.revokeAll);
 * ```
 */
export class AuthController {
  /**
   * Creates a new AuthController instance with injected dependencies.
   *
   * All methods are bound in the constructor to preserve `this` context
   * when used as Express route handler callbacks. Without binding,
   * `this.authService` would be `undefined` at runtime because Express
   * invokes handlers without the class context.
   *
   * @param authService - Authentication service for all auth business logic
   *   (R17: interface-driven DI). Provides register, login, refreshToken,
   *   revokeSession, and revokeAllSessions operations.
   */
  constructor(private readonly authService: AuthService) {
    // Bind ALL methods to preserve `this` context when used as Express
    // route handler callbacks. Without this, `this.authService` would be
    // `undefined` at runtime since Express invokes handlers without
    // the class instance context.
    this.register = this.register.bind(this);
    this.login = this.login.bind(this);
    this.refresh = this.refresh.bind(this);
    this.revoke = this.revoke.bind(this);
    this.revokeAll = this.revokeAll.bind(this);
  }

  // ---------------------------------------------------------------------------
  // Public Endpoints (No Auth Required)
  // ---------------------------------------------------------------------------

  /**
   * Register a new user account.
   *
   * Maps to: `POST /api/v1/auth/register` (PUBLIC — no auth middleware)
   *
   * Extracts the pre-validated {@link RegisterDTO} from the request body and
   * delegates to {@link AuthService.register}. The service handles password
   * hashing (bcrypt), user creation, JWT token generation, session persistence,
   * and audit logging (R32: USER_REGISTER).
   *
   * The response contains a sanitized user profile conforming to a subset of
   * the {@link _UserResponse} interface (no password hash per R23) alongside
   * a fresh {@link TokenPair} for immediate API access.
   *
   * Response: `201 Created` with `{ data: AuthResponse }`
   *
   * Error cases (handled by AuthService → global error handler):
   * - `409 Conflict`: Email already registered (ConflictError)
   * - `400 Bad Request`: Invalid input (ValidationError from Zod at route level)
   *
   * @param req  - Express request with validated RegisterDTO body
   * @param res  - Express response — returns 201 with `{ data: AuthResponse }`
   * @param next - Express next function for error propagation to global handler
   */
  async register(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const dto: RegisterDTO = req.body as RegisterDTO;
      const context: RequestContext = extractRequestContext(req);
      const result: AuthResponse = await this.authService.register(dto, context);
      res.status(201).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Authenticate a user via email + password credentials.
   *
   * Maps to: `POST /api/v1/auth/login` (PUBLIC — no auth middleware)
   *
   * Extracts the pre-validated {@link LoginDTO} from the request body and
   * delegates to {@link AuthService.login}. The service verifies credentials
   * (email lookup + bcrypt compare), generates tokens, creates a session,
   * and writes audit log entries (R32: USER_LOGIN on success,
   * USER_LOGIN_FAILED on failure).
   *
   * Response: `200 OK` with `{ data: AuthResponse }`
   *
   * Error cases (handled by AuthService → global error handler):
   * - `401 Unauthorized`: Invalid credentials (AuthenticationError)
   * - `400 Bad Request`: Invalid input (ValidationError from Zod at route level)
   *
   * @param req  - Express request with validated LoginDTO body
   * @param res  - Express response — returns 200 with `{ data: AuthResponse }`
   * @param next - Express next function for error propagation to global handler
   */
  async login(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const dto: LoginDTO = req.body as LoginDTO;
      const context: RequestContext = extractRequestContext(req);
      const result: AuthResponse = await this.authService.login(dto, context);
      res.status(200).json({ data: result });
    } catch (error) {
      next(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Token Management Endpoints (Auth Required)
  // ---------------------------------------------------------------------------

  /**
   * Exchange a refresh token for a new token pair (refresh token rotation).
   *
   * Maps to: `POST /api/v1/auth/refresh`
   *
   * Extracts the pre-validated {@link RefreshTokenDTO} from the request body and
   * delegates to {@link AuthService.refreshToken}. The service validates the
   * refresh token (not expired, not revoked), generates a new access + refresh
   * token pair, invalidates the old refresh token (one-time use per rotation
   * policy), blacklists the old session JTI in Redis (R33), and returns the
   * new pair.
   *
   * Response: `200 OK` with `{ data: { tokens: TokenPair } }`
   *
   * Error cases (handled by AuthService → global error handler):
   * - `401 Unauthorized`: Refresh token invalid, revoked, or expired
   *   (AuthenticationError)
   *
   * @param req  - Express request with validated RefreshTokenDTO body
   * @param res  - Express response — returns 200 with `{ data: { tokens } }`
   * @param next - Express next function for error propagation to global handler
   */
  async refresh(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const dto: RefreshTokenDTO = req.body as RefreshTokenDTO;
      const tokens: TokenPair = await this.authService.refreshToken(dto);
      res.status(200).json({ data: { tokens } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Revoke a single authentication session (current session logout).
   *
   * Maps to: `POST /api/v1/auth/revoke` (authenticated)
   *
   * Extracts the authenticated user's ID from `req.user` and the current
   * access token from the `Authorization: Bearer <token>` header. Delegates
   * to {@link AuthService.revokeSession} which:
   * 1. Extracts the JTI from the access token
   * 2. Verifies session ownership (must belong to requesting user)
   * 3. Blacklists the JTI in Redis with remaining TTL (R33)
   * 4. Revokes the session and associated refresh tokens in the database
   * 5. Writes an audit log entry (R32: SESSION_REVOKE)
   *
   * The access token is extracted from the Authorization header (already
   * verified by the auth middleware) rather than from the request body,
   * because the service uses jwt.verify/decode to extract the JTI for
   * blacklisting.
   *
   * Response: `200 OK` with `{ data: { message: string } }`
   *
   * Error cases (handled by AuthService → global error handler):
   * - `404 Not Found`: No session found for the token's JTI (NotFoundError)
   * - `401 Unauthorized`: Session doesn't belong to user (AuthenticationError)
   *
   * @param req  - Express request with authenticated user on `req.user`
   * @param res  - Express response — returns 200 with success message
   * @param next - Express next function for error propagation to global handler
   */
  async revoke(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId: string = req.user!.userId;

      // Extract the raw access token from the Authorization header.
      // The auth middleware has already verified this token and set req.user,
      // so the header is guaranteed to contain a valid Bearer token at this point.
      const authHeader: string = req.headers.authorization as string;
      const accessToken: string = authHeader.replace('Bearer ', '');

      const context: RequestContext = extractRequestContext(req);
      await this.authService.revokeSession(accessToken, userId, context);
      res
        .status(200)
        .json({ data: { message: 'Session revoked successfully' } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Revoke ALL active sessions for the authenticated user (force logout all).
   *
   * Maps to: `POST /api/v1/auth/revoke-all` (authenticated)
   *
   * Extracts the authenticated user's ID from `req.user` and delegates to
   * {@link AuthService.revokeAllSessions}. The service:
   * 1. Fetches ALL active (non-revoked, non-expired) sessions for the user
   * 2. Blacklists each session's JTI in Redis with remaining TTL (R33)
   * 3. Revokes all sessions and all refresh tokens in the database
   * 4. Writes an audit log entry (R32: SESSION_REVOKE_ALL)
   * 5. Returns count of revoked sessions
   *
   * This is the "nuclear option" — invalidates every active session across
   * all devices. The user must re-authenticate on every device.
   *
   * Response: `200 OK` with `{ data: { message: string, revokedCount: number } }`
   *
   * @param req  - Express request with authenticated user on `req.user`
   * @param res  - Express response — returns 200 with message and revoked count
   * @param next - Express next function for error propagation to global handler
   */
  async revokeAll(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const context: RequestContext = extractRequestContext(req);
      const revokedCount: number =
        await this.authService.revokeAllSessions(userId, context);
      res.status(200).json({
        data: {
          message: 'All sessions revoked successfully',
          revokedCount,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

// =============================================================================
// Exports
// =============================================================================

export default AuthController;
