/**
 * @module EncryptionKeyService.test
 * @description Unit tests for the EncryptionKeyService class which manages
 * Signal Protocol key material exchange: PreKey bundle upload (with audit
 * logging), bundle fetch for X3DH key agreement (with one-time prekey
 * consumption and low-threshold detection), prekey replenishment, prekey
 * status checking, and bundle existence verification.
 *
 * Architecture rules validated:
 *  - R12: Server stores key bundles as opaque base64 strings. ZERO decryption logic.
 *  - R17: Interface-driven DI — service takes IKeyRepository + AuditService via constructor
 *  - R23: Audit metadata contains ONLY key counts, never actual key values
 *  - R32: Immutable audit log entry for keys.bundle_upload
 *  - R22: Standardized error responses (NotFoundError, ValidationError)
 *  - R28: Zero console.log in test code — structured logging only
 *  - R7 : TypeScript strict mode, zero warnings
 *
 * Test Framework: Jest ^29.7.x with ts-jest ^29.1.x
 * Coverage target: ≥80%
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Imports
 * ──────────────────────────────────────────────────────────────────────────── */

import { EncryptionKeyService, type FetchBundleResult } from '../../../src/services/EncryptionKeyService';
import type { IKeyRepository } from '../../../src/domain/interfaces/IKeyRepository';
import { AuditService } from '../../../src/services/AuditService';
import { NotFoundError } from '../../../src/errors/NotFoundError';
import { ValidationError } from '../../../src/errors/ValidationError';
import { AuditAction } from '@kalle/shared';
import type {
  PreKeyBundleDTO,
  PreKeyBundleResponse,
  PreKeyCountStatus,
  PublicPreKey,
} from '@kalle/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Constants
 * ──────────────────────────────────────────────────────────────────────────── */

/** Mirrors the PREKEY_LOW_THRESHOLD constant inside EncryptionKeyService (10). */
const PREKEY_LOW_THRESHOLD = 10;

/* ────────────────────────────────────────────────────────────────────────────
 * Test Data Factories
 *
 * All key material is treated as opaque base64 strings — the server never
 * decrypts them (R12). Factories produce structurally valid objects that
 * satisfy the PreKeyBundleDTO / PreKeyBundleResponse / PublicPreKey contracts.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Create a structurally valid PreKeyBundleDTO for upload tests.
 * Optionally accepts an override for preKeys count.
 */
const createValidBundle = (preKeyCount = 2): PreKeyBundleDTO => {
  const preKeys: PublicPreKey[] = Array.from({ length: preKeyCount }, (_, i) => ({
    keyId: i + 1,
    publicKey: `base64PreKey${i + 1}==`,
  }));

  return {
    identityKey: { publicKey: 'base64IdentityKey==' },
    signedPreKey: {
      keyId: 1,
      publicKey: 'base64SignedPreKey==',
      signature: 'base64Signature==',
      timestamp: Date.now(),
    },
    preKeys,
    registrationId: 12345,
  };
};

/**
 * Create a valid PreKeyBundleResponse as returned by repository.findByUserId().
 */
const createBundleResponse = (userId = 'user-2'): PreKeyBundleResponse => ({
  userId,
  identityKey: { publicKey: 'base64IdentityKey==' },
  signedPreKey: {
    keyId: 1,
    publicKey: 'base64SignedPreKey==',
    signature: 'base64Signature==',
    timestamp: Date.now(),
  },
  preKey: { keyId: 1, publicKey: 'base64PreKey1==' },
  registrationId: 12345,
});

/**
 * Create a valid PreKeyCountStatus as returned by repository.getPreKeyStatus().
 */
const createPreKeyStatus = (
  remaining: number,
  userId = 'user-1',
): PreKeyCountStatus => ({
  userId,
  remainingPreKeys: remaining,
  threshold: PREKEY_LOW_THRESHOLD,
  needsReplenishment: remaining < PREKEY_LOW_THRESHOLD,
});

/* ────────────────────────────────────────────────────────────────────────────
 * Mock Dependencies (R17 — interface mocks validate DI)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Creates a fresh mock implementing IKeyRepository.
 * Each method is a jest.fn() returning sensible defaults.
 */
const createMockKeyRepository = (): jest.Mocked<IKeyRepository> => ({
  upsertBundle: jest.fn().mockResolvedValue(undefined),
  findByUserId: jest.fn().mockResolvedValue(null),
  consumePreKey: jest.fn().mockResolvedValue(null),
  countRemainingPreKeys: jest.fn().mockResolvedValue(0),
  getPreKeyStatus: jest.fn().mockResolvedValue(null),
  addPreKeys: jest.fn().mockResolvedValue(undefined),
  hasBundle: jest.fn().mockResolvedValue(false),
});

