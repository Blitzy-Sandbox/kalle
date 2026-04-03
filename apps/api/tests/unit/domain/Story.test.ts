/**
 * @module apps/api/tests/unit/domain/Story.test.ts
 *
 * Unit tests for the Story domain model class.
 *
 * Tests focus on:
 * - Static factory creation with validation and defaults
 * - 24-hour expiration lifecycle (R11, R35)
 * - Unique view tracking with duplicate prevention
 * - Cleanup eligibility determination for the hourly BullMQ job
 * - TEXT / IMAGE / VIDEO type guard correctness
 * - Serialization to StoryResponse shape
 * - Edge cases and boundary conditions
 *
 * Architecture rules enforced:
 * - R11  (Story Expiration): Stories hidden after 24h; expiresAt >= now → expired
 * - R35  (Data Retention): Stories/media purged after 24h
 * - R12  (E2E Encryption): Stories are NOT encrypted — zero encryption references
 * - R16  (OOD Layering): Tests verify domain model behavior only
 * - R7   (Zero Warnings): TypeScript strict mode compatible
 * - R28  (Structured Logging): Zero console.log calls
 *
 * Zero Prisma imports. Zero external service dependencies.
 */

import { Story, StoryProps, StoryViewRecord } from '../../../src/domain/models/Story';
import { StoryType } from '@kalle/shared/types/story';
import { TTL } from '@kalle/shared/constants/index';

// =============================================================================
// Helper Factories
// =============================================================================

/**
 * Returns a valid StoryProps object for a TEXT story.
 * Uses fixed dates for deterministic time-sensitive tests.
 *
 * @param overrides - Optional partial overrides for any StoryProps field
 */
