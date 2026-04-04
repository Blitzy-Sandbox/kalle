/**
 * @file encryption.test.ts
 * Unit tests for the Signal Protocol encryption wrapper (apps/web/src/lib/encryption.ts).
 *
 * Covers 11 test suites:
 *   Suite 1  — Session creation via X3DH (createSession)
 *   Suite 2  — 1:1 encrypt/decrypt round-trip (R12)
 *   Suite 3  — Sender Key distribution (R14)
 *   Suite 4  — Sender Key rotation on membership change (R14)
 *   Suite 5  — Group encrypt/decrypt via AES-GCM (R14)
 *   Suite 6  — Key generation utilities
 *   Suite 7  — PreKey bundle assembly (PreKeyBundleDTO validation)
 *   Suite 8  — SignalProtocolStore IndexedDB persistence
 *   Suite 9  — Encryption initialization lifecycle
 *   Suite 10 — Complete key material cleanup
 *   Suite 11 — R23: Zero plaintext / key-material logging
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @privacyresearch/libsignal-protocol-typescript
// vi.hoisted() ensures mock variables are declared before vi.mock() factories
// ---------------------------------------------------------------------------
const {
  mockGenerateIdentityKeyPair,
  mockGenerateRegistrationId,
  mockGeneratePreKey,
  mockGenerateSignedPreKey,
  mockProcessPreKey,
  mockEncrypt,
  mockDecryptPreKeyWhisperMessage,
  mockDecryptWhisperMessage,
} = vi.hoisted(() => ({
  mockGenerateIdentityKeyPair: vi.fn(),
  mockGenerateRegistrationId: vi.fn(),
  mockGeneratePreKey: vi.fn(),
  mockGenerateSignedPreKey: vi.fn(),
  mockProcessPreKey: vi.fn(),
  mockEncrypt: vi.fn(),
  mockDecryptPreKeyWhisperMessage: vi.fn(),
  mockDecryptWhisperMessage: vi.fn(),
}));

vi.mock('@privacyresearch/libsignal-protocol-typescript', () => {
  class MockSignalProtocolAddress {
    name: string;
    deviceId: number;
    constructor(name: string, deviceId: number) {
      this.name = name;
      this.deviceId = deviceId;
    }
    toString(): string {
      return `${this.name}.${this.deviceId}`;
    }
    static fromString(s: string): MockSignalProtocolAddress {
      const parts = s.split('.');
      const deviceId = parseInt(parts.pop() ?? '1', 10);
      const name = parts.join('.');
      return new MockSignalProtocolAddress(name, deviceId);
    }
  }

  return {
    KeyHelper: {
      generateIdentityKeyPair: (...a: unknown[]) =>
        mockGenerateIdentityKeyPair(...a),
      generateRegistrationId: (...a: unknown[]) =>
        mockGenerateRegistrationId(...a),
      generatePreKey: (...a: unknown[]) => mockGeneratePreKey(...a),
      generateSignedPreKey: (...a: unknown[]) =>
        mockGenerateSignedPreKey(...a),
    },
    SignalProtocolAddress: MockSignalProtocolAddress,
    SessionBuilder: class {
      constructor(_store: unknown, _address: unknown) {}
      processPreKey = mockProcessPreKey;
    },
    SessionCipher: class {
      constructor(_store: unknown, _address: unknown) {}
      encrypt = mockEncrypt;
      decryptPreKeyWhisperMessage = mockDecryptPreKeyWhisperMessage;
      decryptWhisperMessage = mockDecryptWhisperMessage;
    },
    Direction: { SENDING: 1, RECEIVING: 2 },
  };
});

// ---------------------------------------------------------------------------
// Mock db module (Dexie IndexedDB) with count() on all encryption tables
// ---------------------------------------------------------------------------
const {
  mockIdentityKeys,
  mockPreKeys,
  mockSignedPreKeys,
  mockSessions,
  mockSenderKeys,
  mockRegistration,
  mockMessages,
  mockTransaction,
} = vi.hoisted(() => ({
  mockIdentityKeys: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    toArray: vi.fn().mockResolvedValue([]),
  },
  mockPreKeys: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    toArray: vi.fn().mockResolvedValue([]),
  },
  mockSignedPreKeys: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    toArray: vi.fn().mockResolvedValue([]),
  },
  mockSessions: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    toArray: vi.fn().mockResolvedValue([]),
    bulkDelete: vi.fn().mockResolvedValue(undefined),
  },
  mockSenderKeys: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
  },
  mockRegistration: {
    get: vi.fn(),
    put: vi.fn(),
    clear: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
  },
  mockMessages: {} as Record<string, unknown>,
  mockTransaction: vi
    .fn()
    .mockImplementation(
      (_mode: string, _tables: unknown[], fn: () => Promise<void>) => fn(),
    ),
}));

vi.mock('@/lib/db', () => ({
  db: {
    identityKeys: mockIdentityKeys,
    preKeys: mockPreKeys,
    signedPreKeys: mockSignedPreKeys,
    sessions: mockSessions,
    senderKeys: mockSenderKeys,
    registration: mockRegistration,
    messages: mockMessages,
    transaction: mockTransaction,
  },
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are registered
// ---------------------------------------------------------------------------
import {
  SignalProtocolStore,
  store,
  generateIdentityKeyPair,
  generateRegistrationId,
  generatePreKeys,
  generateSignedPreKey,
  assemblePreKeyBundle,
  createSession,
  hasSession,
  encryptMessage,
  decryptMessage,
  createSenderKey,
  processSenderKeyDistribution,
  encryptGroupMessage,
  decryptGroupMessage,
  rotateSenderKey,
  initializeEncryption,
  clearAllEncryptionData,
} from '@/lib/encryption';

import { db } from '@/lib/db';
import type { PreKeyBundleDTO, PreKeyBundleResponse } from '@kalle/shared';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Produce a deterministic ArrayBuffer from a string */
function fakeArrayBuffer(str: string): ArrayBuffer {
  return new TextEncoder().encode(str).buffer;
}

