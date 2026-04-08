/**
 * Unit tests for apps/web/src/lib/db.ts — Dexie.js IndexedDB Schema and Operations
 *
 * Covers:
 *  Suite 1:  Schema initialization (10 tables)
 *  Suite 2:  Message CRUD operations
 *  Suite 3:  Conversation-scoped queries
 *  Suite 4:  Timestamp ordering
 *  Suite 5:  Contact CRUD operations
 *  Suite 6:  Encryption tables — basic CRUD
 *  Suite 7:  clearAllData utility
 *  Suite 8:  clearMessages utility
 *  Suite 9:  isDatabaseAvailable utility
 *  Suite 10: Singleton export behaviour
 *
 * Test isolation: afterEach clears all 10 tables.
 * IndexedDB polyfill: fake-indexeddb/auto (MUST be first import).
 */

// MUST be the first import — polyfills global indexedDB, IDBKeyRange, etc.
import 'fake-indexeddb/auto';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  db,
  KalleDatabase,
  clearAllData,
  clearMessages,
  isDatabaseAvailable,
} from '@/lib/db';

// ---------------------------------------------------------------------------
// Global teardown — guarantees per-test isolation across all suites
// ---------------------------------------------------------------------------

afterEach(async () => {
  await db.messages.clear();
  await db.conversations.clear();
  await db.contacts.clear();
  await db.identityKeys.clear();
  await db.preKeys.clear();
  await db.signedPreKeys.clear();
  await db.sessions.clear();
  await db.senderKeys.clear();
  await db.searchHistory.clear();
  await db.registration.clear();
});

// ---------------------------------------------------------------------------
// Suite 1 — Schema Initialization
// ---------------------------------------------------------------------------

