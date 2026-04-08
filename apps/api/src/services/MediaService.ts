/**
 * @module MediaService
 *
 * Encrypted Media Upload Service
 *
 * Handles encrypted media upload with MIME type verification against an
 * allowlist and 25 MB size enforcement. Stores encrypted blobs via
 * IStorageProvider and metadata via IMediaRepository.
 *
 * Architecture rules enforced:
 *
 *  - R17 (Interface-Driven Dependencies): All dependencies received via
 *    constructor injection typed as interfaces — never import concrete
 *    repository or provider classes.
 *  - R16 (OOD Layering): ALL media business logic lives in this service.
 *    Controllers are thin delegation layers; repositories handle persistence.
 *  - R8  (Media Upload Validation): 25 MB size limit enforced server-side
 *    (413 PayloadTooLargeError). Server verifies declared MIME type against
 *    the canonical allowlist — rejects disallowed types with 415
 *    UnsupportedMediaTypeError.  Two distinct errors for two distinct
 *    violations.
 *  - R12 (E2E Encryption): Media is encrypted client-side before upload.
 *    This service stores opaque encrypted blobs — zero processing, zero
 *    decryption.  The buffer received by `uploadMedia()` is already
 *    ciphertext.
 *  - R27 (Client-Side Thumbnail Generation): Thumbnails are generated
 *    client-side before encryption (max 200 px longest edge).  The client
 *    uploads both thumbnail and full-size as separate encrypted blobs.  This
 *    service stores metadata about both — it does NOT generate thumbnails.
 *  - R22 (Standardized Error Responses): Throws typed DomainError
 *    subclasses that the global error-handler middleware maps to HTTP status
 *    codes and the standardised error shape.
 *  - R28 (Structured Logging Only): Zero `console.log` / `console.warn`
 *    calls.
 *  - R7  (Zero Warnings Build): TypeScript strict mode, zero warnings.
 */

// ---------------------------------------------------------------------------
// Internal dependency imports  (R17 — interface-driven)
// ---------------------------------------------------------------------------

import type {
  IMediaRepository,
  CreateMediaData,
} from '../domain/interfaces/IMediaRepository.js';

import type { IStorageProvider } from '../domain/interfaces/IStorageProvider.js';

// ---------------------------------------------------------------------------
// Error class imports
// ---------------------------------------------------------------------------

import { PayloadTooLargeError } from '../errors/PayloadTooLargeError.js';
import { UnsupportedMediaTypeError } from '../errors/UnsupportedMediaTypeError.js';
import { NotFoundError } from '../errors/NotFoundError.js';

// ---------------------------------------------------------------------------
// Shared types and constants from @kalle/shared
// ---------------------------------------------------------------------------

import type { MediaResponse } from '@kalle/shared';
import {
  MediaType,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
} from '@kalle/shared';

// ---------------------------------------------------------------------------
// External imports
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Re-export shared constants so that controllers / validators can import
// ALLOWED_MIME_TYPES and MAX_FILE_SIZE from this service module.
// ---------------------------------------------------------------------------

export { ALLOWED_MIME_TYPES, MAX_FILE_SIZE };

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

/**
 * Input shape for the file data received from the upload controller.
 * The `buffer` contains **encrypted** data (R12) — the server never
 * decrypts or inspects it.
 */
export interface UploadFileInput {
  /** The raw encrypted file buffer (ciphertext). */
  buffer: Buffer;
  /** Original client-provided filename. */
  originalname: string;
  /** Declared MIME type of the **original** (unencrypted) file. */
  mimetype: string;
  /** Size of the encrypted blob in bytes. */
  size: number;
}

/**
 * Complete input DTO for {@link MediaService.uploadMedia}.
 */
export interface UploadMediaInput {
  /** Authenticated user ID performing the upload. */
  uploaderId: string;
  /** Multer-compatible file object containing the encrypted blob. */
  file: UploadFileInput;
  /** Semantic media category (IMAGE, VIDEO, DOCUMENT, VOICE_NOTE). */
  type: MediaType;
  /** Client-side encryption key (opaque string — server never uses it). */
  encryptionKey: string;
  /** Client-side encryption IV (opaque string — server never uses it). */
  encryptionIv: string;

