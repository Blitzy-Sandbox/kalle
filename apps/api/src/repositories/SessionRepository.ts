import type { PrismaClient } from '@prisma/client';

// Re-export all types from the domain interface file for backward compatibility
// and to maintain the contract that existing consumers may import from here.
import type {
  ISessionRepository,
  CreateSessionData,
  SessionRecord,
  CreateRefreshTokenData,
  RefreshTokenRecord,
} from '../domain/interfaces/ISessionRepository.js';

export type {
  ISessionRepository,
  CreateSessionData,
  SessionRecord,
  CreateRefreshTokenData,
  RefreshTokenRecord,
};

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
