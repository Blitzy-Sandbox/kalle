/**
 * Kalle — Signal Protocol Wrapper for E2E Encryption
 *
 * High-level API wrapping `@privacyresearch/libsignal-protocol-typescript`
 * for client-side E2E encryption.
 *
 * Provides:
 * - 1:1 sessions (X3DH key agreement + Double Ratchet)
 * - Group Sender Key distribution with automatic rotation on membership changes (R14)
 * - All encrypt/decrypt operations — the server NEVER sees plaintext (R12)
 * - Key material persisted in IndexedDB via `db.ts` module
 *
 * Security constraints:
 * - R12: All encryption/decryption happens client-side only
 * - R14: Sender Keys rotate on member removal — removed members cannot decrypt
 * - R23: ZERO logging of keys, prekey material, or plaintext
 */

import {
  KeyHelper,
  SignalProtocolAddress,
  SessionBuilder,
  SessionCipher,
  Direction,
} from '@privacyresearch/libsignal-protocol-typescript';
import type {
  KeyPairType,
  StorageType,
  PreKeyPairType,
  SignedPreKeyPairType,
  SessionRecordType,
} from '@privacyresearch/libsignal-protocol-typescript';

import { db } from './db';
import type {
  PreKeyBundleDTO,
  PreKeyBundleResponse,
  SenderKeyDistribution,
  SenderKeyRotationEvent,
} from '@kalle/shared';

// ---------------------------------------------------------------------------
// Utility: Base64 ↔ ArrayBuffer Conversion
// ---------------------------------------------------------------------------

/**
 * Encode an ArrayBuffer to a Base64 string.
 * Uses browser-native btoa for efficiency.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode a Base64 string to an ArrayBuffer.
 * Uses browser-native atob for efficiency.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Encode a string to an ArrayBuffer (UTF-8).
 */
function stringToArrayBuffer(str: string): ArrayBuffer {
  const encoder = new TextEncoder();
  return encoder.encode(str).buffer;
}

/**
 * Decode an ArrayBuffer to a string (UTF-8).
 */
function arrayBufferToString(buffer: ArrayBuffer): string {
  const decoder = new TextDecoder();
  return decoder.decode(buffer);
}

// ---------------------------------------------------------------------------
// Utility: Group Encryption Primitives (Sender Key Protocol — R14)
// ---------------------------------------------------------------------------

/**
 * Generate a random 256-bit AES key for Sender Key group encryption.
 * Uses Web Crypto API for cryptographically secure random generation.
 */
async function generateGroupKey(): Promise<ArrayBuffer> {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  return crypto.subtle.exportKey('raw', key);
}

/**
 * Encrypt data with AES-256-GCM using the provided key material.
 * Returns a concatenation of 12-byte IV + ciphertext + 16-byte auth tag.
 */
async function aesGcmEncrypt(
  key: ArrayBuffer,
  plaintext: ArrayBuffer
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // Use Uint8Array view to avoid cross-realm ArrayBuffer instanceof failures
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(key),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    plaintext
  );
  // Concatenate: IV (12 bytes) + ciphertext (includes auth tag)
  const result = new Uint8Array(iv.byteLength + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.byteLength);
  return result.buffer;
}

/**
 * Decrypt data with AES-256-GCM using the provided key material.
 * Expects input format: 12-byte IV + ciphertext + 16-byte auth tag.
 */
async function aesGcmDecrypt(
  key: ArrayBuffer,
  data: ArrayBuffer
): Promise<ArrayBuffer> {
  const dataBytes = new Uint8Array(data);
  const iv = dataBytes.slice(0, 12);
  const ciphertext = dataBytes.slice(12);
  // Use Uint8Array view to avoid cross-realm ArrayBuffer instanceof failures
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(key),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext
  );
}

// ---------------------------------------------------------------------------
// Signal Protocol Store (IndexedDB-backed — R12)
// ---------------------------------------------------------------------------

/**
 * IndexedDB-backed Signal Protocol storage implementation.
 *
 * All key material is persisted to IndexedDB via the Dexie `db` instance,
 * ensuring persistence across page refreshes and browser restarts.
 *
 * Implements `StorageType` from the Signal Protocol library.
 *
 * CRITICAL (R23): This class MUST NOT log any key material.
 */
export class SignalProtocolStore implements StorageType {

