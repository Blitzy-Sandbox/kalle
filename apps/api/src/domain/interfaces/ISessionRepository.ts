/**
 * @file ISessionRepository.ts
 * @description Repository interface contract for session and refresh-token persistence.
 *
 * This interface defines the data-access contract that the AuthService depends
 * on for session lifecycle management. The concrete implementation
 * (SessionRepository) is the sole implementer and is wired via the composition
 * root in `server.ts`.
 *
 * Architecture Rules Enforced:
 * - R17 (Interface-Driven Dependencies): This file lives in `domain/interfaces/`
 *   so that services import only the interface — never the concrete repository.
 *   The composition root (server.ts) is the only module that instantiates the
 *   concrete SessionRepository.
 * - R16 (OOD Layering): Services depend on this interface for data access.
 *   The interface defines zero business logic — it is a pure data contract.
 * - R33 (Session Revocation): Interface methods support single-session and
 *   all-sessions revocation workflows, enabling Redis blacklist + DB persistence.
 *
 * @see apps/api/src/repositories/SessionRepository.ts — concrete implementation
 * @see apps/api/src/services/AuthService.ts — primary consumer of this interface
 */

// ---------------------------------------------------------------------------
// Data Transfer Objects
// ---------------------------------------------------------------------------

/**
 * Input data required to persist a new Session record.
 * The composition root (server.ts) is responsible for generating the JTI
 * and computing the expiry; this DTO captures the persistence shape only.
 */
export interface CreateSessionData {
  /** User who owns the session. */
  userId: string;
  /** JWT ID — unique identifier for the access token. */
  jti: string;
  /** User agent or device description (optional). */
  deviceInfo?: string;
  /** Access token expiration timestamp. */
  expiresAt: Date;
}

/**
 * Read-only projection of a persisted Session row.
 * Returned from every query and mutation that yields session data.
 */
export interface SessionRecord {
  id: string;
  userId: string;
  jti: string;
  deviceInfo: string | null;
  isRevoked: boolean;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Input data required to persist a new RefreshToken record.
 * Token value MUST be hashed before reaching the repository — this layer
 * performs zero hashing (R16: data access only).
 */
export interface CreateRefreshTokenData {
  /** User who owns the refresh token. */
  userId: string;
  /** The refresh token value (hashed by AuthService before storage). */
  token: string;
  /** Foreign key linking to the parent Session. */
  sessionId: string;
  /** Refresh token expiration timestamp. */
  expiresAt: Date;
}

/**
 * Read-only projection of a persisted RefreshToken row.
 */
export interface RefreshTokenRecord {
  id: string;
  userId: string;
  token: string;
  sessionId: string;
  isRevoked: boolean;
  createdAt: Date;
  expiresAt: Date;
}

// ---------------------------------------------------------------------------
// Repository Interface
// ---------------------------------------------------------------------------

/**
 * Contract for session and refresh-token persistence.
 *
 * Services code against this interface (R17: interface-driven dependencies).
 * The concrete {@link SessionRepository} is the sole implementer and is
 * wired via the composition root in `server.ts`.
 */
export interface ISessionRepository {
  // ── Session operations ──────────────────────────────────────────────
  /** Persist a new session record (isRevoked defaults to false). */
  createSession(data: CreateSessionData): Promise<SessionRecord>;

  /** Lookup a session by its unique JWT ID. */
  findSessionByJti(jti: string): Promise<SessionRecord | null>;

  /** Mark a single session as revoked by its JTI (R33 single-session logout). */
  revokeSessionByJti(jti: string): Promise<void>;

  /**
   * Revoke ALL active (non-revoked) sessions for a user (R33 revoke-all).
   * @returns The number of sessions that were revoked.
   */
  revokeAllSessionsByUserId(userId: string): Promise<number>;

  /**
   * Return every non-revoked, non-expired session for a user,
   * ordered by most-recently created first.
   */
  findActiveSessionsByUserId(userId: string): Promise<SessionRecord[]>;

  /**
   * Hard-delete all sessions whose expiresAt is in the past.
   * Intended for periodic cleanup.
   * @returns The count of deleted rows.
   */
  deleteExpiredSessions(): Promise<number>;

  // ── RefreshToken operations ─────────────────────────────────────────
  /** Persist a new refresh token record (isRevoked defaults to false). */
  createRefreshToken(data: CreateRefreshTokenData): Promise<RefreshTokenRecord>;

  /** Lookup a refresh token by its unique token value. */
  findRefreshToken(token: string): Promise<RefreshTokenRecord | null>;

  /** Mark a single refresh token as revoked. */
  revokeRefreshToken(token: string): Promise<void>;

  /**
   * Revoke all non-revoked refresh tokens tied to a specific session.
   * Cascading call when a session is revoked.
   * @returns Count of revoked tokens.
   */
  revokeRefreshTokensBySessionId(sessionId: string): Promise<number>;

  /**
   * Revoke all non-revoked refresh tokens for a user (R33 revoke-all flow).
   * @returns Count of revoked tokens.
   */
  revokeRefreshTokensByUserId(userId: string): Promise<number>;

  /**
   * Hard-delete all refresh tokens whose expiresAt is in the past.
   * Intended for periodic cleanup.
   * @returns Count of deleted rows.
   */
  deleteExpiredRefreshTokens(): Promise<number>;
}
