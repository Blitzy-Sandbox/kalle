/**
 * @module @kalle/shared/types/audit
 *
 * Audit Log Types and Action Enums
 *
 * Defines the complete type system for the immutable, append-only audit log
 * that records all security-sensitive actions in the application.
 *
 * Key design constraints:
 * - R32: Audit log is immutable — no UPDATE or DELETE operations permitted.
 *        The database role for the application has no UPDATE/DELETE permissions
 *        on the audit_log table. AuditLogEntry intentionally omits `updatedAt`.
 * - R23: Log hygiene — metadata fields MUST NOT contain message content,
 *        encryption keys, JWT tokens, passwords, or file contents.
 * - R29: Correlation ID propagation — every audit entry carries the originating
 *        request's correlation ID for end-to-end traceability.
 * - R35: Audit logs are purged after 90 days via a scheduled BullMQ job
 *        (audit-log-cleanup). The purge job is the only permitted deletion path.
 *
 * This file contains zero runtime code beyond enum value declarations.
 * No circular dependencies — this file has zero imports from other type files.
 */

// ---------------------------------------------------------------------------
// AuditAction Enum
// ---------------------------------------------------------------------------

/**
 * Exhaustive enumeration of all security-sensitive actions that trigger
 * audit log entries. This is the authoritative list per AAP Section 0.4.4.
 *
 * AuditService is injected into: AuthService, UserService,
 * ConversationService, MessageService, and EncryptionKeyService.
 *
 * Each value uses SCREAMING_SNAKE_CASE matching the Prisma enum identifiers
 * to ensure serialization consistency between database and application layers.
 * Prisma enums serialize to their identifier name — the TypeScript string
 * values must match exactly for correct type-safe comparisons.
 */
export enum AuditAction {
  /** New user account created via registration endpoint */
  USER_REGISTER = 'USER_REGISTER',

  /** Successful user login (JWT token pair issued) */
  USER_LOGIN = 'USER_LOGIN',

  /** Failed login attempt (invalid credentials) */
  USER_LOGIN_FAILED = 'USER_LOGIN_FAILED',

  /** Single session revoked (access token blacklisted in Redis) */
  SESSION_REVOKE = 'SESSION_REVOKE',

  /** All active sessions for a user revoked at once */
  SESSION_REVOKE_ALL = 'SESSION_REVOKE_ALL',

  /** User blocked another user */
  USER_BLOCK = 'USER_BLOCK',

  /** User unblocked a previously blocked user */
  USER_UNBLOCK = 'USER_UNBLOCK',

  /** Member added to a group conversation */
  GROUP_MEMBER_ADD = 'GROUP_MEMBER_ADD',

  /** Member removed from a group conversation */
  GROUP_MEMBER_REMOVE = 'GROUP_MEMBER_REMOVE',

  /** Admin role granted or revoked within a group conversation */
  GROUP_ADMIN_CHANGE = 'GROUP_ADMIN_CHANGE',

  /** Message soft-deleted (tombstone — ciphertext nulled, row retained) */
  MESSAGE_DELETE = 'MESSAGE_DELETE',

  /** Encryption prekey bundle uploaded to the server */
  KEYS_BUNDLE_UPLOAD = 'KEYS_BUNDLE_UPLOAD',
}

// ---------------------------------------------------------------------------
// CreateAuditLogDTO
// ---------------------------------------------------------------------------

/**
 * Data transfer object for writing a new audit log entry.
 *
 * Used by AuditService.log() to persist a security-sensitive action.
 *
 * CRITICAL SECURITY CONSTRAINT (R23, R32):
 * The `metadata` field MUST NOT contain any of the following:
 *   - Message plaintext or ciphertext content
 *   - Encryption keys, prekey material, or session keys
 *   - JWT tokens (access or refresh)
 *   - User passwords or password hashes
 *   - File contents or binary data
 *
 * Callers are responsible for sanitizing metadata before passing it
 * to the AuditService. The AuditService should additionally validate
 * that prohibited fields are not present.
 */
export interface CreateAuditLogDTO {
  /** The security-sensitive action being recorded */
  action: AuditAction;

  /** UUID of the user who performed the action (always required) */
  actorId: string;

  /**
   * UUID of the target entity (user, conversation, message, etc.).
   * Optional because some actions (e.g., SESSION_REVOKE_ALL) may not
   * have a specific target beyond the actor themselves.
   */
  targetId?: string;

