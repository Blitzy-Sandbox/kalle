/**
 * @module AuthService
 *
 * Authentication Service — Core Security Service
 *
 * Implements user registration, login, JWT token generation (access + refresh),
 * token refresh rotation, single-session revocation, and all-sessions revocation
 * with Redis-backed token blacklist.
 *
 * This is a critical security service — every design decision prioritises
 * security correctness. All five public methods are exercised by the
 * AuthController (thin delegation) and correspond to REST endpoints under
 * /api/v1/auth/*.
 *
 * Architecture Rules Enforced:
 * - R17: Interface-driven dependencies — all dependencies received via constructor
 *        injection typed as INTERFACES. Never imports concrete repository/provider classes.
 * - R16: ALL auth business logic resides here. Controllers are thin delegation layers.
 * - R33: Revoked access tokens blacklisted in Redis (keyed by JTI, TTL = remaining
 *        token expiry). Auth middleware checks blacklist on every request.
 *        `revokeAllSessions` invalidates every active session for a user.
 * - R23: Logs MUST NOT contain JWT tokens, passwords, password hashes, plaintext
 *        message content, encryption keys, or prekey material. Log only user IDs,
 *        action types, and correlation IDs.
 * - R28: Zero console.log / console.warn / console.error calls. Structured Pino
 *        logging is handled by the LoggerProvider — this service writes only to
 *        the audit log.
 * - R9:  Generates the JWT tokens that the auth middleware validates on every
 *        protected route.
 * - R7:  TypeScript strict mode, zero warnings.
 * - R22: Throws typed DomainError subclasses that the global error handler maps
 *        to standardised HTTP error responses.
 * - R32: Writes immutable audit log entries for security-sensitive auth actions:
 *        user.register, user.login, user.login_failed, session.revoke, session.revoke_all.
 *
 * @see apps/api/src/controllers/AuthController.ts  — thin delegation layer
 * @see apps/api/src/middleware/auth.ts              — JWT verification + blacklist check
 * @see apps/api/src/websocket/middleware/ws-auth.ts — WebSocket auth handshake
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Internal imports — interfaces (R17: code against interfaces only)
// ---------------------------------------------------------------------------

import type {
  IUserRepository,
  CreateUserData,
  UserWithPassword,
} from '../domain/interfaces/IUserRepository.js';

import type {
  ISessionRepository,
  CreateSessionData,
  SessionRecord,
  CreateRefreshTokenData,
  RefreshTokenRecord,
} from '../domain/interfaces/ISessionRepository.js';

import type { ICacheProvider } from '../domain/interfaces/ICacheProvider.js';
import type { AuditService, AuditLogParams } from './AuditService.js';
import type { EnvConfig } from '../config/env.js';

// ---------------------------------------------------------------------------
// Internal imports — domain error classes (R22)
// ---------------------------------------------------------------------------

import { AuthenticationError } from '../errors/AuthenticationError.js';
import { ConflictError } from '../errors/ConflictError.js';
import { NotFoundError } from '../errors/NotFoundError.js';

// ---------------------------------------------------------------------------
// Shared types from @kalle/shared
// ---------------------------------------------------------------------------

import {
  type RegisterDTO,
  type LoginDTO,
  type JWTPayload,
  type TokenPair,
  type RefreshTokenDTO,
  type AuthResponse,
  type UserResponse,
  AuditAction,
} from '@kalle/shared';

// =============================================================================
// Constants
// =============================================================================

/**
 * Number of bcrypt salt rounds for password hashing.
 * 12 rounds provides a strong security/performance balance (~250ms on modern hardware).
 */
const SALT_ROUNDS = 12;

/**
 * Redis key prefix for JWT token blacklist entries (R33).
 * Full key format: `blacklist:<jti>` with TTL = remaining token expiry.
 */
const BLACKLIST_PREFIX = 'blacklist:';

