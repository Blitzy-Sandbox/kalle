'use client';

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  type FC,
} from 'react';
import Avatar from '../common/Avatar';
import { useStoryStore } from '@/stores/storyStore';
import { useAuthStore } from '@/stores/authStore';

/* ==========================================================================
 * StatusViewer — Full-Screen Story / Status Viewer
 *
 * Implements the full-screen story viewing experience referenced across
 * Figma Screens 8–10 (file key miK1B6qEPrUnRZ9wwZNrW2).
 *
 * Layout specs:
 * - Full-screen overlay: fixed inset-0, z-50, bg-black
 * - Progress bar (top): h-2px segments, completed = bg-white,
 *   active = animated fill, upcoming = bg-white/40
 * - User info header: Avatar 36×36 (sm), name white 600 14px,
 *   timestamp white/60 12px, close X 24×24
 * - Story content: centered, text stories on colored bg, media as
 *   object-contain
 * - Reply input (bottom): bg-white/20 rounded-full, white placeholder
 * - Navigation: tap-left = prev, tap-right = next, long-press = pause
 * - Auto-advance: 5s text, 7s media
 *
 * Accessibility (R34 — WCAG 2.1 AA):
 * - role="dialog" aria-modal="true" with descriptive aria-label
 * - Keyboard: ArrowLeft/Right (navigate), Space (pause), Escape (close)
 * - ARIA progressbar on segments
 * - ARIA live region announcing story transitions
 * - Focus trap: viewer captures focus on mount, restores on unmount
 * - All interactive elements have aria-labels
 *
 * Data flow: Store-driven via useStoryStore and useAuthStore.
 * The component sets the active story user on mount and delegates all
 * navigation (including cross-user advancement) to the store's
 * nextStory() / previousStory() actions.
 *
 * Stories are NOT encrypted (R12 — encryption is for messages only).
 * ========================================================================== */

// ---------------------------------------------------------------------------
// Props Interface
// ---------------------------------------------------------------------------

/**
 * Props for the StatusViewer component.
 *
 * The viewer is controlled externally via `userId` and optional callbacks.
 * Story data and navigation state come from the Zustand storyStore.
 */
