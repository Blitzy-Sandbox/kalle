/**
 * @module @kalle/shared/types/api-contracts
 *
 * REST API Request/Response Contracts for ALL `/api/v1/*` endpoints.
 *
 * These typed contracts ensure type safety between the frontend API client
 * (`apps/web/src/lib/api.ts`) and backend controllers
 * (`apps/api/src/controllers/*.ts`). Every REST endpoint has a
 * corresponding typed request body, query params, path params, and
 * response shape defined here.
 *
 * Key design constraints:
 * - R22: Standardized error responses — all errors use ApiErrorResponse
 * - R30: All REST endpoints prefixed with `/api/v1/`
 * - R31: Input validation via Zod — these contracts define the shapes
 *         that Zod schemas validate against
 * - R17: Interface-driven dependencies — these contracts define the
 *         exact API surface
 *
 * This file contains ZERO runtime code — only TypeScript types and interfaces.
 * All imports use `import type` to ensure zero runtime footprint.
 *
 * @see AAP Section 0.2.3 — REST API request/response contracts
 * @see AAP Section 0.3.2 — Import Architecture Rules
 */

// =============================================================================
// Type-Only Imports from Sibling Modules
// =============================================================================

import type {
  UserResponse,
  UserSearchResult,
  BlockedUserInfo,
  UpdateProfileDTO,
} from './user';

import type {
  ConversationResponse,
  CreateConversationDTO,
} from './conversation';

import type {
  MessageResponse,
  SendMessageDTO,
  EditMessageDTO,
  DeleteMessageResponse,
} from './message';

import type { MediaResponse } from './media';

import type {
  StoryResponse,
  StoryFeedItem,
  CreateStoryDTO,
  StoryView,
} from './story';

import type {
  LoginDTO,
  RegisterDTO,
  TokenPair,
  SessionInfo,
  RefreshTokenDTO,
} from './auth';

import type {
  PreKeyBundleDTO,
  PreKeyBundleResponse,
} from './encryption';

import type { AuditLogEntry } from './audit';

import type { ApiErrorResponse } from './error';

// =============================================================================
// Common Types — Pagination and Response Wrappers
// =============================================================================

/**
 * Generic paginated response wrapper used by all list/search endpoints.
 *
 * Implements cursor-based pagination for consistent, scalable traversal
 * of result sets across the API. The `cursor` is an opaque string
 * derived from the last item's identifier or timestamp.
 *
 * @typeParam T - The type of items in the paginated collection
 */
export interface PaginatedResponse<T> {
  /** Array of result items for the current page */
  data: T[];

  /** Pagination metadata for traversing result sets */
  pagination: {
    /**
     * Opaque cursor string for fetching the next page.
     * Undefined when there are no more results.
     */
    cursor?: string;

    /** Whether additional pages of results exist beyond this page */
    hasMore: boolean;

    /**
     * Optional total count of matching items across all pages.
     * May be omitted for performance when the total is expensive to compute.
     */
    total?: number;
  };
}

/**
 * Generic single-item API response wrapper.
 *
 * Wraps a single data payload with optional metadata. Used by endpoints
 * that return a single resource (e.g., GET by ID, POST create, PATCH update).
 *
 * @typeParam T - The type of the response payload
 */
export interface ApiResponse<T> {
  /** The response payload */
  data: T;

  /** Optional metadata about the response (e.g., processing time, version) */
  meta?: Record<string, unknown>;
}

/**
 * Common pagination query parameters for list endpoints.
 *
 * All paginated endpoints accept these base parameters. Domain-specific
 * query interfaces extend this with additional filters.
 */
export interface PaginationQuery {
  /**
   * Opaque cursor string obtained from a previous response's
   * `pagination.cursor` field. Omit for the first page.
   */
  cursor?: string;

  /**
   * Maximum number of items to return per page.
   * Defaults to 20 if not specified; backend enforces a max of 100.
   */
  limit?: number;
}

// =============================================================================
// Auth Endpoint Contracts — /api/v1/auth/*
// =============================================================================

