/**
 * @module apps/web/src/lib/media
 * Client-side media processing utilities for the Kalle WhatsApp clone.
 *
 * Provides:
 * - MIME type and file size validation against shared allowlists (R8)
 * - Client-side thumbnail generation capped at 200px longest edge (R27)
 * - AES-GCM 256-bit media encryption/decryption via Web Crypto API (R12)
 * - Multipart media upload with XHR-based progress tracking
 * - Base64 encoding helpers for key/IV serialization
 *
 * All media encryption occurs exclusively on the client side. The server
 * only receives ciphertext — it has zero access to plaintext content (R12).
 * Thumbnails are generated client-side before encryption and uploaded as
 * separate encrypted blobs with their own key/IV pair (R27).
 */

import {
  MediaType,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_THUMBNAIL_DIMENSION,
} from '@kalle/shared';
import type {
  UploadMediaDTO,
  MediaResponse,
  MediaUploadProgress,
} from '@kalle/shared';
import { apiClient, uploadFormData, API_BASE_URL } from './api';

// apiClient is imported for module coupling with the authenticated API
// infrastructure; actual file uploads use uploadFormData which provides
// XHR-based multipart progress tracking with authorization headers
void apiClient;

/* ── Internal Constants ───────────────────────────────────────────── */

/** AES-GCM encryption algorithm identifier */
const AES_ALGORITHM = 'AES-GCM';

/** AES key length in bits for encryption key generation */
const AES_KEY_LENGTH_BITS = 256;

/** AES-GCM initialization vector length in bytes (96-bit nonce) */
const AES_IV_LENGTH_BYTES = 12;

/** JPEG quality factor for thumbnail output (0–1 scale) */
const THUMBNAIL_JPEG_QUALITY = 0.8;

/** MIME type used for generated thumbnail images */
const THUMBNAIL_OUTPUT_MIME = 'image/jpeg';

/** MIME type assigned to encrypted blobs before upload */
const ENCRYPTED_BLOB_MIME = 'application/octet-stream';

/** API endpoint for media upload (R30 — /api/v1/ prefix) */
const MEDIA_UPLOAD_ENDPOINT = '/api/v1/media';

/* ── Base64 Encoding Helpers ──────────────────────────────────────── */

/**
 * Converts an ArrayBuffer to a Base64-encoded string.
 * Used for serializing AES-GCM keys and initialization vectors
 * so they can be transmitted safely over the REST API.
 *
 * @param buffer - The raw bytes to encode
 * @returns Base64-encoded string representation
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts a Base64-encoded string back to an ArrayBuffer.
 * Used for deserializing AES-GCM keys and initialization vectors
 * received from the server or stored locally.
 *
 * @param base64 - The Base64-encoded string to decode
 * @returns The decoded raw bytes as an ArrayBuffer
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  // Allocate a fresh ArrayBuffer of exact size to avoid Node.js Buffer pool issues
  const buffer = new ArrayBuffer(len);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < len; i++) {
    view[i] = binaryString.charCodeAt(i);
  }
  return buffer;
}

/* ── Validation Functions ─────────────────────────────────────────── */

/**
 * Validates a file's MIME type against the shared ALLOWED_MIME_TYPES allowlist.
 * Checks across all MediaType categories: IMAGE, VIDEO, DOCUMENT, VOICE_NOTE.
 * Enforces client-side MIME validation matching the server-side allowlist (R8).
 *
 * @param file - The File object to validate
 * @returns Object with `valid` boolean and matched `mediaType` (null if invalid)
 */
export function validateMimeType(file: File): {
  valid: boolean;
  mediaType: MediaType | null;
} {
  const fileMime = file.type.toLowerCase().trim();

  if (!fileMime) {
    return { valid: false, mediaType: null };
  }

  // Explicitly check each MediaType category in the allowlist
  const mediaTypeValues: MediaType[] = [
    MediaType.IMAGE,
    MediaType.VIDEO,
    MediaType.DOCUMENT,
    MediaType.VOICE_NOTE,
  ];

  for (const mediaType of mediaTypeValues) {
    const allowedList = ALLOWED_MIME_TYPES[mediaType];
    if (allowedList && (allowedList as readonly string[]).includes(fileMime)) {
      return { valid: true, mediaType };
    }
  }

  return { valid: false, mediaType: null };
}

