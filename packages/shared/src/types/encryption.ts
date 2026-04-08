/**
 * @module @kalle/shared/types/encryption
 *
 * E2E encryption-related TypeScript types for Signal Protocol integration.
 *
 * Covers:
 * - PreKey bundles (X3DH key agreement) for 1:1 session establishment
 * - Signed prekeys, identity keys, and one-time prekeys
 * - Sender Key distribution and rotation for group messaging
 * - Key status monitoring for prekey replenishment and session tracking
 *
 * Consumed by:
 * - Frontend encryption library (`apps/web/src/lib/encryption.ts`)
 * - Backend key exchange endpoints (`apps/api/src/controllers/KeyController.ts`)
 * - API contracts (`packages/shared/src/types/api-contracts.ts`)
 *
 * Security constraints (from AAP):
 * - R12: All encryption/decryption happens client-side; server stores only ciphertext
 * - R14: Group encryption uses Sender Keys with automatic rotation on membership changes
 * - R23: Logs MUST NOT contain encryption keys or prekey material
 * - R10: Seed data must include valid encryption key material
 *
 * All key material is represented as Base64-encoded strings (not raw byte arrays).
 * All date/time fields use ISO 8601 string format.
 * This file contains ZERO runtime code — only TypeScript interfaces.
 */

// ============================================================================
// Phase 1: Signal Protocol Key Primitives
// ============================================================================

/**
 * IdentityKey — Long-term public identity key for a user.
 *
 * Generated once during registration and used for the lifetime of the account.
 * The identity key is the anchor of trust in the Signal Protocol — it signs
 * the signed prekey and is used in the X3DH key agreement.
 */
export interface IdentityKey {
  /** Base64-encoded Curve25519 public key bytes */
  publicKey: string;

  /**
   * Optional safety number / fingerprint for out-of-band verification.
   * Derived from both parties' identity keys for contact verification UI.
   */
  fingerprint?: string;
}

/**
 * SignedPreKey — Medium-term signed prekey, rotated periodically.
 *
 * Signed by the identity key to prove ownership. Used as part of the X3DH
 * key agreement when initiating a new session. Typically rotated every 7–30 days.
 */
export interface SignedPreKey {
  /** Unique identifier for this signed prekey */
  keyId: number;

  /** Base64-encoded Curve25519 public key bytes */
  publicKey: string;

  /** Base64-encoded Ed25519 signature (signed by the identity key) */
  signature: string;

  /** Unix timestamp (milliseconds) when this key was generated */
  timestamp: number;
}

/**
 * PublicPreKey — One-time prekey, consumed on first message.
 *
 * Provides forward secrecy for the initial key exchange. Each one-time prekey
 * is used exactly once, then discarded by the server. Clients should maintain
 * a supply of ~100 prekeys on the server and replenish when the count drops
 * below the threshold (see PreKeyCountStatus).
 */
export interface PublicPreKey {
  /** Unique identifier for this one-time prekey */
  keyId: number;

  /** Base64-encoded Curve25519 public key bytes */
  publicKey: string;
}

// ============================================================================
// Phase 2: PreKey Bundle Types (X3DH Key Agreement)
// ============================================================================

/**
 * PreKeyBundleDTO — Payload for uploading a prekey bundle to the server.
 *
 * The client uploads this bundle after registration (and periodically to
 * replenish one-time prekeys) so that other users can initiate X3DH
 * sessions and send encrypted messages without requiring real-time
 * key exchange.
 */
export interface PreKeyBundleDTO {
  /** The user's long-term identity key */
  identityKey: IdentityKey;

  /** The user's current signed prekey */
  signedPreKey: SignedPreKey;

  /** Array of one-time prekeys (typically 100 at a time for initial upload) */
  preKeys: PublicPreKey[];

  /** Client's registration ID for Signal Protocol session establishment */
  registrationId: number;
}

/**
 * PreKeyBundleResponse — Bundle returned when fetching another user's keys.
 *
 * The server returns one identity key, one signed prekey, and at most one
 * one-time prekey (which is consumed and removed from the server on fetch).
 * If no one-time prekeys remain, the preKey field is undefined — the X3DH
 * protocol can still proceed without it, but with reduced forward secrecy
 * for the initial message.
 */
