'use client';

/**
 * EditContactPage — /contact/[id]/edit
 *
 * Next.js 14 App Router page implementing Figma Screen 7:
 * "WhatsApp Edit Contact" (node 0:10334, file key miK1B6qEPrUnRZ9wwZNrW2).
 *
 * Responsibilities:
 * - Extracts the dynamic [id] route parameter to identify the contact.
 * - Auth gate: redirects unauthenticated users to /auth/login (Rule R9).
 * - Fetches contact data from the live backend via REST API (Rules R5, R6).
 * - Renders the EditContact form component with fetched data and action handlers.
 * - Handles loading, error, and form-submission states.
 * - Manages navigation: cancel → back, save → back, delete → /chat.
 * - Applies responsive layout constraints (Rules R3, R15).
 *
 * @see AAP Section 0.7.1 Group 14 — Frontend Application
 * @see Rules R1 (Figma fidelity), R5 (no mocks), R6 (backend integration),
 *      R7 (zero warnings), R9 (auth gate), R15 (mobile stack nav),
 *      R22 (error shape), R34 (WCAG 2.1 AA)
 */

// ---------------------------------------------------------------------------
// External imports
// ---------------------------------------------------------------------------
import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';

// ---------------------------------------------------------------------------
// Internal imports — components
// ---------------------------------------------------------------------------
import { NavigationBar } from '@/components/common/NavigationBar';
import { Separator } from '@/components/common/Separator';
import { EditContact } from '@/components/contacts/EditContact';

// ---------------------------------------------------------------------------
// Internal imports — state management
// ---------------------------------------------------------------------------
import { useChatStore } from '@/stores/chatStore';
import { useAuthStore } from '@/stores/authStore';

// ---------------------------------------------------------------------------
// Internal imports — utilities and hooks
// ---------------------------------------------------------------------------
import { apiClient } from '@/lib/api';
import { useResponsive } from '@/hooks/useResponsive';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of the user profile response from GET /api/v1/users/:id.
 * Defined locally because @kalle/shared is not a direct page dependency;
 * the EditContact component and stores handle the shared-type integration.
 */
interface UserProfileResponse {
  id: string;
  displayName?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  phoneCountry?: string;
  phoneType?: string;
  about?: string;
  avatarUrl?: string;
  email?: string;
}

/**
 * Data shape emitted by the EditContact component on save.
 * Mirrors the onSave callback signature in EditContactProps.
 */