  // ---- Identity Key Pair ----

  /**
   * Retrieve the local identity key pair from IndexedDB.
   * Returns undefined if no identity has been generated yet.
   */
  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    const record = await db.identityKeys.get('local');
    if (!record || !record.privateKey) {
      return undefined;
    }
    return {
      pubKey: base64ToArrayBuffer(record.publicKey),
      privKey: base64ToArrayBuffer(record.privateKey),
    };
  }

  /**
   * Save a remote identity key for the given address.
   * Returns `true` if this is a new/changed identity (TOFU model).
   */
  async saveIdentity(
    identifier: string,
    identityKey: ArrayBuffer
  ): Promise<boolean> {
    const address = SignalProtocolAddress.fromString(identifier);
    const addressName = address.name;

    const existing = await db.identityKeys.get(addressName);
    const newPublicKey = arrayBufferToBase64(identityKey);

    if (existing && existing.publicKey === newPublicKey) {
      return false; // Identity unchanged
    }

    await db.identityKeys.put({
      id: addressName,
      publicKey: newPublicKey,
    });

    return true; // Identity is new or changed
  }

  /**
   * Determine if the given identity key is trusted.
   * Implements Trust On First Use (TOFU): trusts the first identity seen
   * for a given address, and trusts subsequent identical keys.
   */
  async isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer,
    _direction: Direction
  ): Promise<boolean> {
    const address = SignalProtocolAddress.fromString(identifier);
    const addressName = address.name;

    const existing = await db.identityKeys.get(addressName);
    if (!existing) {
      return true; // TOFU: trust on first use
    }
    return existing.publicKey === arrayBufferToBase64(identityKey);
  }

  // ---- Registration ID ----

  /**
   * Retrieve the local device registration ID from IndexedDB.
   */
  async getLocalRegistrationId(): Promise<number | undefined> {
    const record = await db.registration.get('local');
    return record?.registrationId;
  }

  // ---- PreKey Storage ----

  /**
   * Load a one-time prekey by its ID from IndexedDB.
   */
  async loadPreKey(keyId: number | string): Promise<KeyPairType | undefined> {
    const numericId = typeof keyId === 'string' ? parseInt(keyId, 10) : keyId;
    const record = await db.preKeys.get(numericId);
    if (!record) {
      return undefined;
    }
    return {
      pubKey: base64ToArrayBuffer(record.publicKey),
      privKey: base64ToArrayBuffer(record.privateKey),
    };
  }

  /**
   * Store a one-time prekey in IndexedDB.
   */
  async storePreKey(
    keyId: number | string,
    keyPair: KeyPairType
  ): Promise<void> {
    const numericId = typeof keyId === 'string' ? parseInt(keyId, 10) : keyId;
    await db.preKeys.put({
      keyId: numericId,
      publicKey: arrayBufferToBase64(keyPair.pubKey),
      privateKey: arrayBufferToBase64(keyPair.privKey),
    });
  }

  /**
   * Remove a consumed one-time prekey from IndexedDB.
   */
  async removePreKey(keyId: number | string): Promise<void> {
    const numericId = typeof keyId === 'string' ? parseInt(keyId, 10) : keyId;
    await db.preKeys.delete(numericId);
  }

  // ---- Signed PreKey Storage ----

  /**
   * Load a signed prekey by its ID from IndexedDB.
   */
  async loadSignedPreKey(
    keyId: number | string
  ): Promise<KeyPairType | undefined> {
    const numericId = typeof keyId === 'string' ? parseInt(keyId, 10) : keyId;
    const record = await db.signedPreKeys.get(numericId);
    if (!record) {
      return undefined;
    }
    return {
      pubKey: base64ToArrayBuffer(record.publicKey),
      privKey: base64ToArrayBuffer(record.privateKey),
    };
  }

  /**
   * Store a signed prekey in IndexedDB.
   */
  async storeSignedPreKey(
    keyId: number | string,
    keyPair: KeyPairType
  ): Promise<void> {
    const numericId = typeof keyId === 'string' ? parseInt(keyId, 10) : keyId;
    await db.signedPreKeys.put({
      keyId: numericId,
      publicKey: arrayBufferToBase64(keyPair.pubKey),
      privateKey: arrayBufferToBase64(keyPair.privKey),
      signature: '',
      timestamp: Date.now(),
    });
  }

  /**
   * Remove a signed prekey from IndexedDB.
   */
  async removeSignedPreKey(keyId: number | string): Promise<void> {
    const numericId = typeof keyId === 'string' ? parseInt(keyId, 10) : keyId;
    await db.signedPreKeys.delete(numericId);
  }

  // ---- Session Storage (Double Ratchet State) ----

  /**
   * Load a serialised session record for the given address from IndexedDB.
   */
  async loadSession(
    identifier: string
  ): Promise<SessionRecordType | undefined> {
    const record = await db.sessions.get(identifier);
    return record?.record;
  }

  /**
   * Store a serialised session record for the given address in IndexedDB.
   */
  async storeSession(
    identifier: string,
    record: SessionRecordType
  ): Promise<void> {
    await db.sessions.put({
      id: identifier,
      record,
    });
  }

  /**
   * Remove a single session record for the given address from IndexedDB.
   */
  async removeSession(identifier: string): Promise<void> {
    await db.sessions.delete(identifier);
  }

  /**
   * Remove all session records for a given user (across all device IDs).
   * Matches all sessions whose ID starts with "userId.".
   */
  async removeAllSessions(identifier: string): Promise<void> {
    const allSessions = await db.sessions.toArray();
    const toDelete = allSessions
      .filter((s) => s.id.startsWith(`${identifier}.`))
      .map((s) => s.id);
    await db.sessions.bulkDelete(toDelete);
  }
}

