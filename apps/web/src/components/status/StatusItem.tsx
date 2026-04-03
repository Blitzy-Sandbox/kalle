'use client';

import React, { type FC, useMemo, useCallback } from 'react';
import Avatar from '../common/Avatar';
import { Separator } from '../common/Separator';

/**
 * Props for the StatusItem component.
 *
 * Represents a single user's story entry in the Status feed's "Recent Updates"
 * section. The component renders a circular avatar with a segmented SVG progress
 * ring indicating which stories have been viewed, the user's display name, and
 * a relative timestamp of their most recent story.
 *
 * Figma reference: Screen 8 (WhatsApp Status), node 0:8498
 * Design file: miK1B6qEPrUnRZ9wwZNrW2
 */
export interface StatusItemProps {
  /** User ID — used as React key in parent list and for data attribution */
  userId: string;
  /** User display name rendered next to the avatar */
  name: string;
  /** User avatar image URL. Falls back to Avatar initials fallback when absent. */
  avatarUrl?: string;
  /** Timestamp of the most recent story. Accepts Date object or ISO 8601 string. */
  timestamp: Date | string;
  /** Total number of active (non-expired) stories from this user */
  totalStories: number;
  /** Number of stories the current user has already viewed */
  viewedStories: number;
  /** Click handler invoked when the row is activated (click or keyboard Enter/Space) */
  onClick: () => void;
  /** Whether to render the inset separator below this row. Default false. */
  showSeparator?: boolean;
  /** Additional Tailwind className applied to the outermost row container */
  className?: string;
}

/* ============================================================
 * SVG Progress Ring Constants
 *
 * The ring surrounds the 52px avatar with a 2.5px-wide stroke.
 * Ring stroke-center diameter: 58px (radius 29).
 * SVG viewBox: 62×62 (58 + 2px padding per side for stroke overshoot).
 * Avatar is inset 5px from the SVG's top-left to center within the ring.
 * ============================================================ */
const RING_SIZE = 62;
const RING_CENTER = 31;
const RING_RADIUS = 29;
const RING_STROKE_WIDTH = 2.5;
const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Gap in pixels along the circumference between adjacent story segments */
const SEGMENT_GAP = 4;

/** Minimum arc length in px — segments smaller than this collapse to a full ring */
const MIN_SEGMENT_LENGTH = 1;

/** Stroke color for unviewed story segments — #25D366 (whatsapp-green) */
const COLOR_UNVIEWED = '#25D366';
/** Stroke color for viewed story segments — #8E8E93 (secondary gray) */
/* BLITZY [COLOR]: #8E8E93 on #FFFFFF yields ~3.2:1 contrast, below WCAG AA 4.5:1
   for normal text. This is the Figma design specification value (style_12W6LV).
   Nearest accessible alternative: #717175 (~4.6:1). */
const COLOR_VIEWED = '#8E8E93';

/** Offset in pixels from the SVG container edge to center the 52px avatar inside the 62px ring */
const AVATAR_INSET = 5;

/** Month abbreviations for absolute-date formatting fallback */
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/* ============================================================
 * Relative Time Formatter
 *
 * Converts a timestamp to a human-readable relative string
 * matching WhatsApp's status timestamp display convention:
 *
 *   < 1 min   → "Just now"
 *   < 60 min  → "X min ago"
 *   < 24 h    → "Xh ago"
 *   < 48 h    → "Yesterday"
 *   Otherwise → "MMM DD" (e.g., "Mar 28")
 * ============================================================ */
