/**
 * @module apps/api/src/domain/models/PreKeyBundle
 *
 * PreKey bundle domain model for Signal Protocol key management.
 *
 * Validates bundle integrity (identity key, signed prekey, one-time prekeys),
 * tracks prekey consumption for X3DH key agreement sessions, and determines
 * when the one-time prekey supply needs replenishment.
 *
 * The X3DH (Extended Triple Diffie-Hellman) protocol requires:
 *  1. A long-term identity key (IdentityKey) — one per user, immutable
 *  2. A medium-term signed prekey (SignedPreKey) — rotated periodically, signed by identity key
 *  3. A pool of one-time prekeys (PublicPreKey[]) — each consumed exactly once during
 *     initial session establishment, providing forward secrecy for the first message
 *
 * When another user wants to send an encrypted message, they fetch this user's bundle,
 * consume one one-time prekey, and establish a Signal session. If no one-time prekeys
 * remain, the protocol proceeds with reduced forward secrecy (identity + signed prekey only).
 *
 * Architecture rules enforced:
 * - R16 (OOD Layering): Business logic encapsulated in methods, not anemic data bags
 * - R17 (Interface-Driven): Zero Prisma imports — ORM-agnostic pure TypeScript
 * - R12 (E2E Encryption): Server stores bundles for key exchange; zero decryption logic
 * - R23 (Log Hygiene): Zero logging of key material — no keys/prekeys in any output
 * - R7 (Zero Warnings): TypeScript strict mode compatible with zero warnings
 * - R28 (Structured Logging): Zero console.log / console.warn / console.error calls
 */

import { randomUUID } from 'node:crypto';

import type {
  IdentityKey,
  SignedPreKey,
  PublicPreKey,
  PreKeyBundleResponse,
  PreKeyCountStatus,
} from '@kalle/shared/types/encryption';
import { ENCRYPTION } from '@kalle/shared/constants';

// =============================================================================
// Interface Definition
// =============================================================================

/**
 * Properties required to construct a PreKeyBundle instance.
 *
 * Used as the constructor parameter and as the canonical shape for
 * hydrating a PreKeyBundle from persistence (repository layer).
 */
export interface PreKeyBundleProps {
  /** Unique identifier for this bundle record */
  id: string;

  /** User ID who owns this bundle */
  userId: string;

  /** Signal Protocol registration ID for session establishment */
  registrationId: number;

  /** Long-term public identity key (Curve25519) */
  identityKey: IdentityKey;

  /** Medium-term signed prekey (signed by identity key) */
  signedPreKey: SignedPreKey;

  /** Array of one-time prekeys available for key exchange */
  preKeys: PublicPreKey[];

  /** IDs of prekeys that have been consumed (used in key exchanges) */
  usedPreKeyIds: number[];

  /** Timestamp when this bundle was first created */
  createdAt: Date;

  /** Timestamp of the last modification (prekey consumption, addition, etc.) */
  updatedAt: Date;
}

// =============================================================================
// PreKeyBundle Domain Model
// =============================================================================

/**
 * Domain model for Signal Protocol PreKey bundles.
 *
 * Encapsulates bundle validation, prekey lifecycle management (consumption,
 * replenishment), and serialization for API responses. This is a rich domain
 * model with business logic — not an anemic data holder.
 *
 * Key responsibilities:
 * - Validate bundle integrity on creation (identity key, signed prekey, prekeys)
 * - Track which one-time prekeys have been consumed
 * - Determine when the prekey supply needs replenishment
 * - Provide bundles for X3DH key exchange (consuming one prekey per exchange)
 * - Serialize to API response format
 *
 * Thread safety: This model is NOT thread-safe for concurrent prekey consumption.
 * The repository layer must ensure atomic consume operations in concurrent environments.
 */
