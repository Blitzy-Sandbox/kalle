'use client';

/**
 * CallsList — Full call history screen component.
 *
 * Implements Figma Screen 11 (WhatsApp Calls, node 0:10395) and
 * Screen 12 (WhatsApp Calls Edit, node 0:8597) from Figma file
 * miK1B6qEPrUnRZ9wwZNrW2.
 *
 * Renders a scrollable list of call entries with:
 *  - StatusBar (simulated iOS system bar)
 *  - NavigationBar with dynamic Edit/Done toggle, SegmentedControl (All/Missed),
 *    and phone-plus icon / Clear text
 *  - Scrollable call list with CallItem rows separated by Separator components
 *  - TabBar at bottom with Calls tab active
 *
 * Supports two modes:
 *  - Normal mode: "Edit" left action, phone-plus right action, info icons visible
 *  - Edit mode: "Done" (semibold) left action, "Clear" right action, red delete
 *    circles visible, info icons hidden, separators shifted to 99px inset
 *
 * @module CallsList
 */

import React, { useState, useMemo } from 'react';
import Image from 'next/image';

/* ── Internal component imports (from depends_on_files whitelist only) ─── */
import CallItem from './CallItem';
import NavigationBar from '../common/NavigationBar';
import TabBar from '../common/TabBar';
import SegmentedControl from '../common/SegmentedControl';
import Separator from '../common/Separator';
import StatusBar from '../common/StatusBar';

/* ── Static SVG icon import — resolved at build time by Next.js bundler.
 * Phone-plus icon from Figma node 0:10630 (file miK1B6qEPrUnRZ9wwZNrW2).
 * Used as the right action in the navigation bar during normal (non-edit) mode. */
import iconPhonePlus from '@/assets/icons/icon-phone-plus.svg';

/* ═══════════════════════════════════════════════════════════════════════════
 * TYPE DEFINITIONS
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Represents a single call record in the call history.
 *
 * Shape matches `CallItemCall` from CallItem component, allowing direct
 * pass-through without transformation.
 */
export interface Call {
  /** Unique identifier for the call record */
  id: string;
  /** Display name of the contact */
  name: string;
  /** URL or path to the contact's avatar image */
  avatar?: string;
  /** Direction of the call — determines icon and color treatment */
  direction: 'outgoing' | 'incoming' | 'missed';
  /** Formatted date string (e.g. "10/13/19") */
  date: string;
  /** Optional phone type label (e.g. "mobile", "home") */
  phoneType?: string;
}

/**
 * Props interface for the CallsList component.
 *
 * Exposes callback handlers for all user interactions (call press, info press,
 * delete, clear all, new call, tab navigation) plus a className escape hatch
 * for parent layout integration.
 */
