/**
 * @module apps/api/src/domain/models/Media
 * @description Media domain model implementing MIME type validation, file size enforcement,
 * type guards, thumbnail checks, and encryption metadata validation.
 *
 * This is a rich domain model (R16: OOD Layering) — NOT an anemic data bag.
 * It encapsulates all media-related business rules:
 *
 * - R8:  Server-side MIME allowlist verification and 25 MB upload limit
 * - R12: Encryption metadata validation (client-side E2E encryption)
 * - R27: Client-side thumbnail requirement for IMAGE type (max 200 px)
 * - R17: Zero Prisma imports — pure TypeScript, ORM-agnostic
 * - R28: Zero console.log — structured logging only
 * - R7:  Strict TypeScript with zero warnings
 */

import { randomUUID } from 'node:crypto';
import {
  MediaType,
  type MediaResponse,
  type ThumbnailMetadata,
  SIZE_LIMITS,
  MIME_TYPES,
  ALL_ALLOWED_MIME_TYPES,
} from '@kalle/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Exported Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metadata for a client-generated encrypted thumbnail (R27).
 *
 * Thumbnails are encrypted separately from the full-size image and
 * uploaded as distinct blobs. Both dimensions are constrained to
 * SIZE_LIMITS.THUMBNAIL_MAX_DIMENSION_PX (200 px longest edge).
 */
export interface ThumbnailInfo {
  /** URL to the encrypted thumbnail blob */
  url: string;
  /** Thumbnail width in pixels (≤ 200 px) */
  width: number;
  /** Thumbnail height in pixels (≤ 200 px) */
  height: number;
  /** AES decryption key for the thumbnail — base64-encoded (R27: encrypted separately) */
  encryptionKey: string;
  /** Initialization vector for thumbnail decryption — base64-encoded */
  encryptionIv: string;
}

/**
 * Construction properties for the Media domain model.
 *
 * Used by the constructor to hydrate an instance from persistence
 * (repository → domain model reconstitution) or by the static
 * factory method to create new instances with full validation.
 */
export interface MediaProps {
  /** Unique media identifier (UUID v4) */
  id: string;
  /** User ID of the uploader */
  uploaderId: string;
  /** Category of media content */
  type: MediaType;
  /** MIME type of the original (pre-encryption) file */
  mimeType: string;
  /** Original filename as reported by the client */
  fileName: string;
  /** Size of the encrypted blob in bytes */
  fileSize: number;
  /** URL to download the encrypted media blob */
  url: string;
  /** Per-media AES encryption key — base64-encoded */
  encryptionKey: string;
  /** AES initialization vector — base64-encoded */
  encryptionIv: string;
  /** Thumbnail metadata, required for IMAGE type per R27 */
  thumbnail?: ThumbnailInfo;
  /** Original image/video width in pixels */
  width?: number;
  /** Original image/video height in pixels */
  height?: number;
  /** Duration in seconds (VIDEO/VOICE_NOTE) */
  duration?: number;
  /** Voice note waveform amplitude samples [0.0, 1.0] */
  waveform?: number[];
  /** Associated message ID */
  messageId?: string;
  /** Associated story ID */
  storyId?: string;
  /** Timestamp when the media was uploaded */
  createdAt: Date;
  /** Timestamp of last update */
  updatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps each MediaType to the corresponding key in the MIME_TYPES constant
 * from @kalle/shared. VOICE_NOTE maps to AUDIO because voice notes use
 * audio MIME types (audio/ogg, audio/webm, etc.).
 */
const MEDIA_TYPE_TO_MIME_CATEGORY: Record<MediaType, keyof typeof MIME_TYPES> = {
  [MediaType.IMAGE]: 'IMAGE',
  [MediaType.VIDEO]: 'VIDEO',
  [MediaType.DOCUMENT]: 'DOCUMENT',
  [MediaType.VOICE_NOTE]: 'AUDIO',
};

// ─────────────────────────────────────────────────────────────────────────────
// Media Domain Model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rich domain model for media attachments.
 *
 * Encapsulates all business rules for media processing:
 * - MIME type validation against the server allowlist (R8)
 * - File size enforcement (25 MB maximum — R8)
 * - Encryption metadata integrity checks (R12)
 * - Thumbnail requirement for IMAGE type (R27)
 * - Waveform requirement for VOICE_NOTE type
 *
 * This class has zero I/O — no database, HTTP, or filesystem operations.
 * All persistence is handled by the repository layer.
 */
export class Media {
  // ─── Private Readonly Fields ─────────────────────────────────────────────
  private readonly _id: string;
  private readonly _uploaderId: string;
  private readonly _type: MediaType;
  private readonly _mimeType: string;
  private readonly _fileName: string;
  private readonly _fileSize: number;
  private readonly _url: string;
  private readonly _encryptionKey: string;
  private readonly _encryptionIv: string;
  private readonly _thumbnail: ThumbnailInfo | undefined;
  private readonly _width: number | undefined;
  private readonly _height: number | undefined;
  private readonly _duration: number | undefined;
  private readonly _waveform: number[] | undefined;
  private readonly _messageId: string | undefined;
  private readonly _storyId: string | undefined;
  private readonly _createdAt: Date;
  private readonly _updatedAt: Date;

