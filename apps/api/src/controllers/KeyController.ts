/**
 * @file apps/api/src/controllers/KeyController.ts
 * @description Thin delegation controller for E2E encryption key management
 * endpoints. Handles PreKey bundle upload and fetch operations for Signal
 * Protocol X3DH key agreement (R12).
 *
 * This controller receives `EncryptionKeyService` via constructor injection
 * (R17) and contains ZERO business logic (R16). All key validation, bundle
 * storage, prekey consumption, and audit logging are handled by the service.
 *
 * Architecture rules enforced:
 * - R16 (Thin Delegation): Zero business logic — delegates entirely to
 *        EncryptionKeyService. No key validation, no bundle construction.
 * - R17 (Constructor Injection): Receives EncryptionKeyService via
 *        constructor. Wired in server.ts: `new KeyController(encryptionKeyService)`.
 * - R12 (E2E Encryption Integrity): Server stores key bundles but NEVER
 *        performs encryption/decryption. Controller only relays key material.
 * - R22 (Standardized Error Responses): All errors propagate via DomainError
 *        subclasses to the global error-handler middleware via `next(error)`.
 * - R23 (Log Hygiene): Controller MUST NOT log encryption keys, prekey
 *        material, or bundle contents. Only userId, action type, correlationId.
 * - R28 (Structured Logging Only): Zero `console.log` calls.
 * - R31 (Input Validation): Zod validation applied at route level — controller
 *        receives pre-validated data.
 * - R7  (Zero Warnings Build): Compiles under `tsc --noEmit --strict`.
 * - R9  (Auth Required): All key endpoints require authentication.
 *        `req.user` is populated by auth middleware.
 *
 * @module KeyController
 */

import type { Request, Response, NextFunction } from 'express';
import type { EncryptionKeyService } from '../services/EncryptionKeyService';
import type { PreKeyBundleDTO, PreKeyBundleResponse } from '@kalle/shared';

// ---------------------------------------------------------------------------
// KeyController
// ---------------------------------------------------------------------------

/**
 * Controller for Signal Protocol encryption key exchange endpoints.
 *
 * Provides two endpoints:
 * - `POST /api/v1/keys/bundle`      — Upload a PreKey bundle (authenticated)
 * - `GET  /api/v1/keys/bundle/:userId` — Fetch a PreKey bundle for X3DH (authenticated)
 *
 * Both endpoints require JWT authentication (R9). The controller performs
 * zero business logic (R16) — all operations are delegated to the injected
 * EncryptionKeyService instance.
 *
 * @example
 * ```typescript
 * // In server.ts composition root:
 * const keyController = new KeyController(encryptionKeyService);
 *
 * // In key.routes.ts:
 * router.post('/bundle', authMiddleware, keyController.uploadBundle);
 * router.get('/bundle/:userId', authMiddleware, keyController.getBundle);
 * ```
 */
