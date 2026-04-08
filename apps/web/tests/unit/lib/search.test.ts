/**
 * @file search.test.ts
 * Unit tests for the client-side full-text message search engine
 * (apps/web/src/lib/search.ts).
 *
 * Uses fake-indexeddb for real IndexedDB operations in Node.js Vitest
 * environment. All 8 suites verify:
 *
 *   1. Core full-text search with case-insensitive substring matching
 *   2. R21 enforcement — ZERO fetch / XMLHttpRequest calls during search
 *   3. Pagination (limit + offset)
 *   4. Filtering (conversationId, dateFrom, dateTo)
 *   5. Snippet generation with surrounding context and ellipsis
 *   6. Index management — indexMessage, removeMessageFromIndex, clearConversationIndex
 *   7. Edge cases — empty queries, short queries, special characters, whitespace
 *   8. Search history — saveSearchTerm, getRecentSearchTerms with deduplication
 *
 * Constraints:
 *   - TypeScript strict mode compatible (R7)
 *   - Zero console.log statements in test code
 *   - fake-indexeddb/auto MUST be the first import
 */

// MUST be the very first import — polyfills globalThis.indexedDB before
// Dexie.js initialises its database connection.
import 'fake-indexeddb/auto';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  searchMessages,
  indexMessage,
  removeMessageFromIndex,
  clearConversationIndex,
  getRecentSearchTerms,
  saveSearchTerm,
} from '@/lib/search';
import { db } from '@/lib/db';

// ---------------------------------------------------------------------------
// Test Data — pre-populated in IndexedDB before each test
// ---------------------------------------------------------------------------

const testMessages = [
  {
    id: 'msg-1',
    conversationId: 'conv-1',
    conversationName: 'Martha Craig',
    senderId: 'user-1',
    senderName: 'Martha Craig',
    content: 'Hey, have you seen the new design mockups?',
    timestamp: '2026-03-30T10:00:00Z',
    type: 'TEXT',
  },
  {
    id: 'msg-2',
    conversationId: 'conv-1',
    conversationName: 'Martha Craig',
    senderId: 'user-2',
    senderName: 'You',
    content: 'Yes! The mockups look amazing. Great work on the color palette.',
    timestamp: '2026-03-30T10:05:00Z',
    type: 'TEXT',
  },
  {
    id: 'msg-3',
    conversationId: 'conv-2',
    conversationName: 'Andrew Parker',
    senderId: 'user-3',
    senderName: 'Andrew Parker',
    content: 'Can you review the pull request I submitted?',
    timestamp: '2026-03-30T11:00:00Z',
    type: 'TEXT',
  },
  {
    id: 'msg-4',
    conversationId: 'conv-2',
    conversationName: 'Andrew Parker',
    senderId: 'user-2',
    senderName: 'You',
    content: 'Sure, I will review it this afternoon.',
    timestamp: '2026-03-30T11:30:00Z',
    type: 'TEXT',
  },
  {
    id: 'msg-5',
    conversationId: 'conv-1',
    conversationName: 'Martha Craig',
    senderId: 'user-1',
    senderName: 'Martha Craig',
    content: 'The design review meeting is scheduled for tomorrow at 3pm.',
    timestamp: '2026-03-30T14:00:00Z',
    type: 'TEXT',
  },
  {
    id: 'msg-6',
    conversationId: 'conv-3',
    conversationName: 'Design Team',
    senderId: 'user-4',
    senderName: 'Karen Castillo',
    content:
      'Design sprint starts next Monday. Everyone please prepare your mockups.',
    timestamp: '2026-03-30T15:00:00Z',
    type: 'TEXT',
  },
  {
    id: 'msg-7',
    conversationId: 'conv-1',
    conversationName: 'Martha Craig',
    senderId: 'user-2',
    senderName: 'You',
    content: 'I updated the color tokens in the Figma file.',
    timestamp: '2026-03-30T16:00:00Z',
    type: 'TEXT',
  },
];

