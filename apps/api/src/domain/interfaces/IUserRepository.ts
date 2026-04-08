/**
 * @module apps/api/src/domain/interfaces/IUserRepository
 *
 * User Repository Interface — the most foundational repository contract in the system.
 *
 * Users are referenced by conversations, messages, stories, media, sessions,
 * audit logs, and encryption keys. This interface defines the persistence
 * contract for user CRUD, email-based lookup (unique index), cursor-paginated
 * search, online status tracking, and block/unblock management.
 *
 * Architecture Rules:
 * - R17: Services code against this interface — no service imports the concrete
 *   UserRepository class. All DI wiring happens in the composition root (server.ts).
 * - R16: Repository abstracts persistence. Zero business logic resides here.
 *   Password hashing is performed by AuthService, not the repository.
 * - R9: Supports authentication flows via findByEmail (login) and create (register).
 * - R23: Password hash is stored via this repository but MUST NOT appear in any
 *   logs or API responses. The shared UserResponse type excludes it.
 * - R7: TypeScript strict mode, zero warnings.
 * - R28: Zero console.log calls — structured Pino logging only.
 *
 * The concrete implementation resides at apps/api/src/repositories/UserRepository.ts
 * and uses Prisma ORM for persistence.
 */

import type {
  UserResponse,
  UserSearchResult,
  BlockedUserInfo,
  UserStatus,
  UpdateProfileDTO,
} from '@kalle/shared';

// =============================================================================
// Repository-Level Types
// =============================================================================

/**
 * Data required to create a new user record in the database.
 *
 * This interface includes `passwordHash` — the bcrypt-hashed password produced
 * by AuthService. The shared `CreateUserDTO` contains the plaintext `password`
 * field from the registration request; by the time data reaches the repository,
 * AuthService has already hashed it.
 *
 * The `id` field is optional — if omitted, the repository generates a UUID v4.
 */
export interface CreateUserData {
  /** Optional pre-generated user ID (UUID v4). Auto-generated if omitted. */
  id?: string;

  /** User's email address — unique index enforced at the database level. */
  email: string;

  /** bcrypt password hash produced by AuthService. NEVER stored as plaintext. */
  passwordHash: string;

  /** Display name shown across all UI surfaces (chat lists, messages, contacts). */
  displayName: string;

  /** Optional phone number (e.g., "+1 202 555 0181"). */
  phoneNumber?: string;

  /** Optional avatar image URL. */
  avatar?: string;

  /** Optional status/about text. Defaults to "Hey there! I am using WhatsApp". */
  about?: string;
}

/**
 * Full user record including the password hash.
 *
 * SECURITY WARNING (R23): This type includes `passwordHash` and is intended
 * for use ONLY by AuthService during login password comparison (bcrypt.compare).
 * It MUST NEVER be:
 * - Returned in any API response
 * - Logged by any logging middleware or service
 * - Serialized to any external system
 *
 * All date/time fields use ISO 8601 string format for cross-platform compatibility.
 */
export interface UserWithPassword {
  /** Unique user identifier (UUID v4). */
  id: string;

  /** User's email address. */
  email: string;

  /** bcrypt password hash — NEVER expose in responses or logs (R23). */
  passwordHash: string;

  /** Display name shown in the UI. */
  displayName: string;

  /** Phone number (optional). */
  phoneNumber?: string;

  /** Avatar image URL (optional). */
  avatar?: string;

  /** Status/about text (optional). */
  about?: string;

  /** Current online/offline status from presence tracking. */
  status: UserStatus;

  /** ISO 8601 timestamp of last user activity (set when user goes offline). */
  lastSeen?: string;

  /** ISO 8601 timestamp of account creation. */
  createdAt: string;

  /** ISO 8601 timestamp of last profile update. */
  updatedAt: string;
}

// =============================================================================
// Repository Interface
// =============================================================================

/**
 * IUserRepository — persistence contract for user aggregate root.
 *
 * All methods are asynchronous, returning Promises to support non-blocking
 * database operations. The concrete Prisma-backed implementation handles
 * connection pooling, query optimization, and error translation.
 *
 * Key design decisions:
 * - `findById` returns `UserResponse` (excludes passwordHash) for general use.
 * - `findByEmail` returns `UserWithPassword` (includes passwordHash) exclusively
 *   for AuthService login verification.
 * - `search` uses cursor-based pagination for consistent performance on large datasets.
 * - Block/unblock operations manage the BlockedUser join table.
 * - Email uniqueness is enforced by a database unique index — `create` throws
 *   a ConflictError if a duplicate email is inserted.
 */
export interface IUserRepository {
  /**
   * Create a new user record.
   *
   * Email uniqueness is enforced at the database level via a unique index.
   * If the email already exists, the concrete implementation throws a ConflictError.
   *
   * @param data - User creation payload with email, passwordHash, and displayName.
   * @returns The created user as a UserResponse (passwordHash excluded).
   */
  create(data: CreateUserData): Promise<UserResponse>;

  /**
   * Find a user by their unique identifier.
   *
   * Returns the public UserResponse shape which excludes the password hash.
   * Suitable for use across all service methods that need user data.
   *
   * @param id - The user's UUID.
   * @returns UserResponse if found, null otherwise.
   */
  findById(id: string): Promise<UserResponse | null>;

