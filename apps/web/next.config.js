/**
 * Next.js Configuration — kalle-web
 *
 * This module exports the build/runtime configuration for the kalle Next.js
 * application. The configuration is the single source of truth for:
 *
 *   - Build-time bundling and transpilation (transpilePackages, webpack)
 *   - Runtime image optimization (images.remotePatterns)
 *   - Client-side environment variable injection (env)
 *   - HTTP response headers including security policy (headers)
 *
 * --- MINOR-2 (QA Checkpoint F2) — Web Security Headers ---
 *
 * The QA testing report identified that the Next.js application was emitting
 * only the default headers (`Cache-Control`, `X-Powered-By`) on its
 * server-rendered responses, missing the following defense-in-depth headers
 * that the kalle-api Express server applies via Helmet:
 *
 *   - Content-Security-Policy
 *   - X-Content-Type-Options: nosniff
 *   - X-Frame-Options: SAMEORIGIN
 *   - Referrer-Policy
 *   - Permissions-Policy
 *
 * This file implements those headers via Next.js `headers()` async function,
 * which applies the headers to every server-rendered route. The resulting
 * security posture matches the kalle-api Helmet configuration verified in
 * QA Checkpoint F2 (CSP, X-Frame-Options SAMEORIGIN, X-Content-Type-Options
 * nosniff, Referrer-Policy no-referrer).
 *
 * The CSP `connect-src`, `img-src`, and `form-action` directives are derived
 * from the same NEXT_PUBLIC_* environment variables that the application code
 * uses, ensuring header values match runtime expectations:
 *
 *   - `connect-src` enumerates the HTTP + WebSocket origins the app reaches
 *     (NEXT_PUBLIC_API_URL for kalle-api REST + Socket.IO; NEXT_PUBLIC_WS_URL
 *     for the WebSocket variant; NEXT_PUBLIC_KEYCLOAK_BASE_URL for OIDC token
 *     exchange after PKCE callback).
 *   - `img-src` allows API-served avatars/uploads, data: URIs (inline icons),
 *     and blob: URLs (client-side image processing pipeline).
 *   - `form-action` allows the PKCE redirect to Keycloak's authorization
 *     endpoint (the login page issues `window.location.href` navigation, but
 *     CSP form-action also covers any HTML form submissions to the IDP).
 *
 * The `script-src` and `style-src` directives include `'unsafe-inline'` and
 * `'unsafe-eval'` (script-src only) to accommodate Next.js's hydration and
 * development HMR runtime, which inject inline scripts and use eval()
 * respectively. Future hardening (e.g., nonce-based CSP) requires a Next.js
 * middleware refactor and is out of scope for the QA F2 minor fix.
 *
 * @see {@link https://nextjs.org/docs/app/api-reference/next-config-js/headers}
 *      Next.js headers() reference
 * @see {@link https://content-security-policy.com/} CSP directive reference
 */

/**
 * Strip a trailing slash from a URL origin so CSP directives don't accumulate
 * double slashes. Returns a non-trailing-slash form (e.g. `http://localhost:3001`).
 *
 * @param {string} url - URL or URL-like origin string
 * @returns {string} Origin without trailing slash
 */
const stripTrailingSlash = (url) => url.replace(/\/+$/, '');

/**
 * Build the Content-Security-Policy directive value at config-evaluation time.
 *
 * The CSP is recomputed each time `next.config.js` is evaluated (i.e. once at
 * server start), pulling current values from the same NEXT_PUBLIC_* env vars
 * the runtime application code uses. This keeps the policy in lock-step with
 * the actual origins the app reaches.
 *
 * Defaults match the runtime fallbacks in `src/lib/api.ts`, `src/lib/socket.ts`,
 * and `src/app/auth/callback/page.tsx` so local development "just works" when
 * env vars are unset.
 *
 * @returns {string} A semicolon-separated CSP directive string
 */
const buildContentSecurityPolicy = () => {
  /** kalle-api REST origin; same fallback as src/lib/api.ts. */
  const apiOrigin = stripTrailingSlash(
    process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001',
  );

  /** Socket.IO HTTP polling origin; same fallback as src/lib/socket.ts. */
  const wsHttpOrigin = stripTrailingSlash(
    process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001',
  );

  /** WebSocket protocol form of NEXT_PUBLIC_WS_URL (http:// → ws://, https:// → wss://). */
  const wsProtocolOrigin = wsHttpOrigin.replace(/^http(s?):/, 'ws$1:');

  /**
   * Keycloak realm origin used by the PKCE callback for token exchange and
   * by the login page for the authorization-endpoint redirect.
   * Defaults to localhost:8080 to mirror the docker-compose service.
   */
  const keycloakOrigin = stripTrailingSlash(
    process.env.NEXT_PUBLIC_KEYCLOAK_BASE_URL || 'http://localhost:8080',
  );

  /**
   * CSP directives. Order matters only for human readability; CSP itself is
   * directive-keyed.
   */
  const directives = [
    // Default fallback for any fetch directive not enumerated below.
    "default-src 'self'",

    // Scripts: Next.js requires 'unsafe-inline' for hydration scripts and
    // 'unsafe-eval' for dev-mode HMR. These are documented limitations of the
    // current Next.js architecture; nonce-based CSP requires a middleware
    // refactor (out of scope for MINOR-2).
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",

    // Styles: Tailwind and styled-jsx emit inline <style> tags requiring
    // 'unsafe-inline'. This is standard for Next.js + Tailwind stacks.
    "style-src 'self' 'unsafe-inline'",

    // Images: same-origin static assets, data: URIs (icon sets), blob: URIs
    // (client-side processed images), and the API origin (uploads endpoint).
    `img-src 'self' data: blob: ${apiOrigin}`,

    // Fonts: same-origin and inline data: fonts (Tailwind font subsets).
    "font-src 'self' data:",

    // Network connections: REST + Socket.IO HTTP polling + Socket.IO WebSocket
    // upgrade + Keycloak token endpoint. The 'self' keyword covers Next.js's
    // server actions and route handlers. Origins are deduplicated below
    // because NEXT_PUBLIC_API_URL and NEXT_PUBLIC_WS_URL frequently share
    // a value (`http://localhost:3001` in the default local-dev config).
    `connect-src ${[
      "'self'",
      ...new Set([apiOrigin, wsHttpOrigin, wsProtocolOrigin, keycloakOrigin]),
    ].join(' ')}`,

    // Form submissions: same-origin (legacy email/password form to /api/v1/auth/login)
    // and Keycloak (PKCE redirect endpoint, defense-in-depth even though the
    // login page uses window.location.href and not a <form>).
    `form-action 'self' ${keycloakOrigin}`,

    // Clickjacking defense. 'self' allows same-origin frames (matches the
    // X-Frame-Options: SAMEORIGIN posture below for legacy browser support).
    "frame-ancestors 'self'",

    // Restrict <base href> to same origin — prevents <base> tag injection
    // from rewriting relative URLs.
    "base-uri 'self'",

    // Disallow plugins (Flash, Java applets, etc.) and embedded objects.
    "object-src 'none'",
  ];

  return directives.join('; ');
};

