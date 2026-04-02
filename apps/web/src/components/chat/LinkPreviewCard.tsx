'use client';

import { useState, useCallback } from 'react';

/**
 * Open Graph metadata extracted from a URL by the backend link-preview job.
 * Represents the data shape returned after BullMQ processes a URL for OG tags.
 */
export interface LinkPreviewData {
  /** The original URL that was parsed for OG metadata */
  url: string;
  /** The OG title of the linked page */
  title: string;
  /** Optional OG description snippet */
  description?: string;
  /** Optional OG image URL (already decrypted/available) */
  image?: string;
  /** Optional site name from OG metadata (e.g., "YouTube", "GitHub") */
  siteName?: string;
  /** Optional site favicon URL */
  favicon?: string;
}

/**
 * Props for the LinkPreviewCard component.
 */
export interface LinkPreviewCardProps {
  /** The OG metadata for the link to preview */
  preview: LinkPreviewData;
  /**
   * Optional callback fired when the card is pressed/clicked.
   * When provided, prevents default anchor navigation and delegates to this handler.
   * When omitted, the anchor tag opens the URL in a new browser tab naturally.
   */
  onPress?: () => void;
}

/**
 * Extracts a display-friendly domain name from a raw URL string.
 * Strips the "www." prefix for a cleaner visual presentation.
 * Falls back to the raw URL string if URL parsing fails.
 *
 * @param url - The full URL to extract a domain from
 * @returns The cleaned hostname or the raw URL as fallback
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * LinkPreviewCard — Renders a rich Open Graph link preview card within a
 * message bubble when a URL's OG metadata has been fetched by the backend's
 * BullMQ link-preview job.
 *
 * Features:
 * - Displays OG image with skeleton loading state and error fallback
 * - Title with 2-line clamp, description with 3-line clamp
 * - Site name (uppercase) or domain with optional favicon
 * - Accessible: wrapped in semantic `<a>` with aria-label, keyboard navigable
 * - Graceful degradation: falls back to plain text link if no title available
 *
 * Design tokens derived from WhatsApp Chat screen (Figma 0:8257,
 * file key miK1B6qEPrUnRZ9wwZNrW2).
 *
 * Layout:
 * ┌──────────────────────┐
 * │   OG Image (if any)  │  ← full width, max-h-40 (160px), object-cover
 * ├──────────────────────┤
 * │ Title (bold, 2 lines)│  ← font-semibold 14px/1.3em
 * │ Description (3 lines)│  ← 13px/1.23em text-secondary
 * │ 🔗 sitename.com     │  ← 11px/1.193em text-secondary, truncated
 * └──────────────────────┘
 *
 * @example
 * ```tsx
 * <LinkPreviewCard
 *   preview={{
 *     url: 'https://github.com/vercel/next.js',
 *     title: 'Next.js by Vercel - The React Framework',
 *     description: 'Production grade React applications that scale.',
 *     image: 'https://nextjs.org/static/twitter-cards/home.jpg',
 *     siteName: 'GitHub',
 *     favicon: 'https://github.com/favicon.ico',
 *   }}
 * />
 * ```
 */
export default function LinkPreviewCard({ preview, onPress }: LinkPreviewCardProps) {
  const { url, title, description, image, siteName, favicon } = preview;

  /** Tracks whether the OG image has finished loading (success or failure) */
  const [imageLoaded, setImageLoaded] = useState(false);
  /** Tracks whether the OG image failed to load — hides image area on failure */
  const [imageError, setImageError] = useState(false);

  /**
   * Click handler for the entire card. When an onPress callback is provided,
   * it prevents default anchor navigation and delegates to the callback.
   * Otherwise, the <a> tag handles navigation to the URL in a new tab.
   */
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (onPress) {
        event.preventDefault();
        onPress();
      }
    },
    [onPress]
  );

  /** Marks the OG image as successfully loaded, revealing it in place of the skeleton */
  const handleImageLoad = useCallback(() => {
    setImageLoaded(true);
  }, []);

  /** Marks the OG image as failed — hides the entire image area gracefully */
  const handleImageError = useCallback(() => {
    setImageError(true);
    setImageLoaded(true);
  }, []);

  /* ------------------------------------------------------------------ *
   * Error / Fallback State                                              *
   *                                                                     *
   * When the preview lacks a title (minimal or invalid OG data), render *
   * the URL as a plain text link instead of a rich card. This matches   *
   * the spec requirement: "Error state: show URL as plain text link     *
   * (no card)."                                                         *
   * ------------------------------------------------------------------ */
  if (!title) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-[14px] leading-[1.3em] text-blue-ios underline outline-none focus-visible:ring-2 focus-visible:ring-blue-ios"
        aria-label={`Link: ${url}`}
      >
        {url}
      </a>
    );
  }

  /* Determine display values */
  const displayDomain = siteName || extractDomain(url);
  const showImage = Boolean(image) && !imageError;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      aria-label={`Link preview: ${title}`}
      className="block w-full overflow-hidden rounded-lg border-hairline border-separator bg-file-bg no-underline outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-1"
    >
      {/* ── OG Image Area ────────────────────────────────────────────── */}
      {showImage && (
        <div className="relative w-full overflow-hidden">
          {/* Skeleton placeholder with pulsing animation while image loads */}
          {!imageLoaded && (
            <div
              className="h-40 w-full bg-black/[0.05] motion-safe:animate-pulse"
              aria-hidden="true"
            />
          )}
          {/*
           * Actual OG image element — always present in DOM when showImage
           * is true so that browser load/error events fire. During loading,
           * positioned absolutely with zero opacity to avoid layout shift.
           * On successful load, switches to block flow positioning.
           */}
          <img
            src={image!}
            alt={title}
            loading="lazy"
            decoding="async"
            width={375}
            height={160}
            onLoad={handleImageLoad}
            onError={handleImageError}
            className={
              imageLoaded
                ? 'block w-full max-h-40 object-cover'
                : 'absolute inset-0 w-full max-h-40 object-cover opacity-0'
            }
          />
        </div>
      )}

      {/* ── Content Area ─────────────────────────────────────────────── */}
      <div className="p-2">
        {/*
         * Title — SF Pro Text 600, 14px, line-height 1.3em, max 2 lines
         * Uses font-semibold (600 weight) with explicit size/line-height
         * instead of a Tailwind fontSize tuple to match the precise spec.
         */}
        <p className="font-semibold text-[14px] leading-[1.3em] text-black line-clamp-2">
          {title}
        </p>

        {/*
         * Description — SF Pro Text 400, 13px, line-height 1.23em, max 3 lines
         * Uses the text-section-header Tailwind token which bundles
         * 13px / 1.23em / 400 weight — exact match for the description spec.
         */}
        {description && (
          <p className="mt-1 text-section-header text-secondary line-clamp-3">
            {description}
          </p>
        )}

        {/*
         * Site name / URL footer — SF Pro Text 400, 11px, line-height 1.193em
         * Shows siteName in uppercase if available, otherwise shows the
         * extracted domain from the URL. Optional favicon rendered as a
         * decorative 12×12 image alongside the text.
         */}
        <div className="mt-1 flex items-center gap-1">
          {/* Favicon — decorative only, hidden from assistive tech */}
          {favicon && (
            <img
              src={favicon}
              alt=""
              aria-hidden="true"
              width={12}
              height={12}
              className="h-3 w-3 flex-shrink-0 rounded-sm"
            />
          )}
          <span
            className={`truncate text-[11px] leading-[1.193em] text-secondary${
              siteName ? ' uppercase' : ''
            }`}
          >
            {displayDomain}
          </span>
        </div>
      </div>
    </a>
  );
}