/**
 * POST /api/v1/auth/register — Create a new user account.
 *
 * Registration uses email + password (NOT phone OTP per AAP Section 0.8.2).
 * On success, returns the created user profile and a fresh token pair.
 */
export interface RegisterRequest {
  /** Registration payload containing email, password, displayName, and optional fields */
  body: RegisterDTO;
}

/**
 * Response for POST /api/v1/auth/register.
 *
 * Contains the sanitized user profile (no password hash) and a fresh
 * JWT access + refresh token pair for immediate API access.
 */
export interface RegisterResponse {
  data: {
    /** Sanitized user profile (excludes password hash per R23) */
    user: UserResponse;
    /** Fresh access + refresh token pair */
    tokens: TokenPair;
  };
}

/**
 * POST /api/v1/auth/login — Authenticate with email + password.
 *
 * On success, returns the user profile and a fresh token pair.
 * On failure, returns a standardized error response (ApiErrorResponse).
 */
export interface LoginRequest {
  /** Login credentials containing email and password */
  body: LoginDTO;
}

/**
 * Response for POST /api/v1/auth/login.
 *
 * Contains the authenticated user's profile and a fresh token pair.
 */
export interface LoginResponse {
  data: {
    /** Authenticated user profile (excludes password hash per R23) */
    user: UserResponse;
    /** Fresh access + refresh token pair */
    tokens: TokenPair;
  };
}

/**
 * POST /api/v1/auth/refresh — Exchange refresh token for a new token pair.
 *
 * Implements refresh token rotation: the provided refresh token is consumed
 * (invalidated) and a brand-new token pair is issued.
 */
export interface RefreshTokenRequest {
  /** Payload containing the refresh token to exchange */
  body: RefreshTokenDTO;
}

/**
 * Response for POST /api/v1/auth/refresh.
 *
 * Contains only the new token pair (no user profile — already known).
 */
export interface RefreshTokenResponse {
  data: {
    /** New access + refresh token pair replacing the consumed tokens */
    tokens: TokenPair;
  };
}

/**
 * POST /api/v1/auth/revoke — Revoke a single session (logout).
 *
 * The provided refresh token identifies the session to invalidate.
 * The server blacklists the associated JTI in Redis (R33).
 */
export interface RevokeSessionRequest {
  body: {
    /** Refresh token identifying the session to revoke */
    refreshToken: string;
  };
}

/**
 * Response for POST /api/v1/auth/revoke.
 *
 * Confirms the session was successfully revoked.
 */
export interface RevokeSessionResponse {
  data: {
    /** Human-readable confirmation message */
    message: string;
  };
}

/**
 * Response for POST /api/v1/auth/revoke-all — Revoke all active sessions (R33).
 *
 * Invalidates every active session for the authenticated user by
 * blacklisting all associated JTIs in Redis. Returns the count of
 * sessions that were revoked.
 */
export interface RevokeAllSessionsResponse {
  data: {
    /** Human-readable confirmation message */
    message: string;
    /** Number of active sessions that were revoked */
    revokedCount: number;
  };
}

// =============================================================================
// User Endpoint Contracts — /api/v1/users/*
// =============================================================================

/**
 * Response for GET /api/v1/users/me — Fetch current user's profile.
 *
 * Returns the authenticated user's full profile. No request body needed;
 * the user is identified from the JWT access token.
 */
export interface GetCurrentUserResponse {
  /** Full user profile of the authenticated user */
  data: UserResponse;
}

/**
 * PATCH /api/v1/users/me — Update current user's profile.
 *
 * Supports partial updates: only provided fields are modified.
 * Maps to Figma Screen 15 (Edit Profile).
 */
export interface UpdateProfileRequest {
  /** Partial profile update payload */
  body: UpdateProfileDTO;
}

/**
 * Response for PATCH /api/v1/users/me.
 *
 * Returns the updated user profile reflecting all changes.
 */
export interface UpdateProfileResponse {
  /** Updated user profile */
  data: UserResponse;
}

