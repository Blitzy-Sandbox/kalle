'use client';

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import Image from 'next/image';
import Avatar from '@/components/common/Avatar';
import iconCloseX from '@/assets/icons/icon-close-x.svg';

/* ==========================================================================
 * StatusViewer — Full-Screen Story / Status Viewer
 *
 * Implements the full-screen story viewing experience referenced across
 * Figma Screens 8–10 (file key miK1B6qEPrUnRZ9wwZNrW2).
 *
 * Layout specs:
 * - Full-screen overlay: fixed inset-0, z-50, bg-black
 * - Progress bar (top): h-2px segments, completed=bg-white,
 *   active=animated fill, upcoming=bg-white/40
 * - User info header: Avatar 36×36 (sm), name white 600 14px,
 *   timestamp white/60 12px, close X 24×24
 * - Story content: centered, text stories on colored bg, media as
 *   object-contain
 * - Reply input (bottom): bg-white/20 rounded-full, white placeholder
 * - Navigation: tap-left=prev, tap-right=next, long-press=pause
 * - Auto-advance: 5s text, 7s media
 *
 * Design tokens: white text/icons, black overlay bg, white/40 progress
 * ========================================================================== */

/**
 * Individual story segment data.
 */
export interface StorySegment {
  /** Unique identifier for the story segment */
  id: string;
  /** Type of story content */
  type: 'text' | 'image' | 'video';
  /** Text content (for text stories) */
  text?: string;
  /** Background color (for text stories) */
  bgColor?: string;
  /** Media URL (for image/video stories) */
  mediaUrl?: string;
  /** Video poster image URL */
  posterUrl?: string;
  /** Timestamp when the story was created */
  createdAt: string;
  /** Duration to display in seconds (default: 5 for text, 7 for media) */
  duration?: number;
}

/**
 * Props for the StatusViewer component.
 */
export interface StatusViewerProps {
  /** Display name of the status author */
  userName: string;
  /** Author avatar image URL */
  userAvatarSrc?: string;
  /** Array of story segments to display in sequence */
  stories: StorySegment[];
  /** Index of the initial story segment to show (default: 0) */
  initialStoryIndex?: number;
  /** Callback to close the viewer */
  onClose: () => void;
  /** Callback when all stories for this user are viewed, navigate to next user */
  onNextUser?: () => void;
  /** Callback to navigate to previous user */
  onPrevUser?: () => void;
  /** Callback when a story segment is viewed (for view tracking) */
  onStoryViewed?: (storyId: string) => void;
  /** Callback when the user sends a reply */
  onReply?: (storyId: string, text: string) => void;
  /** Additional CSS class names */
  className?: string;
}

/** Auto-advance durations in milliseconds */
const TEXT_DURATION_MS = 5000;
const MEDIA_DURATION_MS = 7000;

/**
 * StatusViewer — Full-screen story viewer with auto-advance.
 *
 * Displays a sequence of story segments with a progress bar, user info
 * header, and reply input. Supports text stories (colored backgrounds)
 * and media stories (images/videos) with automatic advancement.
 *
 * Navigation:
 * - Tap left half → previous segment
 * - Tap right half → next segment
 * - Long-press → pause auto-advance
 * - Swipe down → close viewer
 * - Keyboard: ArrowLeft/Right, Space (pause), Escape (close)
 *
 * WCAG 2.1 AA compliant (R34):
 * - role="dialog" with aria-modal="true"
 * - All controls have aria-labels
 * - Keyboard navigable (arrows, escape, space)
 * - ARIA live region for segment transitions
 *
 * @example
 * ```tsx
 * <StatusViewer
 *   userName="Martha Craig"
 *   userAvatarSrc="/avatars/martha.jpg"
 *   stories={[
 *     { id: '1', type: 'text', text: 'Hello!', bgColor: '#007AFF', createdAt: '2h ago' },
 *     { id: '2', type: 'image', mediaUrl: '/media/photo.jpg', createdAt: '1h ago' },
 *   ]}
 *   onClose={() => setViewerOpen(false)}
 *   onStoryViewed={(id) => markViewed(id)}
 * />
 * ```
 */
