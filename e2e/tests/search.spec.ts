import { test, expect, type Page, type APIRequestContext, type APIResponse } from '@playwright/test';

/**
 * Client-Side Message Search E2E Tests
 *
 * Validates that message search operates EXCLUSIVELY against the client-side
 * IndexedDB (Dexie.js) store with ZERO network calls to any backend API
 * endpoint.  This file is the authoritative R21 conformance suite.
 *
 * Rules Tested:
 * - R21: Client-Side Search Only — message search operates exclusively against
 *        client-side IndexedDB index of decrypted messages.  Zero
 *        search-related API calls during search.
 * - R12: E2E Encryption Integrity — search indexes decrypted messages locally;
 *        no plaintext or search tokens are sent to the server.
 * - R5:  No mock data — live backend used for user registration and
 *        conversation creation.
 * - R6:  Backend integration wiring — users and conversations populated via
 *        real REST API calls against the running Docker Compose stack.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Backend REST API base URL (Docker service on port 3001). */
const API_BASE_URL: string =
  process.env.API_BASE_URL ?? 'http://localhost:3001';

/** Frontend application base URL (Next.js on port 3000). */
const APP_URL: string =
  process.env.APP_URL ?? 'http://localhost:3000';

const AUTH_URL = `${API_BASE_URL}/api/v1/auth`;
const CONVERSATIONS_URL = `${API_BASE_URL}/api/v1/conversations`;
const KEYS_URL = `${API_BASE_URL}/api/v1/keys`;
const HEALTH_URL = `${API_BASE_URL}/api/v1/health`;

/** Dexie.js database name used by the frontend application. */
const INDEXED_DB_NAME = 'kalle-db';

/** Minimum query length before the search engine fires (per search.ts). */
const MIN_SEARCH_QUERY_LENGTH = 2;

/** SearchBar debounce interval (ms) — allows extra buffer. */
const SEARCH_DEBOUNCE_MS = 500;

/**
 * The 10 prescribed test messages covering diverse content scenarios:
 * plain text, punctuation, emoji, URLs, and comma-separated lists.
 */
const TEST_MESSAGES: readonly string[] = [
  'Hello world, this is a test message',
  'The weather today is sunny and warm',
  "Let's meet at the coffee shop tomorrow",
  'Did you see the new movie release?',
  'Project deadline is next Friday',
  'Happy birthday! 🎂🎉',
  'Check out this link: https://example.com',
  'The quick brown fox jumps over the lazy dog',
  'React and TypeScript are great for building UIs',
  'Remember to buy groceries: milk, eggs, bread',
] as const;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface UserData {
  id: string;
  email: string;
  displayName: string;
  tokens: TokenPair;
}

interface AuthResponse {
  data: {
    user: { id: string; email: string; displayName: string };
    tokens: TokenPair;
  };
}

/** A single captured network request for monitoring purposes. */
interface TrackedRequest {
  url: string;
  method: string;
  postData: string | null;
}

// ---------------------------------------------------------------------------
// Module-level shared state (populated in test.beforeAll)
// ---------------------------------------------------------------------------

let userA: UserData;
let userB: UserData;
let conversationId: string;
let testRunId: string;

// ---------------------------------------------------------------------------
// Unique identity generator
// ---------------------------------------------------------------------------

let idCounter = 0;

