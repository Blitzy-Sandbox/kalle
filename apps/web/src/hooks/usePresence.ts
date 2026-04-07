/**
 * @module usePresence
 *
 * Custom React hook for online/offline presence state and typing indicator
 * management. Subscribes to Zustand presence store for reactive state and
 * emits typing WebSocket events with 3-second client-side debounce per
 * conversation.
 *
 * @see AAP §0.1.1 — Online/offline/last-seen presence, typing indicators
 * @see AAP R25  — WebSocket rate limiting (typing:start max 10/min)
 */

import { useEffect, useCallback, useRef, useMemo } from 'react';
import { usePresenceStore } from '../stores/presenceStore';
import { useAuthStore } from '../stores/authStore';
import { emitEvent, isConnected } from '../lib/socket';
import type { UserPresenceInfo } from '@kalle/shared';

/* ─── Constants ────────────────────────────────────────────────────────── */

/**
 * Client-side debounce interval for typing:start events (milliseconds).
 * Matches the server-side 3-second debounce interval (AAP §0.1.1).
 * Ensures at most one typing:start emission per 3 seconds per conversation,
 * staying well within the R25 rate limit of 10 typing:start events per minute.
 */
const TYPING_DEBOUNCE_MS = 3_000;

/* ─── Types ────────────────────────────────────────────────────────────── */

/** Cross-environment timer handle type for setTimeout/clearTimeout */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Return type for the usePresence hook.
 * Provides presence query functions, typing indicator controls,
 * and conversation-specific derived state.
 */
interface UsePresenceReturn {
  /** Check if a specific user is currently online */
  isOnline: (userId: string) => boolean;

  /** Get the ISO 8601 last-seen timestamp for a user */
  getLastSeen: (userId: string) => string | undefined;

  /** Get user IDs currently typing in a conversation (excludes current user) */
  getTypingUsers: (conversationId: string) => string[];

  /**
   * Emit typing:start event with 3s debounce.
   * If conversationId is omitted, uses the hook's bound conversationId.
   */
  startTyping: (conversationId?: string) => void;

  /**
   * Emit typing:stop event and clear any active debounce timer.
   * If conversationId is omitted, uses the hook's bound conversationId.
   */
  stopTyping: (conversationId?: string) => void;

  /** Count of currently online users */
  onlineCount: number;

  /** Whether the bound contactId is currently online (false if no contactId) */
  isContactOnline: boolean;

  /** Last-seen timestamp for the bound contactId (undefined if no contactId) */
  contactLastSeen: string | undefined;

  /** User IDs typing in the bound conversationId (empty if no conversationId) */
  typingUsers: string[];
}

/* ─── Hook Implementation ──────────────────────────────────────────────── */

/**
 * Custom hook for presence subscription and typing indicator management.
 *
 * Subscribes to Zustand presence store selectors for reactive online/offline
 * state, typing indicators, and last-seen timestamps. Provides memoized query
 * functions and typing event emission with 3-second client-side debounce.
 *
 * When `conversationId` and/or `contactId` are provided, the hook also computes
 * conversation-specific derived state (isContactOnline, contactLastSeen,
 * typingUsers) via useMemo for efficient re-rendering.
 *
 * @param conversationId - Optional conversation ID for typing indicators
 *                         and derived state
 * @param contactId      - Optional contact user ID for derived online and
 *                         last-seen state
 *
 * @example
 * ```tsx
 * // Global usage — query any user/conversation
 * const { isOnline, startTyping, onlineCount } = usePresence();
 *
 * // Conversation-specific usage — derived state for a 1:1 chat
 * const {
 *   isContactOnline, contactLastSeen, typingUsers,
 *   startTyping, stopTyping
 * } = usePresence(conversationId, contactUserId);
 * ```
 */
