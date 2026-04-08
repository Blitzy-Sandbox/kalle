/**
 * @module ConversationService
 *
 * Conversation Service — manages conversation lifecycle: creation (DIRECT 1:1
 * and GROUP), participant membership (add/remove with Sender Key rotation
 * triggers), per-user settings (archive/mute), group metadata updates, and
 * paginated conversation listing.
 *
 * Orchestrates between IConversationRepository, IUserRepository, ICacheProvider,
 * IQueueProvider, and AuditService to deliver all conversation business logic
 * while preserving clean architectural boundaries.
 *
 * Architecture Rules Enforced:
 * - R17 (Interface-Driven Dependencies): All dependencies received via constructor
 *   injection as interfaces — never imports a concrete repository or provider class.
 * - R16 (OOD Layering): ALL conversation business logic lives here. Controllers
 *   are thin delegation layers that parse requests, validate via Zod, and delegate.
 * - R14 (Group Encryption via Sender Keys): Enqueues `sender-key-distribution`
 *   jobs on group creation (initial), member addition (redistribute), and member
 *   removal (KEY ROTATION — removed member cannot decrypt future messages).
 * - R18 (Fan-Out via Queue): Provides participant counts used by MessageService's
 *   fan-out decision when participant count >= 3.
 * - R32 (Immutable Audit Log): Writes audit entries for group.member_add,
 *   group.member_remove, and group.admin_change security-sensitive actions.
 * - R22 (Standardized Error Responses): Throws typed DomainError subclasses that
 *   the global error handler maps to HTTP status codes.
 * - R28 (Structured Logging Only): Zero console.log calls.
 * - R7  (Zero Warnings Build): TypeScript strict mode, zero warnings.
 *
 * Composition Root Wiring (server.ts):
 *   const conversationService = new ConversationService(
 *     conversationRepository, userRepository, cacheProvider, queueProvider, auditService
 *   );
 */

import type {
  IConversationRepository,
  CreateConversationData,
  AddParticipantData,
  ParticipantSettings,
} from '../domain/interfaces/IConversationRepository.js';
import type { IUserRepository } from '../domain/interfaces/IUserRepository.js';
import type { ICacheProvider } from '../domain/interfaces/ICacheProvider.js';
import type { IQueueProvider } from '../domain/interfaces/IQueueProvider.js';
import type { AuditService } from './AuditService.js';

import { NotFoundError } from '../errors/NotFoundError.js';
import { AuthorizationError } from '../errors/AuthorizationError.js';
import { ConflictError } from '../errors/ConflictError.js';
import { ValidationError } from '../errors/ValidationError.js';

import type {
  ConversationResponse,
  ConversationListItem,
  CreateConversationDTO,
  UpdateConversationDTO,
  MuteSettings,
} from '@kalle/shared';
import { ConversationType, ParticipantRole, AuditAction } from '@kalle/shared';

// =============================================================================
// Constants
// =============================================================================

/** Default page size for conversation list pagination. */
const DEFAULT_CONVERSATIONS_LIMIT = 30;

/** TTL in seconds for cached participant ID lists in Redis (5 minutes). */
const PARTICIPANTS_CACHE_TTL_SECONDS = 300;

/** Cache key prefix for participant ID lists, keyed by conversationId. */
const CACHE_PREFIX_PARTICIPANTS = 'conversation:participants:';

// =============================================================================
// ConversationService Class
// =============================================================================

/**
 * Manages conversation lifecycle operations including creation of DIRECT (1:1)
 * and GROUP conversations, participant membership management with automatic
 * Sender Key distribution/rotation triggers, per-user settings (archive, mute),
 * group metadata updates, and paginated conversation listing.
 *
 * All dependencies are injected via the constructor as interfaces (R17).
 * No concrete repository or provider class is ever imported.
 */
