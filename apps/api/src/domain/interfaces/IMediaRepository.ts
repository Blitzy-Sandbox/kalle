/**
 * @module apps/api/src/domain/interfaces/IMediaRepository
 * @description Media repository interface — defines the persistence contract for media
 * metadata records. This interface abstracts the underlying data store (Prisma/PostgreSQL)
 * so that services depend on the contract rather than the concrete implementation (R17).
 *
 * IMPORTANT ARCHITECTURAL DISTINCTION:
 * - This repository handles **metadata** about encrypted media blobs (file type, MIME,
 *   size, encryption keys/IVs, thumbnail info, dimensions, duration, waveform data,
 *   and associations to messages or stories).
 * - The **actual encrypted binary blobs** are managed by {@link IStorageProvider}.
 * - Media files are encrypted client-side before upload (R12). The server never
 *   decrypts media — it stores ciphertext blobs verbatim.
 * - Size and MIME validation occur at the service/controller layer (R8), not here.
 * - Thumbnail metadata is stored alongside main media metadata (R27).
 * - This interface contains zero business logic — it is a pure persistence contract (R16).
 *
 * @see {@link IStorageProvider} for encrypted blob storage operations
 * @see {@link MediaService} for business logic that orchestrates both repository and storage
 */

import type { MediaResponse, MediaType } from '@kalle/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Repository-Level Input Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Data required to create a new media metadata record in the persistence layer.
 *
 * All fields correspond to the media domain model properties. These are plain
 * value objects — no ORM types (e.g., Prisma model instances) leak through
 * this interface boundary.
 *
 * Encryption-related fields (encryptionKey, encryptionIv, thumbnail*) contain
 * base64-encoded values produced by the client-side Signal Protocol wrapper.
 * The server persists these opaquely — it never interprets or decrypts them (R12).
 */
export interface CreateMediaData {
  /**
   * Optional external ID assignment.
   * When omitted, the repository implementation generates a UUID v4.
   */
  id?: string;

  /** User ID of the uploader who owns this media */
  uploaderId: string;

  /**
   * Category of media content (IMAGE, VIDEO, DOCUMENT, VOICE_NOTE).
   * Determined and validated at the service/controller layer before reaching
   * the repository.
   */
  type: MediaType;

  /**
   * MIME type of the original (pre-encryption) file.
   * Already validated against the allowlist (R8) before reaching the repository.
   */
  mimeType: string;

  /** Original filename as reported by the client file picker */
  fileName: string;

  /**
   * Size of the encrypted payload in bytes.
   * Already validated against the 25 MB limit (R8) before reaching the repository.
   */
  fileSize: number;

  /**
   * URL or storage key pointing to the encrypted blob in {@link IStorageProvider}.
   * The blob has already been written to storage before this metadata record is created.
   */
  url: string;

  /**
   * Client-generated symmetric AES key used to encrypt this media,
   * itself encrypted per-recipient via Signal Protocol session.
   * Base64-encoded string.
   */
  encryptionKey: string;

  /**
   * Initialization vector used for AES-CBC / AES-GCM encryption.
   * Base64-encoded string.
   */
  encryptionIv: string;

  /**
   * URL or storage key pointing to the encrypted thumbnail blob (R27).
   * Present for IMAGE type; undefined for other media types.
   */
  thumbnailUrl?: string;

  /**
   * Thumbnail width in pixels (≤ 200 px longest edge per R27).
   * Present when thumbnailUrl is provided.
   */
  thumbnailWidth?: number;

  /**
   * Thumbnail height in pixels (≤ 200 px longest edge per R27).
   * Present when thumbnailUrl is provided.
   */
  thumbnailHeight?: number;

  /**
   * Separate AES decryption key for the thumbnail — base64-encoded.
   * Required when thumbnailUrl is provided (R27).
   */
  thumbnailEncryptionKey?: string;

  /**
   * Separate initialization vector for thumbnail decryption — base64-encoded.
   * Required when thumbnailUrl is provided (R27).
   */
  thumbnailEncryptionIv?: string;

  /** Original image or video width in pixels (before encryption) */
  width?: number;

  /** Original image or video height in pixels (before encryption) */
  height?: number;

  /**
   * Duration in seconds — applicable to VIDEO and VOICE_NOTE types.
   * Determined client-side from the original media before encryption.
   */
  duration?: number;

  /**
   * Waveform amplitude samples for voice notes.
   * Each value is a normalized float in the range [0.0, 1.0].
   * Generated client-side via Web Audio API before encryption.
   */
  waveform?: number[];

  /**
   * Associated message ID when the media is attached to a chat message.
   * Mutually exclusive with storyId in typical usage, though the repository
   * does not enforce this constraint (service layer responsibility).
   */
  messageId?: string;