/**
 * Pre-computed bcrypt hash of a dummy password.
 * Used for constant-time login responses when the email does not exist,
 * preventing user enumeration via timing side-channels (Issue 6).
 * The hash corresponds to an arbitrary 32-character random string so it never
 * matches any real user input.
 */
const DUMMY_PASSWORD_HASH: string =
  '$2a$12$LJ3m4ys3Lz0mHQqGZq0Oue1J5FfB0Oj2yFh9KjYx7N3mBz6L8CXXW';

/**
 * Optional request context forwarded from the controller for audit log enrichment.
 * Contains correlation ID, client IP, and user-agent (R29, R32).
 */
export interface RequestContext {
  /** UUID v4 correlation ID assigned by the correlation-id middleware (R29). */
  correlationId?: string;
  /** Client IP address extracted from the request. */
  ipAddress?: string;
  /** Client User-Agent header value. */
  userAgent?: string;
}

// =============================================================================
// AuthService Class
// =============================================================================

/**
 * Core authentication service implementing registration, login, token management,
 * and session revocation with Redis-backed token blacklist.
 *
 * All dependencies are injected via constructor (R17). The composition root
 * (`server.ts`) wires concrete implementations to the interface contracts
 * consumed by this service.
 *
 * @example
 * ```typescript
 * // In composition root (server.ts):
 * const authService = new AuthService(
 *   userRepository,      // IUserRepository
 *   sessionRepository,   // ISessionRepository
 *   cacheProvider,        // ICacheProvider
 *   auditService,         // AuditService
 *   env,                  // EnvConfig
 * );
 * ```
 */
