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
        crypto: false,
        stream: false,
        buffer: false,
      };
    }
    return config;
  },

  // Experimental features — server actions with a relaxed body size limit
  // to support larger form submissions (e.g. profile avatar uploads).
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
};

module.exports = nextConfig;
