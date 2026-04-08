/**
 * @module storyStore.test
 *
 * Unit tests for the useStoryStore Zustand store managing story/status state.
 *
 * Organised into 9 test phases:
 *   Phase 1 — Story feed CRUD (setStoriesFeed with R11 expiration filtering)
 *   Phase 2 — Story creation (addStory grouping and re-sorting)
 *   Phase 3 — View tracking (viewStory and hasUnviewed updates)
 *   Phase 4 — Story deletion (deleteStory with group cleanup)
 *   Phase 5 — Expiration filtering (removeExpiredStories — R11)
 *   Phase 6 — Story viewer navigation (nextStory / previousStory cross-user)
 *   Phase 7 — My Status section (setMyStory — Figma Screen 8)
 *   Phase 8 — Encryption verification (R12: stories NOT encrypted)
 *   Phase 9 — Full store reset (clearAll on logout)
 *
 * Rules verified:
 *   R7  — Zero console.log; TypeScript strict mode compatible
 *   R11 — Stories hidden after 24h — client-side expiresAt filtering
 *   R12 — Stories are NOT encrypted — content is plaintext
 *   R28 — Log hygiene (zero console.log in test file)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStoryStore } from '@/stores/storyStore';
import type { StoryResponse, StoryFeedItem, MyStatusInfo } from '@kalle/shared';
import { StoryType } from '@kalle/shared';

// ---------------------------------------------------------------------------
// Test Data Factory Helpers
// ---------------------------------------------------------------------------

/** Monotonically-increasing counter used for unique IDs across factories. */
let idCounter = 0;

/** Creates an ISO 8601 date string N hours in the future from now. */
function futureDate(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
}

/** Creates an ISO 8601 date string N hours in the past from now. */
function pastDate(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
}

/**
 * Creates a valid, non-expired {@link StoryResponse} with sensible defaults.
 * Each call increments `idCounter` to produce unique identifiers.
 */
