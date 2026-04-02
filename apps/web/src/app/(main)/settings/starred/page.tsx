'use client';

import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { NavigationBar } from '@/components/common/NavigationBar';
import starredEmptyImg from '@/assets/images/img-starred-empty.png';

/**
 * Starred Messages Empty State Page
 *
 * Implements Figma Screen 16 (node 0:8820, file key miK1B6qEPrUnRZ9wwZNrW2).
 * This is a UI shell only — starred message functionality is explicitly out of
 * scope per AAP Section 0.8.2. Renders a centered empty state illustration with
 * heading and instructional body text.
 *
 * Layout:
 *   ┌─────────────────────────────────┐
 *   │  NavigationBar                  │
 *   │  ← Settings    Starred Messages │
 *   ├─────────────────────────────────┤
 *   │                                 │
 *   │      ┌──────────────┐           │
 *   │      │  ○ Circular  │           │
 *   │      │  illustration│           │
 *   │      └──────────────┘           │
 *   │     No Starred Messages         │
 *   │  Tap and hold on any message…   │
 *   │                                 │
 *   └─────────────────────────────────┘
 *
 * Design Tokens:
 * - Background: surface (#EFEFF4)
 * - Heading: 600 16px / 1.3125em, color rgba(60,60,67,0.6)
 * - Body: 400 14px / 1.5em, color rgba(60,60,67,0.6)
 * - Illustration: 132×132px circle, border 0.5px #636366, shadow 0 2px 4px rgba(0,0,0,0.2)
 */
export default function StarredMessagesPage() {
  const router = useRouter();

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Navigation Bar — back chevron with "Settings" label, centered title */}
      <NavigationBar
        title="Starred Messages"
        leftAction={
          <span className="flex items-center gap-[6px]">
            {/* Back chevron — inline SVG from icon-back-chevron.svg (node 0:8825).
                Uses currentColor to inherit text-blue-ios from NavigationBar action button. */}
            <svg
              width="12"
              height="21"
              viewBox="0 0 12 21"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
              className="shrink-0"
            >
              <path
                d="M3.60206 10.5L11.4062 2.55085C11.9866 1.9597 11.9778 1.00999 11.3867 0.429623C10.7955 -0.150747 9.84583 -0.142006 9.26546 0.449147L0.429623 9.44915C-0.143208 10.0326 -0.143208 10.9674 0.429623 11.5509L9.26546 20.5509C9.84583 21.142 10.7955 21.1507 11.3867 20.5704C11.9778 19.99 11.9866 19.0403 11.4062 18.4491L3.60206 10.5Z"
                fill="currentColor"
              />
            </svg>
            Settings
          </span>
        }
        onLeftAction={() => router.back()}
      />

      {/* Empty state content — vertically and horizontally centered in remaining space */}
      <main className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center mx-6">
          {/* Circular illustration — 132×132px with border, shadow, and rounded clip.
              Figma node 0:8852. Image: img-starred-empty.png (imageRef 35177d93c…). */}
          <div
            className="w-[132px] h-[132px] rounded-full border-[0.5px] border-[#636366] shadow-[0_2px_4px_rgba(0,0,0,0.2)] overflow-hidden relative"
          >
            <Image
              src={starredEmptyImg}
              alt="Starred messages illustration showing a chat message with a star"
              fill
              sizes="132px"
              className="object-cover"
              priority
            />
          </div>

          {/* Heading — SF Pro Text 600, 16px, line-height 1.3125em, tracking -0.03em.
              25px gap below illustration. Color rgba(60,60,67,0.6). Node 0:8854. */}
          <h1
            className="font-semibold text-[16px] leading-[1.3125em] tracking-tighter-ios text-[rgba(60,60,67,0.6)] mt-[25px]"
          >
            No Starred Messages
          </h1>

          {/* Description — SF Pro Text 400, 14px, line-height 1.5em, tracking -0.02em.
              10px gap below heading. Max width 327px. Centered. Color rgba(60,60,67,0.6).
              Node 0:8853. */}
          <p
            className="font-normal text-[14px] leading-[1.5em] tracking-[-0.02em] text-[rgba(60,60,67,0.6)] text-center mt-[10px] max-w-[327px]"
          >
            Tap and hold on any message to star it, so you can easily find it later.
          </p>
        </div>
      </main>
    </div>
  );
}
