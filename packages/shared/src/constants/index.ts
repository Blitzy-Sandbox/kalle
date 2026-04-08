/**
 * @module @kalle/shared/constants
 *
 * Single source of truth for all configuration constants, rate limits, size limits,
 * TTL values, MIME type allowlists, and thresholds used across the entire Kalle monorepo.
 *
 * Design principles:
 * - `as const` everywhere for literal type inference
 * - Zero external dependencies — pure TypeScript constants only
 * - Organized by domain into named exported objects
 * - All values are `export const` for tree-shaking
 * - No runtime side effects — only declarations and types
 */

// ---------------------------------------------------------------------------
// Rate Limit Constants (R25)
// ---------------------------------------------------------------------------

/**
 * Rate limiting thresholds for WebSocket connections and HTTP endpoints.
 *
 * WebSocket limits are per-connection per-minute.
 * HTTP limits are per-IP per-window.
 *
 * @see R25 — WebSocket Rate Limiting
 */
export const RATE_LIMITS = {
  /** WebSocket: max message:send events per minute per connection (R25) */
  WS_MESSAGE_SEND_PER_MIN: 30,
  /** WebSocket: max typing:start events per minute per connection (R25) */
  WS_TYPING_PER_MIN: 10,
  /** WebSocket: max events per minute for all other event types per connection (R25) */
  WS_DEFAULT_PER_MIN: 60,
  /** HTTP: general API rate limit — max requests per IP per window */
  HTTP_REQUESTS_PER_WINDOW: 100,
  /** HTTP: general rate limit window in milliseconds (1 minute = 60,000 ms) */
  HTTP_WINDOW_MS: 60_000,
  /** HTTP: auth endpoints rate limit — max requests per IP per window (stricter) */
  HTTP_AUTH_REQUESTS_PER_WINDOW: 20,
  /** HTTP: auth rate limit window in milliseconds (15 minutes = 900,000 ms) */
  HTTP_AUTH_WINDOW_MS: 900_000,
} as const;

// ---------------------------------------------------------------------------
// File Size Limit Constants (R8, R27)
// ---------------------------------------------------------------------------

/**
 * File upload and media processing size constraints.
 *
 * @see R8  — Media Upload Validation (25 MB limit)
 * @see R27 — Client-Side Thumbnail Generation (200 px max)
 */
export const SIZE_LIMITS = {
  /** Maximum file upload size in bytes (25 MB = 26,214,400 bytes) — R8 */
  MAX_UPLOAD_BYTES: 26_214_400,
  /** Maximum file upload size in megabytes (for display purposes) */
  MAX_UPLOAD_MB: 25,
  /** Maximum thumbnail longest edge in pixels — R27 */
  THUMBNAIL_MAX_DIMENSION_PX: 200,
} as const;

// ---------------------------------------------------------------------------
// TTL (Time-To-Live) Constants (R11, R19, R35, R36)
// ---------------------------------------------------------------------------

/**
 * All time-based configuration values for token expiry, story lifecycle,
 * message editing windows, typing indicators, and data retention.
 *
 * @see R11 — Story Expiration and Cleanup
 * @see R19 — Message Edit Integrity (15-minute window)
 * @see R35 — Data Retention Enforcement
 * @see R36 — Database Backup (7-day retention)
 */
