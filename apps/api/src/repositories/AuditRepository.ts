/**
 * @module apps/api/src/repositories/AuditRepository
 *
 * Prisma-backed APPEND-ONLY implementation of the IAuditRepository interface.
 *
 * Handles persistence of security-sensitive audit log entries with strict
 * immutability constraints. This repository provides INSERT (create), READ
 * (findByQuery, count), and scheduled CLEANUP (deleteOlderThan) operations.
 *
 * Architecture rules enforced:
 * - R32: IMMUTABLE AUDIT LOG — This is the MOST critical rule for this file.
 *        The audit_log table is append-only. This repository contains NO
 *        update() or generic delete(id) method. The ONLY write is create()
 *        (INSERT). deleteOlderThan() exists solely for the 90-day scheduled
 *        cleanup BullMQ job (R35).
 * - R17: Implements IAuditRepository interface (interface-driven DI).
 *        PrismaClient injected via constructor — no hard-coded instantiation.
 * - R16: Zero business logic — persistence only. Metadata sanitization (R23)
 *        happens in AuditService, not here.
 * - R23: This repository MUST NOT log any metadata field values. Logging is
 *        handled at the service layer.
 * - R29: Correlation ID is stored as a direct column on the AuditLog model.
 *        The repository stores it as-is from the DTO.
 * - R35: deleteOlderThan() supports the 90-day audit log purge BullMQ job.
 * - R28: Zero console.log — structured Pino logging handled at service layer.
 * - R7:  TypeScript strict mode, zero warnings.
 *
 * Prisma AuditLog model reference (from prisma/schema.prisma):
 *   model AuditLog {
 *     id            String      @id @default(uuid())
 *     actorId       String?
 *     action        AuditAction
 *     targetType    String?
 *     targetId      String?
 *     metadata      Json?
 *     ipAddress     String?
 *     userAgent     String?
 *     correlationId String?
 *     createdAt     DateTime    @default(now())
 *     @@map("audit_logs")
 *   }
 */

import type { PrismaClient, Prisma, AuditLog } from '@prisma/client';
import type {
  IAuditRepository,
  AuditLogPage,
} from '../domain/interfaces/IAuditRepository.js';
import {
  type CreateAuditLogDTO,
  type AuditLogEntry,
  type AuditLogQuery,
  AuditAction,
} from '@kalle/shared';

// =============================================================================
// AuditRepository — Prisma-backed APPEND-ONLY implementation
// =============================================================================

