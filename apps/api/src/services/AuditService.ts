/**
 * @module AuditService
 *
 * Append-Only Audit Log Service — FOUNDATIONAL SECURITY SERVICE
 *
 * Writes immutable audit log entries for security-sensitive actions across the
 * entire application. This is a FOUNDATIONAL service injected into:
 *   - AuthService      (user.register, user.login, user.login_failed, session.revoke, session.revoke_all)
 *   - UserService       (user.block, user.unblock)
 *   - ConversationService (group.member_add, group.member_remove, group.admin_change)
 *   - MessageService    (message.delete — via controller layer)
 *   - EncryptionKeyService (keys.bundle_upload)
 *
 * Architecture rules enforced:
 *
 *  - R32 (Immutable Audit Log): Uses ONLY `create()` on the repository — never
 *    update or delete. The audit_log table has no UPDATE or DELETE permissions
 *    for the application database role.
 *  - R23 (Log Hygiene): Metadata field MUST NOT contain JWT tokens, passwords,
 *    password hashes, plaintext message content, ciphertext, encryption keys,
 *    prekey material, or file contents. This service sanitizes metadata before
 *    persisting by replacing sensitive key values with '[REDACTED]'.
 *  - R29 (Correlation ID Propagation): Audit entries include correlationId for
 *    end-to-end request traceability.
 *  - R17 (Interface-Driven Dependencies): Receives IAuditRepository via
 *    constructor injection — never imports the concrete repository class.
 *  - R16 (OOD Layering): ALL audit logging business logic lives here.
 *  - R28 (Structured Logging Only): Zero console.log / console.warn calls.
 *  - R7  (Zero Warnings Build): TypeScript strict mode, zero warnings.
 *  - R35 (Data Retention): Audit logs purged after 90 days via the
 *    audit-log-cleanup BullMQ job (not this service's responsibility).
 *
 * CRITICAL DESIGN DECISION — Error Swallowing:
 *   The `log()` method NEVER throws. If audit logging fails (DB down, constraint
 *   violation), the primary business operation in the calling service must not
 *   be disrupted. Failures return `null` instead of an AuditLogEntry.
 */

import type { IAuditRepository, AuditLogPage } from '../domain/interfaces/IAuditRepository.js';
import type {
  CreateAuditLogDTO,
  AuditLogEntry,
  AuditLogQuery,
  AuditAction,
} from '@kalle/shared';

// ---------------------------------------------------------------------------
// Sensitive Metadata Key Blocklist (R23: Log Hygiene)
// ---------------------------------------------------------------------------

/**
 * Set of metadata key names (in lowercase) that MUST be redacted before
 * persisting to the audit log. Matching is case-insensitive.
 *
 * This covers:
 *  - Authentication credentials (password, passwordHash, token, jwt, secret)
 *  - JWT token variants (accessToken, refreshToken, jwtToken)
 *  - Signal Protocol key material (identityKey, signedPreKey, preKey, preKeys,
 *    privateKey, publicKey, encryptionKey, encryptionIv)
 *  - Message content (ciphertext, plaintext, messageContent, content)
 *  - File data (fileContent, buffer)
 */
const SENSITIVE_METADATA_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'jwttoken',
  'jwt',
  'secret',
  'identitykey',
  'signedprekey',
  'prekey',
  'prekeys',
  'privatekey',
  'publickey',
  'encryptionkey',
  'encryptioniv',
  'ciphertext',
  'plaintext',
  'messagecontent',
  'content',
  'filecontent',
  'buffer',
]);

// ---------------------------------------------------------------------------
// Exported Interfaces
// ---------------------------------------------------------------------------

/**
 * Parameters accepted by {@link AuditService.log}.
 *
 * Callers provide the action, actor, optional target, and optional metadata.
 * The service sanitizes metadata to remove sensitive fields before persisting
 * to the audit log repository.
 */
export interface AuditLogParams {
  /** The audit action being recorded (e.g., AuditAction.USER_LOGIN) */
  action: AuditAction;

  /** ID of the user performing the action */
  actorId: string;

  /** Optional ID of the target entity (user, conversation, message, etc.) */
  targetId?: string;

