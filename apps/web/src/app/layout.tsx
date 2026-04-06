import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * Root Layout — WhatsApp Clone (Kalle)
 *
 * Next.js 14 App Router root layout wrapping the entire application.
 * Configures global CSS (Tailwind), HTML document metadata, viewport
 * settings for iOS safe areas, and the base typographic / background
 * styling derived from the Figma Token Manifest (AAP Section 0.5.2).
 *
 * Design tokens consumed (resolved via tailwind.config.ts):
 *  - font-sans  → SF Pro Text font stack (Section 0.6.3 / 0.6.4)
 *  - bg-surface → #EFEFF4 (color-bg-secondary across all screens)
 *  - text-black → #000000 (color-text-primary)
 *
 * WCAG 2.1 AA compliance (Rule R34):
 *  - lang="en" on <html> for assistive technology
 *  - Proper single <html>/<body> document structure
 *  - Focus-visible styles injected via globals.css (#007AFF, 2px ring)
 *
 * This is a Server Component — no 'use client' directive. The layout
 * does not use React hooks, browser APIs, or event handlers.
 */

/* ================================================================
 * METADATA — Next.js page-level <head> configuration
 *
 * Generates the following tags at render time:
 *   <title>WhatsApp</title>
 *   <meta name="description" content="WhatsApp Web Clone — ..." />
 *
 * manifest is set to null (no PWA manifest for the current scope).
 * ================================================================ */
export const metadata: Metadata = {
  title: 'WhatsApp',
  description: 'WhatsApp Web Clone — Real-time encrypted messaging',
  manifest: null,
};

/* ================================================================
 * VIEWPORT — Mobile viewport and iOS safe area configuration
 *
 * Generates the following meta tag:
 *   <meta name="viewport" content="width=device-width,
 *     initial-scale=1, maximum-scale=1, user-scalable=no,
 *     viewport-fit=cover" />
 *   <meta name="theme-color" content="#F6F6F6" />
 *
 * Key decisions:
 *  - themeColor #F6F6F6 matches the navigation bar background
 *    (color-bg-nav from Figma Token Manifest, Section 0.5.2).
 *    This tints the mobile browser chrome to blend with the app.
 *  - viewportFit 'cover' enables content to extend into iOS safe
 *    areas, allowing the globals.css safe-area utilities (pt-safe,
 *    pb-safe) to control inset padding per component.
 *  - userScalable false prevents pinch-to-zoom, matching native
 *    WhatsApp behavior where zoom is not available.
 * ================================================================ */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /* WCAG 2.1 AA compliance: removed maximumScale=1 and userScalable=false
     to allow users who need zoom to pinch-to-zoom. This resolves the
     Lighthouse accessibility failure for restricted zoom. */
  themeColor: '#F6F6F6',
  viewportFit: 'cover',
};

/* ================================================================
 * ROOT LAYOUT COMPONENT
 *
 * The outermost layout wrapping every page in the application.
 * Applies global Tailwind utility classes to <body>:
 *
 *  font-sans      — SF Pro Text font stack defined in
 *                    tailwind.config.ts → theme.extend.fontFamily.sans
 *  antialiased    — -webkit-font-smoothing: antialiased for iOS-
 *                    native text rendering fidelity
 *  bg-surface     — #EFEFF4 app background from Figma Token Manifest
 *                    (color-bg-secondary, used across all 21 screens)
 *  text-black     — #000000 default text color (color-text-primary)
 *  min-h-screen   — ensures the body spans at least the full
 *                    viewport height, preventing short-page gaps
 *  overscroll-none — prevents rubber-band bounce on iOS (also set
 *                    in globals.css body rule for redundancy)
 *
 * suppressHydrationWarning on <html> prevents React hydration
 * mismatch warnings caused by browser extensions (e.g., Dark Reader,
 * Grammarly) that modify DOM attributes before hydration.
 * ================================================================ */
export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased bg-surface text-black min-h-screen overscroll-none">
        {children}
      </body>
    </html>
  );
}
