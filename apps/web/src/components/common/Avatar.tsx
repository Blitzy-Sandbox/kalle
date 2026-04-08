'use client';

import { useState, useEffect, type ReactNode, type KeyboardEvent } from 'react';
import Image from 'next/image';

/**
 * Props for the Avatar component.
 *
 * Supports three size variants matching Figma specifications (sm=36px, md=52px, lg=80px)
 * plus a customSize override for non-standard sizes (e.g., 40px for call list rows).
 */
export interface AvatarProps {
  /** Image source URL — when null/undefined/empty, falls back to initials display */
  src?: string | null;
  /** Alt text for accessibility — also used to derive initials for the fallback view */
  alt: string;
  /** Size variant: sm=36px, md=52px, lg=80px (default: 'md') */
  size?: 'sm' | 'md' | 'lg';
  /** Custom size in pixels — overrides the size variant when provided */
  customSize?: number;
  /** Optional badge overlay (e.g., online indicator, "+" icon) positioned at bottom-right */
  badge?: ReactNode;
  /** Additional Tailwind className applied to the outermost container */
  className?: string;
  /** Optional click handler — adds cursor-pointer and button semantics */
  onClick?: () => void;
}

/**
 * Size configuration map matching Figma specifications exactly.
 *
 * - sm (36px): Used in compact contexts
 * - md (52px): Chat list rows (node 0:8875), settings profile row
 * - lg (80px): Contact info, edit profile screens
 *
 * Font sizes for initials fallback:
 * - sm: 14px (text-sm equivalent)
 * - md: 18px
 * - lg: 28px
 */
const SIZE_CONFIG = {
  sm: { dimension: 36, fontSize: 14 },
  md: { dimension: 52, fontSize: 18 },
  lg: { dimension: 80, fontSize: 28 },
} as const;

/**
 * Extracts up to two initials from the provided name string.
 *
 * Takes the first letter of the first two words, uppercased.
 * Single-word names return a single initial.
 * Empty/whitespace-only strings return an empty string.
 *
 * @example
 * getInitials('Martha Craig') // 'MC'
 * getInitials('Sabohiddin')   // 'S'
 * getInitials('')             // ''
 */
function getInitials(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '';

  const words = trimmed.split(/\s+/);
  const first = words[0]?.[0] ?? '';
  const second = words.length > 1 ? (words[1]?.[0] ?? '') : '';

  return (first + second).toUpperCase();
}

/**
 * Circular avatar image component used across all WhatsApp clone screens.
 *
 * Renders a user/contact photo inside a perfect circle with object-cover fit.
 * Falls back to a neutral gray circle with white initials derived from the
 * alt text when no image source is provided or when the image fails to load.
 *
 * Supports an optional badge overlay (absolute-positioned at bottom-right)
 * for indicators such as the blue "+" on the Status screen (node 0:8498).
 *
 * Uses Next.js `<Image>` with `fill` prop for optimized loading, automatic
 * lazy-loading, and WebP conversion.
 *
 * @example
 * ```tsx
 * <Avatar src="/avatars/martha.jpg" alt="Martha Craig" size="md" />
 * <Avatar alt="Karen Castillo" size="sm" /> // Shows initials "KC"
 * <Avatar src={userAvatar} alt="My Status" size="md" badge={<PlusIcon />} />
 * <Avatar alt="Jamie Franco" customSize={40} /> // 40px for calls list
 * ```
 */
function Avatar({
  src,
  alt,
  size = 'md',
  customSize,
  badge,
  className = '',
  onClick,
}: AvatarProps) {
  const [hasImageError, setHasImageError] = useState(false);

  /* Resolve the pixel dimension: customSize takes precedence over the size variant */
  const config = SIZE_CONFIG[size];
  const dimension = customSize ?? config.dimension;

  /**
   * Compute the initials font size.
   * For standard sizes use the pre-defined config value.
   * For custom sizes, scale proportionally relative to the md variant
   * (18px font / 52px container ≈ 0.346 ratio).
   */
  const fontSize = customSize
    ? Math.round(customSize * (config.fontSize / config.dimension))
    : config.fontSize;

  /* Determine whether to show the image or the initials fallback */
  const showImage = Boolean(src) && !hasImageError;
  const initials = getInitials(alt);

  /* Reset error state when src changes so a new URL gets a fresh attempt */
  useEffect(() => {
    setHasImageError(false);
  }, [src]);

  const handleImageError = () => {
    setHasImageError(true);
  };

  /**
   * Determine the interactive wrapper element.
   * When onClick is provided, the container acts as a button for accessibility.
   */
  const isInteractive = typeof onClick === 'function';
  const containerRole = isInteractive ? 'button' : undefined;
  const containerTabIndex = isInteractive ? 0 : undefined;

  /**
   * Handle keyboard activation for interactive avatars.
   * Enter and Space trigger the onClick callback (WCAG 2.1 AA — R34).
   */
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isInteractive && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onClick?.();
    }
  };

  return (
    <div
      role={containerRole}
      tabIndex={containerTabIndex}
      aria-label={alt}
      onClick={isInteractive ? onClick : undefined}
      onKeyDown={isInteractive ? handleKeyDown : undefined}
      className={[
        'relative inline-flex flex-shrink-0 rounded-full overflow-hidden',
        isInteractive
          ? 'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-2'
          : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        width: `${dimension}px`,
        height: `${dimension}px`,
        minWidth: `${dimension}px`,
        minHeight: `${dimension}px`,
      }}
    >
      {showImage ? (
        /* Next.js optimized Image with fill + object-cover inside the circular container */
        <Image
          src={src as string}
          alt={alt}
          fill
          sizes={`${dimension}px`}
          className="object-cover"
          onError={handleImageError}
        />
      ) : (
        /* Initials fallback — neutral gray circle with centered white text */
        <div
          className="flex h-full w-full items-center justify-center bg-[#C4C4C4]"
          aria-hidden="true"
        >
          <span
            className="font-semibold text-white leading-none select-none"
            style={{ fontSize: `${fontSize}px` }}
          >
            {initials}
          </span>
        </div>
      )}

      {/* Optional badge overlay — absolute positioned at bottom-right */}
      {badge != null && (
        <div className="absolute bottom-0 right-0 z-10">{badge}</div>
      )}
    </div>
  );
}

export default Avatar;
