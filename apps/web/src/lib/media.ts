/**
 * @file media.ts
 * @description Client-side media processing library for the Kalle WhatsApp clone.
 *
 * Implements the complete client-side media pipeline:
 *   1. MIME type detection and validation against the shared allowlist (R8)
 *   2. Client-side thumbnail generation with max 200px longest edge (R27)
 *   3. Client-side AES-GCM encryption of media files before upload (R12)
 *   4. Multipart upload with progress tracking via XMLHttpRequest
 *   5. File size enforcement (25 MB limit, R8)
 *
 * Architecture Rules Enforced:
 *   R8  — Media upload validation: 25 MB limit + MIME allowlist enforcement
 *   R12 — E2E encryption integrity: all media encrypted client-side before upload
 *   R27 — Client-side thumbnail generation: max 200px longest edge, encrypted
 *         separately, uploaded as distinct blob
 *   R23 — Log hygiene: no encryption keys or sensitive data in console output
 *   R7  — Zero warnings build: strict TypeScript, no implicit any
 *
 * Dependencies:
 *   - @kalle/shared/types/media: MediaType, UploadMediaDTO, MediaResponse,
 *     ALLOWED_MIME_TYPES, MAX_FILE_SIZE, MAX_THUMBNAIL_DIMENSION,
 *     MediaUploadProgress
 *   - ./api: uploadFormData for network transfer with progress
 */

import {
  MediaType,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_THUMBNAIL_DIMENSION,
} from '@kalle/shared/types/media';
import type {
  UploadMediaDTO,
  MediaResponse,
  MediaUploadProgress,
} from '@kalle/shared/types/media';
import { uploadFormData } from './api';

// =============================================================================
// Constants
// =============================================================================

/** AES-GCM key length in bits for media encryption */
const AES_KEY_LENGTH = 256;

/** AES-GCM IV length in bytes (96 bits, NIST recommended for GCM) */
const AES_IV_LENGTH = 12;

/** AES-GCM algorithm identifier for Web Crypto API */
const AES_ALGORITHM = 'AES-GCM';

/** JPEG quality for thumbnail generation (0.0–1.0) */
const THUMBNAIL_JPEG_QUALITY = 0.7;

/** MIME type used for generated thumbnails */
const THUMBNAIL_MIME_TYPE = 'image/jpeg';

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Result of client-side AES-GCM encryption of a single blob.
 * Contains the encrypted data and the key material needed for decryption.
 */
export interface EncryptedBlob {
  /** Encrypted binary data */
  data: ArrayBuffer;

  /** Base64-encoded AES-GCM key used for encryption */
  key: string;

  /** Base64-encoded initialization vector used for encryption */
  iv: string;
}

/**
 * Result of client-side thumbnail generation (R27).
 * The thumbnail blob is the raw (unencrypted) thumbnail image data.
 */
export interface ThumbnailResult {
  /** Raw thumbnail image blob (JPEG) */
  blob: Blob;

  /** Thumbnail width in pixels (≤ MAX_THUMBNAIL_DIMENSION) */
  width: number;

  /** Thumbnail height in pixels (≤ MAX_THUMBNAIL_DIMENSION) */
  height: number;
}

/**
 * Callback type for reporting upload progress changes.
 * Called during both encryption and upload phases.
 */
export type ProgressCallback = (progress: MediaUploadProgress) => void;

/**
 * Options for the processAndUploadMedia function.
 */
export interface MediaUploadOptions {
  /** Callback invoked on progress changes during encryption and upload */
  onProgress?: ProgressCallback;

  /** Associated message ID (when attaching media to a message) */
  messageId?: string;

  /** Associated story ID (when attaching media to a story) */
  storyId?: string;
}

// =============================================================================
// MIME Type Validation (R8)
// =============================================================================

/**
 * Determines the MediaType category for a given MIME type string.
 *
 * Checks the MIME type against the shared ALLOWED_MIME_TYPES allowlist.
 * Returns the matching MediaType if found, or null if the MIME type is
 * not in the allowlist.
 *
 * @param mimeType - The MIME type string to classify (e.g., 'image/jpeg').
 * @returns The matching MediaType enum value, or null if not allowed.
 *
 * @example
 * ```typescript
 * detectMediaType('image/jpeg');   // MediaType.IMAGE
 * detectMediaType('video/mp4');    // MediaType.VIDEO
 * detectMediaType('text/html');    // null (not in allowlist)
 * ```
 */
export function detectMediaType(mimeType: string): MediaType | null {
  const normalizedMime = mimeType.toLowerCase().trim();

  for (const [type, mimes] of Object.entries(ALLOWED_MIME_TYPES)) {
    if ((mimes as readonly string[]).includes(normalizedMime)) {
      return type as MediaType;
    }
  }

  return null;
}

