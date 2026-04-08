/**
 * @module apps/api/src/domain/models/Conversation
 *
 * Conversation domain model implementing type management (DIRECT vs GROUP),
 * membership invariants, participant management with role assignment,
 * authorization checks, and archive/mute/pin state transitions.
 *
 * Enforces that DIRECT conversations have exactly 2 participants and
 * GROUP conversations have at least 2. Membership changes are tracked
 * to drive Sender Key rotation (R14) and fan-out decisions (R18).
 *
 * Architecture rules enforced:
 * - R16 (OOD Layering): Business logic encapsulated in methods, not anemic data bags
 * - R17 (Interface-Driven): Zero Prisma imports — ORM-agnostic pure TypeScript
 * - R14 (Group Encryption): Membership invariants drive Sender Key rotation
 * - R18 (Fan-Out via Queue): needsFanOut() enables BullMQ queue decision
 * - R7 (Zero Warnings): TypeScript strict mode compatible with zero warnings
 * - R28 (Structured Logging): Zero direct stdout/stderr logging calls
 */

import { randomUUID } from 'node:crypto';

import { ConversationType, ParticipantRole } from '@kalle/shared/types/conversation';
import type {
  ConversationResponse,
  ConversationParticipant,
  MuteSettings,
} from '@kalle/shared/types/conversation';

// =============================================================================
// Interfaces
// =============================================================================

/**
 * Internal representation of a participant within a conversation.
 *
 * Dates are stored as native `Date` objects for domain logic operations.
 * Serialisation to ISO 8601 strings happens in `toResponse()`.
 */
export interface Participant {
  /** Unique user identifier. */
  userId: string;
  /** User's display name. */
  displayName: string;
  /** User's avatar URL, if set. */
  avatar?: string;
  /** The participant's role in this conversation. */
  role: ParticipantRole;
  /** When the user joined the conversation. */
  joinedAt: Date;
}

/**
 * Per-user mute configuration for a conversation.
 *
 * Supports both timed mutes (expire at a specific date) and indefinite
 * mutes (`muteExpiresAt` is `null`).
 */
export interface MuteConfig {
  /** Whether the conversation is currently muted. */
  isMuted: boolean;
  /**
   * When the mute expires.
   * - `Date`: mute expires at this timestamp.
   * - `null`: muted indefinitely (no automatic unmute).
   * - `undefined`: not applicable (conversation is not muted).
   */
  muteExpiresAt?: Date | null;
}

/**
 * Constructor properties for hydrating a `Conversation` instance.
 *
 * Used both by static factory methods (`createDirect`, `createGroup`)
 * and by the repository layer when reconstructing from persisted data.
 */
export interface ConversationProps {
  /** Unique conversation identifier. */
  id: string;
  /** Whether this is a 1:1 or group conversation. */
  type: ConversationType;
  /** Display name for GROUP conversations; `undefined` for DIRECT. */
  groupName?: string;
  /** Avatar URL for GROUP conversations; `undefined` for DIRECT. */
  groupAvatar?: string;
  /** All participants in this conversation with their roles. */
  participants: Participant[];
  /** Whether the conversation is archived for the current user. */
  isArchived: boolean;
  /** Per-user mute configuration. */
  muteConfig: MuteConfig;
  /** ISO timestamp of when the conversation was pinned; `undefined` if not pinned. */
  pinnedAt?: Date;
  /** When the conversation was created. */
  createdAt: Date;
  /** When the conversation was last updated. */
  updatedAt: Date;
}

// =============================================================================
// Conversation Domain Model
// =============================================================================

/**
 * Rich domain model for conversations (1:1 and group).
 *
 * Encapsulates all business logic for participant management, state
 * transitions, authorization checks, and serialization. This class
 * contains ZERO database or I/O dependencies — it is a pure in-memory
 * representation of a conversation aggregate.
 *
 * Use the static factory methods `createDirect()` and `createGroup()`
 * for creating new conversations with full validation, or the public
 * constructor for hydrating from persisted data.
 */
export class Conversation {
  // ---------------------------------------------------------------------------
  // Private fields
  // ---------------------------------------------------------------------------

