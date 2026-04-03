/**
 * @module apps/api/src/repositories/UserRepository
 *
 * Prisma-backed implementation of the IUserRepository interface.
 *
 * Handles user persistence operations including CRUD, email-based lookup,
 * cursor-paginated search, online status updates, and block/unblock management.
 * This is the most foundational repository — many other repositories and
 * services reference users through this persistence layer.
 *
 * Architecture rules enforced:
 * - R17: Implements IUserRepository interface (interface-driven DI).
 *        PrismaClient injected via constructor — no hard-coded instantiation.
 * - R16: Zero business logic — persistence only. Password hashing, validation,
 *        access control, and domain rules live in AuthService/UserService.
 * - R23: UserWithPassword (including passwordHash) is ONLY returned from
 *        findByEmail for AuthService login. All other methods return
 *        UserResponse which excludes passwordHash.
 * - R28: Zero console.log — structured Pino logging handled at service layer.
 * - R7:  TypeScript strict mode, zero warnings.
 *
 * Field mapping (Prisma ↔ Shared types):
 * - Prisma `avatarUrl` → Shared `avatar`
 * - Prisma `isOnline` (boolean) → Shared `status` (UserStatus enum)
 * - Prisma `DateTime` fields → ISO 8601 strings
 */

import type { PrismaClient, User } from '@prisma/client';
import type {
  IUserRepository,
  CreateUserData,
  UserWithPassword,
} from '../domain/interfaces/IUserRepository.js';
import {
  UserStatus,
  type UserResponse,
  type UserSearchResult,
  type BlockedUserInfo,
  type UpdateProfileDTO,
} from '@kalle/shared';

// =============================================================================
// UserRepository — Prisma-backed implementation
// =============================================================================

