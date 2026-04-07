/**
 * Unit tests for MessageRepository — per R16, R17.
 */
import { MessageRepository } from '../../../src/repositories/MessageRepository';

/* Shared fake record that Prisma methods return */
const MSG_RECORD = {
  id: 'm-1',
  conversationId: 'c-1',
  senderId: 'u-1',
  clientMessageId: 'cm-1',
  ciphertext: 'encrypted-payload',
  type: 'TEXT',
  replyToId: null,
  isEdited: false,
  isDeleted: false,
  editedAt: null,
  deletedAt: null,
  linkPreview: null,
  serverTimestamp: new Date('2024-01-01T10:00:00Z'),
  clientTimestamp: null,
  sender: { id: 'u-1', displayName: 'Alice', avatarUrl: null },
  replyTo: null,
  statuses: [],
  media: [],
};

function mkPrisma() {
  return {
    message: {
      create: jest.fn().mockResolvedValue(MSG_RECORD),
      findUnique: jest.fn().mockResolvedValue(MSG_RECORD),
      findFirst: jest.fn().mockResolvedValue(MSG_RECORD),
      findMany: jest.fn().mockResolvedValue([MSG_RECORD]),
      update: jest.fn().mockResolvedValue(MSG_RECORD),
    },
    messageStatus: {
      upsert: jest.fn().mockResolvedValue({
        messageId: 'm-1',
        userId: 'u-2',
        status: 'DELIVERED',
        deliveredAt: new Date(),
        readAt: null,
      }),
    },
    $transaction: jest.fn((ops: any) => {
      if (typeof ops === 'function') return ops(mkPrisma());
      return Promise.all(ops);
    }),
  } as any;
}

describe('MessageRepository', () => {
  let prisma: ReturnType<typeof mkPrisma>;
  let repo: MessageRepository;

  beforeEach(() => {
    prisma = mkPrisma();
    repo = new MessageRepository(prisma);
  });

  it('create persists message and returns response', async () => {
    const result = await repo.create({
      conversationId: 'c-1',
      senderId: 'u-1',
      ciphertext: 'encrypted',
      type: 'TEXT' as any,
      clientMessageId: 'cm-1',
    });
    expect(prisma.message.create).toHaveBeenCalled();
    expect(result).toHaveProperty('id', 'm-1');
  });

  it('findById returns mapped response', async () => {
    const result = await repo.findById('m-1');
    expect(prisma.message.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm-1' } }),
    );
    expect(result).toHaveProperty('id', 'm-1');
  });

  it('findById returns null for missing message', async () => {
    prisma.message.findUnique.mockResolvedValue(null);
    expect(await repo.findById('missing')).toBeNull();
  });

  it('update swaps ciphertext (R19)', async () => {
    const result = await repo.update('m-1', {
      ciphertext: 'new-cipher',
      isEdited: true,
      editedAt: new Date(),
    });
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm-1' } }),
    );
    expect(result).toBeDefined();
  });

  it('softDelete nulls ciphertext (R20)', async () => {
    prisma.message.update.mockResolvedValue({
      ...MSG_RECORD,
      ciphertext: null,
      isDeleted: true,
      deletedAt: new Date(),
    });
    const result = await repo.softDelete('m-1', {
      ciphertext: null,
      isDeleted: true,
      deletedAt: new Date(),
    });
    expect(prisma.message.update).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('findByConversation returns paginated messages', async () => {
    const result = await repo.findByConversation({
      conversationId: 'c-1',
      limit: 10,
    });
    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('hasMore');
    expect(prisma.message.findMany).toHaveBeenCalled();
  });

  it('findAfterTimestamp returns messages for sync (R13)', async () => {
    const results = await repo.findAfterTimestamp(
      ['c-1', 'c-2'],
      new Date('2024-01-01'),
      100,
    );
    expect(prisma.message.findMany).toHaveBeenCalled();
    expect(Array.isArray(results)).toBe(true);
  });

  it('findAfterTimestamp returns empty for no conversation IDs', async () => {
    const results = await repo.findAfterTimestamp([], new Date(), 10);
    expect(results).toEqual([]);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('findByClientMessageId de-duplicates messages', async () => {
    const result = await repo.findByClientMessageId('cm-1');
    expect(prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientMessageId: 'cm-1' } }),
    );
    expect(result).toHaveProperty('id');
  });

  it('updateStatus upserts per-recipient status', async () => {
    const result = await repo.updateStatus('m-1', 'u-2', 'DELIVERED' as any);
    expect(prisma.messageStatus.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId_userId: { messageId: 'm-1', userId: 'u-2' } },
      }),
    );
    expect(result).toHaveProperty('messageId');
    expect(result).toHaveProperty('userId');
    expect(result).toHaveProperty('status');
  });

  it('setLinkPreview attaches OG metadata', async () => {
    const preview = { url: 'https://example.com', title: 'Example' };
    const result = await repo.setLinkPreview('m-1', preview as any);
    expect(prisma.message.update).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('batchUpdateStatus handles empty array', async () => {
    await repo.batchUpdateStatus([], 'u-1', 'READ' as any);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