describe('KalleDatabase schema initialization', () => {
  it('should create all 10 required tables', () => {
    expect(db.messages).toBeTruthy();
    expect(db.conversations).toBeTruthy();
    expect(db.contacts).toBeTruthy();
    expect(db.identityKeys).toBeTruthy();
    expect(db.preKeys).toBeTruthy();
    expect(db.signedPreKeys).toBeTruthy();
    expect(db.sessions).toBeTruthy();
    expect(db.senderKeys).toBeTruthy();
    expect(db.searchHistory).toBeTruthy();
    expect(db.registration).toBeTruthy();
  });

  it('should be an instance of KalleDatabase', () => {
    expect(db).toBeInstanceOf(KalleDatabase);
  });

  it('should have a database name of "kalle-db"', () => {
    expect(db.name).toBe('kalle-db');
  });

  it('should have exactly 10 tables defined', () => {
    expect(db.tables.length).toBe(10);
  });

  it('should expose messages table with correct indexes', () => {
    const schema = db.tables.find((t) => t.name === 'messages');
    expect(schema).toBeDefined();
  });

  it('should expose contacts table with displayName and email indexes', () => {
    const schema = db.tables.find((t) => t.name === 'contacts');
    expect(schema).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Message CRUD
// ---------------------------------------------------------------------------

describe('messages table — CRUD operations', () => {
  const testMessage = {
    id: 'msg-test-1',
    conversationId: 'conv-test-1',
    conversationName: 'Test Conversation',
    senderId: 'user-test-1',
    senderName: 'Test User',
    content: 'Hello, this is a test message',
    timestamp: '2026-03-30T12:00:00Z',
    type: 'TEXT',
  };

  it('should put a message and retrieve it by id', async () => {
    await db.messages.put(testMessage);
    const retrieved = await db.messages.get('msg-test-1');

    expect(retrieved).toBeDefined();
    expect(retrieved!.content).toBe('Hello, this is a test message');
    expect(retrieved!.conversationId).toBe('conv-test-1');
    expect(retrieved!.senderId).toBe('user-test-1');
    expect(retrieved!.senderName).toBe('Test User');
    expect(retrieved!.type).toBe('TEXT');
  });

  it('should update an existing message', async () => {
    await db.messages.put(testMessage);
    await db.messages.put({ ...testMessage, content: 'Updated content' });

    const retrieved = await db.messages.get('msg-test-1');
    expect(retrieved!.content).toBe('Updated content');
  });

  it('should delete a message by id', async () => {
    await db.messages.put(testMessage);
    await db.messages.delete('msg-test-1');

    const retrieved = await db.messages.get('msg-test-1');
    expect(retrieved).toBeUndefined();
  });

  it('should return undefined for non-existent message', async () => {
    const retrieved = await db.messages.get('non-existent');
    expect(retrieved).toBeUndefined();
  });

  it('should bulk-insert multiple messages', async () => {
    const messages = [
      { ...testMessage, id: 'msg-bulk-1' },
      { ...testMessage, id: 'msg-bulk-2' },
      { ...testMessage, id: 'msg-bulk-3' },
    ];
    await db.messages.bulkPut(messages);

    const count = await db.messages.count();
    expect(count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Conversation-Scoped Queries
// ---------------------------------------------------------------------------

describe('messages table — conversation-scoped queries', () => {
  beforeEach(async () => {
    await db.messages.bulkPut([
      {
        id: 'msg-a1',
        conversationId: 'conv-a',
        conversationName: 'Conv A',
        senderId: 'u1',
        senderName: 'A',
        content: 'A1',
        timestamp: '2026-03-30T10:00:00Z',
        type: 'TEXT',
      },
      {
        id: 'msg-a2',
        conversationId: 'conv-a',
        conversationName: 'Conv A',
        senderId: 'u1',
        senderName: 'A',
        content: 'A2',
        timestamp: '2026-03-30T11:00:00Z',
        type: 'TEXT',
      },
      {
        id: 'msg-b1',
        conversationId: 'conv-b',
        conversationName: 'Conv B',
        senderId: 'u2',
        senderName: 'B',
        content: 'B1',
        timestamp: '2026-03-30T10:30:00Z',
        type: 'TEXT',
      },
      {
        id: 'msg-b2',
        conversationId: 'conv-b',
        conversationName: 'Conv B',
        senderId: 'u2',
        senderName: 'B',
        content: 'B2',
        timestamp: '2026-03-30T11:30:00Z',
        type: 'TEXT',
      },
    ]);
  });

  it('should filter messages by conversationId', async () => {
    const results = await db.messages
      .where('conversationId')
      .equals('conv-a')
      .toArray();

    expect(results.length).toBe(2);
    results.forEach((r) => expect(r.conversationId).toBe('conv-a'));
  });

  it('should return different messages for different conversations', async () => {
    const convA = await db.messages
      .where('conversationId')
      .equals('conv-a')
      .toArray();
    const convB = await db.messages
      .where('conversationId')
      .equals('conv-b')
      .toArray();

    expect(convA.length).toBe(2);
    expect(convB.length).toBe(2);

    const idsA = convA.map((m) => m.id);
    const idsB = convB.map((m) => m.id);
    idsA.forEach((idA) => expect(idsB).not.toContain(idA));
  });

  it('should return empty array for non-existent conversation', async () => {
    const results = await db.messages
      .where('conversationId')
      .equals('conv-nonexistent')
      .toArray();

    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Timestamp Ordering
// ---------------------------------------------------------------------------

describe('messages table — timestamp ordering', () => {
  beforeEach(async () => {
    // Insert messages out of chronological order
    await db.messages.bulkPut([
      {
        id: 'msg-3',
        conversationId: 'c1',
        conversationName: 'C1',
        senderId: 'u1',
        senderName: 'U',
        content: 'Third',
        timestamp: '2026-03-30T12:00:00Z',
        type: 'TEXT',
      },
      {
        id: 'msg-1',
        conversationId: 'c1',
        conversationName: 'C1',
        senderId: 'u1',
        senderName: 'U',
        content: 'First',
        timestamp: '2026-03-30T10:00:00Z',
        type: 'TEXT',
      },
      {
        id: 'msg-2',
        conversationId: 'c1',
        conversationName: 'C1',
        senderId: 'u1',
        senderName: 'U',
        content: 'Second',
        timestamp: '2026-03-30T11:00:00Z',
        type: 'TEXT',
      },
    ]);
  });

  it('should sort messages by timestamp field', async () => {
    const results = await db.messages
      .where('conversationId')
      .equals('c1')
      .sortBy('timestamp');

    expect(results.length).toBe(3);
    expect(results[0].content).toBe('First');
    expect(results[1].content).toBe('Second');
    expect(results[2].content).toBe('Third');
  });

  it('should sort by timestamp globally via orderBy', async () => {
    const results = await db.messages.orderBy('timestamp').toArray();

    expect(results.length).toBe(3);
    expect(results[0].timestamp).toBe('2026-03-30T10:00:00Z');
    expect(results[2].timestamp).toBe('2026-03-30T12:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Contact Operations
// ---------------------------------------------------------------------------

describe('contacts table — CRUD operations', () => {
  const testContact = {
    id: 'contact-1',
    displayName: 'Martha Craig',
    email: 'martha@example.com',
    avatar: 'https://example.com/avatar.jpg',
    about: 'Design adds value faster than it adds cost',
    phoneNumber: '+1 202 555 0181',
    isBlocked: false,
    updatedAt: '2026-03-30T12:00:00Z',
  };

  it('should add a contact and retrieve it', async () => {
    await db.contacts.put(testContact);
    const retrieved = await db.contacts.get('contact-1');

    expect(retrieved).toBeDefined();
    expect(retrieved!.displayName).toBe('Martha Craig');
    expect(retrieved!.email).toBe('martha@example.com');
    expect(retrieved!.phoneNumber).toBe('+1 202 555 0181');
    expect(retrieved!.isBlocked).toBe(false);
  });

  it('should update a contact', async () => {
    await db.contacts.put(testContact);
    await db.contacts.put({ ...testContact, displayName: 'Martha C.' });

    const retrieved = await db.contacts.get('contact-1');
    expect(retrieved!.displayName).toBe('Martha C.');
  });

  it('should delete a contact', async () => {
    await db.contacts.put(testContact);
    await db.contacts.delete('contact-1');

    const retrieved = await db.contacts.get('contact-1');
    expect(retrieved).toBeUndefined();
  });

  it('should query contacts by displayName index', async () => {
    await db.contacts.bulkPut([
      testContact,
      {
        ...testContact,
        id: 'contact-2',
        displayName: 'Andrew Parker',
        email: 'andrew@example.com',
      },
    ]);

    const result = await db.contacts
      .where('displayName')
      .equals('Martha Craig')
      .toArray();

    expect(result.length).toBe(1);
    expect(result[0].id).toBe('contact-1');
  });

  it('should query contacts by email index', async () => {
    await db.contacts.put(testContact);

    const result = await db.contacts
      .where('email')
      .equals('martha@example.com')
      .toArray();

    expect(result.length).toBe(1);
    expect(result[0].displayName).toBe('Martha Craig');
  });

  it('should return empty array for non-existent displayName query', async () => {
    const result = await db.contacts
      .where('displayName')
      .equals('Ghost User')
      .toArray();

    expect(result.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — Encryption Tables Basic CRUD
// ---------------------------------------------------------------------------

describe('encryption tables — basic CRUD', () => {
  it('should store and retrieve identity keys', async () => {
    const key = {
      id: 'user-1.1',
      publicKey: 'base64pubkey',
      privateKey: 'base64privkey',
    };
    await db.identityKeys.put(key);

    const retrieved = await db.identityKeys.get('user-1.1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.publicKey).toBe('base64pubkey');
    expect(retrieved!.privateKey).toBe('base64privkey');
  });

  it('should store and retrieve pre-keys by keyId', async () => {
    const prekey = {
      keyId: 1,
      publicKey: 'prekey-pub-base64',
      privateKey: 'prekey-priv-base64',
    };
    await db.preKeys.put(prekey);

    const retrieved = await db.preKeys.get(1);
    expect(retrieved).toBeDefined();
    expect(retrieved!.keyId).toBe(1);
    expect(retrieved!.publicKey).toBe('prekey-pub-base64');
  });

  it('should store and retrieve signed pre-keys by keyId', async () => {
    const signedPreKey = {
      keyId: 1,
      publicKey: 'signed-pub-base64',
      privateKey: 'signed-priv-base64',
      signature: 'sig-base64',
      timestamp: Date.now(),
    };
    await db.signedPreKeys.put(signedPreKey);

    const retrieved = await db.signedPreKeys.get(1);
    expect(retrieved).toBeDefined();
    expect(retrieved!.signature).toBe('sig-base64');
  });

  it('should store and retrieve session records', async () => {
    const session = {
      id: 'user-1.1',
      record: 'serialized-session-record-base64',
    };
    await db.sessions.put(session);

    const retrieved = await db.sessions.get('user-1.1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.record).toBe('serialized-session-record-base64');
  });

  it('should store and retrieve sender keys', async () => {
    const senderKey = {
      id: 'group-1:user-1',
      record: 'serialized-sender-key-base64',
    };
    await db.senderKeys.put(senderKey);

    const retrieved = await db.senderKeys.get('group-1:user-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.record).toBe('serialized-sender-key-base64');
  });

  it('should store and retrieve registration record', async () => {
    const registration = {
      id: 'local',
      registrationId: 12345,
    };
    await db.registration.put(registration);

    const retrieved = await db.registration.get('local');
    expect(retrieved).toBeDefined();
    expect(retrieved!.registrationId).toBe(12345);
  });

  it('should delete identity keys', async () => {
    await db.identityKeys.put({
      id: 'user-2.1',
      publicKey: 'pk',
    });
    await db.identityKeys.delete('user-2.1');

    const retrieved = await db.identityKeys.get('user-2.1');
    expect(retrieved).toBeUndefined();
  });

  it('should delete pre-keys by keyId', async () => {
    await db.preKeys.put({
      keyId: 42,
      publicKey: 'pk',
      privateKey: 'sk',
    });
    await db.preKeys.delete(42);

    const retrieved = await db.preKeys.get(42);
    expect(retrieved).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — clearAllData
// ---------------------------------------------------------------------------

describe('clearAllData', () => {
  it('should clear ALL tables in single transaction (used on logout)', async () => {
    // Pre-populate every table
    await db.messages.put({
      id: 'msg-clear-1',
      conversationId: 'conv-1',
      conversationName: 'C',
      senderId: 'u1',
      senderName: 'U',
      content: 'text',
      timestamp: '2026-03-30T12:00:00Z',
      type: 'TEXT',
    });
    await db.conversations.put({
      id: 'conv-clear-1',
      type: 'DIRECT',
      displayName: 'Test',
      updatedAt: '2026-03-30T12:00:00Z',
    });
    await db.contacts.put({
      id: 'contact-clear-1',
      displayName: 'Test',
      email: 'test@test.com',
      isBlocked: false,
      updatedAt: '2026-03-30T12:00:00Z',
    });
    await db.identityKeys.put({
      id: 'local',
      publicKey: 'pk',
      privateKey: 'sk',
    });
    await db.preKeys.put({
      keyId: 1,
      publicKey: 'pk',
      privateKey: 'sk',
    });
    await db.signedPreKeys.put({
      keyId: 1,
      publicKey: 'pk',
      privateKey: 'sk',
      signature: 'sig',
      timestamp: Date.now(),
    });
    await db.sessions.put({
      id: 'session-clear-1',
      record: 'rec',
    });
    await db.senderKeys.put({
      id: 'group-1:user-1',
      record: 'rec',
    });
    await db.searchHistory.put({
      term: 'test search',
      timestamp: Date.now(),
    });
    await db.registration.put({
      id: 'local',
      registrationId: 99,
    });

    // Verify all tables have data
    expect(await db.messages.count()).toBeGreaterThan(0);
    expect(await db.conversations.count()).toBeGreaterThan(0);
    expect(await db.contacts.count()).toBeGreaterThan(0);
    expect(await db.identityKeys.count()).toBeGreaterThan(0);
    expect(await db.preKeys.count()).toBeGreaterThan(0);
    expect(await db.signedPreKeys.count()).toBeGreaterThan(0);
    expect(await db.sessions.count()).toBeGreaterThan(0);
    expect(await db.senderKeys.count()).toBeGreaterThan(0);
    expect(await db.searchHistory.count()).toBeGreaterThan(0);
    expect(await db.registration.count()).toBeGreaterThan(0);

    // Execute clearAllData
    await clearAllData();

    // Verify every table is now empty
    expect(await db.messages.count()).toBe(0);
    expect(await db.conversations.count()).toBe(0);
    expect(await db.contacts.count()).toBe(0);
    expect(await db.identityKeys.count()).toBe(0);
    expect(await db.preKeys.count()).toBe(0);
    expect(await db.signedPreKeys.count()).toBe(0);
    expect(await db.sessions.count()).toBe(0);
    expect(await db.senderKeys.count()).toBe(0);
    expect(await db.searchHistory.count()).toBe(0);
    expect(await db.registration.count()).toBe(0);
  });

  it('should be idempotent — clearing empty tables succeeds', async () => {
    // All tables are already empty from afterEach
    await expect(clearAllData()).resolves.toBeUndefined();

    expect(await db.messages.count()).toBe(0);
    expect(await db.registration.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — clearMessages
// ---------------------------------------------------------------------------

describe('clearMessages', () => {
  it('should clear only the messages table', async () => {
    await db.messages.put({
      id: 'msg-cm-1',
      conversationId: 'conv-1',
      conversationName: 'C',
      senderId: 'u1',
      senderName: 'U',
      content: 'text',
      timestamp: '2026-03-30T12:00:00Z',
      type: 'TEXT',
    });
    await db.contacts.put({
      id: 'contact-cm-1',
      displayName: 'Test',
      email: 'test@test.com',
      isBlocked: false,
      updatedAt: '2026-03-30T12:00:00Z',
    });

    await clearMessages();

    expect(await db.messages.count()).toBe(0);
    expect(await db.contacts.count()).toBeGreaterThan(0);
  });

  it('should not affect encryption tables', async () => {
    await db.messages.put({
      id: 'msg-cm-2',
      conversationId: 'conv-1',
      conversationName: 'C',
      senderId: 'u1',
      senderName: 'U',
      content: 'text',
      timestamp: '2026-03-30T12:00:00Z',
      type: 'TEXT',
    });
    await db.identityKeys.put({
      id: 'local',
      publicKey: 'pk',
      privateKey: 'sk',
    });
    await db.sessions.put({
      id: 'sess-cm-1',
      record: 'rec',
    });

    await clearMessages();

    expect(await db.messages.count()).toBe(0);
    expect(await db.identityKeys.count()).toBeGreaterThan(0);
    expect(await db.sessions.count()).toBeGreaterThan(0);
  });

  it('should not affect conversations table', async () => {
    await db.messages.put({
      id: 'msg-cm-3',
      conversationId: 'conv-1',
      conversationName: 'C',
      senderId: 'u1',
      senderName: 'U',
      content: 'text',
      timestamp: '2026-03-30T12:00:00Z',
      type: 'TEXT',
    });
    await db.conversations.put({
      id: 'conv-cm-1',
      type: 'DIRECT',
      displayName: 'Chat',
      updatedAt: '2026-03-30T12:00:00Z',
    });

    await clearMessages();

    expect(await db.messages.count()).toBe(0);
    expect(await db.conversations.count()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 9 — isDatabaseAvailable
// ---------------------------------------------------------------------------

describe('isDatabaseAvailable', () => {
  it('should return true when IndexedDB is accessible', async () => {
    const available = await isDatabaseAvailable();
    expect(available).toBe(true);
  });

  it('should return a boolean value', async () => {
    const result = await isDatabaseAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('should return false when indexedDB is undefined', async () => {
    // Temporarily remove the global indexedDB
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      const available = await isDatabaseAvailable();
      expect(available).toBe(false);
    } finally {
      // Restore the original indexedDB
      Object.defineProperty(globalThis, 'indexedDB', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 10 — Singleton Export
// ---------------------------------------------------------------------------

describe('db singleton', () => {
  it('should be the same instance across references', () => {
    const db1 = db;
    const db2 = db;
    expect(db1).toBe(db2);
  });

  it('should be an instance of KalleDatabase', () => {
    expect(db).toBeInstanceOf(KalleDatabase);
  });

  it('should be an instance of Dexie', () => {
    // KalleDatabase extends Dexie, so db should also be a Dexie instance
    expect(db).toBeInstanceOf(KalleDatabase);
    expect(db.name).toBeDefined();
    expect(typeof db.version).toBe('function');
  });
});