/**
 * Creates a fresh mock for AuditService.
 * Only the log() method is used by EncryptionKeyService.
 * Cast via `as unknown as AuditService` to satisfy strict TypeScript (R7).
 */
const createMockAuditService = (): { log: jest.Mock } => ({
  log: jest.fn().mockResolvedValue(null),
});

/* ────────────────────────────────────────────────────────────────────────────
 * Test Suite
 * ──────────────────────────────────────────────────────────────────────────── */

describe('EncryptionKeyService', () => {
  let service: EncryptionKeyService;
  let mockKeyRepository: jest.Mocked<IKeyRepository>;
  let mockAuditService: { log: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    mockKeyRepository = createMockKeyRepository();
    mockAuditService = createMockAuditService();

    // Construct service with mocked dependencies (R17: interface-driven DI)
    service = new EncryptionKeyService(
      mockKeyRepository,
      mockAuditService as unknown as AuditService,
    );
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * uploadBundle
   * ──────────────────────────────────────────────────────────────────────── */

  describe('uploadBundle', () => {
    it('should upsert the bundle via keyRepository', async () => {
      const bundle = createValidBundle();

      await service.uploadBundle('user-1', bundle);

      expect(mockKeyRepository.upsertBundle).toHaveBeenCalledTimes(1);
      expect(mockKeyRepository.upsertBundle).toHaveBeenCalledWith('user-1', bundle);
    });

    it('should write audit entry for keys.bundle_upload (R32)', async () => {
      const bundle = createValidBundle();

      await service.uploadBundle('user-1', bundle);

      expect(mockAuditService.log).toHaveBeenCalledTimes(1);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.KEYS_BUNDLE_UPLOAD,
          actorId: 'user-1',
        }),
      );
    });

    it('should include ONLY preKeyCount in audit metadata — NOT actual key values (R23)', async () => {
      const preKeyCount = 5;
      const bundle = createValidBundle(preKeyCount);

      await service.uploadBundle('user-1', bundle);

      // Extract the actual metadata passed to audit log
      const auditCallArgs = mockAuditService.log.mock.calls[0][0] as {
        action: string;
        actorId: string;
        metadata?: Record<string, unknown>;
      };

      // Metadata MUST contain preKeyCount
      expect(auditCallArgs.metadata).toBeDefined();
      expect(auditCallArgs.metadata).toEqual(
        expect.objectContaining({ preKeyCount }),
      );

      // Metadata MUST NOT contain any actual key material (R23)
      const metadata = auditCallArgs.metadata as Record<string, unknown>;
      expect(metadata).not.toHaveProperty('identityKey');
      expect(metadata).not.toHaveProperty('signedPreKey');
      expect(metadata).not.toHaveProperty('preKeys');
      expect(metadata).not.toHaveProperty('publicKey');
      expect(metadata).not.toHaveProperty('signature');
      expect(metadata).not.toHaveProperty('registrationId');
    });

    it('should throw ValidationError if bundle is missing identityKey', async () => {
      const bundle = createValidBundle();
      // Remove the identityKey entirely to trigger validation
      const invalidBundle = { ...bundle, identityKey: undefined } as unknown as PreKeyBundleDTO;

      await expect(service.uploadBundle('user-1', invalidBundle)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError if identityKey has empty publicKey', async () => {
      const bundle = createValidBundle();
      const invalidBundle: PreKeyBundleDTO = {
        ...bundle,
        identityKey: { publicKey: '' },
      };

      await expect(service.uploadBundle('user-1', invalidBundle)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError if bundle has empty preKeys array', async () => {
      const bundle = createValidBundle();
      const invalidBundle: PreKeyBundleDTO = {
        ...bundle,
        preKeys: [],
      };

      await expect(service.uploadBundle('user-1', invalidBundle)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError if signedPreKey is missing', async () => {
      const bundle = createValidBundle();
      const invalidBundle = { ...bundle, signedPreKey: undefined } as unknown as PreKeyBundleDTO;

      await expect(service.uploadBundle('user-1', invalidBundle)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError if registrationId is not a number', async () => {
      const bundle = createValidBundle();
      const invalidBundle = {
        ...bundle,
        registrationId: 'not-a-number' as unknown as number,
      } as PreKeyBundleDTO;

      await expect(service.uploadBundle('user-1', invalidBundle)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError if signedPreKey has missing publicKey', async () => {
      const bundle = createValidBundle();
      const invalidBundle: PreKeyBundleDTO = {
        ...bundle,
        signedPreKey: {
          ...bundle.signedPreKey,
          publicKey: '',
        },
      };

      await expect(service.uploadBundle('user-1', invalidBundle)).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError if signedPreKey has missing signature', async () => {
      const bundle = createValidBundle();
      const invalidBundle: PreKeyBundleDTO = {
        ...bundle,
        signedPreKey: {
          ...bundle.signedPreKey,
          signature: '',
        },
      };

      await expect(service.uploadBundle('user-1', invalidBundle)).rejects.toThrow(ValidationError);
    });

    it('should not call keyRepository.upsertBundle if bundle is invalid', async () => {
      const invalidBundle: PreKeyBundleDTO = {
        ...createValidBundle(),
        preKeys: [],
      };

      await expect(service.uploadBundle('user-1', invalidBundle)).rejects.toThrow(ValidationError);
      expect(mockKeyRepository.upsertBundle).not.toHaveBeenCalled();
    });

    it('should not call auditService.log if bundle validation fails', async () => {
      const invalidBundle = {
        ...createValidBundle(),
        identityKey: undefined,
      } as unknown as PreKeyBundleDTO;

      await expect(service.uploadBundle('user-1', invalidBundle)).rejects.toThrow(ValidationError);
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    it('should handle repository errors propagated to the caller', async () => {
      mockKeyRepository.upsertBundle.mockRejectedValueOnce(new Error('DB connection failed'));
      const bundle = createValidBundle();

      await expect(service.uploadBundle('user-1', bundle)).rejects.toThrow('DB connection failed');
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * fetchBundle — X3DH key exchange
   * ──────────────────────────────────────────────────────────────────────── */

  describe('fetchBundle', () => {
    it('should fetch bundle from keyRepository', async () => {
      const bundleResponse = createBundleResponse('user-2');
      mockKeyRepository.findByUserId.mockResolvedValueOnce(bundleResponse);
      mockKeyRepository.countRemainingPreKeys.mockResolvedValueOnce(50);

      const result: FetchBundleResult = await service.fetchBundle('user-2');

      expect(mockKeyRepository.findByUserId).toHaveBeenCalledTimes(1);
      expect(mockKeyRepository.findByUserId).toHaveBeenCalledWith('user-2');
      expect(result.bundle).toEqual(bundleResponse);
    });

    it('should throw NotFoundError if bundle not found', async () => {
      mockKeyRepository.findByUserId.mockResolvedValueOnce(null);

      await expect(service.fetchBundle('unknown-user')).rejects.toThrow(NotFoundError);

      try {
        mockKeyRepository.findByUserId.mockResolvedValueOnce(null);
        await service.fetchBundle('unknown-user');
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundError);
        expect((error as NotFoundError).message).toBe('PreKey bundle not found');
        expect((error as NotFoundError).code).toBe('NOT_FOUND');
        expect((error as NotFoundError).statusCode).toBe(404);
      }
    });

    it('should check remaining prekey count after fetch', async () => {
      const bundleResponse = createBundleResponse('user-2');
      mockKeyRepository.findByUserId.mockResolvedValueOnce(bundleResponse);
      mockKeyRepository.countRemainingPreKeys.mockResolvedValueOnce(15);

      await service.fetchBundle('user-2');

      expect(mockKeyRepository.countRemainingPreKeys).toHaveBeenCalledTimes(1);
      expect(mockKeyRepository.countRemainingPreKeys).toHaveBeenCalledWith('user-2');
    });

    it('should return lowPreKeys=false when above threshold', async () => {
      const bundleResponse = createBundleResponse('user-2');
      mockKeyRepository.findByUserId.mockResolvedValueOnce(bundleResponse);
      mockKeyRepository.countRemainingPreKeys.mockResolvedValueOnce(50);

      const result = await service.fetchBundle('user-2');

      expect(result.lowPreKeys).toBe(false);
      expect(result.remainingPreKeys).toBe(50);
    });

    it('should return lowPreKeys=true when below threshold (< 10)', async () => {
      const bundleResponse = createBundleResponse('user-2');
      mockKeyRepository.findByUserId.mockResolvedValueOnce(bundleResponse);
      mockKeyRepository.countRemainingPreKeys.mockResolvedValueOnce(5);

      const result = await service.fetchBundle('user-2');

      expect(result.lowPreKeys).toBe(true);
      expect(result.remainingPreKeys).toBe(5);
    });

    it('should return lowPreKeys=true when prekeys are exactly at threshold', async () => {
      // Threshold is 10, remaining is 9 → below threshold → lowPreKeys=true
      const bundleResponse = createBundleResponse('user-2');
      mockKeyRepository.findByUserId.mockResolvedValueOnce(bundleResponse);
      mockKeyRepository.countRemainingPreKeys.mockResolvedValueOnce(9);

      const result = await service.fetchBundle('user-2');

      expect(result.lowPreKeys).toBe(true);
    });

    it('should return lowPreKeys=false when prekeys equal threshold (boundary)', async () => {
      // remaining === 10, threshold is 10 → not below → lowPreKeys=false
      const bundleResponse = createBundleResponse('user-2');
      mockKeyRepository.findByUserId.mockResolvedValueOnce(bundleResponse);
      mockKeyRepository.countRemainingPreKeys.mockResolvedValueOnce(PREKEY_LOW_THRESHOLD);

      const result = await service.fetchBundle('user-2');

      expect(result.lowPreKeys).toBe(false);
      expect(result.remainingPreKeys).toBe(PREKEY_LOW_THRESHOLD);
    });

    it('should return lowPreKeys=true when zero prekeys remain', async () => {
      const bundleResponse = createBundleResponse('user-2');
      mockKeyRepository.findByUserId.mockResolvedValueOnce(bundleResponse);
      mockKeyRepository.countRemainingPreKeys.mockResolvedValueOnce(0);

      const result = await service.fetchBundle('user-2');

      expect(result.lowPreKeys).toBe(true);
      expect(result.remainingPreKeys).toBe(0);
    });

    it('should not call countRemainingPreKeys when bundle is not found', async () => {
      mockKeyRepository.findByUserId.mockResolvedValueOnce(null);

      await expect(service.fetchBundle('unknown-user')).rejects.toThrow(NotFoundError);
      expect(mockKeyRepository.countRemainingPreKeys).not.toHaveBeenCalled();
    });

    it('should return bundle with optional preKey undefined when exhausted', async () => {
      const bundleNoPreKey: PreKeyBundleResponse = {
        ...createBundleResponse('user-2'),
        preKey: undefined,
      };
      mockKeyRepository.findByUserId.mockResolvedValueOnce(bundleNoPreKey);
      mockKeyRepository.countRemainingPreKeys.mockResolvedValueOnce(0);

      const result = await service.fetchBundle('user-2');

      expect(result.bundle.preKey).toBeUndefined();
      expect(result.lowPreKeys).toBe(true);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * addPreKeys — replenishment
   * ──────────────────────────────────────────────────────────────────────── */

  describe('addPreKeys', () => {
    it('should add preKeys via keyRepository', async () => {
      const preKeys: PublicPreKey[] = [
        { keyId: 10, publicKey: 'base64PreKey10==' },
        { keyId: 11, publicKey: 'base64PreKey11==' },
      ];

      await service.addPreKeys('user-1', preKeys);

      expect(mockKeyRepository.addPreKeys).toHaveBeenCalledTimes(1);
      expect(mockKeyRepository.addPreKeys).toHaveBeenCalledWith('user-1', preKeys);
    });

    it('should throw ValidationError if preKeys array is empty', async () => {
      await expect(service.addPreKeys('user-1', [])).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError with correct error code for empty preKeys', async () => {
      try {
        await service.addPreKeys('user-1', []);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).code).toBe('VALIDATION_ERROR');
        expect((error as ValidationError).statusCode).toBe(400);
      }
    });

    it('should not call keyRepository.addPreKeys if preKeys array is empty', async () => {
      await expect(service.addPreKeys('user-1', [])).rejects.toThrow(ValidationError);
      expect(mockKeyRepository.addPreKeys).not.toHaveBeenCalled();
    });

    it('should handle single preKey in array', async () => {
      const preKeys: PublicPreKey[] = [{ keyId: 100, publicKey: 'base64NewKey==' }];

      await service.addPreKeys('user-1', preKeys);

      expect(mockKeyRepository.addPreKeys).toHaveBeenCalledWith('user-1', preKeys);
    });

    it('should handle large batch of preKeys', async () => {
      const preKeys: PublicPreKey[] = Array.from({ length: 100 }, (_, i) => ({
        keyId: i + 1,
        publicKey: `base64Batch${i}==`,
      }));

      await service.addPreKeys('user-1', preKeys);

      expect(mockKeyRepository.addPreKeys).toHaveBeenCalledWith('user-1', preKeys);
    });

    it('should propagate repository errors to the caller', async () => {
      mockKeyRepository.addPreKeys.mockRejectedValueOnce(new Error('Write failed'));

      const preKeys: PublicPreKey[] = [{ keyId: 50, publicKey: 'base64Key==' }];

      await expect(service.addPreKeys('user-1', preKeys)).rejects.toThrow('Write failed');
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * getPreKeyStatus
   * ──────────────────────────────────────────────────────────────────────── */

  describe('getPreKeyStatus', () => {
    it('should delegate to keyRepository.getPreKeyStatus', async () => {
      const status = createPreKeyStatus(15, 'user-1');
      mockKeyRepository.getPreKeyStatus.mockResolvedValueOnce(status);

      const result = await service.getPreKeyStatus('user-1');

      expect(mockKeyRepository.getPreKeyStatus).toHaveBeenCalledTimes(1);
      expect(mockKeyRepository.getPreKeyStatus).toHaveBeenCalledWith('user-1');
      expect(result).toEqual(status);
    });

    it('should return status with needsReplenishment=true when below threshold', async () => {
      const status = createPreKeyStatus(3, 'user-1');
      mockKeyRepository.getPreKeyStatus.mockResolvedValueOnce(status);

      const result = await service.getPreKeyStatus('user-1');

      expect(result).not.toBeNull();
      expect(result!.remainingPreKeys).toBe(3);
      expect(result!.needsReplenishment).toBe(true);
    });

    it('should return status with needsReplenishment=false when above threshold', async () => {
      const status = createPreKeyStatus(50, 'user-1');
      mockKeyRepository.getPreKeyStatus.mockResolvedValueOnce(status);

      const result = await service.getPreKeyStatus('user-1');

      expect(result).not.toBeNull();
      expect(result!.remainingPreKeys).toBe(50);
      expect(result!.needsReplenishment).toBe(false);
    });

    it('should return null if user has no bundle', async () => {
      mockKeyRepository.getPreKeyStatus.mockResolvedValueOnce(null);

      const result = await service.getPreKeyStatus('nonexistent-user');

      expect(result).toBeNull();
    });

    it('should propagate repository errors to the caller', async () => {
      mockKeyRepository.getPreKeyStatus.mockRejectedValueOnce(new Error('DB error'));

      await expect(service.getPreKeyStatus('user-1')).rejects.toThrow('DB error');
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * hasBundle
   * ──────────────────────────────────────────────────────────────────────── */

  describe('hasBundle', () => {
    it('should return true if user has a bundle', async () => {
      mockKeyRepository.hasBundle.mockResolvedValueOnce(true);

      const result = await service.hasBundle('user-1');

      expect(mockKeyRepository.hasBundle).toHaveBeenCalledTimes(1);
      expect(mockKeyRepository.hasBundle).toHaveBeenCalledWith('user-1');
      expect(result).toBe(true);
    });

    it('should return false if user has no bundle', async () => {
      mockKeyRepository.hasBundle.mockResolvedValueOnce(false);

      const result = await service.hasBundle('nonexistent-user');

      expect(result).toBe(false);
    });

    it('should propagate repository errors to the caller', async () => {
      mockKeyRepository.hasBundle.mockRejectedValueOnce(new Error('Connection lost'));

      await expect(service.hasBundle('user-1')).rejects.toThrow('Connection lost');
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Constructor & Dependency Injection (R17)
   * ──────────────────────────────────────────────────────────────────────── */

  describe('constructor (R17 interface-driven DI)', () => {
    it('should accept IKeyRepository and AuditService via constructor', () => {
      // The service was already constructed in beforeEach.
      // If the constructor signature were wrong, TypeScript compilation
      // would fail (enforced by R7: strict mode).
      expect(service).toBeInstanceOf(EncryptionKeyService);
    });

    it('should create separate instances with separate dependencies', () => {
      const repo2 = createMockKeyRepository();
      const audit2 = createMockAuditService();
      const service2 = new EncryptionKeyService(
        repo2,
        audit2 as unknown as AuditService,
      );

      expect(service2).toBeInstanceOf(EncryptionKeyService);
      expect(service2).not.toBe(service);
    });
  });
});