  /**
   * Associated story ID when the media is used in a story.
   * Mutually exclusive with messageId in typical usage, though the repository
   * does not enforce this constraint (service layer responsibility).
   */
  storyId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Repository Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Media metadata repository contract.
 *
 * Abstracts persistence of media metadata records behind a clean async
 * interface. Concrete implementations (e.g., Prisma-backed {@link MediaRepository})
 * are injected into services via the composition root (R17).
 *
 * All methods return Promises — implementations are expected to perform
 * async I/O against the underlying data store.
 *
 * No business logic belongs in implementations of this interface (R16):
 * - No MIME type validation (service layer — R8)
 * - No file size enforcement (service layer — R8)
 * - No encryption/decryption (client-side — R12)
 * - No thumbnail generation (client-side — R27)
 */
export interface IMediaRepository {
  /**
   * Persist a new media metadata record.
   *
   * Called after the encrypted blob has been successfully stored via
   * {@link IStorageProvider}. The `data.url` field must already point
   * to a valid storage location.
   *
   * @param data - Complete media metadata to persist
   * @returns The created media record mapped to the {@link MediaResponse} DTO
   */
  create(data: CreateMediaData): Promise<MediaResponse>;

  /**
   * Retrieve a single media metadata record by its unique identifier.
   *
   * @param id - UUID v4 media record identifier
   * @returns The media record as {@link MediaResponse}, or `null` if no record
   *          exists with the given ID
   */
  findById(id: string): Promise<MediaResponse | null>;

  /**
   * Retrieve all media metadata records associated with a specific message.
   *
   * Messages can have multiple media attachments (e.g., an image gallery).
   * Results are returned in creation order (oldest first) for consistent
   * rendering in the chat UI.
   *
   * @param messageId - The associated message's unique identifier
   * @returns Array of {@link MediaResponse} records; empty array if no media
   *          is associated with the message
   */
  findByMessage(messageId: string): Promise<MediaResponse[]>;

  /**
   * Retrieve all media metadata records associated with a specific story.
   *
   * Used for story media retrieval (rendering the story viewer) and for
   * the story cleanup BullMQ job to identify media that needs blob deletion
   * after story expiration (R11, R35).
   *
   * @param storyId - The associated story's unique identifier
   * @returns Array of {@link MediaResponse} records; empty array if no media
   *          is associated with the story
   */
  findByStory(storyId: string): Promise<MediaResponse[]>;

  /**
   * Retrieve all media uploaded by a specific user, with cursor-based pagination.
   *
   * Used for user profile media galleries and storage usage management.
   * Results are returned in reverse chronological order (newest first).
   *
   * @param uploaderId - The uploader's user ID
   * @param options - Optional pagination parameters:
   *   - `cursor`: Opaque cursor string from a previous response's `cursor` field.
   *               When provided, results start after this position.
   *   - `limit`: Maximum number of records to return. Implementations should
   *              apply a sensible default (e.g., 20) when omitted.
   * @returns Paginated result containing:
   *   - `items`: Array of {@link MediaResponse} records for the current page
   *   - `cursor`: Opaque cursor for the next page, or `undefined` if no more pages
   *   - `hasMore`: `true` if additional records exist beyond the current page
   */
  findByUploader(
    uploaderId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{
    items: MediaResponse[];
    cursor?: string;
    hasMore: boolean;
  }>;

  /**
   * Delete a single media metadata record by its ID.
   *
   * IMPORTANT: This deletes only the metadata record in the database.
   * The actual encrypted blob stored via {@link IStorageProvider} must be
   * deleted separately by the calling service. This separation ensures the
   * service can coordinate blob deletion with metadata deletion atomically
   * or handle partial failure gracefully.
   *
   * Used during message deletion (R20 — tombstone) and story cleanup (R11).
   *
   * @param id - UUID v4 media record identifier to delete
   * @throws If the record does not exist, implementations may silently succeed
   *         (idempotent delete) or throw — the service layer handles both cases.
   */
  delete(id: string): Promise<void>;

  /**
   * Delete all media metadata records associated with a specific story.
   *
   * Used by the story-cleanup BullMQ job (R11, R35) to efficiently remove
   * all media metadata for expired stories in a single operation.
   *
   * Returns the storage URLs/keys of the deleted records so the calling
   * service or job processor can subsequently clean up the actual encrypted
   * blobs from {@link IStorageProvider}. This two-phase approach prevents
   * orphaned blobs or orphaned metadata records.
   *
   * @param storyId - The story ID whose media metadata records to delete
   * @returns Array of storage URLs/keys (from the `url` and `thumbnailUrl`
   *          fields of deleted records) that need subsequent blob cleanup
   */
  deleteByStory(storyId: string): Promise<string[]>;
}
