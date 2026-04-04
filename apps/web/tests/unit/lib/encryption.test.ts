/**
 * @file encryption.test.ts
 * Unit tests for the Signal Protocol encryption wrapper (apps/web/src/lib/encryption.ts).
 *
 * Covers:
 * - SignalProtocolStore IndexedDB operations
 * - Key generation helpers (identity, registration, prekeys, signed prekeys)
 * - PreKey bundle assembly
 * - 1:1 session creation, encrypt/decrypt (R12)
 * - Group Sender Key create/process/encrypt/decrypt (R14)
 * - Sender Key rotation on member removal (R14)
 * - Initialization and cleanup lifecycle
 * - R23: Zero plaintext logging — no key material in console
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the @privacyresearch/libsignal-protocol-typescript library
// vi.hoisted() ensures variables are declared before vi.mock() factories execute
// (vi.mock factories are hoisted above const declarations by Vitest)
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
  mockLoadSession: vi.fn(),
}));

vi.mock('@privacyresearch/libsignal-protocol-typescript', () => ({
  KeyHelper: {
    generateIdentityKeyPair: (...args: unknown[]) => mockGenerateIdentityKeyPair(...args),
    generateRegistrationId: (...args: unknown[]) => mockGenerateRegistrationId(...args),
    generatePreKey: (...args: unknown[]) => mockGeneratePreKey(...args),
    generateSignedPreKey: (...args: unknown[]) => mockGenerateSignedPreKey(...args),
  },
  SignalProtocolAddress: class {
    name: string;
    deviceId: number;
    constructor(name: string, deviceId: number) {
      this.name = name;
      this.deviceId = deviceId;
    }
    toString() {
      return `${this.name}.${this.deviceId}`;
    }
  },
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
  Direction: {
    SENDING: 1,
    RECEIVING: 2,
  },
}));

// ---------------------------------------------------------------------------
// Mock db module (Dexie IndexedDB)
// vi.hoisted() ensures variables are declared before vi.mock() factories execute
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
    toArray: vi.fn().mockResolvedValue([]),
  },
  mockPreKeys: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    toArray: vi.fn().mockResolvedValue([]),
  },
  mockSignedPreKeys: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    toArray: vi.fn().mockResolvedValue([]),
  },
  mockSessions: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  },
  mockSenderKeys: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  },
  mockRegistration: {
    get: vi.fn(),
    put: vi.fn(),
    clear: vi.fn(),
  },
  mockMessages: {} as Record<string, unknown>,
  mockTransaction: vi.fn().mockImplementation((_mode: string, _tables: unknown[], fn: () => Promise<void>) => fn()),
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
// Import the module under test AFTER mocks are set up
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake ArrayBuffer from a string for testing */
function fakeArrayBuffer(str: string): ArrayBuffer {
  const encoder = new TextEncoder();
  return encoder.encode(str).buffer;
}

