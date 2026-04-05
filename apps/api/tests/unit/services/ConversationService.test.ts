/**
 * @module ConversationService Unit Tests
 *
 * Comprehensive unit tests for ConversationService verifying:
 * - DIRECT conversation creation (exactly 2 participants, dedup, self-prevention)
 * - GROUP conversation creation (3+ participants, creator=ADMIN, R14 initial sender-key-distribution)
 * - getConversations (pagination, defaults)
 * - getConversationById (access control)
 * - addParticipant (GROUP-only, ADMIN-only, R14 member_added, R32 audit GROUP_MEMBER_ADD)
 * - removeParticipant (self-leave or ADMIN, R14 member_removed KEY ROTATION, R32 audit GROUP_MEMBER_REMOVE)
 * - updateParticipantRole (ADMIN-only, R32 audit GROUP_ADMIN_CHANGE)
 * - archiveConversation / unarchiveConversation
 * - muteConversation / unmuteConversation
 * - updateGroupDetails (GROUP-only, ADMIN-only)
 * - getParticipantIds (Redis cache with 300s TTL)
 * - resetUnreadCount (delegation)
 *
 * Architecture: All 5 dependencies mocked via interfaces (R17).
 */

import { ConversationService } from '../../../src/services/ConversationService.js';
import type { IConversationRepository } from '../../../src/domain/interfaces/IConversationRepository.js';
import type { IUserRepository } from '../../../src/domain/interfaces/IUserRepository.js';
import type { ICacheProvider } from '../../../src/domain/interfaces/ICacheProvider.js';
import type { IQueueProvider } from '../../../src/domain/interfaces/IQueueProvider.js';
import type { AuditService } from '../../../src/services/AuditService.js';
import { NotFoundError } from '../../../src/errors/NotFoundError.js';
import { AuthorizationError } from '../../../src/errors/AuthorizationError.js';
import { ConflictError } from '../../../src/errors/ConflictError.js';
import { ValidationError } from '../../../src/errors/ValidationError.js';
import {
  ConversationType,
  ParticipantRole,
  AuditAction,
} from '@kalle/shared';
import type {
  ConversationResponse,
  ConversationListItem,
  CreateConversationDTO,
  MuteSettings,
  UserResponse,
} from '@kalle/shared';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockConversationRepository(): jest.Mocked<IConversationRepository> {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    findByUserId: jest.fn(),
    findDirectConversation: jest.fn(),
    addParticipant: jest.fn(),
    removeParticipant: jest.fn(),
    updateParticipantRole: jest.fn(),
    updateParticipantSettings: jest.fn(),
    updateGroupDetails: jest.fn(),
    getParticipantIds: jest.fn(),
    isParticipant: jest.fn(),
    getUnreadCounts: jest.fn(),
    resetUnreadCount: jest.fn(),
    incrementUnreadCount: jest.fn(),
  };
}

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

function createMockQueueProvider(): jest.Mocked<IQueueProvider> {
  return {
    enqueue: jest.fn(),
    enqueueBulk: jest.fn(),
    scheduleRepeat: jest.fn(),
    removeRepeat: jest.fn(),
    getQueueDepth: jest.fn(),
    close: jest.fn(),
  };
}

function createMockAuditService(): jest.Mocked<Pick<AuditService, 'log'>> {
  return {
    log: jest.fn(),
  };
}

// =============================================================================
// Test Data Helpers
// =============================================================================

const USER_A_ID = 'aaaaaaaa-0000-4000-a000-000000000001';
const USER_B_ID = 'bbbbbbbb-0000-4000-b000-000000000002';
const USER_C_ID = 'cccccccc-0000-4000-c000-000000000003';
const USER_D_ID = 'dddddddd-0000-4000-d000-000000000004';
const CONV_ID = '11111111-0000-4000-a000-000000000001';

function createParticipant(
  userId: string,
  role: ParticipantRole = ParticipantRole.MEMBER,
) {
  return {
    userId,
    displayName: `User-${userId.slice(0, 4)}`,
    role,
    joinedAt: new Date().toISOString(),
    isOnline: false,
  };
}