export class KeyController {
  /**
   * Creates a new KeyController instance.
   *
   * @param encryptionKeyService - Service for Signal Protocol key material
   *        management — delegates from both uploadBundle() and getBundle()
   *        endpoints. Injected via constructor per R17.
   */
  constructor(
    private readonly encryptionKeyService: EncryptionKeyService
  ) {
    // Bind all public methods to preserve `this` context when used as
    // Express route handler callbacks. Without binding, `this.encryptionKeyService`
    // would be `undefined` at runtime because Express invokes handlers
    // without preserving the class instance context.
    this.uploadBundle = this.uploadBundle.bind(this);
    this.getBundle = this.getBundle.bind(this);
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/keys/bundle — Upload PreKey Bundle
  // -------------------------------------------------------------------------

  /**
   * Handles PreKey bundle upload for Signal Protocol key exchange.
   *
   * The authenticated user uploads their identity key, signed prekey,
   * and one-time prekeys so that other users can initiate X3DH sessions
   * and send encrypted messages without requiring real-time key exchange.
   *
   * Request body (Zod-validated at route level, R31):
   * - `identityKey`   — Long-term public identity key (IdentityKey)
   * - `signedPreKey`  — Medium-term signed prekey (SignedPreKey)
   * - `preKeys`       — Array of one-time prekeys (PublicPreKey[])
   * - `registrationId` — Client's Signal Protocol registration ID (number)
   *
   * The service handles all validation, storage, and audit logging (R32).
   * Controller NEVER logs key material (R23).
   *
   * @param req - Express request with `req.user.userId` and `req.body` (PreKeyBundleDTO)
   * @param res - Express response — returns 201 on success
   * @param next - Express next function for error propagation to global error handler
   */
  async uploadBundle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Extract authenticated user ID from JWT payload (R9)
      const userId: string = req.user!.userId;

      // Extract Zod-validated bundle data from request body (R31)
      const bundleData: PreKeyBundleDTO = req.body as PreKeyBundleDTO;

      // Delegate entirely to service — handles validation, persistence,
      // and audit logging (keys.bundle_upload). Zero business logic here (R16).
      await this.encryptionKeyService.uploadBundle(userId, bundleData);

      // 201 Created — PreKey bundle stored successfully
      res.status(201).json({
        data: {
          message: 'PreKey bundle uploaded successfully',
        },
      });
    } catch (error: unknown) {
      // Propagate all errors to the global error handler middleware (R22).
      // DomainError subclasses (ValidationError, ConflictError, etc.) are
      // mapped to appropriate HTTP status codes by the error handler.
      next(error);
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/keys/bundle/:userId — Fetch PreKey Bundle
  // -------------------------------------------------------------------------

  /**
   * Fetches a user's PreKey bundle for X3DH key agreement.
   *
   * The requesting user retrieves the target user's identity key, signed
   * prekey, and (if available) one one-time prekey. The one-time prekey
   * is consumed on fetch — subsequent fetches may return a different one
   * or none if all are exhausted.
   *
   * Path parameter (validated at route level):
   * - `:userId` — Target user whose bundle to fetch
   *
   * Response shape (PreKeyBundleResponse):
   * ```json
   * {
   *   "data": {
   *     "userId": "target-user-uuid",
   *     "identityKey": { "publicKey": "base64...", "fingerprint": "..." },
   *     "signedPreKey": { "keyId": 1, "publicKey": "base64...", "signature": "base64...", "timestamp": 1234567890 },
   *     "preKey": { "keyId": 42, "publicKey": "base64..." },
   *     "registrationId": 12345
   *   }
   * }
   * ```
   *
   * NOTE: `preKey` may be absent if all one-time prekeys are exhausted.
   * The X3DH protocol can still proceed without it (with reduced forward
   * secrecy for the initial message). Status 200 is returned regardless.
   *
   * @param req - Express request with `req.params.userId`
   * @param res - Express response — returns 200 with PreKeyBundleResponse
   * @param next - Express next function for error propagation
   */
  async getBundle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Extract target user ID from route parameter (validated at route level)
      const targetUserId: string = req.params.userId;

      // Delegate to service — handles bundle lookup, one-time prekey
      // consumption, and prekey count monitoring. Throws NotFoundError
      // if the target user has no PreKey bundle uploaded. Zero business
      // logic in controller (R16).
      const result = await this.encryptionKeyService.fetchBundle(targetUserId);

      // Extract the PreKeyBundleResponse from the FetchBundleResult.
      // The service also returns lowPreKeys and remainingPreKeys for
      // potential replenishment notification triggering — the controller
      // only cares about the bundle payload for the HTTP response.
      const bundle: PreKeyBundleResponse = result.bundle;

      // 200 OK — return the fetched bundle (preKey may be undefined)
      res.status(200).json({
        data: bundle,
      });
    } catch (error: unknown) {
      // Propagate to global error handler (R22).
      // NotFoundError → 404 if user has no bundle.
      next(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default KeyController;