// ---------------------------------------------------------------------------
// Global mock setup for R21 network-call verification
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
const mockXHR = vi.fn();

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Stub network globals so any accidental network call is detectable
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('XMLHttpRequest', mockXHR);

  // Clear existing data for full isolation
  await db.messages.clear();
  if (db.searchHistory) {
    await db.searchHistory.clear();
  }

  // Pre-populate test messages
  for (const msg of testMessages) {
    await db.messages.put(msg);
  }
});

afterEach(async () => {
  // Clean up data
  await db.messages.clear();
  if (db.searchHistory) {
    await db.searchHistory.clear();
  }

  // Restore all mocked globals and spies
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// =============================================================================
// Suite 1: searchMessages — Full-Text Search (R21)
// =============================================================================

describe('searchMessages', () => {
  it('should perform case-insensitive substring matching', async () => {
    // "design" appears in msg-1, msg-5 (lowercase), and msg-6 ("Design" — uppercase)
    const results = await searchMessages('design');
    expect(results.length).toBeGreaterThanOrEqual(3);

    // Upper-case query must produce the same result count
    const results2 = await searchMessages('DESIGN');
    expect(results2.length).toBe(results.length);
  });

  it('should return results with correct SearchResult shape', async () => {
    const results = await searchMessages('mockups');
    expect(results.length).toBeGreaterThanOrEqual(1);

    const result = results[0];
    expect(result).toHaveProperty('messageId');
    expect(result).toHaveProperty('conversationId');
    expect(result).toHaveProperty('conversationName');
    expect(result).toHaveProperty('senderId');
    expect(result).toHaveProperty('senderName');
    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('matchedSnippet');
    expect(result).toHaveProperty('matchIndex');
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('type');
  });

  it('should sort results by match position (earlier match = higher rank), then by recency', async () => {
    const results = await searchMessages('design');

    // Verify primary sort: matchIndex values must be non-decreasing
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].matchIndex).toBeLessThanOrEqual(
        results[i + 1].matchIndex,
      );
    }

    // Verify secondary sort: within equal matchIndex, more recent first
    for (let i = 0; i < results.length - 1; i++) {
      const current = results[i];
      const next = results[i + 1];
      if (current.matchIndex === next.matchIndex) {
        expect(
          new Date(current.timestamp).getTime(),
        ).toBeGreaterThanOrEqual(new Date(next.timestamp).getTime());
      }
    }
  });
});

// =============================================================================
// Suite 2: Zero Network Calls (R21 Enforcement)
// =============================================================================