const textStoryProps = (overrides?: Partial<StoryProps>): StoryProps => ({
  id: 'story-1',
  authorId: 'user-1',
  authorName: 'Alice',
  authorAvatar: 'alice.png',
  type: StoryType.TEXT,
  content: 'Hello World!',
  mediaUrl: undefined,
  thumbnailUrl: undefined,
  backgroundColor: '#FF6B6B',
  fontStyle: undefined,
  duration: 5,
  views: [],
  expiresAt: new Date(Date.now() + TTL.STORY_EXPIRATION_MS),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/**
 * Returns a valid StoryProps object for an IMAGE story.
 *
 * @param overrides - Optional partial overrides for any StoryProps field
 */
const imageStoryProps = (overrides?: Partial<StoryProps>): StoryProps => ({
  ...textStoryProps(),
  id: 'story-2',
  type: StoryType.IMAGE,
  content: undefined,
  mediaUrl: 'https://example.com/image.jpg',
  thumbnailUrl: 'https://example.com/thumb.jpg',
  backgroundColor: undefined,
  duration: 5,
  ...overrides,
});

/**
 * Returns a valid StoryProps object for a VIDEO story.
 *
 * @param overrides - Optional partial overrides for any StoryProps field
 */
const videoStoryProps = (overrides?: Partial<StoryProps>): StoryProps => ({
  ...textStoryProps(),
  id: 'story-3',
  type: StoryType.VIDEO,
  content: undefined,
  mediaUrl: 'https://example.com/video.mp4',
  thumbnailUrl: 'https://example.com/thumb-vid.jpg',
  backgroundColor: undefined,
  duration: 30,
  ...overrides,
});

// =============================================================================
// Phase 2: Factory Tests — Story.create()
// =============================================================================

describe('Story.create()', () => {
  it('should create a TEXT story with content and default backgroundColor "#FF6B6B"', () => {
    const story = Story.create({
      authorId: 'user-1',
      authorName: 'Alice',
      type: StoryType.TEXT,
      content: 'Hello World!',
    });

    expect(story.type).toBe(StoryType.TEXT);
    expect(story.content).toBe('Hello World!');
    expect(story.backgroundColor).toBe('#FF6B6B');
    expect(story.authorId).toBe('user-1');
    expect(story.authorName).toBe('Alice');
  });

  it('should create a TEXT story with a custom backgroundColor', () => {
    const story = Story.create({
      authorId: 'user-1',
      authorName: 'Alice',
      type: StoryType.TEXT,
      content: 'Custom color',
      backgroundColor: '#00BFFF',
    });

    expect(story.backgroundColor).toBe('#00BFFF');
  });

  it('should create an IMAGE story with mediaUrl', () => {
    const story = Story.create({
      authorId: 'user-1',
      authorName: 'Alice',
      type: StoryType.IMAGE,
      mediaUrl: 'https://example.com/image.jpg',
      thumbnailUrl: 'https://example.com/thumb.jpg',
    });

    expect(story.type).toBe(StoryType.IMAGE);
    expect(story.mediaUrl).toBe('https://example.com/image.jpg');
    expect(story.thumbnailUrl).toBe('https://example.com/thumb.jpg');
  });

  it('should create a VIDEO story with mediaUrl and custom duration', () => {
    const story = Story.create({
      authorId: 'user-1',
      authorName: 'Alice',
      type: StoryType.VIDEO,
      mediaUrl: 'https://example.com/video.mp4',
      duration: 45,
    });

    expect(story.type).toBe(StoryType.VIDEO);
    expect(story.mediaUrl).toBe('https://example.com/video.mp4');
    expect(story.duration).toBe(45);
  });

  it('should set expiresAt to now + 24 hours (TTL.STORY_EXPIRATION_MS)', () => {
    const beforeCreate = Date.now();
    const story = Story.create({
      authorId: 'user-1',
      authorName: 'Alice',
      type: StoryType.TEXT,
      content: 'Expiration test',
    });
    const afterCreate = Date.now();

    const expiresAtMs = story.expiresAt.getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(beforeCreate + TTL.STORY_EXPIRATION_MS);
    expect(expiresAtMs).toBeLessThanOrEqual(afterCreate + TTL.STORY_EXPIRATION_MS);
  });

  it('should initialize views to an empty array', () => {
    const story = Story.create({
      authorId: 'user-1',
      authorName: 'Alice',
      type: StoryType.TEXT,
      content: 'Empty views test',
    });

    expect(story.getViewCount()).toBe(0);
    expect(story.getViews()).toEqual([]);
  });

  it('should default duration to 5 seconds for IMAGE stories', () => {
    const story = Story.create({
      authorId: 'user-1',
      authorName: 'Alice',
      type: StoryType.IMAGE,
      mediaUrl: 'https://example.com/image.jpg',
    });

    expect(story.duration).toBe(5);
  });

  it('should default duration to 5 seconds for TEXT stories when not specified', () => {
    const story = Story.create({
      authorId: 'user-1',
      authorName: 'Alice',
      type: StoryType.TEXT,
      content: 'Duration default test',
    });

    expect(story.duration).toBe(5);
  });

  it('should default duration to 10 seconds for VIDEO stories when not specified', () => {
    const story = Story.create({
      authorId: 'user-1',
      authorName: 'Alice',
      type: StoryType.VIDEO,
      mediaUrl: 'https://example.com/video.mp4',
    });

    expect(story.duration).toBe(10);
  });

  it('should throw for TEXT type with empty content', () => {
    expect(() =>
      Story.create({
        authorId: 'user-1',
        authorName: 'Alice',
        type: StoryType.TEXT,
        content: '',
      })
    ).toThrow('TEXT stories require non-empty content');
  });

  it('should throw for TEXT type with undefined content', () => {
    expect(() =>
      Story.create({
        authorId: 'user-1',
        authorName: 'Alice',
        type: StoryType.TEXT,
      })
    ).toThrow('TEXT stories require non-empty content');
  });

  it('should throw for TEXT type with whitespace-only content', () => {
    expect(() =>
      Story.create({
        authorId: 'user-1',
        authorName: 'Alice',
        type: StoryType.TEXT,
        content: '   ',
      })
    ).toThrow('TEXT stories require non-empty content');
  });

  it('should throw for IMAGE type with missing mediaUrl', () => {
    expect(() =>
      Story.create({
        authorId: 'user-1',
        authorName: 'Alice',
        type: StoryType.IMAGE,
      })
    ).toThrow('IMAGE stories require a non-empty mediaUrl');
  });

  it('should throw for IMAGE type with empty mediaUrl', () => {
    expect(() =>
      Story.create({
        authorId: 'user-1',
        authorName: 'Alice',
        type: StoryType.IMAGE,
        mediaUrl: '',
      })
    ).toThrow('IMAGE stories require a non-empty mediaUrl');
  });

  it('should throw for VIDEO type with missing mediaUrl', () => {
    expect(() =>
      Story.create({
        authorId: 'user-1',
        authorName: 'Alice',
        type: StoryType.VIDEO,
      })
    ).toThrow('VIDEO stories require a non-empty mediaUrl');
  });

  it('should throw for VIDEO type with empty mediaUrl', () => {
    expect(() =>
      Story.create({
        authorId: 'user-1',
        authorName: 'Alice',
        type: StoryType.VIDEO,
        mediaUrl: '',
      })
    ).toThrow('VIDEO stories require a non-empty mediaUrl');
  });

  it('should throw for empty authorId', () => {
    expect(() =>
      Story.create({
        authorId: '',
        authorName: 'Alice',
        type: StoryType.TEXT,
        content: 'No author ID',
      })
    ).toThrow('Story authorId is required');
  });

  it('should throw for empty authorName', () => {
    expect(() =>
      Story.create({
        authorId: 'user-1',
        authorName: '',
        type: StoryType.TEXT,
        content: 'No author name',
      })
    ).toThrow('Story authorName is required');
  });

  it('should generate a UUID id when not provided', () => {
    const story = Story.create({
      authorId: 'user-1',
      authorName: 'Alice',
      type: StoryType.TEXT,
      content: 'Auto ID',
    });

    expect(story.id).toBeDefined();
    expect(story.id.length).toBeGreaterThan(0);
  });

  it('should use the provided id when specified', () => {
    const story = Story.create({
      id: 'custom-story-id',
      authorId: 'user-1',
      authorName: 'Alice',
      type: StoryType.TEXT,
      content: 'Custom ID',
    });

    expect(story.id).toBe('custom-story-id');
  });

  it('should trim authorId and authorName', () => {
    const story = Story.create({
      authorId: '  user-1  ',
      authorName: '  Alice  ',
      type: StoryType.TEXT,
      content: 'Trimmed',
    });

    expect(story.authorId).toBe('user-1');
    expect(story.authorName).toBe('Alice');
  });
});

// =============================================================================
// Phase 3: Expiration Tests — CRITICAL (R11: 24-Hour Expiration)
// =============================================================================

describe('isExpired()', () => {
  it('should return false when now < expiresAt (story is not expired)', () => {
    const story = new Story(textStoryProps());

    expect(story.isExpired()).toBe(false);
  });

  it('should return true when now === expiresAt (boundary: >= not >)', () => {
    const expiresAt = new Date('2025-06-15T12:00:00.000Z');
    const story = new Story(textStoryProps({ expiresAt }));

    // Pass now = exactly expiresAt
    expect(story.isExpired(expiresAt)).toBe(true);
  });

  it('should return true when now > expiresAt (story is past expired)', () => {
    const expiresAt = new Date('2024-01-01T00:00:00.000Z');
    const story = new Story(textStoryProps({ expiresAt }));

    const futureDate = new Date('2024-06-01T00:00:00.000Z');
    expect(story.isExpired(futureDate)).toBe(true);
  });

  it('should accept injectable now parameter for deterministic testing', () => {
    const expiresAt = new Date('2025-06-15T12:00:00.000Z');
    const story = new Story(textStoryProps({ expiresAt }));

    const beforeExpiry = new Date('2025-06-15T11:59:59.999Z');
    const atExpiry = new Date('2025-06-15T12:00:00.000Z');
    const afterExpiry = new Date('2025-06-15T12:00:00.001Z');

    expect(story.isExpired(beforeExpiry)).toBe(false);
    expect(story.isExpired(atExpiry)).toBe(true);
    expect(story.isExpired(afterExpiry)).toBe(true);
  });

  it('should expire at T+24h+1ms after creation time', () => {
    const createdAt = new Date('2025-06-15T00:00:00.000Z');
    const expiresAt = new Date(createdAt.getTime() + TTL.STORY_EXPIRATION_MS);
    const story = new Story(textStoryProps({ createdAt, expiresAt }));

    // T + 24h - 1ms → NOT expired
    const justBeforeExpiry = new Date(expiresAt.getTime() - 1);
    expect(story.isExpired(justBeforeExpiry)).toBe(false);

    // T + 24h → IS expired (boundary inclusive)
    expect(story.isExpired(expiresAt)).toBe(true);

    // T + 24h + 1ms → IS expired
    const justAfterExpiry = new Date(expiresAt.getTime() + 1);
    expect(story.isExpired(justAfterExpiry)).toBe(true);
  });

  it('should default to current time when now is not provided', () => {
    // Create a story that expires far in the future
    const futureExpiry = new Date(Date.now() + 999_999_999);
    const storyFuture = new Story(textStoryProps({ expiresAt: futureExpiry }));
    expect(storyFuture.isExpired()).toBe(false);

    // Create a story that already expired
    const pastExpiry = new Date(Date.now() - 1);
    const storyPast = new Story(textStoryProps({ expiresAt: pastExpiry }));
    expect(storyPast.isExpired()).toBe(true);
  });
});

describe('getTimeRemaining()', () => {
  it('should return a positive number for a non-expired story', () => {
    const expiresAt = new Date('2099-01-01T00:00:00.000Z');
    const story = new Story(textStoryProps({ expiresAt }));

    const now = new Date('2025-06-15T00:00:00.000Z');
    const remaining = story.getTimeRemaining(now);

    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBe(expiresAt.getTime() - now.getTime());
  });

  it('should return 0 for an expired story (never negative)', () => {
    const expiresAt = new Date('2024-01-01T00:00:00.000Z');
    const story = new Story(textStoryProps({ expiresAt }));

    const now = new Date('2025-01-01T00:00:00.000Z');
    expect(story.getTimeRemaining(now)).toBe(0);
  });

  it('should return 0 when now equals expiresAt (boundary)', () => {
    const expiresAt = new Date('2025-06-15T12:00:00.000Z');
    const story = new Story(textStoryProps({ expiresAt }));

    expect(story.getTimeRemaining(expiresAt)).toBe(0);
  });

  it('should use injectable now parameter for deterministic results', () => {
    const expiresAt = new Date('2025-06-15T12:00:00.000Z');
    const story = new Story(textStoryProps({ expiresAt }));

    const now1 = new Date('2025-06-15T11:00:00.000Z');
    expect(story.getTimeRemaining(now1)).toBe(3_600_000); // 1 hour in ms

    const now2 = new Date('2025-06-15T06:00:00.000Z');
    expect(story.getTimeRemaining(now2)).toBe(21_600_000); // 6 hours in ms
  });

  it('should return exactly TTL.STORY_EXPIRATION_MS for a just-created story', () => {
    const now = new Date('2025-06-15T00:00:00.000Z');
    const expiresAt = new Date(now.getTime() + TTL.STORY_EXPIRATION_MS);
    const story = new Story(textStoryProps({ createdAt: now, expiresAt }));

    expect(story.getTimeRemaining(now)).toBe(TTL.STORY_EXPIRATION_MS);
  });
});

// =============================================================================
// Phase 4: View Tracking Tests
// =============================================================================

describe('addView()', () => {
  it('should add a view with userId and viewedAt timestamp', () => {
    const story = new Story(textStoryProps());
    const now = new Date('2025-06-15T08:00:00.000Z');

    const result = story.addView('viewer-1', now);

    expect(result).toBe(true);
    const views = story.getViews();
    expect(views).toHaveLength(1);
    expect(views[0].userId).toBe('viewer-1');
    expect(views[0].viewedAt).toEqual(now);
  });

  it('should return true on successful new view', () => {
    const story = new Story(textStoryProps());
    expect(story.addView('viewer-1')).toBe(true);
  });

  it('should return false for duplicate view from same userId (prevents double counting)', () => {
    const story = new Story(textStoryProps());

    expect(story.addView('viewer-1')).toBe(true);
    expect(story.addView('viewer-1')).toBe(false);
    expect(story.getViewCount()).toBe(1);
  });

  it('should return false for expired story (cannot view expired stories)', () => {
    const expiresAt = new Date('2024-01-01T00:00:00.000Z');
    const story = new Story(textStoryProps({ expiresAt }));

    const now = new Date('2025-01-01T00:00:00.000Z');
    expect(story.addView('viewer-1', now)).toBe(false);
    expect(story.getViewCount()).toBe(0);
  });

  it('should allow multiple different users to view the same story', () => {
    const story = new Story(textStoryProps());

    expect(story.addView('viewer-1')).toBe(true);
    expect(story.addView('viewer-2')).toBe(true);
    expect(story.addView('viewer-3')).toBe(true);
    expect(story.getViewCount()).toBe(3);

    const views = story.getViews();
    const userIds = views.map((v: StoryViewRecord) => v.userId);
    expect(userIds).toContain('viewer-1');
    expect(userIds).toContain('viewer-2');
    expect(userIds).toContain('viewer-3');
  });

  it('should use injectable now parameter for viewedAt timestamp', () => {
    const story = new Story(textStoryProps());
    const specificTime = new Date('2025-06-15T10:30:00.000Z');

    story.addView('viewer-1', specificTime);

    const views = story.getViews();
    expect(views[0].viewedAt).toEqual(specificTime);
  });
});

describe('getViewCount()', () => {
  it('should return 0 for a new story with no views', () => {
    const story = new Story(textStoryProps());
    expect(story.getViewCount()).toBe(0);
  });

  it('should return correct count after multiple unique views', () => {
    const story = new Story(textStoryProps());

    story.addView('viewer-1');
    expect(story.getViewCount()).toBe(1);

    story.addView('viewer-2');
    expect(story.getViewCount()).toBe(2);

    story.addView('viewer-3');
    expect(story.getViewCount()).toBe(3);
  });

  it('should not increase count for duplicate views', () => {
    const story = new Story(textStoryProps());

    story.addView('viewer-1');
    story.addView('viewer-1');
    story.addView('viewer-1');

    expect(story.getViewCount()).toBe(1);
  });
});

describe('getViews()', () => {
  it('should return a defensive copy — modifying returned array does not affect model', () => {
    const story = new Story(textStoryProps());
    story.addView('viewer-1');

    const views = story.getViews();
    views.push({ userId: 'injected-user', viewedAt: new Date() });

    // The internal views should still have only 1 entry
    expect(story.getViewCount()).toBe(1);
    expect(story.getViews()).toHaveLength(1);
  });

  it('should return views with userId and viewedAt for each view record', () => {
    const story = new Story(textStoryProps());
    const time1 = new Date('2025-06-15T08:00:00.000Z');
    const time2 = new Date('2025-06-15T09:00:00.000Z');

    story.addView('viewer-1', time1);
    story.addView('viewer-2', time2);

    const views = story.getViews();
    expect(views).toHaveLength(2);

    expect(views[0]).toEqual({ userId: 'viewer-1', viewedAt: time1 });
    expect(views[1]).toEqual({ userId: 'viewer-2', viewedAt: time2 });
  });

  it('should return empty array for a story with no views', () => {
    const story = new Story(textStoryProps());
    expect(story.getViews()).toEqual([]);
  });
});

describe('hasBeenViewedBy()', () => {
  it('should return true for a userId that has viewed the story', () => {
    const story = new Story(textStoryProps());
    story.addView('viewer-1');

    expect(story.hasBeenViewedBy('viewer-1')).toBe(true);
  });

  it('should return false for a userId that has not viewed the story', () => {
    const story = new Story(textStoryProps());
    story.addView('viewer-1');

    expect(story.hasBeenViewedBy('viewer-2')).toBe(false);
  });

  it('should return false when no views exist', () => {
    const story = new Story(textStoryProps());
    expect(story.hasBeenViewedBy('viewer-1')).toBe(false);
  });
});

// =============================================================================
// Phase 5: Cleanup Eligibility Tests — CRITICAL (R11, R35)
// =============================================================================

describe('shouldCleanup()', () => {
  it('should return true for expired IMAGE story WITH mediaUrl', () => {
    const expiresAt = new Date('2024-01-01T00:00:00.000Z');
    const story = new Story(imageStoryProps({ expiresAt }));

    const now = new Date('2025-01-01T00:00:00.000Z');
    expect(story.shouldCleanup(now)).toBe(true);
  });

  it('should return true for expired VIDEO story WITH mediaUrl', () => {
    const expiresAt = new Date('2024-01-01T00:00:00.000Z');
    const story = new Story(videoStoryProps({ expiresAt }));

    const now = new Date('2025-01-01T00:00:00.000Z');
    expect(story.shouldCleanup(now)).toBe(true);
  });

  it('should return false for non-expired story even with mediaUrl', () => {
    const story = new Story(imageStoryProps());

    expect(story.shouldCleanup()).toBe(false);
  });

  it('should return false for expired TEXT story WITHOUT mediaUrl (no media cleanup needed)', () => {
    const expiresAt = new Date('2024-01-01T00:00:00.000Z');
    const story = new Story(
      textStoryProps({
        expiresAt,
        mediaUrl: undefined,
      })
    );

    const now = new Date('2025-01-01T00:00:00.000Z');
    expect(story.shouldCleanup(now)).toBe(false);
  });

  it('should use injectable now for expiration check', () => {
    const expiresAt = new Date('2025-06-15T12:00:00.000Z');
    const story = new Story(imageStoryProps({ expiresAt }));

    const beforeExpiry = new Date('2025-06-15T11:59:59.999Z');
    const afterExpiry = new Date('2025-06-15T12:00:00.001Z');

    expect(story.shouldCleanup(beforeExpiry)).toBe(false);
    expect(story.shouldCleanup(afterExpiry)).toBe(true);
  });
});

// =============================================================================
// Phase 6: Type Guard Tests
// =============================================================================

describe('type guards', () => {
  it('should return true from isText() for StoryType.TEXT', () => {
    const story = new Story(textStoryProps());
    expect(story.isText()).toBe(true);
    expect(story.isImage()).toBe(false);
    expect(story.isVideo()).toBe(false);
  });

  it('should return true from isImage() for StoryType.IMAGE', () => {
    const story = new Story(imageStoryProps());
    expect(story.isText()).toBe(false);
    expect(story.isImage()).toBe(true);
    expect(story.isVideo()).toBe(false);
  });

  it('should return true from isVideo() for StoryType.VIDEO', () => {
    const story = new Story(videoStoryProps());
    expect(story.isText()).toBe(false);
    expect(story.isImage()).toBe(false);
    expect(story.isVideo()).toBe(true);
  });

  it('should have mutually exclusive type guards (only one returns true at a time)', () => {
    const textStory = new Story(textStoryProps());
    const imageStory = new Story(imageStoryProps());
    const videoStory = new Story(videoStoryProps());

    // TEXT story: only isText is true
    expect(
      [textStory.isText(), textStory.isImage(), textStory.isVideo()].filter(Boolean)
    ).toHaveLength(1);

    // IMAGE story: only isImage is true
    expect(
      [imageStory.isText(), imageStory.isImage(), imageStory.isVideo()].filter(Boolean)
    ).toHaveLength(1);

    // VIDEO story: only isVideo is true
    expect(
      [videoStory.isText(), videoStory.isImage(), videoStory.isVideo()].filter(Boolean)
    ).toHaveLength(1);
  });
});

// =============================================================================
// Phase 7: Serialization Tests
// =============================================================================

describe('toResponse()', () => {
  it('should return object with all expected fields', () => {
    const story = new Story(
      textStoryProps({
        id: 'story-resp-1',
        authorId: 'user-resp-1',
        authorName: 'Bob',
        authorAvatar: 'bob.png',
        type: StoryType.TEXT,
        content: 'Serialization test',
        backgroundColor: '#FF6B6B',
        fontStyle: 'bold-serif',
        duration: 7,
      })
    );

    const response = story.toResponse();

    expect(response.id).toBe('story-resp-1');
    expect(response.authorId).toBe('user-resp-1');
    expect(response.authorName).toBe('Bob');
    expect(response.authorAvatar).toBe('bob.png');
    expect(response.type).toBe(StoryType.TEXT);
    expect(response.content).toBe('Serialization test');
    expect(response.backgroundColor).toBe('#FF6B6B');
    expect(response.fontStyle).toBe('bold-serif');
    expect(response.duration).toBe(7);
  });

  it('should convert Date fields to ISO 8601 strings', () => {
    const expiresAt = new Date('2025-06-16T00:00:00.000Z');
    const createdAt = new Date('2025-06-15T00:00:00.000Z');
    const story = new Story(textStoryProps({ expiresAt, createdAt }));

    const response = story.toResponse();

    expect(response.expiresAt).toBe('2025-06-16T00:00:00.000Z');
    expect(response.createdAt).toBe('2025-06-15T00:00:00.000Z');
    // Verify they are strings, not Date objects
    expect(typeof response.expiresAt).toBe('string');
    expect(typeof response.createdAt).toBe('string');
  });

  it('should include viewCount computed from views array', () => {
    const story = new Story(textStoryProps());
    story.addView('viewer-1');
    story.addView('viewer-2');

    const response = story.toResponse();
    expect(response.viewCount).toBe(2);
  });

  it('should include viewCount of 0 when no views exist', () => {
    const story = new Story(textStoryProps());
    const response = story.toResponse();
    expect(response.viewCount).toBe(0);
  });

  it('should include isExpired dynamically computed for non-expired story', () => {
    const story = new Story(textStoryProps());
    const response = story.toResponse();

    expect(response.isExpired).toBe(false);
  });

  it('should include isExpired dynamically computed for expired story', () => {
    const expiresAt = new Date('2024-01-01T00:00:00.000Z');
    const story = new Story(textStoryProps({ expiresAt }));

    const response = story.toResponse();
    expect(response.isExpired).toBe(true);
  });

  it('should include expiresAt as an ISO 8601 string', () => {
    const expiresAt = new Date('2025-12-31T23:59:59.999Z');
    const story = new Story(textStoryProps({ expiresAt }));

    const response = story.toResponse();
    expect(response.expiresAt).toBe('2025-12-31T23:59:59.999Z');
  });

  it('should include mediaUrl and thumbnailUrl for IMAGE story', () => {
    const story = new Story(imageStoryProps());
    const response = story.toResponse();

    expect(response.mediaUrl).toBe('https://example.com/image.jpg');
    expect(response.thumbnailUrl).toBe('https://example.com/thumb.jpg');
  });

  it('should include undefined optional fields for TEXT story without media', () => {
    const story = new Story(textStoryProps());
    const response = story.toResponse();

    expect(response.mediaUrl).toBeUndefined();
    expect(response.thumbnailUrl).toBeUndefined();
  });
});

// =============================================================================
// Phase 8: Edge Cases
// =============================================================================

describe('edge cases', () => {
  it('addView() should be idempotent for the same userId', () => {
    const story = new Story(textStoryProps());

    // First call succeeds
    expect(story.addView('user-repeat')).toBe(true);
    // Subsequent calls return false without side effects
    expect(story.addView('user-repeat')).toBe(false);
    expect(story.addView('user-repeat')).toBe(false);
    expect(story.addView('user-repeat')).toBe(false);

    expect(story.getViewCount()).toBe(1);
  });

  it('isExpired at exact expiration time returns true (getTime() === expiresAt.getTime())', () => {
    const expiresAt = new Date('2025-06-15T18:00:00.000Z');
    const story = new Story(textStoryProps({ expiresAt }));

    const exactTime = new Date(expiresAt.getTime());
    expect(story.isExpired(exactTime)).toBe(true);
  });

  it('getTimeRemaining() should never return a negative value', () => {
    const expiresAt = new Date('2020-01-01T00:00:00.000Z');
    const story = new Story(textStoryProps({ expiresAt }));

    // Far in the future from expiration
    const farFuture = new Date('2099-01-01T00:00:00.000Z');
    expect(story.getTimeRemaining(farFuture)).toBe(0);
    expect(story.getTimeRemaining(farFuture)).toBeGreaterThanOrEqual(0);
  });

  it('shouldCleanup() returns true only for expired stories WITH media', () => {
    const expiredTime = new Date('2024-01-01T00:00:00.000Z');
    const now = new Date('2025-01-01T00:00:00.000Z');

    // Expired TEXT story (no media) → false
    const textStory = new Story(textStoryProps({ expiresAt: expiredTime }));
    expect(textStory.shouldCleanup(now)).toBe(false);

    // Expired IMAGE story (has media) → true
    const imgStory = new Story(imageStoryProps({ expiresAt: expiredTime }));
    expect(imgStory.shouldCleanup(now)).toBe(true);

    // Expired VIDEO story (has media) → true
    const vidStory = new Story(videoStoryProps({ expiresAt: expiredTime }));
    expect(vidStory.shouldCleanup(now)).toBe(true);

    // Non-expired IMAGE story → false
    const freshImg = new Story(imageStoryProps());
    expect(freshImg.shouldCleanup(now)).toBe(false);
  });

  it('should handle story construction with pre-existing views', () => {
    const views: StoryViewRecord[] = [
      { userId: 'v1', viewedAt: new Date('2025-06-15T08:00:00.000Z') },
      { userId: 'v2', viewedAt: new Date('2025-06-15T09:00:00.000Z') },
    ];
    const story = new Story(textStoryProps({ views }));

    expect(story.getViewCount()).toBe(2);
    expect(story.hasBeenViewedBy('v1')).toBe(true);
    expect(story.hasBeenViewedBy('v2')).toBe(true);
    expect(story.hasBeenViewedBy('v3')).toBe(false);
  });

  it('should not allow viewing an expired story even with a past now parameter', () => {
    const expiresAt = new Date('2025-06-15T12:00:00.000Z');
    const story = new Story(textStoryProps({ expiresAt }));

    // Inject now = after expiry
    const afterExpiry = new Date('2025-06-15T12:00:01.000Z');
    expect(story.addView('viewer-late', afterExpiry)).toBe(false);
  });

  it('constructor should make a defensive copy of the views array', () => {
    const originalViews: StoryViewRecord[] = [
      { userId: 'v1', viewedAt: new Date() },
    ];
    const story = new Story(textStoryProps({ views: originalViews }));

    // Mutate the original array
    originalViews.push({ userId: 'injected', viewedAt: new Date() });

    // Story's internal views should not be affected
    expect(story.getViewCount()).toBe(1);
    expect(story.hasBeenViewedBy('injected')).toBe(false);
  });

  it('TTL.STORY_EXPIRATION_MS should be exactly 86400000 (24 hours in ms)', () => {
    expect(TTL.STORY_EXPIRATION_MS).toBe(86_400_000);
    expect(TTL.STORY_EXPIRATION_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('getters should expose all StoryProps fields correctly', () => {
    const props = textStoryProps({
      id: 'getter-test-id',
      authorId: 'getter-author',
      authorName: 'Getter Author',
      authorAvatar: 'getter-avatar.png',
      content: 'Getter content',
      backgroundColor: '#AABBCC',
      fontStyle: 'italic',
      duration: 8,
    });
    const story = new Story(props);

    expect(story.id).toBe('getter-test-id');
    expect(story.authorId).toBe('getter-author');
    expect(story.authorName).toBe('Getter Author');
    expect(story.authorAvatar).toBe('getter-avatar.png');
    expect(story.type).toBe(StoryType.TEXT);
    expect(story.content).toBe('Getter content');
    expect(story.mediaUrl).toBeUndefined();
    expect(story.thumbnailUrl).toBeUndefined();
    expect(story.backgroundColor).toBe('#AABBCC');
    expect(story.fontStyle).toBe('italic');
    expect(story.duration).toBe(8);
    expect(story.expiresAt).toEqual(props.expiresAt);
    expect(story.createdAt).toEqual(props.createdAt);
    expect(story.updatedAt).toEqual(props.updatedAt);
  });
});