  /**
   * Constructs a Media instance from the given properties.
   *
   * Prefer using the static {@link create} factory for new uploads
   * (which performs full validation). The constructor is intentionally
   * public for repository reconstitution of existing records.
   */
  constructor(props: MediaProps) {
    this._id = props.id;
    this._uploaderId = props.uploaderId;
    this._type = props.type;
    this._mimeType = props.mimeType;
    this._fileName = props.fileName;
    this._fileSize = props.fileSize;
    this._url = props.url;
    this._encryptionKey = props.encryptionKey;
    this._encryptionIv = props.encryptionIv;
    this._thumbnail = props.thumbnail
      ? { ...props.thumbnail }
      : undefined;
    this._width = props.width;
    this._height = props.height;
    this._duration = props.duration;
    this._waveform = props.waveform ? [...props.waveform] : undefined;
    this._messageId = props.messageId;
    this._storyId = props.storyId;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  // ─── Getter Accessors (Encapsulation) ──────────────────────────────────────

  get id(): string { return this._id; }
  get uploaderId(): string { return this._uploaderId; }
  get type(): MediaType { return this._type; }
  get mimeType(): string { return this._mimeType; }
  get fileName(): string { return this._fileName; }
  get fileSize(): number { return this._fileSize; }
  get url(): string { return this._url; }
  get encryptionKey(): string { return this._encryptionKey; }
  get encryptionIv(): string { return this._encryptionIv; }

  /** Returns a defensive copy of the thumbnail metadata, or undefined */
  get thumbnail(): ThumbnailInfo | undefined {
    return this._thumbnail ? { ...this._thumbnail } : undefined;
  }

  get width(): number | undefined { return this._width; }
  get height(): number | undefined { return this._height; }
  get duration(): number | undefined { return this._duration; }

  /** Returns a defensive copy of the waveform array, or undefined */
  get waveform(): number[] | undefined {
    return this._waveform ? [...this._waveform] : undefined;
  }

  get messageId(): string | undefined { return this._messageId; }
  get storyId(): string | undefined { return this._storyId; }
  get createdAt(): Date { return this._createdAt; }
  get updatedAt(): Date { return this._updatedAt; }

  // ─── Static Factory Method ─────────────────────────────────────────────────

  /**
   * Creates a new Media instance with full validation.
   *
   * Enforces:
   * - MIME type validation against the allowlist (R8)
   * - File size ≤ 25 MB (R8)
   * - Non-empty encryption metadata (R12)
   * - Thumbnail required for IMAGE type (R27)
   * - Waveform required for VOICE_NOTE type
   *
   * @throws {Error} If any validation check fails
   */
  static create(dto: {
    uploaderId: string;
    type: MediaType;
    mimeType: string;
    fileName: string;
    fileSize: number;
    url: string;
    encryptionKey: string;
    encryptionIv: string;
    thumbnail?: ThumbnailInfo;
    width?: number;
    height?: number;
    duration?: number;
    waveform?: number[];
    messageId?: string;
    storyId?: string;
  }): Media {
    // Validate required string fields are non-empty
    if (!dto.uploaderId || dto.uploaderId.trim().length === 0) {
      throw new Error('Uploader ID is required and cannot be empty');
    }
    if (!dto.fileName || dto.fileName.trim().length === 0) {
      throw new Error('File name is required and cannot be empty');
    }

    // R8: MIME type must be in the server-side allowlist
    Media.validateMimeType(dto.mimeType, dto.type);

    // R8: File size must not exceed 25 MB
    Media.validateFileSize(dto.fileSize);

    // R12: Encryption metadata is mandatory — media must be encrypted client-side
    if (!dto.encryptionKey || dto.encryptionKey.trim().length === 0) {
      throw new Error(
        'Encryption key is required — media must be encrypted client-side before upload (R12)',
      );
    }
    if (!dto.encryptionIv || dto.encryptionIv.trim().length === 0) {
      throw new Error(
        'Encryption IV is required — media must be encrypted client-side before upload (R12)',
      );
    }

    // R27: IMAGE type requires a client-generated thumbnail
    if (dto.type === MediaType.IMAGE) {
      if (!dto.thumbnail) {
        throw new Error(
          'Thumbnail is required for IMAGE type — client must generate thumbnail before encryption (R27)',
        );
      }
    }

    // VOICE_NOTE type requires waveform data for playback visualization
    if (dto.type === MediaType.VOICE_NOTE) {
      if (!dto.waveform || !Array.isArray(dto.waveform) || dto.waveform.length === 0) {
        throw new Error(
          'Waveform data is required for VOICE_NOTE type — client must generate waveform before upload',
        );
      }
    }

    const now = new Date();

    return new Media({
      id: randomUUID(),
      uploaderId: dto.uploaderId,
      type: dto.type,
      mimeType: dto.mimeType,
      fileName: dto.fileName,
      fileSize: dto.fileSize,
      url: dto.url,
      encryptionKey: dto.encryptionKey,
      encryptionIv: dto.encryptionIv,
      thumbnail: dto.thumbnail,
      width: dto.width,
      height: dto.height,
      duration: dto.duration,
      waveform: dto.waveform,
      messageId: dto.messageId,
      storyId: dto.storyId,
      createdAt: now,
      updatedAt: now,
    });
  }

  // ─── Static Validation Methods ─────────────────────────────────────────────

  /**
   * Validates a MIME type against the allowlist for the given media category (R8).
   *
   * Performs a two-tier check:
   * 1. Category-specific check (e.g., IMAGE → MIME_TYPES.IMAGE)
   * 2. Global allowlist check (ALL_ALLOWED_MIME_TYPES) as defense-in-depth
   *
   * @throws {Error} If the MIME type is not in the category list or global allowlist
   */
  static validateMimeType(mimeType: string, type: MediaType): void {
    if (!mimeType || mimeType.trim().length === 0) {
      throw new Error('MIME type is required and cannot be empty');
    }

    const normalizedMime = mimeType.trim().toLowerCase();

    // Tier 1: Category-specific validation
    const mimeCategory = MEDIA_TYPE_TO_MIME_CATEGORY[type];
    const categoryList = MIME_TYPES[mimeCategory] as readonly string[];

    if (!categoryList.includes(normalizedMime)) {
      throw new Error(
        `Unsupported MIME type '${normalizedMime}' for media type ${type}. ` +
        `Allowed types: ${categoryList.join(', ')}`,
      );
    }

    // Tier 2: Global allowlist defense-in-depth
    if (!(ALL_ALLOWED_MIME_TYPES as readonly string[]).includes(normalizedMime)) {
      throw new Error(
        `MIME type '${normalizedMime}' is not in the global allowlist`,
      );
    }
  }

  /**
   * Validates file size against the 25 MB upload limit (R8).
   *
   * Boundary behavior: exactly 25 MB (26,214,400 bytes) is allowed.
   * One byte over (26,214,401) is rejected.
   *
   * @throws {Error} If file size is non-positive or exceeds the limit
   */
  static validateFileSize(fileSize: number): void {
    if (fileSize <= 0) {
      throw new Error('File size must be positive');
    }
    if (fileSize > SIZE_LIMITS.MAX_UPLOAD_BYTES) {
      throw new Error(
        `File size ${fileSize} bytes exceeds maximum allowed size of ` +
        `${SIZE_LIMITS.MAX_UPLOAD_BYTES} bytes (25MB)`,
      );
    }
  }

  // ─── Instance Validation Methods ───────────────────────────────────────────

  /**
   * Validates thumbnail metadata constraints (R27).
   *
   * Checks that dimensions do not exceed THUMBNAIL_MAX_DIMENSION_PX (200 px)
   * and that the thumbnail has its own separate encryption metadata.
   * Only applicable for IMAGE type; non-IMAGE types return immediately.
   *
   * @throws {Error} If thumbnail dimensions or encryption metadata are invalid
   */
  validateThumbnail(): void {
    if (this._type !== MediaType.IMAGE) {
      return;
    }

    if (!this._thumbnail) {
      return;
    }

    const maxDim = SIZE_LIMITS.THUMBNAIL_MAX_DIMENSION_PX;

    if (this._thumbnail.width > maxDim) {
      throw new Error(
        `Thumbnail width ${this._thumbnail.width}px exceeds maximum of ${maxDim}px`,
      );
    }

    if (this._thumbnail.height > maxDim) {
      throw new Error(
        `Thumbnail height ${this._thumbnail.height}px exceeds maximum of ${maxDim}px`,
      );
    }

    if (!this._thumbnail.encryptionKey || this._thumbnail.encryptionKey.trim().length === 0) {
      throw new Error(
        'Thumbnail encryption key is required — thumbnail must be encrypted separately (R27)',
      );
    }

    if (!this._thumbnail.encryptionIv || this._thumbnail.encryptionIv.trim().length === 0) {
      throw new Error(
        'Thumbnail encryption IV is required — thumbnail must be encrypted separately (R27)',
      );
    }
  }

  /**
   * Validates encryption metadata for both the main media and its thumbnail (R12, R27).
   *
   * Ensures the main media has a non-empty encryptionKey and encryptionIv.
   * If a thumbnail is present, also ensures the thumbnail has its own separate
   * encryption metadata (R27: encrypted separately from the full-size image).
   *
   * @throws {Error} If any encryption metadata is missing or empty
   */
  validateEncryptionMetadata(): void {
    if (!this._encryptionKey || this._encryptionKey.trim().length === 0) {
      throw new Error('Media encryption key is required (R12)');
    }

    if (!this._encryptionIv || this._encryptionIv.trim().length === 0) {
      throw new Error('Media encryption IV is required (R12)');
    }

    // R27: Thumbnail has its own separate encryption — verify if present
    if (this._thumbnail) {
      if (!this._thumbnail.encryptionKey || this._thumbnail.encryptionKey.trim().length === 0) {
        throw new Error(
          'Thumbnail must have its own encryption key — encrypted separately from main media (R27)',
        );
      }

      if (!this._thumbnail.encryptionIv || this._thumbnail.encryptionIv.trim().length === 0) {
        throw new Error(
          'Thumbnail must have its own encryption IV — encrypted separately from main media (R27)',
        );
      }
    }
  }

  // ─── Type Guard Methods ────────────────────────────────────────────────────

  /** Returns true if this media is an image (JPEG, PNG, GIF, WebP, HEIC, HEIF) */
  isImage(): boolean {
    return this._type === MediaType.IMAGE;
  }

  /** Returns true if this media is a video (MP4, WebM, QuickTime, 3GPP) */
  isVideo(): boolean {
    return this._type === MediaType.VIDEO;
  }

  /** Returns true if this media is a document (PDF, Office, text, etc.) */
  isDocument(): boolean {
    return this._type === MediaType.DOCUMENT;
  }

  /** Returns true if this media is a voice note (audio recording) */
  isVoiceNote(): boolean {
    return this._type === MediaType.VOICE_NOTE;
  }

  /**
   * Returns true if this media has thumbnail metadata.
   * For IMAGE types created via the factory, this is always true (R27).
   */
  hasThumbnail(): boolean {
    return this._thumbnail !== undefined && this._thumbnail !== null;
  }

  /**
   * Returns true if this media has non-empty waveform data.
   * Relevant for VOICE_NOTE type.
   */
  hasWaveform(): boolean {
    return (
      this._waveform !== undefined &&
      this._waveform !== null &&
      Array.isArray(this._waveform) &&
      this._waveform.length > 0
    );
  }

  /** Returns true if this media is associated with a message */
  isAssociatedWithMessage(): boolean {
    return this._messageId !== undefined && this._messageId !== null;
  }

  /** Returns true if this media is associated with a story */
  isAssociatedWithStory(): boolean {
    return this._storyId !== undefined && this._storyId !== null;
  }

  // ─── Utility Methods ───────────────────────────────────────────────────────

  /**
   * Returns a human-readable formatted file size string.
   *
   * @example "500 B", "1.5 KB", "25.0 MB"
   */
  getFileSizeFormatted(): string {
    const bytes = this._fileSize;

    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Returns the dimensions as a "WxH" string, or undefined if dimensions are not set.
   *
   * @example "1920x1080"
   */
  getDimensionsString(): string | undefined {
    if (this._width !== undefined && this._height !== undefined) {
      return `${this._width}x${this._height}`;
    }
    return undefined;
  }

  /**
   * Returns the duration formatted as "M:SS", or undefined if no duration is set.
   *
   * @example "1:05" for 65 seconds, "0:14" for 14 seconds
   */
  getDurationFormatted(): string | undefined {
    if (this._duration === undefined) {
      return undefined;
    }

    const totalSeconds = Math.floor(this._duration);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  // ─── Serialization ─────────────────────────────────────────────────────────

  /**
   * Converts the domain model to a plain response object matching
   * the MediaResponse interface from @kalle/shared.
   *
   * Date fields are serialized to ISO 8601 strings.
   * Thumbnail is mapped to ThumbnailMetadata format.
   */
  toResponse(): MediaResponse {
    const thumbnail: ThumbnailMetadata | undefined = this._thumbnail
      ? {
          url: this._thumbnail.url,
          width: this._thumbnail.width,
          height: this._thumbnail.height,
          encryptionKey: this._thumbnail.encryptionKey,
          encryptionIv: this._thumbnail.encryptionIv,
        }
      : undefined;

    return {
      id: this._id,
      uploaderId: this._uploaderId,
      type: this._type,
      mimeType: this._mimeType,
      fileName: this._fileName,
      fileSize: this._fileSize,
      url: this._url,
      encryptionKey: this._encryptionKey,
      encryptionIv: this._encryptionIv,
      thumbnail,
      width: this._width,
      height: this._height,
      duration: this._duration,
      waveform: this._waveform ? [...this._waveform] : undefined,
      createdAt: this._createdAt.toISOString(),
    };
  }
}
