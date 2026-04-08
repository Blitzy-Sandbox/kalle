/**
 * @module AuditService.test
 *
 * Unit tests for the AuditService class — the FOUNDATIONAL audit logging
 * service injected into AuthService, UserService, ConversationService,
 * MessageService, and EncryptionKeyService.
 *
 * Tests validate:
 *  - R32 (Immutable Audit Log): Only `create()` is called — never update/delete
 *  - R23 (Log Hygiene): Metadata sanitization strips ALL sensitive keys
 *  - R29 (Correlation ID Propagation): correlationId forwarded to repository
 *  - R17 (Interface-Driven Dependencies): Constructor receives IAuditRepository
 *  - R28 (Structured Logging Only): Zero console.log in test file
 *  - R7  (Zero Warnings Build): TypeScript strict mode, zero warnings
 *
 * Coverage target: ≥80%
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Imports
 * ──────────────────────────────────────────────────────────────────────────── */

import { AuditService } from '../../../src/services/AuditService';
import type { IAuditRepository, AuditLogPage } from '../../../src/domain/interfaces/IAuditRepository';
import type { AuditLogEntry, AuditLogQuery, CreateAuditLogDTO } from '@kalle/shared';
import { AuditAction } from '@kalle/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Mock IAuditRepository (R17 — interface mock validates DI)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Creates a fresh mock of IAuditRepository with all 4 methods stubbed.
 * Called in beforeEach to ensure test isolation.
 */
