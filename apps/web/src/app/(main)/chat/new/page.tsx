'use client';

/**
 * @module apps/web/src/app/(main)/chat/new/page.tsx
 *
 * New Conversation Page — allows users to search for contacts and create
 * a new DIRECT or GROUP conversation via the backend API.
 *
 * This is a static Next.js App Router route that takes precedence over
 * the dynamic `[id]` route, preventing the route collision where "new"
 * was previously interpreted as a conversation UUID (Issue #3).
 *
 * Routes handled:
 *  - /chat/new          → Direct conversation creation (default)
 *  - /chat/new?type=group → Group conversation creation
 *
 * AAP Rules enforced:
 *  - R5  No mock data — live user search via GET /api/v1/users/search
 *  - R6  Backend wiring — conversation creation via POST /api/v1/conversations
 *  - R9  Auth guard — redirects unauthenticated users
 *  - R15 Mobile stack — full-screen view (no split panel on mobile)
 *  - R31 Zod validation — server validates CreateConversationDTO
 *  - R34 WCAG 2.1 AA — ARIA roles, keyboard nav, focus indicators
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { useAuthStore } from '@/stores/authStore';
import { apiClient } from '@/lib/api';
import NavigationBar from '@/components/common/NavigationBar';
import Avatar from '@/components/common/Avatar';
import Separator from '@/components/common/Separator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lightweight user result returned by GET /api/v1/users/search */
interface UserSearchResult {
  id: string;
  displayName: string;
  email: string;
  avatar?: string;
  about?: string;
  status: string;
}

// ---------------------------------------------------------------------------
// NewConversationPage Component
// ---------------------------------------------------------------------------

