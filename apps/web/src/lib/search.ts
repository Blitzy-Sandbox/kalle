/**
 * Kalle — Client-Side Full-Text Message Search Engine
 *
 * Provides client-side full-text message search exclusively against IndexedDB
 * via Dexie.js. Every search operation runs locally against decrypted messages
 * stored in the browser's IndexedDB — ZERO network calls are made at any point
 * during search, indexing, or history operations.
 *
 * Enforces:
 *  - R21: Message search operates exclusively against client-side IndexedDB
 *         index of decrypted messages. Zero search-related API calls during search.
 *  - R12: E2E encryption integrity — search operates on decrypted content stored
 *         locally after Signal Protocol decryption.
 *  - R20: Tombstone handling — deleted messages are removed from the search index.
 *
 * Features:
 *  - Case-insensitive substring matching against decrypted message content
 *  - Results ranked by match position (earlier match = higher relevance) then recency
 *  - Contextual snippet generation with configurable surrounding character length
 *  - Optional per-conversation and date range filtering
 *  - Pagination support via limit and offset
 *  - Recent search term history with deduplication
 *
 * Imported by: useSearch hook, SearchBar component, ChatView component
 */

import { db } from './db';
import type { MessageType } from '@kalle/shared';

// =============================================================================
// Interfaces
// =============================================================================

/**
 * Represents a single search result with full conversation context.
 *
 * Provides all information needed to render a search result row in the UI:
 * message content, matched snippet with context, sender and conversation names,
 * and the original message timestamp.
 */
export interface SearchResult {
  /** UUID of the matched message */
  messageId: string;
  /** UUID of the conversation containing the matched message */
  conversationId: string;
  /** Display name of the conversation (group name or contact name) */
  conversationName: string;
  /** UUID of the message sender */
  senderId: string;
  /** Display name of the message sender */
  senderName: string;
  /** Full decrypted plaintext content of the matched message */
  content: string;
  /** Content excerpt with surrounding context around the first match */
  matchedSnippet: string;
  /** Character index of the first query occurrence within content */
  matchIndex: number;
  /** ISO 8601 server timestamp of the message */
  timestamp: string;
  /** MessageType enum value (e.g. 'TEXT', 'IMAGE', 'DOCUMENT') */
  type: string;
}

/**
 * Options for filtering and paginating search results.
 *
 * All fields are optional. Defaults: limit = 50, offset = 0.
 */
export interface SearchOptions {
  /** Restrict search to a specific conversation by UUID */
  conversationId?: string;
  /** Maximum number of results to return (default: 50) */
  limit?: number;
  /** Number of results to skip for pagination (default: 0) */
  offset?: number;
  /** Include only messages sent on or after this date */
  dateFrom?: Date;
  /** Include only messages sent on or before this date */
  dateTo?: Date;
}

// =============================================================================
// Constants
// =============================================================================

/** Minimum query length to prevent excessively broad results */
const MIN_QUERY_LENGTH = 2;

/** Default number of results per search page */
const DEFAULT_LIMIT = 50;

/** Default pagination offset */
const DEFAULT_OFFSET = 0;

/** Number of characters to show before and after the match in a snippet */
const SNIPPET_CONTEXT_LENGTH = 40;

// =============================================================================
// Core Search Function
// =============================================================================

/**
 * Perform a full-text search against decrypted messages stored in IndexedDB.
 *
 * CRITICAL: This function makes ZERO network calls. All operations execute
 * entirely within the browser's IndexedDB via Dexie.js (R21).
 *
 * Algorithm:
 *  1. Normalize the query (trim, lowercase)
 *  2. Apply optional filters (conversationId, date range)
 *  3. Case-insensitive substring match via `Collection.filter()`
 *  4. Sort by relevance (match position ascending) then recency (timestamp descending)
 *  5. Apply pagination (offset + limit)
 *  6. Map to SearchResult with contextual snippets
 *
 * @param query - The search query string (minimum 2 characters after trimming)
 * @param options - Optional filters and pagination settings
 * @returns Array of SearchResult objects sorted by relevance, then recency
 */
