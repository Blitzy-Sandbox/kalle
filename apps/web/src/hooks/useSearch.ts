/**
 * Kalle — Client-Side Message Search Hook
 *
 * Custom React hook providing a complete client-side message search interface.
 * All search operations run exclusively against the local IndexedDB (Dexie.js)
 * — zero network calls during search. This is the primary hook used by the
 * SearchBar UI component and chat search feature.
 *
 * Enforces:
 *  - R21: Client-Side Search Only — message search operates exclusively against
 *         client-side IndexedDB index of decrypted messages. Zero search-related
 *         API calls during search.
 *  - R12: E2E Encryption Integrity — search index contains decrypted plaintext
 *         stored locally — never sent to server.
 *  - R15: Mobile Navigation Pattern — navigateToResult pushes conversation view
 *         onto the mobile nav stack via UI store.
 *  - R23: Log Hygiene — zero console.log statements.
 *
 * VERIFICATION: This module does NOT import any REST client, fetch, axios,
 * or HTTP / network module. Every search operation is purely local.
 *
 * Imported by: SearchBar component, ChatView component
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  searchMessages,
  getRecentSearchTerms,
  saveSearchTerm,
  type SearchResult,
  type SearchOptions,
} from '../lib/search';
import { useUIStore } from '../stores/uiStore';
import { useChatStore } from '../stores/chatStore';
import { db } from '../lib/db';

// =============================================================================
// Constants
// =============================================================================

/**
 * Debounce delay (ms) for search-as-you-type behaviour.
 * After the user stops typing for this duration, the search is executed
 * automatically against IndexedDB — zero network calls (R21).
 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Minimum query length required to trigger a search execution.
 * Prevents excessively broad matches that would degrade IndexedDB performance.
 */
const MIN_QUERY_LENGTH = 2;

/**
 * Default maximum number of search results per query execution.
 */
const DEFAULT_RESULT_LIMIT = 50;

/**
 * Maximum number of recent search terms loaded on mount.
 */
const RECENT_SEARCH_LIMIT = 10;

// =============================================================================
// Hook Return Interface
// =============================================================================

/**
 * Public interface returned by the useSearch hook.
 *
 * All state and actions are exposed for use by SearchBar, ChatView,
 * and any other component that needs to interact with the search feature.
 */
export interface UseSearchReturn {
  // ── Search State ─────────────────────────────────────────────────────

  /** Current search query text. Updated immediately on setQuery for responsive input display. */
  query: string;

  /** Array of search results from the most recent search execution. */
  results: SearchResult[];

  /** Whether a search is currently being executed against IndexedDB. */
  isSearching: boolean;

  /** Error message string from the most recent failed search, or null if no error. */
  error: string | null;

  /** Array of recently used search term strings, most recent first. */
  recentSearches: string[];

  // ── Actions ──────────────────────────────────────────────────────────

  /**
   * Set the search query with automatic debounced search-as-you-type.
   * Updates the query state immediately for responsive input display,
   * then triggers a search after SEARCH_DEBOUNCE_MS (300ms) of inactivity.
   */
  setQuery: (query: string) => void;

  /**
   * Execute a search immediately against IndexedDB (R21: zero network calls).
   * Optionally accepts a query override and search options for filtering.
   */
  executeSearch: (query?: string, options?: SearchOptions) => Promise<void>;

  /** Reset all search state (query, results, error) and sync with UI store. */
  clearSearch: () => void;

  /** Clear the entire recent search history from IndexedDB. */
  clearRecentSearches: () => void;

  // ── Result Navigation ────────────────────────────────────────────────

  /** Total number of results from the most recent search. */
  totalResults: number;

  /** Whether the most recent search produced any results. */
  hasResults: boolean;