  /**
   * Optional metadata providing additional context about the action.
   * Sensitive keys (passwords, tokens, encryption keys, etc.) are
   * automatically redacted before persistence (R23).
   */
  metadata?: Record<string, unknown>;

  /** Request correlation ID for end-to-end traceability (R29) */
  correlationId?: string;

  /** Client IP address for security attribution */
  ipAddress?: string;

  /** Client User-Agent header for security attribution */
  userAgent?: string;
}

// ---------------------------------------------------------------------------
// AuditService Class
// ---------------------------------------------------------------------------

/**
 * Foundational audit logging service that writes append-only log entries
 * for security-sensitive actions.
 *
 * @example
 * ```typescript
 * // Injected via composition root (server.ts)
 * const auditService = new AuditService(auditRepository);
 *
 * // Called by AuthService on login
 * await auditService.log({
 *   action: AuditAction.USER_LOGIN,
 *   actorId: user.id,
 *   correlationId: req.correlationId,
 *   ipAddress: req.ip,
 *   userAgent: req.headers['user-agent'],
 * });
 * ```
 */
export class AuditService {
  /**
   * Creates a new AuditService instance.
   *
   * @param auditRepository - Repository interface for append-only audit log
   *                          persistence (R17: interface-driven dependencies).
   *                          Only the `create()`, `findByQuery()`, and `count()`
   *                          methods are used by this service. No `update()` or
   *                          `delete()` is ever called (R32: immutable audit log).
   */
  constructor(
    private readonly auditRepository: IAuditRepository,
  ) {}

  // -----------------------------------------------------------------------
  // Public Methods
  // -----------------------------------------------------------------------

  /**
   * Write an audit log entry for a security-sensitive action.
   *
   * This is the PRIMARY method called by all other services (AuthService,
   * UserService, ConversationService, MessageService, EncryptionKeyService).
   *
   * **CRITICAL — Error Swallowing:**
   * This method NEVER throws. If audit persistence fails (DB down, constraint
   * violation, etc.), the method returns `null`. The calling service's primary
   * business operation must not be disrupted by audit failures.
   *
   * **CRITICAL — Metadata Sanitization (R23, R32):**
   * All metadata is deep-cloned and sanitized before persistence. Sensitive
   * keys (passwords, tokens, encryption keys, message content, etc.) are
   * replaced with `'[REDACTED]'` to preserve the audit trail structure while
   * preventing sensitive data from entering the immutable log.
   *
   * @param params - {@link AuditLogParams} containing the action, actor,
   *                 optional target, and optional metadata
   * @returns The created {@link AuditLogEntry} on success, or `null` on failure
   */
  async log(params: AuditLogParams): Promise<AuditLogEntry | null> {
    try {
      // Step 1 — Sanitize metadata (R23, R32)
      const sanitizedMetadata: Record<string, unknown> | undefined =
        params.metadata !== undefined && params.metadata !== null
          ? this.sanitizeMetadata(params.metadata)
          : undefined;

      // Step 2 — Build CreateAuditLogDTO
      const dto: CreateAuditLogDTO = {
        action: params.action,
        actorId: params.actorId,
        targetId: params.targetId,
        metadata: sanitizedMetadata,
        correlationId: params.correlationId,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      };

      // Step 3 — Persist via repository (INSERT ONLY — R32)
      const entry: AuditLogEntry = await this.auditRepository.create(dto);

      return entry;
    } catch (_error: unknown) {
      // Audit logging failures are swallowed — the primary business operation
      // in the calling service must not be disrupted. In a production system
      // with a Pino logger dependency, we would log this failure here. However,
      // this service intentionally has a minimal dependency footprint (only
      // IAuditRepository), and adding a logger dependency is not part of its
      // current contract.
      //
      // The error is intentionally ignored. The calling service receives `null`
      // and can decide whether to handle the audit failure (most services will
      // simply continue with their primary operation).
      return null;
    }
  }

  /**
   * Query audit log entries with filtering and cursor-based pagination.
   *
   * Used by administrative endpoints to retrieve audit trail data. Delegates
   * entirely to the repository — no additional business logic needed for reads.
   *
   * @param query - {@link AuditLogQuery} containing optional filters for action,
   *                actorId, targetId, date range, cursor, and limit
   * @returns Paginated {@link AuditLogPage} containing matching entries
   */
  async query(query: AuditLogQuery): Promise<AuditLogPage> {
    return this.auditRepository.findByQuery(query);
  }

