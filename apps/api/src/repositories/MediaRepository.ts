/**
 * @module apps/api/src/repositories/MediaRepository
 *
 * Prisma-backed implementation of the {@link IMediaRepository} interface.
 *
 * Handles persistence of media **metadata** records — NOT the encrypted binary blobs
 * (those are managed by {@link IStorageProvider}). Media records store encrypted file
 * URLs, MIME types, sizes, encryption keys/IVs, thumbnail metadata, and associations
 * to messages and stories.
 *
 * Architecture rules enforced:
 * - **R17** (Interface-Driven Dependencies): Implements IMediaRepository interface.
 *   PrismaClient injected via constructor — no hard-coded instantiation.
 * - **R16** (OOD Layering): Zero business logic — persistence and data mapping only.
 *   MIME validation, size enforcement, and encryption happen in MediaService / client.
 * - **R12** (E2E Encryption): Stores encrypted URLs and encryption metadata opaquely.
 *   Zero decryption logic anywhere in this file.
 * - **R27** (Client-Side Thumbnails): Stores client-generated thumbnail metadata
 *   (URL, encryption keys/IVs). Thumbnail dimensions are not persisted in the
 *   current schema; the consuming client computes dimensions upon decryption.
 * - **R28** (Structured Logging): Zero `console.log` — structured Pino logging is
 *   handled at the service layer.
 * - **R7**  (Zero Warnings Build): TypeScript strict mode, zero warnings.
 *
 * Field mapping (Prisma ↔ Shared types):
 * | Prisma column          | Shared field        | Transformation           |
 * |------------------------|---------------------|--------------------------|
 * | `userId`               | `uploaderId`        | Rename                   |
 * | `filename`             | `fileName`          | Rename                   |
 * | `size`                 | `fileSize`          | Rename                   |
 * | `encryptedUrl`         | `url`               | Rename                   |
 * | `mimeType`             | `type` (MediaType)  | Derived from MIME prefix |
 * | thumbnail* fields      | `thumbnail`         | Compose ThumbnailMetadata|
 * | `waveform` (JSON str)  | `waveform` (number[])| JSON parse/stringify    |
 * | `createdAt` (Date)     | `createdAt` (string)| `.toISOString()`         |
 *
 * @see {@link IMediaRepository} for the persistence contract
 * @see {@link IStorageProvider} for encrypted blob storage operations
 * @see {@link MediaService} for business logic orchestrating both
 */

import type { PrismaClient, Media } from '@prisma/client';
import type {
  IMediaRepository,
  CreateMediaData,
} from '../domain/interfaces/IMediaRepository.js';
import {
  MediaType,
  type MediaResponse,
  type ThumbnailMetadata,
} from '@kalle/shared';

// =============================================================================
// MediaRepository — Prisma-backed implementation
// =============================================================================