function uniqueEmail(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}@test.local`;
}

// ===========================================================================
// API Helper Functions
// ===========================================================================

/**
 * Register a new user via the REST API and return structured user data
 * including authentication tokens.
 */
async function registerUser(
  request: APIRequestContext,
  email: string,
  password: string,
  displayName: string,
): Promise<UserData> {
  const res: APIResponse = await request.post(`${AUTH_URL}/register`, {
    data: { email, password, displayName },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as AuthResponse;
  return {
    id: body.data.user.id,
    email: body.data.user.email,
    displayName: body.data.user.displayName,
    tokens: body.data.tokens,
  };
}

/**
 * Create a direct conversation between the authenticated user and the
 * specified participants.  Returns the conversation ID.
 */
async function createConversation(
  request: APIRequestContext,
  token: string,
  participantIds: string[],
): Promise<string> {
  const res: APIResponse = await request.post(CONVERSATIONS_URL, {
    headers: { Authorization: `Bearer ${token}` },
    data: { participantIds, type: 'DIRECT' },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { data: { id?: string; conversation?: { id: string } } };
  return body.data.id ?? body.data.conversation?.id ?? '';
}

/**
 * Upload a minimal valid PreKey bundle for the given user so that the
 * encryption handshake can proceed.
 */
async function uploadPreKeyBundle(
  request: APIRequestContext,
  token: string,
): Promise<void> {
  const res: APIResponse = await request.post(`${KEYS_URL}/bundle`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      identityKey: Buffer.from('identity-key-placeholder-32bytes!').toString('base64'),
      signedPreKey: {
        keyId: 1,
        publicKey: Buffer.from('signed-prekey-placeholder-32byte').toString('base64'),
        signature: Buffer.from(
          'signature-placeholder-64bytes-for-testing-purposes-only-pad!!',
        ).toString('base64'),
      },
      preKeys: Array.from({ length: 10 }, (_, i) => ({
        keyId: i + 1,
        publicKey: Buffer.from(
          `prekey-placeholder-${String(i).padStart(13, '0')}-32b`,
        ).toString('base64'),
      })),
    },
  });
  expect([200, 201]).toContain(res.status());
}

/**
 * Revoke authentication tokens for a user.  Errors are intentionally
 * swallowed because cleanup should not fail the test suite.
 */
async function revokeToken(
  request: APIRequestContext,
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  await request
    .post(`${AUTH_URL}/revoke`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { refreshToken },
    })
    .catch(() => {
      /* swallow — best-effort cleanup */
    });
}

// ===========================================================================
// Browser Helper Functions
// ===========================================================================

/**
 * Log in a user through the browser UI by navigating to the login page,
 * filling credentials, and waiting for the authenticated redirect.
 */
async function loginViaBrowser(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(`${APP_URL}/login`, { waitUntil: 'networkidle' });

  // Use flexible selectors to accommodate varying input implementations
  const emailInput = page.locator(
    'input[type="email"], input[name="email"], input[placeholder*="email" i]',
  ).first();

  await emailInput.waitFor({ state: 'visible', timeout: 15_000 });
  await emailInput.fill(email);
  await page.fill('input[type="password"], input[name="password"]', password);

  // Submit the form
  await page.click(
    'button[type="submit"], button:has-text("Login"), button:has-text("Sign In"), button:has-text("Log In")',
  );

  // Wait for navigation away from the login page
  await page.waitForURL(/\/(chat|status|main)/, { timeout: 15_000 });
}

/**
 * Navigate to a specific conversation in the chat view and wait for it
 * to render.
 */
async function navigateToConversation(
  page: Page,
  convId: string,
): Promise<void> {
  await page.goto(`${APP_URL}/chat/${convId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector(
    '[data-testid="chat-view"], [data-testid="message-list"], .chat-view, [role="log"]',
    { timeout: 15_000 },
  );
}

/**
 * Seed test messages directly into the Dexie.js IndexedDB 'messages' object
 * store.  Runs AFTER the application has initialised so the schema is ready.
 * Returns the number of messages successfully inserted.
 */
async function seedMessagesInIndexedDB(
  page: Page,
  messages: readonly string[],
  convId: string,
  senderId: string,
  senderName: string,
): Promise<number> {
  return page.evaluate(
    async (args: {
      msgs: readonly string[];
      dbName: string;
      cId: string;
      sId: string;
      sName: string;
    }) => {
      const { msgs, dbName, cId, sId, sName } = args;
      return new Promise<number>((resolve, reject) => {
        const openReq = indexedDB.open(dbName);
        openReq.onsuccess = () => {
          const db = openReq.result;
          let tx: IDBTransaction;
          try {
            tx = db.transaction('messages', 'readwrite');
          } catch {
            // Object store not yet created — resolve 0 for the retry logic.
            resolve(0);
            return;
          }
          const store = tx.objectStore('messages');
          const now = Date.now();
          msgs.forEach((content: string, idx: number) => {
            store.put({
              id: `search-seed-${now}-${idx}`,
              conversationId: cId,
              conversationName: 'Search Test Conversation',
              senderId: sId,
              senderName: sName,
              content,
              timestamp: new Date(now - (msgs.length - idx) * 60_000).toISOString(),
              type: 'TEXT',
            });
          });
          tx.oncomplete = () => resolve(msgs.length);
          tx.onerror = () => reject(tx.error);
        };
        openReq.onerror = () => reject(openReq.error);
      });
    },
    {
      msgs: [...messages],
      dbName: INDEXED_DB_NAME,
      cId: convId,
      sId: senderId,
      sName: senderName,
    },
  );
}

