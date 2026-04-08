'use client';

/**
 * @module ContactInfoPage
 *
 * Next.js App Router dynamic route page for /contact/[id].
 * Implements the Contact Info detail screen (Figma Screen 6:
 * WhatsApp Contact Info, node 0:9486, file key miK1B6qEPrUnRZ9wwZNrW2).
 *
 * This is a **client component** that orchestrates data fetching,
 * authentication gating (R9), error/loading states, responsive layout,
 * and mobile navigation management. The actual contact info UI is
 * delegated to the `ContactInfo` presentational component.
 *
 * Responsibilities:
 * - Extract dynamic [id] route parameter via useParams
 * - Auth gate: redirect unauthenticated users to /login (R9)
 * - Fetch contact/user data from REST API via apiClient.get() (R6)
 * - Manage loading, error, and empty states with skeleton UI
 * - Wire navigation handlers: back, edit, message, video call, phone call
 * - Responsive layout adjustments: mobile stack nav (R15), tablet, desktop
 * - Mobile navigation stack management via useUIStore (R15)
 *
 * @see AAP Section 0.5.1 (Screen 6 — WhatsApp Contact Info)
 * @see AAP Section 0.5.3 (Component Inventory — ContactInfoRow, SettingsRow)
 * @see Rules R6 (backend wiring), R9 (auth required), R15 (mobile nav), R34 (WCAG 2.1 AA)
 */

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

import ContactInfo from '@/components/contacts/ContactInfo';
import { NavigationBar } from '@/components/common/NavigationBar';
import Avatar from '@/components/common/Avatar';
import { SettingsRow } from '@/components/common/SettingsRow';
import { Separator } from '@/components/common/Separator';

import { useChatStore } from '@/stores/chatStore';
import { useAuthStore } from '@/stores/authStore';
import { useUIStore } from '@/stores/uiStore';

import { useResponsive } from '@/hooks/useResponsive';
import { apiClient } from '@/lib/api';

// =============================================================================
// Types
// =============================================================================

/**
 * Shape of user data returned from `GET /api/v1/users/:id`.
 *
 * Matches `UserResponse` from `@kalle/shared/types/user`.
 * Defined locally to avoid importing shared types directly from the
 * page component (shared types are consumed via stores/hooks/api).
 */
interface ContactData {
  /** Unique user identifier (UUID v4). */
  id: string;

  /** User's email address. */
  email: string;

  /** Display name shown in UI. */
  displayName: string;

  /** Avatar image URL. */
  avatar?: string;

  /** Status/about text (e.g., "Digital goodies designer - Pixsellz"). */
  about?: string;

  /** Phone number (e.g., "+1 202 555 0181"). */
  phoneNumber?: string;

  /** Current online/offline status string. */
  status: string;

  /** ISO 8601 timestamp of last activity. */
  lastSeen?: string;

  /** ISO 8601 timestamp of account creation. */
  createdAt: string;

  /** ISO 8601 timestamp of last profile update. */
  updatedAt: string;
}

// =============================================================================
// Helper — Back Chevron SVG
// =============================================================================

/**
 * Compact blue back-chevron SVG used in the NavigationBar left action.
 * Matches Figma node 0:8257 chevron specification: 11.84×21px, fill #007AFF.
 */
