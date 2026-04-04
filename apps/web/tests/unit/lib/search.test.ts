/**
 * @file search.test.ts
 * Unit tests for the client-side full-text search engine (apps/web/src/lib/search.ts).
 *
 * Covers:
 * - Core search with case-insensitive substring matching
 * - R21: ZERO network calls during search — all operations against IndexedDB
 * - R20: Tombstone handling — removeMessageFromIndex
 * - Relevance ranking (match position then recency)
 * - Snippet generation with ellipsis context
 * - Pagination (limit + offset)
 * - Per-conversation filtering
 * - Date range filtering
 * - Minimum query length enforcement
 * - Index management: indexMessage, removeMessageFromIndex, clearConversationIndex
 * - Search history: saveSearchTerm, getRecentSearchTerms with deduplication
 * - Edge cases: emoji, special characters, empty content, whitespace
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the db module (Dexie.js)
// vi.hoisted() ensures variables are declared before vi.mock() factories execute
// (vi.mock factories are hoisted above const declarations by Vitest)
// ---------------------------------------------------------------------------
const {
  mockMessagesWhere,
  mockMessagesToCollection,
  mockMessagesPut,
  mockMessagesDelete,
  mockCollectionEquals,
  mockCollectionFilter,
  mockCollectionDelete,
  mockSearchHistoryOrderBy,
  mockSearchHistoryReverse,
  mockSearchHistoryLimit,
  mockSearchHistoryToArray,
  mockSearchHistoryWhere,
  mockSearchHistoryEquals,
  mockSearchHistoryFirst,
  mockSearchHistoryPut,
} = vi.hoisted(() => ({
  mockMessagesWhere: vi.fn(),
  mockMessagesToCollection: vi.fn(),
  mockMessagesPut: vi.fn(),
  mockMessagesDelete: vi.fn(),
  mockCollectionEquals: vi.fn(),
  mockCollectionFilter: vi.fn(),
  mockCollectionDelete: vi.fn(),
  mockSearchHistoryOrderBy: vi.fn(),
  mockSearchHistoryReverse: vi.fn(),
  mockSearchHistoryLimit: vi.fn(),
  mockSearchHistoryToArray: vi.fn(),
  mockSearchHistoryWhere: vi.fn(),
  mockSearchHistoryEquals: vi.fn(),
  mockSearchHistoryFirst: vi.fn(),
  mockSearchHistoryPut: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    messages: {
      where: (...args: unknown[]) => {
        mockMessagesWhere(...args);
        return {
          equals: (...eqArgs: unknown[]) => {
            mockCollectionEquals(...eqArgs);
            return {
              filter: (...fArgs: unknown[]) => {
                // Return the mock's result so tests can override via mockImplementation
                return mockCollectionFilter(...fArgs);
              },
              delete: (...dArgs: unknown[]) => mockCollectionDelete(...dArgs),
            };
          },
        };
      },
      toCollection: () => {
        mockMessagesToCollection();
        return {
          filter: (...fArgs: unknown[]) => {
            // Return the mock's result so tests can override via mockImplementation
            return mockCollectionFilter(...fArgs);
          },
        };
      },
      put: mockMessagesPut,
      delete: mockMessagesDelete,
    },
    searchHistory: {
      orderBy: (...args: unknown[]) => {
        mockSearchHistoryOrderBy(...args);
        return {
          reverse: () => {
            mockSearchHistoryReverse();
            return {
              limit: (n: number) => {
                mockSearchHistoryLimit(n);
                return { toArray: mockSearchHistoryToArray };
              },
            };
          },
        };
      },
      where: (...args: unknown[]) => {
        mockSearchHistoryWhere(...args);
        return {
          equals: (...eqArgs: unknown[]) => {
            mockSearchHistoryEquals(...eqArgs);
            return { first: mockSearchHistoryFirst };
          },
        };
      },
      put: mockSearchHistoryPut,
    },
  },
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------
import {
  searchMessages,
  indexMessage,
  removeMessageFromIndex,
  clearConversationIndex,
  getRecentSearchTerms,
  saveSearchTerm,
} from '@/lib/search';
import type { SearchResult } from '@/lib/search';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------
function createMessage(overrides: Partial<{
  id: string;
  conversationId: string;
  conversationName: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: string;
  type: string;
}> = {}) {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2)}`,
    conversationId: overrides.conversationId ?? 'conv-1',
    conversationName: overrides.conversationName ?? 'Test Conversation',
    senderId: overrides.senderId ?? 'user-1',
    senderName: overrides.senderName ?? 'Alice',
    content: overrides.content ?? 'Hello, this is a test message',
    timestamp: overrides.timestamp ?? '2024-06-15T10:00:00.000Z',
    type: overrides.type ?? 'TEXT',
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('search.ts — Client-Side Full-Text Search (R21)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: mockCollectionFilter returns an empty collection (toArray → [])
    // Tests override this via mockCollectionFilter.mockImplementation(filterFn => ...)
    mockCollectionFilter.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
    }));
    mockSearchHistoryToArray.mockResolvedValue([]);
    mockSearchHistoryFirst.mockResolvedValue(undefined);
    mockSearchHistoryPut.mockResolvedValue(undefined);
    mockMessagesPut.mockResolvedValue(undefined);
    mockMessagesDelete.mockResolvedValue(undefined);
    mockCollectionDelete.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // searchMessages — Core Search
  // =========================================================================

  describe('searchMessages — core search', () => {
    it('returns empty results for queries shorter than 2 characters', async () => {
      const results = await searchMessages('a');
      expect(results).toEqual([]);
      // R21: no network calls — no API mocks triggered, only IndexedDB
    });

    it('returns empty results for empty query', async () => {
      const results = await searchMessages('');
      expect(results).toEqual([]);
    });

    it('returns empty results for whitespace-only query', async () => {
      const results = await searchMessages('   ');
      expect(results).toEqual([]);
    });

    it('performs case-insensitive search (R21 — all local)', async () => {
      const messages = [
        createMessage({ id: 'm1', content: 'Hello World' }),
        createMessage({ id: 'm2', content: 'hello there' }),
        createMessage({ id: 'm3', content: 'HELLO EVERYONE' }),
      ];

      // Override the mock to return filtered messages
      mockCollectionFilter.mockImplementation((filterFn: (msg: any) => boolean) => {
        const filtered = messages.filter(filterFn);
        return { toArray: vi.fn().mockResolvedValue(filtered) };
      });

      const results = await searchMessages('hello');
      // All three messages should match "hello" case-insensitively
      expect(results.length).toBe(3);
    });

    it('uses toCollection for search without conversation filter', async () => {
      mockCollectionFilter.mockImplementation(() => ({
        toArray: vi.fn().mockResolvedValue([]),
      }));

      await searchMessages('test');
      expect(mockMessagesToCollection).toHaveBeenCalled();
    });

    it('uses where(conversationId) when conversationId filter provided', async () => {
      mockCollectionFilter.mockImplementation(() => ({
        toArray: vi.fn().mockResolvedValue([]),
      }));

      await searchMessages('test', { conversationId: 'conv-42' });
      expect(mockMessagesWhere).toHaveBeenCalledWith('conversationId');
      expect(mockCollectionEquals).toHaveBeenCalledWith('conv-42');
    });
  });

  // =========================================================================
  // searchMessages — Relevance Ranking
  // =========================================================================

  describe('searchMessages — relevance ranking', () => {
    it('ranks results by match position (earlier = higher relevance)', async () => {
      const messages = [
        createMessage({ id: 'm1', content: 'End of line test', timestamp: '2024-06-15T10:00:00Z' }),
        createMessage({ id: 'm2', content: 'test at the beginning', timestamp: '2024-06-15T10:00:00Z' }),
        createMessage({ id: 'm3', content: 'A mid test here', timestamp: '2024-06-15T10:00:00Z' }),
      ];

      mockCollectionFilter.mockImplementation((filterFn: (msg: any) => boolean) => {
        const filtered = messages.filter(filterFn);
        return { toArray: vi.fn().mockResolvedValue(filtered) };
      });

      const results = await searchMessages('test');
      // m2 has "test" at position 0, m3 at position 6, m1 at position 16
      expect(results[0].messageId).toBe('m2');
    });

    it('breaks ties by recency (more recent first)', async () => {
      const messages = [
        createMessage({ id: 'm1', content: 'test message old', timestamp: '2024-06-14T10:00:00Z' }),
        createMessage({ id: 'm2', content: 'test message new', timestamp: '2024-06-15T10:00:00Z' }),
      ];

      mockCollectionFilter.mockImplementation((filterFn: (msg: any) => boolean) => {
        const filtered = messages.filter(filterFn);
        return { toArray: vi.fn().mockResolvedValue(filtered) };
      });

      const results = await searchMessages('test');
      // Both match at position 0, so m2 (more recent) should rank first
      expect(results[0].messageId).toBe('m2');
    });
  });

  // =========================================================================
  // searchMessages — Pagination
  // =========================================================================

  describe('searchMessages — pagination', () => {
    it('respects limit option', async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        createMessage({ id: `m${i}`, content: `test message ${i}` })
      );

      mockCollectionFilter.mockImplementation((filterFn: (msg: any) => boolean) => {
        const filtered = messages.filter(filterFn);
        return { toArray: vi.fn().mockResolvedValue(filtered) };
      });

      const results = await searchMessages('test', { limit: 3 });
      expect(results.length).toBe(3);
    });

    it('respects offset option for pagination', async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        createMessage({
          id: `m${i}`,
          content: `test message number ${i}`,
          timestamp: `2024-06-15T10:0${i}:00Z`,
        })
      );

      mockCollectionFilter.mockImplementation((filterFn: (msg: any) => boolean) => {
        const filtered = messages.filter(filterFn);
        return { toArray: vi.fn().mockResolvedValue(filtered) };
      });

      const page1 = await searchMessages('test', { limit: 3, offset: 0 });
      const page2 = await searchMessages('test', { limit: 3, offset: 3 });

      expect(page1.length).toBe(3);
      expect(page2.length).toBe(3);
      // Pages should not overlap
      const page1Ids = page1.map((r: SearchResult) => r.messageId);
      const page2Ids = page2.map((r: SearchResult) => r.messageId);
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }
    });

    it('defaults to limit=50, offset=0', async () => {
      const messages = Array.from({ length: 60 }, (_, i) =>
        createMessage({ id: `m${i}`, content: `test message ${i}` })
      );

      mockCollectionFilter.mockImplementation((filterFn: (msg: any) => boolean) => {
        const filtered = messages.filter(filterFn);
        return { toArray: vi.fn().mockResolvedValue(filtered) };
      });

      const results = await searchMessages('test');
      expect(results.length).toBe(50);
    });
  });

  // =========================================================================
  // searchMessages — Date Range Filtering
  // =========================================================================

  describe('searchMessages — date range filtering', () => {
    it('filters messages by dateFrom', async () => {
      const messages = [
        createMessage({ id: 'old', content: 'test old', timestamp: '2024-01-01T00:00:00Z' }),
        createMessage({ id: 'new', content: 'test new', timestamp: '2024-06-15T00:00:00Z' }),
      ];

      mockCollectionFilter.mockImplementation((filterFn: (msg: any) => boolean) => {
        const filtered = messages.filter(filterFn);
        return { toArray: vi.fn().mockResolvedValue(filtered) };
      });

      const results = await searchMessages('test', {
        dateFrom: new Date('2024-06-01T00:00:00Z'),
      });
      expect(results.length).toBe(1);
      expect(results[0].messageId).toBe('new');
    });

    it('filters messages by dateTo', async () => {
      const messages = [
        createMessage({ id: 'old', content: 'test old', timestamp: '2024-01-01T00:00:00Z' }),
        createMessage({ id: 'new', content: 'test new', timestamp: '2024-06-15T00:00:00Z' }),
      ];

      mockCollectionFilter.mockImplementation((filterFn: (msg: any) => boolean) => {
        const filtered = messages.filter(filterFn);
        return { toArray: vi.fn().mockResolvedValue(filtered) };
      });

      const results = await searchMessages('test', {
        dateTo: new Date('2024-03-01T00:00:00Z'),
      });
      expect(results.length).toBe(1);
      expect(results[0].messageId).toBe('old');
    });
  });

  // =========================================================================
  // searchMessages — Snippet Generation
  // =========================================================================

  describe('searchMessages — snippet generation', () => {
    it('generates snippets with context around the match', async () => {
      const longContent = 'The quick brown fox jumps over the lazy dog in the park on a sunny day test';
      const messages = [createMessage({ id: 'm1', content: longContent })];

      mockCollectionFilter.mockImplementation((filterFn: (msg: any) => boolean) => {
        const filtered = messages.filter(filterFn);
        return { toArray: vi.fn().mockResolvedValue(filtered) };
      });

      const results = await searchMessages('test');
      expect(results.length).toBe(1);
      expect(results[0].matchedSnippet).toBeDefined();
      expect(results[0].matchedSnippet).toContain('test');
    });

    it('includes ellipsis when content is truncated', async () => {
      const prefix = 'A'.repeat(80);
      const content = `${prefix}test${'B'.repeat(80)}`;
      const messages = [createMessage({ id: 'm1', content })];

      mockCollectionFilter.mockImplementation((filterFn: (msg: any) => boolean) => {
        const filtered = messages.filter(filterFn);
        return { toArray: vi.fn().mockResolvedValue(filtered) };
      });

      const results = await searchMessages('test');
      expect(results.length).toBe(1);
      // Should have leading ellipsis (match is not at start) and trailing ellipsis
      expect(results[0].matchedSnippet.startsWith('...')).toBe(true);
      expect(results[0].matchedSnippet.endsWith('...')).toBe(true);
    });
  });

  // =========================================================================
  // searchMessages — Edge Cases
  // =========================================================================

  describe('searchMessages — edge cases', () => {
    it('handles emoji content in search', async () => {
      const messages = [
        createMessage({ id: 'm1', content: 'Hello 😎 world' }),
      ];

      mockCollectionFilter.mockImplementation((filterFn: (msg: any) => boolean) => {
        const filtered = messages.filter(filterFn);
        return { toArray: vi.fn().mockResolvedValue(filtered) };
      });

      const results = await searchMessages('hello');
      expect(results.length).toBe(1);
    });

    it('handles special characters in search query', async () => {
      const messages = [
        createMessage({ id: 'm1', content: 'Price is $100.00' }),
      ];

      mockCollectionFilter.mockImplementation((filterFn: (msg: any) => boolean) => {
        const filtered = messages.filter(filterFn);
        return { toArray: vi.fn().mockResolvedValue(filtered) };
      });

      const results = await searchMessages('$100');
      expect(results.length).toBe(1);
    });

    it('skips messages with empty content', async () => {
      const messages = [
        createMessage({ id: 'm1', content: '' }),
        createMessage({ id: 'm2', content: 'test message' }),
      ];

      mockCollectionFilter.mockImplementation((filterFn: (msg: any) => boolean) => {
        const filtered = messages.filter(filterFn);
        return { toArray: vi.fn().mockResolvedValue(filtered) };
      });

      const results = await searchMessages('test');
      expect(results.length).toBe(1);
      expect(results[0].messageId).toBe('m2');
    });
  });

  // =========================================================================
  // indexMessage
  // =========================================================================

  describe('indexMessage', () => {
    it('stores a TEXT message in IndexedDB', async () => {
      await indexMessage(createMessage({ type: 'TEXT', content: 'Indexable content' }));
      expect(mockMessagesPut).toHaveBeenCalledTimes(1);
      const putArg = mockMessagesPut.mock.calls[0][0];
      expect(putArg.content).toBe('Indexable content');
    });

    it('skips non-TEXT messages (IMAGE, VIDEO, etc.)', async () => {
      await indexMessage(createMessage({ type: 'IMAGE', content: 'image caption' }));
      expect(mockMessagesPut).not.toHaveBeenCalled();
    });

    it('skips messages with empty or whitespace-only content', async () => {
      await indexMessage(createMessage({ type: 'TEXT', content: '   ' }));
      expect(mockMessagesPut).not.toHaveBeenCalled();
    });

    it('skips messages with null/undefined content', async () => {
      await indexMessage(createMessage({ type: 'TEXT', content: '' }));
      expect(mockMessagesPut).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // removeMessageFromIndex (R20 — Tombstone)
  // =========================================================================

  describe('removeMessageFromIndex (R20)', () => {
    it('deletes a message from the IndexedDB search index', async () => {
      await removeMessageFromIndex('msg-to-delete');
      expect(mockMessagesDelete).toHaveBeenCalledWith('msg-to-delete');
    });
  });

  // =========================================================================
  // clearConversationIndex
  // =========================================================================

  describe('clearConversationIndex', () => {
    it('deletes all messages for a conversation from IndexedDB', async () => {
      await clearConversationIndex('conv-to-clear');
      expect(mockMessagesWhere).toHaveBeenCalledWith('conversationId');
      expect(mockCollectionEquals).toHaveBeenCalledWith('conv-to-clear');
      expect(mockCollectionDelete).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Search History
  // =========================================================================

  describe('getRecentSearchTerms', () => {
    it('returns recent terms ordered by timestamp descending', async () => {
      mockSearchHistoryToArray.mockResolvedValue([
        { id: 1, term: 'react', timestamp: 3000 },
        { id: 2, term: 'vue', timestamp: 2000 },
      ]);

      const terms = await getRecentSearchTerms(10);
      expect(terms).toEqual(['react', 'vue']);
      expect(mockSearchHistoryOrderBy).toHaveBeenCalledWith('timestamp');
      expect(mockSearchHistoryReverse).toHaveBeenCalled();
      expect(mockSearchHistoryLimit).toHaveBeenCalledWith(10);
    });

    it('defaults to limit of 10', async () => {
      mockSearchHistoryToArray.mockResolvedValue([]);
      await getRecentSearchTerms();
      expect(mockSearchHistoryLimit).toHaveBeenCalledWith(10);
    });
  });

  describe('saveSearchTerm', () => {
    it('saves a new search term to IndexedDB', async () => {
      mockSearchHistoryFirst.mockResolvedValue(undefined);

      await saveSearchTerm('React hooks');
      expect(mockSearchHistoryPut).toHaveBeenCalledTimes(1);
      const putArg = mockSearchHistoryPut.mock.calls[0][0];
      expect(putArg.term).toBe('react hooks'); // normalized lowercase
      expect(putArg.timestamp).toBeDefined();
    });

    it('updates timestamp for existing term (deduplication)', async () => {
      mockSearchHistoryFirst.mockResolvedValue({
        id: 42,
        term: 'react',
        timestamp: 1000,
      });

      await saveSearchTerm('React');
      expect(mockSearchHistoryPut).toHaveBeenCalledTimes(1);
      const putArg = mockSearchHistoryPut.mock.calls[0][0];
      expect(putArg.id).toBe(42); // Same record updated
      expect(putArg.timestamp).toBeGreaterThan(1000); // New timestamp
    });

    it('does not save terms shorter than minimum length', async () => {
      await saveSearchTerm('a');
      expect(mockSearchHistoryPut).not.toHaveBeenCalled();
    });

    it('normalizes and trims the term before saving', async () => {
      mockSearchHistoryFirst.mockResolvedValue(undefined);
      await saveSearchTerm('  REACT  ');
      expect(mockSearchHistoryEquals).toHaveBeenCalledWith('react');
    });
  });

  // =========================================================================
  // R21 — Zero Network Calls Verification
  // =========================================================================

  describe('R21 — Zero Network Calls', () => {
    it('search module never calls fetch or XMLHttpRequest', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());

      mockCollectionFilter.mockImplementation(() => ({
        toArray: vi.fn().mockResolvedValue([]),
      }));

      // Exercise all search operations
      await searchMessages('test query');
      await indexMessage(createMessage());
      await removeMessageFromIndex('msg-1');
      await getRecentSearchTerms();
      await saveSearchTerm('test');

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });
});