export class ConversationService {
  constructor(
    private readonly conversationRepository: IConversationRepository,
    private readonly userRepository: IUserRepository,
    private readonly cacheProvider: ICacheProvider,
    private readonly queueProvider: IQueueProvider,
    private readonly auditService: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // createConversation
  // ---------------------------------------------------------------------------

  /**
   * Creates a new DIRECT (1:1) or GROUP conversation.
   *
   * For DIRECT conversations:
   * - `participantIds` must contain exactly 1 other user (currentUser is added
   *   automatically, totalling 2 participants).
   * - Duplicate DIRECT conversations are prevented: if one already exists between
   *   the same two users, the existing conversation is returned.
   * - Both participants receive the MEMBER role.
   *
   * For GROUP conversations:
   * - `participantIds` must contain at least 2 other users (currentUser is added
   *   automatically, totalling 3+ participants).
   * - The `currentUserId` receives the ADMIN role; all others receive MEMBER.
   * - An initial `sender-key-distribution` job is enqueued (R14) so all members
   *   establish Sender Key sessions for group encryption.
   *
   * @param dto - Conversation creation payload from the controller
   * @param currentUserId - Authenticated user creating the conversation
   * @returns Created (or existing DIRECT) ConversationResponse
   * @throws {ValidationError} Invalid participant count or self-conversation
   * @throws {NotFoundError} One or more participant user IDs not found
   */
  async createConversation(
    dto: CreateConversationDTO,
    currentUserId: string,
  ): Promise<ConversationResponse> {
    const { type, participantIds, groupName, groupAvatar } = dto;

    // Validate participant count based on conversation type
    if (type === ConversationType.DIRECT) {
      if (participantIds.length !== 1) {
        throw new ValidationError(
          'DIRECT conversations require exactly 1 other participant',
          {
            field: 'participantIds',
            expected: 1,
            received: participantIds.length,
          },
        );
      }
    } else if (type === ConversationType.GROUP) {
      if (participantIds.length < 2) {
        throw new ValidationError(
          'GROUP conversations require at least 2 other participants',
          {
            field: 'participantIds',
            minimum: 2,
            received: participantIds.length,
          },
        );
      }
    }

    // Deduplicate and combine current user with provided participants
    const allParticipantIds = [currentUserId, ...participantIds];
    const uniqueIds = [...new Set(allParticipantIds)];

    // Prevent self-conversation for DIRECT type
    if (type === ConversationType.DIRECT && uniqueIds.length < 2) {
      throw new ValidationError(
        'Cannot create a DIRECT conversation with yourself',
        { field: 'participantIds' },
      );
    }

    // For DIRECT: check if conversation already exists (duplicate prevention)
    if (type === ConversationType.DIRECT) {
      const otherUserId = participantIds[0];
      const existing = await this.conversationRepository.findDirectConversation(
        currentUserId,
        otherUserId,
      );
      if (existing) {
        return existing;
      }
    }

    // Verify all participant users exist in the system
    const users = await this.userRepository.findByIds(uniqueIds);
    if (users.length !== uniqueIds.length) {
      const foundIds = new Set(users.map((u) => u.id));
      const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
      throw new NotFoundError('One or more users not found', {
        resource: 'User',
        missingIds,
      });
    }

    // Build a user lookup map for constructing participant data
    const userMap = new Map(users.map((u) => [u.id, u]));

    // Construct CreateConversationData for the repository
    const createData: CreateConversationData = {
      type,
      groupName: type === ConversationType.GROUP ? groupName : undefined,
      groupAvatar: type === ConversationType.GROUP ? groupAvatar : undefined,
      participants: uniqueIds.map((userId) => {
        const user = userMap.get(userId)!;
        return {
          userId,
          displayName: user.displayName,
          avatar: user.avatar,
          // Creator gets ADMIN role in groups; all get MEMBER in direct chats
          role:
            type === ConversationType.GROUP && userId === currentUserId
              ? ParticipantRole.ADMIN
              : ParticipantRole.MEMBER,
        };
      }),
    };

    const conversation = await this.conversationRepository.create(createData);

    // For GROUP: enqueue initial Sender Key distribution (R14)
    // All members need to establish Sender Key sessions for group encryption
    if (type === ConversationType.GROUP) {
      await this.queueProvider.enqueue('sender-key-distribution', {
        groupId: conversation.id,
        participantIds: uniqueIds,
        action: 'initial',
      });
    }

    return conversation;
  }

  // ---------------------------------------------------------------------------
  // getConversations
  // ---------------------------------------------------------------------------

  /**
   * Retrieves a paginated list of conversations for a user.
   *
   * Returns lightweight ConversationListItem entries suitable for rendering
   * the chat list UI (Figma Screen 1). Supports cursor-based pagination
   * and optional inclusion of archived conversations.
   *
   * @param userId - User requesting their conversation list
   * @param options - Pagination and filter options
   * @returns Paginated conversation list with cursor for next page
   */
  async getConversations(
    userId: string,
    options?: {
      cursor?: string;
      limit?: number;
      includeArchived?: boolean;
    },
  ): Promise<{ items: ConversationListItem[]; cursor?: string; hasMore: boolean }> {
    return this.conversationRepository.findByUserId(userId, {
      cursor: options?.cursor,
      limit: options?.limit ?? DEFAULT_CONVERSATIONS_LIMIT,
      includeArchived: options?.includeArchived,
    });
  }

  // ---------------------------------------------------------------------------
  // getConversationById
  // ---------------------------------------------------------------------------

  /**
   * Retrieves a single conversation by ID with full participant and message data.
   *
   * Enforces authorization: only participants of the conversation may access it.
   *
   * @param conversationId - Conversation to retrieve
   * @param userId - Authenticated user requesting the conversation
   * @returns Full ConversationResponse
   * @throws {NotFoundError} Conversation does not exist
   * @throws {AuthorizationError} User is not a participant
   */
  async getConversationById(
    conversationId: string,
    userId: string,
  ): Promise<ConversationResponse> {
    const conversation = await this.findConversationOrThrow(conversationId);

    const isParticipant = await this.conversationRepository.isParticipant(
      conversationId,
      userId,
    );
    if (!isParticipant) {
      throw new AuthorizationError('Not a participant in this conversation');
    }

    return conversation;
  }

  // ---------------------------------------------------------------------------
  // addParticipant (R14: triggers Sender Key distribution)
  // ---------------------------------------------------------------------------

  /**
   * Adds a new member to a GROUP conversation.
   *
   * Authorization: only ADMIN participants can add new members.
   * Triggers Sender Key distribution (R14): existing members re-distribute
   * their Sender Keys to the new member so the new member can decrypt future
   * group messages.
   *
   * Writes an audit log entry for the group.member_add action (R32).
   *
   * @param conversationId - Group conversation to add member to
   * @param userId - User ID of the new member being added
   * @param currentUserId - Authenticated admin user performing the action
   * @param role - Role for the new member (defaults to MEMBER)
   * @returns Updated ConversationResponse with the new participant
   * @throws {NotFoundError} Conversation or user not found
   * @throws {ValidationError} Conversation is not GROUP type
   * @throws {AuthorizationError} Requester is not an admin
   * @throws {ConflictError} User is already a participant
   */
  async addParticipant(
    conversationId: string,
    userId: string,
    currentUserId: string,
    role: ParticipantRole = ParticipantRole.MEMBER,
  ): Promise<ConversationResponse> {
    // Retrieve conversation and enforce GROUP type
    const conversation = await this.findConversationOrThrow(conversationId);
    this.assertGroupConversation(conversation);

    // Enforce admin authorization
    this.assertAdminRole(conversation, currentUserId);

    // Verify the new user exists in the system
    const users = await this.userRepository.findByIds([userId]);
    if (users.length === 0) {
      throw new NotFoundError('User not found', {
        resource: 'User',
        id: userId,
      });
    }

    // Prevent duplicate membership
    const alreadyParticipant = await this.conversationRepository.isParticipant(
      conversationId,
      userId,
    );
    if (alreadyParticipant) {
      throw new ConflictError(
        'User is already a participant in this conversation',
        { userId, conversationId },
      );
    }

    // Build participant data with user profile info
    const user = users[0];
    const participantData: AddParticipantData = {
      userId,
      displayName: user.displayName,
      avatar: user.avatar,
      role,
    };

    const updated = await this.conversationRepository.addParticipant(
      conversationId,
      participantData,
    );

    // Invalidate cached participant IDs (stale after membership change)
    await this.invalidateParticipantsCache(conversationId);

    // CRITICAL (R14): Enqueue Sender Key distribution for the new member
    // Existing members re-distribute their Sender Keys to the new participant
    await this.queueProvider.enqueue('sender-key-distribution', {
      groupId: conversationId,
      newMemberId: userId,
      action: 'member_added',
    });

    // Write immutable audit entry (R32) — AuditService.log() never throws
    await this.auditService.log({
      action: AuditAction.GROUP_MEMBER_ADD,
      actorId: currentUserId,
      targetId: userId,
      metadata: { conversationId },
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // removeParticipant (R14: triggers Sender Key ROTATION)
  // ---------------------------------------------------------------------------

  /**
   * Removes a member from a GROUP conversation.
   *
   * Authorization: ADMIN participants can remove any member; any participant
   * can remove themselves (self-leave).
   *
   * CRITICAL (R14): Triggers Sender Key ROTATION — remaining members MUST
   * rotate their Sender Keys so the removed member cannot decrypt any messages
   * sent after their removal.
   *
   * Writes an audit log entry for the group.member_remove action (R32).
   *
   * @param conversationId - Group conversation to remove member from
   * @param userId - User ID of the member being removed
   * @param currentUserId - Authenticated user performing the action
   * @returns Updated ConversationResponse without the removed participant
   * @throws {NotFoundError} Conversation not found
   * @throws {ValidationError} Conversation is not GROUP type
   * @throws {AuthorizationError} Non-admin trying to remove another member
   */
  async removeParticipant(
    conversationId: string,
    userId: string,
    currentUserId: string,
  ): Promise<ConversationResponse> {
    // Retrieve conversation and enforce GROUP type
    const conversation = await this.findConversationOrThrow(conversationId);
    this.assertGroupConversation(conversation);

    // Allow self-leave; otherwise enforce admin authorization
    const isSelfLeave = userId === currentUserId;
    if (!isSelfLeave) {
      this.assertAdminRole(conversation, currentUserId);
    }

    const updated = await this.conversationRepository.removeParticipant(
      conversationId,
      userId,
    );

    // Invalidate cached participant IDs (stale after membership change)
    await this.invalidateParticipantsCache(conversationId);

    // CRITICAL (R14): Enqueue Sender Key ROTATION for remaining members
    // Removed member MUST NOT be able to decrypt future messages
    await this.queueProvider.enqueue('sender-key-distribution', {
      groupId: conversationId,
      removedMemberId: userId,
      action: 'member_removed',
    });

    // Write immutable audit entry (R32) — AuditService.log() never throws
    await this.auditService.log({
      action: AuditAction.GROUP_MEMBER_REMOVE,
      actorId: currentUserId,
      targetId: userId,
      metadata: { conversationId },
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // updateParticipantRole
  // ---------------------------------------------------------------------------

  /**
   * Updates a participant's role in a GROUP conversation (promote/demote).
   *
   * Authorization: only ADMIN participants can change roles.
   * Writes an audit log entry for the group.admin_change action (R32).
   *
   * @param conversationId - Group conversation
   * @param userId - Target participant whose role is being changed
   * @param role - New role (ADMIN or MEMBER)
   * @param currentUserId - Authenticated admin performing the action
   * @returns Updated ConversationResponse
   * @throws {NotFoundError} Conversation or participant not found
   * @throws {ValidationError} Conversation is not GROUP type
   * @throws {AuthorizationError} Requester is not an admin
   */
  async updateParticipantRole(
    conversationId: string,
    userId: string,
    role: ParticipantRole,
    currentUserId: string,
  ): Promise<ConversationResponse> {
    const conversation = await this.findConversationOrThrow(conversationId);
    this.assertGroupConversation(conversation);
    this.assertAdminRole(conversation, currentUserId);

    // Verify target user is a participant in this conversation
    const isParticipant = await this.conversationRepository.isParticipant(
      conversationId,
      userId,
    );
    if (!isParticipant) {
      throw new NotFoundError(
        'User is not a participant in this conversation',
        { resource: 'ConversationParticipant', userId, conversationId },
      );
    }

    const updated = await this.conversationRepository.updateParticipantRole(
      conversationId,
      userId,
      role,
    );

    // Write immutable audit entry (R32) — AuditService.log() never throws
    await this.auditService.log({
      action: AuditAction.GROUP_ADMIN_CHANGE,
      actorId: currentUserId,
      targetId: userId,
      metadata: { conversationId, newRole: role },
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // archiveConversation / unarchiveConversation
  // ---------------------------------------------------------------------------

  /**
   * Archives a conversation for the specified user (per-user setting).
   *
   * Archived conversations are hidden from the default chat list but remain
   * accessible when `includeArchived` is set in getConversations().
   *
   * @param conversationId - Conversation to archive
   * @param userId - User archiving the conversation
   * @returns Updated ConversationResponse reflecting archived state
   * @throws {NotFoundError} Conversation not found
   * @throws {AuthorizationError} User is not a participant
   */
  async archiveConversation(
    conversationId: string,
    userId: string,
  ): Promise<ConversationResponse> {
    await this.verifyParticipation(conversationId, userId);
    return this.conversationRepository.updateParticipantSettings(
      conversationId,
      userId,
      { isArchived: true },
    );
  }

  /**
   * Unarchives a conversation for the specified user (per-user setting).
   *
   * Restores a previously archived conversation to the default chat list.
   *
   * @param conversationId - Conversation to unarchive
   * @param userId - User unarchiving the conversation
   * @returns Updated ConversationResponse reflecting unarchived state
   * @throws {NotFoundError} Conversation not found
   * @throws {AuthorizationError} User is not a participant
   */
  async unarchiveConversation(
    conversationId: string,
    userId: string,
  ): Promise<ConversationResponse> {
    await this.verifyParticipation(conversationId, userId);
    return this.conversationRepository.updateParticipantSettings(
      conversationId,
      userId,
      { isArchived: false },
    );
  }

  // ---------------------------------------------------------------------------
  // muteConversation / unmuteConversation
  // ---------------------------------------------------------------------------

  /**
   * Mutes notifications for a conversation for the specified user.
   *
   * Accepts MuteSettings from the shared types package which may include
   * an optional expiration timestamp for time-limited muting.
   *
   * @param conversationId - Conversation to mute
   * @param userId - User muting the conversation
   * @param muteSettings - Mute configuration (isMuted flag + optional expiry)
   * @returns Updated ConversationResponse reflecting muted state
   * @throws {NotFoundError} Conversation not found
   * @throws {AuthorizationError} User is not a participant
   */
  async muteConversation(
    conversationId: string,
    userId: string,
    muteSettings: MuteSettings,
  ): Promise<ConversationResponse> {
    await this.verifyParticipation(conversationId, userId);

    // Convert shared MuteSettings (string dates) to repository ParticipantSettings (Date objects)
    const settings: ParticipantSettings = {
      isMuted: true,
      muteExpiresAt:
        typeof muteSettings.muteExpiresAt === 'string'
          ? new Date(muteSettings.muteExpiresAt)
          : muteSettings.muteExpiresAt ?? null,
    };

    return this.conversationRepository.updateParticipantSettings(
      conversationId,
      userId,
      settings,
    );
  }

  /**
   * Unmutes a previously muted conversation for the specified user.
   *
   * Clears both the muted flag and any expiration timestamp.
   *
   * @param conversationId - Conversation to unmute
   * @param userId - User unmuting the conversation
   * @returns Updated ConversationResponse reflecting unmuted state
   * @throws {NotFoundError} Conversation not found
   * @throws {AuthorizationError} User is not a participant
   */
  async unmuteConversation(
    conversationId: string,
    userId: string,
  ): Promise<ConversationResponse> {
    await this.verifyParticipation(conversationId, userId);
    return this.conversationRepository.updateParticipantSettings(
      conversationId,
      userId,
      { isMuted: false, muteExpiresAt: null },
    );
  }

  // ---------------------------------------------------------------------------
  // updateGroupDetails
  // ---------------------------------------------------------------------------

  /**
   * Updates a group conversation's metadata (name and/or avatar).
   *
   * Authorization: only ADMIN participants can update group details.
   * Only applicable to GROUP conversations.
   *
   * @param conversationId - Group conversation to update
   * @param data - Group details to update (groupName and/or groupAvatar)
   * @param currentUserId - Authenticated admin performing the update
   * @returns Updated ConversationResponse
   * @throws {NotFoundError} Conversation not found
   * @throws {ValidationError} Conversation is not GROUP type
   * @throws {AuthorizationError} Requester is not an admin
   */
  async updateGroupDetails(
    conversationId: string,
    data: Pick<UpdateConversationDTO, 'groupName' | 'groupAvatar'>,
    currentUserId: string,
  ): Promise<ConversationResponse> {
    const conversation = await this.findConversationOrThrow(conversationId);
    this.assertGroupConversation(conversation);
    this.assertAdminRole(conversation, currentUserId);

    return this.conversationRepository.updateGroupDetails(conversationId, {
      groupName: data.groupName,
      groupAvatar: data.groupAvatar,
    });
  }

  // ---------------------------------------------------------------------------
  // getParticipantIds (supports R18 fan-out decision)
  // ---------------------------------------------------------------------------

  /**
   * Retrieves the list of participant user IDs for a conversation.
   *
   * Results are cached in Redis for performance (TTL: 5 minutes) since
   * participant lists change infrequently relative to read frequency.
   * The cache is invalidated when members are added or removed.
   *
   * Used by MessageService to determine whether to use direct delivery
   * or BullMQ fan-out (R18: fan-out when participant count >= 3).
   *
   * @param conversationId - Conversation whose participants to retrieve
   * @returns Array of participant user IDs
   */
  async getParticipantIds(conversationId: string): Promise<string[]> {
    // Check Redis cache first for performance
    const cacheKey = `${CACHE_PREFIX_PARTICIPANTS}${conversationId}`;
    const cached = await this.cacheProvider.get<string[]>(cacheKey);
    if (cached) {
      return cached;
    }

    // Cache miss: fetch from database via repository
    const ids = await this.conversationRepository.getParticipantIds(conversationId);

    // Populate cache for subsequent reads
    await this.cacheProvider.set(cacheKey, ids, PARTICIPANTS_CACHE_TTL_SECONDS);

    return ids;
  }

  // ---------------------------------------------------------------------------
  // resetUnreadCount
  // ---------------------------------------------------------------------------

  /**
   * Resets the unread message count for a user in a conversation.
   *
   * Typically called when a user opens a conversation and reads all messages,
   * clearing the unread badge displayed in the chat list (Figma Screen 1).
   *
   * @param conversationId - Conversation to reset count for
   * @param userId - User whose unread count to reset
   */
  async resetUnreadCount(
    conversationId: string,
    userId: string,
  ): Promise<void> {
    return this.conversationRepository.resetUnreadCount(conversationId, userId);
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  /**
   * Finds a conversation by ID or throws NotFoundError.
   *
   * Centralizes the common pattern of looking up a conversation and raising
   * a typed 404 error if it does not exist.
   *
   * @param conversationId - Conversation ID to look up
   * @returns The found ConversationResponse
   * @throws {NotFoundError} If the conversation does not exist
   */
  private async findConversationOrThrow(
    conversationId: string,
  ): Promise<ConversationResponse> {
    const conversation =
      await this.conversationRepository.findById(conversationId);
    if (!conversation) {
      throw new NotFoundError('Conversation not found', {
        resource: 'Conversation',
        id: conversationId,
      });
    }
    return conversation;
  }

  /**
   * Asserts that a conversation is of type GROUP.
   *
   * Many operations (addParticipant, removeParticipant, updateParticipantRole,
   * updateGroupDetails) are only valid for group conversations. This guard
   * throws a descriptive ValidationError for DIRECT conversations.
   *
   * @param conversation - Conversation to check
   * @throws {ValidationError} If the conversation is not GROUP type
   */
  private assertGroupConversation(conversation: ConversationResponse): void {
    if (conversation.type !== ConversationType.GROUP) {
      throw new ValidationError(
        'This operation is only available for group conversations',
        { conversationType: conversation.type },
      );
    }
  }

  /**
   * Asserts that a user has the ADMIN role in a conversation.
   *
   * Enforces authorization for group management operations: adding/removing
   * members, changing roles, and updating group details all require ADMIN.
   *
   * @param conversation - Conversation containing the participant list
   * @param userId - User whose role to verify
   * @throws {AuthorizationError} If the user is not a participant or not an admin
   */
  private assertAdminRole(
    conversation: ConversationResponse,
    userId: string,
  ): void {
    const participant = conversation.participants.find(
      (p) => p.userId === userId,
    );
    if (!participant) {
      throw new AuthorizationError('Not a participant in this conversation');
    }
    if (participant.role !== ParticipantRole.ADMIN) {
      throw new AuthorizationError(
        'Only group admins can perform this action',
      );
    }
  }

  /**
   * Verifies that a user is a participant in a conversation.
   *
   * Used as a guard for per-user operations (archive, mute) that require
   * membership but not necessarily admin status.
   *
   * @param conversationId - Conversation to check
   * @param userId - User whose participation to verify
   * @throws {NotFoundError} If the conversation does not exist
   * @throws {AuthorizationError} If the user is not a participant
   */
  private async verifyParticipation(
    conversationId: string,
    userId: string,
  ): Promise<void> {
    const conversation = await this.findConversationOrThrow(conversationId);
    const isParticipant = conversation.participants.some(
      (p) => p.userId === userId,
    );
    if (!isParticipant) {
      throw new AuthorizationError('Not a participant in this conversation');
    }
  }

  /**
   * Invalidates the cached participant ID list for a conversation.
   *
   * Called after any membership change (addParticipant, removeParticipant)
   * to ensure subsequent reads via getParticipantIds() fetch fresh data.
   *
   * @param conversationId - Conversation whose cache to invalidate
   */
  private async invalidateParticipantsCache(
    conversationId: string,
  ): Promise<void> {
    const cacheKey = `${CACHE_PREFIX_PARTICIPANTS}${conversationId}`;
    await this.cacheProvider.del(cacheKey);
  }
}
