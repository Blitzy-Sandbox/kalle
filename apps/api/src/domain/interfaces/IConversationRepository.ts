/**
 * @module IConversationRepository
 *
 * Defines the conversation repository contract for persisting conversations
 * (both DIRECT and GROUP), managing participant membership, handling per-user
 * settings (archive/mute), and supporting paginated conversation lists.
 *
 * The concrete Prisma-backed implementation lives in
 * `apps/api/src/repositories/ConversationRepository.ts`. Services import
 * ONLY this interface — never the concrete class (Rule R17).
 *
 * Design notes:
 * - Composite index on `userId + conversationId` in the
 *   `ConversationParticipant` table supports efficient look-ups
 *   (see AAP Section 0.4.5).
 * - Membership mutations (add/remove participant) are persistence-only
 *   operations. The **service layer** is responsible for triggering
 *   Sender Key rotation (R14) and BullMQ fan-out (R18) after these calls.
 * - Per-user settings (archive, mute) are stored on the join table
 *   (`ConversationParticipant`) so each user can independently
 *   archive/mute a conversation without affecting other members.
 * - All methods return `Promise<T>` to allow async Prisma operations
 *   in the concrete implementation.
 *
 * @see AAP Section 0.2.3, 0.4.5
 * @see Rules R14 (Sender Keys), R16 (OOD Layering), R17 (Interface-Driven),
 *      R18 (Fan-Out via Queue), R7 (Zero Warnings), R28 (Structured Logging)
 */

import type {
  ConversationResponse,
  ConversationListItem,
  ConversationType,
  ParticipantRole,
  ConversationParticipant,
  MuteSettings,
} from '@kalle/shared';

// Re-export shared types that form part of this repository's public contract.
// ConversationResponse (returned by most methods) embeds both
// ConversationParticipant[] and MuteSettings, so consumers of this interface
// module typically need these types when processing repository results.
export type { ConversationParticipant, MuteSettings };

// ---------------------------------------------------------------------------
// Repository-level data-transfer interfaces
// ---------------------------------------------------------------------------

/**
 * Data required to create a new conversation.
 *
 * - For `DIRECT` conversations: `participants` must contain exactly two
 *   entries (one per side of the 1:1 chat). `groupName` and `groupAvatar`
 *   should be omitted.
 * - For `GROUP` conversations: `participants` must contain two or more
 *   entries, at least one with `role: ADMIN`. `groupName` is expected.
 *
 * The optional `id` field allows the caller to supply an externally
 * generated identifier (e.g. a UUID v4 created by the service layer).
 * When omitted, the repository implementation generates one.
 */
export interface CreateConversationData {
  /** Optional pre-generated conversation identifier. */
  id?: string;

  /** Whether this is a 1:1 (`DIRECT`) or multi-user (`GROUP`) chat. */
  type: ConversationType;

  /**
   * Display name for a GROUP conversation.
   * Ignored for DIRECT conversations.
   */
  groupName?: string;

  /**
   * Avatar URL for a GROUP conversation.
   * Ignored for DIRECT conversations.
   */
  groupAvatar?: string;

  /**
   * Initial set of participants to include in the conversation.
   * Each entry specifies the user identity and their assigned role.
   */
  participants: Array<{
    /** The unique user identifier. */
    userId: string;
    /** The participant's display name at the time of creation. */
    displayName: string;
    /** Optional avatar URL for the participant. */
    avatar?: string;
    /** The role to assign (ADMIN or MEMBER). */
    role: ParticipantRole;
  }>;
}

/**
 * Per-user conversation settings that are stored on the
 * `ConversationParticipant` join table.
 *
 * All fields are optional — only the fields present in the object
 * will be updated; omitted fields are left unchanged.
 *
 * - `isArchived`: moves the conversation to / from the archive view.
 * - `isMuted` / `muteExpiresAt`: controls notification suppression.
 *   Setting `muteExpiresAt` to `null` represents an indefinite mute.
 */
export interface ParticipantSettings {
  /** Set `true` to archive, `false` to unarchive. */
  isArchived?: boolean;

  /** Set `true` to mute, `false` to unmute. */
  isMuted?: boolean;

  /**
   * When the mute expires.
   * - `Date` instance: muted until this moment.
   * - `null`: muted indefinitely (no automatic unmute).
   * - `undefined` / omitted: no change to the current value.
   */
  muteExpiresAt?: Date | null;
}

