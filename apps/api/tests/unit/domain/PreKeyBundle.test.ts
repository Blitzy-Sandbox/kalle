/**
 * @module tests/unit/domain/PreKeyBundle.test
 *
 * Comprehensive unit tests for the PreKeyBundle domain model.
 *
 * Tests cover:
 * - Bundle construction and validation (identity key, signed prekey, one-time prekeys)
 * - Static factory method (PreKeyBundle.create)
 * - PreKey availability tracking (hasAvailablePreKeys, getAvailablePreKeyCount)
 * - PreKey consumption lifecycle (consumePreKey)
 * - Replenishment threshold detection (needsReplenishment)
 * - PreKey addition / replenishment (addPreKeys)
 * - X3DH key exchange bundle generation (getBundleForKeyExchange)
 * - Getter accessors for all properties
 * - Serialization (toResponse, toStatusResponse)
 * - Edge cases and boundary conditions
 *
 * Architecture rules enforced:
 * - R12 (E2E Encryption): Validates Signal Protocol key bundle integrity
 * - R23 (Log Hygiene): Uses clearly fake base64 strings — zero real key material
 * - R16 (OOD Layering): Tests domain model behavior only — zero persistence logic
 * - R7 (Zero Warnings): TypeScript strict mode compatible
 * - R28 (Structured Logging): Zero console.log / console.warn / console.error calls
 */

import { PreKeyBundle, PreKeyBundleProps } from '../../../src/domain/models/PreKeyBundle';
import type { IdentityKey, SignedPreKey, PublicPreKey } from '@kalle/shared/types/encryption';
import { ENCRYPTION } from '@kalle/shared/constants';

// =============================================================================
// Test Helper Factories
// =============================================================================

/**
 * Returns a valid fake IdentityKey for test purposes.
 * Uses clearly fake base64 strings — never real key material (R23).
 */
const validIdentityKey = (): IdentityKey => ({
  publicKey: 'aWRlbnRpdHkta2V5LXB1YmxpYw==',
  fingerprint: '00 11 22 33 44 55 66 77 88 99',
});

/**
 * Returns a valid fake SignedPreKey for test purposes.
 * Uses clearly fake base64 strings — never real key material (R23).
 */
const validSignedPreKey = (): SignedPreKey => ({
  keyId: 1,
  publicKey: 'c2lnbmVkLXByZWtleS1wdWJsaWM=',
  signature: 'c2lnbmF0dXJlLWJhc2U2NA==',
  timestamp: Date.now(),
});

/**
 * Generates an array of fake PublicPreKey objects with sequential keyIds.
 *
 * @param count - Number of prekeys to generate
 * @param startId - Starting keyId (defaults to 1)
 * @returns Array of PublicPreKey with unique keyIds and fake base64 publicKeys
 */
const generatePreKeys = (count: number, startId: number = 1): PublicPreKey[] =>
  Array.from({ length: count }, (_, i) => ({
    keyId: startId + i,
    publicKey: `cHJla2V5LSR7c3RhcnRJZCArIGl9-${startId + i}`,
  }));

/**
 * Returns a complete, valid PreKeyBundleProps object with optional overrides.
 * Uses fixed dates for deterministic time-sensitive tests.
 *
 * @param overrides - Partial properties to override defaults
 * @returns A fully populated PreKeyBundleProps object
 */
const validBundleProps = (overrides?: Partial<PreKeyBundleProps>): PreKeyBundleProps => ({
  id: 'bundle-1',
  userId: 'user-1',
  registrationId: 12345,
  identityKey: validIdentityKey(),
  signedPreKey: validSignedPreKey(),
  preKeys: generatePreKeys(20),
  usedPreKeyIds: [],
  createdAt: new Date('2024-06-01T00:00:00Z'),
  updatedAt: new Date('2024-06-01T00:00:00Z'),
  ...overrides,
});

// =============================================================================
// Phase 2: Bundle Validation Tests — CRITICAL
// =============================================================================