/**
 * GET /api/v1/users/search — Search users by query string.
 *
 * Cursor-paginated search results for finding contacts.
 * Extends PaginationQuery with a required search query string.
 */
export interface UserSearchQuery extends PaginationQuery {
  /** Search query string — matches against displayName and email */
  q: string;
}

/**
 * Response for GET /api/v1/users/search.
 *
 * Returns cursor-paginated search results with lightweight user data.
 */
export interface UserSearchResponse extends PaginatedResponse<UserSearchResult> {}

/**
 * Path parameters for POST /api/v1/users/:userId/block
 * and DELETE /api/v1/users/:userId/block (unblock).
 */
export interface BlockUserParams {
  /** UUID of the user to block or unblock */
  userId: string;
}

/**
 * Response for POST /api/v1/users/:userId/block.
 *
 * Confirms the block was applied and returns the blocked user's info.
 */
export interface BlockUserResponse {
  data: {
    /** Human-readable confirmation message */
    message: string;
    /** Information about the blocked user */
    blockedUser: BlockedUserInfo;
  };
}

/**
 * Response for DELETE /api/v1/users/:userId/block — Unblock a user.
 *
 * Confirms the block was removed.
 */
export interface UnblockUserResponse {
  data: {
    /** Human-readable confirmation message */
    message: string;
  };
}

/**
 * Response for GET /api/v1/users/blocked — List all blocked users.
 *
 * Returns the complete list of users blocked by the authenticated user.
 */
export interface GetBlockedUsersResponse {
  /** Array of blocked user information */
  data: BlockedUserInfo[];
}

// =============================================================================
// Conversation Endpoint Contracts — /api/v1/conversations/*
// =============================================================================

/**
 * GET /api/v1/conversations — List conversations for the authenticated user.
 *
 * Cursor-paginated list of conversations sorted by most recent activity.
 */
export interface GetConversationsQuery extends PaginationQuery {}

/**
 * Response for GET /api/v1/conversations.
 *
 * Cursor-paginated list of conversation objects.
 */
export interface GetConversationsResponse extends PaginatedResponse<ConversationResponse> {}

/**
 * POST /api/v1/conversations — Create a new conversation.
 *
 * For DIRECT conversations: participantIds must contain exactly 2 user IDs.
 * For GROUP conversations: participantIds must contain 2+ user IDs and groupName is required.
 */
export interface CreateConversationRequest {
  /** Conversation creation payload */
  body: CreateConversationDTO;
}

/**
 * Response for POST /api/v1/conversations.
 *
 * Returns the newly created conversation with all metadata.
 */
export interface CreateConversationResponse {
  /** The created conversation */
  data: ConversationResponse;
}

/**
 * Path parameters for GET /api/v1/conversations/:conversationId.
 */
export interface GetConversationParams {
  /** UUID of the conversation to retrieve */
  conversationId: string;
}

/**
 * Response for GET /api/v1/conversations/:conversationId.
 *
 * Returns the full conversation with participants, last message, and settings.
 */
export interface GetConversationResponse {
  /** The requested conversation */
  data: ConversationResponse;
}

/**
 * PATCH /api/v1/conversations/:conversationId — Update conversation settings.
 *
 * Supports per-user settings (archive, mute) and group properties (name, avatar).
 * Per-user settings apply only to the requesting user.
 * Group properties require ADMIN role.
 */
export interface UpdateConversationRequest {
  body: {
    /** Set true to archive, false to unarchive */
    isArchived?: boolean;
    /** Set true to mute, false to unmute */
    isMuted?: boolean;
    /** ISO 8601 mute expiry timestamp, or null for indefinite mute */
    muteExpiresAt?: string | null;
    /** New group display name (GROUP conversations only, requires ADMIN) */
    groupName?: string;
    /** New group avatar URL (GROUP conversations only, requires ADMIN) */
    groupAvatar?: string;
  };
}

/**
 * Response for PATCH /api/v1/conversations/:conversationId.
 *
 * Returns the updated conversation reflecting all changes.
 */
