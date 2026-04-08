/**
 * @file apps/api/src/routes/v1/media.routes.ts
 * @description Media upload and retrieval route definitions.
 *
 * Defines two Express routes:
 * - `POST /`          — Upload an encrypted media blob (multipart via multer)
 * - `GET  /:mediaId`  — Retrieve media metadata by ID
 *
 * ALL endpoints require authentication (Rule R9).  Rate limiting is applied
 * per-route: `uploadRateLimiter` (30 req/min) for uploads due to higher
 * resource cost of file processing, and `apiRateLimiter` (100 req/min) for
 * metadata retrieval.
 *
 * Architecture Rules Enforced:
 * - R8  (Media Upload Validation): 25 MB file size limit enforced at the
 *       multer layer as a first line of defense (26 MB to accommodate
 *       encryption overhead).  MediaService enforces exact content limits
 *       and MIME allowlist per Rule R16.
 * - R12 (E2E Encryption): Media is encrypted client-side before upload.
 *       Server receives opaque ciphertext — zero decryption logic.
 * - R27 (Client-Side Thumbnails): Thumbnails generated and encrypted
 *       client-side, uploaded as distinct blobs.  Route handles upload
 *       mechanics only.
 * - R9  (Auth Required): All media endpoints require authentication via
 *       `router.use(authMiddleware)`.
 * - R31 (Input Validation via Zod): Path parameter `:mediaId` validated
 *       as UUID format.
 * - R30 (API Versioning): Sub-paths only — `/api/v1/media` prefix applied
 *       by the v1 index router.
 * - R28 (Structured Logging Only): ZERO `console.log` calls.
 * - R7  (Zero Warnings Build): TypeScript strict mode compliant.
 *
 * @example
 * ```typescript
 * // In v1/index.ts:
 * import { createMediaRoutes } from './media.routes';
 *
 * router.use('/media', createMediaRoutes(mediaController, authMiddleware));
 * ```
 */

// ---------------------------------------------------------------------------
// External imports
// ---------------------------------------------------------------------------

import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Internal imports — middleware
// ---------------------------------------------------------------------------

import { validateParams } from '../../middleware/validation';
import { uploadRateLimiter, apiRateLimiter } from '../../middleware/rate-limiter';

// ---------------------------------------------------------------------------
// Internal imports — controller type (type-only, R17: no concrete import)
// ---------------------------------------------------------------------------

import type { MediaController } from '../../controllers/MediaController';

// ---------------------------------------------------------------------------
// Multer configuration — in-memory file storage for encrypted media blobs
// ---------------------------------------------------------------------------

/**
 * Multer instance configured for encrypted media uploads.
 *
 * Configuration rationale:
 * 1. **Memory storage:** Files stored in `req.file.buffer` (Buffer).
 *    Encrypted blobs are passed directly to StorageProvider for filesystem
 *    persistence — no temporary files needed on disk.
 * 2. **File size limit (26 MB):** 25 MB content + ~1 MB for encryption
 *    overhead (AES-GCM IV, auth tag, padding).  This is the first layer
 *    of defense; MediaService enforces the exact 25 MB limit on actual
 *    content size.
 * 3. **Single file:** Only one file per request.  Thumbnail uploads are
 *    handled as separate requests per Rule R27.
 * 4. **No file filter:** MIME type validation is delegated to MediaService
 *    against the `ALLOWED_MIME_TYPES` constant from `@kalle/shared`, not
 *    by multer.  This follows Rule R16 — all business logic in the service
 *    layer, not at the route level.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 26 * 1024 * 1024, // 26 MB (25 MB media + 1 MB encryption overhead)
    files: 1,                    // Single file upload only
  },
});

// ---------------------------------------------------------------------------
// Zod validation schemas (Rule R31)
// ---------------------------------------------------------------------------

/**
 * Path parameter schema for the `GET /:mediaId` endpoint.
 *
 * Validates that `:mediaId` is a well-formed UUID string.  Invalid
 * formats are rejected with a 400 response via `validateParams`
 * middleware before reaching the controller.
 */
const mediaIdParamSchema = z.object({
  mediaId: z.string().uuid('Invalid media ID format'),
});

// ---------------------------------------------------------------------------
// Route factory function
// ---------------------------------------------------------------------------

/**
 * Factory function that creates and returns an Express Router with media
 * upload and retrieval routes.
 *
 * This function follows the composition pattern used by all route modules
 * in the v1 router — it receives pre-configured controller and middleware
 * instances from the v1 index router (which receives them from the
 * `server.ts` composition root).
 *
 * **Endpoint summary:**
 *
 * | Method | Path       | Rate Limiter       | Description                      |
 * |--------|------------|--------------------|----------------------------------|
 * | POST   | /          | uploadRateLimiter  | Upload encrypted media blob      |
 * | GET    | /:mediaId  | apiRateLimiter     | Retrieve media metadata by ID    |
 *
 * **Middleware chains:**
 * - POST /: `authMiddleware` → `uploadRateLimiter` → `multer.single('file')` → `mediaController.upload`
 * - GET /:mediaId: `authMiddleware` → `apiRateLimiter` → `validateParams(mediaIdParamSchema)` → `mediaController.getMedia`
 *
 * @param mediaController - MediaController instance with `upload` and
 *   `getMedia` handler methods.  Injected from the composition root.
 * @param authMiddleware - JWT verification + Redis blacklist check
 *   middleware.  Applied to all routes in this router (Rule R9).
 * @returns Configured Express Router for media endpoints
 */
export function createMediaRoutes(
  mediaController: MediaController,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  // ─── Apply authentication to ALL routes (Rule R9) ───────────────────
  router.use(authMiddleware);

  // ─── POST / — Upload encrypted media file ──────────────────────────
  //
  // Middleware chain:
  //   1. authMiddleware (applied via router.use above)
  //   2. uploadRateLimiter — 30 req/min per IP (higher cost operation)
  //   3. multer.single('file') — parses multipart form, populates req.file
  //   4. mediaController.upload — extracts metadata, delegates to MediaService
  //
  // Notes:
  //   - Multer places the encrypted binary blob in req.file.buffer
  //   - No body validation at route level — multipart form metadata fields
  //     (type, mimeType, fileName, encryptionKey, etc.) are processed by
  //     the controller and validated by MediaService (Rule R16)
  //   - If file exceeds 26 MB, multer throws MulterError with code
  //     LIMIT_FILE_SIZE, caught by the global error handler → 413
  router.post(
    '/',
    uploadRateLimiter,
    upload.single('file'),
    mediaController.upload,
  );

  // ─── GET /:mediaId — Get media metadata ────────────────────────────
  //
  // Middleware chain:
  //   1. authMiddleware (applied via router.use above)
  //   2. apiRateLimiter — 100 req/min per IP (standard API rate)
  //   3. validateParams(mediaIdParamSchema) — validates :mediaId as UUID
  //   4. mediaController.getMedia — retrieves metadata from MediaService
  //
  // Notes:
  //   - Returns media metadata including download URL, encryption metadata,
  //     dimensions, and MIME type
  //   - MediaService throws NotFoundError (404) if no media record exists
  router.get(
    '/:mediaId',
    apiRateLimiter,
    validateParams(mediaIdParamSchema),
    mediaController.getMedia,
  );

  return router;
}