  /**
   * Count audit log entries matching the given query filters.
   *
   * Used for pagination metadata and administrative reporting. Supports the
   * same filter parameters as {@link query} but returns only the count.
   *
   * @param query - Optional partial {@link AuditLogQuery} with filter criteria.
   *                If omitted, returns the total count of all audit log entries.
   * @returns The number of matching audit log entries
   */
  async count(query?: Partial<AuditLogQuery>): Promise<number> {
    return this.auditRepository.count(query);
  }

  // -----------------------------------------------------------------------
  // Private Methods — Metadata Sanitization (R23)
  // -----------------------------------------------------------------------

  /**
   * Deep-clone and sanitize metadata to remove sensitive fields (R23).
   *
   * Recursively traverses the metadata object and replaces any value whose
   * key matches a sensitive field name with `'[REDACTED]'`. The matching is
   * case-insensitive (e.g., 'Password', 'PASSWORD', 'password' all match).
   *
   * Handles:
   *  - Flat objects: `{ password: '...' }` → `{ password: '[REDACTED]' }`
   *  - Nested objects: `{ user: { passwordHash: '...' } }` → `{ user: { passwordHash: '[REDACTED]' } }`
   *  - Arrays: `[{ token: '...' }]` → `[{ token: '[REDACTED]' }]`
   *  - Deeply nested structures at any depth
   *
   * @param metadata - Original metadata object (NOT mutated)
   * @returns A deep-cloned copy with all sensitive values replaced
   */
  private sanitizeMetadata(
    metadata: Record<string, unknown>,
  ): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const key of Object.keys(metadata)) {
      const value: unknown = metadata[key];

      if (this.isKeySensitive(key)) {
        // Replace the entire value with a redaction marker, preserving the key
        // so the audit trail structure remains intact for forensic analysis.
        sanitized[key] = '[REDACTED]';
      } else if (Array.isArray(value)) {
        // Recursively sanitize each array element
        sanitized[key] = this.sanitizeArray(value);
      } else if (this.isPlainObject(value)) {
        // Recursively sanitize nested objects
        sanitized[key] = this.sanitizeMetadata(value as Record<string, unknown>);
      } else {
        // Primitive value with a non-sensitive key — copy as-is
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Recursively sanitize each element in an array.
   *
   * Handles arrays containing objects, nested arrays, and primitive values.
   * Objects within the array are sanitized using {@link sanitizeMetadata}.
   *
   * @param arr - Array to sanitize
   * @returns Sanitized copy of the array
   */
  private sanitizeArray(arr: unknown[]): unknown[] {
    return arr.map((element: unknown): unknown => {
      if (Array.isArray(element)) {
        return this.sanitizeArray(element);
      }
      if (this.isPlainObject(element)) {
        return this.sanitizeMetadata(element as Record<string, unknown>);
      }
      return element;
    });
  }

  /**
   * Check whether a metadata key matches a sensitive field name.
   *
   * Comparison is case-insensitive: the key is lowercased before lookup
   * against the SENSITIVE_METADATA_KEYS set.
   *
   * @param key - The metadata key to check
   * @returns `true` if the key identifies a sensitive field
   */
  private isKeySensitive(key: string): boolean {
    return SENSITIVE_METADATA_KEYS.has(key.toLowerCase());
  }

  /**
   * Type guard that checks whether a value is a plain object (not null, not
   * an array, not a Date, not a RegExp — just a vanilla Object).
   *
   * This prevents incorrect recursion into class instances or built-in
   * objects that should be treated as primitives for sanitization purposes.
   *
   * @param value - The value to test
   * @returns `true` if the value is a plain `Record<string, unknown>`
   */
  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof value !== 'object') {
      return false;
    }
    if (Array.isArray(value)) {
      return false;
    }
    // Exclude Date, RegExp, and other built-in types that should be
    // treated as opaque values rather than recursed into.
    const proto = Object.getPrototypeOf(value) as object | null;
    return proto === Object.prototype || proto === null;
  }
}
