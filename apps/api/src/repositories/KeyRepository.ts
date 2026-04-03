/**
 * @module apps/api/src/repositories/KeyRepository
 *
 * Prisma-backed implementation of the IKeyRepository interface for Signal
 * Protocol PreKey bundle persistence.
 *
 * Handles storage and retrieval of cryptographic key material required for
 * E2E encrypted session establishment (X3DH key agreement). The server
 * stores key bundles so clients can initiate encrypted sessions without
 * requiring the recipient to be online.
 *
 * Storage mapping (Shared types → PostgreSQL columns):
 * - IdentityKey object  → JSON-serialized string in `identityKey` column
 * - SignedPreKey object  → JSON-serialized string in `signedPreKey` column
 * - SignedPreKey.signature → separate `signedPreKeySignature` column
 * - PublicPreKey[]       → JSONB `preKeys` column (native JSON)
 * - registrationId       → Int column
 *
 * Architecture rules enforced:
 * - R12 (E2E Encryption Integrity): Server stores key bundles for exchange
 *        only. Zero decryption logic. All key material is opaque.
 * - R17 (Interface-Driven DI): Implements IKeyRepository interface.
 *        PrismaClient injected via constructor.
 * - R16 (OOD Layering): Zero business logic — persistence and mapping only.
 * - R23 (Log Hygiene): Never logs encryption keys or prekey material.
 * - R28 (Structured Logging): No direct console output statements.
 * - R7  (Zero Warnings Build): TypeScript strict mode compatible.
 */

import type { PrismaClient, Prisma, PreKeyBundle as PrismaPreKeyBundle } from '@prisma/client';
import type { IKeyRepository } from '../domain/interfaces/IKeyRepository.js';
import type {
  PreKeyBundleDTO,
  PreKeyBundleResponse,
  PublicPreKey,
  PreKeyCountStatus,
  IdentityKey,
  SignedPreKey,
} from '@kalle/shared';

// =============================================================================
// Constants
// =============================================================================

/**
 * Minimum number of one-time prekeys before replenishment is needed.
 * When the remaining prekey count drops below this threshold, the
 * prekey-replenish-notification BullMQ job should notify the client
 * to upload additional prekeys.
 */
const PREKEY_REPLENISHMENT_THRESHOLD = 10;

// =============================================================================
// KeyRepository — Prisma-backed implementation
// =============================================================================