// ---------------------------------------------------------------------------
// Singleton Store Instance
// ---------------------------------------------------------------------------

/**
 * Singleton `SignalProtocolStore` instance used by all encryption operations.
 * Exported for use by hooks and other modules requiring store access.
 */
export const store = new SignalProtocolStore();

// ---------------------------------------------------------------------------
// Phase 3: Key Generation Functions
// ---------------------------------------------------------------------------

/**
 * Generate a new Curve25519 identity key pair.
 * The identity key is the long-term anchor of trust in the Signal Protocol.
 */
export async function generateIdentityKeyPair(): Promise<KeyPairType> {
  return KeyHelper.generateIdentityKeyPair();
}

/**
 * Generate a random registration ID for Signal Protocol session establishment.
 * Registration IDs are 14-bit unsigned integers (0–16383).
 */
export async function generateRegistrationId(): Promise<number> {
  return KeyHelper.generateRegistrationId();
}

/**
 * Generate a batch of one-time prekeys starting from `startId`.
 *
 * Each prekey is used exactly once during X3DH key agreement, then consumed.
 * Clients typically maintain ~100 prekeys on the server and replenish
 * when the supply drops below a threshold.
 *
 * @param startId - Starting key ID for the batch
 * @param count - Number of prekeys to generate
 * @returns Array of prekey pairs with sequential IDs
 */
export async function generatePreKeys(
  startId: number,
  count: number
): Promise<PreKeyPairType[]> {
  const preKeys: PreKeyPairType[] = [];
  for (let i = 0; i < count; i++) {
    const preKey = await KeyHelper.generatePreKey(startId + i);
    preKeys.push(preKey);
  }
  return preKeys;
}

/**
 * Generate a signed prekey, signed by the identity key.
 *
 * Signed prekeys are medium-term keys (rotated every 7–30 days) that prove
 * ownership via an Ed25519 signature from the identity key.
 *
 * @param identityKeyPair - The local identity key pair for signing
 * @param signedPreKeyId - Sequential ID for this signed prekey
 */
export async function generateSignedPreKey(
  identityKeyPair: KeyPairType,
  signedPreKeyId: number
): Promise<SignedPreKeyPairType> {
  return KeyHelper.generateSignedPreKey(identityKeyPair, signedPreKeyId);
}

// ---------------------------------------------------------------------------
// Phase 4: PreKey Bundle Assembly
// ---------------------------------------------------------------------------

/** Default number of one-time prekeys to generate in a batch */
const DEFAULT_PREKEY_BATCH_SIZE = 100;

/** Starting ID offset for signed prekeys */
const SIGNED_PREKEY_START_ID = 1;

/**
 * Assemble a complete PreKey bundle for upload to the server.
 *
 * Loads the local identity key pair and registration ID, generates a fresh
 * signed prekey and a batch of one-time prekeys, persists all key material
 * to IndexedDB, and returns the public portions as a `PreKeyBundleDTO`
 * for server upload.
 *
 * @returns PreKeyBundleDTO with base64-encoded public key material
 * @throws Error if the identity key pair is not initialized
 */