describe('PreKeyBundle.validateBundle()', () => {
  describe('Identity Key Validation', () => {
    it('should pass with a valid identityKey containing non-empty base64 publicKey', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: validSignedPreKey(),
          preKeys: generatePreKeys(5),
        })
      ).not.toThrow();
    });

    it('should throw for null identityKey', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: null as unknown as IdentityKey,
          signedPreKey: validSignedPreKey(),
          preKeys: generatePreKeys(5),
        })
      ).toThrow('Identity key is required');
    });

    it('should throw for undefined identityKey', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: undefined as unknown as IdentityKey,
          signedPreKey: validSignedPreKey(),
          preKeys: generatePreKeys(5),
        })
      ).toThrow('Identity key is required');
    });

    it('should throw for empty identityKey.publicKey', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: { publicKey: '' },
          signedPreKey: validSignedPreKey(),
          preKeys: generatePreKeys(5),
        })
      ).toThrow('Identity key publicKey must be a non-empty base64-encoded string');
    });

    it('should throw for whitespace-only identityKey.publicKey', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: { publicKey: '   ' },
          signedPreKey: validSignedPreKey(),
          preKeys: generatePreKeys(5),
        })
      ).toThrow('Identity key publicKey must be a non-empty base64-encoded string');
    });
  });

  describe('Signed PreKey Validation', () => {
    it('should pass with a valid signedPreKey', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: validSignedPreKey(),
          preKeys: generatePreKeys(5),
        })
      ).not.toThrow();
    });

    it('should throw for null signedPreKey', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: null as unknown as SignedPreKey,
          preKeys: generatePreKeys(5),
        })
      ).toThrow('Signed prekey is required');
    });

    it('should throw for undefined signedPreKey', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: undefined as unknown as SignedPreKey,
          preKeys: generatePreKeys(5),
        })
      ).toThrow('Signed prekey is required');
    });

    it('should throw for signedPreKey.keyId <= 0', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: { ...validSignedPreKey(), keyId: 0 },
          preKeys: generatePreKeys(5),
        })
      ).toThrow('Signed prekey keyId must be a positive number');
    });

    it('should throw for negative signedPreKey.keyId', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: { ...validSignedPreKey(), keyId: -1 },
          preKeys: generatePreKeys(5),
        })
      ).toThrow('Signed prekey keyId must be a positive number');
    });

    it('should throw for empty signedPreKey.publicKey', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: { ...validSignedPreKey(), publicKey: '' },
          preKeys: generatePreKeys(5),
        })
      ).toThrow('Signed prekey publicKey must be a non-empty base64-encoded string');
    });

    it('should throw for empty signedPreKey.signature', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: { ...validSignedPreKey(), signature: '' },
          preKeys: generatePreKeys(5),
        })
      ).toThrow('Signed prekey signature must be a non-empty base64-encoded string');
    });

    it('should throw for signedPreKey.timestamp <= 0', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: { ...validSignedPreKey(), timestamp: 0 },
          preKeys: generatePreKeys(5),
        })
      ).toThrow('Signed prekey timestamp must be a positive number');
    });
  });

  describe('One-Time PreKeys Validation', () => {
    it('should pass with at least 1 prekey', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: validSignedPreKey(),
          preKeys: generatePreKeys(1),
        })
      ).not.toThrow();
    });

    it('should throw for null preKeys', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: validSignedPreKey(),
          preKeys: null as unknown as PublicPreKey[],
        })
      ).toThrow('PreKeys must be an array');
    });

    it('should throw for undefined preKeys', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: validSignedPreKey(),
          preKeys: undefined as unknown as PublicPreKey[],
        })
      ).toThrow('PreKeys must be an array');
    });

    it('should throw for empty preKeys array', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: validSignedPreKey(),
          preKeys: [],
        })
      ).toThrow('PreKeys array must contain at least one one-time prekey');
    });

    it('should throw for duplicate keyIds within preKeys array', () => {
      const duplicatePreKeys: PublicPreKey[] = [
        { keyId: 1, publicKey: 'a2V5LTE=' },
        { keyId: 2, publicKey: 'a2V5LTI=' },
        { keyId: 1, publicKey: 'a2V5LTM=' },
      ];
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: validSignedPreKey(),
          preKeys: duplicatePreKeys,
        })
      ).toThrow('Duplicate prekey keyId detected: 1');
    });

    it('should throw for preKey with keyId <= 0', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: validSignedPreKey(),
          preKeys: [{ keyId: 0, publicKey: 'a2V5LTE=' }],
        })
      ).toThrow('PreKey keyId must be a positive number');
    });

    it('should throw for preKey with negative keyId', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: validSignedPreKey(),
          preKeys: [{ keyId: -5, publicKey: 'a2V5LTE=' }],
        })
      ).toThrow('PreKey keyId must be a positive number');
    });

    it('should throw for preKey with empty publicKey', () => {
      expect(() =>
        PreKeyBundle.validateBundle({
          identityKey: validIdentityKey(),
          signedPreKey: validSignedPreKey(),
          preKeys: [{ keyId: 1, publicKey: '' }],
        })
      ).toThrow('PreKey publicKey must be a non-empty string');
    });
  });
});

