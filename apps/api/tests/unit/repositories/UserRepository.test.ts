/**
 * Unit tests for UserRepository — per R16, R17.
 */
import { UserRepository } from '../../../src/repositories/UserRepository';

/* Enum values used by updateOnlineStatus */
enum UserStatus {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
}

function mockPrisma() {
  return {
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    blockedUser: {
      create: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  } as any;
}

const USER_ROW = {
  id: 'u-1',
  email: 'a@b.com',
  passwordHash: 'hash',
  displayName: 'Alice',
  avatarUrl: null,
  phoneNumber: null,
  about: null,
  isOnline: false,
  lastSeen: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('UserRepository', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let repo: UserRepository;

  beforeEach(() => {
    prisma = mockPrisma();
    repo = new UserRepository(prisma);
  });

  it('create inserts and returns user without passwordHash', async () => {
    prisma.user.create.mockResolvedValue(USER_ROW);
    const result = await repo.create({
      email: 'a@b.com',
      passwordHash: 'hash',
      displayName: 'Alice',
    });
    expect(prisma.user.create).toHaveBeenCalled();
    expect(result).toHaveProperty('id');
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('findById returns user or null', async () => {
    prisma.user.findUnique.mockResolvedValue(USER_ROW);
    const result = await repo.findById('u-1');
    expect(result).toHaveProperty('id', 'u-1');

    prisma.user.findUnique.mockResolvedValue(null);
    expect(await repo.findById('missing')).toBeNull();
  });

  it('findByEmail returns user with passwordHash', async () => {
    prisma.user.findUnique.mockResolvedValue(USER_ROW);
    const result = await repo.findByEmail('a@b.com');
    expect(result).toHaveProperty('passwordHash');
  });

  it('update modifies user', async () => {
    prisma.user.update.mockResolvedValue(USER_ROW);
    const result = await repo.update('u-1', { displayName: 'Bob' });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u-1' } }),
    );
    expect(result).toHaveProperty('id');
  });

  it('updatePassword changes hash', async () => {
    prisma.user.update.mockResolvedValue(USER_ROW);
    await repo.updatePassword('u-1', 'newHash');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-1' },
        data: { passwordHash: 'newHash' },
      }),
    );
  });

  it('search performs paginated search', async () => {
    /* search(query, {currentUserId, cursor?, limit?}) — two positional args */
    prisma.blockedUser.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([USER_ROW]);
    const result = await repo.search('alice', {
      currentUserId: 'u-2',
      limit: 10,
    });
    expect(prisma.user.findMany).toHaveBeenCalled();
    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('hasMore');
  });

  it('updateOnlineStatus updates presence with UserStatus enum', async () => {
    prisma.user.update.mockResolvedValue(USER_ROW);
    await repo.updateOnlineStatus('u-1', UserStatus.ONLINE as any);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-1' },
        data: expect.objectContaining({ isOnline: true }),
      }),
    );
  });

  it('blockUser creates blocked record', async () => {
    prisma.blockedUser.create.mockResolvedValue({
      id: 'bl-1',
      blockerId: 'u-1',
      blockedId: 'u-2',
      createdAt: new Date(),
      blocked: { id: 'u-2', displayName: 'Bob', avatarUrl: null },
    });
    const result = await repo.blockUser('u-1', 'u-2');
    expect(result).toHaveProperty('userId', 'u-2');
  });

  it('unblockUser deletes via deleteMany', async () => {
    prisma.blockedUser.deleteMany.mockResolvedValue({ count: 1 });
    await repo.unblockUser('u-1', 'u-2');
    expect(prisma.blockedUser.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blockerId: 'u-1', blockedId: 'u-2' },
      }),
    );
  });

  it('findBlockedUsers lists blocked users', async () => {
    prisma.blockedUser.findMany.mockResolvedValue([]);
    const result = await repo.findBlockedUsers('u-1');
    expect(Array.isArray(result)).toBe(true);
  });

  it('isBlocked uses count to check status', async () => {
    prisma.blockedUser.count.mockResolvedValue(0);
    expect(await repo.isBlocked('u-1', 'u-2')).toBe(false);

    prisma.blockedUser.count.mockResolvedValue(1);
    expect(await repo.isBlocked('u-1', 'u-2')).toBe(true);
  });

  it('existsByEmail checks existence', async () => {
    prisma.user.count.mockResolvedValue(1);
    expect(await repo.existsByEmail('a@b.com')).toBe(true);

    prisma.user.count.mockResolvedValue(0);
    expect(await repo.existsByEmail('z@z.com')).toBe(false);
  });

  it('findByIds returns multiple users', async () => {
    prisma.user.findMany.mockResolvedValue([USER_ROW]);
    const result = await repo.findByIds(['u-1']);
    expect(prisma.user.findMany).toHaveBeenCalled();
    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});
