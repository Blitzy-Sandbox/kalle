/**
 * @module apps/api/src/repositories/MessageRepository
 *
 * Prisma-backed implementation of the IMessageRepository interface.
 * Handles persistence of encrypted messages including creation, ciphertext-swap
 * edits (R19), soft-delete tombstones (R20), cursor-paginated history,
 * offline sync, and status tracking (sent/delivered/read).
 *
 * Architecture rules enforced:
 * - R12: Server stores ONLY ciphertext — zero decryption logic in this file.
 * - R16: Zero business logic — persistence and data mapping only.
 *        Edit window (R19) and sender-only authorization checked by service layer.
 * - R17: Implements IMessageRepository interface (interface-driven DI).
 *        PrismaClient injected via constructor — no hard-coded instantiation.
 * - R19: Edit = ciphertext swap (isEdited flag set, editedAt timestamp recorded).
 * - R20: Delete = tombstone (ciphertext nulled to null, row retained in DB).
 * - R23: NEVER logs ciphertext, message content, or encryption material.
 * - R28: Zero console.log — structured Pino logging at service layer.
 * - R7:  TypeScript strict mode, zero warnings.
 * - R4:  Messages ordered by serverTimestamp for consistent total ordering.
 * - R13: findAfterTimestamp supports offline-to-online reconciliation.
 *
 * Prisma indexes leveraged for performance:
 * - @@index([conversationId, serverTimestamp]) — conversation history + sync
 * - @@index([conversationId, senderId])        — sender-scoped queries
 * - clientMessageId @unique                   — idempotent dedup lookup
 * - @@unique([messageId, userId]) on MessageStatus — per-recipient status upsert
 */

import type { PrismaClient } from '@prisma/client';
import type {
  IMessageRepository,
  CreateMessageData,
  UpdateMessageData,
  SoftDeleteMessageData,
  MessageQueryOptions,
} from '../domain/interfaces/IMessageRepository.js';
import {
  MessageStatusEnum,
  type MessageResponse,
  type MessageStatusUpdate,
  type LinkPreviewData,
  type MessageType,
  type ReplyToMessage,
} from '@kalle/shared';

// =============================================================================
// Internal Types — Shape of Prisma records with eagerly-loaded relations
// =============================================================================

/**
 * Shape of a Prisma Message record after inclusion of sender, replyTo,
 * statuses, and media relations. Used internally by the mapper to
 * produce MessageResponse DTOs without leaking Prisma-generated types
 * beyond this module.
 */
interface MessageRecord {
  id: string;
  conversationId: string;
  senderId: string;
  clientMessageId: string | null;
  ciphertext: string | null;
  type: string;
  replyToId: string | null;
  isEdited: boolean;
  isDeleted: boolean;
  editedAt: Date | null;
  deletedAt: Date | null;
  serverTimestamp: Date;
  clientTimestamp: Date | null;
  sender?: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
  replyTo?: {
    id: string;
    senderId: string;
    ciphertext: string | null;
    type: string;
    sender?: {
      id: string;
      displayName: string;
    } | null;
  } | null;
  statuses?: Array<{
    userId: string;
    status: string;
    deliveredAt: Date | null;
    readAt: Date | null;
  }>;
  media?: Array<{
    id: string;
  }>;
}

// =============================================================================
// Prisma Include Definitions — Reused across query methods
// =============================================================================

/**
 * Full relation include used by most query and mutation methods.
 * Eagerly loads sender profile, replyTo preview, per-recipient statuses,
 * and the first media attachment ID.
 */
const FULL_MESSAGE_INCLUDE = {
  sender: {
    select: { id: true, displayName: true, avatarUrl: true },
  },
  replyTo: {
    select: {
      id: true,
      senderId: true,
      ciphertext: true,
      type: true,
      sender: { select: { id: true, displayName: true } },
    },
  },
  statuses: {
    select: { userId: true, status: true, deliveredAt: true, readAt: true },
  },
  media: {
    select: { id: true },
    take: 1,
  },
} as const;

// =============================================================================
// MessageRepository — Prisma-backed Implementation
// =============================================================================

