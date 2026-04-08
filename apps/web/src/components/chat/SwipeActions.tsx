'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';
import Image from 'next/image';
import iconMoreDots from '@/assets/icons/icon-more-dots.svg';
import iconArchive from '@/assets/icons/icon-archive.svg';

/**
 * Props for the SwipeActions component.
 * Wraps a ChatListItem to reveal "More" and "Archive" action buttons on swipe-left.
 */
export interface SwipeActionsProps {
  /** Callback when "More" button is tapped — opens ChatActionsModal */
  onMore: () => void;
  /** Callback when "Archive" button is tapped — archives the conversation */
  onArchive: () => void;
  /** The ChatListItem content that slides left to reveal actions */
  children: React.ReactNode;
}

/**
 * Module-level ref to the currently open SwipeActions close function.
 * Ensures only one row is swiped open at a time across all instances.
 */
let activeCloseRef: (() => void) | null = null;

/** Total width of action buttons: two 74px buttons = 148px */
const ACTION_WIDTH = 148;
/** Threshold to snap open (one button width) */
const SNAP_THRESHOLD = 74;
/** Threshold beyond which swipe auto-triggers archive */
const AUTO_ARCHIVE_THRESHOLD = 200;
/** Maximum drag overshoot beyond ACTION_WIDTH */
const MAX_OVERSHOOT = 80;

/**
 * SwipeActions — swipe-to-reveal "More" and "Archive" action buttons.
 *
 * Maps to Figma node 0:8856 (swipe action group) within WhatsApp Chats screen (0:8855),
 * file key miK1B6qEPrUnRZ9wwZNrW2.
 *
 * Reveals two 74×74px action buttons behind the chat row on swipe-left:
 * - "More" (gray #C6C6CC) with three-dot icon
 * - "Archive" (blue #3E70A7) with archive icon
 *
 * Snap points:
 * - 0px: closed
 * - 148px: open (both buttons visible)
 * - >200px: auto-trigger archive callback
 *
 * Supports touch (mobile) and mouse drag (desktop) interactions.
 * Dismisses on outside click. Only one row can be swiped open at a time.
 */