export class AuthService {
  /**
   * Creates a new AuthService instance with all required dependencies.
   *
   * @param userRepository    - User persistence operations (R17: interface, not concrete class)
   * @param sessionRepository - Session and refresh token persistence (R17: interface)
   * @param cacheProvider     - Redis cache for JWT blacklist (R33) and existence checks
   * @param auditService      - Immutable audit log writer (R32) — never throws
   * @param env               - Validated environment configuration with JWT settings
   */
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly sessionRepository: ISessionRepository,
    private readonly cacheProvider: ICacheProvider,
    private readonly auditService: AuditService,
    private readonly env: EnvConfig,
  ) {}

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Register a new user account.
   *
   * Flow:
   * 1. Check for duplicate email via `existsByEmail()` (fast unique check)
   * 2. Hash password with bcrypt (12 rounds)
   * 3. Create user record in database
   * 4. Generate JWT access token (with unique JTI) and opaque refresh token
   * 5. Persist session and refresh token records
   * 6. Write audit log entry (R32: `USER_REGISTER`)
   * 7. Return sanitised user profile + token pair
   *
   * @param dto     - Registration payload (email, password, displayName, phoneNumber?)
   * @param context - Optional request context for audit log enrichment (R29, R32)
   * @returns AuthResponse with sanitised user info and fresh token pair
   * @throws ConflictError (409) if email is already registered
   */
  async register(
    dto: RegisterDTO,
    context?: RequestContext,
  ): Promise<AuthResponse> {
    // Normalize email to lowercase for case-insensitive uniqueness (RFC 5321)
    const normalizedEmail: string = dto.email.toLowerCase().trim();

    // Sanitize displayName — strip HTML tags to prevent stored XSS
    const sanitizedDisplayName: string = dto.displayName.replace(
      /<[^>]*>/g,
      '',
    );

    // Step 1 — Check for duplicate email (using normalized email)
    const emailExists: boolean =
      await this.userRepository.existsByEmail(normalizedEmail);
    if (emailExists) {
      throw new ConflictError('Email already registered', { field: 'email' });
    }

    // Step 2 — Hash password (R23: NEVER log password or hash)
    const passwordHash: string = await bcrypt.hash(dto.password, SALT_ROUNDS);

    // Step 3 — Create user record (with normalized email and sanitized displayName)
    const createData: CreateUserData = {
      email: normalizedEmail,
      passwordHash,
      displayName: sanitizedDisplayName,
      phoneNumber: dto.phoneNumber,
    };
    const user: UserResponse = await this.userRepository.create(createData);

    // Step 4 — Generate tokens
    const {
      token: accessToken,
      jti,
      expiresIn,
    } = this.generateAccessToken(user.id, user.email, user.displayName);
    const { token: refreshToken, expiresAt: refreshExpiresAt } =
      this.generateRefreshToken();

    // Step 5 — Create session record (links JTI to user for blacklist lookup)
    const sessionData: CreateSessionData = {
      userId: user.id,
      jti,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
    const session: SessionRecord =
      await this.sessionRepository.createSession(sessionData);

    // Create refresh token record linked to the session
    const refreshData: CreateRefreshTokenData = {
      userId: user.id,
      token: refreshToken,
      sessionId: session.id,
      expiresAt: refreshExpiresAt,
    };
    await this.sessionRepository.createRefreshToken(refreshData);

    // Step 6 — Audit log (R32: immutable audit entry, R29: correlation ID)
    const auditParams: AuditLogParams = {
      action: AuditAction.USER_REGISTER,
      actorId: user.id,
      metadata: { email: user.email },
      correlationId: context?.correlationId,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    };
    await this.auditService.log(auditParams);

    // Step 7 — Build and return response (R23: exclude passwordHash)
    const refreshExpiresIn: number = this.parseDurationToSeconds(
      this.env.JWT_REFRESH_TOKEN_EXPIRY,
    );

    return {
      user: this.toAuthUser(user),
      tokens: {
        accessToken,
        refreshToken,
        expiresIn,
        refreshExpiresIn,
      },
    };
  }

  /**
   * Authenticate a user via email + password credentials.
   *
   * Flow:
   * 1. Look up user by email (returns UserWithPassword including hash)
   * 2. Compare submitted password against stored bcrypt hash
   * 3. On failure: write audit entry (USER_LOGIN_FAILED), throw AuthenticationError
   * 4. On success: generate tokens, create session, write audit (USER_LOGIN)
   * 5. Return sanitised user profile + token pair
   *
   * SECURITY (R23): Error messages are generic ("Invalid credentials") to
   * prevent email enumeration attacks. Neither "user not found" nor "wrong
   * password" is disclosed.
   *
   * @param dto     - Login payload (email, password)
   * @param context - Optional request context for audit log enrichment (R29, R32)
   * @returns AuthResponse with sanitised user info and fresh token pair
   * @throws AuthenticationError (401) on invalid credentials
   */
  async login(
    dto: LoginDTO,
    context?: RequestContext,
  ): Promise<AuthResponse> {
    // Normalize email to lowercase for case-insensitive lookup (RFC 5321)
    const normalizedEmail: string = dto.email.toLowerCase().trim();

    // Step 1 — Find user by email (includes passwordHash for bcrypt comparison)
    const user: UserWithPassword | null =
      await this.userRepository.findByEmail(normalizedEmail);

    // Constant-time response: always perform bcrypt compare even when user not
    // found, preventing timing-based email enumeration (Issue 6).
    if (!user) {
      await bcrypt.compare(dto.password, DUMMY_PASSWORD_HASH);
      throw new AuthenticationError('Invalid credentials');
    }

    // Step 2 — Compare password with stored bcrypt hash
    const isPasswordValid: boolean = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      // Audit failed login BEFORE throwing (R32, R29)
      await this.auditService.log({
        action: AuditAction.USER_LOGIN_FAILED,
        actorId: user.id,
        metadata: { reason: 'invalid_password' },
        correlationId: context?.correlationId,
        ipAddress: context?.ipAddress,
        userAgent: context?.userAgent,
      });
      throw new AuthenticationError('Invalid credentials');
    }

    // Step 3 — Generate tokens
    const {
      token: accessToken,
      jti,
      expiresIn,
    } = this.generateAccessToken(user.id, user.email, user.displayName);
    const { token: refreshToken, expiresAt: refreshExpiresAt } =
      this.generateRefreshToken();

    // Step 4 — Create session and refresh token records
    const sessionData: CreateSessionData = {
      userId: user.id,
      jti,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
    const session: SessionRecord =
      await this.sessionRepository.createSession(sessionData);

    const refreshData: CreateRefreshTokenData = {
      userId: user.id,
      token: refreshToken,
      sessionId: session.id,
      expiresAt: refreshExpiresAt,
    };
    await this.sessionRepository.createRefreshToken(refreshData);

    // Step 5 — Audit successful login (R32, R29)
    await this.auditService.log({
      action: AuditAction.USER_LOGIN,
      actorId: user.id,
      correlationId: context?.correlationId,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });

    // Step 6 — Return response (R23: exclude passwordHash from UserWithPassword)
    const refreshExpiresIn: number = this.parseDurationToSeconds(
      this.env.JWT_REFRESH_TOKEN_EXPIRY,
    );

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatar: user.avatar,
        phoneNumber: user.phoneNumber,
      },
      tokens: {
        accessToken,
        refreshToken,
        expiresIn,
        refreshExpiresIn,
      },
    };
  }

  /**
   * Exchange a refresh token for a new token pair (refresh token rotation).
   *
   * Flow:
   * 1. Look up the refresh token record in the database
   * 2. Validate: not revoked, not expired
   * 3. Revoke the old refresh token (consumed — cannot be reused)
   * 4. Find the old session, blacklist its JTI in Redis, revoke session
   * 5. Fetch user info for new JWT payload
   * 6. Generate new access + refresh tokens
   * 7. Create new session and refresh token records
   * 8. Return new token pair
   *
   * This implements refresh token rotation: the old token is consumed and
   * a brand-new pair is issued. If a revoked refresh token is presented,
   * it indicates a potential token theft — the legitimate user would have
   * already rotated.
   *
   * @param dto - Refresh token payload (refreshToken)
   * @returns Fresh TokenPair (accessToken, refreshToken, expiresIn, refreshExpiresIn)
   * @throws AuthenticationError (401) if refresh token is invalid, revoked, or expired
   */
  async refreshToken(dto: RefreshTokenDTO): Promise<TokenPair> {
    // Step 1 — Look up the refresh token
    const refreshTokenRecord: RefreshTokenRecord | null =
      await this.sessionRepository.findRefreshToken(dto.refreshToken);

    if (!refreshTokenRecord) {
      throw new AuthenticationError('Invalid refresh token');
    }

    if (refreshTokenRecord.isRevoked) {
      throw new AuthenticationError('Refresh token has been revoked');
    }

    if (refreshTokenRecord.expiresAt.getTime() < Date.now()) {
      throw new AuthenticationError('Refresh token expired');
    }

    const { userId, sessionId: oldSessionId } = refreshTokenRecord;

    // Step 2 — Revoke the old refresh token (consumed)
    await this.sessionRepository.revokeRefreshToken(dto.refreshToken);

    // Step 3 — Find the old session and blacklist its JTI in Redis (R33)
    const activeSessions: SessionRecord[] =
      await this.sessionRepository.findActiveSessionsByUserId(userId);
    const oldSession: SessionRecord | undefined = activeSessions.find(
      (s: SessionRecord) => s.id === oldSessionId,
    );

    if (oldSession) {
      const remainingTtl: number = this.calculateRemainingTtl(
        oldSession.expiresAt,
      );
      if (remainingTtl > 0) {
        await this.cacheProvider.set(
          `${BLACKLIST_PREFIX}${oldSession.jti}`,
          'revoked',
          remainingTtl,
        );
      }
      // Revoke the old session in the database
      await this.sessionRepository.revokeSessionByJti(oldSession.jti);
    }

    // Revoke any remaining refresh tokens for the old session
    await this.sessionRepository.revokeRefreshTokensBySessionId(oldSessionId);

    // Step 4 — Fetch user info for the new JWT payload
    const user: UserResponse | null =
      await this.userRepository.findById(userId);
    if (!user) {
      throw new AuthenticationError('User not found');
    }

    // Step 5 — Generate new tokens
    const {
      token: newAccessToken,
      jti: newJti,
      expiresIn,
    } = this.generateAccessToken(user.id, user.email, user.displayName);
    const { token: newRefreshToken, expiresAt: newRefreshExpiresAt } =
      this.generateRefreshToken();

    // Step 6 — Create new session and refresh token records
    const newSessionData: CreateSessionData = {
      userId: user.id,
      jti: newJti,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
    const newSession: SessionRecord =
      await this.sessionRepository.createSession(newSessionData);

    const newRefreshData: CreateRefreshTokenData = {
      userId: user.id,
      token: newRefreshToken,
      sessionId: newSession.id,
      expiresAt: newRefreshExpiresAt,
    };
    await this.sessionRepository.createRefreshToken(newRefreshData);

    // Step 7 — Return new token pair
    const refreshExpiresIn: number = this.parseDurationToSeconds(
      this.env.JWT_REFRESH_TOKEN_EXPIRY,
    );

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn,
      refreshExpiresIn,
    };
  }

  /**
   * Revoke a single session (single-session logout — R33).
   *
   * Flow:
   * 1. Extract JTI and expiry from the access token (try verify, fallback decode)
   * 2. Look up the session by JTI in the database
   * 3. Verify session ownership (must belong to the requesting user)
   * 4. Check Redis blacklist to avoid redundant writes (idempotency)
   * 5. Blacklist the JTI in Redis with remaining TTL
   * 6. Revoke session and associated refresh tokens in the database
   * 7. Write audit log entry (R32: SESSION_REVOKE)
   *
   * The access token is accepted as a raw string rather than a pre-extracted
   * JTI to support revoking tokens that may already be expired but still
   * need blacklisting (jwt.decode extracts payload without verification).
   *
   * @param accessToken - The raw JWT access token to revoke
   * @param userId      - ID of the user requesting revocation (ownership check)
   * @param context     - Optional request context for audit log enrichment (R29, R32)
   * @throws NotFoundError (404) if no session matches the token's JTI
   * @throws AuthenticationError (401) if session doesn't belong to the user
   */
  async revokeSession(
    accessToken: string,
    userId: string,
    context?: RequestContext,
  ): Promise<void> {
    // Step 1 — Extract JTI and expiry from the access token
    const payload: JWTPayload = this.extractTokenPayload(accessToken);
    const { jti, exp } = payload;

    // Step 2 — Find the session by JTI
    const session: SessionRecord | null =
      await this.sessionRepository.findSessionByJti(jti);
    if (!session) {
      throw new NotFoundError('Session not found', { resource: 'Session' });
    }

    // Step 3 — Verify session ownership
    if (session.userId !== userId) {
      throw new AuthenticationError('Session does not belong to this user');
    }

    // Step 4 — Check if already blacklisted (idempotency via ICacheProvider.exists)
    const isAlreadyBlacklisted: boolean = await this.cacheProvider.exists(
      `${BLACKLIST_PREFIX}${jti}`,
    );

    if (!isAlreadyBlacklisted) {
      // Step 5 — Blacklist the JTI in Redis with remaining TTL (R33)
      const remainingTtl: number = Math.max(
        0,
        exp - Math.floor(Date.now() / 1000),
      );
      if (remainingTtl > 0) {
        await this.cacheProvider.set(
          `${BLACKLIST_PREFIX}${jti}`,
          'revoked',
          remainingTtl,
        );
      }
    }

    // Step 6 — Revoke session and associated refresh tokens in DB
    await this.sessionRepository.revokeSessionByJti(jti);
    await this.sessionRepository.revokeRefreshTokensBySessionId(session.id);

    // Step 7 — Audit log (R32: immutable audit entry, R29: correlation ID)
    await this.auditService.log({
      action: AuditAction.SESSION_REVOKE,
      actorId: userId,
      metadata: { sessionId: session.id },
      correlationId: context?.correlationId,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
  }

  /**
   * Revoke ALL active sessions for a user (all-sessions logout — R33).
   *
   * Flow:
   * 1. Fetch all active (non-revoked, non-expired) sessions for the user
   * 2. Blacklist each session's JTI in Redis with remaining TTL
   * 3. Revoke all sessions and all refresh tokens in the database
   * 4. Write audit log entry (R32: SESSION_REVOKE_ALL)
   * 5. Return count of revoked sessions
   *
   * This is the "nuclear option" — invalidates every active session across
   * all devices. The user must re-authenticate on every device.
   *
   * @param userId  - ID of the user whose sessions should be revoked
   * @param context - Optional request context for audit log enrichment (R29, R32)
   * @returns Number of sessions that were revoked
   */
  async revokeAllSessions(
    userId: string,
    context?: RequestContext,
  ): Promise<number> {
    // Step 1 — Get all active sessions for the user
    const activeSessions: SessionRecord[] =
      await this.sessionRepository.findActiveSessionsByUserId(userId);

    // Step 2 — Blacklist each session's JTI in Redis (R33)
    const blacklistPromises: Promise<void>[] = activeSessions.map(
      async (session: SessionRecord): Promise<void> => {
        const remainingTtl: number = this.calculateRemainingTtl(
          session.expiresAt,
        );
        if (remainingTtl > 0) {
          await this.cacheProvider.set(
            `${BLACKLIST_PREFIX}${session.jti}`,
            'revoked',
            remainingTtl,
          );
        }
      },
    );
    await Promise.all(blacklistPromises);

    // Step 3 — Revoke all sessions and refresh tokens in DB
    const revokedCount: number =
      await this.sessionRepository.revokeAllSessionsByUserId(userId);
    await this.sessionRepository.revokeRefreshTokensByUserId(userId);

    // Step 4 — Audit log (R32: immutable audit entry, R29: correlation ID)
    await this.auditService.log({
      action: AuditAction.SESSION_REVOKE_ALL,
      actorId: userId,
      metadata: { revokedCount },
      correlationId: context?.correlationId,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });

    return revokedCount;
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Generate a signed JWT access token with a unique JTI.
   *
   * The JTI (JWT ID) is a UUID v4 used as the Redis blacklist key when the
   * session is revoked (R33). The token is signed with HS256 using the
   * JWT_SECRET from environment configuration.
   *
   * @param userId      - User's unique identifier (becomes `sub` claim)
   * @param email       - User's email address (embedded in payload)
   * @param displayName - User's display name (embedded in payload)
   * @returns Object containing the signed token string, JTI, and TTL in seconds
   */
  private generateAccessToken(
    userId: string,
    email: string,
    displayName: string,
  ): { token: string; jti: string; expiresIn: number } {
    const jti: string = uuidv4();
    const expiresIn: number = this.parseDurationToSeconds(
      this.env.JWT_ACCESS_TOKEN_EXPIRY,
    );

    // Build payload matching the JWTPayload interface (iat and exp added by jwt.sign).
    // The `type: 'access'` discriminator is required by WebSocket auth middleware
    // (ws-auth.ts) to validate that only access tokens are used for WS connections.
    const payload: Omit<JWTPayload, 'iat' | 'exp'> = {
      sub: userId,
      email,
      displayName,
      jti,
      type: 'access',
    };

    const token: string = jwt.sign(payload, this.env.JWT_SECRET, {
      expiresIn: expiresIn,
    });

    return { token, jti, expiresIn };
  }

  /**
   * Generate an opaque refresh token (UUID v4) with computed expiration.
   *
   * Refresh tokens are NOT JWTs — they are opaque identifiers stored in the
   * database. This avoids the complexity of refresh token verification and
   * ensures revocation is handled entirely via database lookup.
   *
   * @returns Object containing the opaque token string and expiration Date
   */
  private generateRefreshToken(): { token: string; expiresAt: Date } {
    const token: string = uuidv4();
    const refreshTtlSeconds: number = this.parseDurationToSeconds(
      this.env.JWT_REFRESH_TOKEN_EXPIRY,
    );
    const expiresAt: Date = new Date(Date.now() + refreshTtlSeconds * 1000);
    return { token, expiresAt };
  }

  /**
   * Extract JTI and expiry from an access token.
   *
   * First attempts full verification via `jwt.verify()` (confirms signature
   * integrity and that the token was issued by this server). If verification
   * fails (e.g., token is expired), falls back to `jwt.decode()` which extracts
   * the payload without signature or expiry validation.
   *
   * This dual approach is essential for session revocation: a user may want to
   * revoke a session whose access token has already expired, and we still need
   * the JTI to ensure it's blacklisted (preventing any cached/buffered requests).
   *
   * @param token - Raw JWT access token string
   * @returns Decoded JWTPayload with sub, email, jti, iat, exp
   * @throws AuthenticationError if the token is structurally invalid
   */
  private extractTokenPayload(token: string): JWTPayload {
    // Try full verification first (confirms signature integrity)
    try {
      return jwt.verify(token, this.env.JWT_SECRET) as JWTPayload;
    } catch {
      // Token may be expired but structurally valid — decode without verification
      const decoded = jwt.decode(token) as JWTPayload | null;
      if (
        !decoded ||
        !decoded.jti ||
        typeof decoded.exp !== 'number' ||
        typeof decoded.sub !== 'string'
      ) {
        throw new AuthenticationError('Invalid token format');
      }
      return decoded;
    }
  }

  /**
   * Parse a duration string into seconds.
   *
   * Supports the common duration format used by jsonwebtoken and
   * environment configuration: `<number><unit>` where unit is one of
   * `s` (seconds), `m` (minutes), `h` (hours), or `d` (days).
   *
   * @param duration - Duration string (e.g., '15m', '1h', '7d', '3600s')
   * @returns Duration in seconds
   * @throws Error if the format is invalid or the unit is unsupported
   */
  private parseDurationToSeconds(duration: string): number {
    const match: RegExpMatchArray | null = duration.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new Error(
        `Invalid duration format: "${duration}". Expected format: <number><s|m|h|d>`,
      );
    }

    const value: number = parseInt(match[1], 10);
    const unit: string = match[2];

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 3600;
      case 'd':
        return value * 86400;
      default:
        // Unreachable due to regex constraint, but satisfies exhaustive checking
        throw new Error(`Unsupported duration unit: "${unit}"`);
    }
  }

  /**
   * Calculate remaining TTL in seconds from an expiration Date.
   *
   * Returns 0 if the expiration is in the past (already expired).
   * Used to set appropriate Redis TTL values for blacklisted JTIs.
   *
   * @param expiresAt - Expiration timestamp
   * @returns Remaining seconds until expiration, minimum 0
   */
  private calculateRemainingTtl(expiresAt: Date): number {
    const remainingMs: number = expiresAt.getTime() - Date.now();
    return Math.max(0, Math.ceil(remainingMs / 1000));
  }

  /**
   * Map a full UserResponse to the AuthResponse.user subset shape.
   *
   * Picks only the fields required by the AuthResponse contract:
   * id, email, displayName, avatar, phoneNumber. Excludes status,
   * lastSeen, about, createdAt, updatedAt.
   *
   * @param user - Full user response from the repository
   * @returns Sanitised user object matching AuthResponse['user']
   */
  private toAuthUser(user: UserResponse): AuthResponse['user'] {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatar: user.avatar,
      phoneNumber: user.phoneNumber,
    };
  }
}