/**
 * Validates whether a file is eligible for upload based on MIME type
 * and file size constraints (R8).
 *
 * @param file - The File object to validate.
 * @returns An object with `valid` boolean and optional `error` message.
 *
 * @example
 * ```typescript
 * const result = validateFile(myFile);
 * if (!result.valid) {
 *   showError(result.error);
 * }
 * ```
 */
export function validateFile(file: File): { valid: boolean; error?: string } {
  // R8: Check file size against 25 MB limit
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `File size (${sizeMB} MB) exceeds the maximum allowed size of 25 MB`,
    };
  }

  // R8: Check MIME type against allowlist
  const mediaType = detectMediaType(file.type);
  if (mediaType === null) {
    return {
      valid: false,
      error: `File type "${file.type}" is not supported. Allowed types: images, videos, documents, and audio files.`,
    };
  }

  return { valid: true };
}

// =============================================================================
// Thumbnail Generation (R27)
// =============================================================================

/**
 * Generates a thumbnail for an image file with the longest edge capped at
 * MAX_THUMBNAIL_DIMENSION (200px) per R27.
 *
 * The thumbnail is generated entirely client-side using a canvas element.
 * Both the thumbnail and full-size image are encrypted separately and
 * uploaded as distinct blobs. The server performs no image processing.
 *
 * @param file - The original image File to generate a thumbnail from.
 * @returns A ThumbnailResult containing the thumbnail blob and dimensions.
 * @throws Error if the image cannot be loaded or the canvas fails to produce output.
 *
 * @example
 * ```typescript
 * const file = inputElement.files[0];
 * const thumbnail = await generateThumbnail(file);
 * // thumbnail.blob is a JPEG Blob, thumbnail.width/height are constrained
 * ```
 */
export async function generateThumbnail(file: File): Promise<ThumbnailResult> {
  return new Promise<ThumbnailResult>((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = (): void => {
      URL.revokeObjectURL(objectUrl);

      const { naturalWidth: origWidth, naturalHeight: origHeight } = img;

      if (origWidth === 0 || origHeight === 0) {
        reject(new Error('Image has zero dimensions'));
        return;
      }

      // Calculate scaled dimensions: longest edge ≤ MAX_THUMBNAIL_DIMENSION
      let thumbWidth: number;
      let thumbHeight: number;

      if (origWidth >= origHeight) {
        // Landscape or square: constrain width
        thumbWidth = Math.min(origWidth, MAX_THUMBNAIL_DIMENSION);
        thumbHeight = Math.round((origHeight / origWidth) * thumbWidth);
      } else {
        // Portrait: constrain height
        thumbHeight = Math.min(origHeight, MAX_THUMBNAIL_DIMENSION);
        thumbWidth = Math.round((origWidth / origHeight) * thumbHeight);
      }

      // Ensure minimum 1px dimensions
      thumbWidth = Math.max(1, thumbWidth);
      thumbHeight = Math.max(1, thumbHeight);

      // Render thumbnail on an offscreen canvas
      const canvas = document.createElement('canvas');
      canvas.width = thumbWidth;
      canvas.height = thumbHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to create canvas 2D context'));
        return;
      }

      // Draw the source image scaled to thumbnail dimensions
      ctx.drawImage(img, 0, 0, thumbWidth, thumbHeight);

      // Export as JPEG blob
      canvas.toBlob(
        (blob: Blob | null): void => {
          if (!blob) {
            reject(new Error('Canvas toBlob produced null output'));
            return;
          }

          resolve({
            blob,
            width: thumbWidth,
            height: thumbHeight,
          });
        },
        THUMBNAIL_MIME_TYPE,
        THUMBNAIL_JPEG_QUALITY,
      );
    };

    img.onerror = (): void => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load image for thumbnail generation'));
    };

    img.src = objectUrl;
  });
}

/**
 * Extracts the natural dimensions of an image file without modifying it.
 *
 * @param file - The image File to measure.
 * @returns An object with `width` and `height` in pixels.
 */
export async function getImageDimensions(
  file: File,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = (): void => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };

    img.onerror = (): void => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load image for dimension extraction'));
    };

    img.src = objectUrl;
  });
}

// =============================================================================
// Client-Side AES-GCM Encryption (R12)
// =============================================================================

/**
 * Generates a random AES-GCM key and initialization vector for media encryption.
 *
 * The key is generated via Web Crypto API (crypto.subtle.generateKey) with
 * AES-GCM algorithm and 256-bit key length. The IV is 12 bytes (96 bits),
 * which is the NIST-recommended length for GCM.
 *
 * @returns An object containing the CryptoKey and raw IV.
 */
