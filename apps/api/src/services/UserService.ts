/**
 * @module UserService
 *
 * User Service — manages user profile CRUD, cursor-paginated search,
 * block/unblock functionality, presence tracking, and batch lookups.
 *
 * This is the central service for all user-related business logic consumed
 * by UserController and other services (e.g., MessageService calls isBlocked
 * to enforce block restrictions before message delivery).
 *
 * Architecture Rules Enforced:
 * - R17 (Interface-Driven Dependencies): All dependencies received via constructor
 *   injection as interfaces — never imports a concrete repository or provider class.
 * - R16 (OOD Layering): ALL user business logic lives here. Controllers are thin
 *   delegation layers that parse requests, validate via Zod, and delegate here.
 * - R23 (Log Hygiene): Never logs passwords, tokens, or encryption keys.
 * - R28 (Structured Logging Only): Zero console.log calls.
 * - R7  (Zero Warnings Build): TypeScript strict mode, zero warnings.
 * - R22 (Standardized Error Responses): Throws typed DomainError subclasses that
 *   the global error handler maps to HTTP status codes.
 * - R32 (Immutable Audit Log): Writes audit entries for user.block and user.unblock
 *   security-sensitive actions via AuditService.
 *
 * Composition Root Wiring (server.ts):
 *   const userService = new UserService(userRepository, cacheProvider, auditService);
 */

import type { IUserRepository } from '../domain/interfaces/IUserRepository.js';
import type { ICacheProvider } from '../domain/interfaces/ICacheProvider.js';
import type { AuditService } from './AuditService.js';

import { NotFoundError } from '../errors/NotFoundError.js';
import { AuthorizationError } from '../errors/AuthorizationError.js';
import { ValidationError } from '../errors/ValidationError.js';

import type {
  UserResponse,
  UserSearchResult,
  UpdateProfileDTO,
  BlockedUserInfo,
  UserStatus,
} from '@kalle/shared';
import { AuditAction } from '@kalle/shared';

// =============================================================================
// Constants
// =============================================================================

/** Default number of results per search page when no limit is specified. */
const DEFAULT_SEARCH_LIMIT = 20;

/** TTL in seconds for cached presence entries in Redis (5 minutes). */
const PRESENCE_CACHE_TTL_SECONDS = 300;

// =============================================================================
// UserService Class
// =============================================================================

/**
 * Manages user profile CRUD operations, cursor-paginated search,
 * block/unblock with audit logging, and presence tracking.
 *
 * @example
 * ```typescript
 * // Injected via composition root (server.ts)
 * const userService = new UserService(userRepository, cacheProvider, auditService);
 *
 * // Get a user's profile
 * const profile = await userService.getProfile(userId);
 *
 * // Search for users
 * const results = await userService.searchUsers({
 *   query: 'Martha',
 *   currentUserId: authenticatedUser.id,
 *   limit: 20,
 * });
 *
 * // Block a user (audit log written automatically)
 * const blockInfo = await userService.blockUser({
 *   blockerId: authenticatedUser.id,
 *   blockedId: targetUserId,
 * });
 * ```
 */
export class UserService {
  /**
   * Creates a new UserService instance.
   *
   * @param userRepository - User persistence interface (R17: interface-driven).
   *   Provides findById, update, search, block/unblock operations, presence
   *   tracking, and batch lookups. Concrete Prisma-backed implementation
   *   is wired in the composition root.
   * @param cacheProvider - Cache provider interface (R17: interface-driven).
   *   Used for caching user presence data in Redis with 5-minute TTL.
   * @param auditService - Audit logging service (R32: immutable audit log).
   *   Used to write audit entries for security-sensitive actions (user.block,
   *   user.unblock). Never throws — audit failures are swallowed to avoid
   *   disrupting primary business operations.
   */
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly cacheProvider: ICacheProvider,
    private readonly auditService: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Profile Operations
  // -------------------------------------------------------------------------