  /** Immutable conversation identifier. */
  private readonly _id: string;
  /** Immutable conversation type (DIRECT or GROUP). */
  private readonly _type: ConversationType;
  /** Immutable creation timestamp. */
  private readonly _createdAt: Date;

  /** Mutable group display name (GROUP only). */
  private _groupName?: string;
  /** Mutable group avatar URL (GROUP only). */
  private _groupAvatar?: string;
  /** Mutable participants array. */
  private _participants: Participant[];
  /** Mutable archive state. */
  private _isArchived: boolean;
  /** Mutable mute configuration. */
  private _muteConfig: MuteConfig;
  /** Mutable pin timestamp; `undefined` when not pinned. */
  private _pinnedAt?: Date;
  /** Mutable last-update timestamp. */
  private _updatedAt: Date;

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * Constructs a Conversation from raw properties.
   *
   * For creating **new** conversations prefer the static factory methods
   * `createDirect()` and `createGroup()` which include validation.
   * The public constructor is intended for hydrating from persisted data.
   */
  constructor(props: ConversationProps) {
    this._id = props.id;
    this._type = props.type;
    this._groupName = props.groupName;
    this._groupAvatar = props.groupAvatar;
    this._participants = [...props.participants];
    this._isArchived = props.isArchived;
    this._muteConfig = { ...props.muteConfig };
    this._pinnedAt = props.pinnedAt;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  // ---------------------------------------------------------------------------
  // Getter Accessors
  // ---------------------------------------------------------------------------

  /** Unique conversation identifier. */
  get id(): string {
    return this._id;
  }

  /** Whether this is a 1:1 or group conversation. */
  get type(): ConversationType {
    return this._type;
  }

  /** Display name for GROUP conversations; `undefined` for DIRECT. */
  get groupName(): string | undefined {
    return this._groupName;
  }

  /** Avatar URL for GROUP conversations; `undefined` for DIRECT. */
  get groupAvatar(): string | undefined {
    return this._groupAvatar;
  }

  /** All participants in this conversation (defensive copy). */
  get participants(): Participant[] {
    return [...this._participants];
  }

  /** Whether the conversation is archived for the current user. */
  get isArchived(): boolean {
    return this._isArchived;
  }

  /** Per-user mute configuration (defensive copy). */
  get muteConfig(): MuteConfig {
    return { ...this._muteConfig };
  }

  /** Timestamp of when the conversation was pinned; `undefined` if not. */
  get pinnedAt(): Date | undefined {
    return this._pinnedAt;
  }

  /** When the conversation was created. */
  get createdAt(): Date {
    return this._createdAt;
  }

  /** When the conversation was last updated. */
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---------------------------------------------------------------------------
  // Static Factory Methods
  // ---------------------------------------------------------------------------

  /**
   * Creates a new DIRECT (1:1) conversation.
   *
   * Enforces:
   * - Exactly 2 participants provided.
   * - The two participant user IDs are different.
   * - Both participants are assigned role `MEMBER` (no admin concept in DIRECT).
   *
   * @param dto - Creation parameters with exactly two participant descriptors.
   * @returns A new `Conversation` instance of type DIRECT.
   * @throws {Error} If validation fails.
   */
  static createDirect(dto: {
    id?: string;
    participantIds: [
      { userId: string; displayName: string; avatar?: string },
      { userId: string; displayName: string; avatar?: string },
    ];
  }): Conversation {
    if (dto.participantIds.length !== 2) {
      throw new Error(
        `Direct conversation requires exactly 2 participants, received ${dto.participantIds.length}`,
      );
    }

    const [p1, p2] = dto.participantIds;
    if (p1.userId === p2.userId) {
      throw new Error(
        'Direct conversation requires two different participants',
      );
    }

    const now = new Date();
    const participants: Participant[] = dto.participantIds.map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      avatar: p.avatar,
      role: ParticipantRole.MEMBER,
      joinedAt: now,
    }));

    return new Conversation({
      id: dto.id ?? randomUUID(),
      type: ConversationType.DIRECT,
      participants,
      isArchived: false,
      muteConfig: { isMuted: false },
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Creates a new GROUP conversation.
   *
   * Enforces:
   * - `groupName` is non-empty.
   * - At least 2 participants (including the creator).
   * - `creatorUserId` is present in the participants list.
   * - Creator is assigned role `ADMIN`; all others `MEMBER`.
   *
   * @param dto - Creation parameters including group name and participant list.
   * @returns A new `Conversation` instance of type GROUP.
   * @throws {Error} If validation fails.
   */
  static createGroup(dto: {
    id?: string;
    groupName: string;
    groupAvatar?: string;
    creatorUserId: string;
    participants: Array<{ userId: string; displayName: string; avatar?: string }>;
  }): Conversation {
    if (!dto.groupName || dto.groupName.trim().length === 0) {
      throw new Error('Group name cannot be empty');
    }

    if (dto.participants.length < 2) {
      throw new Error(
        `Group conversation requires at least 2 participants, received ${dto.participants.length}`,
      );
    }

    const creatorFound = dto.participants.some(
      (p) => p.userId === dto.creatorUserId,
    );
    if (!creatorFound) {
      throw new Error(
        'Creator must be included in the participants list',
      );
    }

    const now = new Date();
    const participants: Participant[] = dto.participants.map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      avatar: p.avatar,
      role:
        p.userId === dto.creatorUserId
          ? ParticipantRole.ADMIN
          : ParticipantRole.MEMBER,
      joinedAt: now,
    }));

    return new Conversation({
      id: dto.id ?? randomUUID(),
      type: ConversationType.GROUP,
      groupName: dto.groupName.trim(),
      groupAvatar: dto.groupAvatar,
      participants,
      isArchived: false,
      muteConfig: { isMuted: false },
      createdAt: now,
      updatedAt: now,
    });
  }

  // ---------------------------------------------------------------------------
  // Membership Management Methods
  // ---------------------------------------------------------------------------

  /**
   * Adds a participant to a GROUP conversation.
   *
   * After calling this method the service layer should trigger Sender Key
   * redistribution (R14) so the new member receives current group keys.
   *
   * @param participant - User descriptor with optional role (defaults to MEMBER).
   * @throws {Error} If called on a DIRECT conversation or if the user is
   *                  already a participant.
   */
  addParticipant(participant: {
    userId: string;
    displayName: string;
    avatar?: string;
    role?: ParticipantRole;
  }): void {
    if (this._type === ConversationType.DIRECT) {
      throw new Error('Cannot add participants to a direct conversation');
    }

    if (this._participants.some((p) => p.userId === participant.userId)) {
      throw new Error('User is already a participant');
    }

    this._participants.push({
      userId: participant.userId,
      displayName: participant.displayName,
      avatar: participant.avatar,
      role: participant.role ?? ParticipantRole.MEMBER,
      joinedAt: new Date(),
    });

    this._updatedAt = new Date();
  }

  /**
   * Removes a participant from a GROUP conversation.
   *
   * After calling this method the service layer should trigger Sender Key
   * rotation (R14) so the removed member cannot decrypt post-removal messages.
   *
   * @param userId - The ID of the user to remove.
   * @throws {Error} If called on a DIRECT conversation or if the user is not
   *                  a participant.
   */
  removeParticipant(userId: string): void {
    if (this._type === ConversationType.DIRECT) {
      throw new Error('Cannot remove participants from a direct conversation');
    }

    const index = this._participants.findIndex((p) => p.userId === userId);
    if (index === -1) {
      throw new Error('User is not a participant');
    }

    this._participants.splice(index, 1);
    this._updatedAt = new Date();
  }

  /**
   * Checks whether a user has ADMIN role in a GROUP conversation.
   *
   * @param userId - The user to check.
   * @returns `true` if the user is an admin of this GROUP conversation;
   *          `false` for DIRECT conversations or non-participants.
   */
  isGroupAdmin(userId: string): boolean {
    if (this._type === ConversationType.DIRECT) {
      return false;
    }

    const participant = this._participants.find((p) => p.userId === userId);
    return participant?.role === ParticipantRole.ADMIN;
  }

  /**
   * Promotes a GROUP participant to ADMIN role.
   *
   * @param userId - The user to promote.
   * @throws {Error} If called on a DIRECT conversation or if the user is not
   *                  a participant.
   */
  promoteToAdmin(userId: string): void {
    if (this._type === ConversationType.DIRECT) {
      throw new Error('Cannot promote participants in a direct conversation');
    }

    const participant = this._participants.find((p) => p.userId === userId);
    if (!participant) {
      throw new Error('User is not a participant');
    }

    participant.role = ParticipantRole.ADMIN;
    this._updatedAt = new Date();
  }

  /**
   * Demotes a GROUP participant from ADMIN to MEMBER role.
   *
   * Ensures at least one other ADMIN remains — a group cannot be left
   * without any administrator.
   *
   * @param userId - The user to demote.
   * @throws {Error} If called on a DIRECT conversation, user is not found,
   *                  or this is the last admin.
   */
  demoteToMember(userId: string): void {
    if (this._type === ConversationType.DIRECT) {
      throw new Error('Cannot demote participants in a direct conversation');
    }

    const participant = this._participants.find((p) => p.userId === userId);
    if (!participant) {
      throw new Error('User is not a participant');
    }

    const adminCount = this._participants.filter(
      (p) => p.role === ParticipantRole.ADMIN,
    ).length;

    if (participant.role === ParticipantRole.ADMIN && adminCount <= 1) {
      throw new Error(
        'Cannot demote the last admin — promote another member first',
      );
    }

    participant.role = ParticipantRole.MEMBER;
    this._updatedAt = new Date();
  }

  /**
   * Finds a participant by user ID.
   *
   * @param userId - The user to look up.
   * @returns The `Participant` if found, otherwise `undefined`.
   */
  getParticipant(userId: string): Participant | undefined {
    return this._participants.find((p) => p.userId === userId);
  }

  /**
   * Checks whether a user is a participant in this conversation.
   *
   * @param userId - The user to check.
   * @returns `true` if the user is a participant.
   */
  isParticipant(userId: string): boolean {
    return this._participants.some((p) => p.userId === userId);
  }

  /**
   * Returns the total number of participants.
   */
  getParticipantCount(): number {
    return this._participants.length;
  }

  /**
   * Returns a defensive copy of all participants.
   */
  getParticipants(): Participant[] {
    return [...this._participants];
  }

  /**
   * Returns participants with ADMIN role (empty array for DIRECT conversations).
   */
  getAdmins(): Participant[] {
    return this._participants.filter((p) => p.role === ParticipantRole.ADMIN);
  }

  // ---------------------------------------------------------------------------
  // State Transition Methods
  // ---------------------------------------------------------------------------

  /** Archives the conversation for the current user. */
  archive(): void {
    this._isArchived = true;
    this._updatedAt = new Date();
  }

  /** Unarchives the conversation for the current user. */
  unarchive(): void {
    this._isArchived = false;
    this._updatedAt = new Date();
  }

  /**
   * Mutes the conversation.
   *
   * @param expiresAt - When the mute expires.
   *   - `Date`: mute expires at this timestamp.
   *   - `null` or `undefined`: muted indefinitely.
   */
  mute(expiresAt?: Date | null): void {
    this._muteConfig = {
      isMuted: true,
      muteExpiresAt: expiresAt === undefined ? null : expiresAt,
    };
    this._updatedAt = new Date();
  }

  /** Unmutes the conversation. */
  unmute(): void {
    this._muteConfig = {
      isMuted: false,
      muteExpiresAt: null,
    };
    this._updatedAt = new Date();
  }

  /**
   * Checks whether the conversation is currently muted.
   *
   * If the mute has expired, this method auto-unmutes and returns `false`.
   *
   * @param now - Optional current time for testability.
   * @returns `true` if the conversation is muted.
   */
  isMuted(now?: Date): boolean {
    if (!this._muteConfig.isMuted) {
      return false;
    }

    // Muted indefinitely (no expiration).
    if (
      this._muteConfig.muteExpiresAt === null ||
      this._muteConfig.muteExpiresAt === undefined
    ) {
      return true;
    }

    // Check expiration.
    const currentTime = now ?? new Date();
    if (currentTime >= this._muteConfig.muteExpiresAt) {
      // Auto-unmute on expiry.
      this._muteConfig.isMuted = false;
      this._muteConfig.muteExpiresAt = null;
      return false;
    }

    return true;
  }

  /** Pins the conversation. */
  pin(): void {
    this._pinnedAt = new Date();
    this._updatedAt = new Date();
  }

  /** Unpins the conversation. */
  unpin(): void {
    this._pinnedAt = undefined;
    this._updatedAt = new Date();
  }

  /** Returns `true` if the conversation is currently pinned. */
  isPinned(): boolean {
    return this._pinnedAt !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Group Property Updates
  // ---------------------------------------------------------------------------

  /**
   * Updates the display name of a GROUP conversation.
   *
   * @param name - New group name (must be non-empty).
   * @throws {Error} If called on a DIRECT conversation or if name is empty.
   */
  updateGroupName(name: string): void {
    if (this._type === ConversationType.DIRECT) {
      throw new Error('Cannot set group name on direct conversation');
    }

    if (!name || name.trim().length === 0) {
      throw new Error('Group name cannot be empty');
    }

    this._groupName = name.trim();
    this._updatedAt = new Date();
  }

  /**
   * Updates the avatar URL of a GROUP conversation.
   *
   * @param avatar - New avatar URL.
   * @throws {Error} If called on a DIRECT conversation.
   */
  updateGroupAvatar(avatar: string): void {
    if (this._type === ConversationType.DIRECT) {
      throw new Error('Cannot set group avatar on direct conversation');
    }

    this._groupAvatar = avatar;
    this._updatedAt = new Date();
  }

  // ---------------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------------

  /** Returns `true` if this is a GROUP conversation. */
  isGroup(): boolean {
    return this._type === ConversationType.GROUP;
  }

  /** Returns `true` if this is a DIRECT (1:1) conversation. */
  isDirect(): boolean {
    return this._type === ConversationType.DIRECT;
  }

  /**
   * Determines whether message delivery should be fan-out via BullMQ (R18).
   *
   * Group messages with 3+ recipients are enqueued for asynchronous delivery
   * rather than delivered inline.
   *
   * @returns `true` if the conversation has 3 or more participants.
   */
  needsFanOut(): boolean {
    return this.getParticipantCount() >= 3;
  }

  /**
   * For DIRECT conversations, returns the other participant.
   *
   * @param currentUserId - The current user's ID.
   * @returns The other `Participant`, or `undefined` for GROUP conversations
   *          or if the current user is not found.
   */
  getOtherParticipant(currentUserId: string): Participant | undefined {
    if (this._type !== ConversationType.DIRECT) {
      return undefined;
    }

    return this._participants.find((p) => p.userId !== currentUserId);
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /**
   * Converts this domain model to a plain API response object matching
   * `ConversationResponse` from `@kalle/shared`.
   *
   * Date fields are serialized to ISO 8601 strings. `unreadCount` is
   * initialized to `0` — the caller (service/controller layer) should
   * override it with the actual value from the persistence layer.
   *
   * @param currentUserId - Optional user ID used to resolve display name
   *                        for DIRECT conversations.
   * @returns A plain `ConversationResponse` object.
   */
  toResponse(currentUserId?: string): ConversationResponse {
    const muteSettings: MuteSettings = {
      isMuted: this._muteConfig.isMuted,
      muteExpiresAt:
        this._muteConfig.muteExpiresAt instanceof Date
          ? this._muteConfig.muteExpiresAt.toISOString()
          : this._muteConfig.muteExpiresAt ?? undefined,
    };

    const participants: ConversationParticipant[] = this._participants.map(
      (p) => ({
        userId: p.userId,
        displayName: p.displayName,
        avatar: p.avatar,
        role: p.role,
        joinedAt: p.joinedAt.toISOString(),
      }),
    );

    // Resolve display name for DIRECT conversations from other participant.
    let resolvedGroupName = this._groupName;
    if (
      this._type === ConversationType.DIRECT &&
      currentUserId &&
      !resolvedGroupName
    ) {
      const other = this._participants.find(
        (p) => p.userId !== currentUserId,
      );
      if (other) {
        resolvedGroupName = other.displayName;
      }
    }

    return {
      id: this._id,
      type: this._type,
      groupName: resolvedGroupName,
      groupAvatar: this._groupAvatar,
      participants,
      unreadCount: 0,
      isArchived: this._isArchived,
      muteSettings,
      pinnedAt: this._pinnedAt?.toISOString(),
      createdAt: this._createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
    };
  }
}
