/**
 * @module @kalle/shared/types/auth
 *
 * Authentication and session-related TypeScript types, DTOs, and interfaces
 * for the Kalle WhatsApp clone application.
 *
 * Covers:
 * - User registration (email + password, NOT phone OTP)
 * - User login
 * - JWT access token payload structure with JTI for Redis-backed blacklisting
 * - Token pairs (access + refresh) with TTL metadata
 * - Session tracking for single-session and all-sessions force logout
 * - Auth response combining user profile and token pair
 *
 * Security considerations (R23 — Log Hygiene):
 * - Sensitive fields (password, tokens, JTI) must NEVER appear in application logs
 * - Consumers of these types must sanitize values before logging
 *
 * @see AAP Section 0.1.1 — Session Security
 * @see AAP Section 0.8.2 — Registration uses email+password, NOT phone OTP
 * @see R9  — Authentication on all protected routes
 * @see R33 — Session revocation via Redis-backed token blacklist (keyed by JTI)
 */

// ---------------------------------------------------------------------------
// Phase 1: Request DTOs
// ---------------------------------------------------------------------------

/**
 * Payload for new user registration.
 *
 * Registration uses email + password authentication (NOT phone OTP per AAP 0.8.2).
 * Input validation (e.g., email format, password complexity ≥8 chars) is enforced
 * by Zod schemas in the validators package before this DTO reaches the service layer.
 */
export interface RegisterDTO {
  /** Valid email address — serves as the unique account identifier. */
  email: string;

  /** User password — minimum 8 characters, complexity enforced via Zod validation. */
  password: string;

  /** User-chosen display name shown in conversations and profiles. */
  displayName: string;

  /** Optional phone number for profile display (not used for authentication). */
  phoneNumber?: string;
}

/**
 * Payload for user login via email + password.
 *
 * On success, returns an {@link AuthResponse} containing user info and a
 * {@link TokenPair}. On failure, the server returns a standardized error
 * response with an appropriate error code.
 */
export interface LoginDTO {
  /** Account email address. */
  email: string;

  /** Account password. */
  password: string;
}

/**
 * Payload for exchanging a refresh token for a new {@link TokenPair}.
 *
 * Implements refresh token rotation: the provided refresh token is consumed
 * (invalidated) and a brand-new token pair is issued. This limits the blast
 * radius of a leaked refresh token.
 */
export interface RefreshTokenDTO {
  /** Current refresh token to exchange for a new access + refresh token pair. */
  refreshToken: string;
}

// ---------------------------------------------------------------------------
// Phase 2: Token Types
// ---------------------------------------------------------------------------

/**
 * Decoded JWT access token payload structure.
 *
 * The `jti` (JWT ID) field is critical for the Redis-backed token blacklist
 * used by session revocation (R33). When a session is revoked, the `jti` is
 * stored in Redis with a TTL equal to the token's remaining lifetime. The auth
 * middleware checks this blacklist on every request.
 *
 * Standard JWT registered claims (`sub`, `iat`, `exp`) follow RFC 7519.
 */
export interface JWTPayload {
  /** Subject — the authenticated user's unique identifier (User ID). */
  sub: string;

  /** User's email address embedded in the token for convenience. */
  email: string;

  /** User's display name embedded in the token for convenience. */
  displayName: string;

  /**
   * JWT ID — a unique identifier for this specific token instance (UUID v4).
   * Used as the Redis key for blacklist lookup during session revocation (R33).
   */
  jti: string;

  /** Issued-at timestamp in Unix epoch seconds (RFC 7519 registered claim). */
  iat: number;

  /** Expiration timestamp in Unix epoch seconds (RFC 7519 registered claim). */
  exp: number;
}

/**
 * Access + refresh token pair returned after successful authentication
 * (login, registration, or token refresh).
 *
 * The access token is a short-lived JWT (e.g., 15 minutes) used to
 * authenticate API requests. The refresh token is an opaque, longer-lived
 * token (e.g., 7 days) used solely to obtain a new token pair.
 */
export interface TokenPair {
  /** Short-lived JWT access token for API authentication. */
  accessToken: string;

  /** Longer-lived opaque refresh token for obtaining new token pairs. */
  refreshToken: string;

  /** Access token time-to-live in seconds. */
  expiresIn: number;

  /** Refresh token time-to-live in seconds. */
  refreshExpiresIn: number;
}

// ---------------------------------------------------------------------------
// Phase 3: Session Types
// ---------------------------------------------------------------------------

/**
 * Represents an active (or recently active) authentication session.
 *
 * Session records are persisted in the database and referenced during:
 * - Single-session revocation (`revoke`) — targets one session by refresh token
 * - All-sessions revocation (`revoke-all`) — invalidates every active session
 *   for the user by blacklisting all associated JTIs in Redis (R33)
 *
 * The `jti` field links this session to the JWT access token currently in use,
 * enabling the auth middleware to efficiently check the Redis blacklist.
 */
export interface SessionInfo {
  /** Unique session identifier (primary key). */
  id: string;

  /** Owner user's unique identifier. */
  userId: string;

  /**
   * JWT ID of the access token associated with this session.
   * Used for Redis blacklist keying during revocation (R33).
   */
  jti: string;

  /** Client IP address captured at session creation (optional for privacy). */
  ipAddress?: string;

  /** Client user-agent string captured at session creation (optional). */
  userAgent?: string;

  /** Session creation timestamp in ISO 8601 format. */
  createdAt: string;

  /** Session expiration timestamp in ISO 8601 format. */
  expiresAt: string;

  /**
   * Whether this session is still valid.
   * Set to `false` when the session is explicitly revoked or expires.
   */
  isActive: boolean;

  /**
   * Timestamp of the most recent API call using this session (ISO 8601).
   * Updated periodically for session activity monitoring.
   */
  lastActivityAt?: string;
}

/**
 * Payload for revoking a single authentication session.
 *
 * The provided refresh token identifies the session to invalidate.
 * The server will blacklist the associated JTI in Redis and mark the
 * session record as inactive.
 */
export interface RevokeSessionDTO {
  /** Refresh token identifying the session to revoke. */
  refreshToken: string;
}

// ---------------------------------------------------------------------------
// Phase 4: Auth Response Types
// ---------------------------------------------------------------------------

/**
 * Combined response returned after successful login or registration.
 *
 * Contains a sanitized user profile (no sensitive fields like password hash)
 * alongside a fresh {@link TokenPair} for immediate API access.
 */
export interface AuthResponse {
  /** Sanitized user profile information. */
  user: {
    /** Unique user identifier. */
    id: string;

    /** User's email address. */
    email: string;

    /** User's display name. */
    displayName: string;

    /** URL to the user's avatar image (if set). */
    avatar?: string;

    /** User's phone number (if provided during registration). */
    phoneNumber?: string;
  };

  /** Fresh access + refresh token pair for API authentication. */
  tokens: TokenPair;
}
