/**
 * @module presenceStore
 *
 * Zustand store managing real-time presence (online/offline) and typing
 * indicator state for the WhatsApp clone frontend.
 *
 * Receives updates from Socket.IO `user:presence` and `typing:indicator`
 * events. Typing indicators auto-expire after 5 seconds (server-side
 * debounced at 3-second intervals with 5-second expiry per AAP §0.1.1).
 *
 * State overview:
 * - `onlineUsers`  — Set<userId> currently online
 * - `typingUsers`  — Map<conversationId, userId[]> currently typing
 * - `lastSeen`     — Map<userId, ISO-8601 timestamp>
 * - `typingTimers` — Map<timerKey, TimerHandle> (internal bookkeeping)
 *
 * Immutability strategy:
 *   Zustand detects changes via `Object.is()` reference equality.
 *   Every action that updates visible state (`onlineUsers`, `typingUsers`,
 *   `lastSeen`) creates a **new** Set/Map to trigger React re-renders.
 *   `typingTimers` is mutated in-place because it is internal bookkeeping
 *   that should never drive UI re-renders on its own.
 */

import { create } from 'zustand';
import { UserStatus } from '@kalle/shared';
import type { UserPresenceInfo } from '@kalle/shared';

// =============================================================================
// Constants
// =============================================================================

/**
 * Typing indicator auto-expiry duration in milliseconds.
 *
 * Matches the server-side typing expiry of 5 seconds per AAP §0.1.1.
 * The client-side timer guarantees the typing indicator disappears even
 * when the `typing:stop` WebSocket event is lost, the connection drops,
 * or the remote user disconnects without sending a stop event.
 */
export const TYPING_EXPIRY_MS = 5_000;

// =============================================================================
// Internal Type Aliases
// =============================================================================

/**
 * Cross-environment timer handle.
 *
 * `ReturnType<typeof setTimeout>` resolves to `number` in DOM contexts and
 * `NodeJS.Timeout` in Node contexts. Using this alias avoids an explicit
 * dependency on either global type set — consistent with the pattern
 * established in `uiStore.ts` (`toastTimerId`).
 */
type TimerHandle = ReturnType<typeof setTimeout>;

// =============================================================================
// State Interface
// =============================================================================

interface PresenceState {
  // ── Reactive State ──────────────────────────────────────────────────────

  /** Set of user IDs currently connected and active. */
  onlineUsers: Set<string>;

  /**
   * Users currently typing, grouped by conversation.
   * Map<conversationId, userId[]>
   */
  typingUsers: Map<string, string[]>;

  /**
   * Last-activity timestamps for offline users.
   * Map<userId, ISO 8601 timestamp>
   */
  lastSeen: Map<string, string>;

  // ── Internal Bookkeeping ────────────────────────────────────────────────

  /**
   * Auto-expiry timer handles keyed by `"${conversationId}:${userId}"`.
   * Mutated in-place to avoid unnecessary re-renders — consumers should
   * never subscribe to this property directly.
   */
  typingTimers: Map<string, TimerHandle>;

  // ── Actions ─────────────────────────────────────────────────────────────

  /** Mark a user as online. Removes any stale `lastSeen` entry. */
  setOnline: (userId: string) => void;

  /**
   * Mark a user as offline. Optionally accepts a server-provided
   * `lastSeenTimestamp`; falls back to the current client time.
   * Also clears any typing indicators for the user across all
   * conversations (offline users cannot be typing).
   */
  setOffline: (userId: string, lastSeenTimestamp?: string) => void;

  /**
   * Bulk-replace presence data in a single state update.
   * Used on initial load or WebSocket reconnection to hydrate presence
   * for all known users at once.
   */
  setBulkPresence: (presenceData: UserPresenceInfo[]) => void;

  /**
   * Register a user as typing in a conversation.
   * Starts (or resets) a 5-second auto-expiry timer that will
   * automatically call `clearTyping` when it fires.
   */
  setTyping: (conversationId: string, userId: string) => void;

  /**
   * Remove a single user's typing indicator from a conversation
   * and cancel the associated auto-expiry timer.
   */
  clearTyping: (conversationId: string, userId: string) => void;

  /**
   * Remove ALL typing indicators for a conversation.
   * Used when leaving or closing a conversation view.
   */
  clearAllTypingForConversation: (conversationId: string) => void;

  /**
   * Update the `lastSeen` timestamp for a user.
   * No-op if the user is currently in `onlineUsers`.
   */
  updateLastSeen: (userId: string, timestamp: string) => void;