export const TTL = {
  /** Story expiration in milliseconds (24 hours = 86,400,000 ms) — R11, R35 */
  STORY_EXPIRATION_MS: 86_400_000,
  /** Story expiration in seconds (24 hours = 86,400 s) — for Redis TTL */
  STORY_EXPIRATION_SECONDS: 86_400,
  /** Story cleanup job interval in milliseconds (1 hour = 3,600,000 ms) — R11 */
  STORY_CLEANUP_INTERVAL_MS: 3_600_000,
  /** Audit log retention in days — R35 */
  AUDIT_LOG_RETENTION_DAYS: 90,
  /** Typing indicator expiry in milliseconds (5 seconds = 5,000 ms) */
  TYPING_EXPIRY_MS: 5_000,
  /** Typing indicator debounce interval in milliseconds (3 seconds = 3,000 ms) */
  TYPING_DEBOUNCE_MS: 3_000,
  /** Message edit window in milliseconds (15 minutes = 900,000 ms) — R19 */
  MESSAGE_EDIT_WINDOW_MS: 900_000,
  /** Message edit window in minutes (for display/error messages) — R19 */
  MESSAGE_EDIT_WINDOW_MINUTES: 15,
  /** Access token expiry in seconds (15 minutes = 900 s) */
  ACCESS_TOKEN_EXPIRY_SECONDS: 900,
  /** Access token expiry string for jsonwebtoken library */
  ACCESS_TOKEN_EXPIRY: '15m',
  /** Refresh token expiry in seconds (7 days = 604,800 s) */
  REFRESH_TOKEN_EXPIRY_SECONDS: 604_800,
  /** Refresh token expiry string for jsonwebtoken library */
  REFRESH_TOKEN_EXPIRY: '7d',
  /** Presence online TTL in seconds (for Redis presence keys) */
  PRESENCE_ONLINE_TTL_SECONDS: 60,
  /** Backup retention in days — R36 */
  BACKUP_RETENTION_DAYS: 7,
} as const;

// ---------------------------------------------------------------------------
// MIME Type Allowlist (R8)
// ---------------------------------------------------------------------------

/**
 * Allowed MIME types grouped by media category.
 * Server validates uploads against this allowlist — rejects disallowed types with 415.
 *
 * @see R8 — Media Upload Validation
 */
export const MIME_TYPES = {
  /** Allowed image MIME types */
  IMAGE: [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/heic',
    'image/heif',
  ],
  /** Allowed video MIME types */
  VIDEO: [
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/3gpp',
  ],
  /** Allowed document MIME types */
  DOCUMENT: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'application/zip',
    'application/x-rar-compressed',
  ],
  /** Allowed audio MIME types (voice notes and audio files) */
  AUDIO: [
    'audio/mpeg',
    'audio/mp4',
    'audio/ogg',
    'audio/webm',
    'audio/wav',
    'audio/aac',
  ],
} as const;

/** All allowed MIME types as a flat readonly array */
export const ALL_ALLOWED_MIME_TYPES = [
  ...MIME_TYPES.IMAGE,
  ...MIME_TYPES.VIDEO,
  ...MIME_TYPES.DOCUMENT,
  ...MIME_TYPES.AUDIO,
] as const;

/** TypeScript type representing any single allowed MIME type string */
export type AllowedMimeType = (typeof ALL_ALLOWED_MIME_TYPES)[number];

// ---------------------------------------------------------------------------
// Pagination Constants
// ---------------------------------------------------------------------------

/**
 * Default and maximum page sizes for cursor-paginated list endpoints.
 */
export const PAGINATION = {
  /** Default number of items per page for general list endpoints */
  DEFAULT_PAGE_SIZE: 20,
  /** Maximum allowed items per page (prevents abuse) */
  MAX_PAGE_SIZE: 100,
  /** Default page size for message history (conversations load more messages) */
  DEFAULT_MESSAGE_PAGE_SIZE: 50,
  /** Maximum messages per page */
  MAX_MESSAGE_PAGE_SIZE: 200,
} as const;

// ---------------------------------------------------------------------------
// Encryption Constants
// ---------------------------------------------------------------------------

/**
 * Signal Protocol key management thresholds.
 */
export const ENCRYPTION = {
  /** Minimum number of prekeys before triggering replenishment notification */
  PREKEY_LOW_THRESHOLD: 10,
  /** Number of prekeys to generate in a batch during replenishment */
  PREKEY_BATCH_SIZE: 100,
  /** Initial number of prekeys to generate on registration */
  PREKEY_INITIAL_COUNT: 100,
} as const;

// ---------------------------------------------------------------------------
// WebSocket Event Names
// ---------------------------------------------------------------------------

/**
 * WebSocket event name constants using colon-separated namespace format.
 * Must align with the typed event map in `types/websocket-events.ts`.
 */
