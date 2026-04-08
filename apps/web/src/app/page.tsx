'use client';

/**
 * @module apps/web/src/app/page.tsx
 *
 * Root page component for the Kalle WhatsApp clone.
 *
 * This is the entry point (`/`) of the application. It does not render any
 * meaningful UI — its sole responsibility is to check the user's authentication
 * state (via the Zustand auth store) and redirect to the appropriate route:
 *
 * - **Authenticated** → `/chat` (default main view per Figma Screen 1)
 * - **Unauthenticated** → `/login` (auth flow per Figma Screen 0)
 *
 * The component waits for the auth store to finish rehydrating from
 * sessionStorage (`isInitialized`) before making a redirect decision,
 * preventing a flash of the login page on page reload for authenticated users.
 *
 * While the redirect is being determined, a minimal full-viewport loading
 * indicator is displayed using the app's surface background color (#EFEFF4).
 *
 * @see AAP Section 0.2.3 — Root page (redirect to /chat or /auth)
 * @see AAP Section 0.7.1 Group 14 — Root redirect (auth check → /chat or /auth/login)
 * @see R5  — No mock data — real auth state check via Zustand store
 * @see R9  — Unauthenticated users redirected to login
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/authStore';

/**
 * HomePage — Root redirect page.
 *
 * Checks authentication state from the Zustand auth store and performs a
 * client-side redirect using `router.replace()` (not `push()`) to prevent
 * the root page from appearing in browser back-button history.
 *
 * The redirect only fires after the store has finished rehydrating from
 * sessionStorage (`isInitialized === true`), ensuring the auth check
 * reflects persisted session state rather than default (unauthenticated) state.
 *
 * @returns A minimal loading container while the redirect is in progress.
 */
export default function HomePage(): JSX.Element {
  const router = useRouter();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isInitialized = useAuthStore((state) => state.isInitialized);

  useEffect(() => {
    /* Do not redirect until the auth store has finished rehydrating from
     * sessionStorage. Without this guard, the component would always redirect
     * to /login on page reload because the default `isAuthenticated` is false
     * before hydration completes. */
    if (!isInitialized) {
      return;
    }

    if (isAuthenticated) {
      router.replace('/chat');
    } else {
      router.replace('/login');
    }
  }, [isAuthenticated, isInitialized, router]);

  /* Render a minimal full-viewport loading state while the redirect decision
   * is pending. Uses the app's surface background color (bg-surface = #EFEFF4)
   * from the Tailwind design token configuration for visual consistency. */
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-surface"
      aria-busy="true"
      aria-label="Loading application"
    >
      <div className="flex flex-col items-center gap-3">
        {/* Subtle animated loading indicator */}
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-secondary border-t-blue-ios"
          role="status"
          aria-label="Checking authentication status"
        />
        <span className="sr-only">Redirecting…</span>
      </div>
    </main>
  );
}
