'use client';

/**
 * @module apps/web/src/components/status/StatusFeed
 *
 * Status / Stories feed screen implementing Figma Screen 8
 * (WhatsApp Status, node 0:8498, file key miK1B6qEPrUnRZ9wwZNrW2).
 *
 * Displays "My Status" row with avatar + blue "+" badge, camera/pencil
 * action icons, a "Recent Updates" section with StatusItem list, and
 * an empty state placeholder when no contacts have posted recently.
 *
 * Layout (top → bottom, 375×812px base):
 *   StatusBar (44px) → NavigationBar ("Status", "Privacy") →
 *   My Status Section (76px white card) → Separator →
 *   Recent Updates list / Empty State → TabBar (status active)
 *
 * @see AAP Section 0.5.1 — Screen 8 specification
 * @see AAP Section 0.5.3 — Component Inventory
 * @see R1  — Figma Fidelity (≤5% pixel difference at 1440px)
 * @see R34 — WCAG 2.1 AA Compliance
 * @see R7  — Zero warnings build
 */

import React, { type FC, useCallback, useMemo, useEffect } from 'react';
import Image from 'next/image';

/* ── Common Components ──────────────────────────────────────────────────── */
import { NavigationBar } from '@/components/common/NavigationBar';
import { TabBar, type TabId } from '@/components/common/TabBar';
import Avatar from '@/components/common/Avatar';
import { StatusBar } from '@/components/common/StatusBar';
import { Separator } from '@/components/common/Separator';

/* ── Status Components ──────────────────────────────────────────────────── */
import StatusItem from './StatusItem';

/* ── Stores ─────────────────────────────────────────────────────────────── */
import { useStoryStore } from '@/stores/storyStore';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';

/* ── SVG Icon Assets (Figma node 0:8498) ────────────────────────────────── */
import iconStatusAdd from '@/assets/icons/icon-status-add.svg';
import iconCameraStatus from '@/assets/icons/icon-camera-status.svg';
import iconEditPencil from '@/assets/icons/icon-edit-pencil.svg';

// =============================================================================
// Exports
// =============================================================================

/**
 * Props for the StatusFeed component.
 */
export interface StatusFeedProps {
  /** Additional CSS class names for the root container. */
  className?: string;
  /** Callback invoked when the pencil/text status button is pressed. */
  onTextStatusPress?: () => void;
  /** Callback invoked when the camera status button is pressed. */
  onCameraPress?: () => void;
}

// =============================================================================
// Constants
// =============================================================================

/** Interval in milliseconds for periodic expired-story cleanup. */
const CLEANUP_INTERVAL_MS = 60_000;

// =============================================================================
// Component
// =============================================================================

/**
 * StatusFeed — Status / Stories feed screen.
 *
 * Implements Figma Screen 8 (WhatsApp Status):
 * - My Status section with 58×58px avatar, blue "+" badge, and 36×36px
 *   camera/pencil action buttons on a 76px white card
 * - Recent Updates list with StatusItem progress rings per contact
 * - Empty state placeholder: "No recent updates to show right now."
 * - NavigationBar: title "Status", leftAction "Privacy"
 * - TabBar: status tab active
 *
 * WCAG 2.1 AA compliant (R34):
 * - Keyboard navigable with focus-visible indicators
 * - ARIA landmarks and labels on all sections
 * - Semantic roles on list containers
 * - Motion-safe transitions
 */