function BackChevronSmall() {
  return (
    <svg
      width="10"
      height="18"
      viewBox="0 0 10 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="flex-shrink-0"
    >
      <path
        d="M9 1L1 9L9 17"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// =============================================================================
// Helper — format date for status/bio date
// =============================================================================

/**
 * Formats an ISO 8601 date string into a human-readable short date.
 * Examples: "Dec 18, 2018", "Mar 30, 2026".
 *
 * @param isoDate - ISO 8601 date string
 * @returns Formatted date string, or empty string for invalid/missing input
 */
function formatStatusDate(isoDate: string | undefined): string {
  if (!isoDate) return '';
  try {
    const date = new Date(isoDate);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

// =============================================================================
// Loading Skeleton Component
// =============================================================================

/**
 * Skeleton UI displayed while contact data is being fetched.
 * Uses NavigationBar, Avatar, SettingsRow, and Separator from the
 * common component library to provide a recognisable loading pattern
 * that mirrors the final ContactInfo layout structure.
 *
 * @param props.onBack - Callback for back navigation during loading
 */
function ContactInfoSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Navigation bar — visible immediately during load */}
      <NavigationBar
        title="Contact Info"
        leftAction={
          <span className="flex items-center gap-1">
            <BackChevronSmall />
          </span>
        }
        onLeftAction={onBack}
        leftActionLabel="Go back"
      />

      <div
        role="region"
        className="flex-1 overflow-y-auto"
        aria-busy="true"
        aria-label="Loading contact information"
      >
        {/* Profile photo skeleton — aspect-square gray placeholder */}
        <div className="w-full aspect-square bg-gray-200 animate-pulse" />

        {/* Info & Actions skeleton — name/phone + action button placeholders */}
        <div className="bg-white shadow-card px-[15px] py-3">
          <div className="flex items-center justify-between">
            <div className="space-y-2">
              <div className="h-5 w-32 bg-gray-200 rounded animate-pulse" />
              <div className="h-3 w-24 bg-gray-200 rounded animate-pulse" />
            </div>
            <div className="flex gap-3">
              {/* Three circular action button placeholders */}
              <Avatar
                alt="Loading action"
                size="sm"
                className="animate-pulse opacity-30"
              />
              <Avatar
                alt="Loading action"
                size="sm"
                className="animate-pulse opacity-30"
              />
              <Avatar
                alt="Loading action"
                size="sm"
                className="animate-pulse opacity-30"
              />
            </div>
          </div>
        </div>

        {/* Separator between info and bio */}
        <Separator inset insetLeft={16} />

        {/* Bio section skeleton */}
        <div className="bg-white shadow-card px-[15px] py-3">
          <div className="h-4 w-48 bg-gray-200 rounded animate-pulse" />
          <div className="h-3 w-20 bg-gray-200 rounded animate-pulse mt-2" />
        </div>

        {/* Section gap */}
        <div className="h-[19px]" aria-hidden="true" />

        {/* Settings rows skeleton — three placeholder rows */}
        <div className="bg-white shadow-[0_-0.33px_0_rgba(60,60,67,0.29),0_0.33px_0_rgba(60,60,67,0.29)]">
          <SettingsRow
            label="Media, Links, and Docs"
            icon={
              <div className="w-[29px] h-[29px] bg-gray-200 rounded-[6px] animate-pulse" />
            }
            iconBgColor="transparent"
            showChevron
            showSeparator
          />
          <SettingsRow
            label="Starred Messages"
            icon={
              <div className="w-[29px] h-[29px] bg-gray-200 rounded-[6px] animate-pulse" />
            }
            iconBgColor="transparent"
            showChevron
            showSeparator
          />
          <SettingsRow
            label="Chat Search"
            icon={
              <div className="w-[29px] h-[29px] bg-gray-200 rounded-[6px] animate-pulse" />
            }
            iconBgColor="transparent"
            showChevron
          />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Error State Component
// =============================================================================

/**
 * Error/empty state displayed when contact data fails to load or
 * the contact is not found. Shows the NavigationBar with a back button,
 * a placeholder Avatar, error message text, and a retry/go-back button.
 *
 * @param props.onBack    - Callback for back navigation
 * @param props.errorText - Human-readable error message
 */
function ContactInfoError({
  onBack,
  errorText,
}: {
  onBack: () => void;
  errorText: string;
}) {
  return (
    <div className="flex flex-col h-full bg-surface">
      <NavigationBar
        title="Contact Info"
        leftAction={
          <span className="flex items-center gap-1">
            <BackChevronSmall />
            <span className="font-sans text-nav-action tracking-tight-ios">
              Back
            </span>
          </span>
        }
        onLeftAction={onBack}
        leftActionLabel="Go back"
      />

      <div
        className="flex-1 flex flex-col items-center justify-center p-8"
        role="alert"
      >
        {/* Placeholder avatar for visual weight */}
        <Avatar alt="Contact not found" size="lg" />

        <p className="text-secondary font-sans text-body-text tracking-[-0.02em] text-center mt-4">
          {errorText}
        </p>

        <button
          type="button"
          onClick={onBack}
          className="mt-4 text-blue-ios font-sans text-nav-action tracking-tight-ios rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2"
          aria-label="Go back to previous page"
        >
          Go Back
        </button>

        {/* Visual separator before empty space */}
        <Separator className="mt-8 w-48" />
      </div>
    </div>
  );
}

// =============================================================================
// Page Component
// =============================================================================

/**
 * ContactInfoPage — Dynamic route page for /contact/[id].
 *
 * Orchestrates data fetching, auth gating, responsive layout, and
 * mobile navigation for the Contact Info screen. Delegates all visual
 * rendering to the ContactInfo presentational component on the happy path.
 *
 * @returns React element for the contact info page
 */
export default function ContactInfoPage() {
  // ─── Routing ─────────────────────────────────────────────────────────
  const params = useParams();
  const router = useRouter();

  // Safely extract the dynamic [id] param — handles string and string[] forms
  const id =
    typeof params.id === 'string'
      ? params.id
      : Array.isArray(params.id)
        ? params.id[0]
        : '';

  // ─── Store Hooks ─────────────────────────────────────────────────────

  // Auth state for gate check (R9) — members_accessed: isAuthenticated, user
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);

  // Chat store for conversation lookup when "message" action is tapped
  const conversations = useChatStore((s) => s.conversations);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);

  // UI store for mobile navigation stack management (R15)
  const pushMobileNav = useUIStore((s) => s.pushMobileNav);
  const setMobileNavOpen = useUIStore((s) => s.setMobileNavOpen);

  // Responsive breakpoint detection — members_accessed: isMobile, isTablet, isDesktop
  const { isMobile, isTablet, isDesktop } = useResponsive();

  // ─── Local State ─────────────────────────────────────────────────────
  const [contact, setContact] = useState<ContactData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // ─── Auth Gate (R9): redirect unauthenticated users ──────────────────
  useEffect(() => {
    if (!isAuthenticated) {
      // (auth) is a Next.js route group — no URL segment; correct path is /login
      router.replace('/login');
    }
  }, [isAuthenticated, router]);

  // ─── Data Fetching: load contact by ID from REST API (R6) ────────────
  useEffect(() => {
    // Skip if no ID or not authenticated
    if (!id || !isAuthenticated) return;

    let cancelled = false;

    async function fetchContact() {
      setIsLoading(true);
      setError(null);

      try {
        const data = await apiClient.get<ContactData>(
          `/api/v1/users/${encodeURIComponent(id)}`,
        );

        if (!cancelled) {
          setContact(data);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const message =
            err instanceof Error
              ? err.message
              : 'Failed to load contact information';
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    fetchContact();

    return () => {
      cancelled = true;
    };
  }, [id, isAuthenticated]);

  // ─── Mobile Navigation: push this route onto the stack (R15) ─────────
  useEffect(() => {
    if (isMobile && id) {
      setMobileNavOpen(false);
      pushMobileNav(`/contact/${id}`);
    }
  }, [isMobile, id, setMobileNavOpen, pushMobileNav]);

  // ─── Navigation Handlers ─────────────────────────────────────────────

  /** Navigate back to previous view */
  const handleBack = () => {
    router.back();
  };

  /** Navigate to the edit contact page */
  const handleEdit = () => {
    if (id) {
      router.push(`/contact/${id}/edit`);
    }
  };

  /**
   * Navigate to the conversation with this contact.
   * Looks up an existing DIRECT conversation in the chat store.
   * If the contact is the current user, navigates to settings/profile instead.
   * If none is found, navigates to the main chat list.
   */
  const handleMessage = () => {
    // Prevent messaging yourself — navigate to profile instead
    if (user && contact && user.id === contact.id) {
      router.push('/settings/profile');
      return;
    }

    // Search for a DIRECT conversation whose displayName matches the contact
    const existingConversation = conversations.find(
      (conv) =>
        conv.type === 'DIRECT' && contact && conv.displayName === contact.displayName,
    );

    if (existingConversation) {
      setActiveConversation(existingConversation.id);
      router.push(`/chat/${existingConversation.id}`);
    } else {
      // Fall back to main chat list if no direct conversation is found
      router.push('/chat');
    }
  };

  /**
   * Video call action handler.
   * WebRTC calling is out of scope per AAP Section 0.8.2.
   */
  const handleVideoCall = () => {
    /* BLITZY [OUT_OF_SCOPE]: WebRTC video calling not implemented per AAP 0.8.2.
       Voice/Video calling UI is displayed, but no actual WebRTC functionality. */
  };

  /**
   * Phone call action handler.
   * WebRTC calling is out of scope per AAP Section 0.8.2.
   */
  const handlePhoneCall = () => {
    /* BLITZY [OUT_OF_SCOPE]: WebRTC voice calling not implemented per AAP 0.8.2.
       Voice/Video calling UI is displayed, but no actual WebRTC functionality. */
  };

  // ─── Responsive Container Class ──────────────────────────────────────
  // Desktop: constrain to mobile artboard width, centered
  // Tablet: slightly wider, centered
  // Mobile: full width with stack navigation (R15)
  const containerClass = isDesktop
    ? 'max-w-[375px] mx-auto h-full'
    : isTablet
      ? 'max-w-[540px] mx-auto h-full'
      : 'w-full h-full';

  // ─── Render Gate: show loading skeleton while auth is pending or
  //     redirecting. IMPORTANT: we never return `null` — Next.js SSR
  //     interprets a null page render as "no content" and serves a 404.
  //     Return a visible skeleton instead so the page always produces
  //     renderable HTML during SSR and hydration. ────────────────────
  if (!isAuthenticated || isLoading) {
    return (
      <div className={containerClass}>
        <ContactInfoSkeleton onBack={handleBack} />
      </div>
    );
  }

  // ─── Error / Not Found State ─────────────────────────────────────────
  if (error || !contact) {
    return (
      <div className={containerClass}>
        <ContactInfoError
          onBack={handleBack}
          errorText={error || 'Contact not found'}
        />
      </div>
    );
  }

  // ─── Happy Path: render ContactInfo with fetched data ────────────────
  //
  // Map API UserResponse fields to ContactInfo props:
  // - displayName → name
  // - phoneNumber → phone
  // - avatar → avatarUrl
  // - about → statusText
  // - updatedAt → statusDate (formatted)
  //
  // The ContactInfo component renders the complete Figma Screen 6 UI
  // including StatusBar, NavigationBar, profile photo, action buttons,
  // bio section, and all settings rows.
  return (
    <div className={containerClass}>
      <ContactInfo
        contactId={id}
        name={contact.displayName}
        phone={contact.phoneNumber || ''}
        avatarUrl={contact.avatar}
        statusText={contact.about}
        statusDate={formatStatusDate(contact.updatedAt)}
        isMuted={false}
        onBack={handleBack}
        onEdit={handleEdit}
        onMessage={handleMessage}
        onVideoCall={handleVideoCall}
        onPhoneCall={handlePhoneCall}
      />
    </div>
  );
}
