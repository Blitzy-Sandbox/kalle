'use client';

// =============================================================================
// StatusPage — Status/Stories Feed & Composer Page
// =============================================================================
//
// Next.js 14 App Router page implementing the WhatsApp Status/Stories feature.
// Maps to Figma Screen 8 (Status Feed, node 0:8498) and Screen 10
// (Status Composer, node 0:9634, file key miK1B6qEPrUnRZ9wwZNrW2).
//
// View State Machine:
//   FEED (default) → COMPOSER (camera/pencil) → FEED (on close/post)
//   FEED            → VIEWER  (story tap)     → FEED (on close)
//
// Data Flow:
//   mount → apiClient.get(/api/v1/stories/feed) + .get(/api/v1/stories/me) → setStoriesFeed + setMyStory
//   socket story events  → addStory / deleteStory / viewStory
//   unmount → clearAll()
//
// Stories are NOT encrypted per Rule R12.
// No mock data — all data comes from live backend (Rule R5).
// =============================================================================

import { useState, useEffect, useCallback } from 'react';

import { useStoryStore } from '@/stores/storyStore';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';
import { useSocket } from '@/hooks/useSocket';

import StatusFeed from '@/components/status/StatusFeed';
import StatusComposer from '@/components/status/StatusComposer';
import StatusViewer from '@/components/status/StatusViewer';
import NavigationBar from '@/components/common/NavigationBar';
import Avatar from '@/components/common/Avatar';

import { apiClient } from '@/lib/api';

import type { StoryResponse, StoryFeedItem } from '@kalle/shared/types/story';

// =============================================================================
// Constants
// =============================================================================

/** Interval for removing client-side expired stories (60 seconds). */
const EXPIRY_CHECK_INTERVAL_MS = 60_000;

// =============================================================================
// StatusPage Component
// =============================================================================

/**
 * StatusPage — orchestrates the Status tab with three view states:
 *
 * 1. **Feed** (default): Renders {@link StatusFeed} showing "My Status",
 *    recent contacts' stories, or an empty state placeholder.
 * 2. **Composer**: Renders {@link StatusComposer} as a fixed overlay for
 *    creating text/photo statuses.
 * 3. **Viewer**: Renders {@link StatusViewer} as a fixed overlay for
 *    viewing stories full-screen with progress bar and auto-advance.
 *
 * The page fetches the story feed from the API on mount, subscribes to
 * real-time story events via Socket.IO, and periodically removes expired
 * stories from the client-side store.
 */
