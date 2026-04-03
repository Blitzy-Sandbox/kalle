'use client';

import React, { useCallback } from 'react';
import Image from 'next/image';
import { NavigationBar } from '@/components/common/NavigationBar';
import { TabBar, type TabId } from '@/components/common/TabBar';
import Avatar from '@/components/common/Avatar';
import { Separator } from '@/components/common/Separator';
import { StatusBar } from '@/components/common/StatusBar';
import iconStatusAdd from '@/assets/icons/icon-status-add.svg';
import iconCameraStatus from '@/assets/icons/icon-camera-status.svg';
import iconEditPencil from '@/assets/icons/icon-edit-pencil.svg';

/* ==========================================================================
 * StatusFeed — Status / Stories Feed Screen
 *
 * Maps to Figma Screen 8 (WhatsApp Status, node 0:8498),
 * file key miK1B6qEPrUnRZ9wwZNrW2.
 *
 * Figma layout specs:
 * - Frame: 375×812px, bg #EFEFF4 (bg-surface)
 * - StatusBar (375×44) → NavigationBar ("Status", "Privacy") →
 *   My Status Section → Recent Updates / Empty State → TabBar
 *
 * My Status Section (375×76px white card):
 * - Dual box-shadow: 0px -0.33px / 0px 0.33px rgba(60,60,67,0.29)
 * - Avatar 58×58px with blue "+" badge (20×20px bottom-right)
 * - "My Status" text: SF Pro Text 600 16px, #000000
 * - "Add to my status" subtitle: SF Pro Text 400 14px, #8E8E93
 * - Camera button: 36×36px circle bg #EDEDFF, icon 17.5×15 #007AFF
 * - Pencil button: 36×36px circle bg #EDEDFF, icon 16.24×16.23 #007AFF
 *
 * Empty State (375×43px white card):
 * - "No recent updates to show right now." center, 14px, #8E8E93
 *
 * Design tokens used:
 * - bg-surface (#EFEFF4), bg-white, bg-nav (#F6F6F6)
 * - text-black, text-secondary (#8E8E93), text-blue-ios (#007AFF)
 * - bg-blue-ios (#007AFF for "+" badge)
 * ========================================================================== */

/**
 * Status item data shape for stories displayed in the "Recent Updates" list.
 */
export interface StatusData {
  /** Unique user identifier */
  userId: string;
  /** Display name of the status author */
  name: string;
  /** Avatar image URL */
  avatarSrc?: string;
  /** Timestamp label (e.g., "Today, 10:35 AM") */
  timestamp: string;
  /** Total number of status segments */
  totalSegments: number;
  /** Number of segments the current user has viewed */
  viewedSegments: number;
  /** Whether all segments have been viewed */
  hasUnseenUpdates: boolean;
}

/**
 * Props for the StatusFeed component.
 */
export interface StatusFeedProps {
  /** Current user's avatar URL */
  myAvatarSrc?: string;
  /** Whether the current user has posted a status */
  hasMyStatus?: boolean;
  /** Timestamp of user's most recent status */
  myStatusTimestamp?: string;
  /** Recent status updates from contacts */
  recentUpdates?: StatusData[];
  /** Callback when "My Status" row is tapped (opens own status viewer) */
  onMyStatusClick?: () => void;
  /** Callback when camera action button is tapped (opens camera for photo status) */
  onCameraPress?: () => void;
  /** Callback when pencil action button is tapped (opens text status composer) */
  onTextStatusPress?: () => void;
  /** Callback when "Privacy" left action is tapped */
  onPrivacyPress?: () => void;
  /** Callback when a contact's status is tapped (opens status viewer) */
  onStatusItemClick?: (userId: string) => void;
  /** Active tab for the TabBar */
  activeTab?: TabId;
  /** Tab press handler for the TabBar */
  onTabPress?: (tab: TabId) => void;
  /** Additional CSS class names */
  className?: string;
}

