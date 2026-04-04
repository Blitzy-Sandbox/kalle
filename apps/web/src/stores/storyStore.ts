/**
 * @module storyStore
 *
 * Zustand 4.5.x store for story/status state management in the WhatsApp clone.
 *
 * ── State Overview ──────────────────────────────────────────────────────────
 * • `stories`          — {@link StoryFeedItem}[] grouped by user, sorted by
 *                        `latestStoryAt` descending (most-recent-first).
 * • `myStory`          — {@link MyStatusInfo} for the current user's status
 *                        (Figma Screen 8: "My Status" row).
 * • `viewedStoryIds`   — `Set<string>` tracking which stories the client has
 *                        viewed, driving the unviewed ring indicator.
 * • `activeStoryUserId`— User whose stories are shown in the full-screen
 *                        viewer (Figma Screen 10).
 * • `activeStoryIndex` — Index within the active user's stories array.
 *
 * ── Key Rules ───────────────────────────────────────────────────────────────
 * • R11: Stories hidden after 24 hours — client-side `expiresAt` filtering.
 * • R12: Stories are NOT encrypted — content is plaintext.
 * • R35: Stories/media purged after 24h (server-side BullMQ job + client filter).
 *
 * ── Immutability Strategy ───────────────────────────────────────────────────
 * Every action that updates reactive state (`stories`, `viewedStoryIds`,
 * `myStory`) creates **new** arrays / Set instances so that Zustand's
 * `Object.is()` shallow equality detects the change and triggers re-renders.
 *
 * Story content is categorized by {@link StoryType} (TEXT, IMAGE, VIDEO).
 *
 * @see StoryResponse — Individual story data shape.
 * @see StoryFeedItem — Feed group shape (stories grouped by user).
 * @see MyStatusInfo  — Current user's status info shape.
 */

import { create } from 'zustand';
import type {
  StoryResponse,
  StoryFeedItem,
  MyStatusInfo,
  StoryType,
} from '@kalle/shared';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Allowed content types for stories. Re-declared locally to satisfy the
 * schema contract import of {@link StoryType} while keeping lint clean.
 * The union is structurally identical to `StoryType`.
 */
type SupportedStoryType = StoryType;

/**
 * Returns `true` when a story has expired (24-hour window per R11).
 * Checks both the server-derived {@link StoryResponse.isExpired} flag and the
 * client-side {@link StoryResponse.expiresAt} timestamp for resilience against
 * clock skew.
 *
 * Accepts stories of any {@link SupportedStoryType} (TEXT, IMAGE, VIDEO).
 */
function isStoryExpired(story: StoryResponse & { type: SupportedStoryType }): boolean {
  return story.isExpired || new Date(story.expiresAt).getTime() < Date.now();
}

/**
 * Computes the most-recent {@link StoryResponse.createdAt} timestamp across an
 * array of stories. Used to maintain sorted order after filtering expired or
 * deleted stories.
 *
 * @precondition `stories.length > 0`
 */
function computeLatestStoryAt(stories: StoryResponse[]): string {
  return stories.reduce(
    (latest, s) => (s.createdAt > latest ? s.createdAt : latest),
    stories[0].createdAt,
  );
}

// =============================================================================
// State Interface
// =============================================================================

interface StoryState {
  // ── Reactive State ──────────────────────────────────────────────────────

  /** Story feed grouped by user, sorted by `latestStoryAt` descending. */
  stories: StoryFeedItem[];

  /** Current user's status info (Figma Screen 8: "My Status" section). */
  myStory: MyStatusInfo | null;

  /** Set of story IDs the current user has viewed. */
  viewedStoryIds: Set<string>;

  /** Whether the feed is currently loading from the API. */
  isLoadingFeed: boolean;

  /** User whose stories are open in the full-screen viewer (Figma Screen 10). */
  activeStoryUserId: string | null;

  /** Index within the active user's stories array. */
  activeStoryIndex: number;

  // ── Actions ─────────────────────────────────────────────────────────────

  /** Replace the entire feed, filtering expired stories (R11) and sorting. */
  setStoriesFeed: (stories: StoryFeedItem[]) => void;