export default function StatusPage(): React.JSX.Element {
  // ===========================================================================
  // Local State
  // ===========================================================================

  /** Controls whether the composer overlay is visible. */
  const [showComposer, setShowComposer] = useState<boolean>(false);

  /** Tracks whether the initial story feed fetch has been attempted. */
  const [hasFetched, setHasFetched] = useState<boolean>(false);

  // ===========================================================================
  // Store Selectors — storyStore
  // ===========================================================================

  const stories = useStoryStore((s) => s.stories);
  const myStory = useStoryStore((s) => s.myStory);
  const isLoadingFeed = useStoryStore((s) => s.isLoadingFeed);
  const activeStoryUserId = useStoryStore((s) => s.activeStoryUserId);

  const setStoriesFeed = useStoryStore((s) => s.setStoriesFeed);
  const addStory = useStoryStore((s) => s.addStory);
  const viewStory = useStoryStore((s) => s.viewStory);
  const deleteStory = useStoryStore((s) => s.deleteStory);
  const removeExpiredStories = useStoryStore((s) => s.removeExpiredStories);
  const setActiveStoryUser = useStoryStore((s) => s.setActiveStoryUser);
  const clearAll = useStoryStore((s) => s.clearAll);
  const setMyStory = useStoryStore((s) => s.setMyStory);

  // ===========================================================================
  // Store Selectors — authStore & uiStore
  // ===========================================================================

  const user = useAuthStore((s) => s.user);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const showToast = useUIStore((s) => s.showToast);

  // ===========================================================================
  // Socket Hook
  // ===========================================================================

  const { socket, isConnected } = useSocket();

  // ===========================================================================
  // Effects
  // ===========================================================================

  /**
   * Effect 1 — Set Active Tab
   *
   * Notifies the UI store that the status tab is active so that sibling
   * components (e.g. badge indicators) can respond to tab context.
   */
  useEffect(() => {
    setActiveTab('status');
  }, [setActiveTab]);

  /**
   * Effect 2 — Fetch Stories Feed on Mount
   *
   * Calls two separate backend endpoints (story.routes.ts):
   * - GET /api/v1/stories/feed  → contacts' grouped story feed
   * - GET /api/v1/stories/me    → current user's own active stories
   *
   * Results are merged: feed goes to storyStore, myStatus used for the
   * "My Status" row in Figma Screen 8.
   *
   * Stories are NOT encrypted (Rule R12) — responses are plaintext.
   * No mock data — all data from live backend (Rule R5).
   */
  useEffect(() => {
    let cancelled = false;

    const fetchStories = async (): Promise<void> => {
      try {
        // Fetch contacts' story feed and current user's stories in parallel
        const [feedResponse, myStoriesResponse] = await Promise.all([
          apiClient.get<{ data: StoryFeedItem[] }>('/api/v1/stories/feed'),
          apiClient.get<{ data: StoryResponse[] }>('/api/v1/stories/me'),
        ]);

        if (cancelled) return;

        // Set the contacts' story feed into the store
        const feed = feedResponse.data ?? feedResponse as unknown as StoryFeedItem[];
        setStoriesFeed(Array.isArray(feed) ? feed : []);

        // Build MyStatusInfo and set into store for the "My Status" row
        const myStoriesList = myStoriesResponse.data ?? myStoriesResponse as unknown as StoryResponse[];
        const activeMyStories = Array.isArray(myStoriesList) ? myStoriesList : [];
        if (activeMyStories.length > 0) {
          const sortedByDate = [...activeMyStories].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          );
          setMyStory({
            hasStatus: true,
            stories: sortedByDate,
            lastUpdated: sortedByDate[sortedByDate.length - 1]?.createdAt,
          });
        }
      } catch {
        if (cancelled) return;
        showToast('Failed to load status updates', 'error');
      } finally {
        if (!cancelled) {
          setHasFetched(true);
        }
      }
    };

    void fetchStories();

    return () => {
      cancelled = true;
    };
  }, [setStoriesFeed, setMyStory, showToast]);

  /**
   * Effect 3 — Periodic Expired Story Removal
   *
   * Runs every 60 seconds to remove client-side stories whose
   * expiresAt timestamp has passed. Stories expire after 24h (R11, R35).
   */
  useEffect(() => {
    const intervalId = setInterval(() => {
      removeExpiredStories();
    }, EXPIRY_CHECK_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [removeExpiredStories]);

  /**
   * Effect 4 — Socket.IO Story Event Subscriptions
   *
   * Subscribes to real-time story events. Story events are not yet
   * included in the shared ServerToClientEvents typed contract —
   * using runtime event names for forward compatibility.
   *
   * Events:
   *  - story:new     — New story posted by a contact
   *  - story:deleted — Story removed by the author
   *  - story:viewed  — Someone viewed the current user's story
   */
  useEffect(() => {
    if (!socket || !isConnected) return;

    // Story events extend the base socket protocol but are not yet
    // in the shared ServerToClientEvents interface. We bind to the
    // underlying EventEmitter which accepts arbitrary event strings
    // at runtime. This is type-safe at the handler level.
    const emitter = socket as unknown as {
      on(event: string, fn: (...args: unknown[]) => void): void;
      off(event: string, fn: (...args: unknown[]) => void): void;
    };

    const handleNewStory = (...args: unknown[]): void => {
      const data = args[0] as StoryResponse | undefined;
      if (data?.id) {
        addStory(data);
      }
    };

    const handleDeletedStory = (...args: unknown[]): void => {
      const data = args[0] as { storyId?: string } | undefined;
      if (data?.storyId) {
        deleteStory(data.storyId);
      }
    };

    const handleViewedStory = (...args: unknown[]): void => {
      const data = args[0] as { storyId?: string } | undefined;
      if (data?.storyId) {
        viewStory(data.storyId);
      }
    };

    emitter.on('story:new', handleNewStory);
    emitter.on('story:deleted', handleDeletedStory);
    emitter.on('story:viewed', handleViewedStory);

    return () => {
      emitter.off('story:new', handleNewStory);
      emitter.off('story:deleted', handleDeletedStory);
      emitter.off('story:viewed', handleViewedStory);
    };
  }, [socket, isConnected, addStory, deleteStory, viewStory]);

  /**
   * Effect 5 — Cleanup on Unmount
   *
   * Resets the storyStore state when the user leaves the status tab,
   * ensuring fresh data on next visit.
   */
  useEffect(() => {
    return () => {
      clearAll();
    };
  }, [clearAll]);

  // ===========================================================================
  // Callbacks
  // ===========================================================================

  /**
   * Closes the composer overlay and returns to the feed view.
   */
  const handleCloseComposer = useCallback((): void => {
    setShowComposer(false);
  }, []);

  /**
   * Handles status creation from the composer.
   * Called by StatusComposer's onPost callback with the content and
   * background color. Refreshes the feed after a successful post.
   *
   * @param content - The text content of the new status
   * @param backgroundColor - The hex color for the status background
   */
  const handleCreateStory = useCallback(
    async (content: string, backgroundColor: string): Promise<void> => {
      try {
        const created = await apiClient.post<StoryResponse>(
          '/api/v1/stories',
          {
            type: 'TEXT' as const,
            content,
            backgroundColor,
          },
        );

        addStory(created);
        setShowComposer(false);
        showToast('Status posted', 'success');
      } catch {
        showToast('Failed to post status', 'error');
      }
    },
    [addStory, showToast],
  );

  /**
   * Closes the story viewer overlay by resetting the active story user.
   * Called by StatusViewer's onClose callback.
   */
  const handleCloseViewer = useCallback((): void => {
    setActiveStoryUser(null);
  }, [setActiveStoryUser]);

  /**
   * Advances to the next user's stories in the viewer.
   * Cycles through the stories array to find the next user with stories.
   */
  const handleNextUser = useCallback((): void => {
    if (!activeStoryUserId || stories.length === 0) return;

    const currentIndex = stories.findIndex(
      (s) => s.userId === activeStoryUserId,
    );
    const nextIndex = currentIndex + 1;

    if (nextIndex < stories.length) {
      setActiveStoryUser(stories[nextIndex].userId);
    } else {
      // No more users — close the viewer
      setActiveStoryUser(null);
    }
  }, [activeStoryUserId, stories, setActiveStoryUser]);

  /**
   * Goes to the previous user's stories in the viewer.
   * Cycles backwards through the stories array.
   */
  const handlePrevUser = useCallback((): void => {
    if (!activeStoryUserId || stories.length === 0) return;

    const currentIndex = stories.findIndex(
      (s) => s.userId === activeStoryUserId,
    );
    const prevIndex = currentIndex - 1;

    if (prevIndex >= 0) {
      setActiveStoryUser(stories[prevIndex].userId);
    }
    // At beginning — do nothing, keep current user
  }, [activeStoryUserId, stories, setActiveStoryUser]);

  /**
   * Deletes a story by ID from the backend and removes it from the local store.
   * Provides keyboard-accessible story deletion when viewing own stories
   * and programmatic deletion support for child components.
   *
   * @param storyId - The ID of the story to delete
   */
  const handleDeleteStory = useCallback(
    async (storyId: string): Promise<void> => {
      try {
        await apiClient.delete(`/api/v1/stories/${storyId}`);
        deleteStory(storyId);
        showToast('Status deleted', 'success');
      } catch {
        showToast('Failed to delete status', 'error');
      }
    },
    [deleteStory, showToast],
  );

  /**
   * Keyboard handler for the story viewer section.
   * Pressing Delete removes the currently viewed story when it belongs
   * to the authenticated user. This is an accessibility-only feature —
   * no visual UI is added (DS2-d compliant).
   */
  const handleViewerKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Delete' && activeStoryUserId === user?.id) {
        const feedItem = stories.find(
          (s) => s.userId === activeStoryUserId,
        );
        const targetStory = feedItem?.stories[0];
        if (targetStory?.id) {
          e.preventDefault();
          void handleDeleteStory(targetStory.id);
        }
      }
    },
    [activeStoryUserId, user?.id, stories, handleDeleteStory],
  );

  // ===========================================================================
  // Render — View State Machine
  // ===========================================================================

  // ── Viewer Overlay (highest priority — covers everything) ──────────────
  // Triggered when StatusFeed's handleStatusItemClick sets activeStoryUserId
  // in the store. The viewer renders as a fixed full-screen overlay (z-50).
  if (activeStoryUserId) {
    return (
      <section
        aria-label="Status"
        className="h-full relative"
        onKeyDown={handleViewerKeyDown}
      >
        {/* Base feed layer (hidden under viewer but kept mounted for state) */}
        <div className="h-full overflow-hidden" aria-hidden="true">
          <StatusFeed />
        </div>

        {/* Full-screen story viewer overlay */}
        <StatusViewer
          userId={activeStoryUserId}
          onClose={handleCloseViewer}
          onNextUser={handleNextUser}
          onPrevUser={handlePrevUser}
        />
      </section>
    );
  }

  // ── Composer Overlay ───────────────────────────────────────────────────
  // Activated when showComposer state is set to true. The composer
  // renders as a fixed full-screen overlay (z-50) with a colored background.
  if (showComposer) {
    return (
      <section
        aria-label="Status"
        className="h-full relative"
      >
        {/* Base feed layer (hidden under composer but kept mounted) */}
        <div className="h-full overflow-hidden" aria-hidden="true">
          <StatusFeed />
        </div>

        {/* Full-screen composer overlay */}
        <StatusComposer
          onClose={handleCloseComposer}
          onPost={handleCreateStory}
        />
      </section>
    );
  }

  // ── Loading Skeleton ──────────────────────────────────────────────────
  // Shown before the initial API fetch completes or while the store
  // signals a re-fetch in progress. Renders a minimal skeleton matching
  // the feed structure: NavigationBar + Avatar placeholder.
  if (!hasFetched || isLoadingFeed) {
    return (
      <section
        aria-label="Status"
        aria-busy="true"
        className="flex flex-col h-full bg-surface"
      >
        <NavigationBar
          title="Status"
          leftAction="Privacy"
        />

        {/* My Status skeleton row */}
        <div className="mt-[35px] bg-white shadow-[0px_-0.33px_0px_0px_rgba(60,60,67,0.29),0px_0.33px_0px_0px_rgba(60,60,67,0.29)]">
          <div className="flex items-center h-[76px] pl-[13px] pr-4">
            <Avatar
              src={user?.avatar ?? undefined}
              alt="My status"
              customSize={58}
            />
            <div className="flex-1 min-w-0 ml-[9px] flex flex-col justify-center">
              <p
                className="font-semibold text-[16px] leading-[1.31em] tracking-[-0.033em] text-black"
              >
                My Status
              </p>
              <p
                className="mt-[4px] font-normal text-[14px] leading-[1.14em] tracking-[-0.015em] text-secondary"
              >
                {myStory?.hasStatus
                  ? `${myStory.stories.length} ${myStory.stories.length === 1 ? 'update' : 'updates'} posted`
                  : 'Add to my status'}
              </p>
            </div>
          </div>
        </div>

        {/* Empty state skeleton */}
        <div className="mt-[35px] bg-white h-[43px] flex items-center justify-center shadow-[0px_-0.33px_0px_0px_rgba(60,60,67,0.29),0px_0.33px_0px_0px_rgba(60,60,67,0.29)]">
          <div className="h-3 w-56 bg-gray-200 rounded animate-pulse" />
        </div>
      </section>
    );
  }

  // ── Default: Feed View (Figma Screen 8) ───────────────────────────────
  // StatusFeed is a self-contained component rendering the full screen:
  // StatusBar → NavigationBar → My Status row → Recent Updates/Empty State.
  // It manages its own layout, ARIA landmarks, and interaction handlers.
  // Communication flows through the storyStore (activeStoryUserId) and
  // direct handler stubs (camera/pencil — to be wired via store in future).
  return (
    <section
      aria-label="Status"
      className="h-full relative"
      aria-live="polite"
    >
      {/* Screen-reader announcement of user status count */}
      {myStory?.hasStatus && (
        <div className="sr-only" role="status">
          {`You have ${myStory.stories.length} active ${myStory.stories.length === 1 ? 'status' : 'statuses'}`}
        </div>
      )}
      <StatusFeed />
    </section>
  );
}