  /** Imperative check: is the given user currently online? */
  isUserOnline: (userId: string) => boolean;

  /** Imperative getter: user IDs typing in a conversation (or `[]`). */
  getTypingUsersForConversation: (conversationId: string) => string[];

  /** Imperative getter: ISO 8601 last-seen timestamp (or `undefined`). */
  getLastSeen: (userId: string) => string | undefined;

  /**
   * Reset all presence state to empty collections and cancel every
   * pending typing timer. Called on logout.
   */
  clearAll: () => void;
}

// =============================================================================
// Store Implementation
// =============================================================================

/**
 * Zustand hook for real-time presence and typing indicator state.
 *
 * Usage in React components:
 * ```tsx
 * const isOnline = usePresenceStore(s => s.onlineUsers.has(userId));
 * const typers  = usePresenceStore(s => s.typingUsers.get(conversationId) ?? []);
 * ```
 *
 * Usage in imperative code (Socket.IO handlers, etc.):
 * ```ts
 * usePresenceStore.getState().setOnline(userId);
 * usePresenceStore.getState().setTyping(conversationId, userId);
 * ```
 */
export const usePresenceStore = create<PresenceState>((set, get) => ({
  // ── Initial State ───────────────────────────────────────────────────────

  onlineUsers: new Set<string>(),
  typingUsers: new Map<string, string[]>(),
  lastSeen: new Map<string, string>(),
  typingTimers: new Map<string, TimerHandle>(),

  // ── Presence Actions ────────────────────────────────────────────────────

  setOnline: (userId: string): void => {
    const state = get();

    const nextOnline = new Set(state.onlineUsers);
    nextOnline.add(userId);

    const nextLastSeen = new Map(state.lastSeen);
    nextLastSeen.delete(userId);

    set({ onlineUsers: nextOnline, lastSeen: nextLastSeen });
  },

  setOffline: (userId: string, lastSeenTimestamp?: string): void => {
    const state = get();

    // Remove from online set
    const nextOnline = new Set(state.onlineUsers);
    nextOnline.delete(userId);

    // Record last-seen timestamp
    const nextLastSeen = new Map(state.lastSeen);
    nextLastSeen.set(
      userId,
      lastSeenTimestamp ?? new Date().toISOString(),
    );

    // Clear typing indicators for this user across every conversation
    const nextTyping = new Map(state.typingUsers);
    const timers = state.typingTimers;
    let typingDirty = false;

    for (const [convId, userIds] of nextTyping) {
      if (userIds.includes(userId)) {
        const filtered = userIds.filter((id) => id !== userId);
        if (filtered.length === 0) {
          nextTyping.delete(convId);
        } else {
          nextTyping.set(convId, filtered);
        }

        // Cancel the associated auto-expiry timer
        const timerKey = `${convId}:${userId}`;
        const handle = timers.get(timerKey);
        if (handle !== undefined) {
          clearTimeout(handle);
          timers.delete(timerKey);
        }
        typingDirty = true;
      }
    }

    if (typingDirty) {
      set({
        onlineUsers: nextOnline,
        lastSeen: nextLastSeen,
        typingUsers: nextTyping,
      });
    } else {
      set({ onlineUsers: nextOnline, lastSeen: nextLastSeen });
    }
  },

  setBulkPresence: (presenceData: UserPresenceInfo[]): void => {
    const nextOnline = new Set<string>();
    const nextLastSeen = new Map<string, string>();

    for (const info of presenceData) {
      if (info.status === UserStatus.ONLINE) {
        nextOnline.add(info.userId);
      } else if (info.lastSeen) {
        nextLastSeen.set(info.userId, info.lastSeen);
      }
    }

    set({ onlineUsers: nextOnline, lastSeen: nextLastSeen });
  },

  // ── Typing Actions ──────────────────────────────────────────────────────

  setTyping: (conversationId: string, userId: string): void => {
    const state = get();
    const timerKey = `${conversationId}:${userId}`;
    const timers = state.typingTimers;

    // 1. Clear any existing auto-expiry timer (reset the countdown)
    const existing = timers.get(timerKey);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    // 2. Schedule a new auto-expiry timer
    const handle = setTimeout(() => {
      get().clearTyping(conversationId, userId);
    }, TYPING_EXPIRY_MS);
    timers.set(timerKey, handle);

    // 3. Add user to the conversation's typing list (if not already present)
    const currentTypers = state.typingUsers.get(conversationId) ?? [];
    if (!currentTypers.includes(userId)) {
      const nextTyping = new Map(state.typingUsers);
      nextTyping.set(conversationId, [...currentTypers, userId]);
      set({ typingUsers: nextTyping });
    }
    // If user is already in the list we only needed to reset the timer —
    // no visible state change, so we skip `set()` to avoid extra renders.
  },

  clearTyping: (conversationId: string, userId: string): void => {
    const state = get();
    const timerKey = `${conversationId}:${userId}`;
    const timers = state.typingTimers;

    // Cancel the auto-expiry timer (harmless no-op if already fired)
    const handle = timers.get(timerKey);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(timerKey);
    }

    // Remove user from the typing list
    const currentTypers = state.typingUsers.get(conversationId);
    if (currentTypers === undefined || !currentTypers.includes(userId)) {
      return; // Nothing to clear — avoid unnecessary state update
    }

    const filtered = currentTypers.filter((id) => id !== userId);
    const nextTyping = new Map(state.typingUsers);

    if (filtered.length === 0) {
      nextTyping.delete(conversationId);
    } else {
      nextTyping.set(conversationId, filtered);
    }

    set({ typingUsers: nextTyping });
  },

  clearAllTypingForConversation: (conversationId: string): void => {
    const state = get();
    const timers = state.typingTimers;

    // Cancel all auto-expiry timers for this conversation
    const currentTypers = state.typingUsers.get(conversationId);
    if (currentTypers !== undefined) {
      for (const uid of currentTypers) {
        const timerKey = `${conversationId}:${uid}`;
        const handle = timers.get(timerKey);
        if (handle !== undefined) {
          clearTimeout(handle);
          timers.delete(timerKey);
        }
      }
    }

    // Remove the entire conversation entry
    if (state.typingUsers.has(conversationId)) {
      const nextTyping = new Map(state.typingUsers);
      nextTyping.delete(conversationId);
      set({ typingUsers: nextTyping });
    }
  },

  // ── Last-Seen Action ────────────────────────────────────────────────────

  updateLastSeen: (userId: string, timestamp: string): void => {
    const state = get();

    // Online users do not need a lastSeen entry — skip silently
    if (state.onlineUsers.has(userId)) {
      return;
    }

    const nextLastSeen = new Map(state.lastSeen);
    nextLastSeen.set(userId, timestamp);
    set({ lastSeen: nextLastSeen });
  },

  // ── Imperative Getters ──────────────────────────────────────────────────

  isUserOnline: (userId: string): boolean => {
    return get().onlineUsers.has(userId);
  },

  getTypingUsersForConversation: (conversationId: string): string[] => {
    return get().typingUsers.get(conversationId) ?? [];
  },

  getLastSeen: (userId: string): string | undefined => {
    return get().lastSeen.get(userId);
  },

  // ── Full Reset ──────────────────────────────────────────────────────────

  clearAll: (): void => {
    // Cancel every pending auto-expiry timer to prevent leaks
    const timers = get().typingTimers;
    timers.forEach((handle) => clearTimeout(handle));

    set({
      onlineUsers: new Set<string>(),
      typingUsers: new Map<string, string[]>(),
      lastSeen: new Map<string, string>(),
      typingTimers: new Map<string, TimerHandle>(),
    });
  },
}));