function createMockAuditRepository(): jest.Mocked<IAuditRepository> {
  return {
    create: jest.fn(),
    findByQuery: jest.fn(),
    count: jest.fn(),
    deleteOlderThan: jest.fn(),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/** Default AuditLogEntry returned by the mocked create() on success. */
function defaultAuditLogEntry(overrides?: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    id: 'audit-1',
    action: AuditAction.USER_REGISTER,
    actorId: 'user-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Test Suite
 * ──────────────────────────────────────────────────────────────────────────── */

describe('AuditService', () => {
  let service: AuditService;
  let mockAuditRepository: jest.Mocked<IAuditRepository>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuditRepository = createMockAuditRepository();
    service = new AuditService(mockAuditRepository);

    // Default: create resolves successfully
    mockAuditRepository.create.mockResolvedValue(defaultAuditLogEntry());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // describe: log — primary method (R32)
  // ─────────────────────────────────────────────────────────────────────────

  describe('log — primary method (R32)', () => {
    it('should create an audit log entry via repository.create', async () => {
      await service.log({
        action: AuditAction.USER_REGISTER,
        actorId: 'user-1',
      });

      expect(mockAuditRepository.create).toHaveBeenCalledTimes(1);
      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.action).toBe(AuditAction.USER_REGISTER);
      expect(dto.actorId).toBe('user-1');
    });

    it('should pass correlationId to the repository (R29)', async () => {
      await service.log({
        action: AuditAction.USER_LOGIN,
        actorId: 'user-1',
        correlationId: 'corr-123',
      });

      expect(mockAuditRepository.create).toHaveBeenCalledTimes(1);
      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.correlationId).toBe('corr-123');
    });

    it('should pass targetId when provided', async () => {
      await service.log({
        action: AuditAction.USER_BLOCK,
        actorId: 'user-1',
        targetId: 'user-2',
      });

      expect(mockAuditRepository.create).toHaveBeenCalledTimes(1);
      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.targetId).toBe('user-2');
    });

    it('should pass ipAddress and userAgent when provided', async () => {
      await service.log({
        action: AuditAction.USER_LOGIN,
        actorId: 'user-1',
        ipAddress: '192.168.1.100',
        userAgent: 'Mozilla/5.0 (Test Agent)',
      });

      expect(mockAuditRepository.create).toHaveBeenCalledTimes(1);
      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.ipAddress).toBe('192.168.1.100');
      expect(dto.userAgent).toBe('Mozilla/5.0 (Test Agent)');
    });

    it('should support all 12 audit actions from AAP', async () => {
      const allActions: AuditAction[] = [
        AuditAction.USER_REGISTER,
        AuditAction.USER_LOGIN,
        AuditAction.USER_LOGIN_FAILED,
        AuditAction.SESSION_REVOKE,
        AuditAction.SESSION_REVOKE_ALL,
        AuditAction.USER_BLOCK,
        AuditAction.USER_UNBLOCK,
        AuditAction.GROUP_MEMBER_ADD,
        AuditAction.GROUP_MEMBER_REMOVE,
        AuditAction.GROUP_ADMIN_CHANGE,
        AuditAction.MESSAGE_DELETE,
        AuditAction.KEYS_BUNDLE_UPLOAD,
      ];

      for (const action of allActions) {
        jest.clearAllMocks();
        mockAuditRepository.create.mockResolvedValue(
          defaultAuditLogEntry({ action }),
        );

        await service.log({ action, actorId: 'user-1' });

        expect(mockAuditRepository.create).toHaveBeenCalledTimes(1);
        const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
        expect(dto.action).toBe(action);
      }

      // Verify all 12 actions were tested
      expect(allActions).toHaveLength(12);
    });

    it('should NEVER throw — returns null on failure (critical design)', async () => {
      mockAuditRepository.create.mockRejectedValue(new Error('DB unavailable'));

      const result = await service.log({
        action: AuditAction.USER_REGISTER,
        actorId: 'user-1',
      });

      // Must resolve, not reject
      expect(result).toBeNull();
    });

    it('should return the created AuditLogEntry on success', async () => {
      const expectedEntry = defaultAuditLogEntry({
        id: 'audit-success-1',
        action: AuditAction.USER_LOGIN,
        actorId: 'user-42',
      });
      mockAuditRepository.create.mockResolvedValue(expectedEntry);

      const result = await service.log({
        action: AuditAction.USER_LOGIN,
        actorId: 'user-42',
      });

      expect(result).toEqual(expectedEntry);
    });

    it('should handle null rejection gracefully', async () => {
      mockAuditRepository.create.mockRejectedValue(null);

      const result = await service.log({
        action: AuditAction.USER_REGISTER,
        actorId: 'user-1',
      });

      expect(result).toBeNull();
    });

    it('should handle string error rejection gracefully', async () => {
      mockAuditRepository.create.mockRejectedValue('Connection refused');

      const result = await service.log({
        action: AuditAction.SESSION_REVOKE,
        actorId: 'user-1',
      });

      expect(result).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // describe: log — metadata sanitization (R23, R32)
  // ─────────────────────────────────────────────────────────────────────────

  describe('log — metadata sanitization (R23, R32)', () => {
    it('should redact "password" from metadata', async () => {
      await service.log({
        action: AuditAction.USER_REGISTER,
        actorId: 'user-1',
        metadata: { password: 'secretpass123' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['password']).toBe('[REDACTED]');
    });

    it('should redact "passwordHash" from metadata', async () => {
      await service.log({
        action: AuditAction.USER_REGISTER,
        actorId: 'user-1',
        metadata: { passwordHash: '$2b$12$abcdef...' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['passwordHash']).toBe('[REDACTED]');
    });

    it('should redact "token" from metadata', async () => {
      await service.log({
        action: AuditAction.SESSION_REVOKE,
        actorId: 'user-1',
        metadata: { token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['token']).toBe('[REDACTED]');
    });

    it('should redact "accessToken" from metadata', async () => {
      await service.log({
        action: AuditAction.SESSION_REVOKE,
        actorId: 'user-1',
        metadata: { accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['accessToken']).toBe('[REDACTED]');
    });

    it('should redact "refreshToken" from metadata', async () => {
      await service.log({
        action: AuditAction.SESSION_REVOKE,
        actorId: 'user-1',
        metadata: { refreshToken: 'uuid-refresh-token-value' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['refreshToken']).toBe('[REDACTED]');
    });

    it('should redact "encryptionKey" from metadata', async () => {
      await service.log({
        action: AuditAction.KEYS_BUNDLE_UPLOAD,
        actorId: 'user-1',
        metadata: { encryptionKey: 'base64encodedkey==' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['encryptionKey']).toBe('[REDACTED]');
    });

    it('should redact "identityKey" from metadata', async () => {
      await service.log({
        action: AuditAction.KEYS_BUNDLE_UPLOAD,
        actorId: 'user-1',
        metadata: { identityKey: 'base64identitykey==' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['identityKey']).toBe('[REDACTED]');
    });

    it('should redact "signedPreKey" from metadata', async () => {
      await service.log({
        action: AuditAction.KEYS_BUNDLE_UPLOAD,
        actorId: 'user-1',
        metadata: { signedPreKey: 'base64signedprekey==' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['signedPreKey']).toBe('[REDACTED]');
    });

    it('should redact "ciphertext" from metadata', async () => {
      await service.log({
        action: AuditAction.MESSAGE_DELETE,
        actorId: 'user-1',
        metadata: { ciphertext: 'encrypted-binary-data-here' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['ciphertext']).toBe('[REDACTED]');
    });

    it('should redact "content" from metadata', async () => {
      await service.log({
        action: AuditAction.MESSAGE_DELETE,
        actorId: 'user-1',
        metadata: { content: 'Hello World plaintext message' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['content']).toBe('[REDACTED]');
    });

    it('should redact nested sensitive keys recursively', async () => {
      await service.log({
        action: AuditAction.USER_REGISTER,
        actorId: 'user-1',
        metadata: {
          user: {
            passwordHash: 'hash123',
            email: 'test@test.com',
          },
        },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      const userMeta = dto.metadata!['user'] as Record<string, unknown>;
      expect(userMeta['passwordHash']).toBe('[REDACTED]');
      expect(userMeta['email']).toBe('test@test.com');
    });

    it('should not mutate the original metadata object', async () => {
      const originalMetadata: Record<string, unknown> = {
        password: 'secret123',
        email: 'user@test.com',
        nested: {
          token: 'jwt-token-value',
          safe: 'keep-this',
        },
      };

      // Store a deep copy for comparison
      const passwordBefore = originalMetadata['password'];
      const nestedBefore = (originalMetadata['nested'] as Record<string, unknown>)['token'];

      await service.log({
        action: AuditAction.USER_REGISTER,
        actorId: 'user-1',
        metadata: originalMetadata,
      });

      // Original must not be mutated
      expect(originalMetadata['password']).toBe(passwordBefore);
      expect(
        (originalMetadata['nested'] as Record<string, unknown>)['token'],
      ).toBe(nestedBefore);
    });

    it('should preserve non-sensitive metadata keys', async () => {
      await service.log({
        action: AuditAction.KEYS_BUNDLE_UPLOAD,
        actorId: 'user-1',
        metadata: { email: 'user@test.com', preKeyCount: 10, reason: 'invalid_password' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['email']).toBe('user@test.com');
      expect(dto.metadata!['preKeyCount']).toBe(10);
      expect(dto.metadata!['reason']).toBe('invalid_password');
    });

    it('should handle metadata with no sensitive keys', async () => {
      const safeMetadata = { conversationId: 'conv-1', newRole: 'ADMIN' };

      await service.log({
        action: AuditAction.GROUP_ADMIN_CHANGE,
        actorId: 'user-1',
        metadata: safeMetadata,
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata).toEqual({ conversationId: 'conv-1', newRole: 'ADMIN' });
    });

    it('should handle undefined metadata', async () => {
      await service.log({
        action: AuditAction.USER_LOGIN,
        actorId: 'user-1',
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata).toBeUndefined();
    });

    it('should handle case-insensitive sensitive key matching', async () => {
      await service.log({
        action: AuditAction.USER_REGISTER,
        actorId: 'user-1',
        metadata: { Password: 'secret', TOKEN: 'jwt-value' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['Password']).toBe('[REDACTED]');
      expect(dto.metadata!['TOKEN']).toBe('[REDACTED]');
    });

    it('should redact "jwtToken" from metadata', async () => {
      await service.log({
        action: AuditAction.SESSION_REVOKE,
        actorId: 'user-1',
        metadata: { jwtToken: 'eyJhbGci...' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['jwtToken']).toBe('[REDACTED]');
    });

    it('should redact "jwt" from metadata', async () => {
      await service.log({
        action: AuditAction.SESSION_REVOKE,
        actorId: 'user-1',
        metadata: { jwt: 'eyJhbGci...' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['jwt']).toBe('[REDACTED]');
    });

    it('should redact "secret" from metadata', async () => {
      await service.log({
        action: AuditAction.SESSION_REVOKE,
        actorId: 'user-1',
        metadata: { secret: 'my-super-secret' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['secret']).toBe('[REDACTED]');
    });

    it('should redact "preKey" from metadata', async () => {
      await service.log({
        action: AuditAction.KEYS_BUNDLE_UPLOAD,
        actorId: 'user-1',
        metadata: { preKey: 'base64prekey==' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['preKey']).toBe('[REDACTED]');
    });

    it('should redact "preKeys" from metadata', async () => {
      await service.log({
        action: AuditAction.KEYS_BUNDLE_UPLOAD,
        actorId: 'user-1',
        metadata: { preKeys: ['key1', 'key2', 'key3'] },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['preKeys']).toBe('[REDACTED]');
    });

    it('should redact "privateKey" from metadata', async () => {
      await service.log({
        action: AuditAction.KEYS_BUNDLE_UPLOAD,
        actorId: 'user-1',
        metadata: { privateKey: 'base64privatekey==' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['privateKey']).toBe('[REDACTED]');
    });

    it('should redact "publicKey" from metadata', async () => {
      await service.log({
        action: AuditAction.KEYS_BUNDLE_UPLOAD,
        actorId: 'user-1',
        metadata: { publicKey: 'base64publickey==' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['publicKey']).toBe('[REDACTED]');
    });

    it('should redact "encryptionIv" from metadata', async () => {
      await service.log({
        action: AuditAction.KEYS_BUNDLE_UPLOAD,
        actorId: 'user-1',
        metadata: { encryptionIv: 'base64iv==' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['encryptionIv']).toBe('[REDACTED]');
    });

    it('should redact "plaintext" from metadata', async () => {
      await service.log({
        action: AuditAction.MESSAGE_DELETE,
        actorId: 'user-1',
        metadata: { plaintext: 'This is a decrypted message body' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['plaintext']).toBe('[REDACTED]');
    });

    it('should redact "messageContent" from metadata', async () => {
      await service.log({
        action: AuditAction.MESSAGE_DELETE,
        actorId: 'user-1',
        metadata: { messageContent: 'Some message body text' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['messageContent']).toBe('[REDACTED]');
    });

    it('should redact "fileContent" from metadata', async () => {
      await service.log({
        action: AuditAction.MESSAGE_DELETE,
        actorId: 'user-1',
        metadata: { fileContent: 'binary-file-data-here' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['fileContent']).toBe('[REDACTED]');
    });

    it('should redact "buffer" from metadata', async () => {
      await service.log({
        action: AuditAction.MESSAGE_DELETE,
        actorId: 'user-1',
        metadata: { buffer: 'raw-buffer-data' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['buffer']).toBe('[REDACTED]');
    });

    it('should redact ALL sensitive keys from SENSITIVE_METADATA_KEYS in one object', async () => {
      const allSensitiveMetadata: Record<string, unknown> = {
        password: 'pass1',
        passwordHash: 'hash1',
        token: 'tok1',
        accessToken: 'atok1',
        refreshToken: 'rtok1',
        jwtToken: 'jtok1',
        jwt: 'j1',
        secret: 'sec1',
        identityKey: 'ikey1',
        signedPreKey: 'spk1',
        preKey: 'pk1',
        preKeys: ['pk2', 'pk3'],
        privateKey: 'privk1',
        publicKey: 'pubk1',
        encryptionKey: 'ekey1',
        encryptionIv: 'eiv1',
        ciphertext: 'ct1',
        plaintext: 'pt1',
        messageContent: 'mc1',
        content: 'c1',
        fileContent: 'fc1',
        buffer: 'buf1',
        // Non-sensitive keys that should be preserved
        email: 'user@example.com',
        preKeyCount: 100,
        conversationId: 'conv-1',
      };

      await service.log({
        action: AuditAction.USER_REGISTER,
        actorId: 'user-1',
        metadata: allSensitiveMetadata,
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      const meta = dto.metadata!;

      // All sensitive keys should be redacted
      expect(meta['password']).toBe('[REDACTED]');
      expect(meta['passwordHash']).toBe('[REDACTED]');
      expect(meta['token']).toBe('[REDACTED]');
      expect(meta['accessToken']).toBe('[REDACTED]');
      expect(meta['refreshToken']).toBe('[REDACTED]');
      expect(meta['jwtToken']).toBe('[REDACTED]');
      expect(meta['jwt']).toBe('[REDACTED]');
      expect(meta['secret']).toBe('[REDACTED]');
      expect(meta['identityKey']).toBe('[REDACTED]');
      expect(meta['signedPreKey']).toBe('[REDACTED]');
      expect(meta['preKey']).toBe('[REDACTED]');
      expect(meta['preKeys']).toBe('[REDACTED]');
      expect(meta['privateKey']).toBe('[REDACTED]');
      expect(meta['publicKey']).toBe('[REDACTED]');
      expect(meta['encryptionKey']).toBe('[REDACTED]');
      expect(meta['encryptionIv']).toBe('[REDACTED]');
      expect(meta['ciphertext']).toBe('[REDACTED]');
      expect(meta['plaintext']).toBe('[REDACTED]');
      expect(meta['messageContent']).toBe('[REDACTED]');
      expect(meta['content']).toBe('[REDACTED]');
      expect(meta['fileContent']).toBe('[REDACTED]');
      expect(meta['buffer']).toBe('[REDACTED]');

      // Non-sensitive keys should be preserved
      expect(meta['email']).toBe('user@example.com');
      expect(meta['preKeyCount']).toBe(100);
      expect(meta['conversationId']).toBe('conv-1');
    });

    it('should redact sensitive keys in deeply nested objects', async () => {
      await service.log({
        action: AuditAction.USER_REGISTER,
        actorId: 'user-1',
        metadata: {
          level1: {
            level2: {
              password: 'deep-password',
              safeField: 'keep-me',
            },
          },
        },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      const level1 = dto.metadata!['level1'] as Record<string, unknown>;
      const level2 = level1['level2'] as Record<string, unknown>;
      expect(level2['password']).toBe('[REDACTED]');
      expect(level2['safeField']).toBe('keep-me');
    });

    it('should handle arrays within metadata objects', async () => {
      await service.log({
        action: AuditAction.GROUP_MEMBER_ADD,
        actorId: 'user-1',
        metadata: {
          members: [
            { userId: 'user-2', token: 'jwt-for-user2' },
            { userId: 'user-3', password: 'pass-for-user3' },
          ],
        },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      const members = dto.metadata!['members'] as Array<Record<string, unknown>>;
      expect(members[0]!['userId']).toBe('user-2');
      expect(members[0]!['token']).toBe('[REDACTED]');
      expect(members[1]!['userId']).toBe('user-3');
      expect(members[1]!['password']).toBe('[REDACTED]');
    });

    it('should handle empty metadata object', async () => {
      await service.log({
        action: AuditAction.USER_LOGIN,
        actorId: 'user-1',
        metadata: {},
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata).toEqual({});
    });

    it('should handle metadata with null values gracefully', async () => {
      await service.log({
        action: AuditAction.USER_LOGIN,
        actorId: 'user-1',
        metadata: { field: null, password: 'secret' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['field']).toBeNull();
      expect(dto.metadata!['password']).toBe('[REDACTED]');
    });

    it('should handle metadata with number and boolean values', async () => {
      await service.log({
        action: AuditAction.KEYS_BUNDLE_UPLOAD,
        actorId: 'user-1',
        metadata: { count: 42, active: true, label: 'safe' },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['count']).toBe(42);
      expect(dto.metadata!['active']).toBe(true);
      expect(dto.metadata!['label']).toBe('safe');
    });

    it('should handle metadata with Date values as opaque (not recursed)', async () => {
      const dateVal = new Date('2026-01-01T00:00:00.000Z');
      await service.log({
        action: AuditAction.USER_LOGIN,
        actorId: 'user-1',
        metadata: { timestamp: dateVal },
      });

      const dto = mockAuditRepository.create.mock.calls[0]![0] as CreateAuditLogDTO;
      expect(dto.metadata!['timestamp']).toEqual(dateVal);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // describe: log — ONLY uses create (R32)
  // ─────────────────────────────────────────────────────────────────────────

  describe('log — ONLY uses create (R32)', () => {
    it('should call repository.create — NOT update or delete', async () => {
      await service.log({ action: AuditAction.USER_REGISTER, actorId: 'user-1' });
      await service.log({ action: AuditAction.USER_LOGIN, actorId: 'user-2' });
      await service.log({ action: AuditAction.SESSION_REVOKE, actorId: 'user-3' });

      // create() should be called exactly 3 times
      expect(mockAuditRepository.create).toHaveBeenCalledTimes(3);

      // deleteOlderThan must NEVER be called from log()
      expect(mockAuditRepository.deleteOlderThan).not.toHaveBeenCalled();

      // findByQuery must NEVER be called from log()
      expect(mockAuditRepository.findByQuery).not.toHaveBeenCalled();

      // count must NEVER be called from log()
      expect(mockAuditRepository.count).not.toHaveBeenCalled();
    });

    it('should never call update methods (audit log is immutable)', async () => {
      // Verify that the IAuditRepository interface has no update method
      // and that log() uses only create().
      await service.log({ action: AuditAction.USER_BLOCK, actorId: 'user-1', targetId: 'user-2' });

      const callsToCreate = mockAuditRepository.create.mock.calls.length;
      expect(callsToCreate).toBe(1);

      // The mock repository only has create, findByQuery, count, deleteOlderThan
      // None except create should have been called
      expect(mockAuditRepository.findByQuery).not.toHaveBeenCalled();
      expect(mockAuditRepository.count).not.toHaveBeenCalled();
      expect(mockAuditRepository.deleteOlderThan).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // describe: query
  // ─────────────────────────────────────────────────────────────────────────

  describe('query', () => {
    it('should delegate to auditRepository.findByQuery', async () => {
      const expectedPage: AuditLogPage = {
        items: [
          defaultAuditLogEntry({ id: 'entry-1', action: AuditAction.USER_LOGIN }),
          defaultAuditLogEntry({ id: 'entry-2', action: AuditAction.USER_REGISTER }),
        ],
        cursor: 'next-cursor-token',
        hasMore: true,
      };
      mockAuditRepository.findByQuery.mockResolvedValue(expectedPage);

      const queryObj: AuditLogQuery = {
        action: AuditAction.USER_LOGIN,
        actorId: 'user-1',
        limit: 50,
      };

      const result = await service.query(queryObj);

      expect(mockAuditRepository.findByQuery).toHaveBeenCalledTimes(1);
      expect(mockAuditRepository.findByQuery).toHaveBeenCalledWith(queryObj);
      expect(result).toEqual(expectedPage);
    });

    it('should pass through empty query parameters', async () => {
      const emptyPage: AuditLogPage = { items: [], hasMore: false };
      mockAuditRepository.findByQuery.mockResolvedValue(emptyPage);

      const queryObj: AuditLogQuery = {};
      const result = await service.query(queryObj);

      expect(mockAuditRepository.findByQuery).toHaveBeenCalledWith(queryObj);
      expect(result).toEqual(emptyPage);
    });

    it('should pass through date range filters', async () => {
      const page: AuditLogPage = { items: [], hasMore: false };
      mockAuditRepository.findByQuery.mockResolvedValue(page);

      const queryObj: AuditLogQuery = {
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-03-31T23:59:59.999Z',
      };

      await service.query(queryObj);

      expect(mockAuditRepository.findByQuery).toHaveBeenCalledWith(queryObj);
    });

    it('should propagate errors from the repository', async () => {
      mockAuditRepository.findByQuery.mockRejectedValue(new Error('Query failed'));

      await expect(service.query({ limit: 10 })).rejects.toThrow('Query failed');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // describe: count
  // ─────────────────────────────────────────────────────────────────────────

  describe('count', () => {
    it('should delegate to auditRepository.count', async () => {
      mockAuditRepository.count.mockResolvedValue(42);

      const queryObj: Partial<AuditLogQuery> = { actorId: 'user-1' };
      const result = await service.count(queryObj);

      expect(mockAuditRepository.count).toHaveBeenCalledTimes(1);
      expect(mockAuditRepository.count).toHaveBeenCalledWith(queryObj);
      expect(result).toBe(42);
    });

    it('should handle count with no query parameters', async () => {
      mockAuditRepository.count.mockResolvedValue(1000);

      const result = await service.count();

      expect(mockAuditRepository.count).toHaveBeenCalledTimes(1);
      expect(result).toBe(1000);
    });

    it('should return zero when no entries match', async () => {
      mockAuditRepository.count.mockResolvedValue(0);

      const result = await service.count({ action: AuditAction.KEYS_BUNDLE_UPLOAD });

      expect(result).toBe(0);
    });

    it('should propagate errors from the repository', async () => {
      mockAuditRepository.count.mockRejectedValue(new Error('Count failed'));

      await expect(service.count()).rejects.toThrow('Count failed');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // describe: constructor — R17 (Interface-Driven Dependencies)
  // ─────────────────────────────────────────────────────────────────────────

  describe('constructor — R17 (Interface-Driven Dependencies)', () => {
    it('should accept IAuditRepository as the sole constructor dependency', () => {
      const repo = createMockAuditRepository();
      const svc = new AuditService(repo);

      // Service should be instantiated without errors
      expect(svc).toBeDefined();
      expect(svc).toBeInstanceOf(AuditService);
    });

    it('should use the injected repository for all operations', async () => {
      const repo = createMockAuditRepository();
      repo.create.mockResolvedValue(defaultAuditLogEntry());
      repo.findByQuery.mockResolvedValue({ items: [], hasMore: false });
      repo.count.mockResolvedValue(5);

      const svc = new AuditService(repo);

      await svc.log({ action: AuditAction.USER_LOGIN, actorId: 'user-1' });
      await svc.query({});
      await svc.count();

      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(repo.findByQuery).toHaveBeenCalledTimes(1);
      expect(repo.count).toHaveBeenCalledTimes(1);
    });
  });
});