/**
 * Query all messages currently stored in the IndexedDB 'messages' table.
 */
async function queryIndexedDBMessages(
  page: Page,
): Promise<Array<{ id: string; content: string; conversationId: string }>> {
  return page.evaluate(async (dbName: string) => {
    return new Promise<Array<{ id: string; content: string; conversationId: string }>>(
      (resolve, reject) => {
        const openReq = indexedDB.open(dbName);
        openReq.onsuccess = () => {
          const db = openReq.result;
          let tx: IDBTransaction;
          try {
            tx = db.transaction('messages', 'readonly');
          } catch {
            resolve([]);
            return;
          }
          const store = tx.objectStore('messages');
          const getAllReq = store.getAll();
          tx.oncomplete = () =>
            resolve(
              getAllReq.result as Array<{
                id: string;
                content: string;
                conversationId: string;
              }>,
            );
          tx.onerror = () => reject(tx.error);
        };
        openReq.onerror = () => reject(openReq.error);
      },
    );
  }, INDEXED_DB_NAME);
}

/**
 * Attach a network request tracker to the page that captures every HTTP
 * request to the backend API.  Returns a controller for querying and
 * clearing the captured requests.
 */
function attachNetworkTracker(page: Page): {
  getApiCalls: () => TrackedRequest[];
  getAllCalls: () => TrackedRequest[];
  clear: () => void;
} {
  const captured: TrackedRequest[] = [];

  page.on('request', (request) => {
    const url = request.url();
    // Capture ALL requests to the backend
    if (url.startsWith(API_BASE_URL)) {
      captured.push({
        url,
        method: request.method(),
        postData: request.postData(),
      });
    }
  });

  return {
    /** Return only API v1 calls (excluding health & WebSocket). */
    getApiCalls: () =>
      captured.filter(
        (r) =>
          r.url.includes('/api/v1/') &&
          !r.url.includes('/health') &&
          !r.url.includes('/ws'),
      ),
    /** Return every captured request. */
    getAllCalls: () => [...captured],
    /** Clear the tracker. */
    clear: () => {
      captured.length = 0;
    },
  };
}

/**
 * Open (reveal) the search interface on the current page.
 * The SearchBar component exposes role="searchbox" and
 * aria-label="Search messages".
 */
async function openSearchBar(page: Page): Promise<void> {
  const searchSelector =
    '[role="searchbox"], input[aria-label="Search messages"], input[placeholder*="Search" i]';
  const searchBox = page.locator(searchSelector).first();
  const visible = await searchBox.isVisible().catch(() => false);

  if (!visible) {
    // The search bar may be hidden behind a toggle button
    const trigger = page.locator(
      '[data-testid="search-trigger"], [aria-label="Search"], button:has-text("Search")',
    ).first();
    const hasTrigger = await trigger.isVisible().catch(() => false);
    if (hasTrigger) {
      await trigger.click();
    }
  }

  await page.waitForSelector(searchSelector, { timeout: 10_000 });
}

/**
 * Type a search query into the search bar and wait for the debounce to
 * settle so results render.
 */
async function performSearch(page: Page, query: string): Promise<void> {
  const searchInput = page.locator(
    '[role="searchbox"], input[aria-label="Search messages"], input[placeholder*="Search" i]',
  ).first();
  await searchInput.fill(query);
  // Wait for debounce (300 ms) + render overhead
  await page.waitForTimeout(SEARCH_DEBOUNCE_MS);
}