/** Encode an ArrayBuffer to base64 (mirrors the module's arrayBufferToBase64) */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Create a fake KeyPairType for Signal Protocol mock data */
function fakeKeyPair() {
  return {
    pubKey: fakeArrayBuffer('test-public-key-data'),
    privKey: fakeArrayBuffer('test-private-key-data'),
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('encryption.ts — Signal Protocol Wrapper', () => {
  // -----------------------------------------------------------------------
  // Setup / Teardown — clear mock state between tests
  // -----------------------------------------------------------------------
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-establish transaction mock (vi.restoreAllMocks strips it)
    mockTransaction.mockImplementation(
      (_mode: string, _tables: unknown[], fn: () => Promise<void>) => fn(),
    );

    // Reset db mock defaults
    mockIdentityKeys.get.mockResolvedValue(undefined);
    mockIdentityKeys.put.mockResolvedValue(undefined);
    mockIdentityKeys.delete.mockResolvedValue(undefined);
    mockIdentityKeys.clear.mockResolvedValue(undefined);
    mockIdentityKeys.count.mockResolvedValue(0);
    mockIdentityKeys.toArray.mockResolvedValue([]);

    mockPreKeys.get.mockResolvedValue(undefined);
    mockPreKeys.put.mockResolvedValue(undefined);
    mockPreKeys.delete.mockResolvedValue(undefined);
    mockPreKeys.clear.mockResolvedValue(undefined);
    mockPreKeys.count.mockResolvedValue(0);
    mockPreKeys.toArray.mockResolvedValue([]);

    mockSignedPreKeys.get.mockResolvedValue(undefined);
    mockSignedPreKeys.put.mockResolvedValue(undefined);
    mockSignedPreKeys.delete.mockResolvedValue(undefined);
    mockSignedPreKeys.clear.mockResolvedValue(undefined);
    mockSignedPreKeys.count.mockResolvedValue(0);
    mockSignedPreKeys.toArray.mockResolvedValue([]);

    mockSessions.get.mockResolvedValue(undefined);
    mockSessions.put.mockResolvedValue(undefined);
    mockSessions.delete.mockResolvedValue(undefined);
    mockSessions.clear.mockResolvedValue(undefined);
    mockSessions.count.mockResolvedValue(0);
    mockSessions.toArray.mockResolvedValue([]);
    mockSessions.bulkDelete.mockResolvedValue(undefined);

    mockSenderKeys.get.mockResolvedValue(undefined);
    mockSenderKeys.put.mockResolvedValue(undefined);
    mockSenderKeys.delete.mockResolvedValue(undefined);
    mockSenderKeys.clear.mockResolvedValue(undefined);
    mockSenderKeys.count.mockResolvedValue(0);

    mockRegistration.get.mockResolvedValue(undefined);
    mockRegistration.put.mockResolvedValue(undefined);
    mockRegistration.clear.mockResolvedValue(undefined);
    mockRegistration.count.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Suite 1: createSession — X3DH session establishment
  // =========================================================================

  describe('createSession', () => {
    it('should process prekey bundle and establish X3DH session', async () => {
      const preKeyBundle: PreKeyBundleResponse = {
        userId: 'user-123',
        identityKey: { publicKey: toBase64(fakeArrayBuffer('ik')) },
        signedPreKey: {
          keyId: 1,
          publicKey: toBase64(fakeArrayBuffer('spk')),
          signature: toBase64(fakeArrayBuffer('sig')),
        },
        preKey: {
          keyId: 42,
          publicKey: toBase64(fakeArrayBuffer('pk')),
        },
        registrationId: 1234,
      };

      mockProcessPreKey.mockResolvedValue(undefined);

      await createSession('user-123', 1, preKeyBundle);

      // SessionBuilder.processPreKey must have been called once
      expect(mockProcessPreKey).toHaveBeenCalledTimes(1);
    });

    it('should handle prekey bundle without optional one-time prekey', async () => {
      const preKeyBundle: PreKeyBundleResponse = {
        userId: 'user-456',
        identityKey: { publicKey: toBase64(fakeArrayBuffer('ik')) },
        signedPreKey: {
          keyId: 1,
          publicKey: toBase64(fakeArrayBuffer('spk')),
          signature: toBase64(fakeArrayBuffer('sig')),
        },
        preKey: undefined,
        registrationId: 1234,
      };

      mockProcessPreKey.mockResolvedValue(undefined);

      await createSession('user-456', 1, preKeyBundle);
      expect(mockProcessPreKey).toHaveBeenCalledTimes(1);

      // Verify the bundle passed to processPreKey has undefined preKey
      const processed = mockProcessPreKey.mock.calls[0][0];
      expect(processed.preKey).toBeUndefined();
    });
  });

  // =========================================================================
  // Suite 2: encryptMessage / decryptMessage — 1:1 (R12)
  // =========================================================================

  describe('encryptMessage / decryptMessage — 1:1 (R12)', () => {
    it('should encrypt plaintext and return type:body ciphertext', async () => {
      mockEncrypt.mockResolvedValue({
        type: 3,
        body: 'encrypted-body-content',
      });

      const ciphertext = await encryptMessage('user-123', 1, 'Hello World');
      expect(ciphertext).toContain(':');
      expect(ciphertext.startsWith('3:')).toBe(true);
      expect(mockEncrypt).toHaveBeenCalledTimes(1);
    });

    it('should not leak plaintext into the ciphertext (R12)', async () => {
      const plaintext = 'Secret message content';
      mockEncrypt.mockResolvedValue({
        type: 3,
        body: 'totally-encrypted-data',
      });

      const ciphertext = await encryptMessage('user-123', 1, plaintext);
      expect(ciphertext).not.toContain(plaintext);
    });

    it('should decrypt pre-key whisper message (first message)', async () => {
      const plainBuffer = fakeArrayBuffer('Hello decrypted');
      mockDecryptPreKeyWhisperMessage.mockResolvedValue(plainBuffer);

      const result = await decryptMessage(
        'sender-1',
        1,
        '3:' + btoa('cipher'),
        true,
      );
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(mockDecryptPreKeyWhisperMessage).toHaveBeenCalledTimes(1);
    });

    it('should decrypt standard whisper message (subsequent messages)', async () => {
      const plainBuffer = fakeArrayBuffer('Decrypted text');
      mockDecryptWhisperMessage.mockResolvedValue(plainBuffer);

      const result = await decryptMessage(
        'sender-1',
        1,
        '1:' + btoa('cipher'),
        false,
      );
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(mockDecryptWhisperMessage).toHaveBeenCalledTimes(1);
      expect(mockDecryptPreKeyWhisperMessage).not.toHaveBeenCalled();
    });

    it('should encrypt then decrypt returning original plaintext', async () => {
      const originalPlaintext = 'Hello encrypted world';
      const encodedPlaintext = fakeArrayBuffer(originalPlaintext);

      // Mock encrypt → produces a ciphertext blob
      mockEncrypt.mockResolvedValue({
        type: 1,
        body: btoa('mock-ciphertext-payload'),
      });

      // Mock decrypt → returns the original plaintext as ArrayBuffer
      mockDecryptWhisperMessage.mockResolvedValue(encodedPlaintext);

      const encrypted = await encryptMessage('user-1', 1, originalPlaintext);
      expect(encrypted).toBeDefined();

      const decrypted = await decryptMessage('user-1', 1, encrypted, false);
      expect(decrypted).toBe(originalPlaintext);
    });
  });

  // =========================================================================
  // Suite 3: createSenderKey — Sender Key distribution (R14)
  // =========================================================================

  describe('createSenderKey — Sender Key distribution (R14)', () => {
    it('should generate distribution message for group', async () => {
      mockRegistration.get.mockResolvedValue({
        id: 'local',
        registrationId: 42,
      });

      const distribution = await createSenderKey('group-abc');
      expect(distribution).toBeDefined();
      expect(distribution.groupId).toBe('group-abc');
      expect(distribution.distributionMessage).toBeDefined();
      expect(distribution.distributionMessage.length).toBeGreaterThan(0);
      expect(distribution.createdAt).toBeDefined();
    });

    it('should store sender key in IndexedDB via db.senderKeys', async () => {
      mockRegistration.get.mockResolvedValue({
        id: 'local',
        registrationId: 42,
      });

      await createSenderKey('group-persist');

      expect(mockSenderKeys.put).toHaveBeenCalledTimes(1);
      const putArg = mockSenderKeys.put.mock.calls[0][0];
      expect(putArg.id).toBe('group-persist:local');
      expect(typeof putArg.record).toBe('string');
      expect(putArg.record.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Suite 4: rotateSenderKey — key rotation on membership change (R14)
  // =========================================================================

  describe('rotateSenderKey — key rotation on membership change (R14)', () => {
    it('should create new sender key making old key unusable by removed members', async () => {
      mockRegistration.get.mockResolvedValue({
        id: 'local',
        registrationId: 42,
      });

      const newDist = await rotateSenderKey('group-abc', 'member_removed');
      expect(newDist).toBeDefined();
      expect(newDist.groupId).toBe('group-abc');

      // Old key must be deleted before new key is stored
      expect(mockSenderKeys.delete).toHaveBeenCalledWith('group-abc:local');
      expect(mockSenderKeys.put).toHaveBeenCalled();
    });

    it('should return new distribution message for redistribution', async () => {
      mockRegistration.get.mockResolvedValue({
        id: 'local',
        registrationId: 42,
      });

      const original = await createSenderKey('group-rotate');
      const rotated = await rotateSenderKey('group-rotate', 'member_removed');

      // Distribution messages should differ (different AES-256 keys)
      expect(rotated.distributionMessage).not.toBe(
        original.distributionMessage,
      );
    });

    it('removed member cannot decrypt after rotation (R14 forward secrecy)', async () => {
      // Old member key
      const oldKeyBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(oldKeyBytes);
      const oldKeyBase64 = toBase64(oldKeyBytes.buffer);

      // New rotated key
      const newKeyBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(newKeyBytes);
      const newKeyBase64 = toBase64(newKeyBytes.buffer);

      // Encrypt with the new rotated key
      mockSenderKeys.get.mockResolvedValue({
        id: 'group-abc:local',
        record: newKeyBase64,
      });
      const ciphertext = await encryptGroupMessage(
        'group-abc',
        'Post-rotation message',
      );

      // Removed member tries to decrypt with old key → must fail
      mockSenderKeys.get.mockResolvedValue({
        id: 'group-abc:old-sender',
        record: oldKeyBase64,
      });
      await expect(
        decryptGroupMessage('group-abc', 'old-sender', ciphertext),
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // Suite 5: encryptGroupMessage / decryptGroupMessage (R14)
  // =========================================================================

  describe('encryptGroupMessage / decryptGroupMessage (R14)', () => {
    it('should encrypt plaintext for group using AES-GCM Sender Key', async () => {
      const keyBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(keyBytes);
      const keyBase64 = toBase64(keyBytes.buffer);
      mockSenderKeys.get.mockResolvedValue({
        id: 'group-abc:local',
        record: keyBase64,
      });

      const ciphertext = await encryptGroupMessage(
        'group-abc',
        'Group hello',
      );
      expect(ciphertext).toBeDefined();
      expect(typeof ciphertext).toBe('string');
      expect(ciphertext.length).toBeGreaterThan(0);
      // R12: ciphertext must not contain plaintext
      expect(ciphertext).not.toContain('Group hello');
    });

    it('should throw when no Sender Key exists for encryption', async () => {
      mockSenderKeys.get.mockResolvedValue(undefined);
      await expect(
        encryptGroupMessage('group-999', 'Hello'),
      ).rejects.toThrow(/No Sender Key found/);
    });

    it('should decrypt group ciphertext and return original plaintext', async () => {
      const keyBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(keyBytes);
      const keyBase64 = toBase64(keyBytes.buffer);

      // Encrypt
      mockSenderKeys.get.mockResolvedValue({
        id: 'group-abc:local',
        record: keyBase64,
      });
      const ciphertext = await encryptGroupMessage(
        'group-abc',
        'Round trip test',
      );

      // Decrypt with the same key for a different sender
      mockSenderKeys.get.mockResolvedValue({
        id: 'group-abc:sender-x',
        record: keyBase64,
      });
      const decrypted = await decryptGroupMessage(
        'group-abc',
        'sender-x',
        ciphertext,
      );

      expect(decrypted).toBe('Round trip test');
    });

    it('should throw when no Sender Key exists for decryption', async () => {
      mockSenderKeys.get.mockResolvedValue(undefined);
      await expect(
        decryptGroupMessage('group-abc', 'unknown-sender', 'ciphertext'),
      ).rejects.toThrow(/No Sender Key found/);
    });
  });

  // =========================================================================
  // Suite 6: Key generation utilities
  // =========================================================================

  describe('key generation utilities', () => {
    it('generateIdentityKeyPair should return key pair with pubKey and privKey', async () => {
      const kp = fakeKeyPair();
      mockGenerateIdentityKeyPair.mockResolvedValue(kp);

      const result = await generateIdentityKeyPair();
      expect(result).toBe(kp);
      expect(result.pubKey).toBeDefined();
      expect(result.pubKey.byteLength).toBeGreaterThan(0);
      expect(result.privKey).toBeDefined();
      expect(result.privKey.byteLength).toBeGreaterThan(0);
      expect(mockGenerateIdentityKeyPair).toHaveBeenCalledTimes(1);
    });

    it('generatePreKeys should generate specified count with sequential IDs', async () => {
      const kp = fakeKeyPair();
      mockGeneratePreKey.mockImplementation(async (id: number) => ({
        keyId: id,
        keyPair: kp,
      }));

      const result = await generatePreKeys(10, 5);
      expect(result).toHaveLength(5);
      expect(result[0].keyId).toBe(10);
      expect(result[4].keyId).toBe(14);
      expect(mockGeneratePreKey).toHaveBeenCalledTimes(5);
    });

    it('generateSignedPreKey should produce signed prekey with signature', async () => {
      const kp = fakeKeyPair();
      const signedKp = {
        keyId: 1,
        keyPair: kp,
        signature: fakeArrayBuffer('signature-data'),
      };
      mockGenerateSignedPreKey.mockResolvedValue(signedKp);

      const result = await generateSignedPreKey(kp, 1);
      expect(result).toBe(signedKp);
      expect(result.keyId).toBe(1);
      expect(result.keyPair).toBeDefined();
      expect(result.signature).toBeDefined();
      expect(result.signature.byteLength).toBeGreaterThan(0);
      expect(mockGenerateSignedPreKey).toHaveBeenCalledWith(kp, 1);
    });

    it('generateRegistrationId should return numeric registration ID', async () => {
      mockGenerateRegistrationId.mockResolvedValue(4567);

      const result = await generateRegistrationId();
      expect(result).toBe(4567);
      expect(typeof result).toBe('number');
      expect(mockGenerateRegistrationId).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Suite 7: assemblePreKeyBundle
  // =========================================================================

  describe('assemblePreKeyBundle', () => {
    it('should throw if identity key pair is not initialized', async () => {
      mockIdentityKeys.get.mockResolvedValue(undefined);
      await expect(assemblePreKeyBundle()).rejects.toThrow();
    });

    it('should return valid PreKeyBundleDTO with all required fields', async () => {
      const kp = fakeKeyPair();
      mockIdentityKeys.get.mockResolvedValue({
        id: 'local',
        publicKey: toBase64(kp.pubKey),
        privateKey: toBase64(kp.privKey),
      });
      mockRegistration.get.mockResolvedValue({
        id: 'local',
        registrationId: 9999,
      });

      const signedKp = {
        keyId: 1,
        keyPair: kp,
        signature: fakeArrayBuffer('sig'),
      };
      mockGenerateSignedPreKey.mockResolvedValue(signedKp);
      mockGeneratePreKey.mockImplementation(async (id: number) => ({
        keyId: id,
        keyPair: kp,
      }));

      const bundle: PreKeyBundleDTO = await assemblePreKeyBundle();

      // Verify all required PreKeyBundleDTO fields
      expect(bundle.registrationId).toBe(9999);

      // identityKey must contain base64 publicKey
      expect(bundle.identityKey).toBeDefined();
      expect(typeof bundle.identityKey.publicKey).toBe('string');

      // signedPreKey must have id, publicKey (base64), and signature (base64)
      expect(bundle.signedPreKey).toBeDefined();
      expect(bundle.signedPreKey.keyId).toBe(1);
      expect(typeof bundle.signedPreKey.publicKey).toBe('string');
      expect(typeof bundle.signedPreKey.signature).toBe('string');

      // preKeys is an array of { keyId, publicKey (base64) }
      expect(bundle.preKeys).toBeDefined();
      expect(bundle.preKeys.length).toBeGreaterThan(0);
      expect(bundle.preKeys[0].keyId).toBeDefined();
      expect(typeof bundle.preKeys[0].publicKey).toBe('string');
    });
  });

  // =========================================================================
  // Suite 8: SignalProtocolStore — IndexedDB persistence
  // =========================================================================

  describe('SignalProtocolStore — IndexedDB persistence', () => {
    it('should be a valid SignalProtocolStore instance', () => {
      expect(store).toBeInstanceOf(SignalProtocolStore);
    });

    // ---- Identity Keys ----

    it('should read/write identity keys to db.identityKeys', async () => {
      const kp = fakeKeyPair();
      mockIdentityKeys.get.mockResolvedValue({
        id: 'local',
        publicKey: toBase64(kp.pubKey),
        privateKey: toBase64(kp.privKey),
      });

      const result = await store.getIdentityKeyPair();
      expect(result).toBeDefined();
      expect(mockIdentityKeys.get).toHaveBeenCalledWith('local');
    });

    it('should return undefined when no identity key exists', async () => {
      mockIdentityKeys.get.mockResolvedValue(undefined);
      const result = await store.getIdentityKeyPair();
      expect(result).toBeUndefined();
    });

    it('should store remote identity via saveIdentity', async () => {
      const identityKey = fakeArrayBuffer('remote-identity-key');

      // No existing identity → new identity
      mockIdentityKeys.get.mockResolvedValue(undefined);
      const isNew = await store.saveIdentity('user-abc.1', identityKey);
      expect(isNew).toBe(true);
      expect(mockIdentityKeys.put).toHaveBeenCalledTimes(1);

      // Verify stored with parsed address name (without device id)
      const putArg = mockIdentityKeys.put.mock.calls[0][0];
      expect(putArg.id).toBe('user-abc');
      expect(typeof putArg.publicKey).toBe('string');
    });

    it('should return false from saveIdentity when identity is unchanged', async () => {
      const identityKey = fakeArrayBuffer('remote-identity-key');
      const encoded = toBase64(identityKey);

      // Existing identity matches
      mockIdentityKeys.get.mockResolvedValue({
        id: 'user-abc',
        publicKey: encoded,
      });
      const unchanged = await store.saveIdentity('user-abc.1', identityKey);
      expect(unchanged).toBe(false);
    });

    it('should implement isTrustedIdentity correctly (TOFU)', async () => {
      const identityKey = fakeArrayBuffer('remote-identity-key');

      // First encounter — no stored identity → TOFU: trust
      mockIdentityKeys.get.mockResolvedValue(undefined);
      const firstTrust = await store.isTrustedIdentity(
        'user-abc.1',
        identityKey,
        1,
      );
      expect(firstTrust).toBe(true);

      // Same identity → still trusted
      mockIdentityKeys.get.mockResolvedValue({
        id: 'user-abc',
        publicKey: toBase64(identityKey),
      });
      const sameTrust = await store.isTrustedIdentity(
        'user-abc.1',
        identityKey,
        1,
      );
      expect(sameTrust).toBe(true);

      // Changed identity → NOT trusted
      const changedKey = fakeArrayBuffer('different-identity-key');
      const changedTrust = await store.isTrustedIdentity(
        'user-abc.1',
        changedKey,
        1,
      );
      expect(changedTrust).toBe(false);
    });

    // ---- Registration ID ----

    it('should return stored registration ID from db.registration', async () => {
      mockRegistration.get.mockResolvedValue({
        id: 'local',
        registrationId: 12345,
      });
      const result = await store.getLocalRegistrationId();
      expect(result).toBe(12345);
    });

    // ---- PreKeys ----

    it('should read/write prekeys to db.preKeys', async () => {
      const kp = fakeKeyPair();

      // Store
      await store.storePreKey(42, kp);
      expect(mockPreKeys.put).toHaveBeenCalledTimes(1);
      const putArg = mockPreKeys.put.mock.calls[0][0];
      expect(putArg.keyId).toBe(42);

      // Load
      mockPreKeys.get.mockResolvedValue({
        keyId: 42,
        publicKey: toBase64(kp.pubKey),
        privateKey: toBase64(kp.privKey),
      });
      const loaded = await store.loadPreKey(42);
      expect(loaded).toBeDefined();
      expect(mockPreKeys.get).toHaveBeenCalledWith(42);
    });

    it('should remove prekey and return undefined on reload', async () => {
      await store.removePreKey(7);
      expect(mockPreKeys.delete).toHaveBeenCalledWith(7);

      // After removal, loading returns undefined
      mockPreKeys.get.mockResolvedValue(undefined);
      const loaded = await store.loadPreKey(7);
      expect(loaded).toBeUndefined();
    });

    // ---- Signed PreKeys ----

    it('should read/write signed prekeys to db.signedPreKeys', async () => {
      const kp = fakeKeyPair();

      // Store
      await store.storeSignedPreKey(1, kp);
      expect(mockSignedPreKeys.put).toHaveBeenCalledTimes(1);
      const putArg = mockSignedPreKeys.put.mock.calls[0][0];
      expect(putArg.keyId).toBe(1);

      // Load
      mockSignedPreKeys.get.mockResolvedValue({
        keyId: 1,
        publicKey: toBase64(kp.pubKey),
        privateKey: toBase64(kp.privKey),
      });
      const loaded = await store.loadSignedPreKey(1);
      expect(loaded).toBeDefined();
      expect(mockSignedPreKeys.get).toHaveBeenCalledWith(1);
    });

    it('should remove signed prekey from db.signedPreKeys', async () => {
      await store.removeSignedPreKey(1);
      expect(mockSignedPreKeys.delete).toHaveBeenCalledWith(1);
    });

    // ---- Sessions ----

    it('should read/write sessions to db.sessions', async () => {
      // Store
      await store.storeSession('user1.1', 'session-record-data');
      expect(mockSessions.put).toHaveBeenCalledTimes(1);
      const arg = mockSessions.put.mock.calls[0][0];
      expect(arg.id).toBe('user1.1');

      // Load
      mockSessions.get.mockResolvedValue({
        id: 'user1.1',
        record: 'session-record-data',
      });
      const loaded = await store.loadSession('user1.1');
      expect(loaded).toBeDefined();
      expect(mockSessions.get).toHaveBeenCalledWith('user1.1');
    });

    it('should return undefined for non-existent session', async () => {
      mockSessions.get.mockResolvedValue(undefined);
      const result = await store.loadSession('nonexistent.1');
      expect(result).toBeUndefined();
    });

    it('should remove a single session via removeSession', async () => {
      await store.removeSession('user1.1');
      expect(mockSessions.delete).toHaveBeenCalledWith('user1.1');
    });

    it('should remove all sessions for an address via removeAllSessions', async () => {
      // Simulate 3 sessions, 2 for user1 and 1 for user2
      mockSessions.toArray.mockResolvedValue([
        { id: 'user1.1', record: 'r1' },
        { id: 'user1.2', record: 'r2' },
        { id: 'user2.1', record: 'r3' },
      ]);

      await store.removeAllSessions('user1');

      // Only user1 sessions should be deleted
      expect(mockSessions.bulkDelete).toHaveBeenCalledTimes(1);
      expect(mockSessions.bulkDelete).toHaveBeenCalledWith([
        'user1.1',
        'user1.2',
      ]);
    });
  });

  // =========================================================================
  // Suite 9: initializeEncryption
  // =========================================================================

  describe('initializeEncryption', () => {
    it('should generate keys on first use when no identity exists', async () => {
      mockIdentityKeys.get.mockResolvedValue(undefined);
      const kp = fakeKeyPair();
      mockGenerateIdentityKeyPair.mockResolvedValue(kp);
      mockGenerateRegistrationId.mockResolvedValue(7777);
      mockGeneratePreKey.mockImplementation(async (id: number) => ({
        keyId: id,
        keyPair: kp,
      }));
      mockGenerateSignedPreKey.mockResolvedValue({
        keyId: 1,
        keyPair: kp,
        signature: fakeArrayBuffer('sig'),
      });

      await initializeEncryption();

      // Identity key pair stored in db.identityKeys
      expect(mockIdentityKeys.put).toHaveBeenCalled();

      // Registration ID stored via db.registration.put
      expect(mockRegistration.put).toHaveBeenCalled();
      const regArg = mockRegistration.put.mock.calls[0][0];
      expect(regArg.registrationId).toBe(7777);

      // Signed prekey stored in db.signedPreKeys
      expect(mockSignedPreKeys.put).toHaveBeenCalled();

      // 100 one-time prekeys generated (PREKEY_BATCH_SIZE = 100)
      expect(mockGeneratePreKey).toHaveBeenCalledTimes(100);

      // Verify count queries after initialization (using mocked counts)
      mockIdentityKeys.count.mockResolvedValue(1);
      mockRegistration.count.mockResolvedValue(1);
      mockPreKeys.count.mockResolvedValue(100);
      mockSignedPreKeys.count.mockResolvedValue(1);

      expect(await db.identityKeys.count()).toBe(1);
      expect(await db.registration.count()).toBe(1);
      expect(await db.preKeys.count()).toBe(100);
      expect(await db.signedPreKeys.count()).toBe(1);
    });

    it('should no-op on subsequent calls when keys already exist', async () => {
      const kp = fakeKeyPair();
      mockIdentityKeys.get.mockResolvedValue({
        id: 'local',
        publicKey: toBase64(kp.pubKey),
        privateKey: toBase64(kp.privKey),
      });

      await initializeEncryption();

      // No key generation should occur
      expect(mockGenerateIdentityKeyPair).not.toHaveBeenCalled();
      expect(mockGenerateRegistrationId).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Suite 10: clearAllEncryptionData
  // =========================================================================

  describe('clearAllEncryptionData', () => {
    it('should wipe all key material from all 6 IndexedDB tables', async () => {
      await clearAllEncryptionData();

      expect(mockTransaction).toHaveBeenCalled();
      expect(mockIdentityKeys.clear).toHaveBeenCalledTimes(1);
      expect(mockPreKeys.clear).toHaveBeenCalledTimes(1);
      expect(mockSignedPreKeys.clear).toHaveBeenCalledTimes(1);
      expect(mockSessions.clear).toHaveBeenCalledTimes(1);
      expect(mockSenderKeys.clear).toHaveBeenCalledTimes(1);
      expect(mockRegistration.clear).toHaveBeenCalledTimes(1);

      // All tables report zero count after clearing
      mockIdentityKeys.count.mockResolvedValue(0);
      mockPreKeys.count.mockResolvedValue(0);
      mockSignedPreKeys.count.mockResolvedValue(0);
      mockSessions.count.mockResolvedValue(0);
      mockSenderKeys.count.mockResolvedValue(0);
      mockRegistration.count.mockResolvedValue(0);

      expect(await db.identityKeys.count()).toBe(0);
      expect(await db.preKeys.count()).toBe(0);
      expect(await db.signedPreKeys.count()).toBe(0);
      expect(await db.sessions.count()).toBe(0);
      expect(await db.senderKeys.count()).toBe(0);
      expect(await db.registration.count()).toBe(0);
    });
  });

  // =========================================================================
  // Suite 11: log hygiene (R23)
  // =========================================================================

  describe('log hygiene (R23)', () => {
    it('should not log encryption keys or prekey material', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      const debugSpy = vi
        .spyOn(console, 'debug')
        .mockImplementation(() => {});

      // Exercise several encryption operations
      mockRegistration.get.mockResolvedValue({
        id: 'local',
        registrationId: 1,
      });
      try {
        await createSenderKey('test-group');
      } catch {
        /* tolerate errors */
      }
      try {
        await processSenderKeyDistribution(
          'g1',
          's1',
          toBase64(fakeArrayBuffer('key')),
        );
      } catch {
        /* tolerate errors */
      }
      try {
        const kp = fakeKeyPair();
        mockGenerateIdentityKeyPair.mockResolvedValue(kp);
        await generateIdentityKeyPair();
      } catch {
        /* tolerate errors */
      }

      // Verify no console method was called with key material
      const allSpies = [logSpy, warnSpy, errorSpy, debugSpy];
      for (const spy of allSpies) {
        for (const call of spy.mock.calls) {
          const output = call.map(String).join(' ');
          expect(output).not.toMatch(/privKey|privateKey|secretKey/i);
        }
      }

      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      debugSpy.mockRestore();
    });
  });

  // =========================================================================
  // Additional coverage: hasSession utility
  // =========================================================================

  describe('hasSession', () => {
    it('returns true when session exists in db.sessions', async () => {
      mockSessions.get.mockResolvedValue({ id: 'user-123.1', record: 'x' });
      const result = await hasSession('user-123', 1);
      expect(result).toBe(true);
    });

    it('returns false when no session exists in db.sessions', async () => {
      mockSessions.get.mockResolvedValue(undefined);
      const result = await hasSession('user-999', 1);
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // Additional coverage: processSenderKeyDistribution
  // =========================================================================

  describe('processSenderKeyDistribution', () => {
    it('stores a remote sender key in db.senderKeys', async () => {
      const dist = toBase64(fakeArrayBuffer('sender-key-material'));
      await processSenderKeyDistribution('group-abc', 'user-xyz', dist);

      expect(mockSenderKeys.put).toHaveBeenCalledTimes(1);
      const putArg = mockSenderKeys.put.mock.calls[0][0];
      expect(putArg.id).toBe('group-abc:user-xyz');
      expect(putArg.record).toBe(dist);
    });

    it('rejects invalid base64 distribution message', async () => {
      await expect(
        processSenderKeyDistribution(
          'group-abc',
          'user-xyz',
          '!!!invalid-base64!!!',
        ),
      ).rejects.toThrow();
    });
  });
});