export interface CallsListProps {
  /** Array of call records to display */
  calls: Call[];
  /** Handler invoked when a call row is tapped (navigate to contact) */
  onCallPress?: (callId: string) => void;
  /** Handler invoked when the info "i" button is tapped on a call row */
  onInfoPress?: (callId: string) => void;
  /** Handler invoked when the red delete circle is tapped in edit mode */
  onDeleteCall?: (callId: string) => void;
  /** Handler invoked when "Clear" is tapped in edit mode (clears all calls) */
  onClearAll?: () => void;
  /** Handler invoked when the phone-plus icon is tapped in normal mode */
  onNewCall?: () => void;
  /** Currently active tab in the bottom TabBar */
  activeTab?: 'status' | 'calls' | 'camera' | 'chats' | 'settings';
  /** Handler invoked when a bottom tab is pressed */
  onTabPress?: (tab: string) => void;
  /** Additional CSS class names for the outer container */
  className?: string;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * COMPONENT
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * CallsList renders the full call history screen with support for
 * normal and edit modes, All/Missed filtering, and complete
 * Figma design fidelity.
 *
 * Layout stack (top to bottom):
 *  1. StatusBar (44px, simulated iOS status bar — decorative)
 *  2. NavigationBar (44px, with Edit/Done, SegmentedControl, phone-plus/Clear)
 *  3. Scrollable call list (flex-1, padded for tab bar)
 *  4. TabBar (83px, fixed at bottom, Calls tab active)
 *
 * Screen bg: #EFEFF4 (Tailwind bg-surface)
 * Row bg: #FFFFFF (Tailwind bg-white)
 */
export const CallsList: React.FC<CallsListProps> = ({
  calls,
  onCallPress,
  onInfoPress,
  onDeleteCall,
  onClearAll,
  onNewCall,
  activeTab = 'calls',
  onTabPress,
  className = '',
}) => {
  /* ── Local state ─────────────────────────────────────────────────────── */

  /**
   * Edit mode toggle.
   * Normal mode: "Edit" + phone-plus icon, info circles visible.
   * Edit mode: "Done" (semibold) + "Clear" text, red delete circles visible.
   */
  const [isEditMode, setIsEditMode] = useState<boolean>(false);

  /**
   * Segmented control filter index.
   * 0 = "All" (show every call), 1 = "Missed" (show only direction === 'missed').
   */
  const [filter, setFilter] = useState<0 | 1>(0);

  /* ── Derived data ────────────────────────────────────────────────────── */

  /**
   * Memoized filtered call list.
   * When filter=1 ("Missed"), returns only calls with direction === 'missed'.
   * When filter=0 ("All"), returns the full array unmodified.
   */
  const filteredCalls = useMemo(() => {
    if (filter === 1) {
      return calls.filter((call) => call.direction === 'missed');
    }
    return calls;
  }, [calls, filter]);

  /* ── Event handlers ──────────────────────────────────────────────────── */

  /**
   * Toggles between normal and edit mode.
   * Bound to the NavigationBar left action button.
   */
  const handleEditToggle = (): void => {
    setIsEditMode((prev) => !prev);
  };

  /**
   * Handles the NavigationBar right action.
   * Normal mode: invokes onNewCall (phone-plus icon).
   * Edit mode: invokes onClearAll ("Clear" text button).
   */
  const handleRightAction = (): void => {
    if (isEditMode) {
      onClearAll?.();
    } else {
      onNewCall?.();
    }
  };

  /**
   * Handles SegmentedControl onChange.
   * Updates the filter index (0 = All, 1 = Missed).
   */
  const handleFilterChange = (index: 0 | 1): void => {
    setFilter(index);
  };

  /* ── Navigation bar action elements ──────────────────────────────────── */

  /**
   * Left action for NavigationBar.
   * Normal mode: "Edit" text (font-weight 400, per Figma style_ONNLR1).
   * Edit mode: "Done" text (font-weight 600 / semibold, per Figma style_YD9B3S).
   */
  const leftActionElement: React.ReactNode = isEditMode ? (
    <span className="font-semibold">Done</span>
  ) : (
    'Edit'
  );

  /**
   * Right action for NavigationBar.
   * Normal mode: phone-plus icon (24×24px, #007AFF fill).
   *   Figma node 0:10630 at x=335, y=54.
   * Edit mode: "Clear" text (font-weight 400, per Figma style_DZ642B).
   */
  const rightActionElement: React.ReactNode = isEditMode ? (
    'Clear'
  ) : (
    <Image
      src={iconPhonePlus}
      alt="New call"
      width={24}
      height={24}
      aria-hidden="false"
    />
  );

  /**
   * Center content for NavigationBar.
   * SegmentedControl with "All" and "Missed" labels.
   * Figma node 0:10622: 151×28px, borderRadius 8px, border #007AFF.
   */
  const centerContentElement: React.ReactNode = (
    <SegmentedControl
      labels={['All', 'Missed']}
      activeIndex={filter}
      onChange={handleFilterChange}
    />
  );

  /* ── Render ──────────────────────────────────────────────────────────── */

  return (
    <div className={`flex flex-col h-full bg-surface ${className}`.trim()}>
      {/* ── iOS Status Bar (44px, decorative) ─────────────────────────── */}
      <StatusBar />

      {/* ── Navigation Bar (44px) ─────────────────────────────────────── */}
      {/* Dynamic left/right actions based on edit mode state.
       * Center content hosts the SegmentedControl for All/Missed filtering.
       * NavigationBar handles its own bg (#F6F6F6) and shadow styling. */}
      <NavigationBar
        title="Calls"
        leftAction={leftActionElement}
        onLeftAction={handleEditToggle}
        rightAction={rightActionElement}
        onRightAction={handleRightAction}
        centerContent={centerContentElement}
      />

      {/* ── Scrollable Call List ───────────────────────────────────────── */}
      {/* flex-1 fills space between nav bar and tab bar.
       * overflow-y-auto enables vertical scrolling when list exceeds viewport.
       * pb-[83px] prevents content from being hidden behind the fixed TabBar.
       * role="list" + aria-label for accessibility. */}
      <div
        className="flex-1 overflow-y-auto pb-[83px]"
        role="list"
        aria-label="Call history"
      >
        {filteredCalls.length === 0 ? (
          /* ── Empty state ─────────────────────────────────────────────── */
          /* Centered placeholder text when no calls match the active filter.
           * Uses text-secondary (#8E8E93) at 15px body text size. */
          <div className="flex items-center justify-center h-full">
            <p className="text-[15px] font-normal leading-[1.33em] tracking-tight-ios text-secondary">
              No recent calls
            </p>
          </div>
        ) : (
          /* ── Call entries ────────────────────────────────────────────── */
          filteredCalls.map((call, index) => (
            <div key={call.id} role="listitem">
              {/* CallItem handles all per-row rendering including:
               * - Avatar (40×40px, shifted in edit mode)
               * - Name (bold, red for missed calls)
               * - Direction icon + label
               * - Date (right-aligned)
               * - Info "i" circle (hidden in edit mode)
               * - Red delete minus circle (visible in edit mode) */}
              <CallItem
                call={call}
                isEditMode={isEditMode}
                onPress={() => onCallPress?.(call.id)}
                onInfoPress={() => onInfoPress?.(call.id)}
                onDelete={() => onDeleteCall?.(call.id)}
              />
              {/* Separator between rows (not after last row).
               * Normal mode: inset at 68px (Figma separator alignment).
               * Edit mode: inset shifted to 99px (matching content shift). */}
              {index < filteredCalls.length - 1 && (
                <Separator
                  inset
                  insetLeft={isEditMode ? 99 : 68}
                />
              )}
            </div>
          ))
        )}
      </div>

      {/* ── Bottom Tab Bar (83px, fixed) ──────────────────────────────── */}
      {/* Calls tab highlighted as active. TabBar handles its own
       * fixed positioning, bg (#F6F6F6), and shadow styling. */}
      <TabBar
        activeTab={activeTab}
        onTabPress={(tab) => onTabPress?.(tab)}
      />

      {/* ── Accessibility: Aria live region ────────────────────────────── */}
      {/* Announces edit mode state changes to screen readers.
       * sr-only hides the element visually while keeping it accessible. */}
      <div aria-live="polite" className="sr-only">
        {isEditMode ? 'Edit mode active. Tap delete to remove individual calls, or Clear to remove all.' : ''}
      </div>
    </div>
  );
};

export default CallsList;