function formatRelativeTime(timestamp: Date | string): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  /* Future timestamps or zero-diff are treated as "Just now" */
  if (diffMs < 0) return 'Just now';

  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);

  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffHours < 48) return 'Yesterday';

  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}`;
}

/* ============================================================
 * Ring Segment Computation
 *
 * Generates SVG stroke-dasharray / stroke-dashoffset pairs for
 * each story segment in the circular progress ring.
 *
 * Algorithm:
 *   1. Divide the circle into N equal arcs with SEGMENT_GAP px
 *      between each pair of adjacent arcs.
 *   2. The first `viewed` arcs are colored gray (COLOR_VIEWED),
 *      the remaining arcs are green (COLOR_UNVIEWED).
 *   3. Each arc is rendered as a separate <circle> SVG element
 *      with its own dasharray and dashoffset.
 *   4. A <g> element applies rotate(-90) so arcs begin at 12 o'clock.
 *
 * Dashoffset formula:
 *   For segment i starting at circumference position startPos,
 *   dashoffset = CIRCUMFERENCE - startPos
 *   This positions the visible arc at startPos along the circle.
 * ============================================================ */

/** Describes one SVG arc segment in the progress ring */
interface RingSegment {
  /** stroke-dasharray attribute value */
  dashArray: string;
  /** stroke-dashoffset attribute value */
  dashOffset: number;
  /** Stroke color hex string */
  color: string;
}

/**
 * Generates ring segment descriptors for the SVG progress ring.
 *
 * @param total  - Total number of stories (arc segments)
 * @param viewed - Number of already-viewed stories (gray arcs)
 * @returns Array of RingSegment objects ordered clockwise from 12 o'clock
 */
function computeRingSegments(total: number, viewed: number): RingSegment[] {
  if (total <= 0) return [];

  /* Clamp viewed count to valid range [0, total] */
  const safeViewed = Math.max(0, Math.min(viewed, total));

  /* Single story — full ring with no segment gaps */
  if (total === 1) {
    return [{
      dashArray: `${CIRCUMFERENCE} 0`,
      dashOffset: 0,
      color: safeViewed > 0 ? COLOR_VIEWED : COLOR_UNVIEWED,
    }];
  }

  /* Calculate the arc length per segment after subtracting all gaps */
  const totalGapSpace = total * SEGMENT_GAP;
  const arcLength = (CIRCUMFERENCE - totalGapSpace) / total;

  /*
   * If too many stories make segments visually imperceptible,
   * fall back to a single full ring colored by majority state.
   */
  if (arcLength < MIN_SEGMENT_LENGTH) {
    const majorityColor = safeViewed >= total / 2 ? COLOR_VIEWED : COLOR_UNVIEWED;
    return [{
      dashArray: `${CIRCUMFERENCE} 0`,
      dashOffset: 0,
      color: majorityColor,
    }];
  }

  const segments: RingSegment[] = [];

  for (let i = 0; i < total; i++) {
    const isViewed = i < safeViewed;
    const startPos = i * (arcLength + SEGMENT_GAP);

    segments.push({
      dashArray: `${arcLength} ${CIRCUMFERENCE - arcLength}`,
      dashOffset: CIRCUMFERENCE - startPos,
      color: isViewed ? COLOR_VIEWED : COLOR_UNVIEWED,
    });
  }

  return segments;
}

/* ============================================================
 * StatusItem Component
 *
 * Individual row in the Status feed "Recent Updates" list.
 * Displays a user's avatar inside a segmented progress ring,
 * their display name, and a relative timestamp. Follows the
 * same 74px row height and layout grid as ChatListItem for
 * visual consistency across the application.
 *
 * Layout (left to right):
 *   16px padding | 62px ring+avatar | 2px gap | text column | 16px padding
 *   Text starts at x=80 from the row's left edge per Figma.
 *
 * Accessibility (WCAG 2.1 AA — R34):
 *   - role="button" with tabIndex={0}
 *   - aria-label conveys name and viewed/total count
 *   - Enter and Space activate onClick
 *   - Visible focus-visible indicator
 *   - SVG ring marked aria-hidden (decorative)
 * ============================================================ */
const StatusItem: FC<StatusItemProps> = ({
  userId,
  name,
  avatarUrl,
  timestamp,
  totalStories,
  viewedStories,
  onClick,
  showSeparator = false,
  className = '',
}) => {
  /* Memoize ring segment calculations — recompute only when story counts change */
  const ringSegments = useMemo(
    () => computeRingSegments(totalStories, viewedStories),
    [totalStories, viewedStories],
  );

  /* Memoize formatted relative time string */
  const relativeTime = useMemo(
    () => formatRelativeTime(timestamp),
    [timestamp],
  );

  /* Keyboard activation handler — Enter/Space trigger onClick (WCAG 2.1 AA R34) */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    },
    [onClick],
  );

  /* Compose descriptive aria-label with viewed/total information */
  const safeViewed = Math.min(viewedStories, totalStories);
  const ariaLabel = `${name}'s status - ${safeViewed} of ${totalStories} viewed`;

  return (
    <div className={className} data-user-id={userId}>
      {/* Clickable row container — 74px height matching ChatListItem */}
      <div
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        onClick={onClick}
        onKeyDown={handleKeyDown}
        className={[
          'flex items-center h-[74px] px-4 bg-white cursor-pointer',
          'active:bg-gray-100',
          'focus:outline-none focus-visible:bg-gray-50',
          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-ios',
          'motion-safe:transition-colors motion-safe:duration-150',
        ].join(' ')}
      >
        {/* Progress ring + avatar container (62×62px) */}
        <div
          className="relative flex-shrink-0"
          style={{ width: `${RING_SIZE}px`, height: `${RING_SIZE}px` }}
          aria-hidden="true"
        >
          {/* SVG segmented progress ring */}
          <svg
            className="absolute inset-0"
            width={RING_SIZE}
            height={RING_SIZE}
            viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <g transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}>
              {ringSegments.map((segment, index) => (
                <circle
                  key={index}
                  cx={RING_CENTER}
                  cy={RING_CENTER}
                  r={RING_RADIUS}
                  stroke={segment.color}
                  strokeWidth={RING_STROKE_WIDTH}
                  strokeLinecap="round"
                  fill="none"
                  strokeDasharray={segment.dashArray}
                  strokeDashoffset={segment.dashOffset}
                />
              ))}
            </g>
          </svg>

          {/* Avatar centered inside the ring — 52px (size="md") with 5px inset */}
          <div
            className="absolute"
            style={{ top: `${AVATAR_INSET}px`, left: `${AVATAR_INSET}px` }}
          >
            <Avatar
              src={avatarUrl}
              alt={name}
              size="md"
            />
          </div>
        </div>

        {/* Text content column: name + timestamp
            ml-[2px] positions text start at x=80 from row left edge:
            16px (padding) + 62px (ring) + 2px (gap) = 80px */}
        <div className="ml-[2px] flex-1 flex flex-col justify-center min-w-0">
          <span
            className="font-semibold text-[16px] leading-[1.3125em] tracking-[-0.033em] text-black truncate"
          >
            {name}
          </span>
          <span
            className="font-normal text-[14px] leading-[1.14em] tracking-[-0.015em] text-secondary truncate"
          >
            {relativeTime}
          </span>
        </div>
      </div>

      {/* Optional inset separator — starts at x=80 from left edge per Figma */}
      {showSeparator && (
        <Separator inset insetLeft={80} />
      )}
    </div>
  );
};

export default StatusItem;