function createStory(overrides?: Partial<StoryResponse>): StoryResponse {
  idCounter += 1;
  return {
    id: `story-${idCounter}`,
    authorId: `author-${idCounter}`,
    authorName: `Author ${idCounter}`,
    authorAvatar: `https://img.test/a${idCounter}.jpg`,
    type: StoryType.TEXT,
    content: `Story content #${idCounter}`,
    duration: 5,
    viewCount: 0,
    expiresAt: futureDate(24),
    isExpired: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Creates an expired {@link StoryResponse} — expiresAt in the past and
 * isExpired flag set to true. Used for R11 expiration tests.
 */
function createExpiredStory(
  overrides?: Partial<StoryResponse>,
): StoryResponse {
  return createStory({
    expiresAt: pastDate(1),
    isExpired: true,
    ...overrides,
  });
}

/**
 * Creates a {@link StoryFeedItem} group with sensible defaults.
 * When `stories` are provided in overrides they are used directly;
 * otherwise a single active story is auto-generated for the group.
 */
function createStoryFeedItem(
  overrides?: Partial<StoryFeedItem>,
): StoryFeedItem {
  const userId = overrides?.userId ?? `feed-user-${idCounter + 1}`;
  const userName = overrides?.userName ?? `Feed User ${idCounter + 1}`;

  const stories: StoryResponse[] =
    overrides?.stories ?? [
      createStory({ authorId: userId, authorName: userName }),
    ];

  return {
    userId,
    userName,
    userAvatar: `https://img.test/u.jpg`,
    stories,
    hasUnviewed: true,
    latestStoryAt:
      stories.length > 0
        ? stories[stories.length - 1].createdAt
        : new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shorthand — returns the current Zustand snapshot for assertions
// ---------------------------------------------------------------------------

const state = () => useStoryStore.getState();

// ===========================================================================
// Test Suite
// ===========================================================================

describe('storyStore', () => {
  beforeEach(() => {
    idCounter = 0;
    state().clearAll();
  });

  // =========================================================================
  // Phase 1 — Story Feed (setStoriesFeed)
  // =========================================================================

  describe('Phase 1 — setStoriesFeed', () => {
    it('replaces stories array and filters out expired stories (R11: 24h)', () => {
      const activeStory1 = createStory({
        authorId: 'u1',
        authorName: 'U1',
      });
      const activeStory2 = createStory({
        authorId: 'u2',
        authorName: 'U2',
      });
      const expiredStory = createExpiredStory({
        authorId: 'u3',
        authorName: 'U3',
      });

      const item1 = createStoryFeedItem({
        userId: 'u1',
        userName: 'U1',
        stories: [activeStory1],
      });
      const item2 = createStoryFeedItem({
        userId: 'u2',
        userName: 'U2',
        stories: [activeStory2],
      });
      const item3 = createStoryFeedItem({
        userId: 'u3',
        userName: 'U3',
        stories: [expiredStory],
      });

      state().setStoriesFeed([item1, item2, item3]);

      expect(state().stories).toHaveLength(2);
      const userIds = state().stories.map((s) => s.userId);
      expect(userIds).toContain('u1');
      expect(userIds).toContain('u2');
      expect(userIds).not.toContain('u3');
    });

    it('sorts by latestStoryAt descending (most recent first)', () => {
      const storyOld = createStory({
        authorId: 'old',
        authorName: 'Old',
        createdAt: '2025-01-01T00:00:00.000Z',
      });
      const storyMid = createStory({
        authorId: 'mid',
        authorName: 'Mid',
        createdAt: '2025-06-01T00:00:00.000Z',
      });
      const storyNew = createStory({
        authorId: 'new',
        authorName: 'New',
        createdAt: '2025-12-01T00:00:00.000Z',
      });

      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'old',
          userName: 'Old',
          stories: [storyOld],
        }),
        createStoryFeedItem({
          userId: 'new',
          userName: 'New',
          stories: [storyNew],
        }),
        createStoryFeedItem({
          userId: 'mid',
          userName: 'Mid',
          stories: [storyMid],
        }),
      ]);

      expect(state().stories[0].userId).toBe('new');
      expect(state().stories[1].userId).toBe('mid');
      expect(state().stories[2].userId).toBe('old');
    });

    it('updates hasUnviewed flag based on current viewedStoryIds Set', () => {
      const storyA = createStory({
        id: 'story-A',
        authorId: 'u1',
        authorName: 'U1',
      });
      const storyB = createStory({
        id: 'story-B',
        authorId: 'u1',
        authorName: 'U1',
      });
      const storyC = createStory({
        id: 'story-C',
        authorId: 'u2',
        authorName: 'U2',
      });

      // Pre-populate viewedStoryIds with story-A and story-B
      useStoryStore.setState({
        viewedStoryIds: new Set(['story-A', 'story-B']),
      });

      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'u1',
          userName: 'U1',
          stories: [storyA, storyB],
        }),
        createStoryFeedItem({
          userId: 'u2',
          userName: 'U2',
          stories: [storyC],
        }),
      ]);

      const groupU1 = state().stories.find((s) => s.userId === 'u1');
      const groupU2 = state().stories.find((s) => s.userId === 'u2');

      expect(groupU1?.hasUnviewed).toBe(false); // all viewed
      expect(groupU2?.hasUnviewed).toBe(true); // story-C not viewed
    });
  });

  // =========================================================================
  // Phase 2 — addStory
  // =========================================================================

  describe('Phase 2 — addStory', () => {
    it('adds a story to an existing user group in the feed', () => {
      const story1 = createStory({
        authorId: 'user-1',
        authorName: 'User 1',
        createdAt: '2025-01-01T10:00:00.000Z',
      });
      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'user-1',
          userName: 'User 1',
          stories: [story1],
        }),
      ]);

      const story2 = createStory({
        authorId: 'user-1',
        authorName: 'User 1',
        createdAt: '2025-01-01T12:00:00.000Z',
      });
      state().addStory(story2);

      expect(state().stories).toHaveLength(1);
      expect(state().stories[0].stories).toHaveLength(2);
      expect(state().stories[0].latestStoryAt).toBe(
        '2025-01-01T12:00:00.000Z',
      );
    });

    it('creates a new StoryFeedItem group if author not in feed', () => {
      const story1 = createStory({
        authorId: 'user-1',
        authorName: 'User 1',
      });
      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'user-1',
          userName: 'User 1',
          stories: [story1],
        }),
      ]);

      const newStory = createStory({
        authorId: 'user-2',
        authorName: 'User 2',
      });
      state().addStory(newStory);

      expect(state().stories).toHaveLength(2);
      const newGroup = state().stories.find((s) => s.userId === 'user-2');
      expect(newGroup).toBeDefined();
      expect(newGroup!.userName).toBe('User 2');
      expect(newGroup!.stories).toHaveLength(1);
    });

    it('re-sorts the feed by latestStoryAt descending after adding', () => {
      const olderStory = createStory({
        authorId: 'user-old',
        authorName: 'Old',
        createdAt: '2025-01-01T08:00:00.000Z',
      });
      const newerStory = createStory({
        authorId: 'user-new',
        authorName: 'New',
        createdAt: '2025-06-01T08:00:00.000Z',
      });

      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'user-new',
          userName: 'New',
          stories: [newerStory],
          latestStoryAt: '2025-06-01T08:00:00.000Z',
        }),
        createStoryFeedItem({
          userId: 'user-old',
          userName: 'Old',
          stories: [olderStory],
          latestStoryAt: '2025-01-01T08:00:00.000Z',
        }),
      ]);

      // user-new is first
      expect(state().stories[0].userId).toBe('user-new');

      // Add a very recent story for user-old
      const veryRecentStory = createStory({
        authorId: 'user-old',
        authorName: 'Old',
        createdAt: '2025-12-01T08:00:00.000Z',
      });
      state().addStory(veryRecentStory);

      // user-old should now be first (most recent)
      expect(state().stories[0].userId).toBe('user-old');
    });

    it('rejects duplicate story IDs silently', () => {
      const story1 = createStory({
        id: 'dup-id',
        authorId: 'user-1',
        authorName: 'User 1',
      });
      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'user-1',
          userName: 'User 1',
          stories: [story1],
        }),
      ]);

      const duplicate = createStory({
        id: 'dup-id',
        authorId: 'user-1',
        authorName: 'User 1',
      });
      state().addStory(duplicate);

      expect(state().stories[0].stories).toHaveLength(1);
    });
  });

  // =========================================================================
  // Phase 3 — View Tracking (viewStory)
  // =========================================================================

  describe('Phase 3 — viewStory', () => {
    it('adds story ID to the viewedStoryIds Set', () => {
      state().viewStory('story-123');
      expect(state().viewedStoryIds.has('story-123')).toBe(true);
    });

    it('updates hasUnviewed to false when ALL stories in a group are viewed', () => {
      const s1 = createStory({
        id: 'vt-1',
        authorId: 'u1',
        authorName: 'U1',
      });
      const s2 = createStory({
        id: 'vt-2',
        authorId: 'u1',
        authorName: 'U1',
      });

      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'u1',
          userName: 'U1',
          stories: [s1, s2],
          hasUnviewed: true,
        }),
      ]);

      state().viewStory('vt-1');
      expect(
        state().stories.find((s) => s.userId === 'u1')!.hasUnviewed,
      ).toBe(true);

      state().viewStory('vt-2');
      expect(
        state().stories.find((s) => s.userId === 'u1')!.hasUnviewed,
      ).toBe(false);
    });

    it('keeps hasUnviewed true if any stories remain unviewed', () => {
      const s1 = createStory({
        id: 'vu-1',
        authorId: 'u1',
        authorName: 'U1',
      });
      const s2 = createStory({
        id: 'vu-2',
        authorId: 'u1',
        authorName: 'U1',
      });
      const s3 = createStory({
        id: 'vu-3',
        authorId: 'u1',
        authorName: 'U1',
      });

      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'u1',
          userName: 'U1',
          stories: [s1, s2, s3],
          hasUnviewed: true,
        }),
      ]);

      state().viewStory('vu-1');
      state().viewStory('vu-2');

      expect(
        state().stories.find((s) => s.userId === 'u1')!.hasUnviewed,
      ).toBe(true);
    });
  });

  // =========================================================================
  // Phase 4 — Story Deletion (deleteStory)
  // =========================================================================

  describe('Phase 4 — deleteStory', () => {
    it('removes the story from its user group', () => {
      const s1 = createStory({
        id: 'del-1',
        authorId: 'u1',
        authorName: 'U1',
      });
      const s2 = createStory({
        id: 'del-2',
        authorId: 'u1',
        authorName: 'U1',
      });

      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'u1',
          userName: 'U1',
          stories: [s1, s2],
        }),
      ]);

      state().deleteStory('del-1');

      const group = state().stories.find((s) => s.userId === 'u1');
      expect(group).toBeDefined();
      expect(group!.stories).toHaveLength(1);
      expect(group!.stories[0].id).toBe('del-2');
    });

    it('removes the entire group if it becomes empty', () => {
      const s1 = createStory({
        id: 'single-del',
        authorId: 'u1',
        authorName: 'U1',
      });
      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'u1',
          userName: 'U1',
          stories: [s1],
        }),
      ]);

      expect(state().stories).toHaveLength(1);

      state().deleteStory('single-del');

      expect(state().stories).toHaveLength(0);
    });

    it('removes the story ID from viewedStoryIds if present', () => {
      const s1 = createStory({
        id: 'viewed-del',
        authorId: 'u1',
        authorName: 'U1',
      });
      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'u1',
          userName: 'U1',
          stories: [s1],
        }),
      ]);

      state().viewStory('viewed-del');
      expect(state().viewedStoryIds.has('viewed-del')).toBe(true);

      state().deleteStory('viewed-del');
      expect(state().viewedStoryIds.has('viewed-del')).toBe(false);
    });
  });

  // =========================================================================
  // Phase 5 — Expiration (R11: stories hidden after 24h)
  // =========================================================================

  describe('Phase 5 — removeExpiredStories (R11)', () => {
    it('filters out stories where expiresAt < now', () => {
      const active1 = createStory({
        id: 'active-1',
        authorId: 'u1',
        authorName: 'U1',
        expiresAt: futureDate(12),
        isExpired: false,
      });
      const expired1 = createExpiredStory({
        id: 'expired-1',
        authorId: 'u1',
        authorName: 'U1',
      });
      const expired2 = createExpiredStory({
        id: 'expired-2',
        authorId: 'u2',
        authorName: 'U2',
      });

      // Inject directly via setState to bypass setStoriesFeed filtering
      useStoryStore.setState({
        stories: [
          createStoryFeedItem({
            userId: 'u1',
            userName: 'U1',
            stories: [active1, expired1],
          }),
          createStoryFeedItem({
            userId: 'u2',
            userName: 'U2',
            stories: [expired2],
          }),
        ],
      });

      state().removeExpiredStories();

      // Group u1 should have only the active story
      const groupU1 = state().stories.find((s) => s.userId === 'u1');
      expect(groupU1).toBeDefined();
      expect(groupU1!.stories).toHaveLength(1);
      expect(groupU1!.stories[0].id).toBe('active-1');

      // Group u2 should be completely removed (had only expired stories)
      const groupU2 = state().stories.find((s) => s.userId === 'u2');
      expect(groupU2).toBeUndefined();
    });

    it('removes empty groups after filtering expired stories', () => {
      const expired = createExpiredStory({
        id: 'exp-only',
        authorId: 'u1',
        authorName: 'U1',
      });

      useStoryStore.setState({
        stories: [
          createStoryFeedItem({
            userId: 'u1',
            userName: 'U1',
            stories: [expired],
          }),
        ],
      });

      state().removeExpiredStories();

      expect(state().stories).toHaveLength(0);
    });
  });

  // =========================================================================
  // Phase 6 — Navigation (Story Viewer)
  // =========================================================================

  describe('Phase 6 — setActiveStoryUser / setActiveStoryIndex', () => {
    it('setActiveStoryUser sets userId and resets activeStoryIndex to 0', () => {
      state().setActiveStoryIndex(5);
      state().setActiveStoryUser('user-1');

      expect(state().activeStoryUserId).toBe('user-1');
      expect(state().activeStoryIndex).toBe(0);
    });

    it('setActiveStoryIndex sets the current story index', () => {
      state().setActiveStoryIndex(2);
      expect(state().activeStoryIndex).toBe(2);
    });
  });

  describe('Phase 6 — nextStory / previousStory', () => {
    /**
     * Helper to set up a multi-user feed for navigation tests.
     * user-A has 2 stories; user-B has 1 story.
     */
    function setupNavigationFeed() {
      const sA1 = createStory({
        id: 'nav-a1',
        authorId: 'user-A',
        authorName: 'A',
        createdAt: '2025-06-01T10:00:00.000Z',
      });
      const sA2 = createStory({
        id: 'nav-a2',
        authorId: 'user-A',
        authorName: 'A',
        createdAt: '2025-06-01T11:00:00.000Z',
      });
      const sB1 = createStory({
        id: 'nav-b1',
        authorId: 'user-B',
        authorName: 'B',
        createdAt: '2025-06-01T09:00:00.000Z',
      });

      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'user-A',
          userName: 'A',
          stories: [sA1, sA2],
          latestStoryAt: '2025-06-01T11:00:00.000Z',
        }),
        createStoryFeedItem({
          userId: 'user-B',
          userName: 'B',
          stories: [sB1],
          latestStoryAt: '2025-06-01T09:00:00.000Z',
        }),
      ]);
    }

    it('nextStory advances within active user stories', () => {
      setupNavigationFeed();
      state().setActiveStoryUser('user-A');
      state().setActiveStoryIndex(0);

      const result1 = state().nextStory();
      expect(result1).toBe(true);
      expect(state().activeStoryIndex).toBe(1);

      // Still on user-A, now at index 1 (last story)
      expect(state().activeStoryUserId).toBe('user-A');
    });

    it('nextStory advances to next user when at end of current user stories', () => {
      setupNavigationFeed();
      state().setActiveStoryUser('user-A');
      state().setActiveStoryIndex(1); // last story of user-A

      const result = state().nextStory();
      expect(result).toBe(true);
      expect(state().activeStoryUserId).toBe('user-B');
      expect(state().activeStoryIndex).toBe(0);
    });

    it('nextStory returns false at end of entire feed', () => {
      setupNavigationFeed();
      state().setActiveStoryUser('user-B');
      state().setActiveStoryIndex(0); // last user, only story

      const result = state().nextStory();
      expect(result).toBe(false);
    });

    it('previousStory goes back within current user stories', () => {
      setupNavigationFeed();
      state().setActiveStoryUser('user-A');
      state().setActiveStoryIndex(1);

      const result = state().previousStory();
      expect(result).toBe(true);
      expect(state().activeStoryIndex).toBe(0);
      expect(state().activeStoryUserId).toBe('user-A');
    });

    it('previousStory goes to previous user last story when at beginning', () => {
      setupNavigationFeed();
      state().setActiveStoryUser('user-B');
      state().setActiveStoryIndex(0);

      const result = state().previousStory();
      expect(result).toBe(true);
      expect(state().activeStoryUserId).toBe('user-A');
      // user-A has 2 stories, so last index is 1
      expect(state().activeStoryIndex).toBe(1);
    });

    it('previousStory returns false at very beginning of feed', () => {
      setupNavigationFeed();
      state().setActiveStoryUser('user-A');
      state().setActiveStoryIndex(0);

      const result = state().previousStory();
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // Phase 7 — My Status (setMyStory — Figma Screen 8)
  // =========================================================================

  describe('Phase 7 — setMyStory', () => {
    it('sets the current user status info (Figma Screen 8)', () => {
      const story1 = createStory({
        authorId: 'me',
        authorName: 'Me',
      });
      const now = new Date().toISOString();

      const myStatus: MyStatusInfo = {
        hasStatus: true,
        stories: [story1],
        lastUpdated: now,
      };

      state().setMyStory(myStatus);

      expect(state().myStory).toBeDefined();
      expect(state().myStory!.hasStatus).toBe(true);
      expect(state().myStory!.stories).toHaveLength(1);
      expect(state().myStory!.lastUpdated).toBe(now);
    });

    it('filters out expired stories from myStory.stories (R11)', () => {
      const active = createStory({
        id: 'my-active',
        authorId: 'me',
        authorName: 'Me',
        expiresAt: futureDate(12),
        isExpired: false,
      });
      const expired = createExpiredStory({
        id: 'my-expired',
        authorId: 'me',
        authorName: 'Me',
      });

      state().setMyStory({
        hasStatus: true,
        stories: [active, expired],
        lastUpdated: new Date().toISOString(),
      });

      expect(state().myStory).toBeDefined();
      // Only active stories should remain
      const myStories = state().myStory!.stories;
      expect(myStories).toHaveLength(1);
      expect(myStories[0].id).toBe('my-active');
    });
  });

  // =========================================================================
  // Phase 8 — Encryption Verification (R12: stories NOT encrypted)
  // =========================================================================

  describe('Phase 8 — R12: Stories NOT encrypted', () => {
    it('stories store plaintext content — no encryption fields', () => {
      const story = createStory({
        authorId: 'u1',
        authorName: 'U1',
        content: 'Hello, this is a plaintext status update',
        type: StoryType.TEXT,
      });

      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'u1',
          userName: 'U1',
          stories: [story],
        }),
      ]);

      const storedStory = state().stories[0].stories[0];

      // Content is plaintext — R12 explicitly states stories are NOT encrypted
      expect(storedStory.content).toBe(
        'Hello, this is a plaintext status update',
      );

      // Verify no encryption-related fields exist on the story object
      const storyObj = storedStory as unknown as Record<string, unknown>;
      expect(storyObj['ciphertext']).toBeUndefined();
      expect(storyObj['encryptionKey']).toBeUndefined();
      expect(storyObj['encryptionIv']).toBeUndefined();
    });
  });

  // =========================================================================
  // Phase 9 — clearAll + setIsLoadingFeed
  // =========================================================================

  describe('Phase 9 — clearAll', () => {
    it('resets entire store to initial state', () => {
      // Populate the store with data across multiple state slices
      const story1 = createStory({
        authorId: 'u1',
        authorName: 'U1',
      });
      state().setStoriesFeed([
        createStoryFeedItem({
          userId: 'u1',
          userName: 'U1',
          stories: [story1],
        }),
      ]);
      state().setMyStory({
        hasStatus: true,
        stories: [story1],
        lastUpdated: new Date().toISOString(),
      });
      state().viewStory('some-id');
      state().setActiveStoryUser('u1');
      state().setActiveStoryIndex(3);
      state().setIsLoadingFeed(true);

      // Verify populated state before clearAll
      expect(state().stories).not.toHaveLength(0);
      expect(state().myStory).not.toBeNull();
      expect(state().viewedStoryIds.size).toBeGreaterThan(0);
      expect(state().activeStoryUserId).not.toBeNull();
      expect(state().isLoadingFeed).toBe(true);

      // Clear all state
      state().clearAll();

      // Verify full reset
      expect(state().stories).toEqual([]);
      expect(state().myStory).toBeNull();
      expect(state().viewedStoryIds.size).toBe(0);
      expect(state().activeStoryUserId).toBeNull();
      expect(state().activeStoryIndex).toBe(0);
      expect(state().isLoadingFeed).toBe(false);
    });
  });

  describe('Phase 9 — setIsLoadingFeed', () => {
    it('sets isLoadingFeed to true', () => {
      state().setIsLoadingFeed(true);
      expect(state().isLoadingFeed).toBe(true);
    });

    it('sets isLoadingFeed to false', () => {
      state().setIsLoadingFeed(true);
      state().setIsLoadingFeed(false);
      expect(state().isLoadingFeed).toBe(false);
    });
  });
});
