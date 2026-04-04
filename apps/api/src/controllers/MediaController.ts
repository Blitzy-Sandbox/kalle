/**
 * @file apps/api/src/controllers/MediaController.ts
 * @module MediaController
 *
 * Thin delegation controller for encrypted media upload and retrieval
 * endpoints.  Handles multipart form-data file uploads processed by
 * multer middleware (configured at the route level).
 *
 * Architecture rules enforced:
 *
 *  - R16 (Thin Delegation): ZERO business logic.  No file-size checking,
 *    no MIME validation, no thumbnail generation — ALL delegated to
 *    {@link MediaService}.
 *  - R17 (Constructor Injection): `new MediaController(mediaService)`
 *    wired in `server.ts` composition root.
 *  - R8  (Media Upload Validation): 25 MB size limit (→ 413) and MIME
 *    allowlist (→ 415) enforced by {@link MediaService}, NOT here.
 *  - R12 (E2E Encryption): Media is encrypted client-side before upload.
 *    Controller receives opaque ciphertext — server never decrypts.
 *  - R27 (Client-Side Thumbnails): Thumbnails generated and encrypted
 *    client-side, uploaded as distinct blobs.  Controller passes raw
 *    data through to the service.
 *  - R22 (Standardized Error Responses): Domain errors propagated via
 *    `next(error)` to the global error-handler middleware.
 *  - R28 (Structured Logging Only): ZERO `console.log` calls.
 *  - R7  (Zero Warnings Build): TypeScript strict mode compliant.
 *  - R9  (Auth Required): All media endpoints require authentication.
 */

// Bring in multer's Express.Request augmentation (req.file, req.files)
// so TypeScript recognises multer-populated fields on the request object.
// The project tsconfig restricts auto-discovered @types to ["node", "jest"],
// so we reference multer types explicitly here.
/// <reference types="multer" />

// ---------------------------------------------------------------------------
// External imports
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Internal imports — service layer (R17 interface-driven DI)
// ---------------------------------------------------------------------------

import type { MediaService, UploadMediaInput } from '../services/MediaService';

// ---------------------------------------------------------------------------
// Shared types from @kalle/shared
// ---------------------------------------------------------------------------

import type { MediaResponse, MediaType, UploadMediaDTO } from '@kalle/shared';

// ---------------------------------------------------------------------------
// MediaController
// ---------------------------------------------------------------------------

/**
 * Controller for media upload and retrieval endpoints.
 *
 * Endpoints handled:
 * - `POST /api/v1/media`       — Upload an encrypted media blob
 * - `GET  /api/v1/media/:mediaId` — Retrieve media metadata by ID
 *
 * This controller is intentionally thin (R16).  Every substantive
 * operation — validation, storage, metadata persistence — is delegated
 * to {@link MediaService}.  The only work performed here is request
 * extraction and response formatting.
 *
 * @example
 * ```typescript
 * // In server.ts composition root:
 * const mediaController = new MediaController(mediaService);
 *
 * // In media.routes.ts:
 * router.post('/', multerUpload.single('file'), mediaController.upload);
 * router.get('/:mediaId', mediaController.getMedia);
 * ```
 */
export class MediaController {
  // -------------------------------------------------------------------------
  // Constructor (R17: constructor injection)
  // -------------------------------------------------------------------------

  /**
   * Creates a new MediaController instance.
   *
   * @param mediaService - Media service for upload validation, blob
   *   storage, and metadata retrieval.  Injected at the composition
   *   root (`server.ts`).
   */
  constructor(private readonly mediaService: MediaService) {
    // Bind methods to preserve `this` context when used as Express
    // route handlers.  Without binding, `this.mediaService` would be
    // `undefined` at runtime because Express invokes the handler
    // without the class context.
    this.upload = this.upload.bind(this);
    this.getMedia = this.getMedia.bind(this);
  }

  // ─── POST /api/v1/media ────────────────────────────────────────────

  /**
   * Upload an encrypted media blob.
   *
   * Extracts the multer-populated `req.file` (encrypted binary) and the
   * multipart form-data metadata fields from `req.body` (matching the
   * {@link UploadMediaDTO} contract).  Builds an {@link UploadMediaInput}
   * and delegates entirely to `MediaService.uploadMedia()`.
   *
   * The service performs all validation (R8):
   * - File size ≤ 25 MB   → throws PayloadTooLargeError (413)
   * - MIME type allowlist  → throws UnsupportedMediaTypeError (415)
   *
   * @param req  - Express request populated by multer (req.file) and
   *   auth middleware (req.user)
   * @param res  - Express response — returns 201 with MediaResponse
   * @param next - Error propagation to the global error-handler
   */
  async upload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // R9: userId is guaranteed by auth middleware on protected routes
      const userId: string = req.user!.userId;