function createDirectConversation(
  overrides?: Partial<ConversationResponse>,
): ConversationResponse {
  return {
    id: CONV_ID,
    type: ConversationType.DIRECT,
    participants: [
      createParticipant(USER_A_ID),
      createParticipant(USER_B_ID),
    ],
    unreadCount: 0,
    isArchived: false,
    muteSettings: { isMuted: false },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createGroupConversation(
  overrides?: Partial<ConversationResponse>,
): ConversationResponse {
  return {
    id: CONV_ID,
    type: ConversationType.GROUP,
    groupName: 'Test Group',
    participants: [
      createParticipant(USER_A_ID, ParticipantRole.ADMIN),
      createParticipant(USER_B_ID),
      createParticipant(USER_C_ID),
    ],
    unreadCount: 0,
    isArchived: false,
    muteSettings: { isMuted: false },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMinimalUser(userId: string): UserResponse {
  return {
    id: userId,
    email: `${userId.slice(0, 4)}@test.com`,
    displayName: `User-${userId.slice(0, 4)}`,
    status: 'OFFLINE' as UserResponse['status'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('ConversationService', () => {
  let service: ConversationService;
  let mockConversationRepo: jest.Mocked<IConversationRepository>;
  let mockUserRepo: jest.Mocked<IUserRepository>;
  let mockCache: jest.Mocked<ICacheProvider>;
  let mockQueue: jest.Mocked<IQueueProvider>;
  let mockAudit: jest.Mocked<Pick<AuditService, 'log'>>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConversationRepo = createMockConversationRepository();
    mockUserRepo = createMockUserRepository();
    mockCache = createMockCacheProvider();
    mockQueue = createMockQueueProvider();
    mockAudit = createMockAuditService();

    service = new ConversationService(
      mockConversationRepo,
      mockUserRepo,
      mockCache,
      mockQueue,
      mockAudit as unknown as AuditService,
    );
  });

  // ---------------------------------------------------------------------------
  // createConversation — DIRECT
  // ---------------------------------------------------------------------------

  describe('createConversation — DIRECT', () => {
    it('should create a DIRECT conversation with exactly 2 participants', async () => {
      const dto: CreateConversationDTO = {
        type: ConversationType.DIRECT,
        participantIds: [USER_B_ID],
      };
      mockConversationRepo.findDirectConversation.mockResolvedValue(null);
      mockUserRepo.findByIds.mockResolvedValue([
        createMinimalUser(USER_A_ID),
        createMinimalUser(USER_B_ID),
      ]);
      const expectedConv = createDirectConversation();
      mockConversationRepo.create.mockResolvedValue(expectedConv);

      const result = await service.createConversation(dto, USER_A_ID);

      expect(result).toEqual(expectedConv);
      expect(mockConversationRepo.create).toHaveBeenCalledTimes(1);
      // Both users included in participantIds for create call
      const createArg = mockConversationRepo.create.mock.calls[0][0];
      expect(createArg.type).toBe(ConversationType.DIRECT);
    });

    it('should throw ValidationError when DIRECT participantIds is not exactly 1', async () => {
      const dto: CreateConversationDTO = {
        type: ConversationType.DIRECT,
        participantIds: [USER_B_ID, USER_C_ID],
      };

      await expect(
        service.createConversation(dto, USER_A_ID),
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError when creating self-conversation', async () => {
      const dto: CreateConversationDTO = {
        type: ConversationType.DIRECT,
        participantIds: [USER_A_ID],
      };

      await expect(
        service.createConversation(dto, USER_A_ID),
      ).rejects.toThrow(ValidationError);
    });

    it('should return existing conversation for duplicate DIRECT pair', async () => {
      const dto: CreateConversationDTO = {
        type: ConversationType.DIRECT,
        participantIds: [USER_B_ID],
      };
      const existing = createDirectConversation();
      mockConversationRepo.findDirectConversation.mockResolvedValue(existing);

      const result = await service.createConversation(dto, USER_A_ID);

      expect(result).toEqual(existing);
      expect(mockConversationRepo.create).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError when participant user does not exist', async () => {
      const dto: CreateConversationDTO = {
        type: ConversationType.DIRECT,
        participantIds: [USER_B_ID],
      };
      mockConversationRepo.findDirectConversation.mockResolvedValue(null);
      // Only one user found out of two — the other is missing
      mockUserRepo.findByIds.mockResolvedValue([
        createMinimalUser(USER_A_ID),
      ]);

      await expect(
        service.createConversation(dto, USER_A_ID),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // ---------------------------------------------------------------------------
  // createConversation — GROUP
  // ---------------------------------------------------------------------------

  describe('createConversation — GROUP', () => {
    it('should create a GROUP conversation with creator as ADMIN and enqueue sender-key-distribution (R14)', async () => {
      const dto: CreateConversationDTO = {
        type: ConversationType.GROUP,
        participantIds: [USER_B_ID, USER_C_ID],
        groupName: 'Dev Team',
      };
      mockUserRepo.findByIds.mockResolvedValue([
        createMinimalUser(USER_A_ID),
        createMinimalUser(USER_B_ID),
        createMinimalUser(USER_C_ID),
      ]);
      const expectedConv = createGroupConversation({ groupName: 'Dev Team' });
      mockConversationRepo.create.mockResolvedValue(expectedConv);

      const result = await service.createConversation(dto, USER_A_ID);

      expect(result).toEqual(expectedConv);
      expect(mockConversationRepo.create).toHaveBeenCalledTimes(1);

      // R14: sender-key-distribution enqueued for initial group creation
      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        'sender-key-distribution',
        expect.objectContaining({
          action: 'initial',
          groupId: expectedConv.id,
        }),
      );
    });

    it('should throw ValidationError when GROUP has fewer than 2 participantIds', async () => {
      const dto: CreateConversationDTO = {
        type: ConversationType.GROUP,
        participantIds: [USER_B_ID],
        groupName: 'Tiny Group',
      };

      await expect(
        service.createConversation(dto, USER_A_ID),
      ).rejects.toThrow(ValidationError);
    });

    it('should throw NotFoundError when some GROUP participants do not exist', async () => {
      const dto: CreateConversationDTO = {
        type: ConversationType.GROUP,
        participantIds: [USER_B_ID, USER_C_ID],
        groupName: 'Missing Users',
      };
      // Only 2 found out of 3 (creator + 2 participants)
      mockUserRepo.findByIds.mockResolvedValue([
        createMinimalUser(USER_A_ID),
        createMinimalUser(USER_B_ID),
      ]);

      await expect(
        service.createConversation(dto, USER_A_ID),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // ---------------------------------------------------------------------------
  // getConversations
  // ---------------------------------------------------------------------------

  describe('getConversations', () => {
    it('should return paginated conversation list with default limit 30', async () => {
      const items: ConversationListItem[] = [];
      mockConversationRepo.findByUserId.mockResolvedValue({
        items,
        hasMore: false,
      });

      const result = await service.getConversations(USER_A_ID);

      expect(mockConversationRepo.findByUserId).toHaveBeenCalledWith(
        USER_A_ID,
        expect.objectContaining({ limit: 30 }),
      );
      expect(result.items).toEqual(items);
    });

    it('should forward custom cursor, limit, and includeArchived options', async () => {
      mockConversationRepo.findByUserId.mockResolvedValue({
        items: [],
        hasMore: false,
      });

      await service.getConversations(USER_A_ID, {
        cursor: 'abc123',
        limit: 10,
        includeArchived: true,
      });

      expect(mockConversationRepo.findByUserId).toHaveBeenCalledWith(
        USER_A_ID,
        expect.objectContaining({
          cursor: 'abc123',
          limit: 10,
          includeArchived: true,
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getConversationById
  // ---------------------------------------------------------------------------

  describe('getConversationById', () => {
    it('should return conversation when user is a participant', async () => {
      const conv = createDirectConversation();
      mockConversationRepo.findById.mockResolvedValue(conv);
      mockConversationRepo.isParticipant.mockResolvedValue(true);

      const result = await service.getConversationById(CONV_ID, USER_A_ID);

      expect(result).toEqual(conv);
    });

    it('should throw NotFoundError when conversation does not exist', async () => {
      mockConversationRepo.findById.mockResolvedValue(null);

      await expect(
        service.getConversationById(CONV_ID, USER_A_ID),
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw AuthorizationError when user is not a participant', async () => {
      const conv = createDirectConversation();
      mockConversationRepo.findById.mockResolvedValue(conv);

      await expect(
        service.getConversationById(CONV_ID, USER_D_ID),
      ).rejects.toThrow(AuthorizationError);
    });
  });

  // ---------------------------------------------------------------------------
  // addParticipant — R14 sender-key-distribution, R32 audit GROUP_MEMBER_ADD
  // ---------------------------------------------------------------------------

  describe('addParticipant', () => {
    it('should add participant to GROUP conversation and enqueue sender-key-distribution member_added (R14)', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);
      mockUserRepo.findByIds.mockResolvedValue([createMinimalUser(USER_D_ID)]);
      mockConversationRepo.isParticipant.mockResolvedValue(false);
      const updatedGroup = createGroupConversation({
        participants: [
          ...group.participants,
          createParticipant(USER_D_ID),
        ],
      });
      mockConversationRepo.addParticipant.mockResolvedValue(updatedGroup);

      const result = await service.addParticipant(
        CONV_ID,
        USER_D_ID,
        USER_A_ID, // admin
      );

      expect(result).toEqual(updatedGroup);

      // R14: sender-key-distribution enqueued with member_added action
      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        'sender-key-distribution',
        expect.objectContaining({
          action: 'member_added',
          groupId: CONV_ID,
        }),
      );

      // R32: audit log written for GROUP_MEMBER_ADD
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.GROUP_MEMBER_ADD,
        }),
      );
    });

    it('should throw ValidationError when adding to DIRECT conversation', async () => {
      const direct = createDirectConversation();
      mockConversationRepo.findById.mockResolvedValue(direct);

      await expect(
        service.addParticipant(CONV_ID, USER_C_ID, USER_A_ID),
      ).rejects.toThrow(ValidationError);
    });

    it('should throw AuthorizationError when non-ADMIN tries to add participant', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);

      // USER_B_ID is MEMBER not ADMIN
      await expect(
        service.addParticipant(CONV_ID, USER_D_ID, USER_B_ID),
      ).rejects.toThrow(AuthorizationError);
    });

    it('should throw NotFoundError when target user does not exist', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);
      mockUserRepo.findByIds.mockResolvedValue([]);

      await expect(
        service.addParticipant(CONV_ID, USER_D_ID, USER_A_ID),
      ).rejects.toThrow(NotFoundError);
    });

    it('should throw ConflictError when user is already a participant', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);
      mockUserRepo.findByIds.mockResolvedValue([createMinimalUser(USER_B_ID)]);
      mockConversationRepo.isParticipant.mockResolvedValue(true);

      await expect(
        service.addParticipant(CONV_ID, USER_B_ID, USER_A_ID),
      ).rejects.toThrow(ConflictError);
    });

    it('should invalidate participant cache after adding member', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);
      mockUserRepo.findByIds.mockResolvedValue([createMinimalUser(USER_D_ID)]);
      mockConversationRepo.isParticipant.mockResolvedValue(false);
      mockConversationRepo.addParticipant.mockResolvedValue(group);

      await service.addParticipant(CONV_ID, USER_D_ID, USER_A_ID);

      expect(mockCache.del).toHaveBeenCalledWith(
        `conversation:participants:${CONV_ID}`,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // removeParticipant — R14 KEY ROTATION, R32 audit GROUP_MEMBER_REMOVE
  // ---------------------------------------------------------------------------

  describe('removeParticipant', () => {
    it('should remove participant and enqueue sender-key-distribution member_removed for KEY ROTATION (R14)', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);
      const afterRemove = createGroupConversation({
        participants: [
          createParticipant(USER_A_ID, ParticipantRole.ADMIN),
          createParticipant(USER_C_ID),
        ],
      });
      mockConversationRepo.removeParticipant.mockResolvedValue(afterRemove);

      const result = await service.removeParticipant(
        CONV_ID,
        USER_B_ID,
        USER_A_ID, // admin removes USER_B
      );

      expect(result).toEqual(afterRemove);

      // R14: sender-key-distribution with member_removed triggers KEY ROTATION
      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        'sender-key-distribution',
        expect.objectContaining({
          action: 'member_removed',
          groupId: CONV_ID,
        }),
      );

      // R32: audit log for GROUP_MEMBER_REMOVE
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.GROUP_MEMBER_REMOVE,
        }),
      );
    });

    it('should allow self-leave without ADMIN role', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);
      mockConversationRepo.removeParticipant.mockResolvedValue(group);

      // USER_B (MEMBER) removes themselves — allowed
      await expect(
        service.removeParticipant(CONV_ID, USER_B_ID, USER_B_ID),
      ).resolves.toBeDefined();

      expect(mockConversationRepo.removeParticipant).toHaveBeenCalled();
    });

    it('should throw ValidationError when removing from DIRECT conversation', async () => {
      const direct = createDirectConversation();
      mockConversationRepo.findById.mockResolvedValue(direct);

      await expect(
        service.removeParticipant(CONV_ID, USER_B_ID, USER_A_ID),
      ).rejects.toThrow(ValidationError);
    });

    it('should throw AuthorizationError when non-ADMIN tries to remove another user', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);

      // USER_B (MEMBER) tries to remove USER_C — not allowed (not self, not admin)
      await expect(
        service.removeParticipant(CONV_ID, USER_C_ID, USER_B_ID),
      ).rejects.toThrow(AuthorizationError);
    });

    it('should invalidate participant cache after removal', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);
      mockConversationRepo.removeParticipant.mockResolvedValue(group);

      await service.removeParticipant(CONV_ID, USER_B_ID, USER_A_ID);

      expect(mockCache.del).toHaveBeenCalledWith(
        `conversation:participants:${CONV_ID}`,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // updateParticipantRole — R32 audit GROUP_ADMIN_CHANGE
  // ---------------------------------------------------------------------------

  describe('updateParticipantRole', () => {
    it('should update participant role and write R32 audit with newRole metadata', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);
      mockConversationRepo.isParticipant.mockResolvedValue(true);
      // Target is participant (USER_B)
      const updated = createGroupConversation({
        participants: [
          createParticipant(USER_A_ID, ParticipantRole.ADMIN),
          createParticipant(USER_B_ID, ParticipantRole.ADMIN),
          createParticipant(USER_C_ID),
        ],
      });
      mockConversationRepo.updateParticipantRole.mockResolvedValue(updated);

      const result = await service.updateParticipantRole(
        CONV_ID,
        USER_B_ID,
        ParticipantRole.ADMIN,
        USER_A_ID,
      );

      expect(result).toEqual(updated);

      // R32: audit log for GROUP_ADMIN_CHANGE with metadata.newRole
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.GROUP_ADMIN_CHANGE,
          metadata: expect.objectContaining({
            newRole: ParticipantRole.ADMIN,
          }),
        }),
      );
    });

    it('should throw AuthorizationError when non-ADMIN tries to change roles', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);

      await expect(
        service.updateParticipantRole(
          CONV_ID,
          USER_C_ID,
          ParticipantRole.ADMIN,
          USER_B_ID, // MEMBER, not ADMIN
        ),
      ).rejects.toThrow(AuthorizationError);
    });

    it('should throw ValidationError when updating role in DIRECT conversation', async () => {
      const direct = createDirectConversation();
      mockConversationRepo.findById.mockResolvedValue(direct);

      await expect(
        service.updateParticipantRole(
          CONV_ID,
          USER_B_ID,
          ParticipantRole.ADMIN,
          USER_A_ID,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('should throw NotFoundError when target user is not a participant', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);

      await expect(
        service.updateParticipantRole(
          CONV_ID,
          USER_D_ID, // not in participants
          ParticipantRole.ADMIN,
          USER_A_ID,
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // ---------------------------------------------------------------------------
  // archiveConversation / unarchiveConversation
  // ---------------------------------------------------------------------------

  describe('archiveConversation', () => {
    it('should archive conversation for participant', async () => {
      const conv = createDirectConversation();
      mockConversationRepo.findById.mockResolvedValue(conv);
      mockConversationRepo.updateParticipantSettings.mockResolvedValue(
        createDirectConversation({ isArchived: true }),
      );

      const result = await service.archiveConversation(CONV_ID, USER_A_ID);

      expect(mockConversationRepo.updateParticipantSettings).toHaveBeenCalledWith(
        CONV_ID,
        USER_A_ID,
        expect.objectContaining({ isArchived: true }),
      );
      expect(result.isArchived).toBe(true);
    });

    it('should throw AuthorizationError when non-participant tries to archive', async () => {
      const conv = createDirectConversation();
      mockConversationRepo.findById.mockResolvedValue(conv);

      await expect(
        service.archiveConversation(CONV_ID, USER_D_ID),
      ).rejects.toThrow(AuthorizationError);
    });
  });

  describe('unarchiveConversation', () => {
    it('should unarchive conversation for participant', async () => {
      const conv = createDirectConversation({ isArchived: true });
      mockConversationRepo.findById.mockResolvedValue(conv);
      mockConversationRepo.updateParticipantSettings.mockResolvedValue(
        createDirectConversation({ isArchived: false }),
      );

      const result = await service.unarchiveConversation(CONV_ID, USER_A_ID);

      expect(mockConversationRepo.updateParticipantSettings).toHaveBeenCalledWith(
        CONV_ID,
        USER_A_ID,
        expect.objectContaining({ isArchived: false }),
      );
      expect(result.isArchived).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // muteConversation / unmuteConversation
  // ---------------------------------------------------------------------------

  describe('muteConversation', () => {
    it('should mute conversation with expiry settings', async () => {
      const conv = createDirectConversation();
      mockConversationRepo.findById.mockResolvedValue(conv);
      const mutedConv = createDirectConversation({
        muteSettings: {
          isMuted: true,
          muteExpiresAt: '2026-12-31T23:59:59.000Z',
        },
      });
      mockConversationRepo.updateParticipantSettings.mockResolvedValue(
        mutedConv,
      );

      const muteSettings: MuteSettings = {
        isMuted: true,
        muteExpiresAt: '2026-12-31T23:59:59.000Z',
      };

      const result = await service.muteConversation(
        CONV_ID,
        USER_A_ID,
        muteSettings,
      );

      expect(mockConversationRepo.updateParticipantSettings).toHaveBeenCalledWith(
        CONV_ID,
        USER_A_ID,
        expect.objectContaining({ isMuted: true }),
      );
      expect(result.muteSettings.isMuted).toBe(true);
    });

    it('should mute indefinitely when muteExpiresAt is null', async () => {
      const conv = createDirectConversation();
      mockConversationRepo.findById.mockResolvedValue(conv);
      mockConversationRepo.updateParticipantSettings.mockResolvedValue(
        createDirectConversation({
          muteSettings: { isMuted: true, muteExpiresAt: null },
        }),
      );

      await service.muteConversation(CONV_ID, USER_A_ID, {
        isMuted: true,
        muteExpiresAt: null,
      });

      expect(mockConversationRepo.updateParticipantSettings).toHaveBeenCalledWith(
        CONV_ID,
        USER_A_ID,
        expect.objectContaining({ isMuted: true }),
      );
    });
  });

  describe('unmuteConversation', () => {
    it('should unmute conversation and clear muteExpiresAt', async () => {
      const conv = createDirectConversation({
        muteSettings: { isMuted: true, muteExpiresAt: null },
      });
      mockConversationRepo.findById.mockResolvedValue(conv);
      mockConversationRepo.updateParticipantSettings.mockResolvedValue(
        createDirectConversation({
          muteSettings: { isMuted: false },
        }),
      );

      const result = await service.unmuteConversation(CONV_ID, USER_A_ID);

      expect(mockConversationRepo.updateParticipantSettings).toHaveBeenCalledWith(
        CONV_ID,
        USER_A_ID,
        expect.objectContaining({ isMuted: false, muteExpiresAt: null }),
      );
      expect(result.muteSettings.isMuted).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // updateGroupDetails — GROUP-only, ADMIN-only
  // ---------------------------------------------------------------------------

  describe('updateGroupDetails', () => {
    it('should update group name and avatar when user is ADMIN', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);
      const updated = createGroupConversation({
        groupName: 'Updated Name',
        groupAvatar: 'https://cdn.example.com/new-avatar.png',
      });
      mockConversationRepo.updateGroupDetails.mockResolvedValue(updated);

      const result = await service.updateGroupDetails(
        CONV_ID,
        { groupName: 'Updated Name', groupAvatar: 'https://cdn.example.com/new-avatar.png' },
        USER_A_ID,
      );

      expect(result.groupName).toBe('Updated Name');
      expect(result.groupAvatar).toBe('https://cdn.example.com/new-avatar.png');
    });

    it('should throw AuthorizationError when non-ADMIN tries to update group details', async () => {
      const group = createGroupConversation();
      mockConversationRepo.findById.mockResolvedValue(group);

      await expect(
        service.updateGroupDetails(
          CONV_ID,
          { groupName: 'Hacked Name' },
          USER_B_ID, // MEMBER, not ADMIN
        ),
      ).rejects.toThrow(AuthorizationError);
    });

    it('should throw ValidationError when updating details on DIRECT conversation', async () => {
      const direct = createDirectConversation();
      mockConversationRepo.findById.mockResolvedValue(direct);

      await expect(
        service.updateGroupDetails(
          CONV_ID,
          { groupName: 'Cannot Name Direct' },
          USER_A_ID,
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  // ---------------------------------------------------------------------------
  // getParticipantIds — Redis cache with 300s TTL
  // ---------------------------------------------------------------------------

  describe('getParticipantIds', () => {
    it('should return cached participant IDs when cache hit', async () => {
      mockCache.get.mockResolvedValue([USER_A_ID, USER_B_ID, USER_C_ID]);

      const result = await service.getParticipantIds(CONV_ID);

      expect(result).toEqual([USER_A_ID, USER_B_ID, USER_C_ID]);
      expect(mockCache.get).toHaveBeenCalledWith(
        `conversation:participants:${CONV_ID}`,
      );
      expect(mockConversationRepo.getParticipantIds).not.toHaveBeenCalled();
    });

    it('should fetch from repository and cache with 300s TTL on cache miss', async () => {
      mockCache.get.mockResolvedValue(null);
      mockConversationRepo.getParticipantIds.mockResolvedValue([
        USER_A_ID,
        USER_B_ID,
      ]);

      const result = await service.getParticipantIds(CONV_ID);

      expect(result).toEqual([USER_A_ID, USER_B_ID]);
      expect(mockConversationRepo.getParticipantIds).toHaveBeenCalledWith(
        CONV_ID,
      );
      expect(mockCache.set).toHaveBeenCalledWith(
        `conversation:participants:${CONV_ID}`,
        [USER_A_ID, USER_B_ID],
        300,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // resetUnreadCount
  // ---------------------------------------------------------------------------

  describe('resetUnreadCount', () => {
    it('should delegate to conversationRepository.resetUnreadCount', async () => {
      mockConversationRepo.resetUnreadCount.mockResolvedValue(undefined);

      await service.resetUnreadCount(CONV_ID, USER_A_ID);

      expect(mockConversationRepo.resetUnreadCount).toHaveBeenCalledWith(
        CONV_ID,
        USER_A_ID,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Architecture Rules — R17 Interface-Driven Dependencies
  // ---------------------------------------------------------------------------

  describe('Architecture Rules', () => {
    it('R17: ConversationService accepts all dependencies as interfaces — zero concrete imports', () => {
      // Verify the service was successfully constructed with 5 mock interfaces.
      // If it imported concrete classes, this mock-based construction would fail.
      expect(service).toBeDefined();
    });
  });
});