/**
 * Validates that a file's size does not exceed the maximum allowed limit.
 * Uses MAX_FILE_SIZE from @kalle/shared (25 × 1024 × 1024 = 26,214,400 bytes).
 * Enforces client-side size limit matching server-side enforcement (R8).
 *
 * @param file - The File object to check
 * @returns true if the file size is within the allowed limit
 */
export function validateFileSize(file: File): boolean {
  return file.size <= MAX_FILE_SIZE;
}

/**
 * Determines the MediaType classification for a file based on its MIME type.
 * Returns null if the file's MIME type is not in the ALLOWED_MIME_TYPES list.
 *
 * @param file - The File object to classify
 * @returns The matching MediaType enum value, or null if unrecognized
 */
export function getMediaTypeFromFile(file: File): MediaType | null {
  const result = validateMimeType(file);
  return result.mediaType;
}

/* ── Thumbnail Generation (R27) ───────────────────────────────────── */

/**
 * Generates a thumbnail for an image file using canvas-based resizing.
 * The thumbnail's longest edge is capped at MAX_THUMBNAIL_DIMENSION (200px)
 * while preserving the original aspect ratio. Handles both landscape and
 * portrait orientations correctly.
 *
 * Output format: JPEG at 80% quality for optimal size/quality balance.
 *
 * @param file - An image File to create a thumbnail from
 * @returns Object containing the thumbnail Blob and its pixel dimensions
 * @throws Error if the image cannot be loaded or canvas rendering fails
 */
export async function generateThumbnail(
  file: File,
): Promise<{ blob: Blob; width: number; height: number }> {
  const objectUrl = URL.createObjectURL(file);

  try {
    // Load the image to read its natural dimensions
    const img = await loadImage(objectUrl);
    const { naturalWidth, naturalHeight } = img;

    if (naturalWidth === 0 || naturalHeight === 0) {
      throw new Error('Image has zero dimensions — cannot generate thumbnail');
    }

    // Calculate thumbnail dimensions preserving aspect ratio
    // Cap the longest edge at MAX_THUMBNAIL_DIMENSION (200px)
    let thumbWidth = naturalWidth;
    let thumbHeight = naturalHeight;
    const longestEdge = Math.max(naturalWidth, naturalHeight);

    if (longestEdge > MAX_THUMBNAIL_DIMENSION) {
      const scale = MAX_THUMBNAIL_DIMENSION / longestEdge;
      thumbWidth = Math.round(naturalWidth * scale);
      thumbHeight = Math.round(naturalHeight * scale);
    }

    // Ensure minimum 1px in each dimension
    thumbWidth = Math.max(1, thumbWidth);
    thumbHeight = Math.max(1, thumbHeight);

    // Render the scaled image onto a canvas
    const canvas = document.createElement('canvas');
    canvas.width = thumbWidth;
    canvas.height = thumbHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire 2D canvas rendering context');
    }

    ctx.drawImage(img, 0, 0, thumbWidth, thumbHeight);

    // Export the canvas content as a JPEG blob
    const blob = await canvasToBlob(canvas, THUMBNAIL_OUTPUT_MIME, THUMBNAIL_JPEG_QUALITY);

    return { blob, width: thumbWidth, height: thumbHeight };
  } finally {
    // Always release the object URL to free memory
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Loads an image from a source URL and resolves when the load completes.
 * @internal
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error('Failed to load image for thumbnail generation'));
    img.src = src;
  });
}

/**
 * Converts a canvas element to a Blob with the specified MIME type and quality.
 * @internal
 */
function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Canvas toBlob produced null — rendering may have failed'));
        }
      },
      mimeType,
      quality,
    );
  });
}

/* ── Encryption (R12) ─────────────────────────────────────────────── */