      // Guard against missing file — multer may not populate req.file
      // if the client omits the file field.  This is a request-shape
      // check, not business logic (R16 compliant).
      if (!req.file) {
        const missingFileError = new Error('No file uploaded in the request');
        next(missingFileError);
        return;
      }

      // Extract metadata form-data fields.  In multipart requests all
      // values arrive as strings; numeric and array fields are parsed
      // below.  Field names match the UploadMediaDTO contract.
      const body = req.body as Partial<Record<keyof UploadMediaDTO, string>>;

      // Parse optional numeric fields from string form-data values
      const width: number | undefined =
        body.width !== undefined && body.width !== '' ? Number(body.width) : undefined;
      const height: number | undefined =
        body.height !== undefined && body.height !== '' ? Number(body.height) : undefined;
      const duration: number | undefined =
        body.duration !== undefined && body.duration !== '' ? Number(body.duration) : undefined;

      // Parse waveform JSON array (voice note amplitude samples)
      let waveform: number[] | undefined;
      if (body.waveform !== undefined && body.waveform !== '') {
        waveform = JSON.parse(body.waveform) as number[];
      }

      // Parse optional thumbnail fields (R27: client-side thumbnails)
      const thumbnailWidth: number | undefined =
        body.thumbnailEncryptionKey !== undefined
          ? (body as Record<string, string | undefined>).thumbnailWidth !== undefined
            ? Number((body as Record<string, string | undefined>).thumbnailWidth)
            : undefined
          : undefined;
      const thumbnailHeight: number | undefined =
        body.thumbnailEncryptionKey !== undefined
          ? (body as Record<string, string | undefined>).thumbnailHeight !== undefined
            ? Number((body as Record<string, string | undefined>).thumbnailHeight)
            : undefined
          : undefined;

      // Build the service input DTO, mapping HTTP request shape to the
      // internal UploadMediaInput contract consumed by MediaService.
      const input: UploadMediaInput = {
        uploaderId: userId,
        file: {
          buffer: req.file.buffer,
          originalname: body.fileName ?? req.file.originalname,
          // Use the client-declared MIME type for the original file
          // (before encryption), falling back to multer-detected type.
          mimetype: body.mimeType ?? req.file.mimetype,
          size: req.file.size,
        },
        type: (body.type ?? req.file.mimetype) as MediaType,
        encryptionKey: body.encryptionKey ?? '',
        encryptionIv: body.encryptionIv ?? '',

        // Optional association references
        messageId: body.messageId || undefined,
        storyId: body.storyId || undefined,

        // Optional media dimensions and duration
        width,
        height,
        duration,
        waveform,

        // Thumbnail metadata (R27) — encrypted separately client-side
        thumbnailEncryptionKey: body.thumbnailEncryptionKey || undefined,
        thumbnailEncryptionIv: body.thumbnailEncryptionIv || undefined,
        thumbnailWidth,
        thumbnailHeight,
      };

      // Delegate all business logic to the service (R16)
      const mediaResponse: MediaResponse = await this.mediaService.uploadMedia(input);

      res.status(201).json({ data: mediaResponse });
    } catch (error: unknown) {
      next(error);
    }
  }

  // ─── GET /api/v1/media/:mediaId ────────────────────────────────────

  /**
   * Retrieve media metadata by ID.
   *
   * Extracts `mediaId` from route parameters and delegates to
   * `MediaService.getMediaById()`.  Returns the full {@link MediaResponse}
   * record including download URL and encryption metadata.
   *
   * The service throws {@link NotFoundError} (404) when no media record
   * exists with the given ID.
   *
   * @param req  - Express request with `params.mediaId` path parameter
   * @param res  - Express response — returns 200 with MediaResponse
   * @param next - Error propagation to the global error-handler
   */
  async getMedia(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { mediaId } = req.params;

      // Delegate retrieval to the service (R16)
      const media: MediaResponse = await this.mediaService.getMediaById(mediaId);

      res.status(200).json({ data: media });
    } catch (error: unknown) {
      next(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Exports — named + default (schema requirement)
// ---------------------------------------------------------------------------

export default MediaController;
