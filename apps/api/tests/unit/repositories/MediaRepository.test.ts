/**
 * Unit tests for MediaRepository — per R16, R17.
 */
import { MediaRepository } from '../../../src/repositories/MediaRepository';

function mockPrisma() {
  return {
    media: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  } as any;
}

const MEDIA_ROW = {
  id: 'md-1',
  uploaderId: 'u-1',
  messageId: 'm-1',
  storyId: null,
  fileName: 'photo.jpg',
  mimeType: 'image/jpeg',
  size: 1024,
  storagePath: '/uploads/photo.jpg',
  thumbnailPath: '/uploads/photo_thumb.jpg',
  encryptionKey: 'key',
  encryptionIv: 'iv',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('MediaRepository', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let repo: MediaRepository;

  beforeEach(() => {
    prisma = mockPrisma();
    repo = new MediaRepository(prisma);
  });

  it('create inserts media record', async () => {
    prisma.media.create.mockResolvedValue(MEDIA_ROW);
    const result = await repo.create({
      uploaderId: 'u-1',
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      storagePath: '/uploads/photo.jpg',
    });
    expect(result).toHaveProperty('id', 'md-1');
  });

  it('findById returns media or null', async () => {
    prisma.media.findUnique.mockResolvedValue(MEDIA_ROW);
    expect(await repo.findById('md-1')).toHaveProperty('id');

    prisma.media.findUnique.mockResolvedValue(null);
    expect(await repo.findById('missing')).toBeNull();
  });

  it('findByMessage returns media list', async () => {
    prisma.media.findMany.mockResolvedValue([MEDIA_ROW]);
    const result = await repo.findByMessage('m-1');
    expect(result.length).toBe(1);
  });

  it('findByStory returns media list', async () => {
    prisma.media.findMany.mockResolvedValue([{ ...MEDIA_ROW, storyId: 's-1' }]);
    const result = await repo.findByStory('s-1');
    expect(result.length).toBe(1);
  });

  it('findByUploader returns paginated list', async () => {
    prisma.media.findMany.mockResolvedValue([MEDIA_ROW]);
    const result = await repo.findByUploader('u-1', { limit: 10 });
    expect(result).toHaveProperty('items');
  });

  it('delete removes media by ID', async () => {
    prisma.media.delete.mockResolvedValue(MEDIA_ROW);
    await repo.delete('md-1');
    expect(prisma.media.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'md-1' } }),
    );
  });

  it('deleteByStory removes all media for story and returns paths', async () => {
    prisma.media.findMany.mockResolvedValue([MEDIA_ROW]);
    prisma.media.deleteMany.mockResolvedValue({ count: 1 });
    const paths = await repo.deleteByStory('s-1');
    expect(Array.isArray(paths)).toBe(true);
  });
});