export interface PreKeyBundleResponse {
  /** The target user's ID */
  userId: string;

  /** The target user's long-term identity key */
  identityKey: IdentityKey;

  /** The target user's current signed prekey */
  signedPreKey: SignedPreKey;

  /**
   * A single one-time prekey consumed from the server's supply.
   * Optional: may be undefined if the user's one-time prekeys are exhausted.
   */
  preKey?: PublicPreKey;

  /** The target user's registration ID for session establishment */
  registrationId: number;
}

// ============================================================================
// Phase 3: Sender Key Types (Group Encryption — R14)
// ============================================================================

/**
 * SenderKeyDistribution — Distributed to group members for group message decryption.
 *
 * When a user sends their first message in a group (or when group membership
 * changes), they generate a new Sender Key and distribute it to all current
 * group members. Each member stores the Sender Key and uses it to decrypt
 * subsequent messages from that sender in the group.
 *
 * Per R14: Sender Keys rotate on member removal. Removed members cannot
 * decrypt post-removal messages; added members cannot decrypt pre-join messages.
 */
export interface SenderKeyDistribution {
  /** Conversation ID (group) this Sender Key is for */
  groupId: string;

  /** User ID of the sender who generated this Sender Key */
  senderId: string;

  /** Base64-encoded Sender Key Distribution Message (SKDM) */
  distributionMessage: string;

  /** Chain identifier within the Sender Key session */
  chainId: number;

  /** Key iteration counter (increments on each rotation) */
  iteration: number;

  /** ISO 8601 timestamp when this Sender Key was created */
  createdAt: string;
}

/**
 * SenderKeyRotationEvent — Emitted when Sender Keys must be rotated.
 *
 * Triggered by group membership changes (member added/removed) or
 * suspected key compromise. All remaining group members must generate
 * new Sender Keys and redistribute them.
 *
 * Per R14:
 * - member_removed: Removed user cannot decrypt future messages
 * - member_added: New user cannot decrypt historical messages
 * - key_compromised: Emergency rotation for security breach
 */
export interface SenderKeyRotationEvent {
  /** Conversation ID of the group requiring key rotation */
  groupId: string;

  /** Reason for the Sender Key rotation */
  reason: 'member_removed' | 'member_added' | 'key_compromised';

  /** User ID of the removed member (present when reason is 'member_removed') */
  removedUserId?: string;

  /** User ID of the added member (present when reason is 'member_added') */
  addedUserId?: string;

  /** ISO 8601 timestamp of the rotation event */
  timestamp: string;
}

// ============================================================================
// Phase 4: Key Status Types
// ============================================================================

/**
 * PreKeyCountStatus — Monitors prekey supply for replenishment.
 *
 * Used by the prekey-replenish-notification BullMQ job to detect when
 * a user's one-time prekey supply on the server drops below the minimum
 * threshold, triggering a notification to the client to upload more prekeys.
 */
export interface PreKeyCountStatus {
  /** User ID whose prekey supply is being monitored */
  userId: string;

  /** Count of unused one-time prekeys remaining on the server */
  remainingPreKeys: number;

  /** Minimum acceptable count before replenishment is needed (typically 20) */
  threshold: number;

  /** Whether remainingPreKeys is below the threshold */
  needsReplenishment: boolean;
}

/**
 * KeyExchangeStatus — Tracks whether a Signal session has been established.
 *
 * Used by the frontend to determine if a prekey bundle fetch is needed
 * before sending the first message to a contact, and to display session
 * verification status in the contact info UI.
 */
export interface KeyExchangeStatus {
  /** User ID of the contact */
  userId: string;

  /** Whether an active Signal Protocol session exists with this user */
  hasSession: boolean;

  /** Protocol version of the established session (if any) */
  sessionVersion?: number;

  /** ISO 8601 timestamp of the last key exchange (session establishment or ratchet) */
  lastKeyExchangeAt?: string;
}
