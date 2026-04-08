/**
 * @module apps/api/src/repositories/ConversationRepository
 *
 * Prisma-backed implementation of the IConversationRepository interface.
 *
 * Handles conversation persistence operations including CRUD for both DIRECT
 * (1:1) and GROUP conversations, participant membership management, per-user
 * settings (archive / mute), paginated conversation lists, and unread count
 * tracking. This is the most complex repository, orchestrating two related
 * Prisma models: `Conversation` and `ConversationParticipant`.
 *
 * Architecture rules enforced:
 * - R17: Implements IConversationRepository interface (interface-driven DI).
 *        PrismaClient injected via constructor — no hard-coded instantiation.
 * - R16: Zero business logic — persistence only. Group size limits, admin
 *        checks, Sender Key rotation (R14), and access control live in
 *        ConversationService.
 * - R14: Membership mutations (add/remove) are persistence-only. The service
 *        layer triggers Sender Key redistribution after these calls.
 * - R28: Zero console.log — structured Pino logging handled at service layer.
 * - R7:  TypeScript strict mode, zero warnings.
 *
 * Field mapping (Prisma ↔ Shared types):
 * - Prisma `title` (String?) → Shared `groupName` (string | undefined)
 * - Prisma `avatarUrl` (String?) → Shared `groupAvatar` (string | undefined)
 * - Prisma `muteExpiresAt` (DateTime?) → Shared `muteExpiresAt` (string | null | undefined)
 * - Prisma `pinnedAt` (DateTime?) → Shared `pinnedAt` (string | undefined)
 * - Prisma `DateTime` fields → ISO 8601 strings in responses
 * - Prisma `null` optional fields → `undefined` in shared types
 */

import type { PrismaClient } from '@prisma/client';
import type {
  IConversationRepository,
  CreateConversationData,
  AddParticipantData,
  ParticipantSettings,
} from '../domain/interfaces/IConversationRepository.js';
import {
  ConversationType,
  ParticipantRole,
  type ConversationResponse,
  type ConversationListItem,
  type ConversationParticipant,
  type MuteSettings,
} from '@kalle/shared';

// =============================================================================
// Local Prisma result-shape interfaces (avoids `any` in mappers — R7)
// =============================================================================

/**
 * User fields selected in participant includes across all conversation queries.
 */
interface SelectedUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  isOnline: boolean;
  lastSeen: Date | null;
}

/**
 * Shape of a ConversationParticipant row when included with its `user` select.
 * Matches the Prisma result for:
 * `include: { user: { select: { id, displayName, avatarUrl, isOnline, lastSeen } } }`
 */
interface ParticipantRecord {
  id: string;
  userId: string;
  conversationId: string;
  role: string;
  isArchived: boolean;
  isMuted: boolean;
  muteExpiresAt: Date | null;
  pinnedAt: Date | null;
  lastReadAt: Date | null;
  joinedAt: Date;
  user: SelectedUser | null;
}

/**
 * Shape of a last-message preview row as returned by the `messages` select.
 * Matches the Prisma result for:
 * `select: { id, senderId, ciphertext, type, serverTimestamp, isDeleted, sender: { select: { displayName } } }`
 */
interface MessagePreviewRecord {
  id: string;
  senderId: string;
  ciphertext: string | null;
  type: string;
  serverTimestamp: Date;
  isDeleted: boolean;
  sender: { displayName: string } | null;
}

/**
 * Shape of a Conversation Prisma result when included with participants (and
 * their user select) plus an optional last-message preview.
 */
interface ConversationRecord {
  id: string;
  type: string;
  title: string | null;
  avatarUrl: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  participants: ParticipantRecord[];
  messages?: MessagePreviewRecord[];
}

// =============================================================================
// ConversationRepository — Prisma-backed implementation
// =============================================================================