export class KeyRepository implements IKeyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ─── Upsert Bundle ──────────────────────────────────────────────────

  /**
   * Insert or replace a user's PreKey bundle.
   *
   * Uses Prisma upsert since `userId` has a @unique constraint on the
   * PreKeyBundle model. First upload creates the record; subsequent
   * uploads replace identity key, signed prekey, and all one-time prekeys.
   *
   * Complex objects (IdentityKey, SignedPreKey) are JSON-serialized into
   * String columns. The signed prekey signature is also stored in a
   * separate column for potential database-level operations.
   */
  async upsertBundle(userId: string, dto: PreKeyBundleDTO): Promise<void> {
    const identityKeyJson = JSON.stringify(dto.identityKey);
    const signedPreKeyJson = JSON.stringify(dto.signedPreKey);
    const signedPreKeySignature = dto.signedPreKey.signature;

    const preKeysJson = dto.preKeys as unknown as Prisma.InputJsonValue;

    await this.prisma.preKeyBundle.upsert({
      where: { userId },
      update: {
        identityKey: identityKeyJson,
        signedPreKey: signedPreKeyJson,
        signedPreKeySignature,
        preKeys: preKeysJson,
        registrationId: dto.registrationId,
      },
      create: {
        userId,
        identityKey: identityKeyJson,
        signedPreKey: signedPreKeyJson,
        signedPreKeySignature,
        preKeys: preKeysJson,
        registrationId: dto.registrationId,
      },
    });
  }

  // ─── Find By User ID ────────────────────────────────────────────────

  /**
   * Fetch a user's PreKey bundle for X3DH key agreement.
   *
   * Per the IKeyRepository interface contract, this method atomically
   * consumes the first available one-time prekey (FIFO order) and
   * includes it in the response. If all one-time prekeys are exhausted,
   * the `preKey` field will be undefined — the X3DH protocol can still
   * proceed with reduced forward secrecy.
   *
   * Returns null if no bundle exists for the given user.
   */
  async findByUserId(userId: string): Promise<PreKeyBundleResponse | null> {
    const record = await this.prisma.preKeyBundle.findUnique({
      where: { userId },
    });

    if (!record) {
      return null;
    }

    // Parse the JSONB preKeys column into a typed array
    const preKeys = this.parsePreKeys(record.preKeys);
    let consumedPreKey: PublicPreKey | undefined;

    // Atomically consume the first available prekey (FIFO)
    if (preKeys.length > 0) {
      consumedPreKey = preKeys[0];
      const remaining = preKeys.slice(1);

      await this.prisma.preKeyBundle.update({
        where: { userId },
        data: {
          preKeys: remaining as unknown as Prisma.InputJsonValue,
        },
      });
    }

    return this.mapToResponse(record, consumedPreKey);
  }

  // ─── Consume Pre Key ────────────────────────────────────────────────

  /**
   * Consume a specific one-time prekey by its keyId.
   *
   * Locates the prekey with the matching keyId in the JSON array,
   * removes it atomically, and returns the consumed prekey. If the
   * prekey is not found (already consumed or never existed), returns null.
   *
   * This is more targeted than findByUserId which auto-consumes the
   * first available prekey. Used when the client specifies which
   * prekey to use during X3DH key exchange.
   */
  async consumePreKey(userId: string, preKeyId: number): Promise<PublicPreKey | null> {
    const bundle = await this.prisma.preKeyBundle.findUnique({
      where: { userId },
    });

    if (!bundle) {
      return null;
    }

    const preKeys = this.parsePreKeys(bundle.preKeys);
    if (preKeys.length === 0) {
      return null;
    }

    // Find the prekey by its unique keyId
    const index = preKeys.findIndex((pk) => pk.keyId === preKeyId);
    if (index === -1) {
      return null;
    }

    const consumed = preKeys[index];
    const remaining = [...preKeys.slice(0, index), ...preKeys.slice(index + 1)];

    await this.prisma.preKeyBundle.update({
      where: { userId },
      data: {
        preKeys: remaining as unknown as Prisma.InputJsonValue,
      },
    });

    return consumed;
  }

  // ─── Count Remaining Pre Keys ───────────────────────────────────────

  /**
   * Count the remaining unconsumed one-time prekeys for a user.
   *
   * Uses a select projection to fetch only the preKeys column,
   * minimizing data transfer. Returns 0 if no bundle exists.
   */
  async countRemainingPreKeys(userId: string): Promise<number> {
    const bundle = await this.prisma.preKeyBundle.findUnique({
      where: { userId },
      select: { preKeys: true },
    });

    if (!bundle) {
      return 0;
    }

    return this.parsePreKeys(bundle.preKeys).length;
  }

  // ─── Get Pre Key Status ─────────────────────────────────────────────

  /**
   * Get prekey count status for replenishment monitoring.
   *
   * Returns a PreKeyCountStatus with the remaining count, threshold,
   * and a computed needsReplenishment flag. Returns null if no bundle
   * exists for the user.
   *
   * The threshold (10) determines when the prekey-replenish-notification
   * BullMQ job should alert the client to upload more prekeys.
   */
  async getPreKeyStatus(userId: string): Promise<PreKeyCountStatus | null> {
    const bundle = await this.prisma.preKeyBundle.findUnique({
      where: { userId },
      select: { preKeys: true },
    });

    if (!bundle) {
      return null;
    }

    const count = this.parsePreKeys(bundle.preKeys).length;

    return {
      userId,
      remainingPreKeys: count,
      threshold: PREKEY_REPLENISHMENT_THRESHOLD,
      needsReplenishment: count < PREKEY_REPLENISHMENT_THRESHOLD,
    };
  }

  // ─── Add Pre Keys ──────────────────────────────────────────────────

  /**
   * Append additional one-time prekeys to an existing bundle.
   *
   * Called when the client replenishes prekey supply after receiving a
   * low-prekey-count notification. New prekeys are appended to the
   * existing set — they do not replace previously uploaded prekeys.
   *
   * Throws an error if no bundle exists for the user (the client must
   * call upsertBundle first to establish the identity key and signed prekey).
   */
  async addPreKeys(userId: string, newPreKeys: PublicPreKey[]): Promise<void> {
    const bundle = await this.prisma.preKeyBundle.findUnique({
      where: { userId },
      select: { preKeys: true },
    });

    if (!bundle) {
      throw new Error(`No PreKey bundle found for user ${userId}`);
    }

    const existing = this.parsePreKeys(bundle.preKeys);
    const combined = [...existing, ...newPreKeys];

    await this.prisma.preKeyBundle.update({
      where: { userId },
      data: {
        preKeys: combined as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // ─── Has Bundle ─────────────────────────────────────────────────────

  /**
   * Check if a user has an existing PreKey bundle on the server.
   *
   * Uses Prisma count for an efficient existence check without loading
   * the full record. Returns true if the user has uploaded at least
   * one PreKey bundle.
   */
  async hasBundle(userId: string): Promise<boolean> {
    const count = await this.prisma.preKeyBundle.count({
      where: { userId },
    });
    return count > 0;
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  /**
   * Parse the JSONB preKeys column value into a typed PublicPreKey array.
   *
   * Handles null, undefined, and non-array values gracefully by returning
   * an empty array. The JSONB column stores an array of
   * `{ keyId: number, publicKey: string }` objects.
   */
  private parsePreKeys(jsonValue: Prisma.JsonValue): PublicPreKey[] {
    if (!jsonValue || !Array.isArray(jsonValue)) {
      return [];
    }
    return jsonValue as unknown as PublicPreKey[];
  }

  /**
   * Map a Prisma PreKeyBundle record to the shared PreKeyBundleResponse DTO.
   *
   * Deserializes JSON-stored identity key and signed prekey objects from
   * their String column representations back to typed interfaces.
   * Optionally includes a consumed one-time prekey in the response.
   */
  private mapToResponse(
    record: PrismaPreKeyBundle,
    consumedPreKey?: PublicPreKey,
  ): PreKeyBundleResponse {
    return {
      userId: record.userId,
      identityKey: JSON.parse(record.identityKey) as IdentityKey,
      signedPreKey: JSON.parse(record.signedPreKey) as SignedPreKey,
      preKey: consumedPreKey,
      registrationId: record.registrationId,
    };
  }
}
