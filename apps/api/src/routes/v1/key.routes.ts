/**
 * @file apps/api/src/routes/v1/key.routes.ts
 * @description Defines E2E encryption key management routes for Signal Protocol
 * X3DH key agreement. Two endpoints:
 *
 * - `POST /bundle`        — Upload PreKey bundle (identity key, signed prekey,
 *                            one-time prekeys, registrationId)
 * - `GET  /bundle/:userId` — Fetch a user's PreKey bundle for X3DH key exchange
 *
 * The server stores key bundles but NEVER performs encryption/decryption — it
 * only relays key material between clients (Rule R12). ALL endpoints require
 * authentication (Rule R9) and are rate-limited via `apiRateLimiter` (100
 * req/min). Zod schemas validate bundle structure at the route level before
 * data reaches controllers (Rule R31).
 *
 * Architecture Rules Enforced:
 * - R12 (E2E Encryption Integrity): Server stores key bundles for relay only.
 *        Zero encryption/decryption logic. Validates structure, not
 *        cryptographic validity.
 * - R23 (Log Hygiene): Route MUST NOT log key material — encryption keys,
 *        prekey material, identity keys, signed prekeys. Only userId and action.
 * - R9  (Auth Required): All key endpoints require authentication via JWT
 *        middleware applied at the router level.
 * - R31 (Input Validation via Zod): Bundle structure validated via Zod — correct
 *        shapes, required fields, key IDs as numbers, keys as non-empty strings.
 * - R30 (API Versioning): Sub-paths only — `/api/v1/keys` prefix applied by
 *        the v1 index router.
 * - R28 (Structured Logging Only): Zero `console.log` calls.
 * - R7  (Zero Warnings Build): TypeScript strict mode compliance.
 *
 * @module key.routes
 */

import { Router, RequestHandler } from 'express';
import { z } from 'zod';

import { validateBody, validateParams } from '../../middleware/validation';
import { apiRateLimiter } from '../../middleware/rate-limiter';
import type { KeyController } from '../../controllers/KeyController';

// ---------------------------------------------------------------------------
// Zod Validation Schemas
// ---------------------------------------------------------------------------

/**
 * Schema for the identity key object within a PreKey bundle.
 *
 * The identity key is the long-term public key used in Signal Protocol to
 * identify a user across all sessions. The `publicKey` field contains the
 * base64-encoded public key material. The optional `fingerprint` field
 * provides a human-readable safety number for manual key verification.
 */
const identityKeySchema = z.object({
  publicKey: z.string().min(1, 'Identity public key is required'),
  fingerprint: z.string().optional(),
});

/**
 * Schema for the signed prekey object within a PreKey bundle.
 *
 * The signed prekey is a medium-term key signed by the identity key. It
 * provides forward secrecy beyond what the identity key alone offers.
 * Clients rotate signed prekeys periodically (typically every 1-7 days).
 *
 * - `keyId`     — Unique identifier for this signed prekey (non-negative integer)
 * - `publicKey` — Base64-encoded public key material
 * - `signature` — Base64-encoded signature of the public key by the identity key
 * - `timestamp` — Unix timestamp (ms) of when the signed prekey was generated
 */
const signedPreKeySchema = z.object({
  keyId: z.number().int().nonnegative('Signed prekey ID must be non-negative'),
  publicKey: z.string().min(1, 'Signed prekey public key is required'),
  signature: z.string().min(1, 'Signed prekey signature is required'),
  timestamp: z.number().int().positive('Timestamp must be positive'),
});

/**
 * Schema for each one-time prekey in the preKeys array.
 *
 * One-time prekeys provide forward secrecy for the initial message in an
 * X3DH session. Each prekey is consumed on fetch — once used, it is removed
 * from the server. Clients should upload batches of ~100 prekeys and
 * replenish when the count drops below a threshold.
 *
 * - `keyId`     — Unique identifier for this one-time prekey (non-negative integer)
 * - `publicKey` — Base64-encoded public key material
 */
const preKeySchema = z.object({
  keyId: z.number().int().nonnegative('Prekey ID must be non-negative'),
  publicKey: z.string().min(1, 'Prekey public key is required'),
});