/**
 * Data for adding a single participant to a GROUP conversation.
 *
 * Adding a member triggers Sender Key rotation at the service layer
 * (R14) so the new member cannot decrypt pre-join messages.
 */
export interface AddParticipantData {
  /** The unique user identifier of the new participant. */
  userId: string;

  /** The display name to record for this participant. */
  displayName: string;

  /** Optional avatar URL for the participant. */
  avatar?: string;

  /** The role to assign (defaults determined by caller). */
  role: ParticipantRole;
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

/**
 * Conversation repository contract.
 *
 * Abstracts all persistence operations for conversations, participants,
 * and per-user conversation settings. The concrete implementation uses
 * Prisma; this interface ensures no Prisma types leak into the service
 * layer (R16, R17).
 *
 * Method categories:
 * 1. **CRUD** — `create`, `findById`, `findByUserId`, `findDirectConversation`
 * 2. **Membership** — `addParticipant`, `removeParticipant`, `updateParticipantRole`
 * 3. **Settings** — `updateParticipantSettings`, `updateGroupDetails`
 * 4. **Queries** — `getParticipantIds`, `isParticipant`
 * 5. **Unread tracking** — `getUnreadCounts`, `resetUnreadCount`, `incrementUnreadCount`
 */
export interface IConversationRepository {
  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  /**
   * Create a new conversation (DIRECT or GROUP) with initial participants.
   *
   * For DIRECT conversations the repository ensures exactly two participants
   * are persisted. For GROUP conversations at least one participant must
   * have the ADMIN role.
   *
   * @param data - {@link CreateConversationData} with type, participants,
   *               and optional group metadata.
   * @returns The fully-hydrated {@link ConversationResponse} including
   *          participant details and timestamps.
   */
  create(data: CreateConversationData): Promise<ConversationResponse>;

  /**
   * Find a conversation by its unique identifier.
   *
   * The returned object includes all participants, the most recent
   * message preview, per-user settings, and timestamps.
   *
   * @param id - The conversation's unique identifier.
   * @returns The {@link ConversationResponse}, or `null` if the
   *          conversation does not exist.
   */
  findById(id: string): Promise<ConversationResponse | null>;

  /**
   * Retrieve all conversations for a specific user with cursor-based
   * pagination, ordered by the most recent message timestamp (descending).
   *
   * Leverages the composite index on `userId + conversationId` in the
   * `ConversationParticipant` table for performant look-ups.
   *
   * @param userId  - The user whose conversations to list.
   * @param options - Optional pagination and filter parameters.
   * @param options.cursor         - Opaque cursor for pagination; omit for
   *                                  the first page.
   * @param options.limit          - Maximum items per page (implementation
   *                                  should enforce a sensible default).
   * @param options.includeArchived - When `true`, archived conversations
   *                                  are included in the results.
   * @returns A page of {@link ConversationListItem} entries with an opaque
   *          `cursor` for the next page and a `hasMore` flag.
   */
  findByUserId(
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
  }>;

  /**
   * Find an existing DIRECT conversation between two specific users.
   *
   * Used to prevent creating duplicate 1:1 conversations — if a DIRECT
   * conversation already exists between the two users, the service layer
   * should return it instead of creating a new one.
   *
   * @param userId1 - First user's unique identifier.
   * @param userId2 - Second user's unique identifier.
   * @returns The {@link ConversationResponse} if a DIRECT conversation
   *          exists, otherwise `null`.
   */
  findDirectConversation(
    userId1: string,
    userId2: string,
  ): Promise<ConversationResponse | null>;

  // -------------------------------------------------------------------------
  // Membership management
  // -------------------------------------------------------------------------

  /**
   * Add a participant to a GROUP conversation.
   *
   * Only applies to GROUP conversations — DIRECT conversations always
   * have exactly two members. Uses the composite index on
   * `userId + conversationId` for efficient duplicate checking.
   *
   * The service layer is responsible for triggering Sender Key
   * redistribution (R14) after this call succeeds.
   *
   * @param conversationId - The conversation to add the participant to.
   * @param participant    - {@link AddParticipantData} with userId, display
   *                         name, optional avatar, and role.
   * @returns The updated {@link ConversationResponse} including the new
   *          participant.
   */
  addParticipant(
    conversationId: string,
    participant: AddParticipantData,
  ): Promise<ConversationResponse>;