async function generateEncryptionMaterial(): Promise<{
  key: CryptoKey;
  iv: Uint8Array;
}> {
  const key = await crypto.subtle.generateKey(
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH },
    true, // extractable — needed to export for per-recipient encryption
    ['encrypt', 'decrypt'],
  );

  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_LENGTH));

  return { key, iv };
}

/**
 * Exports a CryptoKey to a base64-encoded string for transmission.
 *
 * @param key - The CryptoKey to export (must be extractable).
 * @returns A base64-encoded string of the raw key bytes.
 */
async function exportKeyToBase64(key: CryptoKey): Promise<string> {
  const rawKey = await crypto.subtle.exportKey('raw', key);
  return arrayBufferToBase64(rawKey);
}

/**
 * Converts an ArrayBuffer to a base64-encoded string.
 *
 * @param buffer - The ArrayBuffer to encode.
 * @returns A base64-encoded string representation.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Encrypts a blob (file or thumbnail) using AES-GCM (R12).
 *
 * Generates a fresh AES-256-GCM key and 96-bit IV, encrypts the entire
 * blob contents, and returns the encrypted data along with base64-encoded
 * key material. The key should subsequently be encrypted per-recipient
 * via the Signal Protocol session for secure delivery.
 *
 * @param blob - The file or thumbnail blob to encrypt.
 * @returns An EncryptedBlob containing encrypted data and key material.
 *
 * @example
 * ```typescript
 * const encrypted = await encryptBlob(file);
 * // encrypted.data contains ciphertext
 * // encrypted.key and encrypted.iv are base64-encoded for Signal Protocol wrapping
 * ```
 */
export async function encryptBlob(blob: Blob): Promise<EncryptedBlob> {
  const { key, iv } = await generateEncryptionMaterial();

  // Read blob contents as ArrayBuffer
  const plaintext = await blob.arrayBuffer();

  // Encrypt with AES-GCM
  // Cast iv buffer to ArrayBuffer for TypeScript 5.9 strict BufferSource compatibility
  const ciphertext = await crypto.subtle.encrypt(
    { name: AES_ALGORITHM, iv: iv as Uint8Array<ArrayBuffer> },
    key,
    plaintext,
  );

  // Export key material as base64 for transmission
  const keyBase64 = await exportKeyToBase64(key);
  const ivBase64 = arrayBufferToBase64(iv.buffer as ArrayBuffer);

  return {
    data: ciphertext,
    key: keyBase64,
    iv: ivBase64,
  };
}

/**
 * Decrypts an AES-GCM encrypted blob using the provided key material.
 *
 * @param encryptedData - The encrypted ArrayBuffer to decrypt.
 * @param keyBase64 - Base64-encoded AES-GCM key.
 * @param ivBase64 - Base64-encoded initialization vector.
 * @returns The decrypted data as an ArrayBuffer.
 */
export async function decryptBlob(
  encryptedData: ArrayBuffer,
  keyBase64: string,
  ivBase64: string,
): Promise<ArrayBuffer> {
  // Import the base64-encoded key
  const rawKey = base64ToArrayBuffer(keyBase64);
  const key = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH },
    false,
    ['decrypt'],
  );

  // Decode the IV
  const iv = base64ToArrayBuffer(ivBase64);

  // Decrypt with AES-GCM
  const plaintext = await crypto.subtle.decrypt(
    { name: AES_ALGORITHM, iv: new Uint8Array(iv) },
    key,
    encryptedData,
  );

  return plaintext;
}

/**
 * Converts a base64-encoded string to an ArrayBuffer.
 *
 * @param base64 - The base64-encoded string to decode.
 * @returns The decoded data as an ArrayBuffer.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// =============================================================================
// Full Media Pipeline: Validate → Thumbnail → Encrypt → Upload
// =============================================================================

/**
 * Processes and uploads a media file through the complete client-side pipeline.
 *
 * Pipeline stages:
 *   1. Validate file size (R8: ≤25 MB) and MIME type (R8: allowlist)
 *   2. For images: generate thumbnail (R27: max 200px longest edge)
 *   3. Encrypt full-size file with AES-GCM (R12: client-side encryption)
 *   4. For images: encrypt thumbnail separately (R27: distinct blob)
 *   5. Upload both encrypted blobs via multipart form data with progress tracking
 *
 * @param file - The File to process and upload.
 * @param options - Optional upload configuration (progress callback, message/story ID).
 * @returns The MediaResponse from the server containing download URLs and metadata.
 * @throws Error if validation fails, encryption fails, or upload fails.
 *
 * @example
 * ```typescript
 * const response = await processAndUploadMedia(file, {
 *   onProgress: (progress) => updateUI(progress),
 *   messageId: 'msg-123',
 * });
 * ```
 */
