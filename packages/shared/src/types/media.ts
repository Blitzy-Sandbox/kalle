/**
 * @module packages/shared/src/types/media
 * @description Media domain types, DTOs, enums, and constants for the Kalle messaging platform.
 *
 * Media attachments (images, videos, documents, voice notes) are encrypted client-side
 * before upload (R12). Clients generate thumbnails for images before encryption (R27).
 * Maximum file size is 25 MB (R8). Server verifies MIME types against an allowlist.
 *
 * This module is consumed by both the frontend (upload/download/display) and backend
 * (validation/storage/metadata) via the @kalle/shared barrel export.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Enums
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies the category of a media attachment.
 *
 * Used in upload DTOs, API responses, MIME-type validation, and UI rendering
 * logic to determine how a media item should be processed and displayed.
 */
export enum MediaType {
  /** Raster images — JPEG, PNG, GIF, WebP */
  IMAGE = 'IMAGE',

  /** Video files — MP4, WebM, QuickTime */
  VIDEO = 'VIDEO',

  /** Document files — PDF, Office documents, plain text, CSV */
  DOCUMENT = 'DOCUMENT',

  /** Recorded audio messages with waveform visualization */
  VOICE_NOTE = 'VOICE_NOTE',
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Server-side MIME-type allowlist keyed by {@link MediaType}.
 *
 * Used for validation on both the client (pre-upload check) and the server
 * (R8 — rejects disallowed types with HTTP 415 Unsupported Media Type).
 *
 * This is a runtime constant (not just a type) because it drives validation
 * logic in both the frontend file picker and the backend upload endpoint.
 */
export const ALLOWED_MIME_TYPES: Record<MediaType, readonly string[]> = {
  [MediaType.IMAGE]: [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
  ],
  [MediaType.VIDEO]: [
    'video/mp4',
    'video/webm',
    'video/quicktime',
  ],
  [MediaType.DOCUMENT]: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
  ],
  [MediaType.VOICE_NOTE]: [
    'audio/ogg',
    'audio/opus',
    'audio/webm',
    'audio/mp4',
    'audio/mpeg',
  ],
} as const;

/**
 * Maximum allowed file size for media uploads, in bytes.
 *
 * Enforced both client-side (preventing unnecessary network traffic) and
 * server-side (R8 — returns HTTP 413 Payload Too Large when exceeded).
 *
 * Value: 25 MB = 25 × 1024 × 1024 = 26 214 400 bytes
 */
export const MAX_FILE_SIZE: number = 25 * 1024 * 1024;

/**
 * Maximum dimension (width or height) for client-generated thumbnails, in pixels.
 *
 * Per R27, the client generates a thumbnail where the longest edge does not
 * exceed this value. The thumbnail is encrypted separately from the full-size
 * image and uploaded as a distinct blob.
 *
 * Value: 200 pixels
 */
export const MAX_THUMBNAIL_DIMENSION: number = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: DTOs (Data Transfer Objects)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metadata sent alongside an encrypted media upload (multipart form data).
 *
 * The actual binary payload is transmitted as a separate form-data part;
 * this DTO carries the structured metadata required by the server to store,
 * index, and later serve the encrypted blob.
 *
 * All encryption fields (encryptionKey, encryptionIv, thumbnail*) contain
 * base64-encoded values produced by the client-side Signal Protocol wrapper.
 * The server never decrypts media — it stores ciphertext blobs verbatim (R12).
 */
export interface UploadMediaDTO {
  /** Category of the media being uploaded */
  type: MediaType;

  /**
   * Declared MIME type of the original (pre-encryption) file.
   * Server verifies this against {@link ALLOWED_MIME_TYPES} (R8).
   */
  mimeType: string;

  /** Original filename as reported by the client file picker */
  fileName: string;

  /**
   * Size of the encrypted payload in bytes.
   * Server enforces that this does not exceed {@link MAX_FILE_SIZE} (R8).
   */
  fileSize: number;

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

  /** Associated message ID (set when media is attached to a message) */
  messageId?: string;

  /** Associated story ID (set when media is used in a story) */
  storyId?: string;

  /**
   * Whether the upload includes a separate thumbnail blob (R27).
   * Should be `true` for IMAGE type; ignored for other types.
   */
  hasThumbnail: boolean;

  /**
   * Separate AES key for the thumbnail, encrypted per-recipient (R27).
   * Required when {@link hasThumbnail} is `true`.
   */
  thumbnailEncryptionKey?: string;