interface SavePayload {
  firstName: string;
  lastName: string;
  phoneCountry: string;
  phoneType: string;
  phoneNumber: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Page component for editing a contact's profile information.
 *
 * This page:
 * 1. Reads the `[id]` dynamic segment from the URL via `useParams`.
 * 2. Redirects unauthenticated users to `/auth/login` (R9).
 * 3. Fetches the contact profile from `GET /api/v1/users/:id` (R5, R6).
 * 4. Renders loading / error / form states with NavigationBar chrome.
 * 5. Delegates the form UI to the `EditContact` component (R2 — component reuse).
 * 6. On save: PATCHes the profile to the backend and navigates back.
 * 7. On delete: DELETEs the contact and navigates to `/chat`.
 *
 * Responsive behaviour (R3, R15):
 * - Mobile (≤ 767 px): full-width, replaces previous view (stack nav).
 * - Tablet (768–1 279 px): centred with 500 px max-width.
 * - Desktop (≥ 1 280 px): constrained width within parent side-by-side layout.
 */
export default function EditContactPage(): React.JSX.Element | null {
  // -----------------------------------------------------------------------
  // Routing
  // -----------------------------------------------------------------------
  const params = useParams();
  const router = useRouter();
  const id = (params?.id ?? '') as string;

  // -----------------------------------------------------------------------
  // Stores
  // -----------------------------------------------------------------------
  const { isAuthenticated, isInitialized, user } = useAuthStore();
  const { conversations } = useChatStore();

  // -----------------------------------------------------------------------
  // Responsive breakpoints
  // -----------------------------------------------------------------------
  const { isMobile, isTablet, isDesktop } = useResponsive();

  // -----------------------------------------------------------------------
  // Local state
  // -----------------------------------------------------------------------
  const [contactData, setContactData] = useState<UserProfileResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // -----------------------------------------------------------------------
  // Auth gate — redirect unauthenticated users (R9)
  // Wait for store rehydration (isInitialized) before making redirect
  // decisions to prevent flash-of-unauthenticated-content (FOUC).
  // Redirect users editing their own profile to /settings/profile.
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!isInitialized) return;
    if (!isAuthenticated) {
      router.replace('/auth/login');
    } else if (user && user.id === id) {
      router.replace('/settings/profile');
    }
  }, [isInitialized, isAuthenticated, user, id, router]);

  // -----------------------------------------------------------------------
  // Data fetching — load contact profile on mount (R5, R6)
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!id || !isInitialized || !isAuthenticated) return;

    let cancelled = false;

    const fetchContact = async (): Promise<void> => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await apiClient.get<UserProfileResponse>(
          `/api/v1/users/${id}`,
        );
        if (!cancelled && response) {
          setContactData(response);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load contact',
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    fetchContact();

    return () => {
      cancelled = true;
    };
  }, [id, isAuthenticated]);

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  /** Cancel editing and navigate back to the previous view. */
  const handleCancel = useCallback((): void => {
    router.back();
  }, [router]);

  /** Persist changes via PATCH and navigate back on success (R5, R6). */
  const handleSave = useCallback(
    async (data: SavePayload): Promise<void> => {
      try {
        await apiClient.patch(`/api/v1/users/${id}`, {
          firstName: data.firstName,
          lastName: data.lastName,
          phoneCountry: data.phoneCountry,
          phoneType: data.phoneType,
          phoneNumber: data.phoneNumber,
        });
        router.back();
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : 'Failed to save changes',
        );
      }
    },
    [id, router],
  );

  /** Delete the contact and navigate to the chat list (R5, R6). */
  const handleDelete = useCallback(async (): Promise<void> => {
    try {
      await apiClient.delete(`/api/v1/users/${id}/contact`);
      // Navigate to conversation list after successful deletion
      router.push('/chat');
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Failed to delete contact',
      );
    }
  }, [id, router]);

  /**
   * Retry fetching contact data after an error.
   * Used by the error-state Retry button.
   */
  const handleRetry = useCallback((): void => {
    setError(null);
    setIsLoading(true);
    apiClient
      .get<UserProfileResponse>(`/api/v1/users/${id}`)
      .then((response) => {
        if (response) {
          setContactData(response);
        }
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : 'Failed to load contact',
        );
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [id]);

  // -----------------------------------------------------------------------
  // Auth redirect — render nothing while rehydration or redirect is pending
  // -----------------------------------------------------------------------
  if (!isInitialized || !isAuthenticated) {
    return null;
  }

  // -----------------------------------------------------------------------
  // Responsive container classes (R3, R15)
  // Mobile: full width. Tablet/Desktop: constrained max-width, centred.
  // -----------------------------------------------------------------------
  const containerClasses = [
    'flex flex-col min-h-screen bg-white font-sans',
    isMobile ? 'w-full pb-[env(safe-area-inset-bottom,34px)]' : '',
    isTablet ? 'max-w-[500px] mx-auto w-full' : '',
    isDesktop ? 'max-w-[500px] w-full' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // -----------------------------------------------------------------------
  // Cancel button shared across loading / error states (DRY)
  // -----------------------------------------------------------------------
  const cancelButton = (
    <button
      type="button"
      onClick={handleCancel}
      className="text-nav-action text-blue-ios tracking-tight-ios focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2 rounded"
      aria-label="Cancel editing"
    >
      Cancel
    </button>
  );

  const disabledSaveLabel = (
    <span
      className="text-nav-title text-disabled tracking-tight-ios"
      aria-disabled="true"
    >
      Save
    </span>
  );

  // -----------------------------------------------------------------------
  // Render: Loading state
  // -----------------------------------------------------------------------
  if (isLoading) {
    return (
      <main
        className={containerClasses}
        role="main"
        aria-label="Edit Contact"
        aria-busy="true"
      >
        <NavigationBar
          title="Edit Contact"
          leftAction={cancelButton}
          rightAction={disabledSaveLabel}
        />
        <Separator />
        <div
          className="flex flex-1 items-center justify-center"
          role="status"
          aria-label="Loading contact information"
        >
          <div className="flex flex-col items-center gap-3">
            {/* Animated spinner */}
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-ios border-t-transparent" />
            <p className="text-body-text text-secondary tracking-tighter-ios">
              Loading contact…
            </p>
          </div>
        </div>
      </main>
    );
  }

  // -----------------------------------------------------------------------
  // Render: Error state (no contact data loaded)
  // -----------------------------------------------------------------------
  if (error && !contactData) {
    return (
      <main
        className={containerClasses}
        role="main"
        aria-label="Edit Contact"
      >
        <NavigationBar
          title="Edit Contact"
          leftAction={cancelButton}
          rightAction={disabledSaveLabel}
        />
        <Separator />
        <div
          className="flex flex-1 flex-col items-center justify-center gap-4 px-4"
          role="alert"
        >
          <p className="text-body-text text-red-ios text-center tracking-tighter-ios">
            {error}
          </p>
          <button
            type="button"
            onClick={handleRetry}
            className="text-nav-action text-blue-ios tracking-tight-ios px-4 py-2 rounded-lg focus-visible:outline-2 focus-visible:outline-blue-ios focus-visible:outline-offset-2"
            aria-label="Retry loading contact"
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  // -----------------------------------------------------------------------
  // Resolve contact fields from API response
  //
  // Use local conversations data to supplement display name resolution
  // when the API response provides only a displayName without separate
  // first/last name fields.
  // -----------------------------------------------------------------------
  const localConversation = conversations.find(
    (conv) => conv.displayName !== undefined && conv.displayName.length > 0,
  );
  const supplementalName =
    contactData?.displayName ?? localConversation?.displayName;

  const resolvedFirstName: string =
    contactData?.firstName ??
    supplementalName?.split(' ')[0] ??
    '';

  const resolvedLastName: string =
    contactData?.lastName ??
    supplementalName?.split(' ').slice(1).join(' ') ??
    '';

  const resolvedPhoneCountry: string =
    contactData?.phoneCountry ?? 'New Zealand';

  const resolvedPhoneType: string =
    contactData?.phoneType ?? 'mobile';

  const resolvedPhoneNumber: string =
    contactData?.phone ?? '';

  // -----------------------------------------------------------------------
  // Render: Main form via EditContact component (R2 — component reuse)
  // -----------------------------------------------------------------------
  return (
    <main
      className={containerClasses}
      role="main"
      aria-label="Edit Contact"
    >
      {/* Visually hidden heading for screen readers (R34 — heading hierarchy) */}
      <h1 className="sr-only">Edit Contact</h1>

      {/* Inline error banner shown when save/delete fails after data is loaded */}
      {error && (
        <div
          className="bg-red-ios/10 px-4 py-2 text-body-text text-red-ios text-center tracking-tighter-ios"
          role="alert"
        >
          {error}
        </div>
      )}

      <EditContact
        contactId={id}
        firstName={resolvedFirstName}
        lastName={resolvedLastName}
        phoneCountry={resolvedPhoneCountry}
        phoneType={resolvedPhoneType}
        phoneNumber={resolvedPhoneNumber}
        onCancel={handleCancel}
        onSave={handleSave}
        onDelete={handleDelete}
      />
    </main>
  );
}