describe('searchMessages — zero network calls (R21)', () => {
  it('should make zero fetch calls during search', async () => {
    await searchMessages('design');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should make zero XMLHttpRequest calls during search', async () => {
    await searchMessages('review');
    expect(mockXHR).not.toHaveBeenCalled();
  });

  it('should make zero network calls across multiple search operations', async () => {
    await searchMessages('design');
    await searchMessages('review');
    await searchMessages('color');
    await searchMessages('meeting');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockXHR).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Suite 3: Pagination
// =============================================================================

describe('searchMessages — pagination', () => {
  it('should respect limit option', async () => {
    // "the" appears in msg-1, msg-2, msg-3, msg-5, msg-7 → at least 5 results
    const results = await searchMessages('the', { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('should respect offset option', async () => {
    const allResults = await searchMessages('design');
    const offsetResults = await searchMessages('design', { offset: 1 });

    // Offset should skip the first result
    if (allResults.length > 1) {
      expect(offsetResults[0].messageId).toBe(allResults[1].messageId);
    }
  });

  it('should work with both limit and offset together', async () => {
    const results = await searchMessages('the', { limit: 1, offset: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// Suite 4: Filtering
// =============================================================================

describe('searchMessages — filtering', () => {
  it('should filter by conversationId when provided', async () => {
    const results = await searchMessages('design', {
      conversationId: 'conv-1',
    });

    // All results must belong to conv-1
    expect(results.length).toBeGreaterThanOrEqual(1);
    results.forEach((r) => {
      expect(r.conversationId).toBe('conv-1');
    });
  });

  it('should filter by dateFrom range', async () => {
    const cutoff = new Date('2026-03-30T12:00:00Z');
    const results = await searchMessages('design', { dateFrom: cutoff });

    // All results must have timestamp >= cutoff
    results.forEach((r) => {
      expect(new Date(r.timestamp).getTime()).toBeGreaterThanOrEqual(
        cutoff.getTime(),
      );
    });
  });

  it('should filter by dateTo range', async () => {
    const cutoff = new Date('2026-03-30T12:00:00Z');
    const results = await searchMessages('design', { dateTo: cutoff });

    results.forEach((r) => {
      expect(new Date(r.timestamp).getTime()).toBeLessThanOrEqual(
        cutoff.getTime(),
      );
    });
  });

  it('should combine conversationId and date range filters', async () => {
    const cutoff = new Date('2026-03-30T12:00:00Z');
    const results = await searchMessages('design', {
      conversationId: 'conv-1',
      dateFrom: cutoff,
    });

    results.forEach((r) => {
      expect(r.conversationId).toBe('conv-1');
      expect(new Date(r.timestamp).getTime()).toBeGreaterThanOrEqual(
        cutoff.getTime(),
      );
    });
  });
});

// =============================================================================
// Suite 5: Snippet Generation
// =============================================================================

describe('snippet generation', () => {
  it('should produce context around match with ellipsis', async () => {
    const results = await searchMessages('mockups');
    expect(results.length).toBeGreaterThanOrEqual(1);

    const snippet = results[0].matchedSnippet;
    expect(snippet).toContain('mockups');
    // Snippet must include surrounding context characters
    expect(snippet.length).toBeGreaterThan('mockups'.length);
  });

  it('should include ellipsis when snippet is truncated', async () => {
    // Insert a long message so the match is far from the start and end
    const longPrefix = 'A'.repeat(80);
    const longSuffix = 'B'.repeat(80);
    const longMsg = {
      id: 'msg-long',
      conversationId: 'conv-1',
      conversationName: 'Martha Craig',
      senderId: 'user-1',
      senderName: 'Martha Craig',
      content: `${longPrefix}target${longSuffix}`,
      timestamp: '2026-03-30T17:00:00Z',
      type: 'TEXT',
    };
    await db.messages.put(longMsg);

    const results = await searchMessages('target');
    expect(results.length).toBe(1);

    const snippet = results[0].matchedSnippet;
    // Should have leading ellipsis (match not at start)
    expect(snippet.startsWith('...')).toBe(true);
    // Should have trailing ellipsis (match not at end)
    expect(snippet.endsWith('...')).toBe(true);
    // Must still contain the query
    expect(snippet).toContain('target');
  });
});

// =============================================================================
// Suite 6: indexMessage, removeMessageFromIndex, clearConversationIndex
// =============================================================================

describe('indexMessage', () => {
  it('should store decrypted plaintext in IndexedDB for future search', async () => {
    const newMessage = {
      id: 'msg-new',
      conversationId: 'conv-1',
      conversationName: 'Martha Craig',
      senderId: 'user-1',
      senderName: 'Martha Craig',
      content: 'This is a unique new searchable message',
      timestamp: '2026-03-31T10:00:00Z',
      type: 'TEXT',
    };

    await indexMessage(newMessage);
    const results = await searchMessages('unique new searchable');
    expect(results.length).toBe(1);
    expect(results[0].messageId).toBe('msg-new');
  });

  it('should skip non-TEXT messages', async () => {
    const imageMsg = {
      id: 'msg-image',
      conversationId: 'conv-1',
      conversationName: 'Martha Craig',
      senderId: 'user-1',
      senderName: 'Martha Craig',
      content: 'image caption not indexable',
      timestamp: '2026-03-31T10:00:00Z',
      type: 'IMAGE',
    };

    await indexMessage(imageMsg);
    const results = await searchMessages('image caption not indexable');
    expect(results.length).toBe(0);
  });

  it('should skip messages with empty content', async () => {
    const emptyMsg = {
      id: 'msg-empty',
      conversationId: 'conv-1',
      conversationName: 'Martha Craig',
      senderId: 'user-1',
      senderName: 'Martha Craig',
      content: '   ',
      timestamp: '2026-03-31T10:00:00Z',
      type: 'TEXT',
    };

    await indexMessage(emptyMsg);
    // Verify no new entry was stored by querying for the whitespace content
    const stored = await db.messages.get('msg-empty');
    expect(stored).toBeUndefined();
  });
});

describe('removeMessageFromIndex', () => {
  it('should delete record from IndexedDB', async () => {
    await removeMessageFromIndex('msg-1');
    const results = await searchMessages('design mockups');
    // msg-1 should no longer appear
    const ids = results.map((r) => r.messageId);
    expect(ids).not.toContain('msg-1');
  });
});

describe('clearConversationIndex', () => {
  it('should bulk-delete all messages for a conversation', async () => {
    await clearConversationIndex('conv-1');
    const results = await searchMessages('design');
    // No results should be from conv-1
    results.forEach((r) => {
      expect(r.conversationId).not.toBe('conv-1');
    });
  });
});

// =============================================================================
// Suite 7: Edge Cases
// =============================================================================

describe('searchMessages — edge cases', () => {
  it('should return empty array for empty query', async () => {
    const results = await searchMessages('');
    expect(results).toEqual([]);
  });

  it('should return empty array for query shorter than 2 characters', async () => {
    const results = await searchMessages('a');
    expect(results).toEqual([]);
  });

  it('should handle special characters in query', async () => {
    // Must not throw even with regex-special characters
    const results = await searchMessages('design?!@#$');
    expect(Array.isArray(results)).toBe(true);
  });

  it('should return empty array for non-matching query', async () => {
    const results = await searchMessages('xyznonexistent');
    expect(results).toEqual([]);
  });

  it('should handle whitespace-only query', async () => {
    const results = await searchMessages('   ');
    expect(results).toEqual([]);
  });

  it('should handle emoji content gracefully', async () => {
    const emojiMsg = {
      id: 'msg-emoji',
      conversationId: 'conv-1',
      conversationName: 'Martha Craig',
      senderId: 'user-1',
      senderName: 'Martha Craig',
      content: 'Hello 😎 world',
      timestamp: '2026-03-31T10:00:00Z',
      type: 'TEXT',
    };
    await db.messages.put(emojiMsg);

    const results = await searchMessages('hello');
    const ids = results.map((r) => r.messageId);
    expect(ids).toContain('msg-emoji');
  });
});

// =============================================================================
// Suite 8: Search History
// =============================================================================

describe('getRecentSearchTerms and saveSearchTerm', () => {
  it('should retrieve saved search terms ordered by most recent', async () => {
    await saveSearchTerm('design');
    // Small delays ensure distinct Date.now() timestamps across calls
    await new Promise((r) => setTimeout(r, 15));
    await saveSearchTerm('review');
    await new Promise((r) => setTimeout(r, 15));
    await saveSearchTerm('meeting');

    const terms = await getRecentSearchTerms();
    expect(terms.length).toBe(3);
    expect(terms[0]).toBe('meeting'); // Most recent first
  });

  it('should deduplicate search terms (update timestamp on duplicate)', async () => {
    await saveSearchTerm('design');
    await new Promise((r) => setTimeout(r, 15));
    await saveSearchTerm('review');
    await new Promise((r) => setTimeout(r, 15));
    await saveSearchTerm('design'); // Duplicate — should update timestamp

    const terms = await getRecentSearchTerms();
    // 'design' should appear exactly once and be the most recent
    const designCount = terms.filter((t) => t === 'design').length;
    expect(designCount).toBe(1);
    expect(terms[0]).toBe('design'); // Most recent
  });

  it('should respect limit parameter', async () => {
    await saveSearchTerm('term1');
    await saveSearchTerm('term2');
    await saveSearchTerm('term3');

    const terms = await getRecentSearchTerms(2);
    expect(terms.length).toBeLessThanOrEqual(2);
  });

  it('should not save terms shorter than minimum length', async () => {
    await saveSearchTerm('a');
    const terms = await getRecentSearchTerms();
    expect(terms.length).toBe(0);
  });

  it('should normalize terms before saving (trim and lowercase)', async () => {
    await saveSearchTerm('  DESIGN  ');
    const terms = await getRecentSearchTerms();
    expect(terms.length).toBe(1);
    expect(terms[0]).toBe('design');
  });
});
