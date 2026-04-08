/**
 * @module IKeyRepository
 *
 * Encryption Key Repository Interface — defines the persistence contract
 * for Signal Protocol prekey bundle management.
 *
 * This interface abstracts all database operations related to encryption
 * key material storage and retrieval. The concrete implementation
 * (`KeyRepository`) uses Prisma to persist key bundles in PostgreSQL.
 *
 * Architecture compliance:
 * - R17: Services import ONLY this interface — never the concrete class.
 * - R16: Pure persistence contract — zero business logic.
 * - R12: Server stores key bundles for X3DH key exchange. Server performs
 *         ZERO decryption. All key material is opaque Base64-encoded strings.
 * - R23: No encryption keys, prekey material, or sensitive data in logs.
 * - R7:  TypeScript strict mode compatible with zero warnings.
 * - R28: Zero console.log calls — structured logging only via Pino.
 */

import type {
  PreKeyBundleDTO,
  PreKeyBundleResponse,
  PublicPreKey,
  PreKeyCountStatus,
} from '@kalle/shared';

/**
 * IKeyRepository — Encryption key repository contract for Signal Protocol
 * prekey bundle management.
 *
 * Supports the full lifecycle of Signal Protocol key material:
 * 1. Bundle upload — client registers identity key, signed prekey, and one-time prekeys
 * 2. Bundle fetch — initiator retrieves recipient's bundle for X3DH key agreement
 * 3. Prekey consumption — one-time prekeys consumed atomically during key exchange
 * 4. Prekey monitoring — track remaining supply for replenishment notifications
 * 5. Prekey replenishment — client uploads additional one-time prekeys when supply is low
 * 6. Existence check — verify a user can receive encrypted messages
 */
export interface IKeyRepository {
  /**
   * Upsert (insert or replace) a user's PreKey bundle.
   *
   * Called when a user uploads their Signal Protocol key material after
   * registration or during periodic key rotation. If a bundle already
   * exists for the user, the identity key, signed prekey, registration ID,
   * and all one-time prekeys are replaced entirely.
   *
   * @param userId - Owner user ID (UUID)
   * @param bundle - PreKeyBundleDTO containing identity key, signed prekey,
   *                 one-time prekeys array, and registration ID
   * @returns Resolves when the bundle has been persisted
   */
  upsertBundle(userId: string, bundle: PreKeyBundleDTO): Promise<void>;

  /**
   * Fetch a user's PreKey bundle for X3DH key agreement.
   *
   * Returns the target user's identity key, signed prekey, registration ID,
   * and at most ONE one-time prekey. The returned one-time prekey is consumed
   * atomically — it will not be returned in any subsequent call. If all
   * one-time prekeys are exhausted, the `preKey` field will be undefined
   * in the response (X3DH can still proceed with reduced forward secrecy).
   *
   * @param userId - User ID whose bundle to retrieve
   * @returns PreKeyBundleResponse with one consumed prekey, or null if no bundle exists
   */
  findByUserId(userId: string): Promise<PreKeyBundleResponse | null>;

  /**
   * Consume (mark as used) a specific one-time prekey from a user's bundle.
   *
   * Called during X3DH key exchange when the initiator selects a specific
   * prekey. Each one-time prekey can only be consumed once — subsequent
   * calls with the same preKeyId return null.
   *
   * @param userId - Owner user ID (UUID)
   * @param preKeyId - Numeric identifier of the prekey to consume
   * @returns The consumed PublicPreKey, or null if already consumed or not found
   */
  consumePreKey(userId: string, preKeyId: number): Promise<PublicPreKey | null>;

  /**
   * Count the remaining (unconsumed) one-time prekeys for a user.
   *
   * Used by the prekey-replenish-notification BullMQ job to determine
   * whether the client needs to upload additional prekeys. Clients should
   * maintain approximately 100 prekeys on the server; the replenishment
   * threshold is typically 20.
   *
   * @param userId - Owner user ID (UUID)
   * @returns Number of remaining unused one-time prekeys
   */
  countRemainingPreKeys(userId: string): Promise<number>;

  /**
   * Get prekey count status for replenishment monitoring.
   *
   * Returns a PreKeyCountStatus object that combines the remaining prekey
   * count with a threshold value and a computed needsReplenishment flag.
   * Used by the prekey-replenish-notification worker job to decide whether
   * to notify the client to upload more prekeys.
   *
   * @param userId - Owner user ID (UUID)
   * @returns PreKeyCountStatus with remaining count, threshold, and
   *          needsReplenishment flag, or null if no bundle exists
   */
  getPreKeyStatus(userId: string): Promise<PreKeyCountStatus | null>;

  /**
   * Add additional one-time prekeys to an existing bundle.
   *
   * Called when the client replenishes its prekey supply after receiving
   * a low-prekey-count notification. The new prekeys are appended to
   * the existing set — they do not replace previously uploaded prekeys.
   *
   * @param userId - Owner user ID (UUID)
   * @param preKeys - Array of new one-time prekeys to append
   * @returns Resolves when all prekeys have been persisted
   */
  addPreKeys(userId: string, preKeys: PublicPreKey[]): Promise<void>;

  /**
   * Check if a user has an existing PreKey bundle on the server.
   *
   * Used to determine if a user is set up for encrypted messaging before
   * attempting to initiate a Signal Protocol session. A user without a
   * bundle cannot receive encrypted messages.
   *
   * @param userId - User ID (UUID) to check
   * @returns true if the user has uploaded at least one PreKey bundle
   */
  hasBundle(userId: string): Promise<boolean>;
}