const SwipeActions: React.FC<SwipeActionsProps> = ({ onMore, onArchive, children }) => {
  /* ---------- State ---------- */
  const [offset, setOffset] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  /* ---------- Refs ---------- */
  const containerRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startOffsetRef = useRef(0);
  const isDraggingRef = useRef(false);
  /** Mirror of offset state for use inside stable callbacks */
  const offsetRef = useRef(0);

  /* ---------- Close handler ---------- */
  const close = useCallback(() => {
    offsetRef.current = 0;
    setOffset(0);
    setIsOpen(false);
    if (activeCloseRef === close) {
      activeCloseRef = null;
    }
  }, []);

  /* ---------- Drag lifecycle (shared between touch and mouse) ---------- */
  const handleDragStart = useCallback(
    (clientX: number) => {
      /* Close any other open swipe row before starting a new drag */
      if (activeCloseRef && activeCloseRef !== close) {
        activeCloseRef();
      }
      startXRef.current = clientX;
      startOffsetRef.current = offsetRef.current;
      isDraggingRef.current = true;
      setIsDragging(true);
    },
    [close],
  );

  const handleDragMove = useCallback((clientX: number) => {
    if (!isDraggingRef.current) return;
    const deltaX = startXRef.current - clientX; /* positive = swiping left */
    const newOffset = Math.max(
      0,
      Math.min(startOffsetRef.current + deltaX, ACTION_WIDTH + MAX_OVERSHOOT),
    );
    offsetRef.current = newOffset;
    setOffset(newOffset);
  }, []);

  const handleDragEnd = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    setIsDragging(false);

    const currentOffset = offsetRef.current;

    if (currentOffset > AUTO_ARCHIVE_THRESHOLD) {
      /* Auto-archive: close the swipe and trigger callback */
      offsetRef.current = 0;
      setOffset(0);
      setIsOpen(false);
      activeCloseRef = null;
      onArchive();
    } else if (currentOffset >= SNAP_THRESHOLD) {
      /* Snap open to full action width */
      offsetRef.current = ACTION_WIDTH;
      setOffset(ACTION_WIDTH);
      setIsOpen(true);
      activeCloseRef = close;
    } else {
      /* Snap closed */
      close();
    }
  }, [onArchive, close]);

  /* ---------- Touch event handlers (mobile) ---------- */
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      handleDragStart(e.touches[0].clientX);
    },
    [handleDragStart],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      handleDragMove(e.touches[0].clientX);
    },
    [handleDragMove],
  );

  const onTouchEnd = useCallback(() => {
    handleDragEnd();
  }, [handleDragEnd]);

  /* ---------- Mouse event handlers (desktop) ---------- */
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      handleDragStart(e.clientX);
    },
    [handleDragStart],
  );

  /**
   * Attach global mouse move/up listeners when actively dragging.
   * This ensures we capture drag events even when the cursor leaves the component.
   */
  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      handleDragMove(e.clientX);
    };
    const onMouseUp = () => {
      handleDragEnd();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDragging, handleDragMove, handleDragEnd]);

  /* ---------- Outside click / touch dismiss ---------- */
  useEffect(() => {
    if (!isOpen) return;

    const handleOutsideInteraction = (e: Event) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    };

    document.addEventListener('mousedown', handleOutsideInteraction);
    document.addEventListener('touchstart', handleOutsideInteraction);

    return () => {
      document.removeEventListener('mousedown', handleOutsideInteraction);
      document.removeEventListener('touchstart', handleOutsideInteraction);
    };
  }, [isOpen, close]);

  /* ---------- Cleanup on unmount ---------- */
  useEffect(() => {
    return () => {
      if (activeCloseRef === close) {
        activeCloseRef = null;
      }
    };
  }, [close]);

  /* ---------- Keyboard activation for action buttons ---------- */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, action: () => void) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        action();
      }
    },
    [],
  );

  /* ---------- Button click handlers ---------- */
  const handleMoreClick = useCallback(() => {
    onMore();
    close();
  }, [onMore, close]);

  const handleArchiveClick = useCallback(() => {
    onArchive();
    close();
  }, [onArchive, close]);

  return (
    <div
      ref={containerRef}
      className="relative h-[74px] overflow-hidden select-none"
      aria-roledescription="swipeable"
    >
      {/* Action buttons — positioned behind the sliding content */}
      <div
        className="absolute inset-y-0 end-0 flex h-full"
        aria-hidden={!isOpen}
      >
        {/* More Button — 74×74, bg #C6C6CC (Figma node 0:8865) */}
        <div
          role="button"
          tabIndex={isOpen ? 0 : -1}
          aria-label="More actions for conversation"
          className={[
            'flex w-[74px] h-[74px] flex-col items-center bg-[#C6C6CC] cursor-pointer',
            'pt-[25px]',
            'focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset',
            'focus-visible:outline-none',
          ].join(' ')}
          onClick={handleMoreClick}
          onKeyDown={(e) => handleKeyDown(e, handleMoreClick)}
        >
          <Image
            src={iconMoreDots}
            alt=""
            width={25}
            height={6}
            aria-hidden="true"
          />
          {/* Gap: 44px (label top) - 31px (icon bottom = 25+6) = 13px */}
          <span
            className="mt-[13px] text-white text-sm font-normal leading-[1.193em] tracking-[-0.01em] text-center"
          >
            More
          </span>
        </div>

        {/* Archive Button — 74×74, bg #3E70A7 (Figma node 0:8857) */}
        <div
          role="button"
          tabIndex={isOpen ? 0 : -1}
          aria-label="Archive conversation"
          className={[
            'flex w-[74px] h-[74px] flex-col items-center bg-[#3E70A7] cursor-pointer',
            'pt-[17.5px]',
            'focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset',
            'focus-visible:outline-none',
          ].join(' ')}
          onClick={handleArchiveClick}
          onKeyDown={(e) => handleKeyDown(e, handleArchiveClick)}
        >
          <Image
            src={iconArchive}
            alt=""
            width={21}
            height={21}
            aria-hidden="true"
          />
          {/* Gap: 44px (label top) - 38.5px (icon bottom = 17.5+21) = 5.5px */}
          <span
            className="mt-[5.5px] text-white text-sm font-normal leading-[1.193em] tracking-[-0.01em] text-center"
          >
            Archive
          </span>
        </div>
      </div>

      {/* Sliding content wrapper — transforms left to reveal action buttons */}
      <div
        className={[
          'relative z-10 h-full bg-white touch-pan-y',
          isDragging
            ? ''
            : 'motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ transform: `translateX(-${offset}px)` }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onMouseDown={onMouseDown}
      >
        {children}
      </div>
    </div>
  );
};

export default SwipeActions;