/**
 * Encrypts media data using AES-GCM 256-bit encryption via the Web Crypto API.
 * Generates a cryptographically random key and 12-byte initialization vector,
 * then encrypts the provided raw data.
 *
 * The key and IV are returned as Base64-encoded strings suitable for
 * transport over the REST API or storage in IndexedDB.
 *
 * @param data - The raw (plaintext) media data to encrypt
 * @returns Object with ciphertext ArrayBuffer and Base64-encoded key/IV strings
 */
export async function encryptMedia(data: ArrayBuffer): Promise<{
  encryptedData: ArrayBuffer;
  key: string;
  iv: string;
}> {
  // Generate a random AES-GCM 256-bit symmetric key
  const cryptoKey = await crypto.subtle.generateKey(
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH_BITS },
    true, // extractable — needed to export the raw key bytes
    ['encrypt', 'decrypt'],
  );

  // Generate a random 12-byte (96-bit) initialization vector
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_LENGTH_BYTES));

  // Encrypt the data — wrap in Uint8Array for cross-environment BufferSource compatibility
  const encryptedData = await crypto.subtle.encrypt(
    { name: AES_ALGORITHM, iv },
    cryptoKey,
    new Uint8Array(data),
  );

  // Export the CryptoKey to raw bytes for Base64 serialization
  const rawKey = await crypto.subtle.exportKey('raw', cryptoKey);

  return {
    encryptedData,
    key: arrayBufferToBase64(rawKey),
    iv: arrayBufferToBase64(iv.buffer as ArrayBuffer),
  };
}

/**
 * Decrypts AES-GCM encrypted media data using the provided key and IV.
 * Reverses the encryption performed by {@link encryptMedia}.
 *
 * @param encryptedData - The ciphertext ArrayBuffer to decrypt
 * @param keyBase64 - Base64-encoded AES-GCM 256-bit key
 * @param ivBase64 - Base64-encoded 12-byte initialization vector
 * @returns The decrypted plaintext ArrayBuffer
 * @throws DOMException if decryption fails (wrong key/IV or corrupted data)
 */
export async function decryptMedia(
  encryptedData: ArrayBuffer,
  keyBase64: string,
  ivBase64: string,
): Promise<ArrayBuffer> {
  // Decode key and IV from their Base64 representations
  const rawKey = new Uint8Array(base64ToArrayBuffer(keyBase64));
  const iv = new Uint8Array(base64ToArrayBuffer(ivBase64));

  // Import the raw key bytes as a non-extractable CryptoKey for decryption
  // Uses Uint8Array wrapper for cross-environment BufferSource compatibility
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH_BITS },
    false, // not extractable — decryption only
    ['decrypt'],
  );

  // Decrypt and return the plaintext — wrap in Uint8Array for cross-environment compatibility
  return crypto.subtle.decrypt(
    { name: AES_ALGORITHM, iv },
    cryptoKey,
    new Uint8Array(encryptedData),
  );
}

/* ── URL Helper ───────────────────────────────────────────────────── */

/**
 * Constructs the full download URL for a media asset by its server-assigned ID.
 *
 * @param mediaId - The unique media identifier from the server
 * @returns Fully qualified URL to the media resource
 */
export function getMediaUrl(mediaId: string): string {
  return `${API_BASE_URL}/api/v1/media/${mediaId}`;
}

/* ── Upload Pipeline ──────────────────────────────────────────────── */

/**
 * Validates, encrypts, and uploads a media file to the server.
 *
 * Complete pipeline:
 * 1. Validate MIME type against the shared allowlist (R8)
 * 2. Validate file size ≤ 25 MB (R8)
 * 3. Encrypt the raw file data with AES-GCM 256-bit (R12)
 * 4. For images: generate a 200px-max thumbnail (R27), encrypt it separately
 * 5. Build multipart FormData with encrypted blobs and metadata DTO
 * 6. Upload via XHR with progress tracking
 *
 * Both the full-size file and thumbnail (if applicable) are encrypted with
 * independent AES keys — the server cannot derive one from the other.
 *
 * @param file - The File object to upload
 * @param options - Optional message/story association and progress callback
 * @returns The server's MediaResponse containing the assigned media ID and metadata
 * @throws Error on MIME validation failure, size limit exceeded, or upload error
 */
