/**
 * @module presenceStore.test
 *
 * Unit tests for the usePresenceStore Zustand store managing real-time
 * presence (online/offline), typing indicators with 5-second auto-expiry,
 * and last-seen timestamps.
 *
 * The tests are organised into six phases:
 *   Phase 1 — Online / Offline tracking (setOnline, setOffline)
 *   Phase 2 — Bulk presence updates (setBulkPresence)
 *   Phase 3 — Typing indicators with timer management (setTyping, clearTyping, clearAllTypingForConversation)
 *   Phase 4 — Timer cleanup (clearAll memory-leak prevention)
 *   Phase 5 — Imperative selectors (isUserOnline, getTypingUsersForConversation, getLastSeen)
 *   Phase 6 — updateLastSeen behaviour
 *
 * Timer-sensitive tests rely on vitest fake timers (vi.useFakeTimers /
 * vi.advanceTimersByTime) to deterministically verify the 5-second
 * auto-expiry behaviour defined in AAP §0.1.1.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { usePresenceStore } from '@/stores/presenceStore';
import type { UserPresenceInfo } from '@kalle/shared';
import { UserStatus } from '@kalle/shared';

// ---------------------------------------------------------------------------
// Convenience constant matching TYPING_EXPIRY_MS inside the store (5 000 ms)
// ---------------------------------------------------------------------------
const TYPING_EXPIRY_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand to get store state. */
const state = () => usePresenceStore.getState();

// ===========================================================================
// Top-level describe
// ===========================================================================