  /**
   * Retrieve a user's public profile by ID.
   *
   * Returns the full UserResponse shape (excluding password hash per R23).
   *
   * @param userId - The unique user ID (UUID v4) to look up.
   * @returns UserResponse containing the user's public profile data.
   * @throws {NotFoundError} If no user exists with the given ID (HTTP 404).
   */
  async getProfile(userId: string): Promise<UserResponse> {
    const user = await this.userRepository.findById(userId);

    if (!user) {
      throw new NotFoundError('User not found', {
        resource: 'User',
        id: userId,
      });
    }

    return user;
  }

  /**
   * Update a user's profile fields (partial update).
   *
   * Accepts an UpdateProfileDTO where all fields are optional. At least one
   * field must be provided — calling with an entirely empty DTO is a
   * validation error.
   *
   * Maps to Figma Screen 15 (Edit Profile) where users can update:
   * displayName, avatar, about, and phoneNumber.
   *
   * When `requestingUserId` is provided, the service verifies that the
   * requesting user is authorized to update the target profile. Only the
   * profile owner may update their own profile (R16: business logic in
   * service layer, not controller).
   *
   * @param userId - The user ID whose profile is being updated.
   * @param data   - Partial profile update payload.
   * @param requestingUserId - Optional ID of the authenticated user requesting
   *   the update. When provided, authorization is enforced: only the profile
   *   owner may update their own profile.
   * @returns The updated UserResponse.
   * @throws {AuthorizationError} If requestingUserId differs from userId (HTTP 403).
   * @throws {ValidationError} If no update fields are provided (HTTP 400).
   * @throws {NotFoundError}   If no user exists with the given ID (HTTP 404).
   */
  async updateProfile(
    userId: string,
    data: UpdateProfileDTO,
    requestingUserId?: string,
  ): Promise<UserResponse> {
    // Enforce authorization when the requesting user ID is provided (R16)
    if (requestingUserId !== undefined && requestingUserId !== userId) {
      throw new AuthorizationError(
        'Cannot update another user\'s profile',
        {
          resource: 'User',
          targetId: userId,
        },
      );
    }
    // Validate that at least one field is provided for the update
    const hasUpdateFields =
      data.displayName !== undefined ||
      data.avatar !== undefined ||
      data.about !== undefined ||
      data.phoneNumber !== undefined;

    if (!hasUpdateFields) {
      throw new ValidationError(
        'At least one field must be provided for profile update',
        {
          fields: [
            {
              field: 'body',
              message:
                'At least one field (displayName, avatar, about, phoneNumber) must be provided',
              code: 'missing_fields',
            },
          ],
        },
      );
    }

    // Verify user exists before attempting update
    const existingUser = await this.userRepository.findById(userId);
    if (!existingUser) {
      throw new NotFoundError('User not found', {
        resource: 'User',
        id: userId,
      });
    }

    // Delegate persistence to repository (R16: zero business logic in repo)
    const updatedUser = await this.userRepository.update(userId, data);
    return updatedUser;
  }

  // -------------------------------------------------------------------------
  // Search Operations
  // -------------------------------------------------------------------------

