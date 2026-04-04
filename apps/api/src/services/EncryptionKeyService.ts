/**
 * @fileoverview EncryptionKeyService — Signal Protocol key material exchange.
 *
 * Manages PreKey bundle upload (upsert), PreKey bundle fetch for X3DH key agreement
 * (with one-time prekey consumption), prekey replenishment, and prekey count monitoring.
 *
 * The server stores key material as opaque base64-encoded strings — it has ZERO
 * decryption logic (R12). Logs MUST NOT contain encryption keys or prekey material (R23).
 *
 * Architecture Rules Applied:
 * - R17: All dependencies injected via constructor as interfaces
 * - R16: All key management business logic lives in this service
 * - R12: Server stores only opaque key bundles — zero decryption
 * - R23: Logs never contain encryption keys or prekey material
 * - R32: Immutable audit log entries for keys.bundle_upload
 * - R28: Zero console.log — structured logging only
 * - R7: TypeScript strict mode, zero warnings
 *
 * @module EncryptionKeyService
 */

// Runtime import — AuditAction enum is needed as a value for audit log entries
import { AuditAction } from '@kalle/shared';

// Error classes — runtime imports for throwing typed domain errors (R22)
import { NotFoundError } from '../errors/NotFoundError';
import { ValidationError } from '../errors/ValidationError';

// Type-only imports — interfaces and DTOs erased at compile time
import type { IKeyRepository } from '../domain/interfaces/IKeyRepository';
import type { AuditService } from './AuditService';
import type {
  PreKeyBundleDTO,
  PreKeyBundleResponse,
  PreKeyCountStatus,
  PublicPreKey,
} from '@kalle/shared';

/**
 * Threshold below which prekey replenishment should be triggered.
 * When remaining one-time prekeys fall below this count after a bundle fetch,
 * the fetchBundle result signals that the client should upload more prekeys.
 */
const PREKEY_LOW_THRESHOLD = 10;

/**
 * Result of fetching a PreKey bundle for X3DH key agreement.
 *
 * Includes the bundle itself plus prekey availability information
 * so the controller can trigger replenishment notifications if the
 * bundle owner's prekey supply is running low.
 */
export interface FetchBundleResult {
  /** The fetched PreKey bundle for X3DH key agreement */
  bundle: PreKeyBundleResponse;
  /** Whether the bundle owner's prekey supply is below the replenishment threshold */
  lowPreKeys: boolean;
  /** Number of remaining one-time prekeys for the bundle owner */
  remainingPreKeys: number;
}

/**
 * Service managing Signal Protocol key material exchange.
 *
 * Handles:
 * - PreKey bundle upload/upsert for new device registration
 * - PreKey bundle fetch for X3DH key agreement (with one-time prekey consumption)
 * - One-time prekey replenishment when supply runs low
 * - Prekey count monitoring for client notifications
 * - Pre-send bundle existence verification
 *
 * Security Guarantees:
 * - Server stores key material as opaque base64-encoded strings (R12)
 * - Zero decryption, zero plaintext access, zero crypto operations
 * - Audit metadata contains only key counts, never actual key values (R23)
 * - All audit entries are immutable — append-only writes (R32)
 *
 * @example
 * ```typescript
 * // In composition root (server.ts):
 * const keyService = new EncryptionKeyService(keyRepository, auditService);
 *
 * // Upload a bundle:
 * await keyService.uploadBundle(userId, bundleDTO);
 *
 * // Fetch for X3DH:
 * const { bundle, lowPreKeys } = await keyService.fetchBundle(recipientId);
 * ```
 */
export class EncryptionKeyService {
  /**
   * Create a new EncryptionKeyService instance.
   *
   * @param keyRepository - Repository interface for Signal Protocol key persistence (R17)
   * @param auditService - Audit logging service for security-sensitive action tracking (R32)
   */
  constructor(
    private readonly keyRepository: IKeyRepository,
    private readonly auditService: AuditService
  ) {}

  /**
   * Upload or update a user's PreKey bundle for Signal Protocol key exchange.
   *
   * Validates the bundle structure, upserts it via the repository, and writes
   * an immutable audit log entry. The metadata contains ONLY the prekey count,
   * never the actual key material (R23).
   *
   * @param userId - The ID of the user uploading their bundle
   * @param bundle - The PreKey bundle containing identityKey, signedPreKey, preKeys, and registrationId
   * @throws {ValidationError} If the bundle is missing required fields or has invalid structure
   */
  async uploadBundle(userId: string, bundle: PreKeyBundleDTO): Promise<void> {
    // Validate bundle has all required fields with correct types
    this.validateBundle(bundle);

    // Upsert the bundle via repository — overwrites any existing bundle for this user
    await this.keyRepository.upsertBundle(userId, bundle);

    // Write immutable audit entry (R32)
    // CRITICAL (R23): metadata contains ONLY the prekey count, never actual key values
    await this.auditService.log({
      action: AuditAction.KEYS_BUNDLE_UPLOAD,
      actorId: userId,
      metadata: {
        preKeyCount: bundle.preKeys.length,
      },
    });
  }