export async function assemblePreKeyBundle(): Promise<PreKeyBundleDTO> {
  const identityKeyPair = await store.getIdentityKeyPair();
  if (!identityKeyPair) {
    throw new Error(
      'Identity key pair not found. Call initializeEncryption() first.'
    );
  }

  const registrationId = await store.getLocalRegistrationId();
  if (registrationId === undefined) {
    throw new Error(
      'Registration ID not found. Call initializeEncryption() first.'
    );
  }

  // Determine next signed prekey ID
  const existingSignedPreKeys = await db.signedPreKeys.toArray();
  const nextSignedPreKeyId =
    existingSignedPreKeys.length > 0
      ? Math.max(...existingSignedPreKeys.map((k) => k.keyId)) + 1
      : SIGNED_PREKEY_START_ID;

  // Generate signed prekey
  const signedPreKey = await generateSignedPreKey(
    identityKeyPair,
    nextSignedPreKeyId
  );

  // Store signed prekey with signature
  await db.signedPreKeys.put({
    keyId: signedPreKey.keyId,
    publicKey: arrayBufferToBase64(signedPreKey.keyPair.pubKey),
    privateKey: arrayBufferToBase64(signedPreKey.keyPair.privKey),
    signature: arrayBufferToBase64(signedPreKey.signature),
    timestamp: Date.now(),
  });

  // Determine next prekey start ID
  const existingPreKeys = await db.preKeys.toArray();
  const nextPreKeyStartId =
    existingPreKeys.length > 0
      ? Math.max(...existingPreKeys.map((k) => k.keyId)) + 1
      : 1;

  // Generate one-time prekeys
  const preKeys = await generatePreKeys(
    nextPreKeyStartId,
    DEFAULT_PREKEY_BATCH_SIZE
  );

  // Store one-time prekeys in IndexedDB
  for (const preKey of preKeys) {
    await store.storePreKey(preKey.keyId, preKey.keyPair);
  }

  // Assemble the DTO with base64-encoded public portions
  return {
    identityKey: {
      publicKey: arrayBufferToBase64(identityKeyPair.pubKey),
    },
    signedPreKey: {
      keyId: signedPreKey.keyId,
      publicKey: arrayBufferToBase64(signedPreKey.keyPair.pubKey),
      signature: arrayBufferToBase64(signedPreKey.signature),
      timestamp: Date.now(),
    },
    preKeys: preKeys.map((pk) => ({
      keyId: pk.keyId,
      publicKey: arrayBufferToBase64(pk.keyPair.pubKey),
    })),
    registrationId,
  };
}

// ---------------------------------------------------------------------------
// Phase 5: 1:1 Session Management (X3DH + Double Ratchet)
// ---------------------------------------------------------------------------

/**
 * Establish a new Signal Protocol session with a remote user.
 *
 * Uses the X3DH key agreement protocol to derive shared secrets from the
 * recipient's prekey bundle. The resulting session uses the Double Ratchet
 * algorithm for ongoing message encryption.
 *
 * @param recipientId - User ID of the remote party
 * @param recipientDeviceId - Device ID of the remote party
 * @param preKeyBundle - PreKey bundle fetched from the server
 */
export async function createSession(
  recipientId: string,
  recipientDeviceId: number,
  preKeyBundle: PreKeyBundleResponse
): Promise<void> {
  const address = new SignalProtocolAddress(recipientId, recipientDeviceId);
  const builder = new SessionBuilder(store, address);

  // Build the device type from the server's prekey bundle response
  const device = {
    identityKey: base64ToArrayBuffer(preKeyBundle.identityKey.publicKey),
    signedPreKey: {
      keyId: preKeyBundle.signedPreKey.keyId,
      publicKey: base64ToArrayBuffer(preKeyBundle.signedPreKey.publicKey),
      signature: base64ToArrayBuffer(preKeyBundle.signedPreKey.signature),
    },
    preKey: preKeyBundle.preKey
      ? {
          keyId: preKeyBundle.preKey.keyId,
          publicKey: base64ToArrayBuffer(preKeyBundle.preKey.publicKey),
        }
      : undefined,
    registrationId: preKeyBundle.registrationId,
  };

  // Process the prekey bundle — establishes X3DH and initialises Double Ratchet
  await builder.processPreKey(device);
}