/** Encode an ArrayBuffer to base64 (mirrors the module's helper) */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Create a fake KeyPairType */
function fakeKeyPair() {
  return {
    pubKey: fakeArrayBuffer('public-key-data'),
    privKey: fakeArrayBuffer('private-key-data'),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('encryption.ts — Signal Protocol Wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish transaction mock implementation (vi.restoreAllMocks strips it)
    mockTransaction.mockImplementation(
      (_mode: string, _tables: unknown[], fn: () => Promise<void>) => fn()
    );
    // Reset all db mocks to default resolved values
    // (vi.restoreAllMocks in afterEach strips all mockResolvedValue/mockImplementation)
    mockIdentityKeys.get.mockResolvedValue(undefined);
    mockIdentityKeys.put.mockResolvedValue(undefined);
    mockIdentityKeys.delete.mockResolvedValue(undefined);
    mockIdentityKeys.clear.mockResolvedValue(undefined);
    mockIdentityKeys.toArray.mockResolvedValue([]);
    mockPreKeys.get.mockResolvedValue(undefined);
    mockPreKeys.put.mockResolvedValue(undefined);
    mockPreKeys.delete.mockResolvedValue(undefined);
    mockPreKeys.clear.mockResolvedValue(undefined);
    mockPreKeys.toArray.mockResolvedValue([]);
    mockSignedPreKeys.get.mockResolvedValue(undefined);
    mockSignedPreKeys.put.mockResolvedValue(undefined);
    mockSignedPreKeys.delete.mockResolvedValue(undefined);
    mockSignedPreKeys.clear.mockResolvedValue(undefined);
    mockSignedPreKeys.toArray.mockResolvedValue([]);
    mockSessions.get.mockResolvedValue(undefined);
    mockSessions.put.mockResolvedValue(undefined);
    mockSessions.delete.mockResolvedValue(undefined);
    mockSessions.clear.mockResolvedValue(undefined);
    mockSenderKeys.get.mockResolvedValue(undefined);
    mockSenderKeys.put.mockResolvedValue(undefined);
    mockSenderKeys.delete.mockResolvedValue(undefined);
    mockSenderKeys.clear.mockResolvedValue(undefined);
    mockRegistration.get.mockResolvedValue(undefined);
    mockRegistration.put.mockResolvedValue(undefined);
    mockRegistration.clear.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // SignalProtocolStore
  // =========================================================================

  describe('SignalProtocolStore', () => {
    it('should be an instance of SignalProtocolStore with IndexedDB backing', () => {
      expect(store).toBeInstanceOf(SignalProtocolStore);
    });

    it('getIdentityKeyPair returns parsed key pair from IndexedDB', async () => {
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

    it('getIdentityKeyPair returns undefined when no identity exists', async () => {
      mockIdentityKeys.get.mockResolvedValue(undefined);
      const result = await store.getIdentityKeyPair();
      expect(result).toBeUndefined();
    });

    it('getLocalRegistrationId returns the stored registration ID', async () => {
      mockRegistration.get.mockResolvedValue({ id: 'local', registrationId: 12345 });
      const result = await store.getLocalRegistrationId();
      expect(result).toBe(12345);
    });

    it('storePreKey saves a prekey pair to IndexedDB', async () => {
      const kp = fakeKeyPair();
      await store.storePreKey(42, kp);
      expect(mockPreKeys.put).toHaveBeenCalledTimes(1);
      const arg = mockPreKeys.put.mock.calls[0][0];
      expect(arg.keyId).toBe(42);
    });

    it('loadPreKey retrieves a prekey from IndexedDB', async () => {
      mockPreKeys.get.mockResolvedValue({
        keyId: 7,
        publicKey: toBase64(fakeArrayBuffer('pub')),
        privateKey: toBase64(fakeArrayBuffer('priv')),
      });

      const result = await store.loadPreKey(7);
      expect(result).toBeDefined();
      expect(mockPreKeys.get).toHaveBeenCalledWith(7);
    });

    it('removePreKey deletes a consumed prekey from IndexedDB', async () => {
      await store.removePreKey(7);
      expect(mockPreKeys.delete).toHaveBeenCalledWith(7);
    });

    it('loadSession returns undefined for non-existent session', async () => {
      mockSessions.get.mockResolvedValue(undefined);
      const result = await store.loadSession('user1.1');
      expect(result).toBeUndefined();
    });

    it('storeSession saves a session record to IndexedDB', async () => {
      await store.storeSession('user1.1', 'session-record-data');
      expect(mockSessions.put).toHaveBeenCalledTimes(1);
      const arg = mockSessions.put.mock.calls[0][0];
      expect(arg.id).toBe('user1.1');
    });
  });

  // =========================================================================
  // Key Generation (Phase 3)
  // =========================================================================

  describe('Key Generation', () => {
    it('generateIdentityKeyPair delegates to KeyHelper', async () => {
      const kp = fakeKeyPair();
      mockGenerateIdentityKeyPair.mockResolvedValue(kp);

      const result = await generateIdentityKeyPair();
      expect(result).toBe(kp);
      expect(mockGenerateIdentityKeyPair).toHaveBeenCalledTimes(1);
    });

    it('generateRegistrationId delegates to KeyHelper', async () => {
      mockGenerateRegistrationId.mockResolvedValue(4567);

      const result = await generateRegistrationId();
      expect(result).toBe(4567);
      expect(mockGenerateRegistrationId).toHaveBeenCalledTimes(1);
    });

    it('generatePreKeys generates a batch of sequential prekeys', async () => {
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

    it('generateSignedPreKey delegates to KeyHelper with identity key', async () => {
      const kp = fakeKeyPair();
      const signedKp = {
        keyId: 1,
        keyPair: kp,
        signature: fakeArrayBuffer('signature-data'),
      };
      mockGenerateSignedPreKey.mockResolvedValue(signedKp);

      const result = await generateSignedPreKey(kp, 1);
      expect(result).toBe(signedKp);
      expect(mockGenerateSignedPreKey).toHaveBeenCalledWith(kp, 1);
    });
  });

  // =========================================================================
  // PreKey Bundle Assembly (Phase 4)
  // =========================================================================

  describe('assemblePreKeyBundle', () => {
    it('throws if identity key pair is not initialized', async () => {
      mockIdentityKeys.get.mockResolvedValue(undefined);
      await expect(assemblePreKeyBundle()).rejects.toThrow();
    });

    it('assembles a valid bundle with public key material', async () => {
      // Setup: identity key pair exists
      const kp = fakeKeyPair();
      mockIdentityKeys.get.mockResolvedValue({
        id: 'local',
        publicKey: toBase64(kp.pubKey),
        privateKey: toBase64(kp.privKey),
      });
      mockRegistration.get.mockResolvedValue({ id: 'local', registrationId: 9999 });

      // Mock key generation
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

      const bundle = await assemblePreKeyBundle();
      expect(bundle).toBeDefined();
      expect(bundle.registrationId).toBe(9999);
      expect(bundle.identityKey).toBeDefined();
      expect(bundle.signedPreKey).toBeDefined();
      expect(bundle.preKeys).toBeDefined();
      expect(bundle.preKeys.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 1:1 Session Management (Phase 5)
  // =========================================================================

  describe('Session Management — 1:1', () => {
    it('createSession processes a prekey bundle via SessionBuilder', async () => {
      const preKeyBundle = {
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

      await createSession('user-123', 1, preKeyBundle as any);
      expect(mockProcessPreKey).toHaveBeenCalledTimes(1);
    });

    it('createSession handles missing optional preKey', async () => {
      const preKeyBundle = {
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

      await createSession('user-456', 1, preKeyBundle as any);
      expect(mockProcessPreKey).toHaveBeenCalledTimes(1);
      // Verify device passed to processPreKey has undefined preKey
      const processedDevice = mockProcessPreKey.mock.calls[0][0];
      expect(processedDevice.preKey).toBeUndefined();
    });

    it('hasSession returns true when session exists', async () => {
      mockSessions.get.mockResolvedValue({ id: 'user-123.1', record: 'data' });

      const result = await hasSession('user-123', 1);
      expect(result).toBe(true);
    });

    it('hasSession returns false when no session exists', async () => {
      mockSessions.get.mockResolvedValue(undefined);

      const result = await hasSession('user-999', 1);
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // 1:1 Message Encryption / Decryption (Phase 6 — R12)
  // =========================================================================

  describe('Message Encryption / Decryption — 1:1 (R12)', () => {
    it('encryptMessage returns type:base64 formatted ciphertext', async () => {
      mockEncrypt.mockResolvedValue({
        type: 3,
        body: 'encrypted-body-content',
      });

      const ciphertext = await encryptMessage('user-123', 1, 'Hello World');
      expect(ciphertext).toContain(':');
      expect(ciphertext.startsWith('3:')).toBe(true);
      expect(mockEncrypt).toHaveBeenCalledTimes(1);
    });

    it('encryptMessage does not leak plaintext into the ciphertext (R12)', async () => {
      const plaintext = 'Secret message content';
      mockEncrypt.mockResolvedValue({
        type: 3,
        body: 'totally-encrypted-data',
      });

      const ciphertext = await encryptMessage('user-123', 1, plaintext);
      expect(ciphertext).not.toContain(plaintext);
    });

    it('decryptMessage handles PreKeyWhisperMessage (first message)', async () => {
      const plainBuffer = fakeArrayBuffer('Hello decrypted');
      mockDecryptPreKeyWhisperMessage.mockResolvedValue(plainBuffer);

      const result = await decryptMessage('sender-1', 1, '3:' + btoa('cipher'), true);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(mockDecryptPreKeyWhisperMessage).toHaveBeenCalledTimes(1);
    });

    it('decryptMessage handles standard WhisperMessage (subsequent messages)', async () => {
      const plainBuffer = fakeArrayBuffer('Decrypted text');
      mockDecryptWhisperMessage.mockResolvedValue(plainBuffer);

      const result = await decryptMessage('sender-1', 1, '1:' + btoa('cipher'), false);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(mockDecryptWhisperMessage).toHaveBeenCalledTimes(1);
      expect(mockDecryptPreKeyWhisperMessage).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Group Encryption — Sender Keys (Phase 7 — R14)
  // =========================================================================

  describe('Sender Key Management — Group Encryption (R14)', () => {
    it('createSenderKey generates and stores a key for a group', async () => {
      mockRegistration.get.mockResolvedValue({ id: 'local', registrationId: 42 });

      const distribution = await createSenderKey('group-abc');
      expect(distribution).toBeDefined();
      expect(distribution.groupId).toBe('group-abc');
      expect(distribution.distributionMessage).toBeDefined();
      expect(distribution.distributionMessage.length).toBeGreaterThan(0);
      expect(distribution.createdAt).toBeDefined();
      // Verify key was stored in IndexedDB
      expect(mockSenderKeys.put).toHaveBeenCalledTimes(1);
      const putArg = mockSenderKeys.put.mock.calls[0][0];
      expect(putArg.id).toBe('group-abc:local');
    });

    it('processSenderKeyDistribution stores a remote sender key', async () => {
      const fakeDistribution = toBase64(fakeArrayBuffer('sender-key-material'));

      await processSenderKeyDistribution('group-abc', 'user-xyz', fakeDistribution);
      expect(mockSenderKeys.put).toHaveBeenCalledTimes(1);
      const putArg = mockSenderKeys.put.mock.calls[0][0];
      expect(putArg.id).toBe('group-abc:user-xyz');
      expect(putArg.record).toBe(fakeDistribution);
    });

    it('processSenderKeyDistribution rejects invalid base64', async () => {
      await expect(
        processSenderKeyDistribution('group-abc', 'user-xyz', '!!!invalid-base64!!!')
      ).rejects.toThrow();
    });

    it('encryptGroupMessage encrypts plaintext with stored Sender Key', async () => {
      // Pre-store a sender key record
      const keyBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(keyBytes);
      const keyBase64 = toBase64(keyBytes.buffer);
      mockSenderKeys.get.mockResolvedValue({ id: 'group-abc:local', record: keyBase64 });

      const ciphertext = await encryptGroupMessage('group-abc', 'Group hello');
      expect(ciphertext).toBeDefined();
      expect(typeof ciphertext).toBe('string');
      expect(ciphertext.length).toBeGreaterThan(0);
      // R12: ciphertext must not contain plaintext
      expect(ciphertext).not.toContain('Group hello');
    });

    it('encryptGroupMessage throws when no Sender Key exists', async () => {
      mockSenderKeys.get.mockResolvedValue(undefined);

      await expect(encryptGroupMessage('group-999', 'Hello')).rejects.toThrow(
        /No Sender Key found/
      );
    });

    it('decryptGroupMessage decrypts ciphertext with stored Sender Key', async () => {
      // Create a real AES key, encrypt, then decrypt to test the round-trip
      const keyBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(keyBytes);
      const keyBase64 = toBase64(keyBytes.buffer);

      // First, encrypt a message
      mockSenderKeys.get.mockResolvedValue({ id: 'group-abc:local', record: keyBase64 });
      const ciphertext = await encryptGroupMessage('group-abc', 'Round trip test');

      // Now, decrypt it using the same key for a different sender
      mockSenderKeys.get.mockResolvedValue({ id: 'group-abc:sender-x', record: keyBase64 });
      const decrypted = await decryptGroupMessage('group-abc', 'sender-x', ciphertext);

      expect(decrypted).toBe('Round trip test');
    });

    it('decryptGroupMessage throws when no Sender Key exists for sender', async () => {
      mockSenderKeys.get.mockResolvedValue(undefined);

      await expect(
        decryptGroupMessage('group-abc', 'unknown-sender', 'ciphertext')
      ).rejects.toThrow(/No Sender Key found/);
    });
  });

  // =========================================================================
  // Sender Key Rotation (Phase 8 — R14)
  // =========================================================================

  describe('Sender Key Rotation (R14)', () => {
    it('rotateSenderKey deletes old key and generates a new one', async () => {
      mockRegistration.get.mockResolvedValue({ id: 'local', registrationId: 42 });

      const newDistribution = await rotateSenderKey('group-abc', 'member_removed');
      expect(newDistribution).toBeDefined();
      expect(newDistribution.groupId).toBe('group-abc');
      // Old key should be deleted
      expect(mockSenderKeys.delete).toHaveBeenCalledWith('group-abc:local');
      // New key should be stored
      expect(mockSenderKeys.put).toHaveBeenCalled();
    });

    it('rotation produces a different key than the original', async () => {
      mockRegistration.get.mockResolvedValue({ id: 'local', registrationId: 42 });

      const original = await createSenderKey('group-rotate');
      const rotated = await rotateSenderKey('group-rotate', 'member_removed');

      // Distribution messages should be different (different AES keys)
      expect(rotated.distributionMessage).not.toBe(original.distributionMessage);
    });

    it('removed member cannot decrypt after rotation (R14 forward secrecy)', async () => {
      // Member had old key
      const oldKeyBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(oldKeyBytes);
      const oldKeyBase64 = toBase64(oldKeyBytes.buffer);

      // After rotation, the group uses a new key
      const newKeyBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(newKeyBytes);
      const newKeyBase64 = toBase64(newKeyBytes.buffer);

      // Encrypt with new key
      mockSenderKeys.get.mockResolvedValue({ id: 'group-abc:local', record: newKeyBase64 });
      const ciphertext = await encryptGroupMessage('group-abc', 'Post-rotation message');

      // Removed member tries to decrypt with old key
      mockSenderKeys.get.mockResolvedValue({ id: 'group-abc:old-sender', record: oldKeyBase64 });
      await expect(
        decryptGroupMessage('group-abc', 'old-sender', ciphertext)
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // Initialization (Phase 9)
  // =========================================================================

  describe('initializeEncryption', () => {
    it('generates keys on first use when no identity exists', async () => {
      // No existing identity
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

      // Identity key pair stored
      expect(mockIdentityKeys.put).toHaveBeenCalled();
      // Registration ID stored
      expect(mockRegistration.put).toHaveBeenCalled();
      // Signed prekey stored
      expect(mockSignedPreKeys.put).toHaveBeenCalled();
      // 100 one-time prekeys generated
      expect(mockGeneratePreKey).toHaveBeenCalledTimes(100);
    });

    it('is a no-op when identity key already exists (idempotent)', async () => {
      const kp = fakeKeyPair();
      mockIdentityKeys.get.mockResolvedValue({
        id: 'local',
        publicKey: toBase64(kp.pubKey),
        privateKey: toBase64(kp.privKey),
      });

      await initializeEncryption();

      // No new keys generated
      expect(mockGenerateIdentityKeyPair).not.toHaveBeenCalled();
      expect(mockGenerateRegistrationId).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Cleanup
  // =========================================================================

  describe('clearAllEncryptionData', () => {
    it('clears all 6 IndexedDB tables in a transaction', async () => {
      await clearAllEncryptionData();

      expect(mockTransaction).toHaveBeenCalled();
      expect(mockIdentityKeys.clear).toHaveBeenCalledTimes(1);
      expect(mockPreKeys.clear).toHaveBeenCalledTimes(1);
      expect(mockSignedPreKeys.clear).toHaveBeenCalledTimes(1);
      expect(mockSessions.clear).toHaveBeenCalledTimes(1);
      expect(mockSenderKeys.clear).toHaveBeenCalledTimes(1);
      expect(mockRegistration.clear).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // R23 — Zero Plaintext Logging
  // =========================================================================

  describe('R23 — Log Hygiene', () => {
    it('encryption module contains no console.log calls for key material', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Exercise several operations
      mockRegistration.get.mockResolvedValue({ id: 'local', registrationId: 1 });
      try { await createSenderKey('test-group'); } catch { /* ignore */ }
      try { await processSenderKeyDistribution('g1', 's1', toBase64(fakeArrayBuffer('key'))); } catch { /* ignore */ }

      // No console output should contain key material
      for (const call of consoleSpy.mock.calls) {
        const output = call.map(String).join(' ');
        expect(output).not.toMatch(/privKey|privateKey|secretKey/i);
      }

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });
  });
});
