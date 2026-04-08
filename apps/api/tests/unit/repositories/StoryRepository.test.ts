/**
 * Unit tests for StoryRepository — per R11, R16, R17, R35.
 */
import { StoryRepository } from '../../../src/repositories/StoryRepository';

const FUTURE = new Date(Date.now() + 86_400_000); // 24h from now
const PAST = new Date(Date.now() - 1000); // expired

const STORY_RECORD = {
  id: 's-1',
  authorId: 'u-1',
  type: 'TEXT',
  textContent: 'Hello story',
  backgroundColor: '#FF6B6B',
  fontStyle: 'sans-serif',
  duration: 5,
  expiresAt: FUTURE,
  createdAt: new Date(),
  updatedAt: new Date(),
  author: { id: 'u-1', displayName: 'Alice', avatarUrl: null },
  media: [],
  _count: { views: 3 },
  views: [],
};

function mkPrisma() {
  return {
    story: {
      create: jest.fn().mockResolvedValue(STORY_RECORD),
      findUnique: jest.fn().mockResolvedValue(STORY_RECORD),
      findMany: jest.fn().mockResolvedValue([STORY_RECORD]),
      delete: jest.fn().mockResolvedValue(STORY_RECORD),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
    },
    storyView: {
      findUnique: jest.fn().mockResolvedValue(null), // default: not yet viewed
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({
        id: 'sv-1',
        storyId: 's-1',
        viewerId: 'u-2',
        viewedAt: new Date(),
        viewer: { id: 'u-2', displayName: 'Bob', avatarUrl: null },
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  } as any;
}

describe('StoryRepository', () => {
  let prisma: ReturnType<typeof mkPrisma>;
  let repo: StoryRepository;

  beforeEach(() => {
    prisma = mkPrisma();
    repo = new StoryRepository(prisma);
  });

  it('create persists a story', async () => {
    const result = await repo.create({
      authorId: 'u-1',
      type: 'TEXT' as any,
      content: 'Hello',
      expiresAt: FUTURE,
      duration: 5,
    });
    expect(prisma.story.create).toHaveBeenCalled();
    expect(result).toHaveProperty('id', 's-1');
    expect(result).toHaveProperty('authorName', 'Alice');
  });

  it('findById returns mapped response', async () => {
    const result = await repo.findById('s-1');
    expect(result).toHaveProperty('id', 's-1');
    expect(result).toHaveProperty('content', 'Hello story');
  });

  it('findById returns null for missing story', async () => {
    prisma.story.findUnique.mockResolvedValue(null);
    expect(await repo.findById('missing')).toBeNull();
  });

  it('findFeed returns grouped feed items', async () => {
    prisma.story.findMany.mockResolvedValue([
      { ...STORY_RECORD, views: [] },
    ]);
    const feed = await repo.findFeed('u-2', ['u-1']);
    expect(prisma.story.findMany).toHaveBeenCalled();
    expect(Array.isArray(feed)).toBe(true);
    if (feed.length > 0) {
      expect(feed[0]).toHaveProperty('userId', 'u-1');
      expect(feed[0]).toHaveProperty('stories');
    }
  });

  it('findFeed returns empty for no contacts', async () => {
    const feed = await repo.findFeed('u-2', []);
    expect(feed).toEqual([]);
    expect(prisma.story.findMany).not.toHaveBeenCalled();
  });

  it('findByAuthor returns active stories', async () => {
    const result = await repo.findByAuthor('u-1');
    expect(prisma.story.findMany).toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(true);
  });

  it('addView creates view record (first view)', async () => {
    const view = await repo.addView('s-1', 'u-2');
    expect(prisma.storyView.findUnique).toHaveBeenCalled();
    expect(prisma.storyView.create).toHaveBeenCalled();
    expect(view).toHaveProperty('viewerId', 'u-2');
  });

  it('addView returns null for duplicate view', async () => {
    prisma.storyView.findUnique.mockResolvedValue({ id: 'existing' });
    const view = await repo.addView('s-1', 'u-2');
    expect(view).toBeNull();
    expect(prisma.storyView.create).not.toHaveBeenCalled();
  });

  it('getViews returns viewer list', async () => {
    prisma.storyView.findMany.mockResolvedValue([
      {
        id: 'sv-1',
        storyId: 's-1',
        viewerId: 'u-2',
        viewedAt: new Date(),
        viewer: { id: 'u-2', displayName: 'Bob', avatarUrl: null },
      },
    ]);
    const views = await repo.getViews('s-1');
    expect(Array.isArray(views)).toBe(true);
    expect(views[0]).toHaveProperty('viewerName', 'Bob');
  });

  it('findExpired returns expired story IDs and media URLs', async () => {
    prisma.story.findMany.mockResolvedValue([
      { id: 's-old', media: [{ encryptedUrl: '/media/x.jpg', thumbnailUrl: '/thumb/x.jpg' }] },
    ]);
    const expired = await repo.findExpired(new Date());
    expect(expired[0]).toHaveProperty('id', 's-old');
    expect(expired[0]).toHaveProperty('mediaUrl', '/media/x.jpg');
  });

  it('deleteExpired removes stories and views', async () => {
    const count = await repo.deleteExpired(['s-old']);
    expect(prisma.storyView.deleteMany).toHaveBeenCalled();
    expect(prisma.story.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['s-old'] } } }),
    );
    expect(count).toBe(1);
  });

  it('deleteExpired returns 0 for empty array', async () => {
    const count = await repo.deleteExpired([]);
    expect(count).toBe(0);
  });

  it('delete removes a story by ID', async () => {
    await repo.delete('s-1');
    expect(prisma.storyView.deleteMany).toHaveBeenCalled();
    expect(prisma.story.delete).toHaveBeenCalledWith({ where: { id: 's-1' } });
  });

  it('hasActiveStories uses count', async () => {
    prisma.story.count.mockResolvedValue(2);
    expect(await repo.hasActiveStories('u-1')).toBe(true);

    prisma.story.count.mockResolvedValue(0);
    expect(await repo.hasActiveStories('u-1')).toBe(false);
  });
});