  // --- Optional thumbnail fields (R27) ---
  /** Encrypted thumbnail blob generated client-side. */
  thumbnailBuffer?: Buffer;
  /** Declared MIME type for the thumbnail. */
  thumbnailMimetype?: string;
  /** Encryption key for the thumbnail blob. */
  thumbnailEncryptionKey?: string;
  /** Encryption IV for the thumbnail blob. */
  thumbnailEncryptionIv?: string;
  /** Thumbnail width in pixels (max 200 px longest edge per R27). */
  thumbnailWidth?: number;
  /** Thumbnail height in pixels. */
  thumbnailHeight?: number;

  // --- Optional media metadata ---
  /** Image / video width in pixels. */
  width?: number;
  /** Image / video height in pixels. */
  height?: number;
  /** Audio / video duration in seconds. */
  duration?: number;
  /** Voice-note waveform data. */
  waveform?: number[];

  // --- Optional association references ---
  /** ID of the message this media is attached to. */
  messageId?: string;
  /** ID of the story this media is attached to. */
  storyId?: string;
}

/**
 * Input DTO for {@link MediaService.getMediaByUploader}.
 */
export interface GetByUploaderInput {
  uploaderId: string;
  cursor?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Flattened, cached list of every MIME type that the server will accept.
 * Computed once on module load and reused across all validation calls.
 */
const allAllowedMimeTypes: readonly string[] = Object.values(ALLOWED_MIME_TYPES).flat();

/**
 * Validates that a given MIME type is in the canonical allowlist.
 *
 * @param mimetype - Declared MIME type string to check.
 * @returns `true` when the MIME type is accepted; `false` otherwise.
 */
function isMimeTypeAllowed(mimetype: string): boolean {
  return allAllowedMimeTypes.includes(mimetype);
}

/**
 * Generates a unique, collision-free storage key under the `media/` prefix.
 *
 * @param prefix - Key prefix (e.g. `'media'` or `'media/thumb'`).
 * @param filename - Original filename (sanitised or as-is).
 * @returns A unique string suitable for use as an IStorageProvider key.
 */
function generateStorageKey(prefix: string, filename: string): string {
  return `${prefix}/${uuidv4()}-${filename}`;
}

// ---------------------------------------------------------------------------
// MediaService
// ---------------------------------------------------------------------------

/**
 * Service responsible for all media-related business logic.
 *
 * Dependencies are injected via the constructor and are typed as
 * interfaces (R17).  All storage operations go through
 * {@link IStorageProvider}; all metadata persistence goes through
 * {@link IMediaRepository}.
 */
export class MediaService {
  // -----------------------------------------------------------------------
  // Constructor  (R17: interface-driven dependency injection)
  // -----------------------------------------------------------------------

  constructor(
    private readonly mediaRepository: IMediaRepository,
    private readonly storageProvider: IStorageProvider,
  ) {}

  // -----------------------------------------------------------------------
  // Public methods
  // -----------------------------------------------------------------------

  /**
   * Upload an encrypted media blob and its optional thumbnail.
   *
   * **Validation order (R8):**
   * 1. File size (413 `PayloadTooLargeError` if > 25 MB).
   * 2. MIME type (415 `UnsupportedMediaTypeError` if not in allowlist).
   *
   * The buffer is **already encrypted** by the client (R12) — the server
   * treats it as an opaque blob.  If a thumbnail is provided it was also
   * generated and encrypted client-side (R27).
   *
   * @param input - Upload parameters including the encrypted file and metadata.
   * @returns The persisted {@link MediaResponse} record.
   */
  async uploadMedia(input: UploadMediaInput): Promise<MediaResponse> {
    const { file } = input;

    // ------------------------------------------------------------------
    // Step 1 — Size validation (R8)
    // Must come FIRST so the 413 fires before the 415.
    // ------------------------------------------------------------------
    if (file.size > MAX_FILE_SIZE) {
      throw new PayloadTooLargeError('File size exceeds the 25MB limit', {
        maxSize: MAX_FILE_SIZE,
        actualSize: file.size,
        fileName: file.originalname,
      });
    }

    // ------------------------------------------------------------------
    // Step 2 — MIME type validation (R8)
    // ------------------------------------------------------------------
    if (!isMimeTypeAllowed(file.mimetype)) {
      throw new UnsupportedMediaTypeError('MIME type not allowed', {
        mimeType: file.mimetype,
        allowedTypes: [...allAllowedMimeTypes],
      });
    }

    // ------------------------------------------------------------------
    // Step 3 — Store encrypted blob via IStorageProvider (R12)
    // ------------------------------------------------------------------
    const storageKey = generateStorageKey('media', file.originalname);
    const url: string = await this.storageProvider.store(
      storageKey,
      file.buffer,
      file.mimetype,
    );

    // ------------------------------------------------------------------
    // Step 4 — Store thumbnail if provided (R27)
    // Server does NOT generate thumbnails — they arrive already encrypted
    // from the client.
    // ------------------------------------------------------------------
    let thumbnailUrl: string | undefined;

    if (input.thumbnailBuffer) {
      const thumbnailKey = generateStorageKey('media/thumb', 'thumb.bin');
      thumbnailUrl = await this.storageProvider.store(
        thumbnailKey,
        input.thumbnailBuffer,
        input.thumbnailMimetype ?? 'application/octet-stream',
      );
    }

    // ------------------------------------------------------------------
    // Step 5 — Create metadata record via IMediaRepository
    // ------------------------------------------------------------------
    const createData: CreateMediaData = {
      uploaderId: input.uploaderId,
      type: input.type,
      mimeType: file.mimetype,
      fileName: file.originalname,
      fileSize: file.size,
      url,
      encryptionKey: input.encryptionKey,
      encryptionIv: input.encryptionIv,

      // Thumbnail metadata (R27)
      thumbnailUrl,
      thumbnailWidth: input.thumbnailWidth,
      thumbnailHeight: input.thumbnailHeight,
      thumbnailEncryptionKey: input.thumbnailEncryptionKey,
      thumbnailEncryptionIv: input.thumbnailEncryptionIv,

      // Media dimensions and duration
      width: input.width,
      height: input.height,
      duration: input.duration,
      waveform: input.waveform,

      // Associations
      messageId: input.messageId,
      storyId: input.storyId,
    };

    const mediaRecord: MediaResponse = await this.mediaRepository.create(createData);

    return mediaRecord;
  }

