'use client';

/**
 * @module apps/web/src/app/(main)/chat/layout.tsx
 *
 * Chat Layout — Responsive dual-panel layout for the Chat feature.
 *
 * Implements the AAP §0.1.3 responsive strategy:
 * - Desktop (≥1280px): Side-by-side panels — chat list on the left (375px),
 *   conversation view (or placeholder) on the right.
 * - Tablet (768–1279px): Collapsible sidebar — chat list rendered at 375px
 *   with remaining space for conversation, or full-width list when no
 *   conversation is active.
 * - Mobile (≤767px): Stack navigation — children rendered full-width; the
 *   parent page.tsx and [id]/page.tsx handle push/pop per R15.
 *
 * This layout wraps both `chat/page.tsx` (the list) and `chat/[id]/page.tsx`
 * (the conversation view). On desktop/tablet, it renders a persistent sidebar
 * with a lightweight version of the conversation list from Zustand, while
 * `children` occupies the main content area.
 *
 * Figma Screens:
 * - Screen 1: WhatsApp Chats (node 0:8855) — list panel
 * - Screen 4: WhatsApp Chat (node 0:8257) — conversation panel
 *
 * Rules enforced:
 * - R3  Responsive breakpoints (375 / 768 / 1280)
 * - R15 Mobile stack navigation — no side-by-side at ≤767px
 * - R34 WCAG 2.1 AA — landmarks, keyboard navigation
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import { useResponsive } from '@/hooks/useResponsive';
import { useChatStore } from '@/stores/chatStore';
import { useAuthStore } from '@/stores/authStore';

/* ── Inline avatar component for sidebar (avoids circular dep) ─────── */
function SidebarAvatar({ src, name }: { src?: string; name: string }) {
  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="w-[52px] h-[52px] rounded-full bg-gray-300 flex-shrink-0 overflow-hidden flex items-center justify-center">
      {src ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={src}
          alt={name}
          className="w-full h-full object-cover"
          loading="lazy"
        />
      ) : (
        <span className="text-white text-sm font-semibold" aria-hidden="true">
          {initials}
        </span>
      )}
    </div>
  );
}

/**
 * Chat Layout — provides responsive dual-panel structure.
 *
 * On desktop/tablet the sidebar persists while children swap between
 * the list page and conversation pages. On mobile, only children are
 * rendered to preserve stack navigation (R15).
 */
