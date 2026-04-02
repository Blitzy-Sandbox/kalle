import type { PrismaClient } from '@prisma/client';

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

// ---------------------------------------------------------------------------
// Concrete Implementation
// ---------------------------------------------------------------------------

/**
 * Prisma-backed implementation of {@link ISessionRepository}.
 *
 * Handles ONLY data access — zero business logic (R16).
 * Never logs tokens, session details, or sensitive material (R23 / R28).
 */
export class SessionRepository implements ISessionRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  // ── Session operations ──────────────────────────────────────────────

  async createSession(data: CreateSessionData): Promise<SessionRecord> {
    const record = await this.prisma.session.create({
      data: {
        userId: data.userId,
        jti: data.jti,
        deviceInfo: data.deviceInfo ?? null,
        expiresAt: data.expiresAt,
        isRevoked: false,
      },
    });
    return SessionRepository.mapSession(record);
  }

  async findSessionByJti(jti: string): Promise<SessionRecord | null> {
    const record = await this.prisma.session.findUnique({
      where: { jti },
    });
    return record ? SessionRepository.mapSession(record) : null;
  }

  async revokeSessionByJti(jti: string): Promise<void> {
    await this.prisma.session.update({
      where: { jti },
      data: { isRevoked: true },
    });
  }

  async revokeAllSessionsByUserId(userId: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: {
        userId,
        isRevoked: false,
      },
      data: { isRevoked: true },
    });
    return result.count;
  }

  async findActiveSessionsByUserId(userId: string): Promise<SessionRecord[]> {
    const records = await this.prisma.session.findMany({
      where: {
        userId,
        isRevoked: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    return records.map(SessionRepository.mapSession);
  }

  async deleteExpiredSessions(): Promise<number> {
    const result = await this.prisma.session.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    return result.count;
  }

  // ── RefreshToken operations ─────────────────────────────────────────

  async createRefreshToken(
    data: CreateRefreshTokenData,
  ): Promise<RefreshTokenRecord> {
    const record = await this.prisma.refreshToken.create({
      data: {
        userId: data.userId,
        token: data.token,
        sessionId: data.sessionId,
        expiresAt: data.expiresAt,
        isRevoked: false,
      },
    });
    return SessionRepository.mapRefreshToken(record);
  }

  async findRefreshToken(token: string): Promise<RefreshTokenRecord | null> {
    const record = await this.prisma.refreshToken.findUnique({
      where: { token },
    });
    return record ? SessionRepository.mapRefreshToken(record) : null;
  }

  async revokeRefreshToken(token: string): Promise<void> {
    await this.prisma.refreshToken.update({
      where: { token },
      data: { isRevoked: true },
    });
  }

  async revokeRefreshTokensBySessionId(sessionId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: {
        sessionId,
        isRevoked: false,
      },
      data: { isRevoked: true },
    });
    return result.count;
  }

  async revokeRefreshTokensByUserId(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        isRevoked: false,
      },
      data: { isRevoked: true },
    });
    return result.count;
  }

  async deleteExpiredRefreshTokens(): Promise<number> {
    const result = await this.prisma.refreshToken.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    return result.count;
  }

  // ── Private mappers ─────────────────────────────────────────────────

  /**
   * Maps a raw Prisma Session record to the typed {@link SessionRecord} DTO.
   * Uses a static method so it can be passed as a callback to `.map()`.
   */
  private static mapSession(record: {
    id: string;
    userId: string;
    jti: string;
    deviceInfo: string | null;
    isRevoked: boolean;
    createdAt: Date;
    expiresAt: Date;
  }): SessionRecord {
    return {
      id: record.id,
      userId: record.userId,
      jti: record.jti,
      deviceInfo: record.deviceInfo,
      isRevoked: record.isRevoked,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Maps a raw Prisma RefreshToken record to the typed
   * {@link RefreshTokenRecord} DTO.
   */
  private static mapRefreshToken(record: {
    id: string;
    userId: string;
    token: string;
    sessionId: string;
    isRevoked: boolean;
    createdAt: Date;
    expiresAt: Date;
  }): RefreshTokenRecord {
    return {
      id: record.id,
      userId: record.userId,
      token: record.token,
      sessionId: record.sessionId,
      isRevoked: record.isRevoked,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }
}