export class PreKeyBundle {
  private readonly _id: string;
  private readonly _userId: string;
  private readonly _registrationId: number;
  private readonly _identityKey: IdentityKey;
  private readonly _signedPreKey: SignedPreKey;
  private _preKeys: PublicPreKey[];
  private _usedPreKeyIds: number[];
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  /**
   * Constructs a PreKeyBundle from hydrated properties.
   * Typically called by the repository layer when loading from persistence,
   * or by the static `create()` factory for new bundles.
   *
   * @param props - Complete bundle properties including all fields
   */
  constructor(props: PreKeyBundleProps) {
    this._id = props.id;
    this._userId = props.userId;
    this._registrationId = props.registrationId;
    this._identityKey = props.identityKey;
    this._signedPreKey = props.signedPreKey;
    this._preKeys = [...props.preKeys];
    this._usedPreKeyIds = [...props.usedPreKeyIds];
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  // ===========================================================================
  // Getter Accessors
  // ===========================================================================

  /** Unique identifier for this bundle record */
  get id(): string {
    return this._id;
  }

  /** User ID who owns this bundle */
  get userId(): string {
    return this._userId;
  }

  /** Signal Protocol registration ID */
  get registrationId(): number {
    return this._registrationId;
  }

  /** Long-term public identity key */
  get identityKey(): IdentityKey {
    return this._identityKey;
  }

  /** Current signed prekey */
  get signedPreKey(): SignedPreKey {
    return this._signedPreKey;
  }

  /** Defensive copy of the one-time prekeys array */
  get preKeys(): PublicPreKey[] {
    return [...this._preKeys];
  }

  /** Defensive copy of the consumed prekey IDs array */
  get usedPreKeyIds(): number[] {
    return [...this._usedPreKeyIds];
  }

  /** Timestamp when this bundle was first created */
  get createdAt(): Date {
    return this._createdAt;
  }

  /** Timestamp of the last modification */
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ===========================================================================
  // Static Factory Method
  // ===========================================================================

  /**
   * Creates a new PreKeyBundle with full validation.
   *
   * This is the primary entry point for constructing a bundle from client-uploaded
   * key material. Validates the entire bundle before accepting it.
   *
   * @param dto - Bundle creation data from the client
   * @returns A new PreKeyBundle instance with generated ID and timestamps
   * @throws Error if any bundle validation fails
   */
  static create(dto: {
    userId: string;
    registrationId: number;
    identityKey: IdentityKey;
    signedPreKey: SignedPreKey;
    preKeys: PublicPreKey[];
  }): PreKeyBundle {
    // Validate all key material before accepting the bundle
    PreKeyBundle.validateBundle({
      identityKey: dto.identityKey,
      signedPreKey: dto.signedPreKey,
      preKeys: dto.preKeys,
    });

    // Validate userId is provided
    if (!dto.userId || typeof dto.userId !== 'string' || dto.userId.trim().length === 0) {
      throw new Error('userId is required and must be a non-empty string');
    }

    // Validate registrationId is a positive integer
    if (typeof dto.registrationId !== 'number' || !Number.isInteger(dto.registrationId) || dto.registrationId <= 0) {
      throw new Error('registrationId must be a positive integer');
    }

    const now = new Date();

    return new PreKeyBundle({
      id: randomUUID(),
      userId: dto.userId,
      registrationId: dto.registrationId,
      identityKey: dto.identityKey,
      signedPreKey: dto.signedPreKey,
      preKeys: dto.preKeys,
      usedPreKeyIds: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  // ===========================================================================
  // Validation Methods
  // ===========================================================================

  /**
   * Validates the integrity of a prekey bundle's key material.
   *
   * Checks:
   * - Identity key exists with a valid non-empty base64-encoded public key
   * - Signed prekey exists with valid keyId, publicKey, signature, and timestamp
   * - At least one one-time prekey exists, each with valid keyId and publicKey
   * - No duplicate keyIds within the one-time prekeys array
   *
   * @param bundle - Bundle key material to validate
   * @throws Error with descriptive message for each validation failure
   */
  static validateBundle(bundle: {
    identityKey: IdentityKey;
    signedPreKey: SignedPreKey;
    preKeys: PublicPreKey[];
  }): void {
    // -------------------------------------------------------------------------
    // Identity Key Validation
    // -------------------------------------------------------------------------
    if (!bundle.identityKey) {
      throw new Error('Identity key is required');
    }
    if (
      !bundle.identityKey.publicKey ||
      typeof bundle.identityKey.publicKey !== 'string' ||
      bundle.identityKey.publicKey.trim().length === 0
    ) {
      throw new Error('Identity key publicKey must be a non-empty base64-encoded string');
    }

    // -------------------------------------------------------------------------
    // Signed PreKey Validation
    // -------------------------------------------------------------------------
    if (!bundle.signedPreKey) {
      throw new Error('Signed prekey is required');
    }
    if (
      typeof bundle.signedPreKey.keyId !== 'number' ||
      !Number.isFinite(bundle.signedPreKey.keyId) ||
      bundle.signedPreKey.keyId <= 0
    ) {
      throw new Error('Signed prekey keyId must be a positive number');
    }
    if (
      !bundle.signedPreKey.publicKey ||
      typeof bundle.signedPreKey.publicKey !== 'string' ||
      bundle.signedPreKey.publicKey.trim().length === 0
    ) {
      throw new Error('Signed prekey publicKey must be a non-empty base64-encoded string');
    }
    if (
      !bundle.signedPreKey.signature ||
      typeof bundle.signedPreKey.signature !== 'string' ||
      bundle.signedPreKey.signature.trim().length === 0
    ) {
      throw new Error('Signed prekey signature must be a non-empty base64-encoded string');
    }
    if (
      typeof bundle.signedPreKey.timestamp !== 'number' ||
      !Number.isFinite(bundle.signedPreKey.timestamp) ||
      bundle.signedPreKey.timestamp <= 0
    ) {
      throw new Error('Signed prekey timestamp must be a positive number');
    }

    // -------------------------------------------------------------------------
    // One-Time PreKeys Validation
    // -------------------------------------------------------------------------
    if (!Array.isArray(bundle.preKeys)) {
      throw new Error('PreKeys must be an array');
    }
    if (bundle.preKeys.length === 0) {
      throw new Error('PreKeys array must contain at least one one-time prekey');
    }

    const seenKeyIds = new Set<number>();
    for (const preKey of bundle.preKeys) {
      if (
        typeof preKey.keyId !== 'number' ||
        !Number.isFinite(preKey.keyId) ||
        preKey.keyId <= 0
      ) {
        throw new Error(`PreKey keyId must be a positive number, received: ${String(preKey.keyId)}`);
      }
      if (
        !preKey.publicKey ||
        typeof preKey.publicKey !== 'string' ||
        preKey.publicKey.trim().length === 0
      ) {
        throw new Error(`PreKey publicKey must be a non-empty string for keyId ${preKey.keyId}`);
      }
      if (seenKeyIds.has(preKey.keyId)) {
        throw new Error(`Duplicate prekey keyId detected: ${preKey.keyId}`);
      }
      seenKeyIds.add(preKey.keyId);
    }
  }

  // ===========================================================================
  // Business Logic Methods
  // ===========================================================================

  /**
   * Checks whether there are any unused one-time prekeys available.
   *
   * @returns true if at least one unconsumed prekey remains
   */
  hasAvailablePreKeys(): boolean {
    return this.getAvailablePreKeyCount() > 0;
  }

  /**
   * Returns the count of unused one-time prekeys.
   *
   * Calculated by filtering out prekeys whose keyId appears in the
   * usedPreKeyIds set.
   *
   * @returns Number of unconsumed one-time prekeys
   */
  getAvailablePreKeyCount(): number {
    return this._preKeys.filter(
      (pk) => !this._usedPreKeyIds.includes(pk.keyId)
    ).length;
  }

  /**
   * Consumes the next available one-time prekey.
   *
   * Finds the first prekey not in usedPreKeyIds, marks it as consumed by
   * adding its keyId to usedPreKeyIds, and returns it. The prekey remains
   * in the preKeys array for audit/tracking purposes — consumption is
   * tracked exclusively via usedPreKeyIds.
   *
   * @returns The consumed PublicPreKey, or null if all prekeys are exhausted
   */
  consumePreKey(): PublicPreKey | null {
    const available = this._preKeys.find(
      (pk) => !this._usedPreKeyIds.includes(pk.keyId)
    );

    if (!available) {
      return null;
    }

    this._usedPreKeyIds.push(available.keyId);
    this._updatedAt = new Date();

    return available;
  }

  /**
   * Determines whether the prekey supply needs replenishment.
   *
   * Returns true when the number of available (unconsumed) prekeys falls
   * at or below the specified threshold. The default threshold is
   * ENCRYPTION.PREKEY_LOW_THRESHOLD (10).
   *
   * Used by the prekey-replenish-notification BullMQ job to decide
   * when to notify the client to upload more prekeys.
   *
   * @param threshold - Minimum acceptable prekey count (default: PREKEY_LOW_THRESHOLD)
   * @returns true if available prekeys are at or below the threshold
   */
  needsReplenishment(threshold?: number): boolean {
    const effectiveThreshold = threshold ?? ENCRYPTION.PREKEY_LOW_THRESHOLD;
    return this.getAvailablePreKeyCount() <= effectiveThreshold;
  }

  /**
   * Adds new one-time prekeys to the bundle (replenishment).
   *
   * Validates that:
   * 1. The batch does not exceed ENCRYPTION.PREKEY_BATCH_SIZE
   * 2. No duplicate keyIds exist between new prekeys and existing prekeys
   * 3. Total prekey count stays within reasonable bounds
   *
   * @param newPreKeys - Array of new one-time prekeys to add
   * @throws Error if any duplicate keyId is found or batch size exceeded
   */
  addPreKeys(newPreKeys: PublicPreKey[]): void {
    // Validate batch size against configured maximum
    if (newPreKeys.length > ENCRYPTION.PREKEY_BATCH_SIZE) {
      throw new Error(
        `Cannot add more than ${ENCRYPTION.PREKEY_BATCH_SIZE} prekeys in a single batch`
      );
    }

    // Prevent unbounded prekey growth — cap at a reasonable maximum
    const maxTotalPreKeys = ENCRYPTION.PREKEY_INITIAL_COUNT * 3;
    if (this._preKeys.length + newPreKeys.length > maxTotalPreKeys) {
      throw new Error(
        `Total prekey count (${this._preKeys.length + newPreKeys.length}) would exceed maximum of ${maxTotalPreKeys}`
      );
    }

    // Check for duplicate keyIds against existing prekeys
    const existingKeyIds = new Set(this._preKeys.map((pk) => pk.keyId));
    for (const pk of newPreKeys) {
      if (existingKeyIds.has(pk.keyId)) {
        throw new Error(
          `Duplicate prekey keyId: ${pk.keyId} already exists in the bundle`
        );
      }
      // Also ensure no duplicates within the new batch itself
      existingKeyIds.add(pk.keyId);
    }

    this._preKeys.push(...newPreKeys);
    this._updatedAt = new Date();
  }

  /**
   * Returns the current signed prekey.
   *
   * @returns The medium-term signed prekey (signed by identity key)
   */
  getSignedPreKey(): SignedPreKey {
    return this._signedPreKey;
  }

  /**
   * Returns the identity key.
   *
   * @returns The long-term public identity key
   */
  getIdentityKey(): IdentityKey {
    return this._identityKey;
  }

  /**
   * Returns the bundle needed for another user to initiate X3DH key agreement.
   *
   * Consumes one one-time prekey (if available) as part of the exchange.
   * If no one-time prekeys remain, the X3DH protocol can still proceed
   * but with reduced forward secrecy for the initial message.
   *
   * @returns Object containing identityKey, signedPreKey, optional preKey, and registrationId
   */
  getBundleForKeyExchange(): {
    identityKey: IdentityKey;
    signedPreKey: SignedPreKey;
    preKey?: PublicPreKey;
    registrationId: number;
  } {
    const consumedPreKey = this.consumePreKey();

    return {
      identityKey: this._identityKey,
      signedPreKey: this._signedPreKey,
      preKey: consumedPreKey ?? undefined,
      registrationId: this._registrationId,
    };
  }

  // ===========================================================================
  // Serialization Methods
  // ===========================================================================

  /**
   * Serializes the bundle to the PreKeyBundleResponse API response format.
   *
   * Returns the bundle data another user needs for key exchange. Peeks at
   * the next available prekey without consuming it (consumption happens
   * via getBundleForKeyExchange()).
   *
   * @param _forUserId - Optional context: the user requesting the bundle (reserved for future use)
   * @returns Plain object matching PreKeyBundleResponse from shared types
   */
  toResponse(_forUserId?: string): PreKeyBundleResponse {
    // Peek at the next available prekey without consuming it
    const availablePreKey = this._preKeys.find(
      (pk) => !this._usedPreKeyIds.includes(pk.keyId)
    );

    return {
      userId: this._userId,
      identityKey: {
        publicKey: this._identityKey.publicKey,
        fingerprint: this._identityKey.fingerprint,
      },
      signedPreKey: {
        keyId: this._signedPreKey.keyId,
        publicKey: this._signedPreKey.publicKey,
        signature: this._signedPreKey.signature,
        timestamp: this._signedPreKey.timestamp,
      },
      preKey: availablePreKey
        ? { keyId: availablePreKey.keyId, publicKey: availablePreKey.publicKey }
        : undefined,
      registrationId: this._registrationId,
    };
  }

  /**
   * Serializes the bundle's prekey supply status for monitoring.
   *
   * Returns information about the prekey supply level, including
   * the count of remaining prekeys, the replenishment threshold,
   * and whether replenishment is currently needed.
   *
   * @returns Plain object matching PreKeyCountStatus from shared types
   */
  toStatusResponse(): PreKeyCountStatus {
    return {
      userId: this._userId,
      remainingPreKeys: this.getAvailablePreKeyCount(),
      threshold: ENCRYPTION.PREKEY_LOW_THRESHOLD,
      needsReplenishment: this.needsReplenishment(),
    };
  }
}