/**
 * StatusFeed — Status / Stories feed screen implementing Figma Screen 8.
 *
 * Displays the user's own status with creation actions (camera, text),
 * a list of recent contact status updates, and an empty state when no
 * contacts have posted recently.
 *
 * WCAG 2.1 AA compliant (R34):
 * - All interactive elements have aria-labels
 * - Keyboard navigable with focus-visible indicators
 * - Semantic section landmarks
 *
 * @example
 * ```tsx
 * <StatusFeed
 *   myAvatarSrc="/avatars/me.jpg"
 *   hasMyStatus={false}
 *   recentUpdates={[]}
 *   onCameraPress={() => openCamera()}
 *   onTextStatusPress={() => openComposer()}
 *   onTabPress={(tab) => navigate(tab)}
 *   activeTab="status"
 * />
 * ```
 */
const StatusFeed: React.FC<StatusFeedProps> = ({
  myAvatarSrc,
  hasMyStatus = false,
  myStatusTimestamp,
  recentUpdates = [],
  onMyStatusClick,
  onCameraPress,
  onTextStatusPress,
  onPrivacyPress,
  onStatusItemClick,
  activeTab = 'status',
  onTabPress,
  className = '',
}) => {
  /**
   * Keyboard handler for interactive rows.
   */
  const handleRowKeyDown = useCallback(
    (callback?: () => void) => (e: React.KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && callback) {
        e.preventDefault();
        callback();
      }
    },
    []
  );

  /**
   * Renders a single status update row in the "Recent Updates" section.
   * Reuses the same 74px row layout as chat list items.
   */
  const renderStatusRow = (status: StatusData) => {
    const allViewed = !status.hasUnseenUpdates;

    return (
      <div key={status.userId}>
        <div
          role="button"
          tabIndex={0}
          aria-label={`View ${status.name}'s status. ${status.timestamp}${status.hasUnseenUpdates ? '. New updates available' : ''}`}
          onClick={() => onStatusItemClick?.(status.userId)}
          onKeyDown={handleRowKeyDown(() => onStatusItemClick?.(status.userId))}
          className={[
            'flex items-center h-[74px] px-4 bg-white cursor-pointer',
            'active:bg-gray-100',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-ios',
            'motion-safe:transition-colors motion-safe:duration-150',
          ].join(' ')}
        >
          {/* Avatar with segmented progress ring */}
          <div className="relative flex-shrink-0 w-[52px] h-[52px]">
            <Avatar src={status.avatarSrc} alt={status.name} size="md" />
            {/* Ring indicator — blue for unseen, gray for all viewed */}
            <div
              className={[
                'absolute inset-[-3px] rounded-full border-2',
                allViewed ? 'border-secondary/30' : 'border-blue-ios',
              ].join(' ')}
              aria-hidden="true"
            />
          </div>

          {/* Name and timestamp */}
          <div className="flex-1 min-w-0 ml-3">
            <p className="font-semibold text-[16px] leading-[1.31em] tracking-[-0.02em] text-black truncate">
              {status.name}
            </p>
            <p className="text-[14px] leading-[1.14em] tracking-[-0.01em] text-secondary mt-0.5 truncate">
              {status.timestamp}
            </p>
          </div>
        </div>
        <Separator inset insetLeft={79} />
      </div>
    );
  };

  return (
    <div className={`flex flex-col min-h-screen bg-surface ${className}`}>
      {/* iOS Status Bar (decorative) */}
      <StatusBar />

      {/* Navigation Bar — "Privacy" left action, "Status" title */}
      <NavigationBar
        title="Status"
        leftAction="Privacy"
        onLeftAction={onPrivacyPress}
      />

      {/* Scrollable content area */}
      <main className="flex-1 overflow-y-auto" role="main" aria-label="Status feed">
        {/* ============================================================
         * My Status Section — white card with avatar, text, and action buttons
         * 375×76px, dual box-shadow for iOS card appearance
         * ============================================================ */}
        <section
          aria-label="My status"
          className="bg-white shadow-[0px_-0.33px_0px_rgba(60,60,67,0.29),0px_0.33px_0px_rgba(60,60,67,0.29)]"
        >
          <div
            role="button"
            tabIndex={0}
            aria-label={hasMyStatus ? `View my status. ${myStatusTimestamp ?? ''}` : 'Add to my status'}
            onClick={onMyStatusClick}
            onKeyDown={handleRowKeyDown(onMyStatusClick)}
            className={[
              'flex items-center h-[76px] px-4 cursor-pointer',
              'active:bg-gray-100',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-ios',
              'motion-safe:transition-colors motion-safe:duration-150',
            ].join(' ')}
          >
            {/* Avatar with blue "+" badge overlay */}
            <div className="relative flex-shrink-0">
              <Avatar src={myAvatarSrc} alt="My status" customSize={58} />
              {!hasMyStatus && (
                <div
                  className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-blue-ios flex items-center justify-center border-2 border-white"
                  aria-hidden="true"
                >
                  <Image
                    src={iconStatusAdd}
                    alt=""
                    width={10}
                    height={10}
                    className="brightness-0 invert"
                    aria-hidden="true"
                  />
                </div>
              )}
            </div>

            {/* Text column */}
            <div className="flex-1 min-w-0 ml-3">
              <p className="font-semibold text-[16px] leading-[1.31em] tracking-[-0.02em] text-black">
                My Status
              </p>
              <p className="text-[14px] leading-[1.14em] tracking-[-0.01em] text-secondary mt-0.5">
                {hasMyStatus ? myStatusTimestamp : 'Add to my status'}
              </p>
            </div>

            {/* Action buttons — camera and pencil/text */}
            <div className="flex items-center gap-4 flex-shrink-0">
              {/* Camera button — photo/video status */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCameraPress?.();
                }}
                aria-label="Create photo or video status"
                className={[
                  'w-9 h-9 rounded-full bg-[#EDEDFF] flex items-center justify-center',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
                  'active:bg-blue-ios/20 motion-safe:transition-colors',
                ].join(' ')}
              >
                <Image
                  src={iconCameraStatus}
                  alt=""
                  width={18}
                  height={15}
                  aria-hidden="true"
                />
              </button>

              {/* Pencil/text button — text status */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onTextStatusPress?.();
                }}
                aria-label="Create text status"
                className={[
                  'w-9 h-9 rounded-full bg-[#EDEDFF] flex items-center justify-center',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios',
                  'active:bg-blue-ios/20 motion-safe:transition-colors',
                ].join(' ')}
              >
                <Image
                  src={iconEditPencil}
                  alt=""
                  width={16}
                  height={16}
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        </section>

        {/* ============================================================
         * Recent Updates / Empty State
         * ============================================================ */}
        {recentUpdates.length > 0 ? (
          <section aria-label="Recent updates" className="mt-[22px]">
            {/* Section header */}
            <p className="px-4 pb-1.5 text-[13px] leading-[1.23em] uppercase text-secondary tracking-wide">
              Recent Updates
            </p>

            {/* Status list */}
            <div className="bg-white shadow-[0px_-0.33px_0px_rgba(60,60,67,0.29),0px_0.33px_0px_rgba(60,60,67,0.29)]">
              {recentUpdates.map(renderStatusRow)}
            </div>
          </section>
        ) : (
          /* Empty state card */
          <div
            className="mt-[22px] bg-white shadow-[0px_-0.33px_0px_rgba(60,60,67,0.29),0px_0.33px_0px_rgba(60,60,67,0.29)] h-[43px] flex items-center justify-center"
            role="status"
            aria-label="No recent updates"
          >
            <p className="text-[14px] leading-[1.19em] text-secondary">
              No recent updates to show right now.
            </p>
          </div>
        )}

        {/* Bottom spacer for tab bar clearance */}
        <div className="h-24" aria-hidden="true" />
      </main>

      {/* Bottom Tab Bar — "Status" active */}
      <TabBar
        activeTab={activeTab}
        onTabPress={onTabPress ?? (() => {})}
      />
    </div>
  );
};

export default StatusFeed;