export async function processAndUploadMedia(
  file: File,
  options: MediaUploadOptions = {},
): Promise<MediaResponse> {
  const { onProgress, messageId, storyId } = options;
  const fileName = file.name;

  // ── Stage 1: Validation (R8) ──────────────────────────────────────────
  const validation = validateFile(file);
  if (!validation.valid) {
    const errorProgress: MediaUploadProgress = {
      fileName,
      type: MediaType.DOCUMENT,
      progress: 0,
      status: 'error',
      error: validation.error,
    };
    onProgress?.(errorProgress);
    throw new Error(validation.error);
  }

  const mediaType = detectMediaType(file.type);
  if (mediaType === null) {
    throw new Error(`Unsupported file type: ${file.type}`);
  }

  // Report encryption start
  onProgress?.({
    fileName,
    type: mediaType,
    progress: 0,
    status: 'encrypting',
  });

  // ── Stage 2: Thumbnail generation for images (R27) ────────────────────
  let thumbnail: ThumbnailResult | null = null;
  let encryptedThumbnail: EncryptedBlob | null = null;
  const isImage = mediaType === MediaType.IMAGE;

  if (isImage) {
    thumbnail = await generateThumbnail(file);

    onProgress?.({
      fileName,
      type: mediaType,
      progress: 20,
      status: 'encrypting',
    });

    // Encrypt thumbnail separately (R27: distinct encrypted blob)
    encryptedThumbnail = await encryptBlob(thumbnail.blob);

    onProgress?.({
      fileName,
      type: mediaType,
      progress: 40,
      status: 'encrypting',
    });
  }

  // ── Stage 3: Encrypt full-size file (R12) ─────────────────────────────
  const encryptedFile = await encryptBlob(file);

  onProgress?.({
    fileName,
    type: mediaType,
    progress: isImage ? 60 : 50,
    status: 'encrypting',
  });

  // ── Stage 4: Get image dimensions if applicable ───────────────────────
  let width: number | undefined;
  let height: number | undefined;

  if (isImage) {
    const dims = await getImageDimensions(file);
    width = dims.width;
    height = dims.height;
  }

  // ── Stage 5: Build multipart form data and upload ─────────────────────
  onProgress?.({
    fileName,
    type: mediaType,
    progress: 0,
    status: 'uploading',
  });

  const formData = new FormData();

  // Attach the encrypted full-size file as the primary blob
  const encryptedBlob = new Blob([encryptedFile.data], {
    type: 'application/octet-stream',
  });
  formData.append('file', encryptedBlob, fileName);

  // Build the metadata DTO
  const metadata: UploadMediaDTO = {
    type: mediaType,
    mimeType: file.type,
    fileName,
    fileSize: encryptedFile.data.byteLength,
    encryptionKey: encryptedFile.key,
    encryptionIv: encryptedFile.iv,
    hasThumbnail: isImage && encryptedThumbnail !== null,
    width,
    height,
  };

  // Optional fields
  if (messageId) {
    metadata.messageId = messageId;
  }
  if (storyId) {
    metadata.storyId = storyId;
  }

  // Thumbnail-specific fields (R27)
  if (isImage && encryptedThumbnail && thumbnail) {
    metadata.thumbnailEncryptionKey = encryptedThumbnail.key;
    metadata.thumbnailEncryptionIv = encryptedThumbnail.iv;

    // Attach encrypted thumbnail as a separate form-data part
    const thumbnailBlob = new Blob([encryptedThumbnail.data], {
      type: 'application/octet-stream',
    });
    formData.append('thumbnail', thumbnailBlob, `thumb_${fileName}`);
  }

  // Append metadata as JSON string
  formData.append('metadata', JSON.stringify(metadata));

  // Upload via multipart with progress tracking
  const response = await uploadFormData<{ data: MediaResponse }>(
    '/media/upload',
    formData,
    {
      onProgress: (percent: number): void => {
        onProgress?.({
          fileName,
          type: mediaType,
          progress: percent,
          status: 'uploading',
        });
      },
    },
  );

  // Report completion
  const mediaResponse = response.data;
  onProgress?.({
    mediaId: mediaResponse.id,
    fileName,
    type: mediaType,
    progress: 100,
    status: 'complete',
  });

  return mediaResponse;
}

/**
 * Creates a File object from a Blob with the given filename and MIME type.
 * Utility for creating uploadable files from programmatically generated content
 * (e.g., voice note recordings).
 *
 * @param blob - The source Blob.
 * @param fileName - Desired filename for the file.
 * @param mimeType - MIME type to assign to the file.
 * @returns A File object suitable for processAndUploadMedia.
 */
export function blobToFile(
  blob: Blob,
  fileName: string,
  mimeType: string,
): File {
  return new File([blob], fileName, { type: mimeType });
}