export class MessageRepository implements IMessageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ─── Create ────────────────────────────────────────────────────────────

  /**
   * Creates a new message record with server-assigned timestamp.
   *
   * The ciphertext is stored exactly as received — zero decryption (R12).
   * If an optional pre-generated ID is provided in `data.id`, it is used
   * as the primary key; otherwise, Prisma generates a UUID v4.
   *
   * When `mediaId` is provided, the existing Media record is connected to
   * the newly created message via Prisma's nested connect write.
   *
   * @param data - CreateMessageData with ciphertext and metadata.
   * @returns The created MessageResponse with server-assigned fields.
   */
  async create(data: CreateMessageData): Promise<MessageResponse> {
    const record = await this.prisma.message.create({
      data: {
        // Use pre-generated ID if provided; otherwise Prisma generates UUID
        ...(data.id !== undefined ? { id: data.id } : {}),
        conversationId: data.conversationId,
        senderId: data.senderId,
        ciphertext: data.ciphertext, // Encrypted client-side — stored as-is (R12)
        // Cast shared MessageType to Prisma MessageType (identical string values)
        type: data.type as never,
        replyToId: data.replyToMessageId ?? null,
        clientMessageId: data.clientMessageId,
        serverTimestamp: data.serverTimestamp ?? new Date(), // Authoritative server time (R4)
        // Connect existing media attachment if provided
        ...(data.mediaId !== undefined
          ? { media: { connect: { id: data.mediaId } } }
          : {}),
      },
      include: FULL_MESSAGE_INCLUDE,
    });

    return this.mapToResponse(record as unknown as MessageRecord);
  }

  // ─── Find by ID ───────────────────────────────────────────────────────

  /**
   * Finds a message by its unique identifier.
   *
   * Returns the full message representation including sender profile,
   * reply-to preview, per-recipient statuses, and media reference.
   * Returns `null` if no message exists with the given ID.
   *
   * @param id - Message UUID.
   * @returns MessageResponse or null if not found.
   */
  async findById(id: string): Promise<MessageResponse | null> {
    const record = await this.prisma.message.findUnique({
      where: { id },
      include: FULL_MESSAGE_INCLUDE,
    });

    return record
      ? this.mapToResponse(record as unknown as MessageRecord)
      : null;
  }

  // ─── Update (Edit — R19) ──────────────────────────────────────────────

  /**
   * Updates a message — ciphertext swap for edit operation (R19).
   *
   * Replaces the stored ciphertext with the new encrypted content, sets
   * `isEdited` to `true`, and records the `editedAt` timestamp. The
   * original ciphertext is permanently overwritten — not retained.
   *
   * The 15-minute edit window and sender-only authorization are enforced
   * at the service layer, NOT here (R16: zero business logic).
   *
   * @param id - Message UUID to update.
   * @param data - UpdateMessageData with new ciphertext and edit metadata.
   * @returns The updated MessageResponse reflecting the edit.
   */
  async update(id: string, data: UpdateMessageData): Promise<MessageResponse> {
    const record = await this.prisma.message.update({
      where: { id },
      data: {
        ciphertext: data.ciphertext, // New encrypted content — R19 ciphertext swap
        isEdited: data.isEdited,
        editedAt: data.editedAt,
      },
      include: FULL_MESSAGE_INCLUDE,
    });

    return this.mapToResponse(record as unknown as MessageRecord);
  }

  // ─── Soft Delete (Tombstone — R20) ────────────────────────────────────

  /**
   * Soft-deletes a message — creates a tombstone with ciphertext nulled (R20).
   *
   * Sets `ciphertext` to `null` (the value in `data.ciphertext` is always `null`),
   * marks `isDeleted` as `true`, and records the `deletedAt` timestamp.
   * The message row is retained in the database — it is NEVER physically deleted.
   * All conversation participants render "This message was deleted."
   *
   * Sender-only authorization is enforced at the service layer.
   *
   * @param id - Message UUID to soft-delete.
   * @param data - SoftDeleteMessageData with null ciphertext and deletion metadata.
   * @returns The updated MessageResponse in tombstone state.
   */
  async softDelete(
    id: string,
    data: SoftDeleteMessageData,
  ): Promise<MessageResponse> {
    const record = await this.prisma.message.update({
      where: { id },
      data: {
        ciphertext: data.ciphertext, // Explicitly null — tombstone (R20)
        isDeleted: data.isDeleted,
        deletedAt: data.deletedAt,
      },
      include: FULL_MESSAGE_INCLUDE,
    });

    return this.mapToResponse(record as unknown as MessageRecord);
  }

  // ─── Find by Conversation (Cursor-Paginated History) ──────────────────

  /**
   * Retrieves messages for a conversation with cursor-based pagination.
   *
   * Messages are returned in reverse chronological order (newest first)
   * to support the chat UI's bottom-anchored scroll. The cursor is a
   * serverTimestamp ISO string — the next page fetches messages strictly
   * older than the cursor timestamp.
   *
   * Leverages the @@index([conversationId, serverTimestamp]) composite
   * index for efficient range scans.
   *
   * @param options - MessageQueryOptions with conversationId, optional cursor, limit, before.
   * @returns Paginated result with items, optional cursor, and hasMore flag.
   */
  async findByConversation(options: MessageQueryOptions): Promise<{
    items: MessageResponse[];
    cursor?: string;
    hasMore: boolean;
  }> {
    const limit = options.limit ?? 50;
    const { conversationId } = options;

    // Build the serverTimestamp filter from cursor and/or before parameters
    // Both represent an upper bound (lt). Use the earlier (smaller) timestamp.
    const upperBoundTimestamps: Date[] = [];
    if (options.cursor) {
      upperBoundTimestamps.push(new Date(options.cursor));
    }
    if (options.before) {
      upperBoundTimestamps.push(options.before);
    }

    // Construct the where clause
    const where: Record<string, unknown> = { conversationId };
    if (upperBoundTimestamps.length > 0) {
      // Use the earlier timestamp as the upper bound
      const earliest = upperBoundTimestamps.reduce((a, b) =>
        a.getTime() < b.getTime() ? a : b,
      );
      where['serverTimestamp'] = { lt: earliest };
    }

    const records = await this.prisma.message.findMany({
      where: where as never,
      include: FULL_MESSAGE_INCLUDE,
      orderBy: { serverTimestamp: 'desc' as const }, // Newest first for pagination
      take: limit + 1, // Fetch one extra to detect hasMore
    });

    const hasMore = records.length > limit;
    const sliced = records.slice(0, limit);
    const items = sliced.map((r) =>
      this.mapToResponse(r as unknown as MessageRecord),
    );

    // Cursor for the next page is the serverTimestamp of the last returned item
    const cursor =
      hasMore && items.length > 0
        ? items[items.length - 1].serverTimestamp
        : undefined;

    return { items, cursor, hasMore };
  }

  // ─── Find After Timestamp (Offline Sync — R13) ────────────────────────

  /**
   * Finds all messages across specified conversations after a given timestamp.
   *
   * Supports the `message:sync` WebSocket protocol for offline-to-online
   * reconciliation (R13). Returns messages in ascending chronological order
   * (oldest first) so the client can replay them in send-order (R4).
   *
   * An optional `limit` parameter provides a safety bound to prevent
   * unbounded result sets after extended disconnection periods.
   *
   * @param conversationIds - Array of conversation UUIDs to sync.
   * @param afterTimestamp - Return only messages after this server timestamp.
   * @param limit - Optional maximum number of messages to return.
   * @returns Array of MessageResponse sorted by serverTimestamp ascending.
   */
  async findAfterTimestamp(
    conversationIds: string[],
    afterTimestamp: Date,
    limit?: number,
  ): Promise<MessageResponse[]> {
    if (conversationIds.length === 0) {
      return [];
    }

    const records = await this.prisma.message.findMany({
      where: {
        conversationId: { in: conversationIds },
        serverTimestamp: { gt: afterTimestamp },
      },
      include: FULL_MESSAGE_INCLUDE,
      orderBy: { serverTimestamp: 'asc' }, // Chronological for sync (R4 — send-order)
      ...(limit !== undefined ? { take: limit } : {}),
    });

    return records.map((r) =>
      this.mapToResponse(r as unknown as MessageRecord),
    );
  }

  // ─── Find by Client Message ID (Deduplication) ────────────────────────

  /**
   * Finds a message by its client-generated idempotency ID.
   *
   * Prevents duplicate message creation when a client retries a send
   * operation after network failure (R4: zero duplicates). If a message
   * with the given `clientMessageId` already exists, the existing record
   * is returned instead of creating a duplicate.
   *
   * Uses the unique index on `clientMessageId` for an efficient lookup.
   *
   * @param clientMessageId - Client-generated UUID v4.
   * @returns MessageResponse or null if no matching message exists.
   */
  async findByClientMessageId(
    clientMessageId: string,
  ): Promise<MessageResponse | null> {
    const record = await this.prisma.message.findFirst({
      where: { clientMessageId },
      include: FULL_MESSAGE_INCLUDE,
    });

    return record
      ? this.mapToResponse(record as unknown as MessageRecord)
      : null;
  }

  // ─── Update Status (Per-Recipient) ────────────────────────────────────

  /**
   * Updates or creates the delivery/read status for a single recipient.
   *
   * Uses a Prisma upsert against the @@unique([messageId, userId]) composite
   * index. Status progresses linearly: SENT → DELIVERED → READ.
   *
   * When status is READ, `deliveredAt` is also set (a message must have
   * been delivered in order to be read). The returned MessageStatusUpdate
   * includes the update timestamp for WebSocket emission.
   *
   * @param messageId - Message UUID.
   * @param userId - Recipient user UUID whose status is being updated.
   * @param status - New status value (SENT, DELIVERED, or READ).
   * @returns The updated MessageStatusUpdate for WebSocket emission.
   */
  async updateStatus(
    messageId: string,
    userId: string,
    status: MessageStatusEnum,
  ): Promise<MessageStatusUpdate> {
    const now = new Date();

    // Determine which timestamp fields to set based on new status
    const deliveredAt =
      status === MessageStatusEnum.DELIVERED ||
      status === MessageStatusEnum.READ
        ? now
        : null;
    const readAt = status === MessageStatusEnum.READ ? now : null;

    // Cast shared enum → Prisma enum (identical string values)
    const prismaStatus = status as never;

    const result = await this.prisma.messageStatus.upsert({
      where: {
        messageId_userId: { messageId, userId },
      },
      update: {
        status: prismaStatus,
        // Only set timestamp fields for the specific transition
        ...(status === MessageStatusEnum.DELIVERED
          ? { deliveredAt: now }
          : {}),
        ...(status === MessageStatusEnum.READ
          ? { readAt: now, deliveredAt: now }
          : {}),
      },
      create: {
        messageId,
        userId,
        status: prismaStatus,
        deliveredAt,
        readAt,
      },
    });

    return {
      messageId: result.messageId,
      userId: result.userId,
      status: result.status as unknown as MessageStatusEnum,
      updatedAt: now.toISOString(),
    };
  }

  // ─── Batch Update Status ──────────────────────────────────────────────

  /**
   * Batch updates delivery/read status for multiple messages in a single
   * database transaction.
   *
   * Used when a user opens a conversation and marks all unread messages
   * as read at once — avoids N individual updateStatus round-trips.
   * Each message status is upserted within a Prisma interactive transaction.
   *
   * Early returns without a database call if the messageIds array is empty.
   *
   * @param messageIds - Array of message UUIDs to update.
   * @param userId - Recipient user UUID whose status is being updated.
   * @param status - New status value (DELIVERED or READ).
   */
  async batchUpdateStatus(
    messageIds: string[],
    userId: string,
    status: MessageStatusEnum,
  ): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const now = new Date();
    const deliveredAt =
      status === MessageStatusEnum.DELIVERED ||
      status === MessageStatusEnum.READ
        ? now
        : null;
    const readAt = status === MessageStatusEnum.READ ? now : null;

    // Cast shared enum → Prisma enum (identical string values)
    const prismaStatus = status as never;

    const operations = messageIds.map((messageId) =>
      this.prisma.messageStatus.upsert({
        where: {
          messageId_userId: { messageId, userId },
        },
        update: {
          status: prismaStatus,
          ...(status === MessageStatusEnum.DELIVERED
            ? { deliveredAt: now }
            : {}),
          ...(status === MessageStatusEnum.READ
            ? { readAt: now, deliveredAt: now }
            : {}),
        },
        create: {
          messageId,
          userId,
          status: prismaStatus,
          deliveredAt,
          readAt,
        },
      }),
    );

    await this.prisma.$transaction(operations);
  }

  // ─── Set Link Preview ─────────────────────────────────────────────────

  /**
   * Attaches Open Graph metadata (link preview) to a message.
   *
   * Called asynchronously by the link-preview BullMQ job after it extracts
   * OG metadata from URLs detected in the message. The returned response
   * includes the link preview data for emission via the `link:preview`
   * WebSocket event to all conversation participants.
   *
   * The link preview data is attached to the in-memory response object.
   * Full database persistence of link preview data requires a dedicated
   * JSON column on the Message model added via schema migration.
   *
   * @param messageId - Message UUID to enrich with link preview.
   * @param linkPreview - Extracted OG metadata (url, title, description, imageUrl, siteName).
   * @returns The MessageResponse with populated linkPreview field.
   * @throws Error if the message does not exist.
   */
  async setLinkPreview(
    messageId: string,
    linkPreview: LinkPreviewData,
  ): Promise<MessageResponse> {
    // Retrieve the current message record to build the full response
    const record = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: FULL_MESSAGE_INCLUDE,
    });

    if (!record) {
      throw new Error(`Message not found: ${messageId}`);
    }

    // Build response and attach the link preview data for WebSocket emission
    const response = this.mapToResponse(record as unknown as MessageRecord);
    response.linkPreview = linkPreview;
    return response;
  }

  // =========================================================================
  // Private Mappers and Helpers
  // =========================================================================

  /**
   * Maps a Prisma Message record (with included relations) to the public
   * MessageResponse DTO.
   *
   * Field mapping:
   * - Prisma DateTime fields       → ISO 8601 strings
   * - Prisma null optionals        → undefined (for DTO optional fields)
   * - Prisma MessageDeliveryStatus → Shared MessageStatusEnum (same strings)
   * - Prisma MessageType           → Shared MessageType (same strings)
   * - Prisma statuses[]            → aggregated into single status enum
   * - Prisma media[0].id           → mediaId (first media attachment)
   * - Prisma serverTimestamp       → createdAt (message creation time)
   * - Derived updatedAt            → max(serverTimestamp, editedAt, deletedAt)
   *
   * CRITICAL: ciphertext is mapped as-is — null = tombstone (R20).
   */
  private mapToResponse(record: MessageRecord): MessageResponse {
    const serverTs = record.serverTimestamp.toISOString();

    // Compute derived timestamps
    const updatedAt = this.computeUpdatedAt(record);

    // Compute aggregate delivery/read status from per-recipient statuses
    const aggregateStatus = this.computeAggregateStatus(record.statuses);

    // Extract first media attachment ID (Message has one-to-many media relation;
    // the response exposes only the primary media reference)
    const mediaId =
      record.media && record.media.length > 0
        ? record.media[0].id
        : undefined;

    // Build reply-to preview if the replyTo relation was included
    let replyTo: ReplyToMessage | undefined;
    if (record.replyTo) {
      replyTo = {
        id: record.replyTo.id,
        senderId: record.replyTo.senderId,
        senderName: record.replyTo.sender?.displayName ?? '',
        ciphertext: record.replyTo.ciphertext ?? null,
        type: record.replyTo.type as MessageType,
      };
    }

    return {
      id: record.id,
      conversationId: record.conversationId,
      senderId: record.senderId,
      senderName: record.sender?.displayName ?? '',
      senderAvatar: record.sender?.avatarUrl ?? undefined,
      ciphertext: record.ciphertext ?? null, // null = tombstone (R20)
      type: record.type as MessageType,
      status: aggregateStatus,
      replyTo,
      mediaId,
      isEdited: record.isEdited,
      isDeleted: record.isDeleted,
      editedAt: record.editedAt ? record.editedAt.toISOString() : undefined,
      deletedAt: record.deletedAt
        ? record.deletedAt.toISOString()
        : undefined,
      clientMessageId: record.clientMessageId ?? '',
      serverTimestamp: serverTs,
      createdAt: serverTs, // serverTimestamp is the message creation time
      updatedAt,
    };
  }

  /**
   * Computes the aggregate delivery/read status from per-recipient statuses.
   *
   * Aggregation rule (per AAP definition): the aggregate status represents
   * the highest (most advanced) state among all recipients:
   * - If any recipient has READ → aggregate is READ
   * - If any recipient has DELIVERED (but none READ) → DELIVERED
   * - Otherwise → SENT
   *
   * For messages with no status records (e.g., just created), returns SENT.
   */
  private computeAggregateStatus(
    statuses?: Array<{ status: string }>,
  ): MessageStatusEnum {
    if (!statuses || statuses.length === 0) {
      return MessageStatusEnum.SENT;
    }

    const hasRead = statuses.some((s) => s.status === 'READ');
    if (hasRead) {
      return MessageStatusEnum.READ;
    }

    const hasDelivered = statuses.some((s) => s.status === 'DELIVERED');
    if (hasDelivered) {
      return MessageStatusEnum.DELIVERED;
    }

    return MessageStatusEnum.SENT;
  }

  /**
   * Computes the `updatedAt` timestamp for a MessageResponse.
   *
   * Since the Prisma Message model does not have an @updatedAt field,
   * this is derived as the most recent timestamp among:
   * - serverTimestamp (creation time — always present)
   * - editedAt (set when message is edited — R19)
   * - deletedAt (set when message is soft-deleted — R20)
   */
  private computeUpdatedAt(record: MessageRecord): string {
    const timestamps: Date[] = [record.serverTimestamp];

    if (record.editedAt) {
      timestamps.push(record.editedAt);
    }
    if (record.deletedAt) {
      timestamps.push(record.deletedAt);
    }

    const latest = timestamps.reduce((a, b) =>
      a.getTime() > b.getTime() ? a : b,
    );
    return latest.toISOString();
  }
}
