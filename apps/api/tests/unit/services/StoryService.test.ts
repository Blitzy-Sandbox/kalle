/**
 * @module StoryService.test
 *
 * Comprehensive unit tests for the StoryService class — the story/status
 * lifecycle service managing creation (text/image/video), feed retrieval,
 * view tracking, author-initiated deletion, and expired story cleanup.
 *
 * Tests validate:
 * - R11 (Story Expiration and Cleanup): Stories hidden after 24h; expired media
 *       deleted by hourly BullMQ job via cleanupExpired().
 * - R35 (Data Retention): Stories/media purged after 24 hours.
 * - R12 (E2E Encryption): Stories are NOT encrypted — plaintext content and
 *       plain URLs. No ciphertext involved in any story operation.
 * - R17 (Interface-Driven Dependencies): Constructor receives IStoryRepository
 *       and IStorageProvider — all mocked as interfaces.
 * - R22 (Standardized Error Responses): Typed domain errors (NotFoundError,
 *       AuthorizationError, ValidationError) thrown with correct codes.
 * - R7  (Zero Warnings Build): TypeScript strict mode, zero warnings.
 * - R28 (Structured Logging Only): Zero console.log calls in test file.
 *
 * Coverage target: ≥80% of StoryService methods and branches.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Imports
 * ──────────────────────────────────────────────────────────────────────────── */

import { StoryService } from '../../../src/services/StoryService';
import type { IStoryRepository } from '../../../src/domain/interfaces/IStoryRepository';
import type { IStorageProvider } from '../../../src/domain/interfaces/IStorageProvider';
import { NotFoundError } from '../../../src/errors/NotFoundError';
import { AuthorizationError } from '../../../src/errors/AuthorizationError';
import { ValidationError } from '../../../src/errors/ValidationError';
import { StoryType } from '@kalle/shared';
import type { StoryResponse, StoryFeedItem, StoryView } from '@kalle/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Mock Factories
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Create a fully typed mock of IStoryRepository.
 * All 10 repository methods are mocked with jest.fn() (R17).
 */
function createMockStoryRepository(): jest.Mocked<IStoryRepository> {
  return {
    create: jest.fn(),
    findById: jest.fn(),
    findFeed: jest.fn(),
    findByAuthor: jest.fn(),
    addView: jest.fn(),
    getViews: jest.fn(),
    findExpired: jest.fn(),
    deleteExpired: jest.fn(),
    delete: jest.fn(),
    hasActiveStories: jest.fn(),
  };
}

/**
 * Create a fully typed mock of IStorageProvider.
 * All 5 storage operations are mocked with jest.fn() (R17).
 */