export interface UpdateConversationResponse {
  /** The updated conversation */
  data: ConversationResponse;
}

/**
 * POST /api/v1/conversations/:conversationId/members — Add a member to a group.
 *
 * Adding a member triggers Sender Key rotation (R14) so the new member
 * cannot decrypt pre-join messages.
 */
export interface AddMemberRequest {
  body: {
    /** UUID of the user to add to the group */
    userId: string;
    /** Role to assign (defaults to 'MEMBER' if omitted) */
    role?: string;
  };
}

/**
 * Response for POST /api/v1/conversations/:conversationId/members.
 *
 * Returns the updated conversation with the new member included.
 */
export interface AddMemberResponse {
  /** The updated conversation */
  data: ConversationResponse;
}

/**
 * Response for DELETE /api/v1/conversations/:conversationId/members/:userId.
 *
 * Removing a member triggers Sender Key rotation (R14) so the removed
 * member cannot decrypt post-removal messages.
 */
export interface RemoveMemberResponse {
  /** The updated conversation without the removed member */
  data: ConversationResponse;
}

// =============================================================================
// Message Endpoint Contracts — /api/v1/conversations/:id/messages, /api/v1/messages/:id
// =============================================================================

/**
 * GET /api/v1/conversations/:conversationId/messages — Fetch message history.
 *
 * Cursor-paginated message list with optional temporal filter.
 * Messages are returned in reverse chronological order (newest first).
 */
export interface GetMessagesQuery extends PaginationQuery {
  /** ISO 8601 timestamp — fetch only messages created before this time */
  before?: string;
}

/**
 * Response for GET /api/v1/conversations/:conversationId/messages.
 *
 * Cursor-paginated list of message objects.
 */
export interface GetMessagesResponse extends PaginatedResponse<MessageResponse> {}

/**
 * POST /api/v1/conversations/:conversationId/messages — Send a new message.
 *
 * The message content is E2E encrypted client-side (R12). The server
 * stores only ciphertext and never performs decryption.
 */
export interface SendMessageRequest {
  /** Encrypted message payload */
  body: SendMessageDTO;
}

/**
 * Response for POST /api/v1/conversations/:conversationId/messages.
 *
 * Returns the created message with server-assigned ID and timestamp.
 */
export interface SendMessageResponse {
  /** The created message */
  data: MessageResponse;
}

/**
 * Path parameters for PATCH /api/v1/messages/:messageId — Edit a message.
 *
 * Per R19: restricted to sender within 15-minute window.
 */
export interface EditMessageParams {
  /** UUID of the message to edit */
  messageId: string;
}

/**
 * PATCH /api/v1/messages/:messageId — Edit message ciphertext (R19).
 *
 * Replaces the stored ciphertext. Original ciphertext is NOT retained.
 * Restricted to the message sender within 15 minutes of original send.
 */
export interface EditMessageRequest {
  /** New encrypted content replacing the original ciphertext */
  body: EditMessageDTO;
}

/**
 * Response for PATCH /api/v1/messages/:messageId.
 *
 * Returns the updated message with isEdited=true and editedAt set.
 */
export interface EditMessageResponse {
  /** The edited message */
  data: MessageResponse;
}

/**
 * Path parameters for DELETE /api/v1/messages/:messageId — Delete a message.
 *
 * Per R20: soft-delete tombstone — ciphertext nulled, row retained.
 */
export interface DeleteMessageParams {
  /** UUID of the message to delete */
  messageId: string;
}

/**
 * Response for DELETE /api/v1/messages/:messageId (R20).
 *
 * Returns the tombstone state of the deleted message.
 * Named `DeleteMessageResponseContract` to avoid conflict with the
 * domain-level `DeleteMessageResponse` type from `./message`.
 */
export interface DeleteMessageResponseContract {
  /** The deleted message tombstone */
  data: DeleteMessageResponse;
}

// =============================================================================
// Media Endpoint Contracts — /api/v1/media/*
// =============================================================================