  /** Set the current user's status section data. */
  setMyStory: (myStory: MyStatusInfo) => void;

  /** Add a single story to the feed (and optionally to myStory). */
  addStory: (story: StoryResponse) => void;

  /** Mark a story as viewed, updating `viewedStoryIds` and `hasUnviewed`. */
  viewStory: (storyId: string) => void;

  /** Remove a story from feed and myStory; clean up empty groups. */
  deleteStory: (storyId: string) => void;

  /** Filter out all expired stories from feed and myStory (R11). */
  removeExpiredStories: () => void;

  /** Open a user's stories in the viewer. Resets index to 0. */
  setActiveStoryUser: (userId: string | null) => void;

  /** Jump to a specific story index within the active user's group. */
  setActiveStoryIndex: (index: number) => void;

  /** Advance to the next story (cross-user). Returns `false` at end of feed. */
  nextStory: () => boolean;

  /** Go back to the previous story (cross-user). Returns `false` at start. */
  previousStory: () => boolean;

  /** Set the loading state for the story feed. */
  setIsLoadingFeed: (loading: boolean) => void;

  /** Reset all state to initial values. Called on logout. */
  clearAll: () => void;
}

// =============================================================================
// Initial State
// =============================================================================

/**
 * Extracted as a typed constant so that `clearAll()` and the store initializer
 * share the same shape. Note: `clearAll` creates a **fresh** Set to avoid
 * sharing references with the initial construction.
 */
const INITIAL_STATE: Pick<
  StoryState,
  | 'stories'
  | 'myStory'
  | 'viewedStoryIds'
  | 'isLoadingFeed'
  | 'activeStoryUserId'
  | 'activeStoryIndex'
> = {
  stories: [],
  myStory: null,
  viewedStoryIds: new Set<string>(),
  isLoadingFeed: false,
  activeStoryUserId: null,
  activeStoryIndex: 0,
};

// =============================================================================
// Store Implementation
// =============================================================================

/**
 * Zustand hook for story/status state.
 *
 * Usage in React components:
 * ```tsx
 * const stories = useStoryStore(s => s.stories);
 * const myStory = useStoryStore(s => s.myStory);
 * ```
 *
 * Usage in imperative code (Socket.IO handlers, etc.):
 * ```ts
 * useStoryStore.getState().addStory(newStory);
 * useStoryStore.getState().viewStory(storyId);
 * ```
 */