export class MediaRepository implements IMediaRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ─── Create ──────────────────────────────────────────────────────────

  /**
   * Persist a new media metadata record.
   *
   * Called after the encrypted blob has been successfully stored via
   * {@link IStorageProvider}. The `data.url` field must already point
   * to a valid storage location.
   *
   * Field name translation occurs here: the interface's domain-oriented
   * field names (e.g., `uploaderId`, `fileName`, `fileSize`, `url`) are
   * mapped to the Prisma schema's column names (e.g., `userId`, `filename`,
   * `size`, `encryptedUrl`).
   *
   * The `type` (MediaType) and `thumbnailWidth`/`thumbnailHeight` fields
   * from {@link CreateMediaData} are accepted but not stored directly —
   * the Prisma schema does not have dedicated columns for them. `type` is
   * re-derived from `mimeType` on read; thumbnail dimensions are populated
   * with defaults in the response mapper.
   *
   * @param data - Complete media metadata to persist
   * @returns The created media record mapped to {@link MediaResponse}
   */
  async create(data: CreateMediaData): Promise<MediaResponse> {
    const record = await this.prisma.media.create({
      data: {
        // Use provided ID if present; otherwise Prisma generates UUID v4
        ...(data.id !== undefined ? { id: data.id } : {}),
        userId: data.uploaderId,
        messageId: data.messageId ?? null,
        storyId: data.storyId ?? null,
        mimeType: data.mimeType,
        encryptedUrl: data.url,
        thumbnailUrl: data.thumbnailUrl ?? null,
        size: data.fileSize,
        filename: data.fileName,
        encryptionKey: data.encryptionKey,
        encryptionIv: data.encryptionIv,
        thumbnailEncryptionKey: data.thumbnailEncryptionKey ?? null,
        thumbnailEncryptionIv: data.thumbnailEncryptionIv ?? null,
        width: data.width ?? null,
        height: data.height ?? null,
        duration:
          data.duration !== undefined ? Math.round(data.duration) : null,
        waveform:
          data.waveform !== undefined
            ? JSON.stringify(data.waveform)
            : null,
      },
    });

    return this.mapToResponse(record);
  }

  // ─── Read (Single) ───────────────────────────────────────────────────

  /**
   * Retrieve a single media metadata record by its unique identifier.
   *
   * @param id - UUID v4 media record identifier
   * @returns The media record as {@link MediaResponse}, or `null` if not found
   */
  async findById(id: string): Promise<MediaResponse | null> {
    const record = await this.prisma.media.findUnique({
      where: { id },
    });
    return record !== null ? this.mapToResponse(record) : null;
  }

  // ─── Read (By Message) ───────────────────────────────────────────────

  /**
   * Retrieve all media metadata records associated with a specific message.
   *
   * Messages can have multiple media attachments (e.g., an image gallery).
   * Results are returned in creation order (oldest first) for consistent
   * rendering in the chat UI.
   *
   * @param messageId - The associated message's unique identifier
   * @returns Array of {@link MediaResponse} records; empty array if none found
   */
  async findByMessage(messageId: string): Promise<MediaResponse[]> {
    const records = await this.prisma.media.findMany({
      where: { messageId },
      orderBy: { createdAt: 'asc' },
    });
    return records.map((r) => this.mapToResponse(r));
  }

  // ─── Read (By Story) ─────────────────────────────────────────────────

  /**
   * Retrieve all media metadata records associated with a specific story.
   *
   * Used for story media retrieval (rendering the story viewer) and for
   * the story-cleanup BullMQ job to identify media that needs blob deletion
   * after story expiration (R11, R35).
   *
   * @param storyId - The associated story's unique identifier
   * @returns Array of {@link MediaResponse} records; empty array if none found
   */
  async findByStory(storyId: string): Promise<MediaResponse[]> {
    const records = await this.prisma.media.findMany({
      where: { storyId },
      orderBy: { createdAt: 'asc' },
    });
    return records.map((r) => this.mapToResponse(r));
  }

  // ─── Read (By Uploader — Paginated) ──────────────────────────────────

  /**
   * Retrieve all media uploaded by a specific user, with cursor-based pagination.
   *
   * Used for user profile media galleries and storage usage management.
   * Results are returned in reverse chronological order (newest first).
   *
   * Pagination uses the "take N+1" pattern: fetches one extra record beyond
   * the requested limit to determine if more pages exist, then trims the
   * result set to the requested limit.
   *
   * @param uploaderId - The uploader's user ID
   * @param options - Optional pagination parameters:
   *   - `cursor`: Opaque cursor (media ID) from a previous response. When
   *               provided, results start after this position.
   *   - `limit`: Maximum records to return. Defaults to 20 when omitted.
   * @returns Paginated result with `items`, optional `cursor`, and `hasMore`
   */
  async findByUploader(
    uploaderId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{
    items: MediaResponse[];
    cursor?: string;
    hasMore: boolean;
  }> {
    const limit = options?.limit ?? 20;

    const records = await this.prisma.media.findMany({
      where: { userId: uploaderId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options?.cursor
        ? { cursor: { id: options.cursor }, skip: 1 }
        : {}),
    });

    const hasMore = records.length > limit;
    const items = records
      .slice(0, limit)
      .map((r) => this.mapToResponse(r));
    const cursor =
      hasMore && items.length > 0
        ? items[items.length - 1].id
        : undefined;

    return { items, cursor, hasMore };
  }

  // ─── Delete (Single) ─────────────────────────────────────────────────

  /**
   * Delete a single media metadata record by its ID.
   *
   * This deletes only the metadata record in the database. The actual
   * encrypted blob stored via {@link IStorageProvider} must be deleted
   * separately by the calling service. This separation allows the service
   * to coordinate blob deletion with metadata deletion and handle partial
   * failure gracefully.
   *
   * @param id - UUID v4 media record identifier to delete
   */
  async delete(id: string): Promise<void> {
    await this.prisma.media.delete({
      where: { id },
    });
  }

  // ─── Delete (By Story — Bulk) ────────────────────────────────────────

  /**
   * Delete all media metadata records associated with a specific story.
   *
   * Used by the story-cleanup BullMQ job (R11, R35) to efficiently remove
   * all media metadata for expired stories.
   *
   * Returns the storage URLs/keys of the deleted records so the calling
   * service or job processor can subsequently clean up the actual encrypted
   * blobs from {@link IStorageProvider}. This two-phase approach prevents
   * orphaned blobs or orphaned metadata records.
   *
   * Implementation:
   * 1. Fetches all media URLs (main + thumbnail) for the story
   * 2. Deletes all metadata records in a single bulk operation
   * 3. Returns collected URLs for blob cleanup
   *
   * @param storyId - The story ID whose media metadata records to delete
   * @returns Array of storage URLs/keys (from `encryptedUrl` and `thumbnailUrl`
   *          fields of deleted records) that need subsequent blob cleanup
   */
  async deleteByStory(storyId: string): Promise<string[]> {
    // Step 1: Retrieve storage URLs before deletion (select only needed fields)
    const records = await this.prisma.media.findMany({
      where: { storyId },
      select: { encryptedUrl: true, thumbnailUrl: true },
    });

    // Step 2: Collect all storage URLs that need subsequent blob cleanup
    const urls: string[] = [];
    for (const record of records) {
      urls.push(record.encryptedUrl);
      if (record.thumbnailUrl !== null) {
        urls.push(record.thumbnailUrl);
      }
    }

    // Step 3: Bulk delete all metadata records for this story
    await this.prisma.media.deleteMany({
      where: { storyId },
    });

    return urls;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────

  /**
   * Maps a raw Prisma `Media` record to the shared {@link MediaResponse} DTO.
   *
   * Performs the following transformations:
   * - Renames Prisma columns to domain field names (userId→uploaderId, etc.)
   * - Derives {@link MediaType} from `mimeType` prefix
   * - Composes {@link ThumbnailMetadata} from separate thumbnail columns
   * - Parses `waveform` from JSON string to `number[]`
   * - Converts nullable fields to `undefined` (JSON-friendly)
   * - Converts `createdAt` Date to ISO 8601 string
   *
   * @param record - Raw Prisma Media model instance
   * @returns Domain-typed {@link MediaResponse}
   */
  private mapToResponse(record: Media): MediaResponse {
    // Compose thumbnail metadata when all required fields are present.
    // Note: thumbnailWidth/thumbnailHeight are not stored in the current
    // Prisma schema. Width/height default to 0, indicating "dimensions
    // unknown — client should compute upon decryption."
    let thumbnail: ThumbnailMetadata | undefined;
    if (
      record.thumbnailUrl !== null &&
      record.thumbnailEncryptionKey !== null &&
      record.thumbnailEncryptionIv !== null
    ) {
      thumbnail = {
        url: record.thumbnailUrl,
        width: 0,
        height: 0,
        encryptionKey: record.thumbnailEncryptionKey,
        encryptionIv: record.thumbnailEncryptionIv,
      };
    }

    // Parse waveform from serialized JSON string to number array.
    // Gracefully handles invalid JSON by treating it as absent.
    let waveform: number[] | undefined;
    if (record.waveform !== null) {
      try {
        const parsed: unknown = JSON.parse(record.waveform);
        if (Array.isArray(parsed)) {
          waveform = parsed as number[];
        }
      } catch {
        // Invalid JSON in waveform column — treat as absent
        waveform = undefined;
      }
    }

    return {
      id: record.id,
      uploaderId: record.userId,
      type: this.deriveMediaType(record.mimeType),
      mimeType: record.mimeType,
      fileName: record.filename,
      fileSize: record.size,
      url: record.encryptedUrl,
      encryptionKey: record.encryptionKey ?? '',
      encryptionIv: record.encryptionIv ?? '',
      thumbnail,
      width: record.width ?? undefined,
      height: record.height ?? undefined,
      duration: record.duration ?? undefined,
      waveform,
      createdAt:
        record.createdAt instanceof Date
          ? record.createdAt.toISOString()
          : String(record.createdAt),
    };
  }

  /**
   * Derives a {@link MediaType} enum value from a MIME type string.
   *
   * This is a pure data-transformation function — not business logic.
   * It maps the MIME type prefix to the corresponding MediaType category
   * for populating the `type` field in {@link MediaResponse}.
   *
   * Mapping rules:
   * - `image/*` → {@link MediaType.IMAGE}
   * - `video/*` → {@link MediaType.VIDEO}
   * - `audio/*` → {@link MediaType.VOICE_NOTE}
   * - Everything else → {@link MediaType.DOCUMENT}
   *
   * @param mimeType - MIME type string (e.g., "image/jpeg", "audio/ogg")
   * @returns Corresponding {@link MediaType} enum value
   */
  private deriveMediaType(mimeType: string): MediaType {
    if (mimeType.startsWith('image/')) {
      return MediaType.IMAGE;
    }
    if (mimeType.startsWith('video/')) {
      return MediaType.VIDEO;
    }
    if (mimeType.startsWith('audio/')) {
      return MediaType.VOICE_NOTE;
    }
    return MediaType.DOCUMENT;
  }
}