  /**
   * Separate initialization vector for the thumbnail (R27).
   * Required when {@link hasThumbnail} is `true`.
   */
  thumbnailEncryptionIv?: string;

  /** Original image or video width in pixels (before encryption) */
  width?: number;

  /** Original image or video height in pixels (before encryption) */
  height?: number;

  /** Duration in seconds — applicable to VIDEO and VOICE_NOTE types */
  duration?: number;

  /**
   * Waveform amplitude samples for voice notes.
   * Each value is a normalized float in the range [0.0, 1.0].
   * Generated client-side via Web Audio API before encryption.
   */
  waveform?: number[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: Response Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metadata describing a client-generated thumbnail (R27).
 *
 * Thumbnails are encrypted separately from the full-size image and
 * uploaded as distinct blobs. Both width and height are constrained
 * to {@link MAX_THUMBNAIL_DIMENSION} (200 px longest edge).
 */
export interface ThumbnailMetadata {
  /** URL to download the encrypted thumbnail blob */
  url: string;

  /** Thumbnail width in pixels (≤ {@link MAX_THUMBNAIL_DIMENSION}) */
  width: number;

  /** Thumbnail height in pixels (≤ {@link MAX_THUMBNAIL_DIMENSION}) */
  height: number;

  /** AES decryption key for the thumbnail — base64-encoded */
  encryptionKey: string;

  /** Initialization vector for thumbnail decryption — base64-encoded */
  encryptionIv: string;
}

/**
 * Full media representation returned from the REST API.
 *
 * Contains all metadata needed by a client to download, decrypt, and
 * render a media attachment. The `url` points to an encrypted blob;
 * decryption requires `encryptionKey` and `encryptionIv` which are
 * delivered encrypted per-recipient via the Signal Protocol session.
 */
export interface MediaResponse {
  /** Unique media identifier (UUID v4) */
  id: string;

  /** User ID of the uploader */
  uploaderId: string;

  /** Category of media content */
  type: MediaType;

  /** MIME type of the original (pre-encryption) file */
  mimeType: string;

  /** Original filename */
  fileName: string;

  /** Size of the encrypted blob in bytes */
  fileSize: number;

  /** URL to download the encrypted media blob */
  url: string;

  /**
   * AES key to decrypt the media, encrypted per-recipient
   * via Signal Protocol session. Base64-encoded.
   */
  encryptionKey: string;

  /** Initialization vector for media decryption. Base64-encoded. */
  encryptionIv: string;

  /**
   * Thumbnail metadata, present for IMAGE type per R27.
   * Undefined for VIDEO, DOCUMENT, and VOICE_NOTE types.
   */
  thumbnail?: ThumbnailMetadata;

  /** Original image or video width in pixels */
  width?: number;

  /** Original image or video height in pixels */
  height?: number;

  /** Duration in seconds for VIDEO and VOICE_NOTE types */
  duration?: number;

  /**
   * Waveform amplitude samples for VOICE_NOTE type.
   * Normalized float values in [0.0, 1.0].
   */
  waveform?: number[];

  /** Timestamp when the media was uploaded — ISO 8601 string */
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: Utility Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tracks the client-side lifecycle of a media upload operation.
 *
 * Used by the frontend `useMediaUpload` hook and `chatStore` to display
 * progress indicators during the encrypt → upload → complete pipeline.
 *
 * Status transitions: encrypting → uploading → complete | error
 */
export interface MediaUploadProgress {
  /**
   * Server-assigned media ID. Populated after the upload completes
   * successfully; undefined during encrypting/uploading phases.
   */
  mediaId?: string;

  /** Original filename for display in the upload progress UI */
  fileName: string;

  /** Category of media being uploaded */
  type: MediaType;

  /**
   * Upload progress percentage in the range [0, 100].
   * During the "encrypting" phase this reflects encryption progress;
   * during "uploading" it reflects network transfer progress.
   */
  progress: number;

  /**
   * Current phase of the upload lifecycle:
   * - `encrypting`  — client is encrypting the file
   * - `uploading`   — encrypted blob is being transferred to the server
   * - `complete`    — upload succeeded, `mediaId` is populated
   * - `error`       — an unrecoverable error occurred, see `error` field
   */
  status: 'encrypting' | 'uploading' | 'complete' | 'error';

  /** Human-readable error message when status is `'error'` */
  error?: string;
}