const StatusViewer: React.FC<StatusViewerProps> = ({
  userName,
  userAvatarSrc,
  stories,
  initialStoryIndex = 0,
  onClose,
  onNextUser,
  onPrevUser,
  onStoryViewed,
  onReply,
  className = '',
}) => {
  /* -------------------------------------------------------------------
   * State
   * ----------------------------------------------------------------- */
  const [currentIndex, setCurrentIndex] = useState<number>(
    Math.min(Math.max(0, initialStoryIndex), Math.max(0, stories.length - 1))
  );
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [replyText, setReplyText] = useState<string>('');

  /* Refs */
  const viewerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const progressIntervalRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const replyInputRef = useRef<HTMLInputElement>(null);

  /* Current story */
  const currentStory = stories[currentIndex];

  /** Get the display duration for the current story */
  const currentDuration = useMemo(() => {
    if (!currentStory) return TEXT_DURATION_MS;
    if (currentStory.duration) return currentStory.duration * 1000;
    return currentStory.type === 'text' ? TEXT_DURATION_MS : MEDIA_DURATION_MS;
  }, [currentStory]);

  /* -------------------------------------------------------------------
   * Navigation Handlers
   * ----------------------------------------------------------------- */

  /** Advance to the next story segment or next user */
  const goNext = useCallback(() => {
    if (currentIndex < stories.length - 1) {
      setCurrentIndex((i) => i + 1);
      setProgress(0);
    } else {
      /* All stories viewed for this user */
      if (onNextUser) {
        onNextUser();
      } else {
        onClose();
      }
    }
  }, [currentIndex, stories.length, onNextUser, onClose]);

  /** Go back to the previous story segment or previous user */
  const goPrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex((i) => i - 1);
      setProgress(0);
    } else if (onPrevUser) {
      onPrevUser();
    }
  }, [currentIndex, onPrevUser]);

  /** Toggle pause state */
  const togglePause = useCallback(() => {
    setIsPaused((p) => !p);
  }, []);

  /* -------------------------------------------------------------------
   * Auto-Advance Timer
   * ----------------------------------------------------------------- */
  useEffect(() => {
    /* Clear existing intervals */
    if (timerRef.current) clearTimeout(timerRef.current);
    if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);

    if (isPaused || !currentStory) return;

    /* Progress bar animation (update every 50ms for smooth fill) */
    const startTime = Date.now();
    progressIntervalRef.current = window.setInterval(() => {
      const elapsed = Date.now() - startTime;
      const pct = Math.min(elapsed / currentDuration, 1);
      setProgress(pct);
    }, 50);

    /* Auto-advance timer */
    timerRef.current = window.setTimeout(() => {
      goNext();
    }, currentDuration);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };
  }, [currentIndex, isPaused, currentDuration, currentStory, goNext]);

  /* -------------------------------------------------------------------
   * Story Viewed Tracking
   * ----------------------------------------------------------------- */
  useEffect(() => {
    if (currentStory) {
      onStoryViewed?.(currentStory.id);
    }
  }, [currentStory, onStoryViewed]);

  /* -------------------------------------------------------------------
   * Keyboard Navigation
   * ----------------------------------------------------------------- */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      /* Do not interfere if reply input is focused */
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
          togglePause();
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
  }, [goNext, goPrev, togglePause, onClose]);

  /* -------------------------------------------------------------------
   * Touch / Click Navigation
   * ----------------------------------------------------------------- */

  /** Long-press to pause */
  const handlePointerDown = useCallback(() => {
    longPressTimerRef.current = window.setTimeout(() => {
      setIsPaused(true);
    }, 300);
  }, []);

  const handlePointerUp = useCallback(() => {
    if (longPressTimerRef.current) {
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
      /* Ignore if clicking on buttons/inputs */
      const target = e.target as HTMLElement;
      if (
        target.closest('button') ||
        target.closest('input') ||
        target.closest('a')
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
    [goNext, goPrev]
  );

  /* -------------------------------------------------------------------
   * Reply Handler
   * ----------------------------------------------------------------- */
  const handleReplySubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = replyText.trim();
      if (trimmed.length === 0 || !currentStory) return;
      onReply?.(currentStory.id, trimmed);
      setReplyText('');
      replyInputRef.current?.blur();
    },
    [replyText, currentStory, onReply]
  );

  /* -------------------------------------------------------------------
   * Early return for empty stories
   * ----------------------------------------------------------------- */
  if (!stories.length || !currentStory) {
    onClose();
    return null;
  }

  return (
    <div
      ref={viewerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${userName}'s status. Story ${currentIndex + 1} of ${stories.length}`}
      className={`fixed inset-0 z-50 flex flex-col bg-black select-none ${className}`}
      onClick={handleContentClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* ============================================================
       * Progress Bar — segmented, one segment per story
       * ============================================================ */}
      <div
        className="flex gap-1 px-2 pt-2 pb-1 z-10"
        role="progressbar"
        aria-valuenow={currentIndex + 1}
        aria-valuemin={1}
        aria-valuemax={stories.length}
        aria-label={`Story ${currentIndex + 1} of ${stories.length}`}
      >
        {stories.map((story, idx) => (
          <div
            key={story.id}
            className="flex-1 h-[2px] rounded-full bg-white/40 overflow-hidden"
          >
            <div
              className="h-full bg-white rounded-full transition-none"
              style={{
                width:
                  idx < currentIndex
                    ? '100%'
                    : idx === currentIndex
                      ? `${progress * 100}%`
                      : '0%',
              }}
            />
          </div>
        ))}
      </div>

      {/* ============================================================
       * User Info Header — avatar, name, timestamp, close button
       * ============================================================ */}
      <div className="flex items-center gap-2.5 px-3 py-2 z-10">
        {/* Avatar */}
        <Avatar
          src={userAvatarSrc}
          alt={userName}
          size="sm"
        />

        {/* Name and timestamp */}
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-[14px] leading-[1.29em] text-white truncate">
            {userName}
          </p>
          <p className="text-[12px] leading-[1.33em] text-white/60 truncate">
            {currentStory.createdAt}
          </p>
        </div>

        {/* Close button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close status viewer"
          className={[
            'w-8 h-8 flex items-center justify-center rounded-full',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-white',
            'active:bg-white/20 motion-safe:transition-colors',
          ].join(' ')}
        >
          <Image
            src={iconCloseX}
            alt=""
            width={24}
            height={24}
            className="brightness-0 invert"
            aria-hidden="true"
          />
        </button>
      </div>

      {/* ============================================================
       * Story Content Area
       * Text stories: colored bg with centered white text
       * Image/Video: centered object-contain
       * ============================================================ */}
      <div className="flex-1 flex items-center justify-center relative overflow-hidden">
        {currentStory.type === 'text' && (
          <div
            className="absolute inset-0 flex items-center justify-center px-8"
            style={{ backgroundColor: currentStory.bgColor || '#007AFF' }}
          >
            <p
              className="text-white text-center font-medium text-[28px] leading-[1.3em] break-words max-w-full"
              style={{
                fontFamily:
                  "'Helvetica Neue', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
              }}
            >
              {currentStory.text}
            </p>
          </div>
        )}

        {currentStory.type === 'image' && currentStory.mediaUrl && (
          <Image
            src={currentStory.mediaUrl}
            alt={`${userName}'s status`}
            fill
            className="object-contain"
            priority
          />
        )}

        {currentStory.type === 'video' && currentStory.mediaUrl && (
          <video
            src={currentStory.mediaUrl}
            poster={currentStory.posterUrl}
            className="w-full h-full object-contain"
            autoPlay
            muted
            playsInline
            aria-label={`${userName}'s video status`}
          />
        )}

        {/* Pause indicator */}
        {isPaused && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/20 z-10"
            aria-live="polite"
            aria-label="Paused"
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

      {/* ============================================================
       * Reply Input — bottom of screen
       * bg-white/20 rounded-full, white placeholder
       * ============================================================ */}
      {onReply && (
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
                  fill="white"
                  aria-hidden="true"
                >
                  <path d="M2.5 10L17.5 10M17.5 10L11 3.5M17.5 10L11 16.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              </button>
            )}
          </div>
        </form>
      )}

      {/* Safe area inset for home indicator */}
      <div className="pb-[env(safe-area-inset-bottom)]" aria-hidden="true" />

      {/* ARIA live region for segment transitions */}
      <div className="sr-only" aria-live="polite" role="status">
        {`Viewing story ${currentIndex + 1} of ${stories.length} by ${userName}${isPaused ? '. Paused.' : ''}`}
      </div>
    </div>
  );
};

export default StatusViewer;