export class ConversationRepository implements IConversationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ─── Create ──────────────────────────────────────────────────────────

  /**
   * Creates a new conversation (DIRECT or GROUP) with initial participants
   * in a single atomic Prisma nested-create operation.
   *
   * For GROUP conversations, the first participant with ADMIN role is
   * recorded as `createdBy`. For DIRECT conversations, `createdBy` is
   * not set (null). The Conversation model generates a UUID v4 for `id`
   * unless one is supplied via `data.id`.
   *
   * Field mapping:
   * - `data.groupName` → Prisma `title`
   * - `data.groupAvatar` → Prisma `avatarUrl`
   * - `data.participants[].role` → Prisma `ConversationParticipant.role`
   *
   * @param data - {@link CreateConversationData} with type, participants,
   *               and optional group metadata.
   * @returns Fully-hydrated {@link ConversationResponse} including
   *          participant details and timestamps.
   */
  async create(data: CreateConversationData): Promise<ConversationResponse> {
    const creator = data.participants.find(
      (p) => p.role === ParticipantRole.ADMIN,
    );

    const record = await this.prisma.conversation.create({
      data: {
        ...(data.id ? { id: data.id } : {}),
        type: data.type,
        title: data.groupName ?? null,
        avatarUrl: data.groupAvatar ?? null,
        createdBy: creator?.userId ?? null,
        participants: {
          create: data.participants.map((p) => ({
            userId: p.userId,
            role: p.role,
          })),
        },
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                displayName: true,
                avatarUrl: true,
                isOnline: true,
                lastSeen: true,
              },
            },
          },
        },
      },
    });

    return this.mapToResponse(record);
  }

  // ─── Find by ID ─────────────────────────────────────────────────────

  /**
   * Finds a conversation by its unique identifier, including all
   * participants with user profile info and the most recent message.
   *
   * Per-user settings (isArchived, muteSettings, pinnedAt) default to
   * their base values since no requesting user context is available.
   * The service layer augments these fields for the specific caller.
   *
   * @param id - The conversation's unique identifier.
   * @returns The {@link ConversationResponse}, or `null` if not found.
   */
  async findById(id: string): Promise<ConversationResponse | null> {
    const record = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                displayName: true,
                avatarUrl: true,
                isOnline: true,
                lastSeen: true,
              },
            },
          },
        },
        messages: {
          orderBy: { serverTimestamp: 'desc' },
          take: 1,
          select: {
            id: true,
            senderId: true,
            ciphertext: true,
            type: true,
            serverTimestamp: true,
            isDeleted: true,
            sender: { select: { displayName: true } },
          },
        },
      },
    });

    return record ? this.mapToResponse(record) : null;
  }

  // ─── Find by User ID (Paginated) ───────────────────────────────────

  /**
   * Retrieves conversations for a specific user with cursor-based
   * pagination, ordered by most recently updated (updatedAt descending).
   *
   * Includes the last message preview for chat list display, the user's
   * per-participant settings (archive/mute), and computes the per-
   * conversation unread count based on `lastReadAt` timestamps.
   *
   * For DIRECT conversations, the display name and avatar resolve to
   * the "other" participant's profile. For GROUP conversations, the
   * group name and avatar are used.
   *
   * @param userId  - The user whose conversations to list.
   * @param options - Optional pagination and filter parameters.
   * @returns A page of {@link ConversationListItem} entries with cursor.
   */
  async findByUserId(
    userId: string,
    options?: {
      cursor?: string;
      limit?: number;
      includeArchived?: boolean;
    },
  ): Promise<{
    items: ConversationListItem[];
    cursor?: string;
    hasMore: boolean;
  }> {
    const limit = options?.limit ?? 50;
    const excludeArchived = !options?.includeArchived;

    const records = await this.prisma.conversation.findMany({
      where: {
        participants: {
          some: {
            userId,
            ...(excludeArchived ? { isArchived: false } : {}),
          },
        },
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                displayName: true,
                avatarUrl: true,
                isOnline: true,
                lastSeen: true,
              },
            },
          },
        },
        messages: {
          orderBy: { serverTimestamp: 'desc' },
          take: 1,
          select: {
            id: true,
            senderId: true,
            ciphertext: true,
            type: true,
            serverTimestamp: true,
            isDeleted: true,
            sender: { select: { displayName: true } },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit + 1,
      ...(options?.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = records.length > limit;
    const pageRecords = records.slice(0, limit);

    // Compute unread counts in parallel for each conversation
    const unreadMap: Record<string, number> = {};
    await Promise.all(
      pageRecords.map(async (r) => {
        const myParticipant = r.participants.find(
          (p) => p.userId === userId,
        );
        const count = await this.prisma.message.count({
          where: {
            conversationId: r.id,
            senderId: { not: userId },
            ...(myParticipant?.lastReadAt
              ? { serverTimestamp: { gt: myParticipant.lastReadAt } }
              : {}),
          },
        });
        unreadMap[r.id] = count;
      }),
    );

    const items = pageRecords.map((r) =>
      this.mapToListItem(r, userId, unreadMap[r.id] ?? 0),
    );

    const cursor =
      hasMore && items.length > 0
        ? items[items.length - 1].id
        : undefined;

    return { items, cursor, hasMore };
  }

  // ─── Find Direct Conversation ───────────────────────────────────────

  /**
   * Finds an existing DIRECT conversation between two specific users.
   *
   * Used by ConversationService to prevent creating duplicate 1:1
   * conversations. If a DIRECT conversation already exists between the
   * two users, the service returns it instead of creating a new one.
   *
   * @param userId1 - First user's unique identifier.
   * @param userId2 - Second user's unique identifier.
   * @returns The {@link ConversationResponse} if found, otherwise `null`.
   */
  async findDirectConversation(
    userId1: string,
    userId2: string,
  ): Promise<ConversationResponse | null> {
    const record = await this.prisma.conversation.findFirst({
      where: {
        type: ConversationType.DIRECT,
        AND: [
          { participants: { some: { userId: userId1 } } },
          { participants: { some: { userId: userId2 } } },
        ],
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                displayName: true,
                avatarUrl: true,
                isOnline: true,
                lastSeen: true,
              },
            },
          },
        },
        messages: {
          orderBy: { serverTimestamp: 'desc' },
          take: 1,
          select: {
            id: true,
            senderId: true,
            ciphertext: true,
            type: true,
            serverTimestamp: true,
            isDeleted: true,
            sender: { select: { displayName: true } },
          },
        },
      },
    });

    return record ? this.mapToResponse(record) : null;
  }

  // ─── Add Participant ────────────────────────────────────────────────

  /**
   * Adds a single participant to a GROUP conversation.
   *
   * Creates the `ConversationParticipant` join record and touches
   * `updatedAt` on the conversation so it surfaces at the top of
   * participants' chat lists. Returns the fully refreshed conversation.
   *
   * The service layer is responsible for triggering Sender Key
   * redistribution (R14) after this call succeeds.
   *
   * @param conversationId - The conversation to add the participant to.
   * @param participant    - {@link AddParticipantData} with user identity
   *                         and role.
   * @returns Updated {@link ConversationResponse} including the new member.
   */
  async addParticipant(
    conversationId: string,
    participant: AddParticipantData,
  ): Promise<ConversationResponse> {
    await this.prisma.conversationParticipant.create({
      data: {
        conversationId,
        userId: participant.userId,
        role: participant.role,
      },
    });

    // Touch updatedAt so the conversation surfaces in chat lists
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    return this.refetchConversation(conversationId);
  }

  // ─── Remove Participant ─────────────────────────────────────────────

  /**
   * Removes a participant from a GROUP conversation.
   *
   * Uses `deleteMany` for safe handling of the composite key
   * (idempotent — no error if already removed). Touches `updatedAt`
   * on the conversation. Returns the refreshed conversation without
   * the removed member.
   *
   * The service layer is responsible for triggering Sender Key
   * rotation (R14) after this call succeeds.
   *
   * @param conversationId - The conversation to remove the user from.
   * @param userId         - The user to remove.
   * @returns Updated {@link ConversationResponse} without the removed
   *          participant.
   */
  async removeParticipant(
    conversationId: string,
    userId: string,
  ): Promise<ConversationResponse> {
    await this.prisma.conversationParticipant.deleteMany({
      where: {
        conversationId,
        userId,
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    return this.refetchConversation(conversationId);
  }

  // ─── Update Participant Role ────────────────────────────────────────

  /**
   * Updates a participant's role within a GROUP conversation.
   *
   * Used for promoting MEMBER → ADMIN or demoting ADMIN → MEMBER.
   * Uses `updateMany` since the match targets the composite key
   * (userId + conversationId) on the join table.
   *
   * @param conversationId - The conversation identifier.
   * @param userId         - The user whose role should change.
   * @param role           - The new {@link ParticipantRole} to assign.
   * @returns Updated {@link ConversationResponse}.
   */
  async updateParticipantRole(
    conversationId: string,
    userId: string,
    role: ParticipantRole,
  ): Promise<ConversationResponse> {
    await this.prisma.conversationParticipant.updateMany({
      where: { conversationId, userId },
      data: { role },
    });

    return this.refetchConversation(conversationId);
  }

  // ─── Update Participant Settings ────────────────────────────────────

  /**
   * Updates per-user conversation settings (archive / mute / lastReadAt).
   *
   * These settings are stored on the `ConversationParticipant` join table,
   * so each user can independently archive or mute a conversation without
   * affecting other members.
   *
   * Only fields present in the `settings` object are updated; omitted
   * fields are left unchanged. Uses `updateMany` to match on the
   * composite key (userId + conversationId).
   *
   * @param conversationId - The conversation identifier.
   * @param userId         - The user whose settings should be updated.
   * @param settings       - {@link ParticipantSettings} fields to change.
   * @returns Updated {@link ConversationResponse} reflecting new settings.
   */
  async updateParticipantSettings(
    conversationId: string,
    userId: string,
    settings: ParticipantSettings,
  ): Promise<ConversationResponse> {
    const updateData: Record<string, unknown> = {};

    if (settings.isArchived !== undefined) {
      updateData.isArchived = settings.isArchived;
    }
    if (settings.isMuted !== undefined) {
      updateData.isMuted = settings.isMuted;
    }
    if (settings.muteExpiresAt !== undefined) {
      updateData.muteExpiresAt = settings.muteExpiresAt;
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.conversationParticipant.updateMany({
        where: { conversationId, userId },
        data: updateData,
      });
    }

    return this.refetchConversation(conversationId, userId);
  }

  // ─── Update Group Details ───────────────────────────────────────────

  /**
   * Updates group-level conversation details (name and / or avatar).
   *
   * Only applicable to GROUP conversations. The service layer verifies
   * the caller has ADMIN role before invoking this method (R16).
   *
   * Field mapping:
   * - `data.groupName` → Prisma `title`
   * - `data.groupAvatar` → Prisma `avatarUrl`
   *
   * @param conversationId - The conversation identifier.
   * @param data           - Fields to update; omitted fields unchanged.
   * @returns Updated {@link ConversationResponse}.
   */
  async updateGroupDetails(
    conversationId: string,
    data: { groupName?: string; groupAvatar?: string },
  ): Promise<ConversationResponse> {
    const updateData: Record<string, unknown> = {};

    if (data.groupName !== undefined) {
      updateData.title = data.groupName;
    }
    if (data.groupAvatar !== undefined) {
      updateData.avatarUrl = data.groupAvatar;
    }

    updateData.updatedAt = new Date();

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: updateData,
    });

    return this.refetchConversation(conversationId);
  }

  // ─── Get Participant IDs ────────────────────────────────────────────

  /**
   * Retrieves the user IDs of all participants in a conversation.
   *
   * Used by the service layer for message fan-out (R18) and Sender Key
   * distribution (R14). Returns a simple string array for efficient
   * downstream processing.
   *
   * @param conversationId - The conversation identifier.
   * @returns Array of participant user ID strings.
   */
  async getParticipantIds(conversationId: string): Promise<string[]> {
    const participants = await this.prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });

    return participants.map((p) => p.userId);
  }

  // ─── Is Participant ─────────────────────────────────────────────────

  /**
   * Checks whether a user is a participant in a conversation.
   *
   * Used for authorisation checks before allowing message operations,
   * settings updates, and other conversation-scoped actions.
   *
   * @param conversationId - The conversation identifier.
   * @param userId         - The user to check.
   * @returns `true` if the user is a current participant; `false` otherwise.
   */
  async isParticipant(
    conversationId: string,
    userId: string,
  ): Promise<boolean> {
    const count = await this.prisma.conversationParticipant.count({
      where: { conversationId, userId },
    });

    return count > 0;
  }

  // ─── Get Unread Counts ──────────────────────────────────────────────

  /**
   * Gets unread message counts for a user across **all** their
   * conversations.
   *
   * Unread counts are derived by counting messages where
   * `serverTimestamp > participant.lastReadAt` and `senderId ≠ userId`.
   * Conversations with zero unread messages are omitted from the result.
   *
   * Counts are computed in parallel for efficiency.
   *
   * @param userId - The user whose unread counts to retrieve.
   * @returns Record mapping conversation IDs to unread counts.
   */
  async getUnreadCounts(userId: string): Promise<Record<string, number>> {
    const participants = await this.prisma.conversationParticipant.findMany({
      where: { userId },
      select: { conversationId: true, lastReadAt: true },
    });

    const counts: Record<string, number> = {};

    await Promise.all(
      participants.map(async (p) => {
        const count = await this.prisma.message.count({
          where: {
            conversationId: p.conversationId,
            senderId: { not: userId },
            ...(p.lastReadAt
              ? { serverTimestamp: { gt: p.lastReadAt } }
              : {}),
          },
        });

        if (count > 0) {
          counts[p.conversationId] = count;
        }
      }),
    );

    return counts;
  }

  // ─── Reset Unread Count ─────────────────────────────────────────────

  /**
   * Resets the unread message count for a user in a specific conversation
   * by setting their `lastReadAt` to the current timestamp.
   *
   * Called when the user opens a conversation and reads all messages.
   * Future unread count computations will only count messages with
   * `serverTimestamp > lastReadAt`.
   *
   * @param conversationId - The conversation whose count to reset.
   * @param userId         - The user for whom to reset.
   */
  async resetUnreadCount(
    conversationId: string,
    userId: string,
  ): Promise<void> {
    await this.prisma.conversationParticipant.updateMany({
      where: { conversationId, userId },
      data: { lastReadAt: new Date() },
    });
  }

  // ─── Increment Unread Count ─────────────────────────────────────────

  /**
   * Signals that a new message was posted in a conversation.
   *
   * Unread counts are **derived** from `lastReadAt` vs message
   * `serverTimestamp`, so creating a new message automatically increases
   * the computed count for all participants whose `lastReadAt` predates
   * the new message. This method touches the conversation's `updatedAt`
   * so it surfaces at the top of all participants' chat lists.
   *
   * The `senderUserId` parameter is accepted to satisfy the interface
   * contract; the sender's unread state is unaffected because
   * `getUnreadCounts` excludes self-sent messages.
   *
   * @param conversationId - The conversation that received a new message.
   * @param senderUserId   - The sender's user ID (excluded from increment).
   */
  async incrementUnreadCount(
    conversationId: string,
    senderUserId: string,
  ): Promise<void> {
    // Touch updatedAt so the conversation bubbles to the top of chat lists.
    // The actual unread count is computed on-the-fly by getUnreadCounts()
    // based on lastReadAt vs message serverTimestamp — no counter column
    // to increment.
    void senderUserId; // acknowledged but unused — unread is derived
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
  }

  // ─── Private: Re-fetch Conversation ─────────────────────────────────

  /**
   * Re-fetches a conversation with full participant and last-message
   * includes after a mutation, mapping to {@link ConversationResponse}.
   *
   * When `requestingUserId` is provided, the response's per-user fields
   * (isArchived, muteSettings, pinnedAt) are populated from that user's
   * participant record. Otherwise, defaults are used.
   *
   * @param conversationId   - The conversation to re-fetch.
   * @param requestingUserId - Optional user ID for per-user field resolution.
   * @returns Fully-hydrated {@link ConversationResponse}.
   * @throws Error if the conversation does not exist (data integrity check).
   */
  private async refetchConversation(
    conversationId: string,
    requestingUserId?: string,
  ): Promise<ConversationResponse> {
    const record = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                displayName: true,
                avatarUrl: true,
                isOnline: true,
                lastSeen: true,
              },
            },
          },
        },
        messages: {
          orderBy: { serverTimestamp: 'desc' },
          take: 1,
          select: {
            id: true,
            senderId: true,
            ciphertext: true,
            type: true,
            serverTimestamp: true,
            isDeleted: true,
            sender: { select: { displayName: true } },
          },
        },
      },
    });

    if (!record) {
      throw new Error(
        `Conversation ${conversationId} not found after mutation`,
      );
    }

    return this.mapToResponse(record, requestingUserId);
  }

  // ─── Private Mappers ────────────────────────────────────────────────

  /**
   * Maps a Prisma Conversation record (with includes) to the public
   * {@link ConversationResponse} type.
   *
   * Field mapping:
   * - Prisma `title` → `groupName`
   * - Prisma `avatarUrl` → `groupAvatar`
   * - Prisma DateTime fields → ISO 8601 strings
   * - Per-user fields (isArchived, muteSettings, pinnedAt) resolved
   *   from `requestingUserId`'s participant record when available.
   *
   * @param record           - Raw Prisma record with participant/message includes.
   * @param requestingUserId - Optional user ID for per-user field resolution.
   */
  private mapToResponse(
    record: ConversationRecord,
    requestingUserId?: string,
  ): ConversationResponse {
    const myParticipant = requestingUserId
      ? record.participants.find(
          (p: ParticipantRecord) => p.userId === requestingUserId,
        )
      : undefined;

    const lastMsg = record.messages?.[0];

    const muteSettings: MuteSettings = {
      isMuted: myParticipant?.isMuted ?? false,
      muteExpiresAt:
        myParticipant?.muteExpiresAt instanceof Date
          ? myParticipant.muteExpiresAt.toISOString()
          : (myParticipant?.muteExpiresAt ?? undefined),
    };

    return {
      id: record.id,
      type: record.type as ConversationType,
      groupName: record.title ?? undefined,
      groupAvatar: record.avatarUrl ?? undefined,
      participants: record.participants.map((p: ParticipantRecord) =>
        this.mapToParticipant(p),
      ),
      lastMessage: lastMsg
        ? {
            id: lastMsg.id,
            senderId: lastMsg.senderId,
            senderName: lastMsg.sender?.displayName ?? 'Unknown',
            ciphertext: lastMsg.ciphertext ?? null,
            type: lastMsg.type,
            serverTimestamp:
              lastMsg.serverTimestamp instanceof Date
                ? lastMsg.serverTimestamp.toISOString()
                : lastMsg.serverTimestamp,
            isDeleted: lastMsg.isDeleted,
          }
        : undefined,
      unreadCount: 0, // Derived on-the-fly via getUnreadCounts()
      isArchived: myParticipant?.isArchived ?? false,
      muteSettings,
      pinnedAt:
        myParticipant?.pinnedAt instanceof Date
          ? myParticipant.pinnedAt.toISOString()
          : (myParticipant?.pinnedAt ?? undefined),
      createdAt:
        record.createdAt instanceof Date
          ? record.createdAt.toISOString()
          : record.createdAt,
      updatedAt:
        record.updatedAt instanceof Date
          ? record.updatedAt.toISOString()
          : record.updatedAt,
    };
  }

  /**
   * Maps a Prisma Conversation record to the lightweight
   * {@link ConversationListItem} optimised for chat list rendering.
   *
   * For DIRECT conversations, `displayName` and `avatar` resolve to
   * the "other" participant's profile. For GROUP conversations, the
   * group name (`title`) and group avatar (`avatarUrl`) are used.
   *
   * @param record      - Raw Prisma record with participant/message includes.
   * @param userId      - The requesting user's ID (for resolving "other" user).
   * @param unreadCount - Pre-computed unread message count.
   */
  private mapToListItem(
    record: ConversationRecord,
    userId: string,
    unreadCount: number = 0,
  ): ConversationListItem {
    const myParticipant = record.participants.find(
      (p: ParticipantRecord) => p.userId === userId,
    );

    const lastMsg = record.messages?.[0];

    let displayName: string;
    let avatar: string | undefined;
    let isOnline: boolean | undefined;
    let lastSeen: string | undefined;

    if (record.type === ConversationType.DIRECT) {
      // For DIRECT, resolve the "other" participant's display info
      const other = record.participants.find(
        (p: ParticipantRecord) => p.userId !== userId,
      );
      displayName = other?.user?.displayName ?? 'Unknown';
      avatar = other?.user?.avatarUrl ?? undefined;
      isOnline = other?.user?.isOnline;
      lastSeen =
        other?.user?.lastSeen instanceof Date
          ? other.user.lastSeen.toISOString()
          : (other?.user?.lastSeen ?? undefined);
    } else {
      // For GROUP, use group name and avatar
      displayName = record.title ?? 'Unnamed Group';
      avatar = record.avatarUrl ?? undefined;
      isOnline = undefined;
      lastSeen = undefined;
    }

    return {
      id: record.id,
      type: record.type as ConversationType,
      displayName,
      avatar,
      lastMessage: lastMsg
        ? {
            senderName: lastMsg.sender?.displayName ?? 'Unknown',
            ciphertext: lastMsg.ciphertext ?? null,
            type: lastMsg.type,
            serverTimestamp:
              lastMsg.serverTimestamp instanceof Date
                ? lastMsg.serverTimestamp.toISOString()
                : lastMsg.serverTimestamp,
            isDeleted: lastMsg.isDeleted,
          }
        : undefined,
      unreadCount,
      isArchived: myParticipant?.isArchived ?? false,
      isMuted: myParticipant?.isMuted ?? false,
      isOnline,
      lastSeen,
    };
  }

  /**
   * Maps a Prisma ConversationParticipant record (with user include)
   * to the public {@link ConversationParticipant} type.
   *
   * Field mapping:
   * - Participant `user.avatarUrl` → `avatar`
   * - Participant `user.isOnline` → `isOnline`
   * - Participant `user.lastSeen` (DateTime) → `lastSeen` (ISO 8601 string)
   * - Participant `joinedAt` (DateTime) → `joinedAt` (ISO 8601 string)
   * - Participant `role` (Prisma enum) → `role` (ParticipantRole)
   *
   * @param record - Raw Prisma ConversationParticipant with user include.
   */
  private mapToParticipant(record: ParticipantRecord): ConversationParticipant {
    return {
      userId: record.userId,
      displayName: record.user?.displayName ?? 'Unknown',
      avatar: record.user?.avatarUrl ?? undefined,
      role: record.role as ParticipantRole,
      joinedAt:
        record.joinedAt instanceof Date
          ? record.joinedAt.toISOString()
          : record.joinedAt,
      isOnline: record.user?.isOnline,
      lastSeen:
        record.user?.lastSeen instanceof Date
          ? record.user.lastSeen.toISOString()
          : (record.user?.lastSeen ?? undefined),
    };
  }
}
