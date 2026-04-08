/**
 * @module IAuditRepository
 *
 * Audit Log Repository Interface — APPEND-ONLY Contract
 *
 * Defines the persistence contract for the immutable audit log. This interface
 * is the first line of defense for Rule R32 (Immutable Audit Log): it exposes
 * a `create()` method for inserts and a `findByQuery()` / `count()` pair for
 * reads, but intentionally omits any `update()` or general-purpose `delete()`
 * method. Audit log entries, once written, cannot be modified.
 *
 * The sole exception is `deleteOlderThan()`, which exists exclusively for the
 * scheduled 90-day retention cleanup BullMQ job (R35: Data Retention). This
 * method is not intended for general application use and requires elevated
 * database permissions (the default application role has no DELETE permission
 * on the audit_log table).
 *
 * Architecture rules enforced by this interface:
 *
 *  - R32 (Immutable Audit Log): NO update() or delete() methods. create() is
 *    INSERT-ONLY. deleteOlderThan() is restricted to retention cleanup.
 *  - R17 (Interface-Driven Dependencies): Services code against this interface.
 *    No service imports the concrete AuditRepository class directly.
 *  - R16 (OOD Layering): This interface abstracts persistence — zero business
 *    logic is defined here. All validation and sanitization is the
 *    responsibility of the AuditService layer.
 *  - R23 (Log Hygiene): The metadata field MUST NOT contain message content,
 *    encryption keys, JWT tokens, passwords, or file contents. Enforcement
 *    occurs in AuditService; the constraint is documented here for awareness.
 *  - R29 (Correlation ID Propagation): Audit entries carry a correlationId
 *    (UUID v4) linking them to the originating HTTP request or WebSocket event.
 *  - R35 (Data Retention): Audit logs are purged after 90 days via the
 *    audit-log-cleanup BullMQ job, which invokes deleteOlderThan().
 *  - R7  (Zero Warnings Build): Strict TypeScript, no warnings.
 *  - R28 (Structured Logging): Zero console.log / console.warn / console.error.
 *
 * Concrete implementation: apps/api/src/repositories/AuditRepository.ts (Prisma)
 */

import type {
  CreateAuditLogDTO,
  AuditLogEntry,
  AuditLogQuery,
  AuditAction,
} from '@kalle/shared';

// Re-export imported types so that consumers of this interface file can access
// the types without adding a separate import from @kalle/shared when they only
// need the repository contract and its associated types.
export type { CreateAuditLogDTO, AuditLogEntry, AuditLogQuery, AuditAction };

/**
 * Paginated result set returned by {@link IAuditRepository.findByQuery}.
 *
 * Uses cursor-based pagination for efficient traversal of large audit log
 * datasets. The `cursor` value is opaque to consumers and should be forwarded
 * as-is to subsequent queries.
 */
export interface AuditLogPage {
  /** Ordered list of audit log entries matching the query filters */
  items: AuditLogEntry[];

  /**
   * Opaque pagination cursor pointing to the next page of results.
   * Undefined when there are no more results beyond the current page.
   */
  cursor?: string;

  /** Indicates whether additional pages of results exist */
  hasMore: boolean;
}

/**
 * APPEND-ONLY audit log repository contract.
 *
 * This interface deliberately limits write operations to a single `create()`
 * method (INSERT-ONLY) and a retention-specific `deleteOlderThan()` method.
 * There is no `update()` method and no general-purpose `delete()` method.
 * This design enforces audit log immutability at the interface level (R32).
 *
 * All methods are asynchronous and return Promises to accommodate the
 * underlying Prisma database operations.
 *
 * @example
 * ```typescript
 * // Injected via composition root — never instantiated directly by services
 * class AuditService {
 *   constructor(private readonly auditRepo: IAuditRepository) {}
 *
 *   async log(dto: CreateAuditLogDTO): Promise<AuditLogEntry> {
 *     // Sanitize metadata (R23) before persisting
 *     return this.auditRepo.create(dto);
 *   }
 * }
 * ```
 */
export interface IAuditRepository {
  /**
   * Insert a new audit log entry (INSERT-ONLY — R32: immutable audit log).
   *
   * This is the **only** write operation permitted on the audit_log table
   * during normal application operation. The concrete implementation must
   * use an INSERT statement (e.g., Prisma `create()`), never an UPSERT.
   *
   * **CRITICAL — Metadata Security Constraints (R23):**
   * The `metadata` field of the DTO MUST NOT contain any of the following:
   *   - Message plaintext or ciphertext content
   *   - Encryption keys or prekey material
   *   - JWT tokens (access or refresh)
   *   - User passwords or password hashes
   *   - File contents or binary data
   *
   * These restrictions are enforced by the AuditService layer, but the
   * repository implementation should not assume sanitized input — it should
   * treat the DTO as-is and persist it without transformation.
   *
   * @param dto - {@link CreateAuditLogDTO} containing the action type,
   *              actor identifier, optional target, and sanitized metadata
   * @returns The created {@link AuditLogEntry} with server-generated `id`
   *          and `createdAt` timestamp
   * @throws If the database INSERT fails (connection error, constraint violation)
   */
  create(dto: CreateAuditLogDTO): Promise<AuditLogEntry>;

  /**
   * Query audit log entries with filtering and cursor-based pagination.
   *
   * Supports filtering by action type, actor ID, target ID, and date range.
   * Results are returned in reverse chronological order (newest first) by
   * default. The cursor-based pagination model ensures consistent traversal
   * even as new entries are appended.
   *
   * Used by admin retrieval endpoints and monitoring dashboards.
   *
   * @param query - {@link AuditLogQuery} specifying optional filters
   *                (action, actorId, targetId, startDate, endDate) and
   *                pagination parameters (cursor, limit)
   * @returns An {@link AuditLogPage} containing the matching entries,
   *          a cursor for the next page (if applicable), and a boolean
   *          indicating whether more results exist
   * @throws If the database query fails (connection error, invalid cursor)
   */
  findByQuery(query: AuditLogQuery): Promise<AuditLogPage>;

  /**
   * Count audit log entries matching the given filter criteria.
   *
   * Useful for admin dashboard widgets, metrics collection, and
   * determining result set size before paginated retrieval.
   *
   * Pagination fields (cursor, limit) in the query are ignored —
   * only the filter dimensions (action, actorId, targetId, date range)
   * are applied to the count.
   *
   * @param query - Optional partial {@link AuditLogQuery} for filtering.
   *                Omit entirely to count all audit log entries.
   * @returns Total number of matching audit log entries
   * @throws If the database count query fails
   */
  count(query?: Partial<AuditLogQuery>): Promise<number>;

  /**
   * Delete audit log entries older than the specified date threshold.
   *
   * **WARNING — Restricted Use (R35: 90-Day Retention):**
   * This method exists **solely** for the `audit-log-cleanup` BullMQ job
   * that enforces the 90-day data retention policy. It MUST NOT be called
   * from any service, controller, or WebSocket handler.
   *
   * The application's default database role typically has no DELETE
   * permission on the audit_log table. The cleanup job must either:
   *   - Run with elevated database permissions, or
   *   - Use a separate database role with scoped DELETE access
   *
   * Implementation note: The concrete repository should use a WHERE clause
   * on `createdAt < olderThan` and return the count of deleted rows for
   * observability and job logging.
   *
   * @param olderThan - Date threshold — all entries with `createdAt` strictly
   *                    before this date will be permanently removed
   * @returns The number of audit log entries that were deleted
   * @throws If the database DELETE fails (permission denied, connection error)
   */
  deleteOlderThan(olderThan: Date): Promise<number>;
}