/**
 * Response for POST /api/v1/media — Upload encrypted media (R8).
 *
 * Media is encrypted client-side before upload. Server enforces
 * 25MB size limit (413) and MIME type allowlist (415).
 */
export interface UploadMediaResponse {
  /** The uploaded media metadata */
  data: MediaResponse;
}

/**
 * Path parameters for GET /api/v1/media/:mediaId — Download media metadata.
 */
export interface GetMediaParams {
  /** UUID of the media to retrieve */
  mediaId: string;
}

/**
 * Response for GET /api/v1/media/:mediaId.
 *
 * Returns the media metadata including download URL, encryption keys,
 * and thumbnail info. The actual binary download uses the URL in the response.
 */
export interface GetMediaResponse {
  /** The media metadata */
  data: MediaResponse;
}

// =============================================================================
// Story Endpoint Contracts — /api/v1/stories/*
// =============================================================================

/**
 * POST /api/v1/stories — Create a new story (R11: 24h expiry).
 *
 * Stories are NOT encrypted (unlike messages). Supports text stories
 * with colored backgrounds and image/video stories with media attachments.
 */
export interface CreateStoryRequest {
  /** Story creation payload */
  body: CreateStoryDTO;
}

/**
 * Response for POST /api/v1/stories.
 *
 * Returns the created story with server-assigned ID, expiry, and metadata.
 */
export interface CreateStoryResponse {
  /** The created story */
  data: StoryResponse;
}

/**
 * Response for GET /api/v1/stories/feed — Fetch story feed.
 *
 * Returns stories grouped by author, sorted by most recent activity.
 * Only non-expired stories are included.
 */
export interface GetStoryFeedResponse {
  /** Array of story feed items grouped by user */
  data: StoryFeedItem[];
}

/**
 * Path parameters for POST /api/v1/stories/:storyId/view — Mark story as viewed.
 */
export interface ViewStoryParams {
  /** UUID of the story being viewed */
  storyId: string;
}

/**
 * Response for POST /api/v1/stories/:storyId/view.
 *
 * Returns the view record confirming the story was marked as viewed.
 * Duplicate views (same viewer + story) do not create additional records.
 */
export interface ViewStoryResponse {
  /** The story view record */
  data: StoryView;
}

/**
 * Path parameters for DELETE /api/v1/stories/:storyId — Delete own story.
 */
export interface DeleteStoryParams {
  /** UUID of the story to delete */
  storyId: string;
}

/**
 * Response for DELETE /api/v1/stories/:storyId.
 *
 * Confirms the story was deleted. Only the story author can delete their own stories.
 */
export interface DeleteStoryResponse {
  data: {
    /** Human-readable confirmation message */
    message: string;
  };
}

// =============================================================================
// Encryption Key Endpoint Contracts — /api/v1/keys/*
// =============================================================================

/**
 * POST /api/v1/keys/bundle — Upload a prekey bundle (R12: E2E encryption).
 *
 * The client uploads identity key, signed prekey, and one-time prekeys
 * so other users can initiate X3DH sessions for encrypted messaging.
 */
export interface UploadKeyBundleRequest {
  /** PreKey bundle payload containing identity key, signed prekey, and one-time prekeys */
  body: PreKeyBundleDTO;
}

/**
 * Response for POST /api/v1/keys/bundle.
 *
 * Confirms the prekey bundle was uploaded successfully.
 */
export interface UploadKeyBundleResponse {
  data: {
    /** Human-readable confirmation message */
    message: string;
  };
}

/**
 * Path parameters for GET /api/v1/keys/bundle/:userId — Fetch a user's prekey bundle.
 */
export interface GetKeyBundleParams {
  /** UUID of the user whose prekey bundle to fetch */
  userId: string;
}

/**
 * Response for GET /api/v1/keys/bundle/:userId.
 *
 * Returns the user's identity key, signed prekey, and one consumed one-time prekey.
 * The one-time prekey (if available) is removed from the server after fetch.
 */
export interface GetKeyBundleResponse {
  /** The target user's prekey bundle */
  data: PreKeyBundleResponse;
}

