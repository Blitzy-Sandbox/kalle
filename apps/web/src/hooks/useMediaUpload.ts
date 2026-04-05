/**
 * @module apps/web/src/hooks/useMediaUpload
 *
 * Custom React hook providing a complete media upload workflow with progress
 * tracking, cancellation, and pre-flight validation.
 *
 * Pipeline stages:
 * 1. **Validation (R8):** MIME type against `ALLOWED_MIME_TYPES` and file size
 *    against 25 MB `MAX_FILE_SIZE` — both from `@kalle/shared`.
 * 2. **Thumbnail preview (R27):** For IMAGE type, generates a preview thumbnail
 *    (200 px max edge) to validate image readability before the full pipeline.
 * 3. **Crypto pre-flight (R12):** Verifies Web Crypto API availability by
 *    performing a test encrypt → decrypt round-trip.
 * 4. **Upload pipeline:** Delegates to `uploadMedia` from `lib/media.ts` which
 *    handles AES-GCM encryption of file + thumbnail, FormData construction, and
 *    XHR upload with progress tracking.
 *
 * Cancellation:
 *   An `AbortController` reference (`useRef`) allows in-flight uploads to be
 *   cancelled via `cancelUpload()`. Progress callbacks check the abort signal
 *   and short-circuit when the upload is cancelled.
 *
 * Authentication:
 *   Verifies the user is authenticated via `useAuthStore` before initiating any
 *   upload. Returns an error state if the user is not authenticated.
 *
 * @see AAP Section 0.2.3 — Media upload with progress hook
 * @see AAP Section 0.7.1 Group 16 — Custom hooks: useMediaUpload
 * @see R8  — Media Upload Validation (25 MB limit, MIME allowlist)
 * @see R12 — E2E Encryption Integrity (client-side encryption)
 * @see R23 — Log Hygiene (zero console.log)
 * @see R27 — Client-Side Thumbnail Generation (200 px max edge)
 */

import { useState, useCallback, useRef } from 'react';
import {
  uploadMedia,
  validateMimeType,
  validateFileSize,
  generateThumbnail,
  encryptMedia,
  decryptMedia,
  getMediaTypeFromFile,
} from '../lib/media';
import { useAuthStore } from '../stores/authStore';
import { MediaType } from '@kalle/shared';
import type { MediaResponse, MediaUploadProgress } from '@kalle/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reactive state object tracking the current media upload lifecycle.
 *
 * Drives UI updates during the upload pipeline (progress bars, status text,
 * error banners). Transitions through statuses in order:
 *   idle → validating → generating-thumbnail → encrypting → uploading → complete
 * Any stage may transition to `error` on failure.
 */
interface UploadState {
  /** True while an upload operation is in progress (from validating to complete/error) */
  isUploading: boolean;

  /** Upload progress percentage in the range [0, 100] */
  progress: number;

  /**
   * Current phase of the upload lifecycle:
   * - `idle`                  — no active upload
   * - `validating`            — checking MIME type and file size (R8)
   * - `generating-thumbnail`  — creating image preview thumbnail (R27, IMAGE only)
   * - `encrypting`            — AES-GCM encryption in progress (R12)
   * - `uploading`             — encrypted blob transfer to server
   * - `complete`              — upload succeeded, `mediaResponse` is populated
   * - `error`                 — an unrecoverable error occurred, see `error` field
   */
  status:
    | 'idle'
    | 'validating'
    | 'generating-thumbnail'
    | 'encrypting'
    | 'uploading'
    | 'complete'
    | 'error';

  /** Human-readable error message when status is `'error'`; null otherwise */
  error: string | null;

  /** Server response after successful upload; null until complete */
  mediaResponse: MediaResponse | null;
}

/**
 * Options accepted by `uploadFile` for associating the upload with a
 * specific message or story context.
 */
interface UploadFileOptions {
  /** ID of the message to associate the media with */
  messageId?: string;

  /** ID of the story to associate the media with */
  storyId?: string;
}

/**
 * Result of client-side file validation via `validateFile`.
 */
interface ValidateFileResult {
  /** True if the file passes all client-side validation checks */
  valid: boolean;

  /** Human-readable error description when `valid` is false */
  error?: string;

  /** Detected `MediaType` category when `valid` is true */
  mediaType?: MediaType;
}

/**
 * Public return type of the `useMediaUpload` hook.
 */
interface UseMediaUploadReturn {
  /**
   * Initiates the full upload pipeline for a file: validate → thumbnail →
   * encrypt → upload. Returns the server `MediaResponse` on success or
   * `null` on failure/cancellation.
   */
  uploadFile: (
    file: File,
    options?: UploadFileOptions,
  ) => Promise<MediaResponse | null>;

  /** Reactive state object tracking upload progress */
  uploadState: UploadState;

  /** Aborts the in-flight upload and resets state to idle */
  cancelUpload: () => void;

  /** Resets upload state to idle (use after completion or error dismissal) */
  resetState: () => void;

