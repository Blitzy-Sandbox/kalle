import { useState, useEffect, useMemo } from 'react';

/**
 * Responsive breakpoints matching the AAP specification.
 *
 * Mobile:  ≤767px  — Stack navigation, single panel visible (R15)
 * Tablet:  768px–1279px — Collapsible sidebar
 * Desktop: ≥1280px — Side-by-side panels (chat list + conversation)
 *
 * Figma designs are at 375px (iPhone X) — mobile-first responsive strategy (R3)
 */
export const BREAKPOINTS = {
  MOBILE_MAX: 767,
  TABLET_MIN: 768,
  TABLET_MAX: 1279,
  DESKTOP_MIN: 1280,
} as const;

/**
 * MediaQuery strings for window.matchMedia.
 * Using matchMedia instead of resize events for performance —
 * only fires when a breakpoint boundary is crossed, not on every pixel change.
 */
const MEDIA_QUERIES = {
  mobile: `(max-width: ${BREAKPOINTS.MOBILE_MAX}px)`,
  tablet: `(min-width: ${BREAKPOINTS.TABLET_MIN}px) and (max-width: ${BREAKPOINTS.TABLET_MAX}px)`,
  desktop: `(min-width: ${BREAKPOINTS.DESKTOP_MIN}px)`,
} as const;

/**
 * Return type for the useResponsive hook.
 * Provides reactive boolean flags and a named breakpoint string
 * for driving responsive layout decisions across the application.
 */
export interface UseResponsiveReturn {
  /** True when viewport width ≤767px (mobile stack navigation per R15) */
  isMobile: boolean;
  /** True when viewport width 768px–1279px (collapsible sidebar) */
  isTablet: boolean;
  /** True when viewport width ≥1280px (side-by-side panels) */
  isDesktop: boolean;
  /** Current breakpoint name derived from the active boolean flags */
  breakpoint: 'mobile' | 'tablet' | 'desktop';
  /** Current viewport width in pixels */
  width: number;
}

/**
 * Internal state shape managed by useState inside the hook.
 */
interface ResponsiveState {
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  width: number;
}

/**
 * Determines the initial responsive state.
 * SSR-safe: defaults to mobile (375px) on the server to match
 * Figma design dimensions (R3). On the client, reads the actual
 * viewport width from window.innerWidth.
 */
function getInitialState(): ResponsiveState {
  if (typeof window === 'undefined') {
    // Server-side rendering: default to mobile (Figma designs are 375px)
    return { isMobile: true, isTablet: false, isDesktop: false, width: 375 };
  }

  const width = window.innerWidth;
  return {
    isMobile: width <= BREAKPOINTS.MOBILE_MAX,
    isTablet: width >= BREAKPOINTS.TABLET_MIN && width <= BREAKPOINTS.TABLET_MAX,
    isDesktop: width >= BREAKPOINTS.DESKTOP_MIN,
    width,
  };
}

/**
 * Custom React hook for responsive breakpoint detection.
 *
 * Uses `window.matchMedia` for efficient, performant resize detection.
 * Only fires when a breakpoint boundary is crossed — no debounce needed,
 * no re-renders on every pixel change during smooth resizes.
 *
 * Provides reactive `isMobile`, `isTablet`, `isDesktop` boolean flags
 * that drive responsive layout decisions throughout the application:
 * - Mobile (≤767px): Stack navigation — R15 push/pop, single panel visible
 * - Tablet (768–1279px): Collapsible sidebar
 * - Desktop (≥1280px): Side-by-side panels (chat list + conversation)
 *
 * @returns {UseResponsiveReturn} Reactive breakpoint state
 *
 * @example
 * ```tsx
 * const { isMobile, isDesktop, breakpoint } = useResponsive();
 *
 * // R15: Mobile stack navigation
 * if (isMobile) {
 *   return activeConversationId ? <ChatView /> : <ChatList />;
 * }
 *
 * // Desktop: side-by-side panels
 * if (isDesktop) {
 *   return (
 *     <div className="flex">
 *       <ChatList className="w-[375px]" />
 *       <ChatView className="flex-1" />
 *     </div>
 *   );
 * }
 * ```
 */
export function useResponsive(): UseResponsiveReturn {
  const [state, setState] = useState<ResponsiveState>(getInitialState);

  useEffect(() => {
    // Guard against SSR — window is not available on the server
    if (typeof window === 'undefined') return;

    // Create MediaQueryList objects for each breakpoint
    const mobileQuery = window.matchMedia(MEDIA_QUERIES.mobile);
    const tabletQuery = window.matchMedia(MEDIA_QUERIES.tablet);
    const desktopQuery = window.matchMedia(MEDIA_QUERIES.desktop);

    /**
     * Handler that updates state when ANY breakpoint boundary is crossed.
     * Reads the current matches state from all three MediaQueryList objects
     * and the current viewport width to produce a consistent state snapshot.
     */
    const handleChange = (): void => {
      setState({
        isMobile: mobileQuery.matches,
        isTablet: tabletQuery.matches,
        isDesktop: desktopQuery.matches,
        width: window.innerWidth,
      });
    };

    // Register listeners using addEventListener (modern API, not deprecated addListener)
    mobileQuery.addEventListener('change', handleChange);
    tabletQuery.addEventListener('change', handleChange);
    desktopQuery.addEventListener('change', handleChange);

    // Initial sync on mount — corrects any mismatch from SSR default
    handleChange();

    // Cleanup: remove all listeners on unmount
    return () => {
      mobileQuery.removeEventListener('change', handleChange);
      tabletQuery.removeEventListener('change', handleChange);
      desktopQuery.removeEventListener('change', handleChange);
    };
  }, []);

  /**
   * Derived breakpoint name from the boolean flags.
   * Memoized to prevent unnecessary recalculations — only recomputes
   * when the isDesktop or isTablet flags actually change.
   */
  const breakpoint = useMemo((): 'mobile' | 'tablet' | 'desktop' => {
    if (state.isDesktop) return 'desktop';
    if (state.isTablet) return 'tablet';
    return 'mobile';
  }, [state.isDesktop, state.isTablet]);

  return {
    isMobile: state.isMobile,
    isTablet: state.isTablet,
    isDesktop: state.isDesktop,
    breakpoint,
    width: state.width,
  };
}