function createMockStorageProvider(): jest.Mocked<IStorageProvider> {
  return {
    store: jest.fn(),
    retrieve: jest.fn(),
    delete: jest.fn(),
    exists: jest.fn(),
    getUrl: jest.fn(),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Test Data Factories
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Build a StoryResponse with sensible defaults.
 * Stories are NOT encrypted (R12) — content and mediaUrl are plaintext.
 */
function createStoryResponse(overrides: Partial<StoryResponse> = {}): StoryResponse {
  return {
    id: 'story-1',
    authorId: 'user-1',
    authorName: 'Test User',
    type: StoryType.TEXT,
    content: 'Hello World',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    isExpired: false,
    createdAt: new Date().toISOString(),
    duration: 7,
    viewCount: 0,
    ...overrides,
  };
}

/**
 * Build a StoryView record.
 */
function createStoryView(overrides: Partial<StoryView> = {}): StoryView {
  return {
    id: 'view-1',
    storyId: 'story-1',
    viewerId: 'user-2',
    viewerName: 'Viewer User',
    viewedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build a StoryFeedItem with grouped stories.
 */
function createFeedItem(overrides: Partial<StoryFeedItem> = {}): StoryFeedItem {
  return {
    userId: 'user-2',
    userName: 'Feed User',
    stories: [createStoryResponse({ authorId: 'user-2', authorName: 'Feed User' })],
    hasUnviewed: true,
    latestStoryAt: new Date().toISOString(),
    ...overrides,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Test Suite
 * ──────────────────────────────────────────────────────────────────────────── */

describe('StoryService', () => {
  let service: StoryService;
  let mockStoryRepository: jest.Mocked<IStoryRepository>;
  let mockStorageProvider: jest.Mocked<IStorageProvider>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStoryRepository = createMockStoryRepository();
    mockStorageProvider = createMockStorageProvider();
    service = new StoryService(mockStoryRepository, mockStorageProvider);
  });

  // =========================================================================
  // createStory
  // =========================================================================

  describe('createStory', () => {
    it('should create a text story with 24h expiration (R11)', async () => {
      const expectedResponse = createStoryResponse();
      mockStoryRepository.create.mockResolvedValue(expectedResponse);

      const beforeCall = Date.now();
      const result = await service.createStory({
        authorId: 'user-1',
        authorName: 'Test User',
        type: StoryType.TEXT,
        content: 'Hello World',
      });
      const afterCall = Date.now();

      expect(mockStoryRepository.create).toHaveBeenCalledTimes(1);
      const createArg = mockStoryRepository.create.mock.calls[0][0];

      // Verify expiresAt is approximately 24 hours from now (±5 second tolerance)
      const expiresAtMs = createArg.expiresAt.getTime();
      const expectedExpiresMin = beforeCall + 24 * 60 * 60 * 1000 - 5000;
      const expectedExpiresMax = afterCall + 24 * 60 * 60 * 1000 + 5000;
      expect(expiresAtMs).toBeGreaterThanOrEqual(expectedExpiresMin);
      expect(expiresAtMs).toBeLessThanOrEqual(expectedExpiresMax);

      expect(result).toEqual(expectedResponse);
    });

    it('should set default display duration for text stories (7s)', async () => {
      const expectedResponse = createStoryResponse({ duration: 7 });
      mockStoryRepository.create.mockResolvedValue(expectedResponse);

      await service.createStory({
        authorId: 'user-1',
        authorName: 'Test User',
        type: StoryType.TEXT,
        content: 'My status update',
      });

      const createArg = mockStoryRepository.create.mock.calls[0][0];
      expect(createArg.duration).toBe(7);
    });

    it('should set default display duration for image stories (5s)', async () => {
      const expectedResponse = createStoryResponse({
        type: StoryType.IMAGE,
        mediaUrl: 'media/image-key.jpg',
        duration: 5,
      });
      mockStoryRepository.create.mockResolvedValue(expectedResponse);

      await service.createStory({
        authorId: 'user-1',
        authorName: 'Test User',
        type: StoryType.IMAGE,
        mediaUrl: 'media/image-key.jpg',
      });

      const createArg = mockStoryRepository.create.mock.calls[0][0];
      expect(createArg.duration).toBe(5);
    });

    it('should set default display duration for video stories (5s)', async () => {
      const expectedResponse = createStoryResponse({
        type: StoryType.VIDEO,
        mediaUrl: 'media/video-key.mp4',
        duration: 5,
      });
      mockStoryRepository.create.mockResolvedValue(expectedResponse);

      await service.createStory({
        authorId: 'user-1',
        authorName: 'Test User',
        type: StoryType.VIDEO,
        mediaUrl: 'media/video-key.mp4',
      });

      const createArg = mockStoryRepository.create.mock.calls[0][0];
      expect(createArg.duration).toBe(5);
    });

    it('should accept custom duration', async () => {
      const expectedResponse = createStoryResponse({ duration: 10 });
      mockStoryRepository.create.mockResolvedValue(expectedResponse);

      await service.createStory({
        authorId: 'user-1',
        authorName: 'Test User',
        type: StoryType.TEXT,
        content: 'Custom duration story',
        duration: 10,
      });

      const createArg = mockStoryRepository.create.mock.calls[0][0];
      expect(createArg.duration).toBe(10);
    });

    it('should throw ValidationError if TEXT story missing content', async () => {
      await expect(
        service.createStory({
          authorId: 'user-1',
          authorName: 'Test User',
          type: StoryType.TEXT,
        }),
      ).rejects.toThrow(ValidationError);

      expect(mockStoryRepository.create).not.toHaveBeenCalled();
    });

    it('should throw ValidationError if TEXT story has empty content', async () => {
      await expect(
        service.createStory({
          authorId: 'user-1',
          authorName: 'Test User',
          type: StoryType.TEXT,
          content: '   ',
        }),
      ).rejects.toThrow(ValidationError);

      expect(mockStoryRepository.create).not.toHaveBeenCalled();
    });

    it('should throw ValidationError if IMAGE story missing mediaUrl', async () => {
      await expect(
        service.createStory({
          authorId: 'user-1',
          authorName: 'Test User',
          type: StoryType.IMAGE,
        }),
      ).rejects.toThrow(ValidationError);

      expect(mockStoryRepository.create).not.toHaveBeenCalled();
    });

    it('should throw ValidationError if VIDEO story missing mediaUrl', async () => {
      await expect(
        service.createStory({
          authorId: 'user-1',
          authorName: 'Test User',
          type: StoryType.VIDEO,
        }),
      ).rejects.toThrow(ValidationError);

      expect(mockStoryRepository.create).not.toHaveBeenCalled();
    });

    it('should throw ValidationError if IMAGE story has empty mediaUrl', async () => {
      await expect(
        service.createStory({
          authorId: 'user-1',
          authorName: 'Test User',
          type: StoryType.IMAGE,
          mediaUrl: '   ',
        }),
      ).rejects.toThrow(ValidationError);

      expect(mockStoryRepository.create).not.toHaveBeenCalled();
    });

    it('should accept optional backgroundColor for TEXT stories', async () => {
      const expectedResponse = createStoryResponse({ backgroundColor: '#FF6B6B' });
      mockStoryRepository.create.mockResolvedValue(expectedResponse);

      await service.createStory({
        authorId: 'user-1',
        authorName: 'Test User',
        type: StoryType.TEXT,
        content: 'Colored background story',
        backgroundColor: '#FF6B6B',
      });

      const createArg = mockStoryRepository.create.mock.calls[0][0];
      expect(createArg.backgroundColor).toBe('#FF6B6B');
    });

    it('should accept optional fontStyle for TEXT stories', async () => {
      const expectedResponse = createStoryResponse({ fontStyle: 'serif' });
      mockStoryRepository.create.mockResolvedValue(expectedResponse);

      await service.createStory({
        authorId: 'user-1',
        authorName: 'Test User',
        type: StoryType.TEXT,
        content: 'Styled text story',
        fontStyle: 'serif',
      });

      const createArg = mockStoryRepository.create.mock.calls[0][0];
      expect(createArg.fontStyle).toBe('serif');
    });

    it('should pass authorAvatar when provided', async () => {
      const expectedResponse = createStoryResponse({ authorAvatar: 'avatars/user-1.jpg' });
      mockStoryRepository.create.mockResolvedValue(expectedResponse);

      await service.createStory({
        authorId: 'user-1',
        authorName: 'Test User',
        authorAvatar: 'avatars/user-1.jpg',
        type: StoryType.TEXT,
        content: 'Story with avatar',
      });

      const createArg = mockStoryRepository.create.mock.calls[0][0];
      expect(createArg.authorAvatar).toBe('avatars/user-1.jpg');
    });

    it('should pass mediaUrl and thumbnailUrl for IMAGE stories (R12 — plain URLs, not encrypted)', async () => {
      const expectedResponse = createStoryResponse({
        type: StoryType.IMAGE,
        mediaUrl: 'media/image.jpg',
        thumbnailUrl: 'media/thumb.jpg',
      });
      mockStoryRepository.create.mockResolvedValue(expectedResponse);

      await service.createStory({
        authorId: 'user-1',
        authorName: 'Test User',
        type: StoryType.IMAGE,
        mediaUrl: 'media/image.jpg',
        thumbnailUrl: 'media/thumb.jpg',
      });

      const createArg = mockStoryRepository.create.mock.calls[0][0];
      expect(createArg.mediaUrl).toBe('media/image.jpg');
      expect(createArg.thumbnailUrl).toBe('media/thumb.jpg');
    });

    it('should pass all fields through to repository create', async () => {
      const expectedResponse = createStoryResponse();
      mockStoryRepository.create.mockResolvedValue(expectedResponse);

      await service.createStory({
        authorId: 'user-1',
        authorName: 'Test User',
        authorAvatar: 'avatars/user-1.jpg',
        type: StoryType.TEXT,
        content: 'Full story input',
        backgroundColor: '#FF6B6B',
        fontStyle: 'serif',
        duration: 12,
      });

      const createArg = mockStoryRepository.create.mock.calls[0][0];
      expect(createArg.authorId).toBe('user-1');
      expect(createArg.authorName).toBe('Test User');
      expect(createArg.authorAvatar).toBe('avatars/user-1.jpg');
      expect(createArg.type).toBe(StoryType.TEXT);
      expect(createArg.content).toBe('Full story input');
      expect(createArg.backgroundColor).toBe('#FF6B6B');
      expect(createArg.fontStyle).toBe('serif');
      expect(createArg.duration).toBe(12);
      expect(createArg.expiresAt).toBeInstanceOf(Date);
    });
  });

  // =========================================================================
  // getStoryFeed
  // =========================================================================

  describe('getStoryFeed', () => {
    it('should delegate to storyRepository.findFeed', async () => {
      const feedItems = [createFeedItem(), createFeedItem({ userId: 'user-3', userName: 'Another User' })];
      mockStoryRepository.findFeed.mockResolvedValue(feedItems);

      const result = await service.getStoryFeed('user-1', ['user-2', 'user-3']);

      expect(mockStoryRepository.findFeed).toHaveBeenCalledTimes(1);
      expect(mockStoryRepository.findFeed).toHaveBeenCalledWith('user-1', ['user-2', 'user-3']);
      expect(result).toEqual(feedItems);
    });

    it('should return StoryFeedItem[] grouped by author', async () => {
      const feedItems: StoryFeedItem[] = [
        createFeedItem({
          userId: 'user-2',
          userName: 'Alice',
          stories: [
            createStoryResponse({ id: 's1', authorId: 'user-2' }),
            createStoryResponse({ id: 's2', authorId: 'user-2' }),
          ],
          hasUnviewed: true,
        }),
        createFeedItem({
          userId: 'user-3',
          userName: 'Bob',
          stories: [createStoryResponse({ id: 's3', authorId: 'user-3' })],
          hasUnviewed: false,
        }),
      ];
      mockStoryRepository.findFeed.mockResolvedValue(feedItems);

      const result = await service.getStoryFeed('user-1', ['user-2', 'user-3']);

      expect(result).toHaveLength(2);
      expect(result[0].userId).toBe('user-2');
      expect(result[0].stories).toHaveLength(2);
      expect(result[1].userId).toBe('user-3');
      expect(result[1].stories).toHaveLength(1);
    });

    it('should return empty array when no contacts have stories', async () => {
      mockStoryRepository.findFeed.mockResolvedValue([]);

      const result = await service.getStoryFeed('user-1', ['user-2']);

      expect(result).toEqual([]);
    });

    it('should return empty array when contactIds is empty', async () => {
      mockStoryRepository.findFeed.mockResolvedValue([]);

      const result = await service.getStoryFeed('user-1', []);

      expect(mockStoryRepository.findFeed).toHaveBeenCalledWith('user-1', []);
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getMyStories
  // =========================================================================

  describe('getMyStories', () => {
    it('should return stories by author', async () => {
      const stories = [
        createStoryResponse({ id: 's1' }),
        createStoryResponse({ id: 's2' }),
      ];
      mockStoryRepository.findByAuthor.mockResolvedValue(stories);

      const result = await service.getMyStories('user-1');

      expect(mockStoryRepository.findByAuthor).toHaveBeenCalledTimes(1);
      expect(mockStoryRepository.findByAuthor).toHaveBeenCalledWith('user-1');
      expect(result).toEqual(stories);
    });

    it('should return empty array when author has no active stories', async () => {
      mockStoryRepository.findByAuthor.mockResolvedValue([]);

      const result = await service.getMyStories('user-1');

      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getStoryById
  // =========================================================================

  describe('getStoryById', () => {
    it('should return story if found and not expired', async () => {
      const story = createStoryResponse();
      mockStoryRepository.findById.mockResolvedValue(story);

      const result = await service.getStoryById('story-1', 'user-2');

      expect(mockStoryRepository.findById).toHaveBeenCalledWith('story-1');
      expect(result).toEqual(story);
    });

    it('should throw NotFoundError if story not found', async () => {
      mockStoryRepository.findById.mockResolvedValue(null);

      await expect(service.getStoryById('nonexistent', 'user-2')).rejects.toThrow(NotFoundError);
      await expect(service.getStoryById('nonexistent', 'user-2')).rejects.toThrow('Story not found');
    });

    it('should throw NotFoundError if story is expired (R11)', async () => {
      const expiredStory = createStoryResponse({
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        isExpired: true,
      });
      mockStoryRepository.findById.mockResolvedValue(expiredStory);

      await expect(service.getStoryById('story-1', 'user-2')).rejects.toThrow(NotFoundError);
      await expect(service.getStoryById('story-1', 'user-2')).rejects.toThrow('Story has expired');
    });

    it('should treat story with expiresAt exactly at current time as expired', async () => {
      const boundaryStory = createStoryResponse({
        expiresAt: new Date(Date.now() - 1).toISOString(),
      });
      mockStoryRepository.findById.mockResolvedValue(boundaryStory);

      await expect(service.getStoryById('story-1', 'user-2')).rejects.toThrow(NotFoundError);
    });
  });

  // =========================================================================
  // viewStory
  // =========================================================================

  describe('viewStory', () => {
    it('should record a view via storyRepository.addView', async () => {
      const story = createStoryResponse();
      const view = createStoryView();
      mockStoryRepository.findById.mockResolvedValue(story);
      mockStoryRepository.addView.mockResolvedValue(view);

      const result = await service.viewStory('story-1', 'user-2');

      expect(mockStoryRepository.findById).toHaveBeenCalledWith('story-1');
      expect(mockStoryRepository.addView).toHaveBeenCalledWith('story-1', 'user-2');
      expect(result).toEqual(view);
    });

    it('should return null for duplicate view (idempotent)', async () => {
      const story = createStoryResponse();
      mockStoryRepository.findById.mockResolvedValue(story);
      mockStoryRepository.addView.mockResolvedValue(null);

      const result = await service.viewStory('story-1', 'user-2');

      expect(mockStoryRepository.addView).toHaveBeenCalledWith('story-1', 'user-2');
      expect(result).toBeNull();
    });

    it('should throw NotFoundError if story not found', async () => {
      mockStoryRepository.findById.mockResolvedValue(null);

      await expect(service.viewStory('nonexistent', 'user-2')).rejects.toThrow(NotFoundError);
      expect(mockStoryRepository.addView).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError if story is expired (R11)', async () => {
      const expiredStory = createStoryResponse({
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      mockStoryRepository.findById.mockResolvedValue(expiredStory);

      await expect(service.viewStory('story-1', 'user-2')).rejects.toThrow(NotFoundError);
      expect(mockStoryRepository.addView).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // getStoryViews
  // =========================================================================

  describe('getStoryViews', () => {
    it('should return views if requester is the author', async () => {
      const story = createStoryResponse({ authorId: 'user-1' });
      const views = [
        createStoryView({ viewerId: 'user-2', viewerName: 'Alice' }),
        createStoryView({ id: 'view-2', viewerId: 'user-3', viewerName: 'Bob' }),
      ];
      mockStoryRepository.findById.mockResolvedValue(story);
      mockStoryRepository.getViews.mockResolvedValue(views);

      const result = await service.getStoryViews('story-1', 'user-1');

      expect(mockStoryRepository.findById).toHaveBeenCalledWith('story-1');
      expect(mockStoryRepository.getViews).toHaveBeenCalledWith('story-1');
      expect(result).toEqual(views);
    });

    it('should throw AuthorizationError if requester is NOT the author', async () => {
      const story = createStoryResponse({ authorId: 'user-1' });
      mockStoryRepository.findById.mockResolvedValue(story);

      await expect(service.getStoryViews('story-1', 'user-2')).rejects.toThrow(AuthorizationError);
      expect(mockStoryRepository.getViews).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError if story not found', async () => {
      mockStoryRepository.findById.mockResolvedValue(null);

      await expect(service.getStoryViews('nonexistent', 'user-1')).rejects.toThrow(NotFoundError);
      expect(mockStoryRepository.getViews).not.toHaveBeenCalled();
    });

    it('should return empty array when no views exist', async () => {
      const story = createStoryResponse({ authorId: 'user-1' });
      mockStoryRepository.findById.mockResolvedValue(story);
      mockStoryRepository.getViews.mockResolvedValue([]);

      const result = await service.getStoryViews('story-1', 'user-1');

      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // deleteStory — author-initiated
  // =========================================================================

  describe('deleteStory', () => {
    it('should delete story if requester is the author', async () => {
      const story = createStoryResponse({ authorId: 'user-1' });
      mockStoryRepository.findById.mockResolvedValue(story);
      mockStoryRepository.delete.mockResolvedValue(undefined);

      await service.deleteStory('story-1', 'user-1');

      expect(mockStoryRepository.findById).toHaveBeenCalledWith('story-1');
      expect(mockStoryRepository.delete).toHaveBeenCalledWith('story-1');
    });

    it('should delete associated media from storage', async () => {
      const story = createStoryResponse({
        authorId: 'user-1',
        mediaUrl: 'media/some-key.jpg',
      });
      mockStoryRepository.findById.mockResolvedValue(story);
      mockStoryRepository.delete.mockResolvedValue(undefined);
      mockStorageProvider.delete.mockResolvedValue(undefined);

      await service.deleteStory('story-1', 'user-1');

      expect(mockStorageProvider.delete).toHaveBeenCalledWith('media/some-key.jpg');
    });

    it('should delete thumbnail from storage if exists', async () => {
      const story = createStoryResponse({
        authorId: 'user-1',
        mediaUrl: 'media/image.jpg',
        thumbnailUrl: 'media/thumb.jpg',
      });
      mockStoryRepository.findById.mockResolvedValue(story);
      mockStoryRepository.delete.mockResolvedValue(undefined);
      mockStorageProvider.delete.mockResolvedValue(undefined);

      await service.deleteStory('story-1', 'user-1');

      expect(mockStorageProvider.delete).toHaveBeenCalledWith('media/image.jpg');
      expect(mockStorageProvider.delete).toHaveBeenCalledWith('media/thumb.jpg');
      expect(mockStorageProvider.delete).toHaveBeenCalledTimes(2);
    });

    it('should not call storageProvider.delete if story has no media', async () => {
      const textStory = createStoryResponse({
        authorId: 'user-1',
        type: StoryType.TEXT,
        mediaUrl: undefined,
        thumbnailUrl: undefined,
      });
      mockStoryRepository.findById.mockResolvedValue(textStory);
      mockStoryRepository.delete.mockResolvedValue(undefined);

      await service.deleteStory('story-1', 'user-1');

      expect(mockStorageProvider.delete).not.toHaveBeenCalled();
      expect(mockStoryRepository.delete).toHaveBeenCalledWith('story-1');
    });

    it('should throw AuthorizationError if requester is NOT the author', async () => {
      const story = createStoryResponse({ authorId: 'user-1' });
      mockStoryRepository.findById.mockResolvedValue(story);

      await expect(service.deleteStory('story-1', 'user-2')).rejects.toThrow(AuthorizationError);
      expect(mockStoryRepository.delete).not.toHaveBeenCalled();
      expect(mockStorageProvider.delete).not.toHaveBeenCalled();
    });

    it('should throw NotFoundError if story not found', async () => {
      mockStoryRepository.findById.mockResolvedValue(null);

      await expect(service.deleteStory('nonexistent', 'user-1')).rejects.toThrow(NotFoundError);
      expect(mockStoryRepository.delete).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // cleanupExpired (R11, R35 — called by BullMQ worker)
  // =========================================================================

  describe('cleanupExpired', () => {
    it('should find all expired stories', async () => {
      const expiredStories = [
        { id: 'story-1', mediaUrl: 'media/img1.jpg', thumbnailUrl: 'media/thumb1.jpg' },
        { id: 'story-2', mediaUrl: 'media/img2.jpg' },
        { id: 'story-3' },
      ];
      mockStoryRepository.findExpired.mockResolvedValue(expiredStories);
      mockStoryRepository.deleteExpired.mockResolvedValue(3);
      mockStorageProvider.delete.mockResolvedValue(undefined);

      await service.cleanupExpired();

      expect(mockStoryRepository.findExpired).toHaveBeenCalledTimes(1);
      // findExpired is called with a Date argument
      const findExpiredArg = mockStoryRepository.findExpired.mock.calls[0][0];
      expect(findExpiredArg).toBeInstanceOf(Date);
    });

    it('should delete media from storage for expired stories with media (R11, R35)', async () => {
      const expiredStories = [
        { id: 'story-1', mediaUrl: 'media/img1.jpg', thumbnailUrl: 'media/thumb1.jpg' },
        { id: 'story-2', mediaUrl: 'media/img2.jpg', thumbnailUrl: 'media/thumb2.jpg' },
      ];
      mockStoryRepository.findExpired.mockResolvedValue(expiredStories);
      mockStoryRepository.deleteExpired.mockResolvedValue(2);
      mockStorageProvider.delete.mockResolvedValue(undefined);

      await service.cleanupExpired();

      // 2 stories × (mediaUrl + thumbnailUrl) = 4 storage delete calls
      expect(mockStorageProvider.delete).toHaveBeenCalledWith('media/img1.jpg');
      expect(mockStorageProvider.delete).toHaveBeenCalledWith('media/thumb1.jpg');
      expect(mockStorageProvider.delete).toHaveBeenCalledWith('media/img2.jpg');
      expect(mockStorageProvider.delete).toHaveBeenCalledWith('media/thumb2.jpg');
      expect(mockStorageProvider.delete).toHaveBeenCalledTimes(4);
    });

    it('should batch delete expired stories from DB', async () => {
      const expiredStories = [
        { id: 'story-1', mediaUrl: 'media/img1.jpg' },
        { id: 'story-2', mediaUrl: 'media/img2.jpg' },
        { id: 'story-3' },
      ];
      mockStoryRepository.findExpired.mockResolvedValue(expiredStories);
      mockStoryRepository.deleteExpired.mockResolvedValue(3);
      mockStorageProvider.delete.mockResolvedValue(undefined);

      await service.cleanupExpired();

      expect(mockStoryRepository.deleteExpired).toHaveBeenCalledTimes(1);
      expect(mockStoryRepository.deleteExpired).toHaveBeenCalledWith(['story-1', 'story-2', 'story-3']);
    });

    it('should return cleanup statistics', async () => {
      const expiredStories = [
        { id: 'story-1', mediaUrl: 'media/img1.jpg', thumbnailUrl: 'media/thumb1.jpg' },
        { id: 'story-2', mediaUrl: 'media/img2.jpg' },
        { id: 'story-3' },
      ];
      mockStoryRepository.findExpired.mockResolvedValue(expiredStories);
      mockStoryRepository.deleteExpired.mockResolvedValue(3);
      mockStorageProvider.delete.mockResolvedValue(undefined);

      const result = await service.cleanupExpired();

      expect(result).toEqual({
        deletedCount: 3,
        mediaFilesDeleted: 3, // img1 + thumb1 + img2 = 3 files deleted
      });
    });

    it('should handle stories without media gracefully', async () => {
      const expiredStories = [
        { id: 'story-1' }, // no media
        { id: 'story-2' }, // no media
      ];
      mockStoryRepository.findExpired.mockResolvedValue(expiredStories);
      mockStoryRepository.deleteExpired.mockResolvedValue(2);

      const result = await service.cleanupExpired();

      expect(mockStorageProvider.delete).not.toHaveBeenCalled();
      expect(result).toEqual({
        deletedCount: 2,
        mediaFilesDeleted: 0,
      });
    });

    it('should return zero counts when no expired stories exist', async () => {
      mockStoryRepository.findExpired.mockResolvedValue([]);

      const result = await service.cleanupExpired();

      expect(result).toEqual({ deletedCount: 0, mediaFilesDeleted: 0 });
      expect(mockStoryRepository.deleteExpired).not.toHaveBeenCalled();
      expect(mockStorageProvider.delete).not.toHaveBeenCalled();
    });

    it('should handle mixed stories (some with media, some without)', async () => {
      const expiredStories = [
        { id: 'story-1', mediaUrl: 'media/img1.jpg' },
        { id: 'story-2' }, // text-only, no media
        { id: 'story-3', mediaUrl: 'media/img3.jpg', thumbnailUrl: 'media/thumb3.jpg' },
      ];
      mockStoryRepository.findExpired.mockResolvedValue(expiredStories);
      mockStoryRepository.deleteExpired.mockResolvedValue(3);
      mockStorageProvider.delete.mockResolvedValue(undefined);

      const result = await service.cleanupExpired();

      // story-1: 1 media file, story-2: 0, story-3: 2 files = 3 total
      expect(mockStorageProvider.delete).toHaveBeenCalledTimes(3);
      expect(mockStorageProvider.delete).toHaveBeenCalledWith('media/img1.jpg');
      expect(mockStorageProvider.delete).toHaveBeenCalledWith('media/img3.jpg');
      expect(mockStorageProvider.delete).toHaveBeenCalledWith('media/thumb3.jpg');
      expect(result.mediaFilesDeleted).toBe(3);
    });
  });

  // =========================================================================
  // hasActiveStories
  // =========================================================================

  describe('hasActiveStories', () => {
    it('should delegate to storyRepository.hasActiveStories and return true', async () => {
      mockStoryRepository.hasActiveStories.mockResolvedValue(true);

      const result = await service.hasActiveStories('user-1');

      expect(mockStoryRepository.hasActiveStories).toHaveBeenCalledWith('user-1');
      expect(result).toBe(true);
    });

    it('should return false when user has no active stories', async () => {
      mockStoryRepository.hasActiveStories.mockResolvedValue(false);

      const result = await service.hasActiveStories('user-1');

      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // Error Code Verification (R22 — Standardized Error Responses)
  // =========================================================================

  describe('error codes and types (R22)', () => {
    it('NotFoundError should have code NOT_FOUND and status 404', async () => {
      mockStoryRepository.findById.mockResolvedValue(null);

      try {
        await service.getStoryById('nonexistent', 'user-1');
        fail('Expected NotFoundError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundError);
        expect((error as NotFoundError).code).toBe('NOT_FOUND');
        expect((error as NotFoundError).statusCode).toBe(404);
      }
    });

    it('AuthorizationError should have code AUTHORIZATION_ERROR and status 403', async () => {
      const story = createStoryResponse({ authorId: 'user-1' });
      mockStoryRepository.findById.mockResolvedValue(story);

      try {
        await service.deleteStory('story-1', 'user-999');
        fail('Expected AuthorizationError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AuthorizationError);
        expect((error as AuthorizationError).code).toBe('AUTHORIZATION_ERROR');
        expect((error as AuthorizationError).statusCode).toBe(403);
      }
    });

    it('ValidationError should have code VALIDATION_ERROR and status 400', async () => {
      try {
        await service.createStory({
          authorId: 'user-1',
          authorName: 'Test User',
          type: StoryType.TEXT,
        });
        fail('Expected ValidationError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).code).toBe('VALIDATION_ERROR');
        expect((error as ValidationError).statusCode).toBe(400);
      }
    });
  });

  // =========================================================================
  // Interface-Driven Dependencies (R17)
  // =========================================================================

  describe('constructor and dependency injection (R17)', () => {
    it('should create service with two interface-driven dependencies', () => {
      const repo = createMockStoryRepository();
      const storage = createMockStorageProvider();
      const svc = new StoryService(repo, storage);

      expect(svc).toBeInstanceOf(StoryService);
    });

    it('should use storyRepository for all persistence operations', async () => {
      const story = createStoryResponse();
      mockStoryRepository.findById.mockResolvedValue(story);
      mockStoryRepository.findFeed.mockResolvedValue([]);
      mockStoryRepository.findByAuthor.mockResolvedValue([]);
      mockStoryRepository.hasActiveStories.mockResolvedValue(true);

      await service.getStoryById('story-1', 'user-1');
      await service.getStoryFeed('user-1', []);
      await service.getMyStories('user-1');
      await service.hasActiveStories('user-1');

      expect(mockStoryRepository.findById).toHaveBeenCalled();
      expect(mockStoryRepository.findFeed).toHaveBeenCalled();
      expect(mockStoryRepository.findByAuthor).toHaveBeenCalled();
      expect(mockStoryRepository.hasActiveStories).toHaveBeenCalled();
    });

    it('should use storageProvider only for media cleanup operations', async () => {
      // Text story — no storage interaction
      const textStory = createStoryResponse({
        authorId: 'user-1',
        type: StoryType.TEXT,
        mediaUrl: undefined,
        thumbnailUrl: undefined,
      });
      mockStoryRepository.findById.mockResolvedValue(textStory);
      mockStoryRepository.delete.mockResolvedValue(undefined);

      await service.deleteStory('story-1', 'user-1');

      expect(mockStorageProvider.store).not.toHaveBeenCalled();
      expect(mockStorageProvider.retrieve).not.toHaveBeenCalled();
      expect(mockStorageProvider.exists).not.toHaveBeenCalled();
      expect(mockStorageProvider.getUrl).not.toHaveBeenCalled();
      expect(mockStorageProvider.delete).not.toHaveBeenCalled();
    });
  });
});