  /**
   * Search for users by query string with cursor-based pagination.
   *
   * Searches across displayName and email fields using case-insensitive
   * matching. The search automatically excludes:
   * - The searching user (currentUserId)
   * - Users blocked by the searching user
   *
   * Results are cursor-paginated for consistent performance on large datasets.
   *
   * @param params - Search parameters.
   * @param params.query - The search query string (must not be empty).
   * @param params.currentUserId - ID of the searching user (excluded from results).
   * @param params.cursor - Optional pagination cursor from a previous response.
   * @param params.limit - Optional maximum results per page (default: 20).
   * @returns Paginated results with items, optional next cursor, and hasMore flag.
   * @throws {ValidationError} If the search query is empty or whitespace-only (HTTP 400).
   */
  async searchUsers(params: {
    query: string;
    currentUserId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    items: UserSearchResult[];
    cursor?: string;
    hasMore: boolean;
  }> {
    const trimmedQuery = params.query.trim();

    if (trimmedQuery.length === 0) {
      throw new ValidationError('Search query must not be empty', {
        fields: [
          {
            field: 'query',
            message: 'Search query must not be empty',
            code: 'empty_query',
          },
        ],
      });
    }

    // Delegate to repository — it handles exclusion of self and blocked users
    return this.userRepository.search(trimmedQuery, {
      currentUserId: params.currentUserId,
      cursor: params.cursor,
      limit: params.limit ?? DEFAULT_SEARCH_LIMIT,
    });
  }

  // -------------------------------------------------------------------------
  // Block/Unblock Operations (R32 — Audit Logging)
  // -------------------------------------------------------------------------

  /**
   * Block another user.
   *
   * Creates a block record. Once blocked:
   * - The blocked user is excluded from the blocker's search results.
   * - The blocked user cannot send messages to the blocker.
   * - An immutable audit log entry is written (R32).
   *
   * This operation is idempotent: if the user is already blocked, the
   * existing block info is returned without creating a duplicate or
   * writing another audit entry.
   *
   * @param params - Block parameters.
   * @param params.blockerId - ID of the user performing the block.
   * @param params.blockedId - ID of the user being blocked.
   * @returns BlockedUserInfo with the blocked user's details and timestamp.
   * @throws {ValidationError} If blockerId equals blockedId — cannot block self (HTTP 400).
   * @throws {NotFoundError}   If the target user (blockedId) does not exist (HTTP 404).
   */
  async blockUser(params: {
    blockerId: string;
    blockedId: string;
  }): Promise<BlockedUserInfo> {
    const { blockerId, blockedId } = params;

    // Prevent self-blocking
    if (blockerId === blockedId) {
      throw new ValidationError('Cannot block yourself', {
        fields: [
          {
            field: 'blockedId',
            message: 'You cannot block yourself',
            code: 'self_block',
          },
        ],
      });
    }

    // Verify the target user exists
    const targetUser = await this.userRepository.findById(blockedId);
    if (!targetUser) {
      throw new NotFoundError('User not found', {
        resource: 'User',
        id: blockedId,
      });
    }

    // Check if already blocked — idempotent behavior
    const alreadyBlocked = await this.userRepository.isBlocked(
      blockerId,
      blockedId,
    );

    if (alreadyBlocked) {
      // Return existing block info without creating a duplicate
      const blockedUsers =
        await this.userRepository.findBlockedUsers(blockerId);
      const existingBlock = blockedUsers.find(
        (blocked) => blocked.userId === blockedId,
      );

      if (existingBlock) {
        return existingBlock;
      }
      // Defensive fallback: if isBlocked returned true but findBlockedUsers
      // doesn't contain the entry (unlikely race condition), proceed to
      // create the block record.
    }

    // Create block record in persistence layer
    const blockInfo = await this.userRepository.blockUser(
      blockerId,
      blockedId,
    );

    // Write immutable audit log entry (R32)
    // AuditService.log() never throws — failures are swallowed to avoid
    // disrupting the primary business operation.
    await this.auditService.log({
      action: AuditAction.USER_BLOCK,
      actorId: blockerId,
      targetId: blockedId,
    });

    return blockInfo;
  }

  /**
   * Unblock a previously blocked user.
   *
   * Removes the block record, restoring the ability for the previously
   * blocked user to appear in search results and send messages.
   * An immutable audit log entry is written (R32).
   *
   * @param params - Unblock parameters.
   * @param params.blockerId - ID of the user removing the block.
   * @param params.blockedId - ID of the user being unblocked.
   * @throws {NotFoundError} If no block exists between the two users (HTTP 404).
   */
  async unblockUser(params: {
    blockerId: string;
    blockedId: string;
  }): Promise<void> {
    const { blockerId, blockedId } = params;

    // Verify block relationship exists
    const blocked = await this.userRepository.isBlocked(blockerId, blockedId);
    if (!blocked) {
      throw new NotFoundError('Block not found', {
        resource: 'BlockedUser',
        blockerId,
        blockedId,
      });
    }

    // Remove block record from persistence layer
    await this.userRepository.unblockUser(blockerId, blockedId);

    // Write immutable audit log entry (R32)
    await this.auditService.log({
      action: AuditAction.USER_UNBLOCK,
      actorId: blockerId,
      targetId: blockedId,
    });
  }

  /**
   * Retrieve all users blocked by a specific user.
   *
   * Returns the complete block list including display names, avatars,
   * and block timestamps for each blocked user.
   *
   * @param blockerId - ID of the user whose block list to retrieve.
   * @returns Array of BlockedUserInfo records.
   */
  async getBlockedUsers(blockerId: string): Promise<BlockedUserInfo[]> {
    return this.userRepository.findBlockedUsers(blockerId);
  }

  /**
   * Check whether one user has blocked another.
   *
   * This is a directional check: returns true only if blockerId has
   * blocked blockedId. Used by MessageService to check if sender is
   * blocked before delivery.
   *
   * @param params - Check parameters.
   * @param params.blockerId - The potential blocker's user ID.
   * @param params.blockedId - The potentially blocked user's ID.
   * @returns true if blockerId has blocked blockedId, false otherwise.
   */
  async isBlocked(params: {
    blockerId: string;
    blockedId: string;
  }): Promise<boolean> {
    return this.userRepository.isBlocked(params.blockerId, params.blockedId);
  }

  // -------------------------------------------------------------------------
  // Presence Operations
  // -------------------------------------------------------------------------

  /**
   * Update a user's online/offline presence status.
   *
   * Called by WebSocket presence handlers on connection and disconnection
   * events. Updates both the persistent database record and the Redis
   * cache for fast presence lookups.
   *
   * Cache key format: `presence:{userId}`
   * Cache TTL: 5 minutes (300 seconds) — stale presence data auto-expires.
   *
   * @param params - Presence update parameters.
   * @param params.userId - The user whose presence is being updated.
   * @param params.status - The new UserStatus (ONLINE or OFFLINE).
   * @param params.lastSeen - Optional timestamp (typically set when going OFFLINE).
   */
  async updateOnlineStatus(params: {
    userId: string;
    status: UserStatus;
    lastSeen?: Date;
  }): Promise<void> {
    const { userId, status, lastSeen } = params;

    // Persist presence update in the database
    await this.userRepository.updateOnlineStatus(userId, status, lastSeen);

    // Cache presence in Redis with 5-minute TTL for fast lookups
    // Presence data is inherently transient — stale entries auto-expire.
    await this.cacheProvider.set(
      `presence:${userId}`,
      {
        status,
        lastSeen: lastSeen ? lastSeen.toISOString() : undefined,
      },
      PRESENCE_CACHE_TTL_SECONDS,
    );
  }

  // -------------------------------------------------------------------------
  // Batch Operations
  // -------------------------------------------------------------------------

  /**
   * Retrieve multiple users by their IDs in a single query.
   *
   * Used for batch lookups such as fetching participant details for
   * a conversation, resolving sender information for message lists,
   * or populating user data for group member lists.
   *
   * Only found users are returned — missing IDs are silently omitted.
   * The returned array may be shorter than the input array.
   *
   * @param ids - Array of user IDs (UUID v4) to look up.
   * @returns Array of UserResponse records for found users.
   */
  async getUsersByIds(ids: string[]): Promise<UserResponse[]> {
    if (ids.length === 0) {
      return [];
    }

    return this.userRepository.findByIds(ids);
  }

}
