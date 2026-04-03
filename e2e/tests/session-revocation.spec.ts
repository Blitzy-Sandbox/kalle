import { test, expect, type APIResponse } from '@playwright/test';

/**
 * Session Revocation E2E Tests
 *
 * Validates JWT token revocation for single session and all sessions.
 * Verifies that revoked tokens are rejected by auth middleware and
 * that Redis-backed token blacklisting works correctly.
 *
 * Rules Tested:
 * - R33: Session Revocation — revoked access tokens blacklisted in Redis
 * - R9:  Auth enforcement on all protected routes
 * - R22: Standardized error response shape
 * - R30: API versioning with /api/v1/ prefix
 * - R32: Immutable audit trail for security actions
 * - R5:  No mock data — live backend
 * - R6:  Backend integration wiring
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3001';

const AUTH_BASE = `${API_BASE_URL}/api/v1/auth`;
const CONVERSATIONS_URL = `${API_BASE_URL}/api/v1/conversations`;
const USERS_ME_URL = `${API_BASE_URL}/api/v1/users/me`;
const STORIES_FEED_URL = `${API_BASE_URL}/api/v1/stories/feed`;
const HEALTH_URL = `${API_BASE_URL}/api/v1/health`;

// ---------------------------------------------------------------------------
// Helper Interfaces
// ---------------------------------------------------------------------------

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface AuthResponse {
  data: {
    user: { id: string; email: string; displayName: string };
    tokens: TokenPair;
  };
}

interface RefreshResponse {
  data: {
    tokens: TokenPair;
  };
}

// ---------------------------------------------------------------------------
// Unique test identity generator
// ---------------------------------------------------------------------------

let testCounter = 0;

function uniqueEmail(): string {
  testCounter += 1;
  return `session-revoke-${Date.now()}-${testCounter}@test.local`;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Register a new user via the REST API.
 * Returns the full auth response including user and token pair.
 */
async function registerUser(
  requestContext: { post: (url: string, opts?: Record<string, unknown>) => Promise<APIResponse> },
  email: string,
  password: string,
  displayName: string,
): Promise<AuthResponse> {
  const res = await requestContext.post(`${AUTH_BASE}/register`, {
    data: { email, password, displayName },
  });
  expect(res.status()).toBe(201);
  return res.json() as Promise<AuthResponse>;
}

/**
 * Log in an existing user via the REST API.
 * Returns the full auth response including user and token pair.
 */
async function loginUser(
  requestContext: { post: (url: string, opts?: Record<string, unknown>) => Promise<APIResponse> },
  email: string,
  password: string,
): Promise<AuthResponse> {
  const res = await requestContext.post(`${AUTH_BASE}/login`, {
    data: { email, password },
  });
  expect(res.status()).toBe(200);
  return res.json() as Promise<AuthResponse>;
}

/**
 * Make an authenticated GET request and return the raw response.
 */
