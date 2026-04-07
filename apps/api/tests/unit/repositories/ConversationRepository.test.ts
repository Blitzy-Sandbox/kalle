/**
 * Unit tests for ConversationRepository — per R16, R17.
 */
import { ConversationRepository } from '../../../src/repositories/ConversationRepository';

const CONV_ROW = {
  id: 'c-1',
  type: 'DIRECT',
  title: null,
  avatarUrl: null,
  createdBy: 'u-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  participants: [
    {
      id: 'cp-1',
      userId: 'u-1',
      conversationId: 'c-1',
      role: 'MEMBER',
      isArchived: false,
      isMuted: false,
      mutedUntil: null,
      unreadCount: 0,
      lastReadAt: null,
      joinedAt: new Date(),
      user: { id: 'u-1', displayName: 'Alice', avatarUrl: null, isOnline: false, lastSeen: null },
    },
  ],
  _count: { messages: 3 },
  messages: [],
};

function mockPrisma() {
  return {
    conversation: {
      create: jest.fn().mockResolvedValue(CONV_ROW),
      findUnique: jest.fn().mockResolvedValue(CONV_ROW),
      findMany: jest.fn().mockResolvedValue([CONV_ROW]),
      update: jest.fn().mockResolvedValue(CONV_ROW),
    },
    conversationParticipant: {
      create: jest.fn().mockResolvedValue({ id: 'cp-2', userId: 'u-2', role: 'MEMBER' }),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ id: 'cp-1' }),
      findMany: jest.fn().mockResolvedValue([{ userId: 'u-1', conversationId: 'c-1', lastReadAt: null }]),
      count: jest.fn().mockResolvedValue(1),
    },
    message: {
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn((cb: any) => {
      if (typeof cb === 'function') return cb(mockPrisma());
      return Promise.all(cb);
    }),
  } as any;
}

describe('ConversationRepository', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let repo: ConversationRepository;

  beforeEach(() => {
    prisma = mockPrisma();
    repo = new ConversationRepository(prisma);
  });

  it('create inserts conversation with participants', async () => {
    const result = await repo.create({
      type: 'DIRECT',
      participants: [
        { userId: 'u-1', role: 'ADMIN' as any },
        { userId: 'u-2', role: 'MEMBER' as any },
      ],
    });
    expect(prisma.conversation.create).toHaveBeenCalled();
    expect(result).toHaveProperty('id');
  });

  it('findById returns conversation or null', async () => {
    const result = await repo.findById('c-1');
    expect(result).toHaveProperty('id');

    prisma.conversation.findUnique.mockResolvedValue(null);
    expect(await repo.findById('missing')).toBeNull();
  });

  it('findByUserId returns paginated conversations', async () => {
    const result = await repo.findByUserId('u-1', {});
    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('hasMore');
  });

  it('addParticipant creates participation record', async () => {
    const result = await repo.addParticipant('c-1', 'u-2', 'MEMBER' as any);
    expect(prisma.conversationParticipant.create).toHaveBeenCalled();
  });

  it('removeParticipant deletes record via deleteMany', async () => {
    await repo.removeParticipant('c-1', 'u-2');
    expect(prisma.conversationParticipant.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: 'c-1', userId: 'u-2' },
      }),
    );
  });

  it('getParticipantIds returns user IDs', async () => {
    prisma.conversationParticipant.findMany.mockResolvedValue([
      { userId: 'u-1' },
      { userId: 'u-2' },
    ]);
    const ids = await repo.getParticipantIds('c-1');
    expect(ids).toEqual(['u-1', 'u-2']);
  });

  it('isParticipant uses count to check membership', async () => {
    prisma.conversationParticipant.count.mockResolvedValue(1);
    expect(await repo.isParticipant('c-1', 'u-1')).toBe(true);

    prisma.conversationParticipant.count.mockResolvedValue(0);
    expect(await repo.isParticipant('c-1', 'u-3')).toBe(false);
  });

  it('resetUnreadCount sets count to zero', async () => {
    await repo.resetUnreadCount('c-1', 'u-1');
    expect(prisma.conversationParticipant.updateMany).toHaveBeenCalled();
  });

  it('updateGroupDetails updates group fields', async () => {
    await repo.updateGroupDetails('c-1', { groupName: 'Team' });
    expect(prisma.conversation.update).toHaveBeenCalled();
  });
});