export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isMobile, isDesktop } = useResponsive();
  const pathname = usePathname();
  const router = useRouter();

  /* ── Store selectors ─────────────────────────────────────────────── */
  const conversations = useChatStore((s) => s.conversations);
  const accessToken = useAuthStore((s) => s.accessToken);

  /* ── State for sidebar conversations ─────────────────────────────── */
  const [sidebarConversations, setSidebarConversations] = useState(conversations);

  // Keep sidebar in sync with store
  useEffect(() => {
    setSidebarConversations(conversations);
  }, [conversations]);

  /* ── Fetch conversations for sidebar if store is empty ────────────── */
  useEffect(() => {
    if (sidebarConversations.length > 0 || isMobile) return;

    const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    const token = accessToken || useAuthStore.getState().getAccessToken();
    if (!token) return;

    const fetchForSidebar = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/conversations`, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          const items = data.data ?? [];
          if (items.length > 0) {
            useChatStore.getState().setConversations(items);
          }
        }
      } catch {
        // Sidebar fetch failure is non-critical — page.tsx handles the error state
      }
    };

    fetchForSidebar();
  }, [sidebarConversations.length, isMobile, accessToken]);

  /* ── Derived state ───────────────────────────────────────────────── */

  /** Whether we're viewing a specific conversation (vs the list). */
  const isConversationActive = useMemo(
    () => pathname.startsWith('/chat/') && pathname !== '/chat',
    [pathname],
  );

  /** Active conversation ID from the URL, if any. */
  const activeConversationId = useMemo(() => {
    if (!isConversationActive) return null;
    const segments = pathname.split('/');
    return segments[2] ?? null;
  }, [pathname, isConversationActive]);

  /** Visible (non-archived) conversations for the sidebar. */
  const visibleConversations = useMemo(
    () => sidebarConversations.filter((c) => !c.isArchived),
    [sidebarConversations],
  );

  /* ── Handlers ────────────────────────────────────────────────────── */

  const handleConversationClick = useCallback(
    (conversationId: string) => {
      router.push(`/chat/${conversationId}`);
    },
    [router],
  );

  /* ── Mobile: pass-through — no sidebar ───────────────────────────── */
  if (isMobile) {
    return <>{children}</>;
  }

  /* ── Desktop & Tablet: side-by-side layout ───────────────────────── */
  const sidebarWidth = isDesktop ? 'w-[375px]' : 'w-[320px]';

  return (
    <div className="flex h-full overflow-hidden" role="presentation">
      {/* ── Left Panel: Conversation Sidebar ───────────────────────── */}
      <aside
        className={`${sidebarWidth} flex-shrink-0 border-r border-separator bg-white overflow-y-auto`}
        aria-label="Conversation list"
      >
        {/* Sidebar header */}
        <div className="px-4 py-3 bg-nav shadow-nav border-b border-separator">
          <h2 className="text-[17px] font-semibold leading-[1.29em] text-black text-center">
            Chats
          </h2>
        </div>

        {/* Conversation list */}
        <nav aria-label="Conversations">
          <ul className="divide-y divide-separator">
            {visibleConversations.length === 0 ? (
              <li className="px-4 py-8 text-center text-secondary text-sm">
                No conversations yet.
              </li>
            ) : (
              visibleConversations.map((convo) => {
                const isActive = convo.id === activeConversationId;
                const lastMsg = convo.lastMessage;
                const preview = lastMsg?.isDeleted
                  ? 'This message was deleted'
                  : lastMsg?.ciphertext ?? '';
                const date = lastMsg?.serverTimestamp
                  ? new Date(lastMsg.serverTimestamp).toLocaleDateString([], {
                      month: 'short',
                      day: 'numeric',
                    })
                  : '';

                return (
                  <li key={convo.id}>
                    <button
                      type="button"
                      className={`w-full flex items-center gap-3 px-4 py-[11px] h-[74px] text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios ${
                        isActive
                          ? 'bg-blue-50'
                          : 'hover:bg-gray-50 active:bg-gray-100'
                      }`}
                      onClick={() => handleConversationClick(convo.id)}
                      aria-current={isActive ? 'page' : undefined}
                      aria-label={`Conversation with ${convo.displayName}${convo.unreadCount > 0 ? `, ${convo.unreadCount} unread` : ''}`}
                    >
                      {/* Avatar */}
                      <SidebarAvatar
                        src={convo.avatar}
                        name={convo.displayName}
                      />

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-base font-semibold leading-[1.31em] text-black truncate">
                            {convo.displayName}
                          </span>
                          <span className="text-sm text-secondary ml-2 flex-shrink-0">
                            {date}
                          </span>
                        </div>
                        <p className="text-sm text-secondary truncate mt-0.5">
                          {preview || '\u00A0'}
                        </p>
                      </div>

                      {/* Unread badge */}
                      {convo.unreadCount > 0 && (
                        <span
                          className="bg-whatsapp-green text-white text-xs rounded-full w-5 h-5 flex items-center justify-center flex-shrink-0"
                          aria-label={`${convo.unreadCount} unread messages`}
                        >
                          {convo.unreadCount}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </nav>
      </aside>

      {/* ── Right Panel: Active Content ────────────────────────────── */}
      <div
        className="flex-1 min-w-0 overflow-hidden"
        role="region"
        aria-label="Conversation content"
      >
        {isConversationActive ? (
          children
        ) : (
          /* Placeholder when no conversation is selected */
          <div className="flex flex-col items-center justify-center h-full bg-surface text-secondary">
            <svg
              className="w-16 h-16 mb-4 opacity-40"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            <p className="text-lg font-medium">Select a conversation</p>
            <p className="text-sm mt-1">
              Choose a chat from the sidebar to start messaging
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