export async function searchMessages(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  // Sanitize and normalize the query
  const normalizedQuery = query.trim().toLowerCase();

  // Return empty results for queries that are too short
  if (normalizedQuery.length < MIN_QUERY_LENGTH) {
    return [];
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? DEFAULT_OFFSET;

  // Build the Dexie collection with optional conversation filter
  const collection = options.conversationId
    ? db.messages.where('conversationId').equals(options.conversationId)
    : db.messages.toCollection();

  // Apply date range filters and content substring match
  const dateFromISO = options.dateFrom ? options.dateFrom.toISOString() : null;
  const dateToISO = options.dateTo ? options.dateTo.toISOString() : null;

  const filtered = collection.filter((msg) => {
    // Date range filtering
    if (dateFromISO && msg.timestamp < dateFromISO) {
      return false;
    }
    if (dateToISO && msg.timestamp > dateToISO) {
      return false;
    }

    // Content must exist and be non-empty
    if (!msg.content) {
      return false;
    }

    // Case-insensitive substring matching — runs entirely client-side (R21)
    return msg.content.toLowerCase().includes(normalizedQuery);
  });

  // Materialize all matching records from IndexedDB
  const matchedMessages = await filtered.toArray();

  // Compute match index for each result and sort by relevance
  const scored = matchedMessages.map((msg) => {
    const matchIndex = msg.content.toLowerCase().indexOf(normalizedQuery);
    return { msg, matchIndex };
  });

  // Sort: primary by match position (earlier = more relevant),
  //        secondary by timestamp descending (more recent first)
  scored.sort((a, b) => {
    const positionDiff = a.matchIndex - b.matchIndex;
    if (positionDiff !== 0) {
      return positionDiff;
    }
    // More recent first — descending timestamp order
    return b.msg.timestamp.localeCompare(a.msg.timestamp);
  });

  // Apply pagination
  const paginated = scored.slice(offset, offset + limit);

  // Map to SearchResult objects with contextual snippets
  return paginated.map(({ msg, matchIndex }) => ({
    messageId: msg.id,
    conversationId: msg.conversationId,
    conversationName: msg.conversationName,
    senderId: msg.senderId,
    senderName: msg.senderName,
    content: msg.content,
    matchedSnippet: generateSnippet(msg.content, normalizedQuery, SNIPPET_CONTEXT_LENGTH),
    matchIndex,
    timestamp: msg.timestamp,
    type: msg.type,
  }));
}

// =============================================================================
// Snippet Generator
// =============================================================================

/**
 * Generate a contextual text snippet around the first occurrence of a query
 * within the content string.
 *
 * Extracts a substring centered on the match with `contextLength` characters
 * of surrounding context on each side. Prepends '...' when truncated from the
 * start and appends '...' when truncated from the end.
 *
 * @param content - The full message content
 * @param query - The lowercased search query
 * @param contextLength - Number of characters to include before and after the match
 * @returns A snippet string with ellipsis indicators for truncation
 */
function generateSnippet(
  content: string,
  query: string,
  contextLength: number = SNIPPET_CONTEXT_LENGTH
): string {
  const lowerContent = content.toLowerCase();
  const matchIdx = lowerContent.indexOf(query);

  // Defensive: if no match found (should not happen in normal flow), return truncated content
  if (matchIdx === -1) {
    const maxLen = contextLength * 2 + query.length;
    if (content.length <= maxLen) {
      return content;
    }
    return content.slice(0, maxLen) + '...';
  }

  const start = Math.max(0, matchIdx - contextLength);
  const end = Math.min(content.length, matchIdx + query.length + contextLength);

  let snippet = content.slice(start, end);

  // Add ellipsis indicators for truncation
  if (start > 0) {
    snippet = '...' + snippet;
  }
  if (end < content.length) {
    snippet = snippet + '...';
  }

  return snippet;
}

// =============================================================================
// Index Management Functions
// =============================================================================

/**
 * Index a decrypted message into IndexedDB for future full-text search.
 *
 * Called after the Signal Protocol decryption pipeline successfully decrypts
 * a message. Only TEXT type messages are indexed — media messages (IMAGE,
 * VIDEO, DOCUMENT, VOICE_NOTE) have no searchable text content.
 *
 * CRITICAL: This stores DECRYPTED plaintext in IndexedDB. The content is
 * never transmitted to the server — this is the foundation of R21's
 * client-side-only search architecture.
 *
 * @param message - The decrypted message data to index
 */
export async function indexMessage(message: {
  id: string;
  conversationId: string;
  conversationName: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: string;
  type: string;
}): Promise<void> {
  // Only index TEXT type messages — media messages have no searchable content
  if (message.type !== ('TEXT' as MessageType)) {
    return;
  }

  // Guard against empty or whitespace-only content
  if (!message.content || message.content.trim().length === 0) {
    return;
  }

  // Store the decrypted message in IndexedDB via Dexie
  await db.messages.put({
    id: message.id,
    conversationId: message.conversationId,
    conversationName: message.conversationName,
    senderId: message.senderId,
    senderName: message.senderName,
    content: message.content,
    timestamp: message.timestamp,
    type: message.type,
  });
}

/**
 * Remove a single message from the search index.
 *
 * Called when a message is deleted (R20: tombstone). The ciphertext is nulled
 * server-side, and the client removes the decrypted content from its local
 * search index so deleted messages no longer appear in search results.
 *
 * @param messageId - UUID of the message to remove from the index
 */
export async function removeMessageFromIndex(messageId: string): Promise<void> {
  await db.messages.delete(messageId);
}

/**
 * Remove all messages for a specific conversation from the search index.
 *
 * Used when a user clears or deletes an entire conversation. Removes all
 * indexed messages for the given conversation in a single bulk operation.
 *
 * @param conversationId - UUID of the conversation whose messages should be cleared
 */
export async function clearConversationIndex(conversationId: string): Promise<void> {
  await db.messages.where('conversationId').equals(conversationId).delete();
}

// =============================================================================
// Search History Functions
// =============================================================================

/**
 * Retrieve recently used search terms, ordered by most recent first.
 *
 * Returns deduplicated search terms from the IndexedDB `searchHistory` table.
 * The result is capped at the specified limit to prevent excessive memory usage.
 *
 * @param limit - Maximum number of recent terms to return (default: 10)
 * @returns Array of search term strings, most recent first
 */
export async function getRecentSearchTerms(limit: number = 10): Promise<string[]> {
  const records = await db.searchHistory
    .orderBy('timestamp')
    .reverse()
    .limit(limit)
    .toArray();

  return records.map((record) => record.term);
}

/**
 * Save a search term to the search history.
 *
 * Deduplicates by checking if the exact term already exists. If it does,
 * the existing record's timestamp is updated to make it the most recent.
 * If the term is new, a new record is inserted.
 *
 * Terms are normalized (trimmed and lowercased) before storage to ensure
 * consistent deduplication behavior.
 *
 * @param term - The search query string to save
 */
export async function saveSearchTerm(term: string): Promise<void> {
  const normalizedTerm = term.trim().toLowerCase();

  // Do not save terms that are too short
  if (normalizedTerm.length < MIN_QUERY_LENGTH) {
    return;
  }

  const now = Date.now();

  // Check for existing record with the same term
  const existing = await db.searchHistory
    .where('term')
    .equals(normalizedTerm)
    .first();

  if (existing && existing.id !== undefined) {
    // Update the existing record's timestamp to make it most recent
    await db.searchHistory.put({
      id: existing.id,
      term: normalizedTerm,
      timestamp: now,
    });
  } else {
    // Insert a new search history record
    await db.searchHistory.put({
      term: normalizedTerm,
      timestamp: now,
    });
  }
}
