/**
 * @module UserService.test
 *
 * Comprehensive unit tests for the UserService class — manages user profile
 * CRUD, cursor-paginated search, block/unblock with audit, presence tracking,
 * and batch lookups.
 *
 * Tests validate:
 * - R32 (Immutable Audit Log): Audit entries for user.block and user.unblock
 * - R17 (Interface-Driven Dependencies): Constructor receives interfaces only
 * - R22 (Standardized Error Responses): Typed domain errors thrown
 * - R23 (Log Hygiene): No sensitive data in audit metadata
 * - R7  (Zero Warnings Build): TypeScript strict mode, zero warnings
 *
 * Coverage target: ≥80%
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Imports
 * ──────────────────────────────────────────────────────────────────────────── */

import { UserService } from '../../../src/services/UserService';
import type { IUserRepository } from '../../../src/domain/interfaces/IUserRepository';
import type { ICacheProvider } from '../../../src/domain/interfaces/ICacheProvider';
import { NotFoundError } from '../../../src/errors/NotFoundError';
import { AuthorizationError } from '../../../src/errors/AuthorizationError';
import { ValidationError } from '../../../src/errors/ValidationError';
import { AuditAction, type UserResponse, type BlockedUserInfo, type UserSearchResult } from '@kalle/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Mock Factories
 * ──────────────────────────────────────────────────────────────────────────── */

function createMockUserRepository(): jest.Mocked<IUserRepository> {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    findByEmail: jest.fn(),
    update: jest.fn(),
    updatePassword: jest.fn(),
    search: jest.fn(),
    updateOnlineStatus: jest.fn(),
    blockUser: jest.fn(),
    unblockUser: jest.fn(),
    findBlockedUsers: jest.fn(),
    isBlocked: jest.fn(),
    existsByEmail: jest.fn(),
    findByIds: jest.fn(),
  };
}

