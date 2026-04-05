'use client';

// =============================================================================
// CallsPage — Call History Page (Screens 11 & 12)
// =============================================================================
//
// Next.js 14 App Router page implementing the Call History view.
// Implements TWO Figma screens:
//   - Screen 11: WhatsApp Calls (node 0:10395) — Normal mode
//   - Screen 12: WhatsApp Calls Edit (node 0:8597) — Edit mode with delete controls
//
// Data Flow:
//   Page (data fetch + state) → CallsList (self-contained UI)
//   Loading skeleton uses NavigationBar + SegmentedControl + CallItem directly.
//
// Rules Enforced:
//   R5  — No mock data; all data from live API
//   R6  — Backend integration wiring for all mutations
//   R7  — Zero TypeScript warnings
//   R28 — No console.log/warn/error (frontend best practice)
//   R34 — WCAG 2.1 AA compliance
// =============================================================================

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { CallsList } from '@/components/calls/CallsList';
import { CallItem } from '@/components/calls/CallItem';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import { NavigationBar } from '@/components/common/NavigationBar';
import { useUIStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { useResponsive } from '@/hooks/useResponsive';
import { apiClient } from '@/lib/api';

// =============================================================================
// Types
// =============================================================================

/** Shape of a call entry returned by the REST API */
interface CallEntry {
  id: string;
  contactName: string;
  avatarUrl: string;
  direction: 'outgoing' | 'incoming' | 'missed';
  date: string;
  phoneType?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Maps an API CallEntry to the Call shape expected by CallsList.
 * CallsList.Call uses `name` / `avatar` while the API uses
 * `contactName` / `avatarUrl`.
 */
function mapCallEntryToListCall(entry: CallEntry) {
  return {
    id: entry.id,
    name: entry.contactName,
    avatar: entry.avatarUrl,
    direction: entry.direction,
    date: entry.date,
    phoneType: entry.phoneType,
  };
}

// =============================================================================
// Loading Skeleton Sub-component
// =============================================================================

/**
 * Renders a shimmer skeleton that mirrors the calls screen layout during
 * the initial data fetch. Uses NavigationBar + SegmentedControl for the
 * header and CallItem for realistic row placeholders.
 *
 * Accessible: announces loading via role="status" + aria-label.
 */
function CallsLoadingSkeleton({
  isEditMode,
  onToggleEdit,
}: {
  isEditMode: boolean;
  onToggleEdit: () => void;
}) {
  /** Placeholder call data for skeleton rows */
  const skeletonCall = {
    id: 'skeleton-0',
    name: '\u00A0', /* non-breaking space keeps row height */
    direction: 'outgoing' as const,
    date: '\u00A0',
  };

  return (
    <div
      className="flex flex-col h-full bg-surface"
      role="status"
      aria-label="Loading call history"
    >
      {/* Skeleton header — real NavigationBar + SegmentedControl */}
      <NavigationBar
        title=""
        leftAction={isEditMode ? 'Done' : 'Edit'}
        onLeftAction={onToggleEdit}
        centerContent={
          <SegmentedControl
            labels={['All', 'Missed']}
            activeIndex={0}
            onChange={() => {
              /* no-op in skeleton state */
            }}
          />
        }
      />

      {/* Skeleton call rows */}
      <div className="flex-1 overflow-y-auto pb-[83px]">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={`skeleton-row-${String(i)}`}
            className="animate-pulse opacity-40"
          >
            <CallItem
              call={{ ...skeletonCall, id: `skeleton-${String(i)}` }}
              isEditMode={isEditMode}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// Error State Sub-component
// =============================================================================

/**
 * Displayed when the API call to fetch calls fails.
 * Uses NavigationBar for structural consistency and shows a retry action.
 */
function CallsErrorState({
  message,
  onRetry,
  isEditMode,
  onToggleEdit,
  segmentedControl,
}: {
  message: string;
  onRetry: () => void;
  isEditMode: boolean;
  onToggleEdit: () => void;
  segmentedControl: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full bg-surface">
      <NavigationBar
        title=""
        leftAction={isEditMode ? 'Done' : 'Edit'}
        onLeftAction={onToggleEdit}
        centerContent={segmentedControl}
      />

      <div
        className="flex flex-col items-center justify-center flex-1 px-8"
        role="alert"
      >
        <p className="text-secondary text-[15px] leading-[1.33em] tracking-tight-ios text-center mb-4">
          {message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="text-blue-ios text-[17px] leading-[1.29em] tracking-tight-ios font-normal
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios
                     focus-visible:ring-offset-2 rounded"
          aria-label="Retry loading call history"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// CallsPage — Main Page Component
// =============================================================================

/**
 * Call History page implementing Figma Screens 11 (normal) and 12 (edit).
 *
 * Rendering Strategy:
 * ┌─────────────────────────────────────────────────┐
 * │ loading === true  →  CallsLoadingSkeleton       │
 * │   (NavigationBar + SegmentedControl + CallItem) │
 * │ error !== null    →  CallsErrorState            │
 * │   (NavigationBar + SegmentedControl + message)  │
 * │ loaded           →  CallsList                   │
 * │   (self-contained: nav, list, tab bar)          │
 * └─────────────────────────────────────────────────┘
 *
 * All four child components (CallsList, CallItem, NavigationBar,
 * SegmentedControl) are used across the three rendering branches.
 */
export default function CallsPage() {
  // ---------------------------------------------------------------------------
  // Local State
  // ---------------------------------------------------------------------------
  const [calls, setCalls] = useState<CallEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<0 | 1>(0);

  // ---------------------------------------------------------------------------
  // External Hooks
  // ---------------------------------------------------------------------------
  const router = useRouter();
  const { setActiveTab, activeTab, isEditMode, toggleEditMode } = useUIStore();
  const { isAuthenticated, user, isInitialized } = useAuthStore();
  const { isMobile, isTablet, isDesktop } = useResponsive();

  // ---------------------------------------------------------------------------
  // Set active tab on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    setActiveTab('calls');
  }, [setActiveTab]);

  // ---------------------------------------------------------------------------
  // Auth guard — redirect if not authenticated (wait for rehydration first)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (isInitialized && !isAuthenticated && !user) {
      router.push('/login');
    }
  }, [isInitialized, isAuthenticated, user, router]);

  // ---------------------------------------------------------------------------
  // Data Fetching — load call history from API (Rule R5, R6)
  // ---------------------------------------------------------------------------
  const fetchCalls = useCallback(async () => {
    if (!isInitialized || !isAuthenticated) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.get<CallEntry[]>('/api/v1/calls');

      if (!cancelled) {
        /* Handle both array and wrapped-object response shapes */
        const data = Array.isArray(response)
          ? response
          : Array.isArray((response as Record<string, unknown>).calls)
            ? ((response as Record<string, unknown>).calls as CallEntry[])
            : [];
        setCalls(data);
      }
    } catch (err: unknown) {
      if (!cancelled) {
        const fallbackMsg = 'Failed to load call history';
        setError(
          err instanceof Error ? err.message : fallbackMsg,
        );
        setCalls([]);
      }
    } finally {
      if (!cancelled) {
        setLoading(false);
      }
    }

    return () => {
      cancelled = true;
    };
  }, [isInitialized, isAuthenticated]);

  useEffect(() => {
    fetchCalls();
  }, [fetchCalls]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  /** Navigate to the contact info page for a call entry */
  const handleInfoPress = useCallback(
    (callId: string) => {
      router.push(`/contact/${callId}`);
    },
    [router],
  );

  /** Delete a single call entry via API, then remove from local state */
  const handleDeleteCall = useCallback(async (callId: string) => {
    try {
      await apiClient.delete(`/api/v1/calls/${callId}`);
      setCalls((prev) => prev.filter((c) => c.id !== callId));
    } catch {
      /* Silently handle — the row remains visible on failure */
    }
  }, []);

  /** Clear all call history via API */
  const handleClearAll = useCallback(async () => {
    try {
      await apiClient.delete('/api/v1/calls');
      setCalls([]);
    } catch {
      /* Silently handle */
    }
  }, []);

  /** Trigger new call flow */
  const handleNewCall = useCallback(() => {
    router.push('/contact/new');
  }, [router]);

  /** Navigate to conversation when a call row is tapped */
  const handleCallPress = useCallback(
    (callId: string) => {
      router.push(`/chat/${callId}`);
    },
    [router],
  );

  /** Handle tab bar navigation to other sections */
  const handleTabPress = useCallback(
    (tab: string) => {
      setActiveTab(
        tab as 'status' | 'calls' | 'camera' | 'chats' | 'settings',
      );

      const routes: Record<string, string> = {
        status: '/status',
        calls: '/calls',
        camera: '/camera',
        chats: '/chat',
        settings: '/settings',
      };

      const route = routes[tab];
      if (route && tab !== 'calls') {
        router.push(route);
      }
    },
    [setActiveTab, router],
  );

  /** Filter change for SegmentedControl (All / Missed) */
  const handleFilterChange = useCallback((index: 0 | 1) => {
    setActiveFilter(index);
  }, []);

  // ---------------------------------------------------------------------------
  // Derived Data
  // ---------------------------------------------------------------------------

  /** Filter calls based on activeFilter before mapping to CallsList shape */
  const filteredCalls = calls.filter((call) =>
    activeFilter === 1 ? call.direction === 'missed' : true,
  );

  /** Map to the Call shape consumed by CallsList */
  const mappedCalls = filteredCalls.map(mapCallEntryToListCall);

  // ---------------------------------------------------------------------------
  // Responsive container classes
  // ---------------------------------------------------------------------------
  const containerClasses = [
    'flex flex-col h-full',
    isMobile && 'w-full',
    isTablet && 'w-full max-w-3xl mx-auto',
    isDesktop && 'w-full max-w-[375px]',
  ]
    .filter(Boolean)
    .join(' ');

  // ---------------------------------------------------------------------------
  // Shared SegmentedControl element for error / skeleton states
  // ---------------------------------------------------------------------------
  const segmentedControlElement = (
    <SegmentedControl
      labels={['All', 'Missed']}
      activeIndex={activeFilter}
      onChange={handleFilterChange}
    />
  );

  // ---------------------------------------------------------------------------
  // Render: Loading State
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className={containerClasses}>
        <CallsLoadingSkeleton
          isEditMode={isEditMode}
          onToggleEdit={toggleEditMode}
        />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Error State
  // ---------------------------------------------------------------------------
  if (error) {
    return (
      <div className={containerClasses}>
        <CallsErrorState
          message={error}
          onRetry={() => {
            fetchCalls();
          }}
          isEditMode={isEditMode}
          onToggleEdit={toggleEditMode}
          segmentedControl={segmentedControlElement}
        />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Loaded State — delegate to CallsList (self-contained UI)
  // ---------------------------------------------------------------------------
  return (
    <div
      className={containerClasses}
      role="region"
      aria-label="Call history"
    >
      <CallsList
        calls={mappedCalls}
        onCallPress={handleCallPress}
        onInfoPress={handleInfoPress}
        onDeleteCall={handleDeleteCall}
        onClearAll={handleClearAll}
        onNewCall={handleNewCall}
        activeTab={activeTab}
        onTabPress={handleTabPress}
      />
    </div>
  );
}