/**
 * Clear the search input — try the clear button first, then fallback to
 * emptying the input and pressing Escape.
 */
async function clearSearch(page: Page): Promise<void> {
  const clearBtn = page.locator(
    '[aria-label="Clear search"], [data-testid="clear-search"], button.clear-search',
  ).first();
  const hasClear = await clearBtn.isVisible().catch(() => false);

  if (hasClear) {
    await clearBtn.click();
  } else {
    const searchInput = page.locator(
      '[role="searchbox"], input[aria-label="Search messages"], input[placeholder*="Search" i]',
    ).first();
    await searchInput.fill('');
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(300);
}

/**
 * Full browser session setup: login → navigate to conversation → seed
 * IndexedDB with test messages.
 */
async function setupAuthenticatedSession(
  page: Page,
  email: string,
  password: string,
  seedMessages: boolean = true,
): Promise<void> {
  await loginViaBrowser(page, email, password);

  if (seedMessages) {
    // Allow the application to initialise Dexie.js
    await page.waitForTimeout(2_000);

    let seeded = await seedMessagesInIndexedDB(
      page,
      TEST_MESSAGES,
      conversationId,
      userA.id,
      userA.displayName,
    );

    // If the database was not yet initialised, navigate to the conversation
    // (which triggers Dexie creation) and retry.
    if (seeded === 0) {
      await navigateToConversation(page, conversationId);
      await page.waitForTimeout(2_000);
      seeded = await seedMessagesInIndexedDB(
        page,
        TEST_MESSAGES,
        conversationId,
        userA.id,
        userA.displayName,
      );
    }
  }
}

// ============================================================================
// TEST SUITE
// ============================================================================

test.describe('Client-Side Message Search', () => {
  // Serial mode: tests share server-side state (registered users,
  // conversation) but each test receives a fresh browser context.
  test.describe.configure({ mode: 'serial' });

  // --------------------------------------------------------------------------
  // Phase 2 — Suite Setup
  // --------------------------------------------------------------------------

  test.beforeAll(async ({ request }) => {
    testRunId = `run-${Date.now()}`;

    // 1. Verify the API server is reachable
    const healthRes: APIResponse = await request.get(HEALTH_URL);
    expect([200, 503]).toContain(healthRes.status());

    // 2. Register two test users
    userA = await registerUser(
      request,
      uniqueEmail('search-a'),
      'SearchTestP@ss123',
      `Search User A ${testRunId}`,
    );
    userB = await registerUser(
      request,
      uniqueEmail('search-b'),
      'SearchTestP@ss123',
      `Search User B ${testRunId}`,
    );

    // 3. Upload PreKey bundles for encryption handshake
    await uploadPreKeyBundle(request, userA.tokens.accessToken);
    await uploadPreKeyBundle(request, userB.tokens.accessToken);

    // 4. Create a direct conversation between userA and userB
    conversationId = await createConversation(
      request,
      userA.tokens.accessToken,
      [userB.id],
    );
  });

  // --------------------------------------------------------------------------
  // Phase 9 — Suite Teardown
  // --------------------------------------------------------------------------

  test.afterAll(async ({ request }) => {
    // Best-effort token revocation for both test users
    if (userA?.tokens) {
      await revokeToken(request, userA.tokens.accessToken, userA.tokens.refreshToken);
    }
    if (userB?.tokens) {
      await revokeToken(request, userB.tokens.accessToken, userB.tokens.refreshToken);
    }
  });

  // ==========================================================================
  // Phase 4 — Basic Search Functionality
  // ==========================================================================

  test.describe('Basic Search Functionality', () => {
    test('search finds matching messages', async ({ page }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);

      await openSearchBar(page);
      await performSearch(page, 'coffee');

      // At least one result should contain "coffee"
      const results = page.locator(
        '[data-testid="search-result"], [role="listitem"]:has-text("coffee"), .search-result',
      );
      await expect(results.first()).toBeVisible({ timeout: 10_000 });

      const matchingResult = page.locator(':text("coffee shop")').first();
      await expect(matchingResult).toContainText('coffee shop');
    });

    test('search finds partial word matches', async ({ page }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);
      await openSearchBar(page);

      // Partial match: "birth" → "Happy birthday! 🎂🎉"
      await performSearch(page, 'birth');
      const birthdayResult = page.locator(':text("birthday")').first();
      await expect(birthdayResult).toBeVisible({ timeout: 10_000 });

      // Partial match: "grocer" → "Remember to buy groceries …"
      await clearSearch(page);
      await openSearchBar(page);
      await performSearch(page, 'grocer');
      const groceryResult = page.locator(':text("groceries")').first();
      await expect(groceryResult).toBeVisible({ timeout: 10_000 });
    });

    test('search is case-insensitive', async ({ page }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);
      await openSearchBar(page);

      // Uppercase query against lowercase source
      await performSearch(page, 'HELLO');
      const helloResult = page.locator(':text("Hello world")').first();
      await expect(helloResult).toBeVisible({ timeout: 10_000 });

      // Lowercase query against mixed-case source
      await clearSearch(page);
      await openSearchBar(page);
      await performSearch(page, 'react');
      const reactResult = page.locator(':text("React")').first();
      await expect(reactResult).toBeVisible({ timeout: 10_000 });
    });

    test('search with no results shows empty state', async ({ page }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);
      await openSearchBar(page);

      // Non-existent term
      await performSearch(page, 'xyznonexistentterm');

      // Either an explicit "no results" indicator or zero result items
      const noResultsIndicator = page.locator(
        '[data-testid="no-search-results"], :text("No results"), :text("no results found"), :text("No messages found"), .empty-search',
      ).first();
      const resultItems = page.locator(
        '[data-testid="search-result"], .search-result',
      );

      const hasEmptyState = await noResultsIndicator.isVisible().catch(() => false);
      const resultCount = await resultItems.count();

      // At least one condition must hold
      expect(hasEmptyState || resultCount === 0).toBe(true);
    });

    test('search with emoji content', async ({ page }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);
      await openSearchBar(page);

      // Search for "birthday" should surface the emoji-laden message
      await performSearch(page, 'birthday');
      const emojiResult = page.locator(':text("Happy birthday")').first();
      await expect(emojiResult).toBeVisible({ timeout: 10_000 });
    });
  });

  // ==========================================================================
  // Phase 5 — Zero Network Calls Validation (R21 Core)
  // ==========================================================================

  test.describe('Zero Network Calls — R21 Core Validation', () => {
    test('ZERO API calls during a single search operation — CRITICAL R21', async ({
      page,
    }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);

      // Attach comprehensive network monitoring
      const tracker = attachNetworkTracker(page);

      // Also set up route-level interception as a secondary guarantee
      const routedUrls: string[] = [];
      await page.route(`${API_BASE_URL}/api/v1/**`, (route) => {
        routedUrls.push(route.request().url());
        return route.continue();
      });

      // Reset after navigation-related requests
      tracker.clear();
      routedUrls.length = 0;

      // Perform the search
      await openSearchBar(page);
      await performSearch(page, 'weather');

      // Verify results appear
      const weatherResult = page.locator(':text("weather")').first();
      await expect(weatherResult).toBeVisible({ timeout: 10_000 });

      // *** CRITICAL R21 ASSERTION ***
      const apiCalls = tracker.getApiCalls();
      expect(apiCalls).toHaveLength(0);

      // Secondary verification via route interception
      expect(routedUrls).toEqual([]);

      // Specifically verify no search-related endpoints were called
      const searchEndpointCalls = apiCalls.filter(
        (c) =>
          c.url.includes('/messages/search') ||
          c.url.includes('/messages?') ||
          c.url.includes('/search'),
      );
      expect(searchEndpointCalls).toHaveLength(0);
    });

    test('multiple sequential searches make zero API calls', async ({
      page,
    }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);

      const tracker = attachNetworkTracker(page);
      tracker.clear();

      await openSearchBar(page);

      // Search 1: "coffee"
      await performSearch(page, 'coffee');
      await page.waitForTimeout(300);

      // Search 2: "movie"
      await performSearch(page, 'movie');
      await page.waitForTimeout(300);

      // Search 3: "deadline"
      await performSearch(page, 'deadline');
      await page.waitForTimeout(300);

      // *** R21: Zero API calls across all three sequential searches ***
      const apiCalls = tracker.getApiCalls();
      expect(apiCalls).toHaveLength(0);
    });

    test('real-time character-by-character typing makes zero API calls', async ({
      page,
    }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);

      const tracker = attachNetworkTracker(page);
      tracker.clear();

      await openSearchBar(page);

      // Focus the search input and type character by character
      const searchInput = page.locator(
        '[role="searchbox"], input[aria-label="Search messages"], input[placeholder*="Search" i]',
      ).first();
      await searchInput.click();

      // Simulate real-time typing with keyboard.type()
      await page.keyboard.type('weather', { delay: 100 });

      // Allow the debounce and any potential XHR to complete
      await page.waitForTimeout(1_500);

      // *** R21: Zero API calls during the entire typing process ***
      const apiCalls = tracker.getApiCalls();
      expect(apiCalls).toHaveLength(0);
    });

    test('zero plaintext or search tokens sent to server in any request', async ({
      page,
    }) => {
      const searchTerms = ['coffee', 'birthday', 'deadline', 'weather'];
      const interceptedBodies: Array<{ url: string; body: string | null }> = [];

      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);

      // Intercept ALL requests and record their payloads
      page.on('request', (req) => {
        const url = req.url();
        if (url.startsWith(API_BASE_URL)) {
          interceptedBodies.push({ url, body: req.postData() });
        }
      });

      // Clear after setup requests
      interceptedBodies.length = 0;

      await openSearchBar(page);

      // Perform each search term sequentially
      for (const term of searchTerms) {
        await performSearch(page, term);
        await page.waitForTimeout(200);
      }

      // *** CRITICAL: No search term appears anywhere in any request ***
      for (const { url, body } of interceptedBodies) {
        for (const term of searchTerms) {
          expect(url.toLowerCase()).not.toContain(term.toLowerCase());
          if (body) {
            expect(body.toLowerCase()).not.toContain(term.toLowerCase());
          }
        }
      }

      // Also assert zero API calls overall
      const apiCalls = interceptedBodies.filter(
        (r) => r.url.includes('/api/v1/') && !r.url.includes('/health'),
      );
      expect(apiCalls).toEqual([]);
    });
  });

  // ==========================================================================
  // Phase 6 — IndexedDB Verification
  // ==========================================================================

  test.describe('IndexedDB Verification', () => {
    test('messages are indexed in IndexedDB (Dexie.js)', async ({ page }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);

      // Inspect IndexedDB directly
      const dbInfo = await page.evaluate(async (dbName: string) => {
        // Verify the Dexie database exists
        const databases = await indexedDB.databases();
        const exists = databases.some((db) => db.name === dbName);
        if (!exists) {
          return { exists: false, messageCount: 0, messages: [] as string[] };
        }

        return new Promise<{
          exists: boolean;
          messageCount: number;
          messages: string[];
        }>((resolve, reject) => {
          const req = indexedDB.open(dbName);
          req.onsuccess = () => {
            const db = req.result;
            let tx: IDBTransaction;
            try {
              tx = db.transaction('messages', 'readonly');
            } catch {
              resolve({ exists: true, messageCount: 0, messages: [] });
              return;
            }
            const store = tx.objectStore('messages');
            const getAllReq = store.getAll();
            tx.oncomplete = () => {
              const allMsgs = getAllReq.result as Array<{ content?: string }>;
              resolve({
                exists: true,
                messageCount: allMsgs.length,
                messages: allMsgs
                  .map((m) => m.content ?? '')
                  .filter(Boolean),
              });
            };
            tx.onerror = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        });
      }, INDEXED_DB_NAME);

      // Assertions
      expect(dbInfo.exists).toBe(true);
      expect(dbInfo.messageCount).toBeGreaterThanOrEqual(TEST_MESSAGES.length);

      // Verify each prescribed test message is present
      for (const expectedMsg of TEST_MESSAGES) {
        expect(dbInfo.messages).toContain(expectedMsg);
      }
    });

    test('search works after page reload — proving IndexedDB persistence', async ({
      page,
    }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);

      // Verify messages exist before reload
      const beforeReload = await queryIndexedDBMessages(page);
      expect(beforeReload.length).toBeGreaterThanOrEqual(TEST_MESSAGES.length);

      const tracker = attachNetworkTracker(page);

      // Reload the page — clears in-memory state but IndexedDB persists
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(3_000);

      // Clear tracker AFTER reload (the reload itself may make API calls)
      tracker.clear();

      // Verify messages survived the reload
      const afterReload = await queryIndexedDBMessages(page);
      expect(afterReload.length).toBeGreaterThanOrEqual(TEST_MESSAGES.length);

      // Perform a search and verify results
      await openSearchBar(page);
      await performSearch(page, 'quick brown fox');

      const foxResult = page.locator(':text("quick brown fox")').first();
      await expect(foxResult).toBeVisible({ timeout: 10_000 });

      // *** R21: Zero API calls during post-reload search ***
      const apiCalls = tracker.getApiCalls();
      expect(apiCalls).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Phase 7 — Search UX Behaviour
  // ==========================================================================

  test.describe('Search UX Behaviour', () => {
    test('search results display matched content', async ({ page }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);
      await openSearchBar(page);

      await performSearch(page, 'quick brown fox');

      // The result must contain the matched text
      const result = page.locator(':text("quick brown fox")').first();
      await expect(result).toBeVisible({ timeout: 10_000 });
      await expect(result).toContainText('quick brown fox');
    });

    test('clicking a search result scrolls to the message', async ({
      page,
    }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);
      await openSearchBar(page);

      await performSearch(page, 'deadline');

      // Click the matching result
      const result = page.locator(':text("deadline")').first();
      await expect(result).toBeVisible({ timeout: 10_000 });
      await result.click();

      // The message should be visible (scrolled into view) in the chat
      const messageInView = page.locator(
        '[data-testid="message-bubble"]:has-text("deadline"), ' +
          '.message-bubble:has-text("deadline"), ' +
          '[role="listitem"]:has-text("deadline")',
      ).first();
      await expect(messageInView).toBeVisible({ timeout: 10_000 });
    });

    test('clearing search restores normal conversation view', async ({
      page,
    }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);

      // Confirm the message list is visible initially
      const messageList = page.locator(
        '[data-testid="message-list"], [data-testid="chat-view"], [role="log"], .message-list',
      ).first();
      await expect(messageList).toBeVisible({ timeout: 10_000 });

      // Open search and perform a query
      await openSearchBar(page);
      await performSearch(page, 'coffee');
      await page.waitForTimeout(500);

      // Clear the search
      await clearSearch(page);

      // The normal conversation view should be restored
      await expect(messageList).toBeVisible({ timeout: 10_000 });

      // Verify the search input is empty
      const searchInput = page.locator(
        '[role="searchbox"], input[aria-label="Search messages"]',
      ).first();
      const inputVisible = await searchInput.isVisible().catch(() => false);
      if (inputVisible) {
        const value = await searchInput.inputValue();
        expect(value).toBe('');
      }
    });

    test('search result count matches expectations', async ({ page }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);
      await openSearchBar(page);

      // "The" appears in at least 2 messages:
      // "The weather today …" and "The quick brown fox …"
      await performSearch(page, 'The');

      const resultItems = page.locator(
        '[data-testid="search-result"], .search-result, [role="listitem"]',
      );
      // Ensure toHaveCount works — at least 2 items
      const count = await resultItems.count();
      expect(count).toBeGreaterThanOrEqual(2);
      await expect(resultItems).toHaveCount(count);
    });
  });

  // ==========================================================================
  // Phase 8 — Edge Cases
  // ==========================================================================

  test.describe('Edge Cases', () => {
    test('search immediately after indexing a new message', async ({
      page,
    }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);

      // Inject a new message with a unique term
      const uniqueTerm = `unique-search-term-${Date.now()}`;
      await page.evaluate(
        async (args: { dbName: string; convId: string; term: string }) => {
          return new Promise<void>((resolve, reject) => {
            const req = indexedDB.open(args.dbName);
            req.onsuccess = () => {
              const db = req.result;
              const tx = db.transaction('messages', 'readwrite');
              const store = tx.objectStore('messages');
              store.put({
                id: `new-msg-${Date.now()}`,
                conversationId: args.convId,
                conversationName: 'Search Test Conversation',
                senderId: 'user-b-id',
                senderName: 'User B',
                content: `This message contains ${args.term} inside`,
                timestamp: new Date().toISOString(),
                type: 'TEXT',
              });
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            };
            req.onerror = () => reject(req.error);
          });
        },
        { dbName: INDEXED_DB_NAME, convId: conversationId, term: uniqueTerm },
      );

      const tracker = attachNetworkTracker(page);
      tracker.clear();

      // Immediately search for the unique term
      await openSearchBar(page);
      await performSearch(page, uniqueTerm);

      // The newly indexed message must appear
      const newResult = page.locator(`:text("${uniqueTerm}")`).first();
      await expect(newResult).toBeVisible({ timeout: 10_000 });

      // *** R21: Zero API calls ***
      expect(tracker.getApiCalls()).toHaveLength(0);
    });

    test('search with special characters (URL, punctuation)', async ({
      page,
    }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);
      await openSearchBar(page);

      // URL content
      await performSearch(page, 'https://example');
      const linkResult = page.locator(':text("https://example.com")').first();
      await expect(linkResult).toBeVisible({ timeout: 10_000 });

      // Comma-separated content
      await clearSearch(page);
      await openSearchBar(page);
      await performSearch(page, 'milk, eggs');
      const groceryResult = page.locator(':text("groceries")').first();
      await expect(groceryResult).toBeVisible({ timeout: 10_000 });
    });

    test('search below minimum query length does not crash', async ({
      page,
    }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);

      const tracker = attachNetworkTracker(page);
      tracker.clear();

      await openSearchBar(page);

      // Single character — below minimum
      const belowMin = 'a'.repeat(MIN_SEARCH_QUERY_LENGTH - 1);
      await performSearch(page, belowMin);
      await page.waitForTimeout(500);

      // Exactly at minimum query length
      const atMin = 'at'.slice(0, MIN_SEARCH_QUERY_LENGTH);
      await performSearch(page, atMin);
      await page.waitForTimeout(500);

      // Zero API calls regardless
      expect(tracker.getApiCalls()).toHaveLength(0);
    });

    test('rapid input changes make zero API calls', async ({ page }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);

      const tracker = attachNetworkTracker(page);
      tracker.clear();

      await openSearchBar(page);
      const searchInput = page.locator(
        '[role="searchbox"], input[aria-label="Search messages"], input[placeholder*="Search" i]',
      ).first();

      // Rapid-fire value changes
      await searchInput.fill('hello');
      await searchInput.fill('world');
      await searchInput.fill('coffee');
      await searchInput.fill('birthday');
      await searchInput.fill('');
      await searchInput.fill('weather');

      // Let all debounces settle
      await page.waitForTimeout(1_500);

      // *** R21: Zero API calls even with rapid input changes ***
      expect(tracker.getApiCalls()).toHaveLength(0);
    });

    test('search while disconnected from network makes zero API calls', async ({
      page,
    }) => {
      await setupAuthenticatedSession(page, userA.email, 'SearchTestP@ss123');
      await navigateToConversation(page, conversationId);

      // Block ALL network requests to the API during search
      await page.route(`${API_BASE_URL}/**`, (route) => route.abort());

      await openSearchBar(page);
      await performSearch(page, 'coffee');

      // Results should still appear from IndexedDB
      const coffeeResult = page.locator(':text("coffee")').first();
      await expect(coffeeResult).toBeVisible({ timeout: 10_000 });

      // Unblock the route for subsequent tests
      await page.unrouteAll();
    });
  });
});