/**
 * Schema for the POST /bundle request body.
 *
 * Validates the complete PreKey bundle structure uploaded by a client.
 * The bundle contains all key material needed for other users to initiate
 * X3DH key agreement sessions.
 *
 * Constraints:
 * - `preKeys` array: 1–200 items (min 1 required, max 200 per upload)
 * - `registrationId`: positive integer (Signal Protocol registration ID)
 * - All key material strings must be non-empty (base64-encoded by the client)
 * - The server does NOT validate cryptographic correctness — it validates
 *   structure only (Rule R12)
 */
const uploadBundleSchema = z.object({
  identityKey: identityKeySchema,
  signedPreKey: signedPreKeySchema,
  preKeys: z
    .array(preKeySchema)
    .min(1, 'At least one prekey is required')
    .max(200, 'Maximum 200 prekeys per upload'),
  registrationId: z.number().int().positive('Registration ID must be positive'),
});

/**
 * Schema for the GET /bundle/:userId path parameter.
 *
 * Validates that the `userId` path parameter is a valid UUID v4 string.
 * Prevents malformed user IDs from reaching the service/repository layer.
 */
const userIdParamSchema = z.object({
  userId: z.string().uuid('Invalid user ID format'),
});

// ---------------------------------------------------------------------------
// Route Factory Function
// ---------------------------------------------------------------------------

/**
 * Creates and returns an Express Router with E2E encryption key management
 * endpoints.
 *
 * This factory function follows the dependency injection pattern — the
 * `KeyController` instance and `authMiddleware` are provided by the
 * composition root (`server.ts`) via the v1 index router, rather than
 * being imported directly. This keeps the route module decoupled from
 * concrete implementations (Rule R17).
 *
 * Middleware chain per endpoint:
 * 1. `POST /bundle`:
 *    `authMiddleware` → `apiRateLimiter` → `validateBody(uploadBundleSchema)` → `keyController.uploadBundle`
 * 2. `GET /bundle/:userId`:
 *    `authMiddleware` → `apiRateLimiter` → `validateParams(userIdParamSchema)` → `keyController.getBundle`
 *
 * @param keyController  - Injected KeyController instance with `uploadBundle`
 *                         and `getBundle` handler methods
 * @param authMiddleware - JWT authentication middleware (verifies token +
 *                         checks Redis blacklist). Applied to ALL routes.
 * @returns Configured Express Router with key management endpoints
 *
 * @example
 * ```typescript
 * // In apps/api/src/routes/v1/index.ts:
 * import { createKeyRoutes } from './key.routes';
 *
 * router.use('/keys', createKeyRoutes(deps.keyController, authMiddleware));
 * // Full paths: POST /api/v1/keys/bundle, GET /api/v1/keys/bundle/:userId
 * ```
 */
export function createKeyRoutes(
  keyController: KeyController,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  // Apply authentication and rate limiting to ALL key management routes.
  // Auth middleware verifies JWT token and checks Redis blacklist (Rule R9).
  // Rate limiter enforces 100 req/min per IP (standard API limit).
  router.use(authMiddleware);
  router.use(apiRateLimiter);

  // ---------------------------------------------------------------------------
  // POST /bundle — Upload PreKey Bundle
  // ---------------------------------------------------------------------------
  // Allows an authenticated user to upload their Signal Protocol key material:
  // identity key, signed prekey, one-time prekeys (1–200), and registration ID.
  // The Zod schema validates the bundle structure before the controller receives
  // it (Rule R31). The controller delegates to EncryptionKeyService for storage
  // and audit logging.
  router.post(
    '/bundle',
    validateBody(uploadBundleSchema),
    keyController.uploadBundle,
  );

  // ---------------------------------------------------------------------------
  // GET /bundle/:userId — Fetch PreKey Bundle for X3DH
  // ---------------------------------------------------------------------------
  // Allows an authenticated user to fetch another user's PreKey bundle to
  // initiate an X3DH key agreement session. The service returns the identity
  // key, signed prekey, and one consumed one-time prekey (if available).
  // The userId path parameter is validated as a UUID (Rule R31).
  router.get(
    '/bundle/:userId',
    validateParams(userIdParamSchema),
    keyController.getBundle,
  );

  return router;
}