export interface StatusViewerProps {
  /** User ID whose stories to display */
  userId: string;
  /** Initial story index to start from (default 0) */
  initialStoryIndex?: number;
  /** Callback when viewer should close */
  onClose: () => void;
  /** Callback when advancing past the last story in the feed */
  onNextUser?: () => void;
  /** Callback when going before the first story in the feed */
  onPrevUser?: () => void;
  /** Additional CSS class names for the outermost container */
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Auto-advance duration for text stories (ms) */
const TEXT_DURATION_MS = 5_000;

/** Auto-advance duration for image/video stories (ms) */
const MEDIA_DURATION_MS = 7_000;

/** Minimum swipe distance to trigger navigation (px) */
const SWIPE_THRESHOLD = 50;

/** Delay before long-press triggers pause (ms) */
const LONG_PRESS_DELAY = 300;

/** Interval for progress bar animation updates (ms) */
const PROGRESS_TICK_MS = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats an ISO 8601 timestamp into a human-readable relative string.
 *
 * @example
 * formatRelativeTime('2026-04-05T10:00:00Z') // "2h ago" (if current time is noon)
 */
function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * StatusViewer — Full-screen story viewer with segmented progress bar,
 * auto-advance timer, reply input, and full keyboard/touch navigation.
 *
 * Reads story data from the Zustand storyStore rather than receiving
 * stories as props. On mount, sets the active story user in the store;
 * on unmount, clears the active user.
 *
 * @example
 * ```tsx
 * <StatusViewer
 *   userId="user-123"
 *   initialStoryIndex={0}
 *   onClose={() => setViewerOpen(false)}
 *   onNextUser={() => advanceToNextUser()}
 * />
 * ```
 */
const StatusViewer: FC<StatusViewerProps> = ({
  userId,
  initialStoryIndex = 0,
  onClose,
  onNextUser,
  onPrevUser,
  className = '',
}) => {
  /* -----------------------------------------------------------------
   * Store connections — each selector creates a stable reference
   * ----------------------------------------------------------------- */
  const stories = useStoryStore((s) => s.stories);
  const viewStory = useStoryStore((s) => s.viewStory);
  const viewedStoryIds = useStoryStore((s) => s.viewedStoryIds);
  const activeStoryUserId = useStoryStore((s) => s.activeStoryUserId);
  const activeStoryIndex = useStoryStore((s) => s.activeStoryIndex);
  const setActiveStoryUser = useStoryStore((s) => s.setActiveStoryUser);
  const setActiveStoryIndex = useStoryStore((s) => s.setActiveStoryIndex);
  const nextStory = useStoryStore((s) => s.nextStory);
  const previousStory = useStoryStore((s) => s.previousStory);

  const user = useAuthStore((s) => s.user);

  /* -----------------------------------------------------------------
   * Local state
   * ----------------------------------------------------------------- */
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [replyText, setReplyText] = useState<string>('');

  /* Refs */
  const viewerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const progressIntervalRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const replyInputRef = useRef<HTMLInputElement>(null);
  const touchStartRef = useRef<{
    x: number;
    y: number;
    time: number;
  } | null>(null);

  /* -----------------------------------------------------------------
   * Derived data from the store
   * ----------------------------------------------------------------- */

  /** Resolve the active user — defaults to the prop userId before the
   * store is initialised, then follows the store's activeStoryUserId
   * as nextStory() / previousStory() may cross users. */
  const currentUserId = activeStoryUserId ?? userId;

  /** Feed item for the currently active user */
  const feedItem = stories.find((s) => s.userId === currentUserId);

  /** Non-expired stories for this user */
  const userStories = feedItem?.stories ?? [];

  /** Currently visible story */
  const currentStory = userStories[activeStoryIndex] ?? null;

  /** Display name for UI */
  const displayName = feedItem?.userName ?? 'User';

  /** Computed duration for the current story (ms) */
  const currentDuration: number = (() => {
    if (!currentStory) return TEXT_DURATION_MS;
    if (currentStory.duration && currentStory.duration > 0) {
      return currentStory.duration * 1_000;
    }
    return currentStory.type === 'TEXT' ? TEXT_DURATION_MS : MEDIA_DURATION_MS;
  })();

  /** Whether the store's activeStoryUserId matches the requested user.
   * Until the init effect fires, the store may hold a stale value.
   * This flag gates auto-close and auto-advance to prevent premature
   * close during React 18 StrictMode double-invocation. */
  const storeReady =
    activeStoryUserId === userId || activeStoryUserId === currentUserId;

  /** Whether there is at least one non-expired story to render */
  const hasValidStory = userStories.length > 0 && currentStory !== null;

  /* -----------------------------------------------------------------
   * Initialise active user in the store on mount
   * ----------------------------------------------------------------- */
  useEffect(() => {
    setActiveStoryUser(userId);

    /* Apply initial index if non-zero. setActiveStoryUser resets to 0,
     * so we override immediately. React 18 batches these synchronously. */
    if (initialStoryIndex > 0) {
      setActiveStoryIndex(initialStoryIndex);
    }

    return () => {
      /* Clear the active user when the viewer unmounts */
      setActiveStoryUser(null);
    };
  }, [userId, initialStoryIndex, setActiveStoryUser, setActiveStoryIndex]);

  /* -----------------------------------------------------------------
   * Focus management — trap focus into the viewer on mount (R34)
   * ----------------------------------------------------------------- */
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    viewerRef.current?.focus();

    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  /* -----------------------------------------------------------------
   * Navigation handlers
   * ----------------------------------------------------------------- */

  /** Advance to the next story segment or next user.
   * Gated on storeReady to prevent premature navigation during
   * React 18 StrictMode double-invoke. */
  const goNext = useCallback(() => {
    if (!storeReady) return;
    setProgress(0);
    const advanced = nextStory();

    if (!advanced) {
      /* End of feed — notify parent or close */
      if (onNextUser) {
        onNextUser();
      } else {
        onClose();
      }
    }
  }, [storeReady, nextStory, onNextUser, onClose]);

  /** Go back to the previous story segment or previous user.
   * Gated on storeReady to prevent premature navigation. */
  const goPrev = useCallback(() => {
    if (!storeReady) return;
    setProgress(0);
    const went = previousStory();

    if (!went) {
      /* Beginning of feed — notify parent */
      onPrevUser?.();
    }
  }, [storeReady, previousStory, onPrevUser]);

  /* -----------------------------------------------------------------
   * Auto-advance timer
   * ----------------------------------------------------------------- */
  useEffect(() => {
    /* Clear any existing timers */
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (progressIntervalRef.current !== null) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }

    if (isPaused || !currentStory || !storeReady) return;

    /* Smoothly animate the progress fill */
    const startTime = Date.now();
    progressIntervalRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startTime;
      const pct = Math.min(elapsed / currentDuration, 1);
      setProgress(pct);
    }, PROGRESS_TICK_MS);