// =============================================================================
// Derived Selectors (non-reactive — read current snapshot)
// =============================================================================

/**
 * Check if a specific user is currently online.
 * For reactive usage in components, prefer:
 *   `usePresenceStore(s => s.onlineUsers.has(userId))`
 */
export const selectIsOnline = (userId: string): boolean =>
  usePresenceStore.getState().onlineUsers.has(userId);

/**
 * Get the list of user IDs currently typing in a conversation.
 * Returns an empty array when nobody is typing.
 */
export const selectTypingUsers = (conversationId: string): string[] =>
  usePresenceStore.getState().typingUsers.get(conversationId) ?? [];

/**
 * Get the ISO 8601 last-seen timestamp for a user.
 * Returns `undefined` if no data is available.
 */
export const selectLastSeen = (userId: string): string | undefined =>
  usePresenceStore.getState().lastSeen.get(userId);

/**
 * Get the total count of currently online users.
 */
export const selectOnlineCount = (): number =>
  usePresenceStore.getState().onlineUsers.size;

// =============================================================================
// Cleanup Utility
// =============================================================================

/**
 * Cancel all pending typing-indicator auto-expiry timers.
 *
 * Call this during app teardown or before page unload to prevent
 * memory leaks from lingering `setTimeout` callbacks.
 */
export function cleanupPresenceTimers(): void {
  const timers = usePresenceStore.getState().typingTimers;
  timers.forEach((handle) => clearTimeout(handle));
}