export class UserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ─── Create ──────────────────────────────────────────────────────────

  /**
   * Creates a new user record in the database.
   *
   * Password hashing is handled by AuthService — this method receives
   * the already-hashed password. If `data.id` is provided, it is used
   * as the primary key; otherwise, Prisma generates a UUID v4.
   *
   * Email uniqueness is enforced by a database unique index. If the
   * email already exists, Prisma throws a unique constraint violation
   * error which should be translated to a ConflictError by the service.
   *
   * @param data - User creation payload with email, passwordHash, and displayName.
   * @returns The created user as a UserResponse (passwordHash excluded).
   */
  async create(data: CreateUserData): Promise<UserResponse> {
    const record = await this.prisma.user.create({
      data: {
        ...(data.id !== undefined ? { id: data.id } : {}),
        email: data.email,
        passwordHash: data.passwordHash,
        displayName: data.displayName,
        phoneNumber: data.phoneNumber ?? null,
        avatarUrl: data.avatar ?? null,
        ...(data.about !== undefined ? { about: data.about } : {}),
      },
    });

    return this.mapToResponse(record);
  }

  // ─── Find by ID ──────────────────────────────────────────────────────

  /**
   * Finds a user by their unique identifier.
   * Returns UserResponse (no passwordHash) suitable for general use.
   *
   * @param id - The user's UUID.
   * @returns UserResponse if found, null otherwise.
   */
  async findById(id: string): Promise<UserResponse | null> {
    const record = await this.prisma.user.findUnique({
      where: { id },
    });

    return record ? this.mapToResponse(record) : null;
  }

  // ─── Find by Email (Auth-only — includes passwordHash) ───────────────

  /**
   * Finds a user by email address, INCLUDING passwordHash.
   *
   * SECURITY WARNING (R23): This is the ONLY method that returns
   * the passwordHash field. It exists exclusively for AuthService
   * to perform bcrypt.compare() during login verification.
   * The returned UserWithPassword MUST NOT be logged, serialized
   * to API responses, or propagated beyond the auth flow.
   *
   * @param email - The user's email address.
   * @returns UserWithPassword if found, null otherwise.
   */
  async findByEmail(email: string): Promise<UserWithPassword | null> {
    const record = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!record) return null;

    return {
      id: record.id,
      email: record.email,
      passwordHash: record.passwordHash,
      displayName: record.displayName,
      phoneNumber: record.phoneNumber ?? undefined,
      avatar: record.avatarUrl ?? undefined,
      about: record.about ?? undefined,
      status: record.isOnline ? UserStatus.ONLINE : UserStatus.OFFLINE,
      lastSeen: record.lastSeen ? record.lastSeen.toISOString() : undefined,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  // ─── Update Profile ──────────────────────────────────────────────────

  /**
   * Updates a user's profile information (partial update).
   * Only modifies fields present in the UpdateProfileDTO — omitted fields
   * retain their current values. Maps DTO `avatar` → Prisma `avatarUrl`.
   * Prisma's @updatedAt handles the updatedAt timestamp automatically.
   *
   * @param id - The user ID to update.
   * @param data - Partial profile update payload.
   * @returns The updated user as a UserResponse.
   */
  async update(id: string, data: UpdateProfileDTO): Promise<UserResponse> {
    const record = await this.prisma.user.update({
      where: { id },
      data: {
        ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
        ...(data.avatar !== undefined ? { avatarUrl: data.avatar } : {}),
        ...(data.about !== undefined ? { about: data.about } : {}),
        ...(data.phoneNumber !== undefined ? { phoneNumber: data.phoneNumber } : {}),
      },
    });

    return this.mapToResponse(record);
  }

  // ─── Update Password ─────────────────────────────────────────────────

  /**
   * Updates only the user's password hash.
   * New hash is computed by AuthService before calling this method.
   * Prisma's @updatedAt automatically updates the timestamp.
   *
   * @param id - The user ID.
   * @param passwordHash - The new bcrypt password hash.
   */
  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash },
    });
  }

  // ─── Search (Cursor-Paginated) ───────────────────────────────────────

  /**
   * Searches users by display name or email with cursor-based pagination.
   *
   * Automatically excludes:
   * - The searching user (currentUserId)
   * - Users blocked by the searching user (blockerId = currentUserId)
   *
   * Uses case-insensitive matching via Prisma's `contains` with `mode: 'insensitive'`.
   * Results are ordered alphabetically by displayName.
   *
   * Cursor pagination: fetches `limit + 1` records to determine if more exist.
   * Returns the last item's ID as the next cursor when hasMore is true.
   *
   * @param query - Search string matched against displayName and email.
   * @param options - Required pagination and filtering options.
   * @returns Paginated search results with items, optional next cursor, and hasMore flag.
   */
  async search(
    query: string,
    options: { currentUserId: string; cursor?: string; limit?: number },
  ): Promise<{ items: UserSearchResult[]; cursor?: string; hasMore: boolean }> {
    const limit = options.limit ?? 20;

    // Fetch IDs of users blocked by the searching user to exclude from results
    const blockedRecords = await this.prisma.blockedUser.findMany({
      where: { blockerId: options.currentUserId },
      select: { blockedId: true },
    });
    const blockedIds = blockedRecords.map((r) => r.blockedId);

    // Combine exclusion list: self + blocked users
    const excludeIds = [options.currentUserId, ...blockedIds];

    const records = await this.prisma.user.findMany({
      where: {
        OR: [
          { displayName: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
        ],
        id: { notIn: excludeIds },
      },
      orderBy: { displayName: 'asc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = records.length > limit;
    const items = records.slice(0, limit).map((r) => this.mapToSearchResult(r));
    const cursor =
      hasMore && items.length > 0 ? items[items.length - 1].id : undefined;

    return { items, cursor, hasMore };
  }

  // ─── Update Online Status ────────────────────────────────────────────

  /**
   * Updates a user's online/offline presence status.
   *
   * Maps UserStatus enum → Prisma boolean:
   * - UserStatus.ONLINE → isOnline = true
   * - UserStatus.OFFLINE → isOnline = false, lastSeen set to now() if not provided
   *
   * When going offline without an explicit lastSeen timestamp, the current
   * server time is used as the last seen moment.
   *
   * @param id - The user ID.
   * @param status - The new presence status (ONLINE or OFFLINE).
   * @param lastSeen - Optional timestamp to record as last seen.
   */
  async updateOnlineStatus(
    id: string,
    status: UserStatus,
    lastSeen?: Date,
  ): Promise<void> {
    const isOnline = status === UserStatus.ONLINE;

    const updateData: { isOnline: boolean; lastSeen?: Date } = { isOnline };

    if (lastSeen !== undefined) {
      updateData.lastSeen = lastSeen;
    } else if (!isOnline) {
      // Set lastSeen to current time when going offline without explicit timestamp
      updateData.lastSeen = new Date();
    }

    await this.prisma.user.update({
      where: { id },
      data: updateData,
    });
  }

  // ─── Block User ──────────────────────────────────────────────────────

  /**
   * Creates a block record between two users.
   * Returns BlockedUserInfo containing the blocked user's profile details
   * and the timestamp of the block action.
   *
   * Uses Prisma's `include` to fetch the blocked user's displayName and
   * avatarUrl in a single query rather than a separate lookup.
   *
   * @param blockerId - The ID of the user performing the block.
   * @param blockedId - The ID of the user being blocked.
   * @returns BlockedUserInfo with blocked user details and block timestamp.
   */
  async blockUser(blockerId: string, blockedId: string): Promise<BlockedUserInfo> {
    const record = await this.prisma.blockedUser.create({
      data: {
        blockerId,
        blockedId,
      },
      include: {
        blocked: {
          select: { id: true, displayName: true, avatarUrl: true },
        },
      },
    });

    return {
      userId: record.blockedId,
      displayName: record.blocked.displayName,
      avatar: record.blocked.avatarUrl ?? undefined,
      blockedAt: record.createdAt.toISOString(),
    };
  }

  // ─── Unblock User ────────────────────────────────────────────────────

  /**
   * Removes a block record between two users.
   * Uses deleteMany to safely handle the case where no block record exists
   * (idempotent operation — no error thrown if already unblocked).
   *
   * @param blockerId - The ID of the user removing the block.
   * @param blockedId - The ID of the user being unblocked.
   */
  async unblockUser(blockerId: string, blockedId: string): Promise<void> {
    await this.prisma.blockedUser.deleteMany({
      where: {
        blockerId,
        blockedId,
      },
    });
  }

  // ─── Find Blocked Users ──────────────────────────────────────────────

  /**
   * Retrieves all users blocked by a given user, with profile info.
   * Ordered by most recently blocked first (createdAt descending).
   *
   * @param blockerId - The ID of the user whose block list to retrieve.
   * @returns Array of BlockedUserInfo records with display names and avatars.
   */
  async findBlockedUsers(blockerId: string): Promise<BlockedUserInfo[]> {
    const records = await this.prisma.blockedUser.findMany({
      where: { blockerId },
      include: {
        blocked: {
          select: { id: true, displayName: true, avatarUrl: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return records.map((r) => ({
      userId: r.blockedId,
      displayName: r.blocked.displayName,
      avatar: r.blocked.avatarUrl ?? undefined,
      blockedAt: r.createdAt.toISOString(),
    }));
  }

  // ─── Is Blocked ──────────────────────────────────────────────────────

  /**
   * Checks if one user has blocked another (directional check).
   * Returns true only if blockerId has an active block on blockedId.
   *
   * @param blockerId - The potential blocker's user ID.
   * @param blockedId - The potentially blocked user's ID.
   * @returns true if blockerId has blocked blockedId, false otherwise.
   */
  async isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
    const count = await this.prisma.blockedUser.count({
      where: { blockerId, blockedId },
    });
    return count > 0;
  }

  // ─── Exists by Email ─────────────────────────────────────────────────

  /**
   * Checks if a user with the given email address already exists.
   * Used during registration to detect duplicate emails before attempting
   * a create() call that would violate the unique index.
   *
   * @param email - The email address to check.
   * @returns true if a user with this email exists, false otherwise.
   */
  async existsByEmail(email: string): Promise<boolean> {
    const count = await this.prisma.user.count({
      where: { email },
    });
    return count > 0;
  }

  // ─── Find by IDs (Batch Lookup) ──────────────────────────────────────

  /**
   * Batch lookup of users by their IDs in a single query.
   * Returns UserResponse array (no passwordHash).
   *
   * Used for loading conversation participant profiles, resolving sender
   * information in message lists, and populating group member details.
   * Only found users are returned — missing IDs are silently omitted.
   *
   * @param ids - Array of user IDs to look up.
   * @returns Array of UserResponse records for found users.
   */
  async findByIds(ids: string[]): Promise<UserResponse[]> {
    if (ids.length === 0) return [];

    const records = await this.prisma.user.findMany({
      where: { id: { in: ids } },
    });

    return records.map((r) => this.mapToResponse(r));
  }

  // ─── Private Mappers ─────────────────────────────────────────────────

  /**
   * Maps a Prisma User record to the public UserResponse type.
   *
   * CRITICAL: UserResponse deliberately excludes passwordHash (R23).
   *
   * Field mapping:
   * - Prisma `avatarUrl` (string | null) → Shared `avatar` (string | undefined)
   * - Prisma `isOnline` (boolean) → Shared `status` (UserStatus.ONLINE | OFFLINE)
   * - Prisma DateTime fields → ISO 8601 strings
   * - Prisma null optionals → undefined
   */
  private mapToResponse(record: User): UserResponse {
    return {
      id: record.id,
      email: record.email,
      displayName: record.displayName,
      phoneNumber: record.phoneNumber ?? undefined,
      avatar: record.avatarUrl ?? undefined,
      about: record.about ?? undefined,
      status: record.isOnline ? UserStatus.ONLINE : UserStatus.OFFLINE,
      lastSeen: record.lastSeen ? record.lastSeen.toISOString() : undefined,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  /**
   * Maps a Prisma User record to a lightweight UserSearchResult.
   * Includes email and status but omits timestamps and phone number
   * for a compact search result payload.
   */
  private mapToSearchResult(record: User): UserSearchResult {
    return {
      id: record.id,
      displayName: record.displayName,
      email: record.email,
      avatar: record.avatarUrl ?? undefined,
      about: record.about ?? undefined,
      status: record.isOnline ? UserStatus.ONLINE : UserStatus.OFFLINE,
    };
  }
}