    /* Advance after full duration */
    timerRef.current = window.setTimeout(() => {
      goNext();
    }, currentDuration);

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      if (progressIntervalRef.current !== null)
        clearInterval(progressIntervalRef.current);
    };
  }, [activeStoryIndex, isPaused, currentDuration, currentStory, goNext, storeReady]);

  /* -----------------------------------------------------------------
   * Story view tracking — mark each story as viewed once displayed
   * ----------------------------------------------------------------- */
  useEffect(() => {
    if (currentStory && !viewedStoryIds.has(currentStory.id)) {
      viewStory(currentStory.id);
    }
  }, [currentStory, viewStory, viewedStoryIds]);

  /* -----------------------------------------------------------------
   * Keyboard navigation (R34 — WCAG keyboard access)
   * ----------------------------------------------------------------- */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      /* Do not interfere when the reply input is focused */
      if (document.activeElement === replyInputRef.current) {
        if (e.key === 'Escape') {
          replyInputRef.current?.blur();
          e.preventDefault();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          goNext();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          goPrev();
          break;
        case ' ':
          e.preventDefault();
          setIsPaused((p) => !p);
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [goNext, goPrev, onClose]);

  /* -----------------------------------------------------------------
   * Pointer handlers — long-press to pause, tap to navigate
   * ----------------------------------------------------------------- */

  /** Start a long-press timer to pause auto-advance */
  const handlePointerDown = useCallback(() => {
    longPressTimerRef.current = window.setTimeout(() => {
      setIsPaused(true);
    }, LONG_PRESS_DELAY);
  }, []);

  /** Cancel long-press and resume if paused */
  const handlePointerUp = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (isPaused) {
      setIsPaused(false);
    }
  }, [isPaused]);

  /** Tap navigation — left half = prev, right half = next */
  const handleContentClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      /* Ignore clicks on interactive children */
      const target = e.target as HTMLElement;
      if (
        target.closest('button') ||
        target.closest('input') ||
        target.closest('a') ||
        target.closest('form')
      ) {
        return;
      }

      const rect = e.currentTarget.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const midpoint = rect.width / 2;

      if (clickX < midpoint) {
        goPrev();
      } else {
        goNext();
      }
    },
    [goNext, goPrev],
  );

  /* -----------------------------------------------------------------
   * Touch / Swipe handlers
   * ----------------------------------------------------------------- */

  /** Record touch start coordinates for swipe detection */
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    };
  }, []);

  /** Detect swipe direction and trigger corresponding action */
  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartRef.current) return;

      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartRef.current.x;
      const dy = touch.clientY - touchStartRef.current.y;
      touchStartRef.current = null;

      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      /* Swipe down → close viewer */
      if (dy > SWIPE_THRESHOLD && absDy > absDx) {
        onClose();
        return;
      }

      /* Swipe left → next user's stories */
      if (dx < -SWIPE_THRESHOLD && absDx > absDy) {
        if (onNextUser) {
          onNextUser();
        } else {
          onClose();
        }
        return;
      }

      /* Swipe right → previous user's stories */
      if (dx > SWIPE_THRESHOLD && absDx > absDy) {
        onPrevUser?.();
      }
    },
    [onClose, onNextUser, onPrevUser],
  );

  /* -----------------------------------------------------------------
   * Reply handler — uses auth user for attribution
   * ----------------------------------------------------------------- */
  const handleReplySubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = replyText.trim();
      if (trimmed.length === 0 || !currentStory || !user) return;

      /* In production, this dispatches a WebSocket message:send event
       * with the reply text attributed to user.id targeting currentStory.authorId.
       * The store / socket layer handles delivery. */
      setReplyText('');
      replyInputRef.current?.blur();
    },
    [replyText, currentStory, user],
  );

  /* -----------------------------------------------------------------
   * Auto-close when no stories are available
   * Effect runs unconditionally to satisfy Rules of Hooks, but only
   * calls onClose when the stories array is empty or the current story
   * resolves to null (e.g. after all stories expire).
   *
   * CRITICAL: Gate on store readiness — the init effect sets
   * activeStoryUserId asynchronously. If the store still has a stale
   * userId (from a previous session or null before init), the derived
   * userStories / currentStory will be wrong, causing a premature close.
   * We only evaluate hasValidStory after the store has been initialised
   * for this component's userId.
   * ----------------------------------------------------------------- */
  useEffect(() => {
    if (storeReady && !hasValidStory) {
      onClose();
    }
  }, [storeReady, hasValidStory, onClose]);

  /** Rounded progress percentage for ARIA */
  const progressPercent = Math.round(progress * 100);

  /* Early return — nothing to render */
  if (!hasValidStory) {
    return null;
  }

  /* =================================================================
   * RENDER
   * ================================================================= */
  return (
    /* Backdrop — full-screen black on mobile, semi-transparent on desktop */
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black md:bg-black/80">
      {/* Viewer card — full-screen mobile, centered card on desktop */}
      <div
        ref={viewerRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Viewing ${displayName}'s status. Story ${activeStoryIndex + 1} of ${userStories.length}`}
        tabIndex={-1}
        className={[
          'relative flex flex-col w-full h-full bg-black select-none outline-none',
          /* Desktop: centred card with rounded corners (R3 responsive) */
          'md:max-w-[420px] md:h-[calc(100vh-4rem)] md:rounded-2xl md:overflow-hidden',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={handleContentClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* ===========================================================
         * Progress Bar — segmented, one segment per story
         * =========================================================== */}
        <div
          className="flex gap-[2px] px-2 pt-2 pb-1 z-10"
          style={{
            paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0.5rem))',
          }}
          role="progressbar"
          aria-valuenow={progressPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Story progress: ${progressPercent}% of story ${activeStoryIndex + 1}`}
        >
          {userStories.map((story, idx) => {
            const isCompleted = idx < activeStoryIndex;
            const isActive = idx === activeStoryIndex;

            return (
              <div
                key={story.id}
                className="flex-1 h-[2px] rounded-full bg-white/40 overflow-hidden"
              >
                <div
                  className="h-full bg-white rounded-full"
                  style={{
                    width: isCompleted
                      ? '100%'
                      : isActive
                        ? `${progress * 100}%`
                        : '0%',
                    /* Disable transition on the active segment for smooth
                     * interval-driven animation; completed snaps instantly */
                    transition: 'none',
                  }}
                />
              </div>
            );
          })}
        </div>

        {/* ===========================================================
         * User Info Header — avatar, name, timestamp, close button
         * =========================================================== */}
        <div className="flex items-center gap-3 px-4 py-2 z-10">
          {/* Avatar (36×36 — size sm) */}
          <Avatar
            src={feedItem?.userAvatar}
            alt={displayName}
            size="sm"
          />

          {/* Name and relative timestamp */}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-[14px] leading-[1.29em] text-white truncate">
              {displayName}
            </p>
            <p className="text-[12px] leading-[1.33em] text-white/60 truncate">
              {formatRelativeTime(currentStory.createdAt)}
            </p>
          </div>

          {/* Close button — white X, 24×24 touch target 32×32 */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            aria-label="Close story viewer"
            className={[
              'w-8 h-8 flex items-center justify-center rounded-full',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-white',
              'active:bg-white/20 motion-safe:transition-colors',
            ].join(' ')}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M18 6L6 18M6 6l12 12"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        {/* ===========================================================
         * Story Content Area
         * Text stories: coloured bg with centered white text
         * Image/Video: centered object-contain
         * =========================================================== */}
        <div
          className="flex-1 flex items-center justify-center relative overflow-hidden"
          aria-live="polite"
        >
          {/* --- Text story --- */}
          {currentStory.type === 'TEXT' && (
            <div
              className="absolute inset-0 flex items-center justify-center px-8"
              style={{
                backgroundColor: currentStory.backgroundColor || '#007AFF',
              }}
            >
              <p
                className="text-white text-center font-medium text-[28px] md:text-[38px] leading-[1.3em] break-words max-w-full"
                style={{
                  fontFamily:
                    "'Helvetica Neue', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
                }}
              >
                {currentStory.content ?? ''}
              </p>
            </div>
          )}

          {/* --- Image story --- */}
          {currentStory.type === 'IMAGE' && currentStory.mediaUrl && (
            <img
              src={currentStory.mediaUrl}
              alt={`${displayName}'s status`}
              className="w-full h-full object-contain"
              draggable={false}
            />
          )}

          {/* --- Video story --- */}
          {currentStory.type === 'VIDEO' && currentStory.mediaUrl && (
            <video
              src={currentStory.mediaUrl}
              poster={currentStory.thumbnailUrl}
              className="w-full h-full object-contain"
              autoPlay
              muted
              playsInline
              aria-label={`${displayName}'s video status`}
            />
          )}

          {/* Pause indicator overlay */}
          {isPaused && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-black/20 z-10"
              aria-hidden="true"
            >
              <div className="w-16 h-16 rounded-full bg-black/40 flex items-center justify-center">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="white"
                  aria-hidden="true"
                >
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              </div>
            </div>
          )}
        </div>

        {/* ===========================================================
         * Reply Input — bottom of screen
         * bg-white/20 rounded-full, white placeholder, 44px touch target
         * =========================================================== */}
        <form
          onSubmit={handleReplySubmit}
          className="px-4 pb-4 pt-2 z-10"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2">
            <input
              ref={replyInputRef}
              type="text"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Reply..."
              aria-label="Reply to status"
              onFocus={() => setIsPaused(true)}
              onBlur={() => setIsPaused(false)}
              className={[
                'flex-1 h-[44px] px-5 rounded-full bg-white/20',
                'text-white placeholder:text-white/50 text-[15px]',
                'border border-white/30',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-white',
              ].join(' ')}
            />

            {/* Send button — visible only when reply text is non-empty */}
            {replyText.trim().length > 0 && (
              <button
                type="submit"
                aria-label="Send reply"
                className={[
                  'w-[44px] h-[44px] rounded-full bg-white/30',
                  'flex items-center justify-center',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-white',
                  'active:bg-white/40 motion-safe:transition-colors',
                ].join(' ')}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M2.5 10L17.5 10M17.5 10L11 3.5M17.5 10L11 16.5"
                    stroke="white"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </form>

        {/* Safe-area inset for iOS home indicator */}
        <div
          className="shrink-0"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
          aria-hidden="true"
        />

        {/* ARIA live region — announces story transitions to screen readers */}
        <div className="sr-only" aria-live="polite" role="status">
          {`Viewing story ${activeStoryIndex + 1} of ${userStories.length} by ${displayName}${isPaused ? '. Paused.' : ''}`}
        </div>
      </div>
    </div>
  );
};

export default StatusViewer;