/**
 * Check whether an active Signal Protocol session exists with the given user.
 *
 * @param recipientId - User ID to check
 * @param deviceId - Device ID to check
 * @returns true if a session record exists in IndexedDB
 */
export async function hasSession(
  recipientId: string,
  deviceId: number
): Promise<boolean> {
  const address = new SignalProtocolAddress(recipientId, deviceId);
  const sessionRecord = await store.loadSession(address.toString());
  return sessionRecord !== undefined && sessionRecord !== null;
}

// ---------------------------------------------------------------------------
// Phase 6: Message Encryption / Decryption (1:1)
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext message for a 1:1 conversation.
 *
 * Uses the Double Ratchet session cipher to encrypt the message. The ratchet
 * advances automatically on each encryption, providing forward secrecy.
 *
 * CRITICAL (R12): The returned ciphertext is the ONLY form that should be
 * transmitted to the server. Plaintext MUST NEVER leave the client.
 *
 * @param recipientId - User ID of the message recipient
 * @param deviceId - Device ID of the recipient
 * @param plaintext - UTF-8 plaintext message content
 * @returns Base64-encoded ciphertext with message type prefix
 */
export async function encryptMessage(
  recipientId: string,
  deviceId: number,
  plaintext: string
): Promise<string> {
  const address = new SignalProtocolAddress(recipientId, deviceId);
  const cipher = new SessionCipher(store, address);

  const plaintextBuffer = stringToArrayBuffer(plaintext);
  const ciphertextMessage = await cipher.encrypt(plaintextBuffer);

  // Encode message type and body together for wire format
  // Format: "<type>:<base64-body>"
  const bodyBase64 = ciphertextMessage.body
    ? btoa(ciphertextMessage.body)
    : '';
  return `${ciphertextMessage.type}:${bodyBase64}`;
}

/**
 * Decrypt a ciphertext message from a 1:1 conversation.
 *
 * Handles both PreKeyWhisperMessage (first message establishing a session)
 * and regular WhisperMessage (subsequent messages in an established session).
 * The Double Ratchet advances automatically on each decryption.
 *
 * @param senderId - User ID of the message sender
 * @param deviceId - Device ID of the sender
 * @param ciphertext - Base64-encoded ciphertext with type prefix
 * @param isPreKeyMessage - Whether this is a PreKeyWhisperMessage (first message)
 * @returns Decrypted UTF-8 plaintext string
 */
export async function decryptMessage(
  senderId: string,
  deviceId: number,
  ciphertext: string,
  isPreKeyMessage: boolean
): Promise<string> {
  const address = new SignalProtocolAddress(senderId, deviceId);
  const cipher = new SessionCipher(store, address);

  // Parse the wire format: "<type>:<base64-body>"
  const colonIndex = ciphertext.indexOf(':');
  const body =
    colonIndex >= 0 ? atob(ciphertext.substring(colonIndex + 1)) : ciphertext;

  let plaintext: ArrayBuffer;

  if (isPreKeyMessage) {
    // First message — uses PreKeyWhisperMessage which also establishes the session
    plaintext = await cipher.decryptPreKeyWhisperMessage(body, 'binary');
  } else {
    // Subsequent messages — uses standard WhisperMessage
    plaintext = await cipher.decryptWhisperMessage(body, 'binary');
  }

  return arrayBufferToString(plaintext);
}

// ---------------------------------------------------------------------------
// Phase 7: Group Encryption (Sender Keys — R14)
// ---------------------------------------------------------------------------
//
// The installed library (@privacyresearch/libsignal-protocol-typescript) does
// not include native GroupCipher / SenderKeyDistributionMessage support.
// We implement the Sender Key protocol using AES-256-GCM with keys stored
// in IndexedDB (`db.senderKeys`). Each sender in a group generates a
// symmetric key; the distribution message carries the key material encrypted
// for each member via their 1:1 Signal session.
//
// Per R14: Sender Keys rotate on member removal. After rotation, removed
// members cannot decrypt new messages.
// ---------------------------------------------------------------------------

/** Internal counter for Sender Key chain iterations */
let senderKeyIterationCounter = 0;