describe('presenceStore', () => {
  // -----------------------------------------------------------------------
  // Global setup / teardown
  // -----------------------------------------------------------------------

  beforeEach(() => {
    vi.useFakeTimers();
    state().clearAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =======================================================================
  // Phase 1 — Online / Offline Tracking
  // =======================================================================

  describe('Phase 1 — Online / Offline Tracking', () => {
    // ----- setOnline --------------------------------------------------

    describe('setOnline', () => {
      it('adds user ID to the onlineUsers Set', () => {
        state().setOnline('user-1');
        expect(state().onlineUsers.has('user-1')).toBe(true);

        state().setOnline('user-2');
        expect(state().onlineUsers.size).toBe(2);
        expect(state().onlineUsers.has('user-2')).toBe(true);
      });

      it('is idempotent — adding same user twice does not duplicate', () => {
        state().setOnline('user-1');
        state().setOnline('user-1');
        expect(state().onlineUsers.size).toBe(1);
      });

      it('removes lastSeen entry for the user (they are online now)', () => {
        // Establish a lastSeen entry first
        state().updateLastSeen('user-1', '2024-01-15T10:00:00Z');
        expect(state().lastSeen.has('user-1')).toBe(true);

        // Going online should remove the lastSeen entry
        state().setOnline('user-1');
        expect(state().lastSeen.has('user-1')).toBe(false);
      });
    });

    // ----- setOffline -------------------------------------------------

    describe('setOffline', () => {
      it('removes user from onlineUsers Set and sets lastSeen timestamp', () => {
        state().setOnline('user-1');
        expect(state().onlineUsers.has('user-1')).toBe(true);

        state().setOffline('user-1', '2024-01-15T10:30:00Z');
        expect(state().onlineUsers.has('user-1')).toBe(false);
        expect(state().lastSeen.get('user-1')).toBe('2024-01-15T10:30:00Z');
      });

      it('uses current ISO timestamp if no timestamp provided', () => {
        state().setOnline('user-1');
        state().setOffline('user-1');

        expect(state().onlineUsers.has('user-1')).toBe(false);

        const ts = state().lastSeen.get('user-1');
        expect(ts).toBeDefined();
        // Verify it looks like a valid ISO 8601 string
        expect(typeof ts).toBe('string');
        expect(Number.isNaN(Date.parse(ts as string))).toBe(false);
      });

      it('clears typing indicators for the user across all conversations', () => {
        // Set user-1 as typing in two conversations
        state().setTyping('conv-A', 'user-1');
        state().setTyping('conv-B', 'user-1');
        expect(state().typingUsers.get('conv-A')).toContain('user-1');
        expect(state().typingUsers.get('conv-B')).toContain('user-1');

        // Go offline
        state().setOffline('user-1', '2024-01-15T11:00:00Z');

        // Typing indicators should be gone
        const typersA = state().typingUsers.get('conv-A') ?? [];
        const typersB = state().typingUsers.get('conv-B') ?? [];
        expect(typersA).not.toContain('user-1');
        expect(typersB).not.toContain('user-1');
      });
    });
  });

  // =======================================================================
  // Phase 2 — Bulk Presence
  // =======================================================================

  describe('Phase 2 — Bulk Presence', () => {
    describe('setBulkPresence', () => {
      it('sets multiple users presence in a single update', () => {
        const presenceData: UserPresenceInfo[] = [
          { userId: 'u1', status: UserStatus.ONLINE },
          { userId: 'u2', status: UserStatus.OFFLINE, lastSeen: '2024-01-15T10:00:00Z' },
          { userId: 'u3', status: UserStatus.ONLINE },
        ];

        state().setBulkPresence(presenceData);

        // Online users
        expect(state().onlineUsers.has('u1')).toBe(true);
        expect(state().onlineUsers.has('u3')).toBe(true);
        expect(state().onlineUsers.has('u2')).toBe(false);

        // Last seen for offline user
        expect(state().lastSeen.get('u2')).toBe('2024-01-15T10:00:00Z');

        // Online users should not have lastSeen
        expect(state().lastSeen.has('u1')).toBe(false);
        expect(state().lastSeen.has('u3')).toBe(false);
      });
    });
  });

  // =======================================================================
  // Phase 3 — Typing Indicators (with Timer Management)
  // =======================================================================

  describe('Phase 3 — Typing Indicators', () => {
    // ----- setTyping --------------------------------------------------

    describe('setTyping — with 5-second auto-expiry', () => {
      it('adds user to typing list for a conversation', () => {
        state().setTyping('conv-1', 'user-1');

        const typers = state().typingUsers.get('conv-1');
        expect(typers).toBeDefined();
        expect(typers).toContain('user-1');
      });

      it('auto-expires after TYPING_EXPIRY_MS (5 000 ms)', () => {
        state().setTyping('conv-1', 'user-1');

        // User is typing immediately after call
        expect(state().typingUsers.get('conv-1')).toContain('user-1');

        // Advance timers by exactly 5 seconds
        vi.advanceTimersByTime(TYPING_EXPIRY_MS);

        // User should have been auto-cleared
        const typers = state().typingUsers.get('conv-1') ?? [];
        expect(typers).not.toContain('user-1');
      });

      it('resets the countdown on repeated calls (debounce)', () => {
        // Time 0: start typing
        state().setTyping('conv-1', 'user-1');

        // Time +3 s: still typing, reset the timer
        vi.advanceTimersByTime(3000);
        state().setTyping('conv-1', 'user-1');

        // Time +6 s total (3 s from last setTyping): still within 5 s window
        vi.advanceTimersByTime(3000);
        expect(state().typingUsers.get('conv-1')).toContain('user-1');

        // Time +8 s total (5 s from the reset at 3 s): should have expired
        vi.advanceTimersByTime(2000);
        const typers = state().typingUsers.get('conv-1') ?? [];
        expect(typers).not.toContain('user-1');
      });

      it('supports multiple users typing in the same conversation', () => {
        state().setTyping('conv-1', 'user-1');
        state().setTyping('conv-1', 'user-2');

        const typers = state().typingUsers.get('conv-1')!;
        expect(typers).toContain('user-1');
        expect(typers).toContain('user-2');
        expect(typers.length).toBe(2);
      });

      it('supports user typing in multiple conversations simultaneously', () => {
        state().setTyping('conv-1', 'user-1');
        state().setTyping('conv-2', 'user-1');

        expect(state().typingUsers.get('conv-1')).toContain('user-1');
        expect(state().typingUsers.get('conv-2')).toContain('user-1');
      });
    });

    // ----- clearTyping ------------------------------------------------

    describe('clearTyping', () => {
      it('removes user from typing list and clears timer', () => {
        state().setTyping('conv-1', 'user-1');
        expect(state().typingUsers.get('conv-1')).toContain('user-1');

        state().clearTyping('conv-1', 'user-1');

        const typers = state().typingUsers.get('conv-1') ?? [];
        expect(typers).not.toContain('user-1');

        // Advance past expiry — should not throw or re-fire
        vi.advanceTimersByTime(TYPING_EXPIRY_MS);
        // State should remain stable (no orphaned timer side-effects)
        expect(state().typingUsers.get('conv-1') ?? []).not.toContain('user-1');
      });

      it('removes conversation entry from Map when last user cleared', () => {
        state().setTyping('conv-1', 'user-1');
        state().clearTyping('conv-1', 'user-1');

        // The conversation key should be removed (or empty array)
        const typers = state().typingUsers.get('conv-1');
        expect(typers === undefined || typers.length === 0).toBe(true);
      });
    });

    // ----- clearAllTypingForConversation --------------------------------

    describe('clearAllTypingForConversation', () => {
      it('clears ALL typing indicators for a conversation', () => {
        state().setTyping('conv-1', 'user-1');
        state().setTyping('conv-1', 'user-2');
        state().setTyping('conv-1', 'user-3');

        state().clearAllTypingForConversation('conv-1');

        const typers = state().typingUsers.get('conv-1') ?? [];
        expect(typers.length).toBe(0);

        // Verify timers are cleared by advancing past expiry
        vi.advanceTimersByTime(TYPING_EXPIRY_MS * 2);
        // No side-effects from orphaned timers
        expect(state().typingUsers.get('conv-1')).toBeUndefined();
      });

      it('does not affect other conversations', () => {
        state().setTyping('conv-1', 'user-1');
        state().setTyping('conv-2', 'user-2');

        state().clearAllTypingForConversation('conv-1');

        // conv-1 should be cleared
        const typers1 = state().typingUsers.get('conv-1') ?? [];
        expect(typers1.length).toBe(0);

        // conv-2 should remain unchanged
        const typers2 = state().typingUsers.get('conv-2');
        expect(typers2).toBeDefined();
        expect(typers2).toContain('user-2');
      });
    });
  });

  // =======================================================================
  // Phase 4 — Timer Cleanup
  // =======================================================================

  describe('Phase 4 — Timer Cleanup', () => {
    describe('clearAll — timer cleanup', () => {
      it('cancels all pending typing timeouts to prevent memory leaks', () => {
        // Create multiple timers across multiple conversations
        state().setTyping('conv-1', 'user-1');
        state().setTyping('conv-1', 'user-2');
        state().setTyping('conv-2', 'user-3');
        state().setTyping('conv-3', 'user-4');
        state().setTyping('conv-3', 'user-5');

        // Also add some online users and lastSeen data
        state().setOnline('user-10');
        state().setOnline('user-11');
        state().updateLastSeen('user-20', '2024-01-15T09:00:00Z');

        // clearAll should reset everything
        state().clearAll();

        expect(state().onlineUsers.size).toBe(0);
        expect(state().typingUsers.size).toBe(0);
        expect(state().lastSeen.size).toBe(0);
        expect(state().typingTimers.size).toBe(0);

        // Advance well past any possible timer expiry — no side-effects
        vi.advanceTimersByTime(TYPING_EXPIRY_MS * 3);

        // State should still be empty (timers were properly cancelled)
        expect(state().onlineUsers.size).toBe(0);
        expect(state().typingUsers.size).toBe(0);
        expect(state().lastSeen.size).toBe(0);
        expect(state().typingTimers.size).toBe(0);
      });
    });
  });

  // =======================================================================
  // Phase 5 — Selectors
  // =======================================================================

  describe('Phase 5 — Selectors', () => {
    describe('isUserOnline', () => {
      it('returns true for online users', () => {
        state().setOnline('user-1');
        expect(state().isUserOnline('user-1')).toBe(true);
      });

      it('returns false for untracked users', () => {
        expect(state().isUserOnline('user-999')).toBe(false);
      });

      it('returns false after user goes offline', () => {
        state().setOnline('user-1');
        state().setOffline('user-1', '2024-01-15T10:30:00Z');
        expect(state().isUserOnline('user-1')).toBe(false);
      });
    });

    describe('getTypingUsersForConversation', () => {
      it('returns user ID array for conversations with typing users', () => {
        state().setTyping('conv-1', 'user-1');
        state().setTyping('conv-1', 'user-2');

        const result = state().getTypingUsersForConversation('conv-1');
        expect(result).toEqual(expect.arrayContaining(['user-1', 'user-2']));
        expect(result.length).toBe(2);
      });

      it('returns empty array for unknown conversation', () => {
        const result = state().getTypingUsersForConversation('conv-999');
        expect(result).toEqual([]);
      });
    });

    describe('getLastSeen', () => {
      it('returns ISO 8601 timestamp for offline users', () => {
        state().setOffline('user-1', '2024-01-15T10:30:00Z');
        expect(state().getLastSeen('user-1')).toBe('2024-01-15T10:30:00Z');
      });

      it('returns undefined for unknown users', () => {
        expect(state().getLastSeen('user-999')).toBeUndefined();
      });
    });
  });

  // =======================================================================
  // Phase 6 — updateLastSeen
  // =======================================================================

  describe('Phase 6 — updateLastSeen', () => {
    describe('updateLastSeen', () => {
      it('does not update lastSeen if user is currently online', () => {
        state().setOnline('user-1');
        state().updateLastSeen('user-1', '2024-01-15T12:00:00Z');

        // Online users should not have a lastSeen entry
        expect(state().lastSeen.has('user-1')).toBe(false);
      });

      it('updates lastSeen for offline users', () => {
        // user-2 is not online — updateLastSeen should work
        state().updateLastSeen('user-2', '2024-01-15T12:00:00Z');
        expect(state().lastSeen.get('user-2')).toBe('2024-01-15T12:00:00Z');
      });

      it('overwrites existing lastSeen for the same user', () => {
        state().updateLastSeen('user-3', '2024-01-15T09:00:00Z');
        state().updateLastSeen('user-3', '2024-01-15T14:00:00Z');
        expect(state().lastSeen.get('user-3')).toBe('2024-01-15T14:00:00Z');
      });
    });
  });
});