export class AuditRepository implements IAuditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ─── Create (INSERT-ONLY per R32) ───────────────────────────────────

  /**
   * Appends a new audit log entry. This is the ONLY write operation on the
   * audit_log table (R32: immutable audit trail). Uses prisma.auditLog.create()
   * exclusively — never upsert(), update(), or updateMany().
   *
   * @param dto - The audit log data to persist
   * @returns The created AuditLogEntry with generated id and timestamps
   */
  async create(dto: CreateAuditLogDTO): Promise<AuditLogEntry> {
    const record = await this.prisma.auditLog.create({
      data: {
        actorId: dto.actorId,
        action: dto.action,
        targetType: dto.targetType ?? null,
        targetId: dto.targetId ?? null,
        metadata: dto.metadata
          ? (dto.metadata as unknown as Prisma.InputJsonValue)
          : undefined,
        ipAddress: dto.ipAddress ?? null,
        userAgent: dto.userAgent ?? null,
        correlationId: dto.correlationId ?? null,
        createdAt: new Date(),
      },
    });

    return this.mapToAuditLogEntry(record);
  }

  // ─── Find by Query (Cursor-Paginated Read) ─────────────────────────

  /**
   * Retrieves audit log entries matching the specified query filters with
   * cursor-based pagination. Results are ordered by createdAt descending
   * (newest first). Uses the take+1 pattern for efficient hasMore detection.
   *
   * @param query - Filters: action, actorId, targetId, startDate, endDate,
   *                cursor, limit (default 50)
   * @returns AuditLogPage with items, optional cursor, and hasMore flag
   */
  async findByQuery(query: AuditLogQuery): Promise<AuditLogPage> {
    const limit = query.limit ?? 50;

    const where = this.buildWhereClause(query);

    const records = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = records.length > limit;
    const items = records.slice(0, limit).map((r) => this.mapToAuditLogEntry(r));
    const cursor =
      hasMore && items.length > 0
        ? items[items.length - 1].id
        : undefined;

    return { items, cursor, hasMore };
  }

  // ─── Count ──────────────────────────────────────────────────────────

  /**
   * Returns the total count of audit log entries matching the optional query
   * filters. Builds the same WHERE conditions as findByQuery for consistency.
   *
   * @param query - Optional partial filters: action, actorId, targetId,
   *                startDate, endDate
   * @returns Integer count of matching records
   */
  async count(query?: Partial<AuditLogQuery>): Promise<number> {
    const where = this.buildWhereClause(query);
    return this.prisma.auditLog.count({ where });
  }

  // ─── Delete Older Than (CLEANUP ONLY — R35) ────────────────────────

  /**
   * Deletes audit log entries older than the specified date. This method
   * exists SOLELY for the 90-day retention cleanup BullMQ job (R35).
   * It is NOT intended for general use.
   *
   * WARNING: This is the only deletion mechanism on the audit_log table.
   * There is no delete-by-id method (R32: immutable audit trail).
   *
   * @param olderThan - Threshold date; entries with createdAt < olderThan
   *                    are permanently removed
   * @returns Count of deleted records
   */
  async deleteOlderThan(olderThan: Date): Promise<number> {
    const result = await this.prisma.auditLog.deleteMany({
      where: {
        createdAt: { lt: olderThan },
      },
    });

    return result.count;
  }

  // ─── Private: WHERE Clause Builder ──────────────────────────────────

  /**
   * Constructs a Prisma-compatible WHERE clause from the audit query filters.
   * Shared by findByQuery() and count() for consistent filtering behaviour.
   *
   * @param query - Optional partial query filters
   * @returns Record suitable for Prisma's `where` parameter
   */
  private buildWhereClause(
    query?: Partial<AuditLogQuery>,
  ): Record<string, unknown> {
    const where: Record<string, unknown> = {};

    if (!query) {
      return where;
    }

    if (query.action) {
      where.action = query.action;
    }

    if (query.actorId) {
      where.actorId = query.actorId;
    }

    if (query.targetId) {
      where.targetId = query.targetId;
    }

    if (query.startDate || query.endDate) {
      where.createdAt = {
        ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
        ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
      };
    }

    return where;
  }

  // ─── Private: Record → Domain Mapper ────────────────────────────────

  /**
   * Maps a raw Prisma AuditLog record to the domain AuditLogEntry type.
   *
   * Key mappings:
   * - actorId: Prisma is String? (nullable); domain is string (required) → fallback ''
   * - correlationId: Direct column on AuditLog model (not inside metadata)
   * - userAgent: Direct column on AuditLog model
   * - metadata: Prisma Json? → Record<string, unknown> | undefined
   * - createdAt: Prisma DateTime → ISO 8601 string
   * - actorName: Not a Prisma column → always undefined (populated by service if needed)
   * - No updatedAt field (immutable records per R32)
   *
   * @param record - Raw Prisma AuditLog model record
   * @returns Domain-typed AuditLogEntry
   */
  private mapToAuditLogEntry(record: AuditLog): AuditLogEntry {
    return {
      id: record.id,
      action: record.action as AuditAction,
      actorId: record.actorId ?? '',
      targetId: record.targetId ?? undefined,
      targetType: record.targetType ?? undefined,
      metadata: (record.metadata as Record<string, unknown>) ?? undefined,
      ipAddress: record.ipAddress ?? undefined,
      userAgent: record.userAgent ?? undefined,
      correlationId: record.correlationId ?? undefined,
      createdAt:
        record.createdAt instanceof Date
          ? record.createdAt.toISOString()
          : String(record.createdAt),
    };
  }
}
