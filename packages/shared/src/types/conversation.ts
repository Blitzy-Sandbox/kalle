/**
 * @module @kalle/shared/types/conversation
 *
 * Conversation domain types, DTOs, enums, and interfaces for the Kalle
 * WhatsApp-clone monorepo.
 *
 * Conversations can be either 1:1 (DIRECT) or group chats (GROUP).
 * Group conversations support membership management, admin roles,
 * archive/unarchive, and mute/unmute functionality.
 *
 * Key design decisions:
 * - All date/time fields use ISO 8601 string representation for
 *   JSON serialisation safety across the wire.
 * - `lastMessage.ciphertext` is the E2E-encrypted payload (R12) —
 *   the server never sees plaintext message content.
 * - `MuteSettings.muteExpiresAt` being `null` represents an
 *   indefinite mute; `undefined` means "not muted".
 * - `ConversationListItem` is a lightweight projection optimised
 *   for the chat list UI (Figma Screen 1 — WhatsApp Chats).
 *
 * This file contains ZERO runtime code — only TypeScript types,
 * interfaces, and enums.
 *
 * @see AAP Section 0.2.3, 0.1.1, 0.4.5
 * @see Rules R12 (E2E encryption), R14 (Sender Keys), R18 (fan-out)
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Distinguishes 1:1 (direct) conversations from group conversations.
 *
 * - `DIRECT` — exactly two participants; cannot have a group name/avatar.
 * - `GROUP`  — two or more participants; supports admin roles, group name,
 *   and group avatar. Sender Key distribution (R14) applies to GROUP.
 */
export enum ConversationType {
  /** One-to-one conversation between exactly two users. */
  DIRECT = 'DIRECT',
  /** Group conversation with two or more participants. */
  GROUP = 'GROUP',
}

/**
 * Roles a user can hold within a group conversation.
 *
 * - `ADMIN`  — can add/remove members, change group name/avatar,
 *   and promote other members to admin.
 * - `MEMBER` — standard participant; can send messages and view
 *   conversation metadata but cannot manage membership.
 */
export enum ParticipantRole {
  /** Group administrator with management privileges. */
  ADMIN = 'ADMIN',
  /** Standard group member. */
  MEMBER = 'MEMBER',
}

// ---------------------------------------------------------------------------
// DTOs — request payloads
// ---------------------------------------------------------------------------

/**
 * Payload for creating a new conversation.
 *
 * For `DIRECT` conversations, `participantIds` must contain exactly
 * two user IDs (the creator is included implicitly or explicitly).
 * For `GROUP` conversations, `participantIds` must contain at least
 * two user IDs, and `groupName` is required.
 */
export interface CreateConversationDTO {
  /** The kind of conversation to create. */
  type: ConversationType;

  /**
   * User IDs to include as participants.
   * - DIRECT: exactly 2 user IDs.
   * - GROUP:  2 or more user IDs.
   */
  participantIds: string[];

  /**
   * Display name for a GROUP conversation.
   * Required when `type` is `GROUP`; ignored for `DIRECT`.
   */
  groupName?: string;

  /** Optional avatar URL for a GROUP conversation. */
  groupAvatar?: string;
}

/**
 * Payload for updating a conversation's per-user settings or
 * group-level properties.
 *
 * All fields are optional — include only the fields that should change.
 * For per-user settings (`isArchived`, `isMuted`, `muteExpiresAt`) the
 * change applies to the requesting user only.
 * For group properties (`groupName`, `groupAvatar`) the caller must be
 * an ADMIN.
 */
export interface UpdateConversationDTO {
  /** Set `true` to archive, `false` to unarchive. */
  isArchived?: boolean;

  /** Set `true` to mute, `false` to unmute. */
  isMuted?: boolean;

  /**
   * When muted, specifies when the mute expires.
   * - ISO 8601 string: muted until this timestamp.
   * - `null`: muted indefinitely.
   * - `undefined` / omitted: no change.
   */
  muteExpiresAt?: string | null;

  /**
   * New display name for a GROUP conversation.
   * Only applicable when `ConversationType` is `GROUP`.
   */
  groupName?: string;

  /**
   * New avatar URL for a GROUP conversation.
   * Only applicable when `ConversationType` is `GROUP`.
   */
  groupAvatar?: string;
}

/**
 * Payload for adding a member to a group conversation.
 *
 * The caller must be an ADMIN of the group. Adding a member triggers
 * Sender Key rotation (R14) so the new member cannot decrypt
 * pre-join messages.
 */
export interface AddParticipantDTO {
  /** The ID of the user to add. */
  userId: string;

  /**
   * Role to assign. Defaults to `MEMBER` if omitted.
   */
  role?: ParticipantRole;
}

// ---------------------------------------------------------------------------
// Response / read-model types
// ---------------------------------------------------------------------------

/**
 * Mute configuration for a conversation (per-user setting).
 *
 * Supports both timed mutes (expire at a specific timestamp) and
 * indefinite mutes (`muteExpiresAt` is `null`).
 */
export interface MuteSettings {
  /** Whether the conversation is currently muted for this user. */
  isMuted: boolean;