/**
 * Create a new Sender Key for a group conversation.
 *
 * Generates a fresh AES-256-GCM key, stores it in IndexedDB under the
 * composite key "groupId:local", and returns a `SenderKeyDistribution`
 * DTO. The distribution message (base64-encoded key) must be sent to all
 * current group members via their 1:1 sessions.
 *
 * @param groupId - Conversation ID of the group
 * @returns SenderKeyDistribution DTO for broadcasting to group members
 */
export async function createSenderKey(
  groupId: string
): Promise<SenderKeyDistribution> {
  const registrationRecord = await db.registration.get('local');
  const senderId = registrationRecord
    ? String(registrationRecord.registrationId)
    : 'local';

  // Generate a new AES-256-GCM key for this group
  const groupKey = await generateGroupKey();
  const distributionMessage = arrayBufferToBase64(groupKey);

  // Increment the chain counter
  senderKeyIterationCounter += 1;
  const chainId = senderKeyIterationCounter;
  const iteration = senderKeyIterationCounter;

  // Store the sender key in IndexedDB
  await db.senderKeys.put({
    id: `${groupId}:local`,
    record: distributionMessage,
  });

  return {
    groupId,
    senderId,
    distributionMessage,
    chainId,
    iteration,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Process a received Sender Key distribution message from a group member.
 *
 * Stores the sender's AES-256-GCM key in IndexedDB under the composite
 * key "groupId:senderId", enabling decryption of their subsequent messages
 * in the group.
 *
 * @param groupId - Conversation ID of the group
 * @param senderId - User ID of the sender who generated the key
 * @param distributionMessage - Base64-encoded Sender Key material
 */
export async function processSenderKeyDistribution(
  groupId: string,
  senderId: string,
  distributionMessage: string
): Promise<void> {
  // Validate that the distribution message is valid base64
  try {
    base64ToArrayBuffer(distributionMessage);
  } catch {
    throw new Error('Invalid Sender Key distribution message format');
  }

  // Store the sender key for this group member
  await db.senderKeys.put({
    id: `${groupId}:${senderId}`,
    record: distributionMessage,
  });
}

/**
 * Encrypt a plaintext message for a group conversation using Sender Keys.
 *
 * Uses the local sender's AES-256-GCM key stored in IndexedDB to encrypt
 * the message. All group members who have processed the sender's key
 * distribution can decrypt the result.
 *
 * CRITICAL (R12): The returned ciphertext is the ONLY form that should be
 * transmitted. Plaintext MUST NEVER leave the client.
 *
 * @param groupId - Conversation ID of the group
 * @param plaintext - UTF-8 plaintext message content
 * @returns Base64-encoded ciphertext (IV + AES-GCM encrypted data)
 */
export async function encryptGroupMessage(
  groupId: string,
  plaintext: string
): Promise<string> {
  const senderKeyRecord = await db.senderKeys.get(`${groupId}:local`);
  if (!senderKeyRecord) {
    throw new Error(
      `No Sender Key found for group "${groupId}". Call createSenderKey() first.`
    );
  }

  const key = base64ToArrayBuffer(senderKeyRecord.record);
  const plaintextBuffer = stringToArrayBuffer(plaintext);
  const encrypted = await aesGcmEncrypt(key, plaintextBuffer);

  return arrayBufferToBase64(encrypted);
}

/**
 * Decrypt a ciphertext message from a group conversation.
 *
 * Uses the sender's AES-256-GCM key (received via Sender Key distribution)
 * to decrypt the message. Requires that the sender's key distribution
 * has been processed via `processSenderKeyDistribution` first.
 *
 * @param groupId - Conversation ID of the group
 * @param senderId - User ID of the message sender
 * @param ciphertext - Base64-encoded ciphertext
 * @returns Decrypted UTF-8 plaintext string
 */
export async function decryptGroupMessage(
  groupId: string,
  senderId: string,
  ciphertext: string
): Promise<string> {
  const senderKeyRecord = await db.senderKeys.get(`${groupId}:${senderId}`);
  if (!senderKeyRecord) {
    throw new Error(
      `No Sender Key found for sender "${senderId}" in group "${groupId}". ` +
        'Sender Key distribution has not been processed.'
    );
  }

  const key = base64ToArrayBuffer(senderKeyRecord.record);
  const encryptedData = base64ToArrayBuffer(ciphertext);
  const decrypted = await aesGcmDecrypt(key, encryptedData);

  return arrayBufferToString(decrypted);
}

// ---------------------------------------------------------------------------
// Phase 8: Sender Key Rotation (R14)
// ---------------------------------------------------------------------------

/**
 * Rotate the Sender Key for a group conversation.
 *
 * Generates a NEW AES-256-GCM key and replaces the old one in IndexedDB.
 * The new distribution message must be broadcast to all *remaining* group
 * members. Removed members who do not receive the new key cannot decrypt
 * any messages encrypted after rotation.
 *
 * Per R14:
 * - `member_removed`: Removed user cannot decrypt future messages
 * - `member_added`: New user cannot decrypt historical messages
 * - `key_compromised`: Emergency rotation for security breach
 *
 * @param groupId - Conversation ID of the group
 * @param reason - Rotation trigger reason
 * @returns SenderKeyDistribution DTO for broadcasting to remaining members
 */
export async function rotateSenderKey(
  groupId: string,
  reason: SenderKeyRotationEvent['reason']
): Promise<SenderKeyDistribution> {
  // Delete the old sender key for this group
  await db.senderKeys.delete(`${groupId}:local`);

  // Create a brand new sender key (the old key is now unusable)
  const distribution = await createSenderKey(groupId);

  // Attach reason context (logged at the application layer, not here — R23)
  void reason; // Used by callers for audit trail; not logged here

  return distribution;
}

// ---------------------------------------------------------------------------
// Phase 9: Initialization and Cleanup
// ---------------------------------------------------------------------------

/** Number of one-time prekeys to generate during initial setup */
const INITIAL_PREKEY_COUNT = 100;

/**
 * Initialise the local encryption state on app startup.
 *
 * If the local identity key pair does not exist in IndexedDB (first use),
 * generates a new identity key pair, registration ID, and initial batch
 * of one-time prekeys. All key material is persisted to IndexedDB.
 *
 * This function is idempotent — calling it when keys already exist is a no-op.
 */
export async function initializeEncryption(): Promise<void> {
  const existingIdentity = await store.getIdentityKeyPair();
  if (existingIdentity) {
    return; // Already initialised — no-op
  }

  // Generate identity key pair
  const identityKeyPair = await generateIdentityKeyPair();

  // Store identity key pair in IndexedDB
  await db.identityKeys.put({
    id: 'local',
    publicKey: arrayBufferToBase64(identityKeyPair.pubKey),
    privateKey: arrayBufferToBase64(identityKeyPair.privKey),
  });

  // Generate and store registration ID
  const regId = await generateRegistrationId();
  await db.registration.put({
    id: 'local',
    registrationId: regId,
  });

  // Generate and store initial batch of one-time prekeys
  const preKeys = await generatePreKeys(1, INITIAL_PREKEY_COUNT);
  for (const preKey of preKeys) {
    await store.storePreKey(preKey.keyId, preKey.keyPair);
  }

  // Generate and store initial signed prekey
  const signedPreKey = await generateSignedPreKey(identityKeyPair, 1);
  await db.signedPreKeys.put({
    keyId: signedPreKey.keyId,
    publicKey: arrayBufferToBase64(signedPreKey.keyPair.pubKey),
    privateKey: arrayBufferToBase64(signedPreKey.keyPair.privKey),
    signature: arrayBufferToBase64(signedPreKey.signature),
    timestamp: Date.now(),
  });
}

/**
 * Clear ALL encryption data from IndexedDB.
 *
 * MUST be called on user logout to prevent key material from persisting
 * after the session ends. Clears identity keys, pre-keys, signed pre-keys,
 * sessions, sender keys, and registration data.
 *
 * This operation is irreversible — all Signal Protocol sessions will be
 * invalidated and must be re-established on next login.
 */
export async function clearAllEncryptionData(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.identityKeys,
      db.preKeys,
      db.signedPreKeys,
      db.sessions,
      db.senderKeys,
      db.registration,
    ],
    async () => {
      await db.identityKeys.clear();
      await db.preKeys.clear();
      await db.signedPreKeys.clear();
      await db.sessions.clear();
      await db.senderKeys.clear();
      await db.registration.clear();
    }
  );

  // Reset the internal sender key iteration counter
  senderKeyIterationCounter = 0;
}