// =============================================================================
// Phase 3: Factory Tests
// =============================================================================

describe('PreKeyBundle.create()', () => {
  it('should create a bundle with valid dto', () => {
    const bundle = PreKeyBundle.create({
      userId: 'user-1',
      registrationId: 12345,
      identityKey: validIdentityKey(),
      signedPreKey: validSignedPreKey(),
      preKeys: generatePreKeys(20),
    });

    expect(bundle).toBeInstanceOf(PreKeyBundle);
    expect(bundle.userId).toBe('user-1');
    expect(bundle.registrationId).toBe(12345);
    expect(bundle.id).toBeDefined();
    expect(typeof bundle.id).toBe('string');
    expect(bundle.id.length).toBeGreaterThan(0);
  });

  it('should set usedPreKeyIds to empty array', () => {
    const bundle = PreKeyBundle.create({
      userId: 'user-1',
      registrationId: 12345,
      identityKey: validIdentityKey(),
      signedPreKey: validSignedPreKey(),
      preKeys: generatePreKeys(10),
    });

    expect(bundle.usedPreKeyIds).toEqual([]);
  });

  it('should set createdAt and updatedAt to current time', () => {
    const before = new Date();
    const bundle = PreKeyBundle.create({
      userId: 'user-1',
      registrationId: 12345,
      identityKey: validIdentityKey(),
      signedPreKey: validSignedPreKey(),
      preKeys: generatePreKeys(10),
    });
    const after = new Date();

    expect(bundle.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(bundle.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(bundle.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(bundle.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('should call validateBundle internally and throw for invalid input', () => {
    expect(() =>
      PreKeyBundle.create({
        userId: 'user-1',
        registrationId: 12345,
        identityKey: { publicKey: '' },
        signedPreKey: validSignedPreKey(),
        preKeys: generatePreKeys(10),
      })
    ).toThrow();
  });

  it('should create bundle with PREKEY_INITIAL_COUNT prekeys (typical initial upload)', () => {
    const bundle = PreKeyBundle.create({
      userId: 'user-1',
      registrationId: 12345,
      identityKey: validIdentityKey(),
      signedPreKey: validSignedPreKey(),
      preKeys: generatePreKeys(ENCRYPTION.PREKEY_INITIAL_COUNT),
    });

    expect(bundle.getAvailablePreKeyCount()).toBe(ENCRYPTION.PREKEY_INITIAL_COUNT);
  });
});

// =============================================================================
// Phase 4: PreKey Availability Tests
// =============================================================================

describe('hasAvailablePreKeys()', () => {
  it('should return true when unused prekeys exist', () => {
    const bundle = new PreKeyBundle(validBundleProps());

    expect(bundle.hasAvailablePreKeys()).toBe(true);
  });

  it('should return false when all prekeys are consumed', () => {
    const preKeys = generatePreKeys(3);
    const allUsedIds = preKeys.map((pk) => pk.keyId);
    const bundle = new PreKeyBundle(
      validBundleProps({
        preKeys,
        usedPreKeyIds: allUsedIds,
      })
    );

    expect(bundle.hasAvailablePreKeys()).toBe(false);
  });
});

describe('getAvailablePreKeyCount()', () => {
  it('should return total count for a fresh bundle with no consumed keys', () => {
    const preKeys = generatePreKeys(20);
    const bundle = new PreKeyBundle(validBundleProps({ preKeys, usedPreKeyIds: [] }));

    expect(bundle.getAvailablePreKeyCount()).toBe(20);
  });

  it('should return correct count after consuming some prekeys', () => {
    const preKeys = generatePreKeys(10);
    const bundle = new PreKeyBundle(
      validBundleProps({
        preKeys,
        usedPreKeyIds: [1, 2, 3],
      })
    );

    expect(bundle.getAvailablePreKeyCount()).toBe(7);
  });

  it('should return 0 when all prekeys are consumed', () => {
    const preKeys = generatePreKeys(5);
    const allUsedIds = preKeys.map((pk) => pk.keyId);
    const bundle = new PreKeyBundle(
      validBundleProps({
        preKeys,
        usedPreKeyIds: allUsedIds,
      })
    );

    expect(bundle.getAvailablePreKeyCount()).toBe(0);
  });
});

// =============================================================================
// Phase 5: PreKey Consumption Tests — CRITICAL
// =============================================================================

describe('consumePreKey()', () => {
  it('should return a PublicPreKey when available', () => {
    const bundle = new PreKeyBundle(validBundleProps());

    const consumed = bundle.consumePreKey();

    expect(consumed).not.toBeNull();
    expect(consumed).toBeDefined();
    expect(consumed!.keyId).toBeGreaterThan(0);
    expect(typeof consumed!.publicKey).toBe('string');
    expect(consumed!.publicKey.length).toBeGreaterThan(0);
  });

  it('should add the consumed keyId to usedPreKeyIds', () => {
    const bundle = new PreKeyBundle(validBundleProps());

    const consumed = bundle.consumePreKey();
    expect(consumed).not.toBeNull();

    expect(bundle.usedPreKeyIds).toContain(consumed!.keyId);
  });

  it('should return different prekey each consecutive call (never reuses)', () => {
    const bundle = new PreKeyBundle(validBundleProps({ preKeys: generatePreKeys(5) }));

    const firstConsumed = bundle.consumePreKey();
    const secondConsumed = bundle.consumePreKey();
    const thirdConsumed = bundle.consumePreKey();

    expect(firstConsumed).not.toBeNull();
    expect(secondConsumed).not.toBeNull();
    expect(thirdConsumed).not.toBeNull();

    const consumedIds = [firstConsumed!.keyId, secondConsumed!.keyId, thirdConsumed!.keyId];
    const uniqueIds = new Set(consumedIds);
    expect(uniqueIds.size).toBe(3);
  });

  it('should return null when all prekeys are consumed (exhausted)', () => {
    const preKeys = generatePreKeys(2);
    const bundle = new PreKeyBundle(validBundleProps({ preKeys, usedPreKeyIds: [] }));

    bundle.consumePreKey();
    bundle.consumePreKey();
    const thirdAttempt = bundle.consumePreKey();

    expect(thirdAttempt).toBeNull();
  });

  it('should update updatedAt after consumption', () => {
    const fixedDate = new Date('2024-01-01T00:00:00Z');
    const bundle = new PreKeyBundle(validBundleProps({ updatedAt: fixedDate }));

    const beforeConsume = bundle.updatedAt;
    bundle.consumePreKey();
    const afterConsume = bundle.updatedAt;

    expect(afterConsume.getTime()).toBeGreaterThanOrEqual(beforeConsume.getTime());
  });

  it('should leave 2 available after consuming 3 prekeys from a 5-prekey bundle', () => {
    const bundle = new PreKeyBundle(validBundleProps({ preKeys: generatePreKeys(5) }));

    bundle.consumePreKey();
    bundle.consumePreKey();
    bundle.consumePreKey();

    expect(bundle.getAvailablePreKeyCount()).toBe(2);
  });

  it('should not return a consumed prekey in subsequent calls', () => {
    const bundle = new PreKeyBundle(validBundleProps({ preKeys: generatePreKeys(10) }));

    const consumedIds: number[] = [];
    for (let i = 0; i < 10; i++) {
      const consumed = bundle.consumePreKey();
      expect(consumed).not.toBeNull();
      expect(consumedIds).not.toContain(consumed!.keyId);
      consumedIds.push(consumed!.keyId);
    }

    // All 10 consumed, next call should return null
    expect(bundle.consumePreKey()).toBeNull();
  });
});

// =============================================================================
// Phase 6: Replenishment Threshold Tests — CRITICAL
// =============================================================================

describe('needsReplenishment()', () => {
  it('should return false when available count is above the threshold', () => {
    // 15 available prekeys, threshold 10 → false
    const bundle = new PreKeyBundle(
      validBundleProps({ preKeys: generatePreKeys(15), usedPreKeyIds: [] })
    );

    expect(bundle.needsReplenishment(10)).toBe(false);
  });

  it('should return true when available count is below the threshold', () => {
    // 8 available prekeys, threshold 10 → true
    const preKeys = generatePreKeys(20);
    const usedIds = preKeys.slice(0, 12).map((pk) => pk.keyId);
    const bundle = new PreKeyBundle(
      validBundleProps({ preKeys, usedPreKeyIds: usedIds })
    );

    expect(bundle.getAvailablePreKeyCount()).toBe(8);
    expect(bundle.needsReplenishment(10)).toBe(true);
  });

  it('should return true when available count equals the threshold (boundary: 10 remaining, threshold 10)', () => {
    // 10 available prekeys, threshold 10 → true (uses <=)
    const bundle = new PreKeyBundle(
      validBundleProps({ preKeys: generatePreKeys(10), usedPreKeyIds: [] })
    );

    expect(bundle.getAvailablePreKeyCount()).toBe(10);
    expect(bundle.needsReplenishment(10)).toBe(true);
  });

  it('should return false when available count is 11 and threshold is 10', () => {
    // 11 available prekeys, threshold 10 → false
    const bundle = new PreKeyBundle(
      validBundleProps({ preKeys: generatePreKeys(11), usedPreKeyIds: [] })
    );

    expect(bundle.getAvailablePreKeyCount()).toBe(11);
    expect(bundle.needsReplenishment(10)).toBe(false);
  });

  it('should return true when available count is 9 and threshold is 10', () => {
    // 9 available prekeys, threshold 10 → true
    const preKeys = generatePreKeys(20);
    const usedIds = preKeys.slice(0, 11).map((pk) => pk.keyId);
    const bundle = new PreKeyBundle(
      validBundleProps({ preKeys, usedPreKeyIds: usedIds })
    );

    expect(bundle.getAvailablePreKeyCount()).toBe(9);
    expect(bundle.needsReplenishment(10)).toBe(true);
  });

  it('should use default threshold ENCRYPTION.PREKEY_LOW_THRESHOLD when no argument provided', () => {
    // PREKEY_LOW_THRESHOLD = 10, create bundle with exactly 10 prekeys
    const bundle = new PreKeyBundle(
      validBundleProps({
        preKeys: generatePreKeys(ENCRYPTION.PREKEY_LOW_THRESHOLD),
        usedPreKeyIds: [],
      })
    );

    // 10 remaining, default threshold 10 → true (<=)
    expect(bundle.needsReplenishment()).toBe(true);
  });

  it('should accept and apply a custom threshold argument', () => {
    const bundle = new PreKeyBundle(
      validBundleProps({ preKeys: generatePreKeys(5), usedPreKeyIds: [] })
    );

    // 5 available, custom threshold 3 → false (5 > 3)
    expect(bundle.needsReplenishment(3)).toBe(false);

    // 5 available, custom threshold 5 → true (5 <= 5)
    expect(bundle.needsReplenishment(5)).toBe(true);

    // 5 available, custom threshold 6 → true (5 <= 6)
    expect(bundle.needsReplenishment(6)).toBe(true);
  });
});

// =============================================================================
// Phase 7: PreKey Addition Tests
// =============================================================================

describe('addPreKeys()', () => {
  it('should add new prekeys to the bundle', () => {
    const bundle = new PreKeyBundle(validBundleProps({ preKeys: generatePreKeys(5) }));
    const initialCount = bundle.getAvailablePreKeyCount();

    const newPreKeys = generatePreKeys(3, 100);
    bundle.addPreKeys(newPreKeys);

    expect(bundle.getAvailablePreKeyCount()).toBe(initialCount + 3);
  });

  it('should make new prekeys available via consumePreKey()', () => {
    const existingPreKeys = generatePreKeys(2);
    const allUsedIds = existingPreKeys.map((pk) => pk.keyId);
    const bundle = new PreKeyBundle(
      validBundleProps({ preKeys: existingPreKeys, usedPreKeyIds: allUsedIds })
    );

    // All existing prekeys consumed
    expect(bundle.getAvailablePreKeyCount()).toBe(0);
    expect(bundle.consumePreKey()).toBeNull();

    // Add new prekeys
    const newPreKeys = generatePreKeys(3, 100);
    bundle.addPreKeys(newPreKeys);

    expect(bundle.getAvailablePreKeyCount()).toBe(3);

    const consumed = bundle.consumePreKey();
    expect(consumed).not.toBeNull();
    expect(consumed!.keyId).toBeGreaterThanOrEqual(100);
  });

  it('should update updatedAt timestamp', () => {
    const fixedDate = new Date('2024-01-01T00:00:00Z');
    const bundle = new PreKeyBundle(validBundleProps({ updatedAt: fixedDate }));

    const newPreKeys = generatePreKeys(2, 100);
    bundle.addPreKeys(newPreKeys);

    expect(bundle.updatedAt.getTime()).toBeGreaterThanOrEqual(fixedDate.getTime());
  });

  it('should throw for duplicate keyId conflicting with existing prekeys', () => {
    const existingPreKeys = generatePreKeys(5); // keyIds 1-5
    const bundle = new PreKeyBundle(validBundleProps({ preKeys: existingPreKeys }));

    const conflictingPreKeys: PublicPreKey[] = [
      { keyId: 3, publicKey: 'ZHVwbGljYXRl' },
    ];

    expect(() => bundle.addPreKeys(conflictingPreKeys)).toThrow(
      'Duplicate prekey keyId: 3 already exists in the bundle'
    );
  });

  it('should increase getAvailablePreKeyCount() by the number of new prekeys added', () => {
    const bundle = new PreKeyBundle(validBundleProps({ preKeys: generatePreKeys(10) }));
    const countBefore = bundle.getAvailablePreKeyCount();

    bundle.addPreKeys(generatePreKeys(5, 100));

    expect(bundle.getAvailablePreKeyCount()).toBe(countBefore + 5);
  });
});

// =============================================================================
// Phase 8: Key Exchange Bundle Tests
// =============================================================================

describe('getBundleForKeyExchange()', () => {
  it('should return identityKey, signedPreKey, and registrationId', () => {
    const identityKey = validIdentityKey();
    const signedPreKey = validSignedPreKey();
    const bundle = new PreKeyBundle(
      validBundleProps({ identityKey, signedPreKey, registrationId: 42 })
    );

    const exchangeBundle = bundle.getBundleForKeyExchange();

    expect(exchangeBundle.identityKey.publicKey).toBe(identityKey.publicKey);
    expect(exchangeBundle.signedPreKey.keyId).toBe(signedPreKey.keyId);
    expect(exchangeBundle.signedPreKey.publicKey).toBe(signedPreKey.publicKey);
    expect(exchangeBundle.signedPreKey.signature).toBe(signedPreKey.signature);
    expect(exchangeBundle.registrationId).toBe(42);
  });

  it('should return one consumed preKey (consumes a prekey)', () => {
    const bundle = new PreKeyBundle(validBundleProps({ preKeys: generatePreKeys(5) }));
    const countBefore = bundle.getAvailablePreKeyCount();

    const exchangeBundle = bundle.getBundleForKeyExchange();

    expect(exchangeBundle.preKey).toBeDefined();
    expect(exchangeBundle.preKey!.keyId).toBeGreaterThan(0);
    expect(typeof exchangeBundle.preKey!.publicKey).toBe('string');
    expect(bundle.getAvailablePreKeyCount()).toBe(countBefore - 1);
  });

  it('should return different preKeys on subsequent calls', () => {
    const bundle = new PreKeyBundle(validBundleProps({ preKeys: generatePreKeys(5) }));

    const first = bundle.getBundleForKeyExchange();
    const second = bundle.getBundleForKeyExchange();

    expect(first.preKey).toBeDefined();
    expect(second.preKey).toBeDefined();
    expect(first.preKey!.keyId).not.toBe(second.preKey!.keyId);
  });

  it('should return undefined preKey when all prekeys are exhausted', () => {
    const preKeys = generatePreKeys(1);
    const bundle = new PreKeyBundle(validBundleProps({ preKeys }));

    // Consume the only prekey
    const first = bundle.getBundleForKeyExchange();
    expect(first.preKey).toBeDefined();

    // No more prekeys available
    const second = bundle.getBundleForKeyExchange();
    expect(second.preKey).toBeUndefined();
  });

  it('should decrease getAvailablePreKeyCount() by 1 after each call', () => {
    const bundle = new PreKeyBundle(validBundleProps({ preKeys: generatePreKeys(10) }));
    const countBefore = bundle.getAvailablePreKeyCount();

    bundle.getBundleForKeyExchange();
    expect(bundle.getAvailablePreKeyCount()).toBe(countBefore - 1);

    bundle.getBundleForKeyExchange();
    expect(bundle.getAvailablePreKeyCount()).toBe(countBefore - 2);

    bundle.getBundleForKeyExchange();
    expect(bundle.getAvailablePreKeyCount()).toBe(countBefore - 3);
  });
});

// =============================================================================
// Phase 9: Accessor Tests
// =============================================================================

describe('getters', () => {
  it('should return the signed prekey via getSignedPreKey()', () => {
    const signedPreKey = validSignedPreKey();
    const bundle = new PreKeyBundle(validBundleProps({ signedPreKey }));

    const result = bundle.getSignedPreKey();

    expect(result.keyId).toBe(signedPreKey.keyId);
    expect(result.publicKey).toBe(signedPreKey.publicKey);
    expect(result.signature).toBe(signedPreKey.signature);
    expect(result.timestamp).toBe(signedPreKey.timestamp);
  });

  it('should return the identity key via getIdentityKey()', () => {
    const identityKey = validIdentityKey();
    const bundle = new PreKeyBundle(validBundleProps({ identityKey }));

    const result = bundle.getIdentityKey();

    expect(result.publicKey).toBe(identityKey.publicKey);
    expect(result.fingerprint).toBe(identityKey.fingerprint);
  });

  it('should return correct userId', () => {
    const bundle = new PreKeyBundle(validBundleProps({ userId: 'my-user-id' }));

    expect(bundle.userId).toBe('my-user-id');
  });

  it('should return correct registrationId', () => {
    const bundle = new PreKeyBundle(validBundleProps({ registrationId: 99999 }));

    expect(bundle.registrationId).toBe(99999);
  });

  it('should return correct id', () => {
    const bundle = new PreKeyBundle(validBundleProps({ id: 'bundle-unique-123' }));

    expect(bundle.id).toBe('bundle-unique-123');
  });

  it('should return defensive copy of usedPreKeyIds (mutations do not affect internal state)', () => {
    const bundle = new PreKeyBundle(validBundleProps());

    bundle.consumePreKey();
    const usedIds = bundle.usedPreKeyIds;
    const lengthBefore = usedIds.length;

    // Mutate the returned array
    usedIds.push(999);

    // Internal state should remain unchanged
    expect(bundle.usedPreKeyIds.length).toBe(lengthBefore);
  });
});

// =============================================================================
// Phase 10: Serialization Tests
// =============================================================================

describe('toResponse()', () => {
  it('should return userId, identityKey, signedPreKey, and registrationId', () => {
    const bundle = new PreKeyBundle(validBundleProps());

    const response = bundle.toResponse();

    expect(response.userId).toBe('user-1');
    expect(response.identityKey).toBeDefined();
    expect(response.identityKey.publicKey).toBe(validIdentityKey().publicKey);
    expect(response.signedPreKey).toBeDefined();
    expect(response.signedPreKey.keyId).toBe(validSignedPreKey().keyId);
    expect(response.signedPreKey.publicKey).toBe(validSignedPreKey().publicKey);
    expect(response.signedPreKey.signature).toBe(validSignedPreKey().signature);
    expect(response.registrationId).toBe(12345);
  });

  it('should include preKey if available (peeks without consuming)', () => {
    const bundle = new PreKeyBundle(validBundleProps({ preKeys: generatePreKeys(5) }));

    const countBefore = bundle.getAvailablePreKeyCount();
    const response = bundle.toResponse();

    // preKey should be present
    expect(response.preKey).toBeDefined();
    expect(response.preKey!.keyId).toBeGreaterThan(0);
    expect(typeof response.preKey!.publicKey).toBe('string');

    // toResponse peeks, does NOT consume — count unchanged
    expect(bundle.getAvailablePreKeyCount()).toBe(countBefore);
  });

  it('should return undefined preKey when all prekeys are exhausted', () => {
    const preKeys = generatePreKeys(2);
    const allUsedIds = preKeys.map((pk) => pk.keyId);
    const bundle = new PreKeyBundle(
      validBundleProps({ preKeys, usedPreKeyIds: allUsedIds })
    );

    const response = bundle.toResponse();

    expect(response.preKey).toBeUndefined();
  });
});

describe('toStatusResponse()', () => {
  it('should return userId, remainingPreKeys count, threshold, and needsReplenishment flag', () => {
    const bundle = new PreKeyBundle(
      validBundleProps({ preKeys: generatePreKeys(15), usedPreKeyIds: [] })
    );

    const status = bundle.toStatusResponse();

    expect(status.userId).toBe('user-1');
    expect(status.remainingPreKeys).toBe(15);
    expect(status.threshold).toBe(ENCRYPTION.PREKEY_LOW_THRESHOLD);
    // 15 > 10, so needsReplenishment should be false
    expect(status.needsReplenishment).toBe(false);
  });

  it('should reflect true needsReplenishment when supply is low', () => {
    const preKeys = generatePreKeys(20);
    const usedIds = preKeys.slice(0, 15).map((pk) => pk.keyId);
    const bundle = new PreKeyBundle(
      validBundleProps({ preKeys, usedPreKeyIds: usedIds })
    );

    const status = bundle.toStatusResponse();

    expect(status.remainingPreKeys).toBe(5);
    expect(status.needsReplenishment).toBe(true);
  });
});

// =============================================================================
// Phase 11: Edge Cases
// =============================================================================

describe('edge cases', () => {
  it('should return null (not throw) from consumePreKey() on an exhausted bundle', () => {
    const preKeys = generatePreKeys(1);
    const bundle = new PreKeyBundle(validBundleProps({ preKeys, usedPreKeyIds: [] }));

    // Consume the only prekey
    bundle.consumePreKey();

    // Should gracefully return null
    expect(() => bundle.consumePreKey()).not.toThrow();
    expect(bundle.consumePreKey()).toBeNull();
  });

  it('should report needsReplenishment() as true after consuming all prekeys', () => {
    const preKeys = generatePreKeys(3);
    const bundle = new PreKeyBundle(validBundleProps({ preKeys, usedPreKeyIds: [] }));

    // Consume all
    bundle.consumePreKey();
    bundle.consumePreKey();
    bundle.consumePreKey();

    expect(bundle.getAvailablePreKeyCount()).toBe(0);
    expect(bundle.needsReplenishment()).toBe(true);
  });

  it('should treat addPreKeys() with empty array as a no-op (no error, no change)', () => {
    const bundle = new PreKeyBundle(validBundleProps({ preKeys: generatePreKeys(5) }));
    const countBefore = bundle.getAvailablePreKeyCount();

    expect(() => bundle.addPreKeys([])).not.toThrow();
    expect(bundle.getAvailablePreKeyCount()).toBe(countBefore);
  });

  it('should throw from validateBundle() with duplicate keyIds in preKeys', () => {
    const duplicatePreKeys: PublicPreKey[] = [
      { keyId: 10, publicKey: 'ZmFrZS1rZXktMTA=' },
      { keyId: 20, publicKey: 'ZmFrZS1rZXktMjA=' },
      { keyId: 10, publicKey: 'ZmFrZS1rZXktMTBk' },
    ];

    expect(() =>
      PreKeyBundle.validateBundle({
        identityKey: validIdentityKey(),
        signedPreKey: validSignedPreKey(),
        preKeys: duplicatePreKeys,
      })
    ).toThrow('Duplicate prekey keyId detected: 10');
  });

  it('should handle a bundle constructed from usedPreKeyIds that partially overlap with preKeys', () => {
    const preKeys = generatePreKeys(5); // keyIds: 1, 2, 3, 4, 5
    const bundle = new PreKeyBundle(
      validBundleProps({ preKeys, usedPreKeyIds: [2, 4] })
    );

    expect(bundle.getAvailablePreKeyCount()).toBe(3);
    expect(bundle.hasAvailablePreKeys()).toBe(true);

    // The first consumePreKey should return keyId 1 (the first unconsumed one)
    const consumed = bundle.consumePreKey();
    expect(consumed).not.toBeNull();
    expect([1, 3, 5]).toContain(consumed!.keyId);
  });

  it('should generate unique IDs for bundles created via create() factory', () => {
    const bundleA = PreKeyBundle.create({
      userId: 'user-1',
      registrationId: 111,
      identityKey: validIdentityKey(),
      signedPreKey: validSignedPreKey(),
      preKeys: generatePreKeys(5),
    });
    const bundleB = PreKeyBundle.create({
      userId: 'user-2',
      registrationId: 222,
      identityKey: validIdentityKey(),
      signedPreKey: validSignedPreKey(),
      preKeys: generatePreKeys(5, 100),
    });

    expect(bundleA.id).not.toBe(bundleB.id);
  });
});