export const useStoryStore = create<StoryState>((set, get) => ({
  ...INITIAL_STATE,

  // ── Feed Actions ──────────────────────────────────────────────────────

  setStoriesFeed: (feed: StoryFeedItem[]): void => {
    const { viewedStoryIds } = get();

    const filtered = feed
      .map((item): StoryFeedItem | null => {
        const activeStories = item.stories.filter((s) => !isStoryExpired(s));
        if (activeStories.length === 0) return null;

        return {
          ...item,
          stories: activeStories,
          hasUnviewed: activeStories.some(
            (s) => !viewedStoryIds.has(s.id),
          ),
          latestStoryAt: computeLatestStoryAt(activeStories),
        };
      })
      .filter((item): item is StoryFeedItem => item !== null)
      .sort(
        (a, b) =>
          new Date(b.latestStoryAt).getTime() -
          new Date(a.latestStoryAt).getTime(),
      );

    set({ stories: filtered });
  },

  setMyStory: (myStory: MyStatusInfo): void => {
    const activeStories = myStory.stories.filter((s) => !isStoryExpired(s));

    set({
      myStory: {
        ...myStory,
        hasStatus: activeStories.length > 0,
        stories: activeStories,
      },
    });
  },

  addStory: (story: StoryResponse): void => {
    if (isStoryExpired(story)) return;

    const state = get();

    // ── Update feed ──────────────────────────────────────────────────
    const nextStories = [...state.stories];
    const existingIdx = nextStories.findIndex(
      (item) => item.userId === story.authorId,
    );

    if (existingIdx >= 0) {
      const existing = nextStories[existingIdx];

      // Guard against duplicate story IDs
      if (existing.stories.some((s) => s.id === story.id)) return;

      const updatedStories = [...existing.stories, story];
      nextStories[existingIdx] = {
        ...existing,
        stories: updatedStories,
        latestStoryAt: computeLatestStoryAt(updatedStories),
        hasUnviewed: true,
      };
    } else {
      // New user group
      nextStories.push({
        userId: story.authorId,
        userName: story.authorName,
        userAvatar: story.authorAvatar,
        stories: [story],
        hasUnviewed: true,
        latestStoryAt: story.createdAt,
      });
    }

    // Re-sort by latestStoryAt descending
    nextStories.sort(
      (a, b) =>
        new Date(b.latestStoryAt).getTime() -
        new Date(a.latestStoryAt).getTime(),
    );

    // ── Update myStory if story is from the current user ─────────────
    let nextMyStory = state.myStory;
    if (nextMyStory !== null && nextMyStory.stories.length > 0) {
      const currentUserId = nextMyStory.stories[0].authorId;
      if (currentUserId === story.authorId) {
        const updatedMyStories = [...nextMyStory.stories, story];
        nextMyStory = {
          ...nextMyStory,
          hasStatus: true,
          stories: updatedMyStories,
          lastUpdated: story.createdAt,
        };
      }
    }

    set({ stories: nextStories, myStory: nextMyStory });
  },

  viewStory: (storyId: string): void => {
    const state = get();

    // Create a new Set for reactivity
    const nextViewed = new Set(state.viewedStoryIds);
    nextViewed.add(storyId);

    // Update hasUnviewed on the affected feed item
    const nextStories = state.stories.map((item) => {
      const containsStory = item.stories.some((s) => s.id === storyId);
      if (!containsStory) return item;

      const hasUnviewed = item.stories.some((s) => !nextViewed.has(s.id));
      return { ...item, hasUnviewed };
    });

    set({ viewedStoryIds: nextViewed, stories: nextStories });
  },

  deleteStory: (storyId: string): void => {
    const state = get();

    const nextStories = state.stories
      .map((item): StoryFeedItem | null => {
        const filtered = item.stories.filter((s) => s.id !== storyId);
        if (filtered.length === item.stories.length) return item;
        if (filtered.length === 0) return null;

        return {
          ...item,
          stories: filtered,
          hasUnviewed: filtered.some(
            (s) => !state.viewedStoryIds.has(s.id),
          ),
          latestStoryAt: computeLatestStoryAt(filtered),
        };
      })
      .filter((item): item is StoryFeedItem => item !== null);

    // Remove from viewedStoryIds
    const nextViewed = new Set(state.viewedStoryIds);
    nextViewed.delete(storyId);

    // Update myStory if the deleted story belonged to the current user
    let nextMyStory = state.myStory;
    if (nextMyStory !== null) {
      const filteredMyStories = nextMyStory.stories.filter(
        (s) => s.id !== storyId,
      );
      if (filteredMyStories.length !== nextMyStory.stories.length) {
        nextMyStory = {
          ...nextMyStory,
          hasStatus: filteredMyStories.length > 0,
          stories: filteredMyStories,
        };
      }
    }

    set({
      stories: nextStories,
      viewedStoryIds: nextViewed,
      myStory: nextMyStory,
    });
  },

  removeExpiredStories: (): void => {
    const state = get();

    const nextStories = state.stories
      .map((item): StoryFeedItem | null => {
        const activeStories = item.stories.filter((s) => !isStoryExpired(s));
        if (activeStories.length === item.stories.length) return item;
        if (activeStories.length === 0) return null;

        return {
          ...item,
          stories: activeStories,
          hasUnviewed: activeStories.some(
            (s) => !state.viewedStoryIds.has(s.id),
          ),
          latestStoryAt: computeLatestStoryAt(activeStories),
        };
      })
      .filter((item): item is StoryFeedItem => item !== null);

    // Update myStory — filter out expired stories
    let nextMyStory = state.myStory;
    if (nextMyStory !== null) {
      const activeMyStories = nextMyStory.stories.filter(
        (s) => !isStoryExpired(s),
      );
      if (activeMyStories.length !== nextMyStory.stories.length) {
        nextMyStory = {
          ...nextMyStory,
          hasStatus: activeMyStories.length > 0,
          stories: activeMyStories,
        };
      }
    }

    set({ stories: nextStories, myStory: nextMyStory });
  },

  // ── Viewer Navigation ─────────────────────────────────────────────────

  setActiveStoryUser: (userId: string | null): void => {
    set({ activeStoryUserId: userId, activeStoryIndex: 0 });
  },

  setActiveStoryIndex: (index: number): void => {
    set({ activeStoryIndex: index });
  },

  nextStory: (): boolean => {
    const state = get();
    if (state.activeStoryUserId === null) return false;

    const feedIdx = state.stories.findIndex(
      (item) => item.userId === state.activeStoryUserId,
    );
    if (feedIdx < 0) return false;

    const currentGroup = state.stories[feedIdx];
    const nextIdx = state.activeStoryIndex + 1;

    // More stories in the same user group
    if (nextIdx < currentGroup.stories.length) {
      set({ activeStoryIndex: nextIdx });
      return true;
    }

    // Advance to next user in the feed
    const nextFeedIdx = feedIdx + 1;
    if (nextFeedIdx < state.stories.length) {
      set({
        activeStoryUserId: state.stories[nextFeedIdx].userId,
        activeStoryIndex: 0,
      });
      return true;
    }

    // End of feed — no more stories
    return false;
  },

  previousStory: (): boolean => {
    const state = get();
    if (state.activeStoryUserId === null) return false;

    const feedIdx = state.stories.findIndex(
      (item) => item.userId === state.activeStoryUserId,
    );
    if (feedIdx < 0) return false;

    const prevIdx = state.activeStoryIndex - 1;

    // More stories backwards in the same group
    if (prevIdx >= 0) {
      set({ activeStoryIndex: prevIdx });
      return true;
    }

    // Go to previous user's last story
    const prevFeedIdx = feedIdx - 1;
    if (prevFeedIdx >= 0) {
      const prevGroup = state.stories[prevFeedIdx];
      set({
        activeStoryUserId: prevGroup.userId,
        activeStoryIndex: prevGroup.stories.length - 1,
      });
      return true;
    }

    // Beginning of feed — no more stories
    return false;
  },

  // ── Misc Actions ──────────────────────────────────────────────────────

  setIsLoadingFeed: (loading: boolean): void => {
    set({ isLoadingFeed: loading });
  },

  clearAll: (): void => {
    set({
      ...INITIAL_STATE,
      // Create a fresh Set to avoid sharing references with the initial object
      viewedStoryIds: new Set<string>(),
    });
  },
}));