  /**
   * Type descriptor for the target entity.
   * Examples: 'user', 'conversation', 'message', 'session', 'key_bundle'
   */
  targetType?: string;

  /**
   * Contextual metadata for the action. Structure varies by action type.
   *
   * SECURITY: MUST NOT contain message content, encryption keys,
   * JWT tokens, passwords, or file contents (R23, R32).
   *
   * Example contents by action:
   *   - USER_REGISTER: { email: 'user@example.com' }
   *   - GROUP_MEMBER_ADD: { conversationId: '...', addedUserId: '...' }
   *   - MESSAGE_DELETE: { conversationId: '...', messageId: '...' }
   */
  metadata?: Record<string, unknown>;

  /** Client IP address at the time of the action */
  ipAddress?: string;

  /** Client User-Agent header string */
  userAgent?: string;

  /**
   * Request correlation ID (UUID v4) for end-to-end traceability (R29).
   * Propagated from the originating HTTP request or WebSocket event.
   */
  correlationId?: string;
}

// ---------------------------------------------------------------------------
// AuditLogEntry
// ---------------------------------------------------------------------------

/**
 * Full audit log record representation as returned from the API
 * and stored in the database.
 *
 * IMPORTANT: This interface intentionally has NO `updatedAt` field
 * because audit records are immutable (R32: append-only, no UPDATE).
 * The database role has no UPDATE or DELETE permissions on audit_log.
 */
export interface AuditLogEntry {
  /** Unique identifier for the audit log entry (UUID) */
  id: string;

  /** The security-sensitive action that was recorded */
  action: AuditAction;

  /** UUID of the user who performed the action */
  actorId: string;

  /**
   * Denormalized display name of the actor at the time of the action.
   * Included for admin UI convenience so that log viewers do not need
   * to resolve user IDs. May be undefined for system-generated entries.
   */
  actorName?: string;

  /** UUID of the target entity, if applicable */
  targetId?: string;

  /**
   * Type descriptor for the target entity.
   * Examples: 'user', 'conversation', 'message', 'session', 'key_bundle'
   */
  targetType?: string;

  /**
   * Contextual metadata snapshot captured at the time of the action.
   *
   * SECURITY: Never contains message content, encryption keys,
   * JWT tokens, passwords, or file contents (R23, R32).
   */
  metadata?: Record<string, unknown>;

  /** Client IP address captured at the time of the action */
  ipAddress?: string;

  /** Client User-Agent header captured at the time of the action */
  userAgent?: string;

  /**
   * Request correlation ID (UUID v4) for traceability (R29).
   * Links this audit entry to the originating request across
   * log aggregation systems.
   */
  correlationId?: string;

  /**
   * ISO 8601 timestamp of when the action occurred.
   * This is the sole temporal field — there is no updatedAt
   * because audit records are immutable (R32).
   */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// AuditLogQuery
// ---------------------------------------------------------------------------

/**
 * Query parameters for filtering and paginating audit log entries.
 *
 * Supports cursor-based pagination for efficient traversal of large
 * audit log datasets. All filter fields are optional — omitting a field
 * means "no filter on this dimension."
 *
 * Used by the internal/admin audit log listing endpoint:
 *   GET /api/v1/audit?action=user.login&actorId=...&limit=50&cursor=...
 */
export interface AuditLogQuery {
  /** Filter by specific action type (e.g., AuditAction.USER_LOGIN) */
  action?: AuditAction;

  /** Filter by the UUID of the actor who performed the action */
  actorId?: string;

  /** Filter by the UUID of the target entity */
  targetId?: string;

  /**
   * ISO 8601 date string — return entries created on or after this date.
   * Example: '2026-01-01T00:00:00.000Z'
   */
  startDate?: string;

  /**
   * ISO 8601 date string — return entries created on or before this date.
   * Example: '2026-03-31T23:59:59.999Z'
   */
  endDate?: string;

  /**
   * Opaque cursor string for cursor-based pagination.
   * Obtained from the `pagination.cursor` field of a previous response.
   */
  cursor?: string;

  /**
   * Maximum number of entries to return per page.
   * Defaults to 50 if not specified. Backend may enforce a maximum cap.
   */
  limit?: number;
}