  /**
   * Navigate to a specific search result's conversation and message.
   * Sets the active conversation via chatStore and pushes mobile nav (R15).
   */
  navigateToResult: (result: SearchResult) => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Client-side message search hook.
 *
 * All search operations are performed exclusively against the browser's
 * IndexedDB via Dexie.js — ZERO network calls are made at any point
 * during search, history retrieval, or result navigation (R21).
 *
 * @param conversationId - Optional conversation UUID to scope search results.
 *                         When provided, only messages from this conversation
 *                         are searched. When omitted, all conversations are searched.
 * @returns UseSearchReturn interface with state, actions, and navigation helpers
 */
export function useSearch(conversationId?: string): UseSearchReturn {
  // ── State ──────────────────────────────────────────────────────────────

  const [query, setQueryState] = useState<string>('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  /**
   * Ref holding the debounce timer ID for search-as-you-type.
   * Using ReturnType<typeof setTimeout> for cross-environment compatibility
   * (Node.js returns NodeJS.Timeout, browser returns number).
   */
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Core Search Execution (R21: IndexedDB only) ────────────────────────

  /**
   * Execute a search against the local IndexedDB — ZERO network calls (R21).
   *
   * 1. Determines the effective search query (override or current state).
   * 2. Validates minimum query length (MIN_QUERY_LENGTH = 2).
   * 3. Calls searchMessages() from lib/search.ts which queries Dexie.js only.
   * 4. Saves the search term to IndexedDB search history.
   * 5. Updates recent searches list.
   *
   * @param queryOverride - Optional query string override. Defaults to current query state.
   * @param options - Optional SearchOptions for filtering (dateFrom, dateTo, limit, offset).
   */
  const executeSearch = useCallback(
    async (queryOverride?: string, options?: SearchOptions): Promise<void> => {
      const searchQuery = (queryOverride ?? query).trim();

      // Enforce minimum query length
      if (searchQuery.length < MIN_QUERY_LENGTH) {
        setResults([]);
        setError(null);
        return;
      }

      setIsSearching(true);
      setError(null);

      try {
        // R21 CRITICAL: searchMessages() queries Dexie.js IndexedDB ONLY.
        // Zero network activity. Verified by: lib/search.ts does not import
        // any REST client, fetch, or axios — it calls db.messages.filter() exclusively.
        const searchResults = await searchMessages(searchQuery, {
          conversationId,
          limit: DEFAULT_RESULT_LIMIT,
          ...options,
        });

        setResults(searchResults);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Search failed';
        setError(message);
        setResults([]);
      } finally {
        setIsSearching(false);
      }

      // Persist the search term to IndexedDB history (non-blocking)
      try {
        await saveSearchTerm(searchQuery);

        // Refresh the recent searches list after saving
        const updatedRecent = await getRecentSearchTerms(RECENT_SEARCH_LIMIT);
        setRecentSearches(updatedRecent);
      } catch {
        // Silently handle IndexedDB write errors for search history.
        // Search history is a convenience feature — failures must not
        // disrupt the core search flow.
      }
    },
    [query, conversationId],
  );

  // ── Debounced Query Setter ─────────────────────────────────────────────

  /**
   * Set the search query with 300ms debounced auto-search.
   *
   * 1. Updates local query state immediately (responsive input display).
   * 2. Syncs with UI store for cross-component state (SearchBar ↔ ChatView).
   * 3. Clears any pending debounce timer.
   * 4. If the query is too short, clears results and returns early.
   * 5. Schedules a new debounce timer that fires executeSearch after 300ms.
   */
  const setQuery = useCallback(
    (newQuery: string): void => {
      // 1. Update local state immediately for responsive input
      setQueryState(newQuery);

      // 2. Sync with global UI store
      useUIStore.getState().setSearchQuery(newQuery);

      // 3. Clear any pending debounce timer
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      // 4. If query is empty or below minimum length, clear results
      const trimmedQuery = newQuery.trim();
      if (trimmedQuery.length < MIN_QUERY_LENGTH) {
        setResults([]);
        setError(null);
        setIsSearching(false);
        return;
      }

      // 5. Schedule debounced search execution (R21: IndexedDB only)
      debounceTimerRef.current = setTimeout(() => {
        void executeSearch(newQuery);
      }, SEARCH_DEBOUNCE_MS);
    },
    [executeSearch],
  );

  // ── Clear Search State ─────────────────────────────────────────────────

  /**
   * Reset all search state to initial values and sync with UI store.
   *
   * Clears: query, results, error, isSearching, debounce timer.
   * Syncs: useUIStore.getState().clearSearch() for cross-component reset.
   */
  const clearSearch = useCallback((): void => {
    // Clear local state
    setQueryState('');
    setResults([]);
    setIsSearching(false);
    setError(null);

    // Cancel pending debounce timer
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    // Sync with global UI store
    useUIStore.getState().clearSearch();
  }, []);

  // ── Clear Recent Search History ────────────────────────────────────────

  /**
   * Clear the entire recent search history from IndexedDB and local state.
   * Uses direct db.searchHistory.clear() for atomic table wipe.
   */
  const clearRecentSearches = useCallback((): void => {
    setRecentSearches([]);

    // Clear the IndexedDB search history table directly (non-blocking)
    void db.searchHistory.clear().catch(() => {
      // Silently handle IndexedDB errors — the UI state is already cleared.
    });
  }, []);

  // ── Result Navigation ──────────────────────────────────────────────────

  /**
   * Navigate to the conversation containing a search result.
   *
   * 1. Sets the active conversation in chatStore.
   * 2. Pushes the conversation route onto the mobile nav stack (R15).
   * 3. On mobile, this triggers push/pop stack navigation where the
   *    conversation view fully replaces the list view.
   */
  const navigateToResult = useCallback((result: SearchResult): void => {
    // Set the active conversation so the ChatView loads the correct conversation
    useChatStore.getState().setActiveConversation(result.conversationId);

    // Push the conversation route onto the mobile nav stack (R15).
    // This ensures that on ≤767px viewports, the conversation view fully
    // replaces the list view with push/pop stack navigation.
    useUIStore.getState().pushMobileNav(`/chat/${result.conversationId}`);
  }, []);

  // ── Load Recent Searches on Mount ──────────────────────────────────────

  /**
   * On mount, load recent search terms from IndexedDB.
   * This populates the "recent searches" UI before the user types anything.
   */
  useEffect(() => {
    let isMounted = true;

    const loadRecent = async (): Promise<void> => {
      try {
        const recent = await getRecentSearchTerms(RECENT_SEARCH_LIMIT);
        if (isMounted) {
          setRecentSearches(recent);
        }
      } catch {
        // Silently handle IndexedDB access errors (e.g., private browsing,
        // SSR environment). The search feature degrades gracefully —
        // recent searches simply won't be displayed.
      }
    };

    void loadRecent();

    return () => {
      isMounted = false;
    };
  }, []);

  // ── Cleanup Debounce Timer on Unmount ──────────────────────────────────

  /**
   * Ensure the debounce timer is cancelled when the hook unmounts.
   * Prevents stale state updates after component teardown.
   */
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, []);

  // ── Return Value ───────────────────────────────────────────────────────

  return {
    // State
    query,
    results,
    isSearching,
    error,
    recentSearches,

    // Actions
    setQuery,
    executeSearch,
    clearSearch,
    clearRecentSearches,

    // Result navigation
    totalResults: results.length,
    hasResults: results.length > 0,
    navigateToResult,
  };
}