// =============================================================================
// Health & Metrics Endpoint Contracts — /api/v1/health, /api/v1/metrics
// =============================================================================

/**
 * Response for GET /api/v1/health — Component-level health check.
 *
 * Returns the overall system status and individual component health
 * (database, Redis, BullMQ queue, file storage) with latency measurements.
 */
export interface HealthCheckResponse {
  data: {
    /** Overall system health status */
    status: 'healthy' | 'degraded' | 'unhealthy';
    /** Application version string (from package.json) */
    version: string;
    /** Server uptime in seconds */
    uptime: number;
    /** Individual component health statuses */
    components: {
      /** PostgreSQL database health */
      database: ComponentHealth;
      /** Redis cache and pub/sub health */
      redis: ComponentHealth;
      /** BullMQ job queue health */
      queue: ComponentHealth;
      /** File storage system health */
      storage: ComponentHealth;
    };
  };
}

/**
 * Health status of an individual infrastructure component.
 *
 * Used within HealthCheckResponse to report per-component health
 * with optional latency measurement and diagnostic details.
 */
export interface ComponentHealth {
  /** Whether the component is operational */
  status: 'up' | 'down';
  /** Response latency in milliseconds (optional, measured via ping/query) */
  latency?: number;
  /** Additional diagnostic details (e.g., version, pool size, queue depth) */
  details?: Record<string, unknown>;
}

/**
 * Response type for GET /api/v1/metrics — Prometheus metrics endpoint (R37).
 *
 * The metrics endpoint returns text/plain in Prometheus exposition format,
 * not typed JSON. This interface exists for internal type safety and
 * content-type negotiation only.
 */
export interface MetricsResponse {
  /** Content type of the metrics response (always Prometheus text format) */
  contentType: 'text/plain';
}

// =============================================================================
// Audit Endpoint Contracts — /api/v1/audit (internal/admin)
// =============================================================================

/**
 * GET /api/v1/audit — Query audit log entries (internal/admin endpoint).
 *
 * Supports filtering by action type, actor, date range, and cursor-based
 * pagination. All filter fields are optional.
 */
export interface GetAuditLogsQuery extends PaginationQuery {
  /** Filter by specific audit action type */
  action?: string;
  /** Filter by the UUID of the actor who performed the action */
  actorId?: string;
  /** ISO 8601 date string — return entries created on or after this date */
  startDate?: string;
  /** ISO 8601 date string — return entries created on or before this date */
  endDate?: string;
}

/**
 * Response for GET /api/v1/audit.
 *
 * Cursor-paginated list of audit log entries matching the query filters.
 */
export interface GetAuditLogsResponse extends PaginatedResponse<AuditLogEntry> {}

// =============================================================================
// Internal Type References — Ensure Imported Types Are Utilized
// =============================================================================

/**
 * Discriminated union representing any API response — either a successful
 * data payload or a standardized error response (R22).
 *
 * Enables generic response handling in the API client where the consumer
 * can narrow between success and error shapes.
 *
 * @typeParam T - The expected success data type
 *
 * @example
 * ```typescript
 * type LoginResult = ApiResult<LoginResponse['data']>;
 * // LoginResult = ApiResponse<{ user: UserResponse; tokens: TokenPair }> | ApiErrorResponse
 * ```
 *
 * @see ApiErrorResponse for the error shape
 * @see ApiResponse for the success shape
 */
export type ApiResult<T> = ApiResponse<T> | ApiErrorResponse;

/**
 * Type helper for session-aware API responses that include session metadata.
 *
 * Used internally by auth endpoints that return session context alongside
 * the primary response data. Combines any response data with optional
 * session information for consumers that need session awareness.
 *
 * @typeParam T - The primary response data type
 *
 * @example
 * ```typescript
 * type AuthResult = SessionAwareResponse<{ user: UserResponse; tokens: TokenPair }>;
 * ```
 */
export type SessionAwareResponse<T> = ApiResponse<T> & {
  /** Optional session metadata associated with the response */
  session?: SessionInfo;
};