  /**
   * Fetch a user's PreKey bundle for X3DH key agreement.
   *
   * The repository automatically consumes one one-time prekey during the fetch
   * operation. After fetching, this method checks the remaining prekey count
   * against the low threshold to inform the caller whether a replenishment
   * notification should be triggered.
   *
   * @param userId - The ID of the user whose bundle to fetch (the message recipient)
   * @returns FetchBundleResult containing the bundle and prekey availability information
   * @throws {NotFoundError} If the user has no PreKey bundle uploaded
   */
  async fetchBundle(userId: string): Promise<FetchBundleResult> {
    // Fetch bundle from repository
    // The repository implementation automatically consumes one one-time prekey
    const bundle = await this.keyRepository.findByUserId(userId);

    if (!bundle) {
      throw new NotFoundError('PreKey bundle not found', {
        resource: 'PreKeyBundle',
        userId,
      });
    }

    // Check remaining prekeys against the low threshold
    // This information allows the controller to trigger a replenishment notification
    const remainingPreKeys = await this.keyRepository.countRemainingPreKeys(userId);
    const lowPreKeys = remainingPreKeys < PREKEY_LOW_THRESHOLD;

    return {
      bundle,
      lowPreKeys,
      remainingPreKeys,
    };
  }

  /**
   * Add additional one-time prekeys to a user's bundle (replenishment).
   *
   * Called when the client detects its prekey supply is running low,
   * typically after receiving a low-prekeys notification from the server.
   * Validates that the preKeys array is non-empty before persisting.
   *
   * @param userId - The ID of the user adding prekeys to their bundle
   * @param preKeys - Array of new one-time prekeys to append to the existing bundle
   * @throws {ValidationError} If the preKeys array is empty or undefined
   */
  async addPreKeys(userId: string, preKeys: PublicPreKey[]): Promise<void> {
    if (!preKeys || preKeys.length === 0) {
      throw new ValidationError('PreKeys array must not be empty', {
        field: 'preKeys',
        reason: 'At least one prekey is required for replenishment',
      });
    }

    await this.keyRepository.addPreKeys(userId, preKeys);
  }

  /**
   * Get the prekey count status for a user.
   *
   * Returns information about how many one-time prekeys remain and whether
   * replenishment is needed. Used for monitoring and client notifications
   * (e.g., the prekey-replenish-notification BullMQ job).
   *
   * @param userId - The ID of the user to check
   * @returns PreKeyCountStatus with remaining count and threshold info, or null if no bundle exists
   */
  async getPreKeyStatus(userId: string): Promise<PreKeyCountStatus | null> {
    return this.keyRepository.getPreKeyStatus(userId);
  }

  /**
   * Check whether a user has an uploaded PreKey bundle.
   *
   * Used before sending encrypted messages to verify the recipient
   * has the key material necessary to establish a Signal Protocol session
   * via X3DH key agreement.
   *
   * @param userId - The ID of the user to check
   * @returns true if the user has an active PreKey bundle, false otherwise
   */
  async hasBundle(userId: string): Promise<boolean> {
    return this.keyRepository.hasBundle(userId);
  }

  /**
   * Validate that a PreKey bundle has all required fields for Signal Protocol.
   *
   * A valid bundle must contain:
   * - identityKey with a non-empty publicKey string
   * - signedPreKey with numeric keyId, non-empty publicKey, and non-empty signature
   * - At least one entry in the preKeys array, each with numeric keyId and non-empty publicKey
   * - A numeric registrationId
   *
   * Collects all validation errors and throws a single ValidationError with
   * field-level details for all failing constraints.
   *
   * @param bundle - The PreKey bundle to validate
   * @throws {ValidationError} If any required field is missing or has an invalid type/value
   */
  private validateBundle(bundle: PreKeyBundleDTO): void {
    const errors: Array<{ field: string; message: string }> = [];

    // Validate identityKey presence and structure
    if (!bundle.identityKey || !bundle.identityKey.publicKey) {
      errors.push({
        field: 'identityKey',
        message: 'Identity key with a non-empty publicKey is required',
      });
    }

    // Validate signedPreKey presence and required sub-fields
    if (!bundle.signedPreKey) {
      errors.push({
        field: 'signedPreKey',
        message: 'Signed prekey is required',
      });
    } else {
      if (typeof bundle.signedPreKey.keyId !== 'number') {
        errors.push({
          field: 'signedPreKey.keyId',
          message: 'Signed prekey keyId must be a number',
        });
      }
      if (!bundle.signedPreKey.publicKey) {
        errors.push({
          field: 'signedPreKey.publicKey',
          message: 'Signed prekey publicKey is required',
        });
      }
      if (!bundle.signedPreKey.signature) {
        errors.push({
          field: 'signedPreKey.signature',
          message: 'Signed prekey signature is required',
        });
      }
    }

    // Validate preKeys array — must have at least one entry
    if (!Array.isArray(bundle.preKeys) || bundle.preKeys.length === 0) {
      errors.push({
        field: 'preKeys',
        message: 'At least one one-time prekey is required',
      });
    } else {
      // Validate each individual prekey in the array
      for (let i = 0; i < bundle.preKeys.length; i++) {
        const preKey = bundle.preKeys[i];
        if (typeof preKey.keyId !== 'number') {
          errors.push({
            field: `preKeys[${i}].keyId`,
            message: `PreKey at index ${i} must have a numeric keyId`,
          });
        }
        if (!preKey.publicKey) {
          errors.push({
            field: `preKeys[${i}].publicKey`,
            message: `PreKey at index ${i} must have a non-empty publicKey`,
          });
        }
      }
    }

    // Validate registrationId — must be a number
    if (typeof bundle.registrationId !== 'number') {
      errors.push({
        field: 'registrationId',
        message: 'Registration ID must be a number',
      });
    }

    // Throw a single ValidationError with all field-level details
    if (errors.length > 0) {
      throw new ValidationError('Invalid PreKey bundle', {
        fields: errors,
      });
    }
  }
}