export const WS_EVENTS = {
  /** Client → Server: send a new encrypted message */
  MESSAGE_SEND: 'message:send',
  /** Server → Client: a new message has arrived */
  MESSAGE_NEW: 'message:new',
  /** Client → Server: edit an existing message */
  MESSAGE_EDIT: 'message:edit',
  /** Server → Client: a message has been edited */
  MESSAGE_EDITED: 'message:edited',
  /** Client → Server: delete a message */
  MESSAGE_DELETE: 'message:delete',
  /** Server → Client: a message has been deleted (tombstone) */
  MESSAGE_DELETED: 'message:deleted',
  /** Client → Server: message was delivered to this client */
  MESSAGE_DELIVERED: 'message:delivered',
  /** Client → Server: message was read by this client */
  MESSAGE_READ: 'message:read',
  /** Client → Server: request missed messages for offline sync — R13 */
  MESSAGE_SYNC: 'message:sync',
  /** Server → Client: response to message:sync with missed messages */
  MESSAGE_SYNC_RESPONSE: 'message:sync:response',
  /** Client → Server: user started typing in a conversation */
  TYPING_START: 'typing:start',
  /** Client → Server: user stopped typing */
  TYPING_STOP: 'typing:stop',
  /** Server → Client: typing indicator broadcast to conversation */
  TYPING_INDICATOR: 'typing:indicator',
  /** Server → Client: user presence change (online/offline/last-seen) */
  USER_PRESENCE: 'user:presence',
  /** Internal: user came online */
  USER_ONLINE: 'user:online',
  /** Internal: user went offline */
  USER_OFFLINE: 'user:offline',
  /** Server → Client: link preview metadata extracted by BullMQ job */
  LINK_PREVIEW: 'link:preview',
  /** Server → Client: connection-level error notification */
  CONNECTION_ERROR: 'connection:error',
} as const;

// ---------------------------------------------------------------------------
// BullMQ Queue Names
// ---------------------------------------------------------------------------

/**
 * BullMQ queue identifiers matching the worker job processors.
 *
 * @see workers/queue/src/jobs/ for job implementations
 * @see R18 — Fan-Out via Queue
 */
export const QUEUE_NAMES = {
  /** Group message delivery fan-out to all participants */
  MESSAGE_FANOUT: 'message-fanout',
  /** Sender Key redistribution on group membership change — R14 */
  SENDER_KEY_DISTRIBUTION: 'sender-key-distribution',
  /** URL OG metadata extraction for link preview cards */
  LINK_PREVIEW: 'link-preview',
  /** Hourly expired story and media purge — R11 */
  STORY_CLEANUP: 'story-cleanup',
  /** Periodic audit log entries older than 90 days purge — R35 */
  AUDIT_LOG_CLEANUP: 'audit-log-cleanup',
  /** Notify client when prekey supply drops below threshold */
  PREKEY_REPLENISH: 'prekey-replenish-notification',
} as const;

// ---------------------------------------------------------------------------
// HTTP Status Code Constants
// ---------------------------------------------------------------------------

/**
 * Commonly used HTTP status codes referenced by the domain error hierarchy.
 *
 * @see apps/api/src/errors/ for typed error classes
 */
export const HTTP_STATUS = {
  /** 200 — Success */
  OK: 200,
  /** 201 — Resource created */
  CREATED: 201,
  /** 204 — Success with no response body */
  NO_CONTENT: 204,
  /** 400 — Validation / bad request — ValidationError */
  BAD_REQUEST: 400,
  /** 401 — Authentication failure — AuthenticationError */
  UNAUTHORIZED: 401,
  /** 403 — Authorization failure — AuthorizationError */
  FORBIDDEN: 403,
  /** 404 — Resource not found — NotFoundError */
  NOT_FOUND: 404,
  /** 409 — Resource conflict — ConflictError */
  CONFLICT: 409,
  /** 413 — File too large — PayloadTooLargeError (R8) */
  PAYLOAD_TOO_LARGE: 413,
  /** 415 — Disallowed MIME type — UnsupportedMediaTypeError (R8) */
  UNSUPPORTED_MEDIA_TYPE: 415,
  /** 429 — Rate limit exceeded — RateLimitError (R25) */
  TOO_MANY_REQUESTS: 429,
  /** 500 — Internal server error */
  INTERNAL_SERVER_ERROR: 500,
} as const;