export default function NewConversationPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Determine mode from query param: ?type=group → GROUP, else DIRECT
  const isGroupMode = searchParams.get('type') === 'group';

  // ── Auth guard (R9) ───────────────────────────────────────────────
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const currentUser = useAuthStore((s) => s.user);

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace('/login');
    }
  }, [isAuthenticated, router]);

  // ── Local state ───────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<UserSearchResult[]>([]);
  const [groupName, setGroupName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── User search with debounce ─────────────────────────────────────
  const performSearch = useCallback(async (query: string) => {
    if (query.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const response = await apiClient.get<{
        data: { items: UserSearchResult[]; nextCursor?: string };
      }>(`/api/v1/users/search?q=${encodeURIComponent(query.trim())}&limit=20`);

      const items = response?.data?.items ?? [];
      // Filter out current user (server may already exclude, but be safe)
      const filtered = items.filter((u) => u.id !== currentUser?.id);
      setSearchResults(filtered);
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [currentUser?.id]);

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
      searchTimerRef.current = setTimeout(() => {
        performSearch(value);
      }, 300);
    },
    [performSearch],
  );

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, []);

  // ── Selection handlers ────────────────────────────────────────────
  const toggleUserSelection = useCallback((user: UserSearchResult) => {
    setSelectedUsers((prev) => {
      const exists = prev.find((u) => u.id === user.id);
      if (exists) {
        return prev.filter((u) => u.id !== user.id);
      }
      return [...prev, user];
    });
  }, []);

  const isUserSelected = useCallback(
    (userId: string) => selectedUsers.some((u) => u.id === userId),
    [selectedUsers],
  );

  // ── Direct conversation — select user and create immediately ──────
  const handleDirectSelect = useCallback(
    async (user: UserSearchResult) => {
      if (isCreating || !currentUser) return;
      setIsCreating(true);
      setError(null);

      try {
        const response = await apiClient.post<{
          data: { id: string };
        }>('/api/v1/conversations', {
          type: 'DIRECT',
          participantIds: [currentUser.id, user.id],
        });

        const conversationId = response?.data?.id;
        if (conversationId) {
          router.replace(`/chat/${conversationId}`);
        } else {
          setError('Failed to create conversation. Please try again.');
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Failed to create conversation.';
        setError(message);
      } finally {
        setIsCreating(false);
      }
    },
    [isCreating, currentUser, router],
  );

  // ── Group conversation — create with selected members ─────────────
  const handleCreateGroup = useCallback(async () => {
    if (isCreating || !currentUser) return;
    if (selectedUsers.length < 1) {
      setError('Select at least one contact for the group.');
      return;
    }
    if (!groupName.trim()) {
      setError('Group name is required.');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const participantIds = [
        currentUser.id,
        ...selectedUsers.map((u) => u.id),
      ];

      const response = await apiClient.post<{
        data: { id: string };
      }>('/api/v1/conversations', {
        type: 'GROUP',
        participantIds,
        groupName: groupName.trim(),
      });

      const conversationId = response?.data?.id;
      if (conversationId) {
        router.replace(`/chat/${conversationId}`);
      } else {
        setError('Failed to create group. Please try again.');
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to create group.';
      setError(message);
    } finally {
      setIsCreating(false);
    }
  }, [isCreating, currentUser, selectedUsers, groupName, router]);

  // ── Back navigation ───────────────────────────────────────────────
  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  // ── Auth guard render block ───────────────────────────────────────
  if (!isAuthenticated) {
    return null;
  }

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-surface">
      {/* ── Navigation Bar ──────────────────────────────────────── */}
      <NavigationBar
        title={isGroupMode ? 'New Group' : 'New Chat'}
        leftAction={
          <button
            type="button"
            onClick={handleBack}
            className="text-[17px] font-normal text-blue-ios focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios"
            aria-label="Go back"
          >
            Back
          </button>
        }
        rightAction={
          isGroupMode && selectedUsers.length > 0 ? (
            <button
              type="button"
              onClick={handleCreateGroup}
              disabled={isCreating || !groupName.trim()}
              className={`text-[17px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios ${
                isCreating || !groupName.trim()
                  ? 'text-disabled cursor-default'
                  : 'text-blue-ios'
              }`}
              aria-label="Create group"
            >
              {isCreating ? 'Creating…' : 'Create'}
            </button>
          ) : undefined
        }
      />

      {/* ── Group Name Input (group mode only) ─────────────────── */}
      {isGroupMode && (
        <div className="bg-white px-4 py-3 border-b border-separator">
          <label
            htmlFor="group-name-input"
            className="block text-[13px] font-normal text-secondary uppercase tracking-wide mb-1"
          >
            Group Name
          </label>
          <input
            id="group-name-input"
            type="text"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="Enter group name"
            className="w-full text-[17px] font-normal text-black bg-transparent outline-none placeholder:text-secondary"
            aria-label="Group name"
            autoFocus
          />
        </div>
      )}

      {/* ── Selected Users Chips (group mode) ──────────────────── */}
      {isGroupMode && selectedUsers.length > 0 && (
        <div className="bg-white px-4 py-2 border-b border-separator flex flex-wrap gap-2">
          {selectedUsers.map((user) => (
            <button
              key={user.id}
              type="button"
              onClick={() => toggleUserSelection(user)}
              className="flex items-center gap-1 bg-blue-ios/10 text-blue-ios rounded-full px-3 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios"
              aria-label={`Remove ${user.displayName}`}
            >
              {user.displayName}
              <span aria-hidden="true" className="ml-1 text-xs">✕</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Search Input ───────────────────────────────────────── */}
      <div className="px-4 py-2 bg-surface">
        <div className="relative flex items-center bg-white rounded-lg border border-separator px-3 py-2">
          <svg
            className="w-4 h-4 text-secondary mr-2 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search by name or email"
            className="flex-1 text-[15px] font-normal text-black bg-transparent outline-none placeholder:text-secondary"
            aria-label="Search contacts"
            role="searchbox"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setSearchResults([]);
              }}
              className="ml-2 text-secondary hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios"
              aria-label="Clear search"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ── Error Banner ───────────────────────────────────────── */}
      {error && (
        <div
          className="mx-4 mt-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* ── Results / Empty State ──────────────────────────────── */}
      <div className="flex-1 overflow-y-auto" role="list" aria-label="Search results">
        {isSearching && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-ios" />
          </div>
        )}

        {!isSearching && searchQuery.trim().length >= 2 && searchResults.length === 0 && (
          <p className="text-center text-secondary text-[15px] py-8">
            No users found matching &ldquo;{searchQuery}&rdquo;
          </p>
        )}

        {!isSearching && searchQuery.trim().length < 2 && (
          <p className="text-center text-secondary text-[15px] py-8">
            {isGroupMode
              ? 'Search for contacts to add to the group.'
              : 'Search for a contact to start a conversation.'}
          </p>
        )}

        {searchResults.map((user, index) => (
          <div key={user.id}>
            <button
              type="button"
              onClick={() =>
                isGroupMode
                  ? toggleUserSelection(user)
                  : handleDirectSelect(user)
              }
              disabled={isCreating}
              className={`w-full flex items-center px-4 py-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-ios ${
                isUserSelected(user.id)
                  ? 'bg-blue-ios/5'
                  : 'hover:bg-black/5 active:bg-black/10'
              } ${isCreating ? 'opacity-50 cursor-default' : ''}`}
              role="listitem"
              aria-selected={isGroupMode ? isUserSelected(user.id) : undefined}
              aria-label={`${isGroupMode ? (isUserSelected(user.id) ? 'Deselect' : 'Select') : 'Start conversation with'} ${user.displayName}`}
            >
              {/* Selection indicator (group mode) */}
              {isGroupMode && (
                <div
                  className={`w-[22px] h-[22px] rounded-full border-2 mr-3 flex items-center justify-center flex-shrink-0 ${
                    isUserSelected(user.id)
                      ? 'bg-blue-ios border-blue-ios'
                      : 'border-secondary'
                  }`}
                  aria-hidden="true"
                >
                  {isUserSelected(user.id) && (
                    <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                </div>
              )}

              {/* Avatar */}
              <Avatar
                src={user.avatar}
                alt={user.displayName}
                size="md"
              />

              {/* User info */}
              <div className="ml-3 flex-1 min-w-0">
                <p className="text-[16px] font-semibold text-black truncate leading-[1.31em]">
                  {user.displayName}
                </p>
                <p className="text-[14px] font-normal text-secondary truncate leading-[1.19em]">
                  {user.about || user.email}
                </p>
              </div>

              {/* Online indicator */}
              {user.status === 'ONLINE' && (
                <div
                  className="w-2.5 h-2.5 rounded-full bg-whatsapp-green flex-shrink-0 ml-2"
                  aria-label="Online"
                />
              )}
            </button>
            {index < searchResults.length - 1 && <Separator inset />}
          </div>
        ))}
      </div>

      {/* ── Creating overlay ───────────────────────────────────── */}
      {isCreating && (
        <div className="absolute inset-0 bg-black/20 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 shadow-lg flex flex-col items-center gap-3">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-ios" />
            <p className="text-[15px] font-normal text-black">
              {isGroupMode ? 'Creating group…' : 'Starting conversation…'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