  /**
   * Find a user by their email address (case-insensitive lookup).
   *
   * Returns the full UserWithPassword record INCLUDING the passwordHash field.
   * This method exists exclusively for AuthService to perform bcrypt password
   * comparison during the login flow.
   *
   * SECURITY (R23): The caller (AuthService) MUST use the returned passwordHash
   * only for bcrypt.compare() and MUST NOT log, serialize, or propagate the hash.
   *
   * @param email - The user's email address (matched case-insensitively).
   * @returns UserWithPassword if found, null otherwise.
   */
  findByEmail(email: string): Promise<UserWithPassword | null>;

  /**
   * Update user profile fields (partial update).
   *
   * Accepts an UpdateProfileDTO where all fields are optional. Only provided
   * (non-undefined) fields are modified; omitted fields retain their current values.
   *
   * @param id - The user ID to update.
   * @param data - Partial profile update payload (displayName, avatar, about, phoneNumber).
   * @returns The updated user as a UserResponse.
   */
  update(id: string, data: UpdateProfileDTO): Promise<UserResponse>;

  /**
   * Update the user's password hash.
   *
   * Used for password change operations. AuthService hashes the new password
   * and passes the resulting bcrypt hash to this method.
   *
   * @param id - The user ID.
   * @param passwordHash - The new bcrypt password hash.
   */
  updatePassword(id: string, passwordHash: string): Promise<void>;

  /**
   * Search for users by query string with cursor-based pagination.
   *
   * Searches across displayName and email fields using case-insensitive matching.
   * The search automatically excludes:
   * - The searching user (currentUserId)
   * - Users blocked by the searching user
   *
   * @param query - The search query string to match against displayName and email.
   * @param options - Pagination and filtering options.
   * @param options.currentUserId - ID of the user performing the search (excluded from results).
   * @param options.cursor - Optional pagination cursor from a previous response.
   * @param options.limit - Optional maximum number of results to return.
   * @returns Paginated search results with items, optional next cursor, and hasMore flag.
   */
  search(
    query: string,
    options: {
      currentUserId: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<{
    items: UserSearchResult[];
    cursor?: string;
    hasMore: boolean;
  }>;

  /**
   * Update the user's online/offline presence status.
   *
   * Called by WebSocket presence handlers on connection and disconnection events.
   * When the status is set to OFFLINE, the lastSeen timestamp is typically
   * provided to record the moment of disconnection.
   *
   * @param id - The user ID.
   * @param status - The new presence status (ONLINE or OFFLINE).
   * @param lastSeen - Optional timestamp to record as last seen (typically set on OFFLINE).
   */
  updateOnlineStatus(id: string, status: UserStatus, lastSeen?: Date): Promise<void>;

  /**
   * Block another user.
   *
   * Creates a block record in the BlockedUser join table. Once blocked:
   * - The blocked user is excluded from the blocker's search results.
   * - The blocked user cannot send messages to the blocker.
   * - An audit log entry is written (by the service layer, not the repository).
   *
   * @param blockerId - The ID of the user performing the block.
   * @param blockedId - The ID of the user being blocked.
   * @returns BlockedUserInfo containing the blocked user's details and block timestamp.
   */
  blockUser(blockerId: string, blockedId: string): Promise<BlockedUserInfo>;

  /**
   * Unblock a previously blocked user.
   *
   * Removes the block record from the BlockedUser join table, restoring
   * the ability for the previously blocked user to appear in search results
   * and send messages.
   *
   * @param blockerId - The ID of the user removing the block.
   * @param blockedId - The ID of the user being unblocked.
   */
  unblockUser(blockerId: string, blockedId: string): Promise<void>;

  /**
   * Retrieve all users blocked by a specific user.
   *
   * Returns the complete block list for the given user, including display names,
   * avatars, and block timestamps for each blocked user.
   *
   * @param blockerId - The ID of the user whose block list to retrieve.
   * @returns Array of BlockedUserInfo records.
   */
  findBlockedUsers(blockerId: string): Promise<BlockedUserInfo[]>;

  /**
   * Check whether one user has blocked another.
   *
   * Used to enforce block restrictions in messaging and search operations.
   * This is a directional check: returns true only if blockerId has blocked blockedId.
   *
   * @param blockerId - The potential blocker's user ID.
   * @param blockedId - The potentially blocked user's ID.
   * @returns true if blockerId has blocked blockedId, false otherwise.
   */
  isBlocked(blockerId: string, blockedId: string): Promise<boolean>;

  /**
   * Check whether a user with the given email address exists.
   *
   * Used during the registration flow to check for duplicate emails before
   * attempting to create a new user record. This provides a faster check
   * than catching the unique constraint violation from create().
   *
   * @param email - The email address to check.
   * @returns true if a user with this email exists, false otherwise.
   */
  existsByEmail(email: string): Promise<boolean>;

  /**
   * Find multiple users by their IDs in a single query.
   *
   * Used for batch lookups such as fetching participant details for a
   * conversation, resolving sender information for message lists, or
   * populating user data for group member lists.
   *
   * Only found users are returned — missing IDs are silently omitted.
   * The returned array may be shorter than the input array.
   *
   * @param ids - Array of user IDs to look up.
   * @returns Array of UserResponse records for found users (passwordHash excluded).
   */
  findByIds(ids: string[]): Promise<UserResponse[]>;
}