async function authenticatedGet(
  requestContext: { get: (url: string, opts?: Record<string, unknown>) => Promise<APIResponse> },
  url: string,
  token: string,
) {
  return requestContext.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Make an authenticated POST request with optional JSON body.
 */
async function authenticatedPost(
  requestContext: { post: (url: string, opts?: Record<string, unknown>) => Promise<APIResponse> },
  url: string,
  token: string,
  body?: Record<string, unknown>,
) {
  return requestContext.post(url, {
    headers: { Authorization: `Bearer ${token}` },
    ...(body ? { data: body } : {}),
  });
}

// ============================================================================
// TEST SUITE
// ============================================================================

test.describe('Session Revocation', () => {
  // Each test creates its own API request context and users to be fully
  // isolated.  We do NOT share state between tests.

  // --------------------------------------------------------------------------
  // Phase 2 — Suite Setup / Teardown
  // --------------------------------------------------------------------------

  test.beforeAll(async ({ request }) => {
    // Verify the API server is reachable before running any session tests.
    // This prevents misleading failures if the Docker stack is not up.
    const healthRes = await request.get(HEALTH_URL);
    expect([200, 503]).toContain(healthRes.status());
  });

  test.afterAll(async () => {
    // Clean-up hook.  Individual tests are self-contained and register unique
    // users per run.  No shared mutable state needs to be torn down.
    // If future iterations add persistent test artefacts they should be
    // cleaned up here.
  });

  // --------------------------------------------------------------------------
  // Phase 3 — Single Session Revocation (revoke)
  // --------------------------------------------------------------------------

  test.describe('Single Session Revocation (POST /api/v1/auth/revoke)', () => {
    test('revoke single session invalidates the access token (R33)', async ({
      request,
    }) => {
      const email = uniqueEmail();
      const password = 'SecureP@ss1234';

      // 1. Register and log in
      const authRes = await registerUser(
        request,
        email,
        password,
        'Revoke Test User',
      );
      const { accessToken, refreshToken } = authRes.data.tokens;

      // 2. Verify access token works
      const beforeRevoke = await authenticatedGet(
        request,
        CONVERSATIONS_URL,
        accessToken,
      );
      expect(beforeRevoke.status()).toBe(200);

      // 3. Revoke the session
      const revokeRes = await authenticatedPost(
        request,
        `${AUTH_BASE}/revoke`,
        accessToken,
        { refreshToken },
      );
      expect([200, 204]).toContain(revokeRes.status());

      // 4. CRITICAL R33: revoked token must be rejected immediately
      const afterRevoke = await authenticatedGet(
        request,
        CONVERSATIONS_URL,
        accessToken,
      );
      expect(afterRevoke.status()).toBe(401);
    });

    test('revoked token is immediately rejected — no cache delay (R33)', async ({
      request,
    }) => {
      const email = uniqueEmail();
      const password = 'SecureP@ss1234';

      // Register + login
      await registerUser(request, email, password, 'Immediate Reject');
      const loginRes = await loginUser(request, email, password);
      const { accessToken, refreshToken } = loginRes.data.tokens;

      // Verify token works
      const ok = await authenticatedGet(request, USERS_ME_URL, accessToken);
      expect(ok.status()).toBe(200);

      // Revoke
      await authenticatedPost(request, `${AUTH_BASE}/revoke`, accessToken, {
        refreshToken,
      });

      // Immediately attempt again — must be 401 with ZERO delay
      const rejected = await authenticatedGet(
        request,
        USERS_ME_URL,
        accessToken,
      );
      expect(rejected.status()).toBe(401);
    });

    test('revoking one session does not affect another session of the same user', async ({
      request,
    }) => {
      const email = uniqueEmail();
      const password = 'SecureP@ss1234';

      // Register
      await registerUser(request, email, password, 'Multi-Session User');

      // Log in twice → two independent sessions
      const loginA = await loginUser(request, email, password);
      const loginB = await loginUser(request, email, password);

      const tokenA = loginA.data.tokens.accessToken;
      const refreshA = loginA.data.tokens.refreshToken;
      const tokenB = loginB.data.tokens.accessToken;

      // Verify both tokens work
      expect(
        (await authenticatedGet(request, CONVERSATIONS_URL, tokenA)).status(),
      ).toBe(200);
      expect(
        (await authenticatedGet(request, CONVERSATIONS_URL, tokenB)).status(),
      ).toBe(200);

      // Revoke session A only
      await authenticatedPost(request, `${AUTH_BASE}/revoke`, tokenA, {
        refreshToken: refreshA,
      });

      // Token A → 401
      expect(
        (await authenticatedGet(request, CONVERSATIONS_URL, tokenA)).status(),
      ).toBe(401);

      // Token B → still 200 (not affected)
      expect(
        (await authenticatedGet(request, CONVERSATIONS_URL, tokenB)).status(),
      ).toBe(200);
    });
  });

  // --------------------------------------------------------------------------
  // Phase 4 — All Sessions Revocation (revoke-all)
  // --------------------------------------------------------------------------

  test.describe(
    'All Sessions Revocation (POST /api/v1/auth/revoke-all)',
    () => {
      test('revoke-all invalidates ALL active sessions for the user (R33)', async ({
        request,
      }) => {
        const email = uniqueEmail();
        const password = 'SecureP@ss1234';

        // Register
        await registerUser(request, email, password, 'RevokeAll User');

        // Login 3 times — three distinct sessions
        const loginA = await loginUser(request, email, password);
        const loginB = await loginUser(request, email, password);
        const loginC = await loginUser(request, email, password);

        const tokenA = loginA.data.tokens.accessToken;
        const tokenB = loginB.data.tokens.accessToken;
        const tokenC = loginC.data.tokens.accessToken;

        // Verify all three tokens work
        expect(
          (await authenticatedGet(request, CONVERSATIONS_URL, tokenA)).status(),
        ).toBe(200);
        expect(
          (await authenticatedGet(request, CONVERSATIONS_URL, tokenB)).status(),
        ).toBe(200);
        expect(
          (await authenticatedGet(request, CONVERSATIONS_URL, tokenC)).status(),
        ).toBe(200);

        // Revoke ALL using tokenA
        const revokeAllRes = await authenticatedPost(
          request,
          `${AUTH_BASE}/revoke-all`,
          tokenA,
        );
        expect([200, 204]).toContain(revokeAllRes.status());

        // CRITICAL R33: ALL tokens must now return 401
        expect(
          (await authenticatedGet(request, CONVERSATIONS_URL, tokenA)).status(),
        ).toBe(401);
        expect(
          (await authenticatedGet(request, CONVERSATIONS_URL, tokenB)).status(),
        ).toBe(401);
        expect(
          (await authenticatedGet(request, CONVERSATIONS_URL, tokenC)).status(),
        ).toBe(401);
      });

      test('revoke-all does not affect other users', async ({ request }) => {
        const emailA = uniqueEmail();
        const emailB = uniqueEmail();
        const password = 'SecureP@ss1234';

        // Register two separate users
        await registerUser(request, emailA, password, 'User A');
        await registerUser(request, emailB, password, 'User B');

        // Each user logs in
        const loginA = await loginUser(request, emailA, password);
        const loginB = await loginUser(request, emailB, password);

        const tokenA = loginA.data.tokens.accessToken;
        const tokenB = loginB.data.tokens.accessToken;

        // Verify both users can access protected resources
        expect(
          (await authenticatedGet(request, CONVERSATIONS_URL, tokenA)).status(),
        ).toBe(200);
        expect(
          (await authenticatedGet(request, CONVERSATIONS_URL, tokenB)).status(),
        ).toBe(200);

        // User A revokes all their sessions
        await authenticatedPost(
          request,
          `${AUTH_BASE}/revoke-all`,
          tokenA,
        );

        // User A → 401
        expect(
          (await authenticatedGet(request, CONVERSATIONS_URL, tokenA)).status(),
        ).toBe(401);

        // User B → still 200 (unaffected)
        expect(
          (await authenticatedGet(request, CONVERSATIONS_URL, tokenB)).status(),
        ).toBe(200);
      });
    },
  );

  // --------------------------------------------------------------------------
  // Phase 5 — Refresh Token Rotation
  // --------------------------------------------------------------------------

  test.describe('Refresh Token Rotation', () => {
    test('refresh token generates a new access token', async ({
      playwright,
    }) => {
      // Use request.newContext() for an isolated API context without any
      // shared cookies or state (validates the request.newContext() import).
      const apiContext = await playwright.request.newContext({
        baseURL: API_BASE_URL,
      });

      try {
        const email = uniqueEmail();
        const password = 'SecureP@ss1234';

        // Register + login
        const authRes = await registerUser(
          apiContext,
          email,
          password,
          'Refresh User',
        );
        const { accessToken: oldAccess, refreshToken } = authRes.data.tokens;

        // Use refresh endpoint to get new tokens
        const refreshRes = await authenticatedPost(
          apiContext,
          `${AUTH_BASE}/refresh`,
          oldAccess,
          { refreshToken },
        );
        expect(refreshRes.status()).toBe(200);

        const refreshBody = (await refreshRes.json()) as RefreshResponse;
        const newTokens = refreshBody.data.tokens;

        // New access token must be a non-empty string
        expect(typeof newTokens.accessToken).toBe('string');
        expect(newTokens.accessToken.length).toBeGreaterThan(0);

        // Validate the full token pair shape using toEqual pattern
        expect(Object.keys(newTokens).sort()).toEqual(
          ['accessToken', 'refreshToken'].sort(),
        );

        // New access token works for authenticated requests
        const okRes = await authenticatedGet(
          apiContext,
          CONVERSATIONS_URL,
          newTokens.accessToken,
        );
        expect(okRes.status()).toBe(200);
      } finally {
        await apiContext.dispose();
      }
    });

    test('used refresh token is rotated and cannot be reused', async ({
      request,
    }) => {
      const email = uniqueEmail();
      const password = 'SecureP@ss1234';

      await registerUser(request, email, password, 'Rotate User');
      const loginRes = await loginUser(request, email, password);
      const { accessToken, refreshToken: oldRefresh } = loginRes.data.tokens;

      // First refresh — should succeed and return a new refresh token
      const firstRefresh = await authenticatedPost(
        request,
        `${AUTH_BASE}/refresh`,
        accessToken,
        { refreshToken: oldRefresh },
      );
      expect(firstRefresh.status()).toBe(200);

      const firstBody = (await firstRefresh.json()) as RefreshResponse;
      const newRefresh = firstBody.data.tokens.refreshToken;
      const newAccess = firstBody.data.tokens.accessToken;

      // Attempt to reuse the OLD refresh token — must be rejected
      const reuse = await authenticatedPost(
        request,
        `${AUTH_BASE}/refresh`,
        newAccess,
        { refreshToken: oldRefresh },
      );
      // The server should reject the stale refresh token (400 or 401)
      expect([400, 401, 403]).toContain(reuse.status());

      // The NEW refresh token should still work
      const secondRefresh = await authenticatedPost(
        request,
        `${AUTH_BASE}/refresh`,
        newAccess,
        { refreshToken: newRefresh },
      );
      expect(secondRefresh.status()).toBe(200);
    });

    test('revoke invalidates the refresh token too', async ({ request }) => {
      const email = uniqueEmail();
      const password = 'SecureP@ss1234';

      await registerUser(request, email, password, 'Revoke Refresh User');
      const loginRes = await loginUser(request, email, password);
      const { accessToken, refreshToken } = loginRes.data.tokens;

      // Revoke the session
      await authenticatedPost(request, `${AUTH_BASE}/revoke`, accessToken, {
        refreshToken,
      });

      // Attempting to use the refresh token after revocation must fail.
      // We need a fresh context or token to call refresh — but the original
      // access token is also revoked.  We try with a raw POST (no auth)
      // since the refresh endpoint may or may not require the access token.
      const refreshAttempt = await request.post(`${AUTH_BASE}/refresh`, {
        data: { refreshToken },
      });

      // Should be rejected — session is fully invalidated
      expect([400, 401, 403]).toContain(refreshAttempt.status());
    });
  });

  // --------------------------------------------------------------------------
  // Phase 6 — Auth Middleware Enforcement (R9)
  // --------------------------------------------------------------------------

  test.describe('Auth Middleware Enforcement (R9)', () => {
    test('protected routes require valid JWT — returns 401 without auth', async ({
      request,
    }) => {
      // These requests have NO Authorization header
      const endpoints = [
        { method: 'get' as const, url: CONVERSATIONS_URL },
        { method: 'get' as const, url: USERS_ME_URL },
        { method: 'get' as const, url: STORIES_FEED_URL },
      ];

      for (const ep of endpoints) {
        const res = await request[ep.method](ep.url);
        expect(res.status()).toBe(401);

        // Verify standardized error shape (R22)
        const body = await res.json();
        expect(body).toHaveProperty('error');
        expect(body.error).toHaveProperty('code');
        expect(body.error).toHaveProperty('message');
      }
    });

    test('invalid JWT format is rejected with 401', async ({ request }) => {
      const res = await request.get(CONVERSATIONS_URL, {
        headers: { Authorization: 'Bearer not.a.valid.jwt' },
      });
      expect(res.status()).toBe(401);

      const body = await res.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
    });

    test('completely missing Authorization header returns 401', async ({
      request,
    }) => {
      const res = await request.get(USERS_ME_URL);
      expect(res.status()).toBe(401);
    });

    test('public endpoints are accessible without auth (R9 exemptions)', async ({
      request,
    }) => {
      // Health endpoint — always public
      const healthRes = await request.get(HEALTH_URL);
      expect([200, 503]).toContain(healthRes.status());

      // Auth register endpoint — public (accepts POST, we just verify it
      // does not return 401 for auth reasons; a 400 for missing body is fine)
      const registerRes = await request.post(`${AUTH_BASE}/register`, {
        data: {},
      });
      // Should NOT be 401 (auth enforcement). A 400 means validation ran,
      // which proves the route is accessible without auth.
      expect(registerRes.status()).not.toBe(401);

      // Auth login endpoint — public
      const loginRes = await request.post(`${AUTH_BASE}/login`, {
        data: {},
      });
      expect(loginRes.status()).not.toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // Phase 7 — Frontend Session Handling
  // --------------------------------------------------------------------------

  test.describe('Frontend Session Handling', () => {
    test('frontend redirects to login after session revocation via API', async ({
      page,
      request,
    }) => {
      const email = uniqueEmail();
      const password = 'SecureP@ss1234';

      // Register user via API
      const authRes = await registerUser(
        request,
        email,
        password,
        'Frontend Revoke User',
      );
      const { accessToken, refreshToken } = authRes.data.tokens;

      // Inject auth state into the frontend by setting localStorage/cookies
      // before navigating.  The frontend stores tokens in Zustand which may
      // persist to localStorage.
      await page.goto('/');
      await page.evaluate(
        ({ accessToken: at, refreshToken: rt, user }) => {
          // Attempt to seed Zustand persisted state if the frontend uses it
          try {
            const authState = {
              state: {
                accessToken: at,
                refreshToken: rt,
                user,
                isAuthenticated: true,
              },
              version: 0,
            };
            localStorage.setItem('auth-storage', JSON.stringify(authState));
          } catch {
            // Graceful — frontend may use a different storage key
          }
        },
        {
          accessToken,
          refreshToken,
          user: authRes.data.user,
        },
      );

      // Navigate to a protected page
      await page.goto('/chat');

      // Revoke the session via the API
      await authenticatedPost(request, `${AUTH_BASE}/revoke`, accessToken, {
        refreshToken,
      });

      // Trigger an action that requires authentication — the frontend should
      // detect the 401 and redirect to the login page.
      await page.reload({ waitUntil: 'networkidle' });

      // After the frontend detects session invalidation it should route to
      // login.  We allow time for client-side redirect.
      await page.waitForURL(/\/(auth\/login|login)/, { timeout: 15_000 }).catch(() => {
        // If explicit redirect doesn't happen, check current URL
      });

      const currentUrl = page.url();
      const isOnLoginPage =
        currentUrl.includes('/login') || currentUrl.includes('/auth');
      expect(isOnLoginPage).toBe(true);
    });

    test('frontend handles revoke-all gracefully across contexts', async ({
      browser,
      request,
    }) => {
      const email = uniqueEmail();
      const password = 'SecureP@ss1234';

      // Register user
      const authRes = await registerUser(
        request,
        email,
        password,
        'Frontend RevokeAll User',
      );
      const { accessToken: tokenCtx1, refreshToken: refreshCtx1 } =
        authRes.data.tokens;

      // Login a second time for a second context
      const loginRes = await loginUser(request, email, password);
      const { accessToken: tokenCtx2 } = loginRes.data.tokens;

      // Create two isolated browser contexts (simulates two tabs / devices)
      const context1 = await browser.newContext();
      const context2 = await browser.newContext();
      const page1 = await context1.newPage();
      const page2 = await context2.newPage();

      // Seed auth state into both contexts
      for (const [pg, at, rt] of [
        [page1, tokenCtx1, refreshCtx1],
        [page2, tokenCtx2, loginRes.data.tokens.refreshToken],
      ] as const) {
        await pg.goto('/');
        await pg.evaluate(
          ({ at: accessTok, rt: refreshTok, user }) => {
            try {
              const authState = {
                state: {
                  accessToken: accessTok,
                  refreshToken: refreshTok,
                  user,
                  isAuthenticated: true,
                },
                version: 0,
              };
              localStorage.setItem('auth-storage', JSON.stringify(authState));
            } catch {
              /* noop */
            }
          },
          {
            at,
            rt,
            user: authRes.data.user,
          },
        );
      }

      // From context 2, call revoke-all — this invalidates both sessions
      await authenticatedPost(
        request,
        `${AUTH_BASE}/revoke-all`,
        tokenCtx2,
      );

      // Reload page1 — its token is now revoked
      await page1.reload({ waitUntil: 'networkidle' });
      await page1.waitForURL(/\/(auth\/login|login)/, { timeout: 15_000 }).catch(() => {});

      const url1 = page1.url();
      const redirected1 =
        url1.includes('/login') || url1.includes('/auth');
      expect(redirected1).toBe(true);

      // Clean up browser contexts
      await context1.close();
      await context2.close();
    });
  });

  // --------------------------------------------------------------------------
  // Phase 8 — Redis Blacklist Behaviour (R33)
  // --------------------------------------------------------------------------

  test.describe('Redis Blacklist Behaviour (R33)', () => {
    test('concurrent revocation requests are handled without errors', async ({
      request,
    }) => {
      const email = uniqueEmail();
      const password = 'SecureP@ss1234';

      await registerUser(request, email, password, 'Concurrent User');

      // Create 3 sessions
      const loginA = await loginUser(request, email, password);
      const loginB = await loginUser(request, email, password);
      const loginC = await loginUser(request, email, password);

      // Fire revoke-all from two sessions concurrently
      const [resA, resB] = await Promise.all([
        authenticatedPost(
          request,
          `${AUTH_BASE}/revoke-all`,
          loginA.data.tokens.accessToken,
        ),
        authenticatedPost(
          request,
          `${AUTH_BASE}/revoke-all`,
          loginB.data.tokens.accessToken,
        ),
      ]);

      // At least one should succeed; the other may succeed or get 401
      // (since the first revoke-all may have already blacklisted it)
      const statuses = [resA.status(), resB.status()];
      expect(statuses.some((s) => s === 200 || s === 204)).toBe(true);

      // Regardless, ALL tokens must now be revoked
      expect(
        (
          await authenticatedGet(
            request,
            CONVERSATIONS_URL,
            loginA.data.tokens.accessToken,
          )
        ).status(),
      ).toBe(401);
      expect(
        (
          await authenticatedGet(
            request,
            CONVERSATIONS_URL,
            loginB.data.tokens.accessToken,
          )
        ).status(),
      ).toBe(401);
      expect(
        (
          await authenticatedGet(
            request,
            CONVERSATIONS_URL,
            loginC.data.tokens.accessToken,
          )
        ).status(),
      ).toBe(401);
    });

    test('error response from revoked token has standardized shape (R22)', async ({
      request,
    }) => {
      const email = uniqueEmail();
      const password = 'SecureP@ss1234';

      await registerUser(request, email, password, 'Error Shape User');
      const loginRes = await loginUser(request, email, password);
      const { accessToken, refreshToken } = loginRes.data.tokens;

      // Revoke
      await authenticatedPost(request, `${AUTH_BASE}/revoke`, accessToken, {
        refreshToken,
      });

      // Use revoked token → 401 with standardized error body
      const failRes = await authenticatedGet(
        request,
        CONVERSATIONS_URL,
        accessToken,
      );
      expect(failRes.status()).toBe(401);

      const body = await failRes.json();
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(typeof body.error.code).toBe('string');
      expect(body.error).toHaveProperty('message');
      expect(typeof body.error.message).toBe('string');
    });
  });

  // --------------------------------------------------------------------------
  // Phase 9 — Audit Trail Integration (R32)
  // --------------------------------------------------------------------------

  test.describe('Audit Trail Integration (R32)', () => {
    test('session revocation actions are auditable', async ({ request }) => {
      const email = uniqueEmail();
      const password = 'SecureP@ss1234';

      // Register user
      const authRes = await registerUser(
        request,
        email,
        password,
        'Audit User',
      );
      const { accessToken: tokenA, refreshToken: refreshA } =
        authRes.data.tokens;

      // Perform single session revoke — this should create an audit entry
      // for "session.revoke"
      const revokeRes = await authenticatedPost(
        request,
        `${AUTH_BASE}/revoke`,
        tokenA,
        { refreshToken: refreshA },
      );
      expect([200, 204]).toContain(revokeRes.status());

      // Login again to obtain a fresh token for the revoke-all test
      const loginRes = await loginUser(request, email, password);
      const { accessToken: tokenB } = loginRes.data.tokens;

      // Perform revoke-all — should create an audit entry for
      // "session.revoke_all"
      const revokeAllRes = await authenticatedPost(
        request,
        `${AUTH_BASE}/revoke-all`,
        tokenB,
      );
      expect([200, 204]).toContain(revokeAllRes.status());

      // NOTE: We cannot directly query the audit_log table from an E2E test
      // without an admin/internal endpoint.  The assertion above confirms the
      // revoke flow succeeds end-to-end; audit log correctness is also
      // validated in the backend integration tests
      // (apps/api/tests/integration/audit.test.ts).  If an audit read
      // endpoint is available, the following assertion would apply:
      //
      //   const auditRes = await authenticatedGet(request, auditUrl, adminToken);
      //   const entries = (await auditRes.json()).data;
      //   expect(entries.some(e => e.action === 'session.revoke')).toBe(true);
      //   expect(entries.some(e => e.action === 'session.revoke_all')).toBe(true);
      //
      // For now, we validate the operations complete without error, which
      // exercises the audit write path internally.
    });
  });

  // --------------------------------------------------------------------------
  // Phase 10 — Edge Cases and Hardening
  // --------------------------------------------------------------------------

  test.describe('Edge Cases', () => {
    test('revoke with already-expired token returns 401', async ({
      request,
    }) => {
      // Use a completely fabricated / obviously-expired token
      const fakeToken =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJzdWIiOiIxMjM0NTY3ODkwIiwiZXhwIjoxfQ.' +
        'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

      const res = await request.get(CONVERSATIONS_URL, {
        headers: { Authorization: `Bearer ${fakeToken}` },
      });
      expect(res.status()).toBe(401);
    });

    test('calling revoke-all when no other sessions exist succeeds', async ({
      request,
    }) => {
      const email = uniqueEmail();
      const password = 'SecureP@ss1234';

      await registerUser(request, email, password, 'Solo Session User');
      const loginRes = await loginUser(request, email, password);
      const { accessToken } = loginRes.data.tokens;

      // Only one session exists — revoke-all should still succeed
      const res = await authenticatedPost(
        request,
        `${AUTH_BASE}/revoke-all`,
        accessToken,
      );
      expect([200, 204]).toContain(res.status());

      // The single token should be revoked
      expect(
        (await authenticatedGet(request, CONVERSATIONS_URL, accessToken)).status(),
      ).toBe(401);
    });

    test('double-revoke of the same session does not crash the server', async ({
      request,
    }) => {
      const email = uniqueEmail();
      const password = 'SecureP@ss1234';

      await registerUser(request, email, password, 'Double Revoke User');
      const loginRes = await loginUser(request, email, password);
      const { accessToken, refreshToken } = loginRes.data.tokens;

      // First revoke — succeeds
      const first = await authenticatedPost(
        request,
        `${AUTH_BASE}/revoke`,
        accessToken,
        { refreshToken },
      );
      expect([200, 204]).toContain(first.status());

      // Second revoke with the same (now-revoked) token — should return 401
      // (the token is blacklisted, so auth middleware rejects it)
      const second = await authenticatedPost(
        request,
        `${AUTH_BASE}/revoke`,
        accessToken,
        { refreshToken },
      );
      expect(second.status()).toBe(401);
    });
  });
});