export function usePresence(
  conversationId?: string,
  contactId?: string,
): UsePresenceReturn {
  /* ── Reactive state subscriptions from Zustand stores ─────────────── */

  const onlineUsers = usePresenceStore((state) => state.onlineUsers);
  const typingUsersMap = usePresenceStore((state) => state.typingUsers);
  const lastSeenMap = usePresenceStore((state) => state.lastSeen);
  const currentUserId = useAuthStore((state) => state.user?.id);

  /* ── Debounce timer refs ──────────────────────────────────────────── */

  /**
   * Map of conversationId → debounce timer handle.
   * Stored in a ref to persist across re-renders without triggering them.
   * Each entry represents an active debounce window: while the timer is
   * running, subsequent startTyping calls for that conversation are no-ops.
   */
  const typingDebounceRef = useRef<Map<string, TimerHandle>>(new Map());

  /* ── Typing Emission: startTyping with 3s debounce ─────────────────
   *
   * Debounce strategy:
   * - First call: emit typing:start immediately, set 3s timer
   * - Subsequent calls within 3s: silently ignored (timer is active)
   * - After 3s: timer fires, clears the map entry, next call re-emits
   *
   * This ensures at most 1 typing:start per 3s per conversation,
   * staying well within the R25 rate limit of 10/min.
   */
  const startTypingImpl = useCallback((convId: string): void => {
    if (!convId || !isConnected()) return;

    const timers = typingDebounceRef.current;

    // If debounce timer exists, we're within the 3s window — skip
    if (timers.has(convId)) return;

    // Emit typing:start with full EventMetadata (R29: correlationId + timestamp)
    emitEvent('typing:start', {
      conversationId: convId,
      correlationId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    });

    // Set debounce timer: allows next emission after TYPING_DEBOUNCE_MS
    const timer = setTimeout(() => {
      timers.delete(convId);
    }, TYPING_DEBOUNCE_MS);

    timers.set(convId, timer);
  }, []);

  /* ── Typing Emission: stopTyping (explicit stop) ───────────────────
   *
   * Called when the user clears the input, navigates away, or after
   * an inactivity period. Clears any active debounce timer and emits
   * typing:stop so the server broadcasts isTyping=false to participants.
   */
  const stopTypingImpl = useCallback((convId: string): void => {
    if (!convId || !isConnected()) return;

    // Clear active debounce timer for this conversation
    const timers = typingDebounceRef.current;
    const existingTimer = timers.get(convId);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      timers.delete(convId);
    }

    // Emit typing:stop with full EventMetadata (R29: correlationId + timestamp)
    emitEvent('typing:stop', {
      conversationId: convId,
      correlationId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    });
  }, []);

  /* ── Presence Query Functions ─────────────────────────────────────── */

  /** Check if a specific user is currently online */
  const isOnline = useCallback(
    (userId: string): boolean => {
      return onlineUsers.has(userId);
    },
    [onlineUsers],
  );

  /** Get the last-seen ISO timestamp for a user */
  const getLastSeen = useCallback(
    (userId: string): string | undefined => {
      return lastSeenMap.get(userId);
    },
    [lastSeenMap],
  );

  /**
   * Get user IDs currently typing in a conversation, excluding the
   * current user. You should not see yourself as typing.
   */
  const getTypingUsers = useCallback(
    (convId: string): string[] => {
      return (typingUsersMap.get(convId) ?? []).filter(
        (id) => id !== currentUserId,
      );
    },
    [typingUsersMap, currentUserId],
  );

  /* ── Conversation-Specific Derived State ──────────────────────────── */

  /** Whether the bound contact is currently online */
  const isContactOnline = useMemo((): boolean => {
    return contactId ? onlineUsers.has(contactId) : false;
  }, [contactId, onlineUsers]);

  /** Last-seen timestamp for the bound contact */
  const contactLastSeen = useMemo((): string | undefined => {
    return contactId ? lastSeenMap.get(contactId) : undefined;
  }, [contactId, lastSeenMap]);

  /** Users typing in the bound conversation (excludes current user) */
  const typingUsers = useMemo((): string[] => {
    if (!conversationId) return [];
    return (typingUsersMap.get(conversationId) ?? []).filter(
      (id) => id !== currentUserId,
    );
  }, [conversationId, typingUsersMap, currentUserId]);

  /* ── Cleanup on Unmount ────────────────────────────────────────────
   *
   * Clear all active debounce timers to prevent memory leaks and
   * stale timer callbacks after the component unmounts.
   */
  useEffect(() => {
    const timers = typingDebounceRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  /* ── Return ─────────────────────────────────────────────────────── */

  return {
    isOnline,
    getLastSeen,
    getTypingUsers,
    startTyping: (convId?: string) =>
      startTypingImpl(convId ?? conversationId ?? ''),
    stopTyping: (convId?: string) =>
      stopTypingImpl(convId ?? conversationId ?? ''),
    onlineCount: onlineUsers.size,
    isContactOnline,
    contactLastSeen,
    typingUsers,
  };
}

/* ─── Utility: formatLastSeen ──────────────────────────────────────────── */

/**
 * Formats an ISO 8601 last-seen timestamp into a human-readable relative
 * string. Used by ChatHeader (Figma Screen 4) to display "last seen X ago"
 * subtitle below the contact name.
 *
 * Returns an empty string for undefined, null, or invalid timestamp input.
 * Handles edge cases: future timestamps (clock skew) are treated as "just now".
 *
 * @param isoTimestamp - ISO 8601 timestamp string matching the
 *                       UserPresenceInfo.lastSeen shape from \@kalle/shared
 * @returns Human-readable relative time string:
 *   - "last seen just now" (< 1 minute or future)
 *   - "last seen Xm ago"  (1-59 minutes)
 *   - "last seen Xh ago"  (1-23 hours)
 *   - "last seen Xd ago"  (1-6 days)
 *   - "last seen MM/DD/YYYY" (7+ days, locale-formatted)
 *   - "" (undefined or invalid input)
 *
 * @example
 * ```ts
 * formatLastSeen('2026-04-05T12:00:00Z'); // "last seen 2h ago"
 * formatLastSeen(undefined);              // ""
 * formatLastSeen('invalid');              // ""
 * ```
 */
export function formatLastSeen(
  isoTimestamp: UserPresenceInfo['lastSeen'],
): string {
  if (!isoTimestamp) return '';

  const date = new Date(isoTimestamp);
  if (isNaN(date.getTime())) return '';

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  // Guard against future timestamps caused by clock skew
  if (diffMs < 0) return 'last seen just now';

  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMinutes < 1) return 'last seen just now';
  if (diffMinutes < 60) return `last seen ${diffMinutes}m ago`;
  if (diffHours < 24) return `last seen ${diffHours}h ago`;
  if (diffDays < 7) return `last seen ${diffDays}d ago`;

  return `last seen ${date.toLocaleDateString()}`;
}