/**
 * Static security headers applied to every response.
 *
 * The `Content-Security-Policy` value is computed once at config-evaluation
 * time and frozen for the lifetime of the Next.js process.
 */
const securityHeaders = [
  {
    // CSP: defense-in-depth against XSS and injection attacks. See
    // buildContentSecurityPolicy() above for derivation logic.
    key: 'Content-Security-Policy',
    value: buildContentSecurityPolicy(),
  },
  {
    // Prevent MIME type sniffing — browsers must respect the Content-Type
    // header declared by the server. Mirrors kalle-api Helmet default.
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    // Clickjacking defense for legacy browsers that do not support CSP
    // frame-ancestors. SAMEORIGIN matches the kalle-api posture.
    key: 'X-Frame-Options',
    value: 'SAMEORIGIN',
  },
  {
    // Don't leak the previous URL (Referer) when navigating away. Matches
    // kalle-api Helmet default and minimizes referrer-based information
    // leakage to third parties (including Keycloak during PKCE redirects).
    key: 'Referrer-Policy',
    value: 'no-referrer',
  },
  {
    // Disable powerful browser APIs the app does not need. Defense-in-depth
    // against compromised third-party scripts (the Signal Protocol code path
    // uses Web Crypto, not the disabled features).
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
  {
    // Cross-origin isolation for SharedArrayBuffer eligibility (also
    // mitigates Spectre side-channel attacks). Mirrors kalle-api COOP.
    key: 'Cross-Origin-Opener-Policy',
    value: 'same-origin',
  },
  {
    // Prevent other origins from embedding our resources via no-cors.
    // Mirrors kalle-api CORP.
    key: 'Cross-Origin-Resource-Policy',
    value: 'same-origin',
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for Docker production builds.
  // Dockerfile.web copies .next/standalone for a minimal production image.
  output: 'standalone',

  // Enable React strict mode to surface potential issues during development.
  // Double-invokes lifecycle methods and effects in dev to catch side-effect bugs.
  reactStrictMode: true,

  // Transpile the shared monorepo package so Next.js processes its TypeScript
  // source when imported. Required for @kalle/shared types/DTOs/validators.
  transpilePackages: ['@kalle/shared'],

  // Image optimization configuration for avatars and media thumbnails.
  // Allows Next.js <Image> component to load images served by the API backend.
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '3001',
        pathname: '/uploads/**',
      },
    ],
  },

  // Client-side environment variables with sensible local development defaults.
  // These are inlined at build time and available via process.env in browser code.
  env: {
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001',
    NEXT_PUBLIC_WS_URL:
      process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001',
  },

  // Webpack configuration customization for Signal Protocol browser compatibility.
  // libsignal-protocol-javascript references Node.js built-in modules that do not
  // exist in the browser. Setting these to false prevents webpack from trying to
  // polyfill them and lets the library use browser-native alternatives (Web Crypto).
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        crypto: false,
        stream: false,
        buffer: false,
      };
    }

    // Map .js extension imports to their TypeScript source equivalents.
    // Required because @kalle/shared uses NodeNext module resolution which
    // mandates .js extensions in source imports, but webpack/bundler resolution
    // needs to find the actual .ts files when transpilePackages processes
    // the shared package from source.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };

    return config;
  },

  // Experimental features — server actions with a relaxed body size limit
  // to support larger form submissions (e.g. profile avatar uploads).
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },

  /**
   * MINOR-2 (QA Checkpoint F2): Apply defense-in-depth security headers to all
   * server-rendered responses. The matcher `/(.*)` includes all routes
   * including the root, login page, callback, chat, and static assets.
   *
   * @returns {Promise<Array<{source: string, headers: Array<{key: string, value: string}>}>>}
   */
  async headers() {
    return [
      {
        // Apply to all paths including the root path '/'. This pattern is
        // documented in the Next.js headers() reference as the canonical
        // "match every route" form.
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

module.exports = nextConfig;