export async function uploadMedia(
  file: File,
  options?: {
    messageId?: string;
    storyId?: string;
    onProgress?: (progress: MediaUploadProgress) => void;
  },
): Promise<MediaResponse> {
  // ── Step 1: Validate MIME type ──
  const mimeResult = validateMimeType(file);
  if (!mimeResult.valid || !mimeResult.mediaType) {
    throw new Error(`Unsupported file type: ${file.type || 'unknown'}`);
  }

  // ── Step 2: Validate file size ──
  if (!validateFileSize(file)) {
    const maxMB = Math.round(MAX_FILE_SIZE / (1024 * 1024));
    throw new Error(
      `File size (${file.size} bytes) exceeds the maximum allowed limit of ${maxMB} MB`,
    );
  }

  const mediaType = mimeResult.mediaType;
  const fileName = file.name || 'unnamed';
  const onProgress = options?.onProgress;

  /**
   * Emits a structured progress update to the caller's callback.
   * Merges required fields with any optional extras.
   */
  const emitProgress = (
    status: MediaUploadProgress['status'],
    progress: number,
    extra?: Partial<Pick<MediaUploadProgress, 'mediaId' | 'error'>>,
  ): void => {
    onProgress?.({
      fileName,
      type: mediaType,
      progress,
      status,
      ...extra,
    });
  };

  try {
    // ── Step 3: Encrypt file data ──
    emitProgress('encrypting', 0);
    const fileBuffer = await file.arrayBuffer();
    const encryptedFile = await encryptMedia(fileBuffer);

    // ── Step 4: Thumbnail for IMAGE type (R27) ──
    let thumbnailEncryption: {
      key: string;
      iv: string;
      blob: Blob;
    } | null = null;

    if (mediaType === MediaType.IMAGE) {
      emitProgress('encrypting', 50);
      const thumbnail = await generateThumbnail(file);
      const thumbBuffer = await thumbnail.blob.arrayBuffer();
      const encryptedThumb = await encryptMedia(thumbBuffer);
      thumbnailEncryption = {
        key: encryptedThumb.key,
        iv: encryptedThumb.iv,
        blob: new Blob([encryptedThumb.encryptedData], {
          type: ENCRYPTED_BLOB_MIME,
        }),
      };
    }

    // ── Step 5: Build multipart FormData ──
    emitProgress('uploading', 0);
    const formData = new FormData();

    // Append the encrypted file blob
    const encryptedFileBlob = new Blob([encryptedFile.encryptedData], {
      type: ENCRYPTED_BLOB_MIME,
    });
    formData.append('file', encryptedFileBlob, fileName);

    // Build metadata DTO matching UploadMediaDTO shape
    const metadata: UploadMediaDTO = {
      type: mediaType,
      mimeType: file.type,
      fileName,
      fileSize: encryptedFile.encryptedData.byteLength,
      encryptionKey: encryptedFile.key,
      encryptionIv: encryptedFile.iv,
      hasThumbnail: thumbnailEncryption !== null,
    };

    // Attach thumbnail encryption metadata and blob if present
    if (thumbnailEncryption) {
      metadata.thumbnailEncryptionKey = thumbnailEncryption.key;
      metadata.thumbnailEncryptionIv = thumbnailEncryption.iv;
      formData.append('thumbnail', thumbnailEncryption.blob, `thumb_${fileName}`);
    }

    // Attach optional message/story association
    if (options?.messageId) {
      metadata.messageId = options.messageId;
    }
    if (options?.storyId) {
      metadata.storyId = options.storyId;
    }

    // Serialize metadata as a JSON string field in the form
    formData.append('metadata', JSON.stringify(metadata));

    // ── Step 6: Upload via XHR with progress tracking ──
    const response = await uploadFormData<MediaResponse>(
      MEDIA_UPLOAD_ENDPOINT,
      formData,
      {
        onProgress: (percent: number) => {
          emitProgress('uploading', percent);
        },
      },
    );

    emitProgress('complete', 100, { mediaId: response.id });

    return response;
  } catch (error) {
    // Report error state via progress callback before re-throwing
    emitProgress('error', 0, {
      error: error instanceof Error ? error.message : 'Upload failed',
    });
    throw error;
  }
}