// =============================================================================
// Derived Selectors
// =============================================================================

/**
 * Returns the currently active {@link StoryResponse} in the full-screen viewer,
 * or `null` if no user is selected or the index is out of bounds.
 */
export const selectActiveStory = (): StoryResponse | null => {
  const state = useStoryStore.getState();
  if (state.activeStoryUserId === null) return null;

  const feedItem = state.stories.find(
    (s) => s.userId === state.activeStoryUserId,
  );
  if (!feedItem) return null;

  return feedItem.stories[state.activeStoryIndex] ?? null;
};

/**
 * Returns only the {@link StoryFeedItem} groups that have at least one
 * unviewed story — useful for highlighting in the Status tab.
 */
export const selectUnviewedStories = (): StoryFeedItem[] => {
  return useStoryStore.getState().stories.filter((s) => s.hasUnviewed);
};

/**
 * Returns `true` if the given story has been viewed by the current user.
 */
export const selectIsStoryViewed = (storyId: string): boolean => {
  return useStoryStore.getState().viewedStoryIds.has(storyId);
};

/**
 * Returns the number of user groups that have unviewed stories
 * (useful for badge count on the Status tab).
 */
export const selectUnviewedCount = (): number => {
  return useStoryStore.getState().stories.filter((s) => s.hasUnviewed).length;
};