  /**
   * Synchronous client-side validation of MIME type and file size (R8).
   * Call before `uploadFile` for immediate UI feedback without async overhead.
   */
  validateFile: (file: File) => ValidateFileResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Initial idle state — reused by resetState and cancelUpload */
const INITIAL_UPLOAD_STATE: UploadState = {
  isUploading: false,
  progress: 0,
  status: 'idle',
  error: null,
  mediaResponse: null,
} as const;

/**
 * Progress offset reserved for pre-flight steps (validation, thumbnail
 * preview, crypto check). The `uploadMedia` progress (0–100) is scaled
 * into the remaining range [PREFLIGHT_PROGRESS_OFFSET, 100].
 */
const PREFLIGHT_PROGRESS_OFFSET = 15;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a `MediaUploadProgress` status value from the `uploadMedia` pipeline
 * to the hook's extended status enum. The pipeline emits a subset of statuses;
 * the hook adds `idle`, `validating`, and `generating-thumbnail`.
 */
function mapProgressStatus(
  status: MediaUploadProgress['status'],
): UploadState['status'] {
  switch (status) {
    case 'encrypting':
      return 'encrypting';
    case 'uploading':
      return 'uploading';
    case 'complete':
      return 'complete';
    case 'error':
      return 'error';
    default:
      return 'uploading';
  }
}

/**
 * Scales a raw progress value from `uploadMedia` (0–100) into the hook's
 * post-preflight range [PREFLIGHT_PROGRESS_OFFSET, 100] so that the earlier
 * pre-flight steps occupy the first PREFLIGHT_PROGRESS_OFFSET percent.
 *
 * @param rawProgress - Raw progress value from `MediaUploadProgress.progress`
 * @returns Scaled progress percentage in [PREFLIGHT_PROGRESS_OFFSET, 100]
 */
function scaleUploadProgress(rawProgress: number): number {
  const scaleFactor =
    (100 - PREFLIGHT_PROGRESS_OFFSET) / 100;
  const scaled =
    PREFLIGHT_PROGRESS_OFFSET + Math.round(rawProgress * scaleFactor);
  return Math.min(100, scaled);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Custom React hook for media uploads with validation, encryption, and progress.
 *
 * Usage:
 * ```tsx
 * const { uploadFile, uploadState, cancelUpload, resetState, validateFile } =
 *   useMediaUpload();
 *
 * // Quick validation without async overhead
 * const result = validateFile(selectedFile);
 * if (!result.valid) showError(result.error);
 *
 * // Full upload pipeline
 * const response = await uploadFile(selectedFile, { messageId });
 * if (response) onUploadComplete(response);
 *
 * // Cancel in-flight upload
 * cancelUpload();
 *
 * // Clear error state
 * resetState();
 * ```
 *
 * @returns Object with `uploadFile`, `uploadState`, `cancelUpload`,
 *   `resetState`, and `validateFile`
 */
export function useMediaUpload(): UseMediaUploadReturn {
  const [uploadState, setUploadState] =
    useState<UploadState>(INITIAL_UPLOAD_STATE);

  /** Holds the AbortController for the current upload — non-reactive (useRef) */
  const abortControllerRef = useRef<AbortController | null>(null);

  /** Read authentication status from the auth store (R9) */
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  // ── validateFile ─────────────────────────────────────────────────

  /**
   * Synchronously validates a file against the client-side allowlist
   * and size limit (R8). Does NOT perform async operations.
   *
   * @param file - The `File` object to validate
   * @returns Validation result with detected `MediaType` on success
   */
  const validateFile = useCallback(
    (file: File): ValidateFileResult => {
      // R8: Check MIME type against the shared ALLOWED_MIME_TYPES allowlist
      const mimeResult = validateMimeType(file);
      if (!mimeResult.valid || !mimeResult.mediaType) {
        return {
          valid: false,
          error:
            'Unsupported file type. Allowed: images, videos, documents, audio.',
        };
      }

      // R8: Check file size against the 25 MB MAX_FILE_SIZE constant
      if (!validateFileSize(file)) {
        return {
          valid: false,
          error: 'File exceeds 25MB size limit.',
        };
      }

      // Determine the MediaType enum value for the caller
      const mediaType = getMediaTypeFromFile(file);
      return {
        valid: true,
        mediaType: mediaType ?? undefined,
      };
    },
    [],
  );

  // ── uploadFile ───────────────────────────────────────────────────

  /**
   * Executes the full upload pipeline: validate → thumbnail preview →
   * crypto pre-flight → encrypt + upload via `uploadMedia`.
   *
   * Returns the server `MediaResponse` on success, or `null` when:
   * - Validation fails (MIME type or file size)
   * - User is not authenticated
   * - Upload is cancelled via `cancelUpload()`
   * - Any async operation throws an error
   *
   * @param file - The `File` object to upload
   * @param options - Optional message/story association
   * @returns `MediaResponse` on success, `null` on failure/cancellation
   */
  const uploadFile = useCallback(
    async (
      file: File,
      options?: UploadFileOptions,
    ): Promise<MediaResponse | null> => {
      try {
        // ── Step 1: Validate (R8) ──────────────────────────────────
        setUploadState({
          isUploading: true,
          progress: 0,
          status: 'validating',
          error: null,
          mediaResponse: null,
        });

        // Verify the user is authenticated before proceeding (R9)
        if (!isAuthenticated) {
          setUploadState({
            ...INITIAL_UPLOAD_STATE,
            status: 'error',
            error: 'Authentication required to upload media.',
          });
          return null;
        }

        const validation = validateFile(file);
        if (!validation.valid) {
          setUploadState({
            ...INITIAL_UPLOAD_STATE,
            status: 'error',
            error: validation.error ?? 'Invalid file.',
          });
          return null;
        }

        // ── Step 2: Create AbortController for cancellation ────────
        const controller = new AbortController();
        abortControllerRef.current = controller;

        // ── Step 3: Image preview thumbnail (R27) ──────────────────
        // For IMAGE files, generate a client-side thumbnail to validate
        // the image is readable and not corrupt before committing to the
        // full encrypt + upload pipeline. The uploadMedia function will
        // independently generate and encrypt its own thumbnail.
        if (validation.mediaType === MediaType.IMAGE) {
          setUploadState((prev) => ({
            ...prev,
            status: 'generating-thumbnail',
            progress: 5,
          }));

          if (controller.signal.aborted) {
            setUploadState(INITIAL_UPLOAD_STATE);
            return null;
          }

          await generateThumbnail(file);
        }

        // ── Step 4: Crypto pre-flight check (R12) ──────────────────
        // Verify that the Web Crypto API is functional in the current
        // browser environment. A test encrypt → decrypt round-trip with
        // a minimal payload catches unsupported or restricted contexts
        // early, providing a clear error instead of a cryptic failure
        // deep inside the upload pipeline.
        setUploadState((prev) => ({
          ...prev,
          status: 'encrypting',
          progress: 10,
        }));

        if (controller.signal.aborted) {
          setUploadState(INITIAL_UPLOAD_STATE);
          return null;
        }

        const preflightPayload = new ArrayBuffer(1);
        const preflightEncrypted = await encryptMedia(preflightPayload);
        await decryptMedia(
          preflightEncrypted.encryptedData,
          preflightEncrypted.key,
          preflightEncrypted.iv,
        );

        // ── Step 5: Full upload pipeline ───────────────────────────
        // Delegates to uploadMedia which handles:
        //   - MIME + size re-validation
        //   - Thumbnail generation for images (200 px max edge, R27)
        //   - AES-GCM encryption of file AND thumbnail separately (R12)
        //   - Multipart FormData upload to POST /api/v1/media
        if (controller.signal.aborted) {
          setUploadState(INITIAL_UPLOAD_STATE);
          return null;
        }

        const mediaResponse = await uploadMedia(file, {
          messageId: options?.messageId,
          storyId: options?.storyId,
          onProgress: (progress: MediaUploadProgress) => {
            // Short-circuit if the upload was cancelled while the
            // XHR was in flight
            if (controller.signal.aborted) {
              return;
            }

            const mappedStatus = mapProgressStatus(progress.status);
            const scaledProgress = scaleUploadProgress(progress.progress);

            setUploadState((prev) => ({
              ...prev,
              status: mappedStatus,
              progress: Math.max(prev.progress, scaledProgress),
            }));
          },
        });

        // Final abort check after the upload resolves
        if (controller.signal.aborted) {
          setUploadState(INITIAL_UPLOAD_STATE);
          return null;
        }

        // ── Success ────────────────────────────────────────────────
        setUploadState({
          isUploading: false,
          progress: 100,
          status: 'complete',
          error: null,
          mediaResponse,
        });

        return mediaResponse;
      } catch (err: unknown) {
        // If the upload was cancelled via AbortController, reset to idle
        // without surfacing an error — cancellation is an intentional action
        if (abortControllerRef.current?.signal.aborted) {
          setUploadState(INITIAL_UPLOAD_STATE);
          return null;
        }

        // Surface the error in state for UI display
        const errorMessage =
          err instanceof Error ? err.message : 'Upload failed';

        setUploadState({
          isUploading: false,
          progress: 0,
          status: 'error',
          error: errorMessage,
          mediaResponse: null,
        });

        return null;
      }
    },
    [isAuthenticated, validateFile],
  );

  // ── cancelUpload ─────────────────────────────────────────────────

  /**
   * Aborts the in-flight upload request and resets state to idle.
   *
   * If no upload is active, this is a no-op on the controller but still
   * resets state (safe to call at any time).
   */
  const cancelUpload = useCallback((): void => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setUploadState(INITIAL_UPLOAD_STATE);
  }, []);

  // ── resetState ───────────────────────────────────────────────────

  /**
   * Resets the upload state to the initial idle state.
   *
   * Use after an upload completes to clear `mediaResponse`, or after an
   * error to dismiss the error message. Does NOT abort an in-flight upload;
   * use `cancelUpload` for that.
   */
  const resetState = useCallback((): void => {
    abortControllerRef.current = null;
    setUploadState(INITIAL_UPLOAD_STATE);
  }, []);

  // ── Return ───────────────────────────────────────────────────────

  return {
    uploadFile,
    uploadState,
    cancelUpload,
    resetState,
    validateFile,
  };
}
