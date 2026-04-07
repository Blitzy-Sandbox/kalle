'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useSocket } from '@/hooks/useSocket';
import { usePresence } from '@/hooks/usePresence';
import { useResponsive } from '@/hooks/useResponsive';
import { TabBar } from '@/components/common/TabBar';

// =============================================================================
// Helper — Active Tab Resolution
// =============================================================================

/**
 * Determines the active TabBar tab identifier from the current URL pathname.
 *
 * Mapping:
 *  - /status/*   → 'status'
 *  - /calls/*    → 'calls'
 *  - /camera/*   → 'camera'
 *  - /settings/* → 'settings'
 *  - /chat/*     → 'chats' (default)
 *
 * The route segment is `/chat` (singular) but the tab ID is `'chats'` (plural)
 * to match the TabBar component's TabId union type.
 *
 * @param pathname - Current URL pathname from usePathname()
 * @returns The matching TabId value
 */
function getActiveTab(
  pathname: string,
): 'status' | 'calls' | 'camera' | 'chats' | 'settings' {
  if (pathname.startsWith('/status')) return 'status';
  if (pathname.startsWith('/calls')) return 'calls';
  if (pathname.startsWith('/camera')) return 'camera';
  if (pathname.startsWith('/settings')) return 'settings';
  return 'chats';
}

// =============================================================================
// Route Mapping — TabId → URL Path
// =============================================================================

/**
 * Maps TabBar tab identifiers to their corresponding navigation paths.
 *
 * Note: 'chats' tab maps to '/chat' route (singular). This intentional
 * asymmetry keeps tab IDs consistent with the TabBar component while
 * matching the Next.js App Router route structure under (main)/chat/.
 */
const TAB_ROUTES: Record<
  'status' | 'calls' | 'camera' | 'chats' | 'settings',
  string
> = {
  status: '/status',
  calls: '/calls',
  camera: '/camera',
  chats: '/chat',
  settings: '/settings',
} as const;

// =============================================================================
// MainLayout Component
// =============================================================================

/**
 * MainLayout — Authenticated Main Layout
 *
 * Next.js 14 App Router layout for the `(main)` route group. This layout
 * wraps ALL authenticated application pages and orchestrates:
 *
 * 1. **Authentication Guard (R9):**
 *    Checks `isAuthenticated` from the auth store on mount and whenever
 *    auth state changes. Unauthenticated users are immediately redirected
 *    to `/login` via `router.replace()` (not push — prevents back-button
 *    returning to an auth-required page).
 *
 * 2. **Bottom Tab Bar Navigation (Figma node 0:9004):**
 *    Renders the 5-tab bottom navigation bar (Status, Calls, Camera,
 *    Chats, Settings). Active tab is derived from the current pathname.
 *    Tab presses navigate to the corresponding route.
 *
 * 3. **Socket.IO Connection Lifecycle:**
 *    Initializes the WebSocket connection when authenticated and tears
 *    it down on unmount. The `useSocket` hook manages reconnection,
 *    event subscriptions, and offline-to-online sync internally.
 *
 * 4. **Presence Tracking:**
 *    Activates presence subscription (online/offline/typing) via
 *    `usePresence()`. Clears all cached presence data on unmount via
 *    `usePresenceStore().clearAll()`.
 *
 * 5. **Responsive Layout Behavior:**
 *    - **Mobile (≤767px):** Full-width single panel. Conversation list
 *      and chat view are NEVER visible simultaneously (R15). Pages use
 *      stack navigation — opening a conversation replaces the list.
 *    - **Tablet (768–1279px):** Collapsible sidebar + main content.
 *      Sidebar visibility toggled via `isMobileNavOpen` in UI store.
 *    - **Desktop (≥1280px):** Side-by-side flex container. Child pages
 *      render their own sidebar (375px) and content panels within this
 *      flex row.
 *
 * WCAG 2.1 AA Compliance (R34):
 *  - `<main role="main" aria-label="Main content">` ARIA landmark
 *  - Loading state: `aria-busy="true"` and `aria-label="Loading"`
 *  - Tab navigation: delegated to `<TabBar>` which implements
 *    `role="tablist"`, `role="tab"`, `aria-selected`, `aria-current`
 *  - Focus-visible styles inherited from globals.css (#007AFF ring)
 *
 * @param children - Child route pages rendered within the layout
 */
