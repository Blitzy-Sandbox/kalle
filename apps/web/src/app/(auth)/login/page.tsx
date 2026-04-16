'use client';

/* =============================================================================
 * Login Page — Email + Password Authentication
 * =============================================================================
 *
 * URL: /login (within (auth) route group — parentheses excluded from URL)
 *
 * Standard email + password login form that POSTs to
 * POST /api/v1/auth/login and redirects to /chat on success.
 *
 * Unauthenticated-only: redirects to /chat when user is already authenticated.
 *
 * Replaces the previous phone-number keypad UI (Directive 1 bug fix).
 * ========================================================================== */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/authStore';

/* =============================================================================
 * Local Type Definitions
 * =============================================================================
 * Define minimal interface types that structurally match the API response
 * shape from POST /api/v1/auth/login. The authStore.login() call uses
 * TypeScript structural typing to verify compatibility with the store's
 * TokenPair and UserResponse parameter types at the call site.
 * ========================================================================== */

/** Token pair from the authentication API — matches @kalle/shared TokenPair */
interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

/** User data from the authentication API — structurally compatible with
 *  @kalle/shared UserResponse for the authStore.login() call site. */
interface AuthUserData {
  id: string;
  email: string;
  displayName: string;
  avatar?: string;
  phoneNumber?: string;
  about?: string;
  status: string;
  lastSeen?: string;
  createdAt: string;
  updatedAt: string;
}

/** Full API response from POST /api/v1/auth/login */
interface AuthLoginResponse {
  tokens: AuthTokens;
  user: AuthUserData;
}

/* =============================================================================
 * LoginPage Component
 * =============================================================================
 *
 * Presents a standard email + password form. On successful authentication
 * the user is redirected to /chat. If already authenticated, immediately
 * redirects via useEffect guard.
 *
 * Accessibility: WCAG 2.1 AA — proper label associations, ARIA live error
 * region, keyboard-operable form, autoComplete hints.
 * ========================================================================== */

export default function LoginPage(): JSX.Element {
  /* ─── Local State ──────────────────────────────────────────────────── */
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  /* ─── Store & Router ───────────────────────────────────────────────── */
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const login = useAuthStore((state) => state.login);
  const router = useRouter();

  /* ─── Auth Redirect — unauthenticated-only page ────────────────────── */
  useEffect(() => {
    if (isAuthenticated) {
      router.replace('/chat');
    }
  }, [isAuthenticated, router]);

  /* ─── Submit Handler ───────────────────────────────────────────────── */
  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();

      /* Validate non-empty fields before network call */
      if (!email.trim() || !password) return;
      if (isSubmitting) return;

      setIsSubmitting(true);
      setError(null);

      try {
        const apiUrl =
          process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

        const response = await fetch(`${apiUrl}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), password }),
        });

        if (!response.ok) {
          if (response.status === 401) {
            setError('Invalid email or password');
          } else {
            setError('An error occurred. Please try again.');
          }
          return;
        }

        const data: AuthLoginResponse = await response.json();

        /* Store tokens and user data (two-arg signature per authStore).
           Type assertion bridges local AuthLoginResponse types with the
           store's TokenPair / UserResponse types from @kalle/shared — both
           are structurally compatible, but the enum nominal type for
           UserStatus requires an explicit cast at the module boundary. */
        useAuthStore
          .getState()
          .login(
            data.tokens as Parameters<typeof login>[0],
            data.user as Parameters<typeof login>[1],
          );

        router.push('/chat');
      } catch {
        setError('An error occurred. Please try again.');
      } finally {
        setIsSubmitting(false);
      }
    },
    [email, password, isSubmitting, router],
  );

  /* ─── Render ───────────────────────────────────────────────────────── */
  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-white px-4">
      <div className="w-full max-w-md">
        {/* ── Heading ─────────────────────────────────────────────── */}
        <h1 className="mb-8 text-center text-2xl font-semibold text-gray-900">
          Sign in to Kalle
        </h1>

        {/* ── Login Form ──────────────────────────────────────────── */}
        <form onSubmit={handleSubmit} noValidate>
          {/* Email field */}
          <div className="mb-4">
            <label
              htmlFor="email"
              className="mb-1 block text-sm font-medium text-gray-700"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email address"
              required
              autoComplete="email"
              disabled={isSubmitting}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#25D366] disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          {/* Password field */}
          <div className="mb-4">
            <label
              htmlFor="password"
              className="mb-1 block text-sm font-medium text-gray-700"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
              autoComplete="current-password"
              disabled={isSubmitting}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-gray-900 placeholder-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#25D366] disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          {/* Error message — ARIA live region for screen reader announcement */}
          <div role="status" aria-live="polite" className="mb-4 min-h-[1.5rem]">
            {error && (
              <p className="text-center text-sm text-red-500">{error}</p>
            )}
          </div>

          {/* Submit button */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-lg bg-[#25D366] px-4 py-2.5 text-base font-semibold text-white transition-colors hover:bg-[#128C7E] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#128C7E] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        {/* ── Demo Credential Hint ────────────────────────────────── */}
        <div className="mt-6 rounded-lg bg-gray-50 p-3 text-center text-sm text-gray-600">
          <p className="font-medium text-gray-700">Demo Credentials</p>
          <p className="mt-1">
            sabohiddin@demo.kalle.app / Demo@Pass123!
          </p>
        </div>
      </div>
    </main>
  );
}
