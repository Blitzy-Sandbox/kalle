/**
 * Playwright E2E Test Configuration for Kalle WhatsApp Clone
 *
 * This configuration defines the browser projects, timeouts, reporter setup,
 * and global test settings for the Kalle E2E test suite. It covers:
 *
 * - Desktop browsers: Chromium, Firefox, WebKit (Safari)
 * - Mobile viewports: Pixel 5 (Android), iPhone 12 (iOS) for R15 mobile
 *   navigation pattern verification
 * - CI-aware settings: conditional retries, worker limits, and forbidOnly
 * - Artifact capture: traces on retry, screenshots/video on failure
 * - Base URL targeting the frontend at http://localhost:3000 with the API
 *   backend at http://localhost:3001 (per AAP §0.4.6)
 *
 * @see https://playwright.dev/docs/test-configuration
 */

import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright test configuration exported as the default module export.
 *
 * Key design decisions:
 * - 5 browser projects covering desktop and mobile for comprehensive
 *   cross-browser and responsive layout testing
 * - 60-second test timeout to accommodate E2E flows involving encryption
 *   handshakes, WebSocket connections, and real-time event propagation
 * - fullyParallel enabled for speed in local development; CI uses a
 *   single worker for deterministic execution
 * - Trace capture on first retry balances debugging capability with
 *   storage usage
 * - Web server configuration is commented out because the stack is
 *   designed to run via `docker-compose up` (R38, R39)
 */
export default defineConfig({
  /**
   * Directory containing all E2E test spec files.
   * Relative to this configuration file's location.
   */
  testDir: './tests',

  /**
   * Run tests within each file in parallel for faster execution.
   * Combined with CI-limited workers, this gives speed locally
   * and determinism in CI.
   */
  fullyParallel: true,

  /**
   * Fail the build if test.only is accidentally left in source code.
   * Only enforced in CI environments to prevent focused tests from
   * slipping into the main branch.
   */
  forbidOnly: !!process.env.CI,

  /**
   * Retry failed tests in CI to handle transient infrastructure flakiness
   * (Docker networking, WebSocket reconnection timing, etc.).
   * No retries locally for fast feedback loops.
   */
  retries: process.env.CI ? 2 : 0,

  /**
   * Limit parallel workers in CI to 1 for deterministic test execution
   * and to prevent resource contention on CI runners.
   * In local development, use the default (CPU-core-based) for speed.
   */
  workers: process.env.CI ? 1 : undefined,

  /**
   * Reporter configuration:
   * - 'html': Generates an interactive HTML report with screenshots,
   *   traces, and test details in the playwright-report directory
   * - 'list': Provides real-time console output showing test progress
   */
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'],
  ],

  /**
   * Global timeout per test case (60 seconds).
   * E2E tests for the Kalle app may involve:
   * - Signal Protocol key exchange and session establishment
   * - WebSocket connection setup and real-time event delivery
   * - Media encryption, upload, and thumbnail generation
   * - Offline sync reconnection flows
   * 60 seconds accommodates these complex multi-step flows.
   */
  timeout: 60_000,

  /**
   * Assertion-level timeout configuration.
   * 10 seconds for expect() assertions to resolve, covering async
   * operations like waiting for decrypted messages to appear in the
   * UI after WebSocket delivery.
   */
  expect: {
    timeout: 10_000,
  },

  /**
   * Directory for test artifacts (screenshots, videos, traces).
   * These files are generated on test failure for debugging.
   */
  outputDir: 'test-results',

  /**
   * Shared settings applied to all browser projects.
   * Individual projects can override these values.
   */
  use: {
    /**
     * Base URL for the frontend application.
     * The Next.js frontend runs on port 3000 in the Docker Compose
     * stack (per AAP §0.4.6). All page.goto('/path') calls resolve
     * relative to this URL.
     */
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',

    /**
     * Trace capture strategy.
     * 'on-first-retry' captures a full execution trace only when a
     * test fails and is retried. This provides detailed debugging
     * data for flaky tests without the storage overhead of tracing
     * every test run.
     */
    trace: 'on-first-retry',

    /**
     * Screenshot capture strategy.
     * 'only-on-failure' captures a screenshot when a test fails,
     * providing visual evidence of the UI state at the point of
     * failure for debugging.
     */
    screenshot: 'only-on-failure',

    /**
     * Video recording strategy.
     * 'retain-on-failure' records video for all tests but only
     * retains the recording when a test fails. This enables
     * step-by-step visual debugging of failed test flows.
     */
    video: 'retain-on-failure',

    /**
     * Timeout for individual Playwright actions (click, fill, etc.).
     * 15 seconds allows for elements that may appear after async
     * operations like decryption or WebSocket event delivery.
     */
    actionTimeout: 15_000,

    /**
     * Timeout for page navigation operations.
     * 30 seconds accommodates Docker Compose service startup latency,
     * Next.js SSR rendering, and initial data fetching on page load.
     */
    navigationTimeout: 30_000,

    /**
     * Extra HTTP headers sent with every request.
     * Accept-Language ensures consistent locale rendering across
     * all browser projects for deterministic UI text assertions.
     */
    extraHTTPHeaders: {
      'Accept-Language': 'en-US',
    },

    /**
     * API base URL for direct backend calls in E2E tests.
     * Tests that need to call the API directly (e.g., seeding data,
     * health endpoints, audit log verification) can access this via
     * `process.env.API_BASE_URL` which defaults to localhost:3001.
     *
     * Usage in tests:
     *   const apiUrl = process.env.API_BASE_URL ?? 'http://localhost:3001';
     */
  },

  /**
   * Browser project definitions.
   *
   * 5 projects cover the full testing matrix:
   * - Desktop: Chromium, Firefox, WebKit (Safari) for cross-browser compat
   * - Mobile: Pixel 5, iPhone 12 for responsive layout and R15 mobile
   *   navigation pattern verification (stack navigation, no simultaneous
   *   chat list + chat view)
   *
   * Each project uses Playwright's built-in device descriptors which
   * configure viewport size, user agent, device scale factor, and
   * touch/mobile emulation automatically.
   */
  projects: [
    /* ────────────────────── Desktop Browsers ────────────────────── */

    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    /* ───────────────────── Mobile Browsers ──────────────────────── */

    /**
     * Mobile Chrome on Pixel 5 (393×851 viewport, 2.75 DPR).
     * Used for testing R15 mobile navigation pattern: at ≤767px,
     * conversation list and chat view must never be visible
     * simultaneously — push/pop stack navigation is required.
     */
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },

    /**
     * Mobile Safari on iPhone 12 (390×844 viewport, 3 DPR).
     * Tests iOS-specific viewport behavior, safe area insets,
     * and touch interactions for the WhatsApp-style iOS UI.
     */
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 12'] },
    },
  ],

  /**
   * Web server configuration (commented out).
   *
   * The Kalle stack is designed to run via `docker-compose up` (R38, R39).
   * Tests expect the stack to be running before execution. Uncomment the
   * block below if you want Playwright to automatically start the stack:
   *
   * webServer: [
   *   {
   *     command: 'docker-compose up',
   *     url: 'http://localhost:3000',
   *     reuseExistingServer: !process.env.CI,
   *     timeout: 120_000,
   *   },
   * ],
   */
});