  /**
   * When the mute expires.
   * - ISO 8601 string: mute expires at this timestamp.
   * - `null`: muted indefinitely (no automatic unmute).
   * - `undefined`: not applicable (conversation is not muted).
   */
  muteExpiresAt?: string | null;
}

/**
 * Represents a user's membership within a conversation.
 *
 * Includes presence information (`isOnline`, `lastSeen`) which is
 * populated from the real-time presence layer — these fields may
 * be absent if presence data is unavailable.
 */
export interface ConversationParticipant {
  /** Unique user identifier. */
  userId: string;

  /** User's display name. */
  displayName: string;

  /** User's avatar URL, if set. */
  avatar?: string;

  /** The participant's role in this conversation. */
  role: ParticipantRole;

  /** ISO 8601 timestamp of when the user joined the conversation. */
  joinedAt: string;

  /**
   * Whether the participant is currently online.
   * Populated from real-time presence data; may be `undefined`
   * if presence information is unavailable.
   */
  isOnline?: boolean;

  /**
   * ISO 8601 timestamp of the participant's last activity.
   * Present only when the user is offline.
   */
  lastSeen?: string;
}

/**
 * Full conversation representation returned from the API.
 *
 * Contains the complete set of conversation metadata including
 * participant list, last message preview, per-user archive/mute
 * settings, and timestamps.
 *
 * `lastMessage.ciphertext` holds the E2E-encrypted payload (R12).
 * The server stores only ciphertext — decryption happens client-side.
 */
export interface ConversationResponse {
  /** Unique conversation identifier. */
  id: string;

  /** Whether this is a 1:1 or group conversation. */
  type: ConversationType;

  /**
   * Display name for GROUP conversations.
   * `undefined` for DIRECT conversations.
   */
  groupName?: string;

  /**
   * Avatar URL for GROUP conversations.
   * `undefined` for DIRECT conversations.
   */
  groupAvatar?: string;

  /** All participants in this conversation with their roles and presence. */
  participants: ConversationParticipant[];

  /**
   * Most recent message in the conversation.
   * Used for chat list preview rendering (Figma Screen 1).
   * May be `undefined` if the conversation has no messages yet.
   */
  lastMessage?: {
    /** Unique message identifier. */
    id: string;
    /** ID of the user who sent this message. */
    senderId: string;
    /** Display name of the sender. */
    senderName: string;
    /**
     * E2E-encrypted message content (R12).
     * `null` when the message has been deleted (tombstone — R20).
     */
    ciphertext: string | null;
    /** Message content type (maps to MessageType enum value). */
    type: string;
    /** ISO 8601 server-assigned timestamp for ordering (R4). */
    serverTimestamp: string;
    /** Whether the message has been soft-deleted (R20). */
    isDeleted: boolean;
  };

  /**
   * Number of unread messages for the current (requesting) user.
   * Used for badge rendering in the chat list UI.
   */
  unreadCount: number;

  /** Whether the conversation is archived for the current user. */
  isArchived: boolean;

  /** Mute configuration for the current user. */
  muteSettings: MuteSettings;

  /**
   * ISO 8601 timestamp of when the conversation was pinned.
   * `undefined` if the conversation is not pinned.
   */
  pinnedAt?: string;

  /** ISO 8601 timestamp of conversation creation. */
  createdAt: string;

  /** ISO 8601 timestamp of last conversation update. */
  updatedAt: string;
}

/**
 * Lightweight conversation projection optimised for the chat list UI
 * (Figma Screen 1 — WhatsApp Chats).
 *
 * Unlike `ConversationResponse`, this omits the full participant list
 * and resolves the "other user" or "group" display information into
 * flat `displayName` and `avatar` fields for efficient rendering.
 */
export interface ConversationListItem {
  /** Unique conversation identifier. */
  id: string;

  /** Whether this is a 1:1 or group conversation. */
  type: ConversationType;

  /**
   * Resolved display name:
   * - DIRECT: the other participant's display name.
   * - GROUP:  the group name.
   */
  displayName: string;

  /**
   * Resolved avatar URL:
   * - DIRECT: the other participant's avatar.
   * - GROUP:  the group avatar.
   */
  avatar?: string;

  /**
   * Most recent message preview.
   * May be `undefined` if the conversation has no messages yet.
   */
  lastMessage?: {
    /** Display name of the message sender. */
    senderName: string;
    /**
     * E2E-encrypted message content (R12).
     * `null` when the message has been deleted (tombstone — R20).
     */
    ciphertext: string | null;
    /** Message content type (maps to MessageType enum value). */
    type: string;
    /** ISO 8601 server-assigned timestamp for ordering. */
    serverTimestamp: string;
    /** Whether the message has been soft-deleted (R20). */
    isDeleted: boolean;
  };

  /**
   * Number of unread messages for the current user.
   * Used for badge rendering.
   */
  unreadCount: number;

  /** Whether the conversation is archived for the current user. */
  isArchived: boolean;

  /** Whether the conversation is muted for the current user. */
  isMuted: boolean;

  /**
   * For DIRECT conversations: whether the other user is online.
   * For GROUP conversations: `undefined`.
   */
  isOnline?: boolean;

  /**
   * For DIRECT conversations: ISO 8601 last-seen timestamp of the other user.
   * For GROUP conversations: `undefined`.
   */
  lastSeen?: string;
}