export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // ---------------------------------------------------------------------------
  // Stores & Hooks
  // ---------------------------------------------------------------------------
  const { isAuthenticated, user, isInitialized } = useAuthStore();
  const { isMobileNavOpen, setMobileNavOpen, isEditMode } = useUIStore();
  const { clearAll: clearPresence } = usePresenceStore();
  const router = useRouter();
  const pathname = usePathname();
  // useSocket() manages the Socket.IO lifecycle internally (auto-connect on
  // auth, auto-disconnect on logout). We invoke it here to activate the hook.
  useSocket();
  const { isMobile, isTablet, isDesktop } = useResponsive();

  // Activate presence tracking (online/offline, typing indicators).
  // Invoked with no arguments for global presence subscription —
  // no specific conversation or contact context at the layout level.
  usePresence();

  // ---------------------------------------------------------------------------
  // Effect 1 — Authentication Guard (R9)
  //
  // Redirects unauthenticated users to the login page. Waits for the
  // Zustand persist middleware to finish rehydrating from sessionStorage
  // (indicated by `isInitialized === true`) before evaluating auth state.
  // Without this guard, the initial render sees the default state
  // (isAuthenticated = false) before rehydration completes, causing a
  // false redirect to /login even when valid credentials exist in storage.
  //
  // Once initialized, checks both isAuthenticated flag AND user object
  // presence — handles edge cases where the flag is true but user data
  // hasn't loaded. Uses router.replace() to prevent the protected route
  // from appearing in browser history.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isInitialized) return;
    if (!isAuthenticated || !user) {
      router.replace('/login');
    }
  }, [isInitialized, isAuthenticated, user, router]);

  // ---------------------------------------------------------------------------
  // NOTE: Socket.IO connection lifecycle is managed entirely by useSocket()
  // hook internally (Effect 1 in useSocket.ts). A redundant connect/disconnect
  // effect here was removed because it caused duplicate connection attempts
  // that cascaded into 300+ failed WebSocket connections (Issue #5 fix).
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Effect 2 — Presence State Cleanup
  //
  // Clears all cached presence data (online users, typing indicators,
  // last-seen timestamps) when the layout unmounts (e.g., user navigates
  // away from the authenticated section or logs out).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      clearPresence();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Auth Loading State
  //
  // While the Zustand persist middleware is rehydrating from sessionStorage
  // (isInitialized === false) or the auth guard is evaluating/redirecting,
  // render a blank screen with the app's secondary background color.
  // This prevents flash of authenticated content for unauthenticated users
  // AND prevents a flash-of-unauthenticated-redirect before hydration
  // completes.
  // ---------------------------------------------------------------------------
  if (!isInitialized || !isAuthenticated || !user) {
    return (
      <div
        className="min-h-screen bg-surface"
        aria-busy="true"
        aria-label="Loading"
      />
    );
  }

  // ---------------------------------------------------------------------------
  // Active Tab & Tab Press Handler
  // ---------------------------------------------------------------------------
  const activeTab = getActiveTab(pathname);

  /**
   * Handles tab bar presses by navigating to the corresponding route.
   * On mobile, resets the mobile navigation state so the list view
   * is shown (not a deep conversation view).
   */
  const handleTabPress = (
    tab: 'status' | 'calls' | 'camera' | 'chats' | 'settings',
  ): void => {
    const targetRoute = TAB_ROUTES[tab];

    // Only navigate if switching to a different tab section
    if (!pathname.startsWith(targetRoute)) {
      router.push(targetRoute);
    }

    // On mobile and tablet, reset the nav state to show the list view
    // rather than staying on a deep screen (e.g., /chat/[id]) (R15).
    // Desktop keeps both panels visible simultaneously so no reset needed.
    if (isMobile || isTablet) {
      setMobileNavOpen(true);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="flex flex-col h-screen bg-surface overflow-hidden">
      {/* ARIA landmark: main content area */}
      <main
        className="flex-1 overflow-hidden relative"
        role="main"
        aria-label="Main content"
      >
        {/* Responsive container:
            - Desktop (≥1280px): flex row enables child pages to render
              side-by-side panels (375px sidebar + flex-1 content)
            - Tablet (768–1279px): flex row when sidebar is open
              (isMobileNavOpen), flex column when collapsed. Child pages
              control their own sidebar width (320px).
            - Mobile (≤767px): single column, full-width stack nav (R15) */}
        <div
          className={[
            'h-full',
            isDesktop
              ? 'flex flex-row'
              : isTablet && isMobileNavOpen
                ? 'flex flex-row'
                : 'flex flex-col',
          ].join(' ')}
        >
          {children}
        </div>
      </main>

      {/* Bottom Tab Bar — 5-tab navigation (Figma node 0:9004)
          Fixed at the bottom of the flex column layout. Total height
          83px (49px tabs + 34px home indicator safe area). */}
      {!isEditMode && (
        <TabBar activeTab={activeTab} onTabPress={handleTabPress} />
      )}
    </div>
  );
}