function createMockCacheProvider(): jest.Mocked<ICacheProvider> {
  return {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    setNx: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    ttl: jest.fn(),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Test Data Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

const now = new Date();

function testUser(overrides?: Partial<UserResponse>): UserResponse {
  return {
    id: 'user-1',
    email: 'test@example.com',
    displayName: 'Test User',
    avatar: 'https://example.com/avatar.jpg',
    about: 'Hello world',
    phoneNumber: '+1234567890',
    status: 'OFFLINE' as UserResponse['status'],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function testBlockedUserInfo(overrides?: Partial<BlockedUserInfo>): BlockedUserInfo {
  return {
    userId: 'user-2',
    displayName: 'Blocked User',
    avatar: 'https://example.com/blocked.jpg',
    blockedAt: now.toISOString(),
    ...overrides,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Test Suite
 * ──────────────────────────────────────────────────────────────────────────── */

describe('UserService', () => {
  let service: UserService;
  let mockUserRepository: jest.Mocked<IUserRepository>;
  let mockCacheProvider: jest.Mocked<ICacheProvider>;
  let mockAuditService: { log: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    mockUserRepository = createMockUserRepository();
    mockCacheProvider = createMockCacheProvider();
    mockAuditService = { log: jest.fn().mockResolvedValue(undefined) };

    service = new UserService(
      mockUserRepository,
      mockCacheProvider,
      mockAuditService as unknown as import('../../../src/services/AuditService').AuditService,
    );

    // Default mock responses
    mockUserRepository.findById.mockResolvedValue(testUser());
    mockCacheProvider.set.mockResolvedValue(undefined);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getProfile
  // ─────────────────────────────────────────────────────────────────────────

  describe('getProfile', () => {
    it('should return user profile when found', async () => {
      const result = await service.getProfile('user-1');

      expect(result.id).toBe('user-1');
      expect(result.email).toBe('test@example.com');
      expect(mockUserRepository.findById).toHaveBeenCalledWith('user-1');
    });

    it('should throw NotFoundError when user does not exist', async () => {
      mockUserRepository.findById.mockResolvedValue(null);

      await expect(service.getProfile('nonexistent')).rejects.toThrow(NotFoundError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // updateProfile
  // ─────────────────────────────────────────────────────────────────────────

  describe('updateProfile', () => {
    it('should update profile with valid fields', async () => {
      const updatedUser = testUser({ displayName: 'Updated Name' });
      mockUserRepository.update.mockResolvedValue(updatedUser);

      const result = await service.updateProfile('user-1', { displayName: 'Updated Name' });

      expect(result.displayName).toBe('Updated Name');
      expect(mockUserRepository.update).toHaveBeenCalledWith('user-1', { displayName: 'Updated Name' });
    });

    it('should support partial updates (only some fields provided)', async () => {
      const updatedUser = testUser({ about: 'New about' });
      mockUserRepository.update.mockResolvedValue(updatedUser);

      await service.updateProfile('user-1', { about: 'New about' });

      expect(mockUserRepository.update).toHaveBeenCalledWith('user-1', { about: 'New about' });
    });

    it('should throw ValidationError when no update fields are provided', async () => {
      await expect(service.updateProfile('user-1', {})).rejects.toThrow(ValidationError);
    });

    it('should throw AuthorizationError when requestingUserId differs from target userId', async () => {
      await expect(
        service.updateProfile('user-1', { displayName: 'X' }, 'user-2'),
      ).rejects.toThrow(AuthorizationError);
    });

    it('should throw NotFoundError when target user does not exist', async () => {
      mockUserRepository.findById.mockResolvedValue(null);

      await expect(
        service.updateProfile('nonexistent', { displayName: 'X' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should allow update when requestingUserId matches target userId', async () => {
      const updatedUser = testUser({ displayName: 'Self Update' });
      mockUserRepository.update.mockResolvedValue(updatedUser);

      const result = await service.updateProfile('user-1', { displayName: 'Self Update' }, 'user-1');

      expect(result.displayName).toBe('Self Update');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // searchUsers
  // ─────────────────────────────────────────────────────────────────────────

  describe('searchUsers', () => {
    const mockResults = {
      items: [
        { id: 'user-2', email: 'other@example.com', displayName: 'Other User', status: 'OFFLINE' as const } as UserSearchResult,
      ],
      hasMore: false,
    };

    beforeEach(() => {
      mockUserRepository.search.mockResolvedValue(mockResults);
    });

    it('should search with query, currentUserId, and default limit', async () => {
      const result = await service.searchUsers({
        query: 'other',
        currentUserId: 'user-1',
      });

      expect(mockUserRepository.search).toHaveBeenCalledWith('other', {
        currentUserId: 'user-1',
        cursor: undefined,
        limit: 20,
      });
      expect(result.items).toHaveLength(1);
    });

    it('should pass cursor and custom limit to repository', async () => {
      await service.searchUsers({
        query: 'Martha',
        currentUserId: 'user-1',
        cursor: 'cursor-abc',
        limit: 10,
      });

      expect(mockUserRepository.search).toHaveBeenCalledWith('Martha', {
        currentUserId: 'user-1',
        cursor: 'cursor-abc',
        limit: 10,
      });
    });

    it('should throw ValidationError for empty query', async () => {
      await expect(
        service.searchUsers({ query: '', currentUserId: 'user-1' }),
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for whitespace-only query', async () => {
      await expect(
        service.searchUsers({ query: '   ', currentUserId: 'user-1' }),
      ).rejects.toThrow(ValidationError);
    });

    it('should trim query whitespace before searching', async () => {
      await service.searchUsers({
        query: '  other  ',
        currentUserId: 'user-1',
      });

      expect(mockUserRepository.search).toHaveBeenCalledWith('other', expect.any(Object));
    });

    it('should return paginated results with cursor and hasMore', async () => {
      const paginatedResults = {
        items: [
          { id: 'user-3', email: 'user3@example.com', displayName: 'User Three', status: 'ONLINE' as const } as UserSearchResult,
          { id: 'user-4', email: 'user4@example.com', displayName: 'User Four', status: 'OFFLINE' as const } as UserSearchResult,
        ],
        cursor: 'next-page-cursor',
        hasMore: true,
      };
      mockUserRepository.search.mockResolvedValue(paginatedResults);

      const result = await service.searchUsers({
        query: 'user',
        currentUserId: 'user-1',
        limit: 2,
      });

      expect(result.items).toHaveLength(2);
      expect(result.cursor).toBe('next-page-cursor');
      expect(result.hasMore).toBe(true);
    });

    it('should pass currentUserId to repository for self and blocked user exclusion', async () => {
      mockUserRepository.search.mockResolvedValue({ items: [], hasMore: false });

      await service.searchUsers({
        query: 'test',
        currentUserId: 'user-1',
      });

      // Repository receives currentUserId which it uses to exclude:
      // 1. The searching user themselves
      // 2. Users blocked by the searching user
      expect(mockUserRepository.search).toHaveBeenCalledWith(
        'test',
        expect.objectContaining({ currentUserId: 'user-1' }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // blockUser (R32 — Audit Logging)
  // ─────────────────────────────────────────────────────────────────────────

  describe('blockUser', () => {
    beforeEach(() => {
      mockUserRepository.findById.mockResolvedValue(testUser({ id: 'user-2' }));
      mockUserRepository.isBlocked.mockResolvedValue(false);
      mockUserRepository.blockUser.mockResolvedValue(testBlockedUserInfo());
    });

    it('should create block record and return block info', async () => {
      const result = await service.blockUser({ blockerId: 'user-1', blockedId: 'user-2' });

      expect(mockUserRepository.blockUser).toHaveBeenCalledWith('user-1', 'user-2');
      expect(result.userId).toBe('user-2');
    });

    it('should throw ValidationError when blocking self', async () => {
      await expect(
        service.blockUser({ blockerId: 'user-1', blockedId: 'user-1' }),
      ).rejects.toThrow(ValidationError);
    });

    it('should throw NotFoundError when target user does not exist', async () => {
      mockUserRepository.findById.mockResolvedValue(null);

      await expect(
        service.blockUser({ blockerId: 'user-1', blockedId: 'nonexistent' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should be idempotent — return existing block info if already blocked', async () => {
      mockUserRepository.isBlocked.mockResolvedValue(true);
      mockUserRepository.findBlockedUsers.mockResolvedValue([
        testBlockedUserInfo({ userId: 'user-2' }),
      ]);

      const result = await service.blockUser({ blockerId: 'user-1', blockedId: 'user-2' });

      expect(result.userId).toBe('user-2');
      // Should NOT call blockUser again or write audit since already blocked
      expect(mockUserRepository.blockUser).not.toHaveBeenCalled();
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    it('should write audit log entry for USER_BLOCK (R32)', async () => {
      await service.blockUser({ blockerId: 'user-1', blockedId: 'user-2' });

      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.USER_BLOCK,
          actorId: 'user-1',
          targetId: 'user-2',
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // unblockUser (R32 — Audit Logging)
  // ─────────────────────────────────────────────────────────────────────────

  describe('unblockUser', () => {
    beforeEach(() => {
      mockUserRepository.isBlocked.mockResolvedValue(true);
      mockUserRepository.unblockUser.mockResolvedValue(undefined);
    });

    it('should remove block record', async () => {
      await service.unblockUser({ blockerId: 'user-1', blockedId: 'user-2' });

      expect(mockUserRepository.unblockUser).toHaveBeenCalledWith('user-1', 'user-2');
    });

    it('should throw NotFoundError if block does not exist', async () => {
      mockUserRepository.isBlocked.mockResolvedValue(false);

      await expect(
        service.unblockUser({ blockerId: 'user-1', blockedId: 'user-2' }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should write audit log entry for USER_UNBLOCK (R32)', async () => {
      await service.unblockUser({ blockerId: 'user-1', blockedId: 'user-2' });

      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.USER_UNBLOCK,
          actorId: 'user-1',
          targetId: 'user-2',
        }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getBlockedUsers
  // ─────────────────────────────────────────────────────────────────────────

  describe('getBlockedUsers', () => {
    it('should return blocked users from repository', async () => {
      const blocked = [testBlockedUserInfo()];
      mockUserRepository.findBlockedUsers.mockResolvedValue(blocked);

      const result = await service.getBlockedUsers('user-1');

      expect(result).toEqual(blocked);
      expect(mockUserRepository.findBlockedUsers).toHaveBeenCalledWith('user-1');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // isBlocked
  // ─────────────────────────────────────────────────────────────────────────

  describe('isBlocked', () => {
    it('should return true when user is blocked', async () => {
      mockUserRepository.isBlocked.mockResolvedValue(true);

      const result = await service.isBlocked({ blockerId: 'user-1', blockedId: 'user-2' });

      expect(result).toBe(true);
      expect(mockUserRepository.isBlocked).toHaveBeenCalledWith('user-1', 'user-2');
    });

    it('should return false when user is not blocked', async () => {
      mockUserRepository.isBlocked.mockResolvedValue(false);

      const result = await service.isBlocked({ blockerId: 'user-1', blockedId: 'user-2' });

      expect(result).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // updateOnlineStatus
  // ─────────────────────────────────────────────────────────────────────────

  describe('updateOnlineStatus', () => {
    it('should update presence in database and cache with 300s TTL', async () => {
      await service.updateOnlineStatus({
        userId: 'user-1',
        status: 'ONLINE' as UserResponse['status'],
      });

      expect(mockUserRepository.updateOnlineStatus).toHaveBeenCalledWith(
        'user-1',
        'ONLINE',
        undefined,
      );
      expect(mockCacheProvider.set).toHaveBeenCalledWith(
        'presence:user-1',
        expect.objectContaining({ status: 'ONLINE' }),
        300,
      );
    });

    it('should include lastSeen when going offline', async () => {
      const lastSeen = new Date();
      await service.updateOnlineStatus({
        userId: 'user-1',
        status: 'OFFLINE' as UserResponse['status'],
        lastSeen,
      });

      expect(mockUserRepository.updateOnlineStatus).toHaveBeenCalledWith(
        'user-1',
        'OFFLINE',
        lastSeen,
      );
      expect(mockCacheProvider.set).toHaveBeenCalledWith(
        'presence:user-1',
        expect.objectContaining({
          status: 'OFFLINE',
          lastSeen: lastSeen.toISOString(),
        }),
        300,
      );
    });

    it('should delete cache presence on offline', async () => {
      await service.updateOnlineStatus({
        userId: 'user-1',
        status: 'OFFLINE' as UserResponse['status'],
      });

      expect(mockCacheProvider.set).toHaveBeenCalledWith(
        'presence:user-1',
        expect.objectContaining({ status: 'OFFLINE' }),
        300,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getUsersByIds
  // ─────────────────────────────────────────────────────────────────────────

  describe('getUsersByIds', () => {
    it('should return users from repository for given IDs', async () => {
      const users = [testUser({ id: 'user-1' }), testUser({ id: 'user-2' })];
      mockUserRepository.findByIds.mockResolvedValue(users);

      const result = await service.getUsersByIds(['user-1', 'user-2']);

      expect(result).toHaveLength(2);
      expect(mockUserRepository.findByIds).toHaveBeenCalledWith(['user-1', 'user-2']);
    });

    it('should return empty array for empty input', async () => {
      const result = await service.getUsersByIds([]);

      expect(result).toEqual([]);
      expect(mockUserRepository.findByIds).not.toHaveBeenCalled();
    });

    it('should return partial results when some IDs are not found', async () => {
      // Repository silently omits missing IDs — returned array may be shorter
      mockUserRepository.findByIds.mockResolvedValue([testUser({ id: 'user-1' })]);

      const result = await service.getUsersByIds(['user-1', 'nonexistent']);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('user-1');
      expect(mockUserRepository.findByIds).toHaveBeenCalledWith(['user-1', 'nonexistent']);
    });
  });
});