  /**
   * Retrieve a single media record by its ID.
   *
   * @param mediaId - Primary key of the media record.
   * @returns The {@link MediaResponse} record.
   * @throws {@link NotFoundError} when no record with the given ID exists.
   */
  async getMediaById(mediaId: string): Promise<MediaResponse> {
    const media: MediaResponse | null = await this.mediaRepository.findById(mediaId);

    if (!media) {
      throw new NotFoundError('Media not found', {
        resource: 'Media',
        id: mediaId,
      });
    }

    return media;
  }

  /**
   * Retrieve all media records attached to a given message.
   *
   * @param messageId - The ID of the message whose media to fetch.
   * @returns An array of {@link MediaResponse} records (may be empty).
   */
  async getMediaByMessage(messageId: string): Promise<MediaResponse[]> {
    return this.mediaRepository.findByMessage(messageId);
  }

  /**
   * Retrieve all media records attached to a given story.
   *
   * @param storyId - The ID of the story whose media to fetch.
   * @returns An array of {@link MediaResponse} records (may be empty).
   */
  async getMediaByStory(storyId: string): Promise<MediaResponse[]> {
    return this.mediaRepository.findByStory(storyId);
  }

  /**
   * Retrieve media records uploaded by a specific user (cursor-paginated).
   *
   * @param input - Contains `uploaderId` and optional `cursor` / `limit`.
   * @returns Paginated result with `items`, optional `cursor`, and `hasMore`.
   */
  async getMediaByUploader(
    input: GetByUploaderInput,
  ): Promise<{ items: MediaResponse[]; cursor?: string; hasMore: boolean }> {
    const { uploaderId, cursor, limit } = input;
    return this.mediaRepository.findByUploader(uploaderId, { cursor, limit });
  }

  /**
   * Delete a media record and its associated storage blobs.
   *
   * Removes both the primary encrypted blob and the optional thumbnail
   * blob from storage, then removes the metadata record from the
   * repository.
   *
   * @param mediaId - Primary key of the media record to delete.
   * @throws {@link NotFoundError} when no record with the given ID exists.
   */
  async deleteMedia(mediaId: string): Promise<void> {
    // Fetch the media record to obtain the storage URL(s).
    const media: MediaResponse | null = await this.mediaRepository.findById(mediaId);

    if (!media) {
      throw new NotFoundError('Media not found', {
        resource: 'Media',
        id: mediaId,
      });
    }

    // Delete the primary encrypted blob from storage.
    await this.storageProvider.delete(media.url);

    // Delete the thumbnail blob from storage if one exists.
    if (media.thumbnail?.url) {
      await this.storageProvider.delete(media.thumbnail.url);
    }

    // Delete the metadata record from the repository.
    await this.mediaRepository.delete(mediaId);
  }
}