const StatusFeed: FC<StatusFeedProps> = ({ className, onTextStatusPress, onCameraPress }) => {
  /* ── Store Selectors ─────────────────────────────────────────────────── */

  const stories = useStoryStore((s) => s.stories);
  const myStory = useStoryStore((s) => s.myStory);
  const isLoadingFeed = useStoryStore((s) => s.isLoadingFeed);
  const setStoriesFeed = useStoryStore((s) => s.setStoriesFeed);
  const removeExpiredStories = useStoryStore((s) => s.removeExpiredStories);
  const setActiveStoryUser = useStoryStore((s) => s.setActiveStoryUser);
  const viewedStoryIds = useStoryStore((s) => s.viewedStoryIds);

  const user = useAuthStore((s) => s.user);

  const setActiveTab = useUIStore((s) => s.setActiveTab);

  /* ── Effects ─────────────────────────────────────────────────────────── */

  /**
   * Remove expired stories on mount and run periodic cleanup every 60 s.
   * When all stories have expired after cleanup the feed state is reset
   * via setStoriesFeed to clear the isLoadingFeed flag and ensure the
   * empty-state card is displayed cleanly.
   */
  useEffect(() => {
    removeExpiredStories();

    const interval = setInterval(() => {
      removeExpiredStories();

      // If every story expired after cleanup, reset feed to idle state
      const current = useStoryStore.getState().stories;
      if (current.length === 0) {
        setStoriesFeed([]);
      }
    }, CLEANUP_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [removeExpiredStories, setStoriesFeed]);

  /* ── Memoised Data ───────────────────────────────────────────────────── */

  /** Visible stories: only groups with at least one active story. */
  const visibleStories = useMemo(
    () => stories.filter((item) => item.stories.length > 0),
    [stories],
  );

  const hasRecentUpdates = visibleStories.length > 0;

  /* ── Callbacks ───────────────────────────────────────────────────────── */

  /** Handle bottom tab bar press — navigates to a different tab. */
  const handleTabPress = useCallback(
    (tab: TabId) => {
      setActiveTab(tab);
    },
    [setActiveTab],
  );

  /** Handle "Privacy" left-action press (presentational shell). */
  const handlePrivacyPress = useCallback(() => {
    /* Privacy settings navigation — wired by parent when available */
  }, []);

  /** Handle My Status row press. */
  const handleMyStatusClick = useCallback(() => {
    /* Opens own-status viewer or composer when wired */
  }, []);

  /** Handle camera action-button press (stops propagation to the row). */
  const handleCameraPress = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onCameraPress?.();
  }, [onCameraPress]);

  /** Handle pencil/text action-button press — opens text status composer. */
  const handleTextStatusPress = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onTextStatusPress?.();
  }, [onTextStatusPress]);

  /** Handle a contact's status row press — opens the story viewer. */
  const handleStatusItemClick = useCallback(
    (userId: string) => {
      setActiveStoryUser(userId);
    },
    [setActiveStoryUser],
  );

  /**
   * Keyboard handler factory — activates a callback on Enter or Space.
   * Applied to every role="button" element for full keyboard support.
   */
  const handleKeyDown = useCallback(
    (callback: () => void) =>
      (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          callback();
        }
      },
    [],
  );

  /** Count how many of a user's stories have been viewed. */
  const getViewedCount = useCallback(
    (userStories: { id: string }[]): number =>
      userStories.filter((s) => viewedStoryIds.has(s.id)).length,
    [viewedStoryIds],
  );

  /* ── Badge Element (memoised) ────────────────────────────────────────── */

  /**
   * Blue "+" badge overlay for the My Status avatar.
   * The SVG (icon-status-add.svg, 20×20px) already contains the
   * #007AFF blue circle with white "+" baked in. Positioned by the
   * Avatar component's badge slot at absolute bottom-0 right-0.
   */
  const statusBadge = useMemo(
    () => (
      <Image
        src={iconStatusAdd}
        alt=""
        width={20}
        height={20}
        aria-hidden="true"
      />
    ),
    [],
  );

  /* ── Render ──────────────────────────────────────────────────────────── */

  return (
    <div
      className={[
        'flex flex-col min-h-screen bg-surface',
        className ?? '',
      ]
        .join(' ')
        .trim()}
    >
      {/* ── iOS Status Bar (decorative) ──────────────────────────────── */}
      <StatusBar />

      {/* ── Navigation Bar: "Privacy" | "Status" ─────────────────────── */}
      <NavigationBar
        title="Status"
        leftAction="Privacy"
        onLeftAction={handlePrivacyPress}
      />

      {/* ── Scrollable Content Area ──────────────────────────────────── */}
      <main
        className="flex-1 overflow-y-auto"
        role="main"
        aria-label="Status feed"
      >
        {/* ────────────────────────────────────────────────────────────
         * My Status Section — 76px white card
         * Dual hairline box-shadow: top + bottom rgba(60,60,67,0.29)
         * ──────────────────────────────────────────────────────────── */}
        <section
          aria-label="My status"
          className="mt-[35px] bg-white shadow-[0px_-0.33px_0px_0px_rgba(60,60,67,0.29),0px_0.33px_0px_0px_rgba(60,60,67,0.29)]"
        >
          <div
            role="button"
            tabIndex={0}
            aria-label={
              myStory?.hasStatus
                ? 'View my status'
                : 'Add to my status'
            }
            onClick={handleMyStatusClick}
            onKeyDown={handleKeyDown(handleMyStatusClick)}
            className={[
              /* Layout: 76px height, 13px left / 16px right padding */
              'flex items-center h-[76px] pl-[13px] pr-4 cursor-pointer',
              /* Interaction states */
              'active:bg-gray-100',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-ios',
              'motion-safe:transition-colors motion-safe:duration-150',
            ].join(' ')}
          >
            {/* Avatar 58×58px with blue "+" badge at bottom-right */}
            <div className="flex-shrink-0">
              <Avatar
                src={user?.avatar ?? undefined}
                alt="My status"
                customSize={58}
                badge={statusBadge}
              />
            </div>

            {/* Text column — starts at x≈80: 13px pad + 58px avatar + 9px gap */}
            <div className="flex-1 min-w-0 ml-[9px] flex flex-col justify-center">
              <p className="font-semibold text-[16px] leading-[1.3125em] tracking-[-0.033em] text-black">
                My Status
              </p>
              <p className="font-normal text-[14px] leading-[1.14em] tracking-[-0.015em] text-secondary">
                {myStory?.hasStatus ? 'Tap to view' : 'Add to my status'}
              </p>
            </div>

            {/* Action buttons — two 36×36px circles, 16px gap */}
            <div className="flex items-center gap-4 flex-shrink-0">
              {/* Camera button — create photo/video status */}
              <button
                type="button"
                onClick={handleCameraPress}
                aria-label="Create photo or video status"
                className={[
                  'w-[36px] h-[36px] rounded-full overflow-hidden flex-shrink-0',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
                  'active:opacity-70 motion-safe:transition-opacity',
                ].join(' ')}
              >
                <Image
                  src={iconCameraStatus}
                  alt=""
                  width={36}
                  height={36}
                  aria-hidden="true"
                />
              </button>

              {/* Pencil button — create text status */}
              <button
                type="button"
                onClick={handleTextStatusPress}
                aria-label="Create text status"
                className={[
                  'w-[36px] h-[36px] rounded-full overflow-hidden flex-shrink-0',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
                  'active:opacity-70 motion-safe:transition-opacity',
                ].join(' ')}
              >
                <Image
                  src={iconEditPencil}
                  alt=""
                  width={36}
                  height={36}
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        </section>

        {/* ── Section Separator ──────────────────────────────────────── */}
        <Separator />

        {/* ────────────────────────────────────────────────────────────
         * Recent Updates / Loading / Empty State
         * ──────────────────────────────────────────────────────────── */}
        {isLoadingFeed ? (
          /* Loading indicator card */
          <div
            className={[
              'mt-[35px] bg-white h-[43px] flex items-center justify-center',
              'shadow-[0px_-0.33px_0px_0px_rgba(60,60,67,0.29),0px_0.33px_0px_0px_rgba(60,60,67,0.29)]',
            ].join(' ')}
            role="status"
            aria-label="Loading status updates"
            aria-busy="true"
          >
            <p className="text-[14px] font-normal leading-[1.14em] tracking-[-0.015em] text-secondary text-center animate-pulse">
              Loading…
            </p>
          </div>
        ) : hasRecentUpdates ? (
          /* Recent updates section with header + StatusItem list */
          <section aria-label="Recent updates" className="mt-[35px]">
            {/* Section header — uppercase gray, 13px */}
            <p className="px-4 pb-1.5 text-section-header uppercase text-secondary tracking-wide">
              Recent Updates
            </p>

            {/* Status items list — white card with dual shadow */}
            <div
              className="bg-white shadow-[0px_-0.33px_0px_0px_rgba(60,60,67,0.29),0px_0.33px_0px_0px_rgba(60,60,67,0.29)]"
              role="list"
              aria-label="Status updates from contacts"
            >
              {visibleStories.map((item, index) => (
                <div key={item.userId} role="listitem">
                  <StatusItem
                    userId={item.userId}
                    name={item.userName}
                    avatarUrl={item.userAvatar}
                    timestamp={item.latestStoryAt}
                    totalStories={item.stories.length}
                    viewedStories={getViewedCount(item.stories)}
                    onClick={() => handleStatusItemClick(item.userId)}
                    showSeparator={index < visibleStories.length - 1}
                  />
                </div>
              ))}
            </div>
          </section>
        ) : (
          /* Empty state card — 43px white card, centered text */
          <div
            className={[
              'mt-[35px] bg-white h-[43px] flex items-center justify-center',
              'shadow-[0px_-0.33px_0px_0px_rgba(60,60,67,0.29),0px_0.33px_0px_0px_rgba(60,60,67,0.29)]',
            ].join(' ')}
            role="status"
            aria-label="No recent updates"
          >
            <p className="text-[14px] font-normal leading-[1.14em] tracking-[-0.015em] text-secondary text-center">
              No recent updates to show right now.
            </p>
          </div>
        )}

        {/* Bottom spacer — 83px clearance for tab bar (49px + 34px home indicator) */}
        <div className="h-[83px]" aria-hidden="true" />
      </main>

      {/* ── Bottom Tab Bar — Status tab active ───────────────────────── */}
      <TabBar activeTab="status" onTabPress={handleTabPress} />
    </div>
  );
};

export default StatusFeed;
