/**
 * Unit tests for KeyRepository — per R12, R16, R17.
 */
import { KeyRepository } from '../../../src/repositories/KeyRepository';

const BUNDLE_RECORD = {
  id: 'pk-1',
  userId: 'u-1',
  identityKey: JSON.stringify({ publicKey: 'ik-pub-123' }),
  signedPreKey: JSON.stringify({ keyId: 1, publicKey: 'spk-pub-123', signature: 'sig-abc' }),
  signedPreKeySignature: 'sig-abc',
  preKeys: [{ keyId: 100, publicKey: 'pk-100' }, { keyId: 101, publicKey: 'pk-101' }],
  registrationId: 42,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function mkPrisma() {
  return {
    preKeyBundle: {
      upsert: jest.fn().mockResolvedValue(BUNDLE_RECORD),
      findUnique: jest.fn().mockResolvedValue(BUNDLE_RECORD),
      update: jest.fn().mockResolvedValue(BUNDLE_RECORD),
      count: jest.fn().mockResolvedValue(1),
    },
  } as any;
}

describe('KeyRepository', () => {
  let prisma: ReturnType<typeof mkPrisma>;
  let repo: KeyRepository;

  beforeEach(() => {
    prisma = mkPrisma();
    repo = new KeyRepository(prisma);
  });

  it('upsertBundle calls prisma.preKeyBundle.upsert', async () => {
    await repo.upsertBundle('u-1', {
      identityKey: { publicKey: 'ik-pub' } as any,
      signedPreKey: { keyId: 1, publicKey: 'spk-pub', signature: 'sig' } as any,
      preKeys: [{ keyId: 100, publicKey: 'pk-100' }],
      registrationId: 42,
    });
    expect(prisma.preKeyBundle.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u-1' } }),
    );
  });

  it('findByUserId returns parsed bundle with consumed prekey', async () => {
    const result = await repo.findByUserId('u-1');
    expect(prisma.preKeyBundle.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u-1' } }),
    );
    expect(result).not.toBeNull();
    expect(result!.identityKey).toEqual({ publicKey: 'ik-pub-123' });
    expect(result!.preKey).toEqual({ keyId: 100, publicKey: 'pk-100' });
    // Should have consumed one prekey → update called with remaining
    expect(prisma.preKeyBundle.update).toHaveBeenCalled();
  });

  it('findByUserId returns null when no bundle exists', async () => {
    prisma.preKeyBundle.findUnique.mockResolvedValue(null);
    expect(await repo.findByUserId('u-missing')).toBeNull();
  });

  it('consumePreKey removes specific prekey by keyId', async () => {
    const consumed = await repo.consumePreKey('u-1', 100);
    expect(consumed).toEqual({ keyId: 100, publicKey: 'pk-100' });
    expect(prisma.preKeyBundle.update).toHaveBeenCalled();
  });

  it('consumePreKey returns null for missing bundle', async () => {
    prisma.preKeyBundle.findUnique.mockResolvedValue(null);
    expect(await repo.consumePreKey('u-missing', 100)).toBeNull();
  });

  it('consumePreKey returns null for non-existent keyId', async () => {
    expect(await repo.consumePreKey('u-1', 999)).toBeNull();
  });

  it('countRemainingPreKeys returns prekey array length', async () => {
    prisma.preKeyBundle.findUnique.mockResolvedValue({
      preKeys: [{ keyId: 100 }, { keyId: 101 }, { keyId: 102 }],
    });
    expect(await repo.countRemainingPreKeys('u-1')).toBe(3);
  });

  it('countRemainingPreKeys returns 0 when no bundle', async () => {
    prisma.preKeyBundle.findUnique.mockResolvedValue(null);
    expect(await repo.countRemainingPreKeys('u-missing')).toBe(0);
  });

  it('hasBundle uses count to check existence', async () => {
    prisma.preKeyBundle.count.mockResolvedValue(1);
    expect(await repo.hasBundle('u-1')).toBe(true);

    prisma.preKeyBundle.count.mockResolvedValue(0);
    expect(await repo.hasBundle('u-2')).toBe(false);
  });

  it('addPreKeys appends to existing prekey array', async () => {
    prisma.preKeyBundle.findUnique.mockResolvedValue({
      preKeys: [{ keyId: 100, publicKey: 'pk-100' }],
    });
    await repo.addPreKeys('u-1', [{ keyId: 200, publicKey: 'pk-200' }]);
    expect(prisma.preKeyBundle.update).toHaveBeenCalled();
  });

  it('addPreKeys throws if no bundle exists', async () => {
    prisma.preKeyBundle.findUnique.mockResolvedValue(null);
    await expect(repo.addPreKeys('u-missing', [])).rejects.toThrow(
      /No PreKey bundle found/,
    );
  });

  it('getPreKeyStatus returns count and threshold info', async () => {
    prisma.preKeyBundle.findUnique.mockResolvedValue({
      preKeys: [{ keyId: 1 }, { keyId: 2 }, { keyId: 3 }],
    });
    const status = await repo.getPreKeyStatus('u-1');
    expect(status).toEqual({
      userId: 'u-1',
      remainingPreKeys: 3,
      threshold: 10,
      needsReplenishment: true,
    });
  });

  it('getPreKeyStatus returns null when no bundle', async () => {
    prisma.preKeyBundle.findUnique.mockResolvedValue(null);
    expect(await repo.getPreKeyStatus('u-missing')).toBeNull();
  });
});