  /**
   * Remove a participant from a GROUP conversation.
   *
   * Only applies to GROUP conversations. The service layer is responsible
   * for triggering Sender Key rotation (R14) after this call succeeds,
   * ensuring the removed member cannot decrypt future messages.
   *
   * @param conversationId - The conversation to remove the participant from.
   * @param userId         - The unique identifier of the user to remove.
   * @returns The updated {@link ConversationResponse} without the removed
   *          participant.
   */
  removeParticipant(
    conversationId: string,
    userId: string,
  ): Promise<ConversationResponse>;

  /**
   * Update a participant's role within a GROUP conversation.
   *
   * Used for promoting a MEMBER to ADMIN or demoting an ADMIN to MEMBER.
   *
   * @param conversationId - The conversation identifier.
   * @param userId         - The user whose role should change.
   * @param role           - The new {@link ParticipantRole} to assign.
   * @returns The updated {@link ConversationResponse}.
   */
  updateParticipantRole(
    conversationId: string,
    userId: string,
    role: ParticipantRole,
  ): Promise<ConversationResponse>;

  // -------------------------------------------------------------------------
  // Per-user settings
  // -------------------------------------------------------------------------

  /**
   * Update per-user conversation settings (archive / mute).
   *
   * These settings are stored on the `ConversationParticipant` join table,
   * so each user can independently archive or mute a conversation without
   * affecting other members.
   *
   * @param conversationId - The conversation identifier.
   * @param userId         - The user whose settings should be updated.
   * @param settings       - {@link ParticipantSettings} fields to change.
   * @returns The updated {@link ConversationResponse} reflecting the new
   *          settings for this user.
   */
  updateParticipantSettings(
    conversationId: string,
    userId: string,
    settings: ParticipantSettings,
  ): Promise<ConversationResponse>;

  /**
   * Update group-level conversation details (name and / or avatar).
   *
   * Only applicable to GROUP conversations. The service layer should
   * verify the caller has the ADMIN role before invoking this method.
   *
   * @param conversationId - The conversation identifier.
   * @param data           - Fields to update; omitted fields are unchanged.
   * @param data.groupName   - New group display name.
   * @param data.groupAvatar - New group avatar URL.
   * @returns The updated {@link ConversationResponse}.
   */
  updateGroupDetails(
    conversationId: string,
    data: { groupName?: string; groupAvatar?: string },
  ): Promise<ConversationResponse>;

  // -------------------------------------------------------------------------
  // Participant queries
  // -------------------------------------------------------------------------

  /**
   * Retrieve the user IDs of all participants in a conversation.
   *
   * Used by the service layer for:
   * - Message fan-out to determine recipients (R18).
   * - Sender Key distribution to know which users need new keys (R14).
   *
   * @param conversationId - The conversation identifier.
   * @returns An array of participant user ID strings.
   */
  getParticipantIds(conversationId: string): Promise<string[]>;

  /**
   * Check whether a user is a participant in a conversation.
   *
   * Used for authorisation checks before allowing message operations,
   * settings updates, and other conversation-scoped actions.
   *
   * @param conversationId - The conversation identifier.
   * @param userId         - The user to check.
   * @returns `true` if the user is a current participant; `false` otherwise.
   */
  isParticipant(conversationId: string, userId: string): Promise<boolean>;

  // -------------------------------------------------------------------------
  // Unread count tracking
  // -------------------------------------------------------------------------

  /**
   * Get the unread message counts for a user across **all** their
   * conversations.
   *
   * Returns a map where each key is a conversation ID and each value
   * is the number of unread messages. Conversations with zero unread
   * messages may be omitted from the result.
   *
   * Used for badge count rendering on the chat list UI.
   *
   * @param userId - The user whose unread counts to retrieve.
   * @returns A record mapping conversation IDs to unread counts.
   */
  getUnreadCounts(userId: string): Promise<Record<string, number>>;

  /**
   * Reset the unread message count for a user in a specific conversation
   * back to zero.
   *
   * Called when the user opens a conversation and reads all messages,
   * clearing the badge count for that conversation.
   *
   * @param conversationId - The conversation whose count should be reset.
   * @param userId         - The user for whom to reset the count.
   */
  resetUnreadCount(conversationId: string, userId: string): Promise<void>;

  /**
   * Increment the unread message count for **all** participants in a
   * conversation except the sender.
   *
   * Called when a new message is persisted so that each non-sender
   * participant sees an updated badge count.
   *
   * @param conversationId - The conversation that received a new message.
   * @param senderUserId   - The sender's user ID (excluded from increment).
   */
  incrementUnreadCount(
    conversationId: string,
    senderUserId: string,
  ): Promise<void>;
}
