/**
 * Kalle — Dexie.js IndexedDB Schema and Client
 *
 * Foundational client-side persistence layer providing:
 * - Decrypted message storage for full-text search (R21: zero search tokens sent to server)
 * - Signal Protocol encryption key material storage (R12: identity keys, pre-keys, sessions, sender keys)
 * - Local conversation and contact caches for offline-ready UI
 * - Search history for recent search term recall
 *
 * Imported by: encryption.ts, search.ts, Zustand stores
 */

import Dexie, { type Table } from 'dexie';

// ---------------------------------------------------------------------------
// Table Record Interfaces
// ---------------------------------------------------------------------------

/**
 * Decrypted message record stored in IndexedDB for client-side search (R21).
 * Content is DECRYPTED plaintext — never sent to the server.
 */
export interface DecryptedMessage {
  /** Message UUID (primary key) */
  id: string;
  /** Conversation this message belongs to (indexed for per-conversation queries) */
  conversationId: string;
  /** Display name of the conversation for search result context */
  conversationName: string;
  /** User ID of the message sender */
  senderId: string;
  /** Display name of the sender for search result rendering */
  senderName: string;
  /** DECRYPTED plaintext message content used for full-text search */
  content: string;
  /** ISO 8601 server timestamp (indexed for chronological ordering) */
  timestamp: string;
  /** Message type discriminator (e.g. 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE', 'SYSTEM') */
  type: string;
}

/**
 * Locally-cached conversation metadata for offline-ready UI rendering.
 */
export interface LocalConversation {
  /** Conversation UUID (primary key) */
  id: string;
  /** Conversation type: 'DIRECT' or 'GROUP' */
  type: string;
  /** For DIRECT: other user's name. For GROUP: group name */
  displayName: string;
  /** Avatar image URL or data URI */
  avatar?: string;
  /** ISO 8601 timestamp of the last message (indexed for sorted list display) */
  lastMessageAt?: string;
  /** ISO 8601 timestamp of last local modification */
  updatedAt: string;
}

/**
 * Locally-cached contact/user data for offline display and search.
 */
export interface LocalContact {
  /** User UUID (primary key) */
  id: string;
  /** User display name (indexed for contact search) */
  displayName: string;
  /** User email address (indexed for contact lookup) */
  email: string;
  /** Avatar image URL or data URI */
  avatar?: string;
  /** User bio / about text */
  about?: string;
  /** Phone number string */
  phoneNumber?: string;
  /** Whether this contact is blocked by the local user */
  isBlocked: boolean;
  /** ISO 8601 timestamp of last local modification */
  updatedAt: string;
}

/**
 * Signal Protocol identity key pair record (R12).
 * Stores the local identity key pair ('local') and remote identity public keys.
 */
export interface IdentityKeyRecord {
  /** 'local' for own key pair, or remote user identifier string */
  id: string;
  /** Base64-encoded public key */
  publicKey: string;
  /** Base64-encoded private key (present only for the local identity key pair) */
  privateKey?: string;
}

/**
 * Signal Protocol one-time pre-key record (R12).
 */
export interface PreKeyRecord {
  /** Pre-key sequential ID (primary key) */
  keyId: number;
  /** Base64-encoded public key */
  publicKey: string;
  /** Base64-encoded private key */
  privateKey: string;
}

/**
 * Signal Protocol signed pre-key record (R12).
 */
export interface SignedPreKeyRecord {
  /** Signed pre-key sequential ID (primary key) */
  keyId: number;
  /** Base64-encoded public key */
  publicKey: string;
  /** Base64-encoded private key */
  privateKey: string;
  /** Base64-encoded signature over the public key */
  signature: string;
  /** Unix timestamp (ms) when this signed pre-key was generated */
  timestamp: number;
}

/**
 * Signal Protocol session record (R12).
 * Stores the serialised Double Ratchet session state for a 1:1 peer.
 */
export interface SessionRecord {
  /** Address string in the form "userId.deviceId" (primary key) */
  id: string;
  /** Base64-encoded serialised session state */
  record: string;
}

/**
 * Signal Protocol Sender Key record for group encryption (R14).
 * Stores the Sender Key state for a specific group + sender pair.
 */
export interface SenderKeyRecord {
  /** Composite key "groupId:senderId" (primary key) */
  id: string;
  /** Base64-encoded serialised Sender Key state */
  record: string;
}

/**
 * Recent search term for the client-side search history UI.
 */
export interface SearchHistoryRecord {
  /** Auto-incremented primary key */
  id?: number;
  /** The search query string */
  term: string;
  /** Unix timestamp (ms) when the search was executed */
  timestamp: number;
}

/**
 * Local device Signal Protocol registration record.
 * Only one row exists (id = 'local').
 */
export interface RegistrationRecord {
  /** Always 'local' — singleton record */
  id: string;
  /** Signal Protocol registration ID for the local device */
  registrationId: number;
}

// ---------------------------------------------------------------------------
// Database Class Definition
// ---------------------------------------------------------------------------

/**
 * Typed Dexie database class for the Kalle application.
 *
 * Schema version 1 defines 10 object stores covering:
 *  - Application data: messages, conversations, contacts, searchHistory
 *  - Signal Protocol key material: identityKeys, preKeys, signedPreKeys,
 *    sessions, senderKeys, registration
 *
 * Index design rationale:
 *  - messages: `conversationId` for per-conversation queries,
 *    `timestamp` for chronological ordering. Full-text search uses
 *    `Collection.filter()` with substring matching (R21).
 *  - conversations: `lastMessageAt` for sorted conversation list.
 *  - contacts: `displayName` + `email` for user search.
 *  - Encryption stores: simple primary key lookups only.
 *  - searchHistory: auto-incremented id, indexed `term` + `timestamp`.
 */
export class KalleDatabase extends Dexie {
  /**
   * Decrypted messages for client-side full-text search (R21).
   * Primary key: id (string UUID).
   */
  messages!: Table<DecryptedMessage, string>;

  /**
   * Locally cached conversation metadata.
   * Primary key: id (string UUID).
   */
  conversations!: Table<LocalConversation, string>;

  /**
   * Locally cached contacts / user profiles.
   * Primary key: id (string UUID).
   */
  contacts!: Table<LocalContact, string>;

  /**
   * Signal Protocol identity key pairs.
   * Primary key: id (string — 'local' or remote user id).
   */
  identityKeys!: Table<IdentityKeyRecord, string>;

  /**
   * Signal Protocol one-time pre-keys.
   * Primary key: keyId (number).
   */
  preKeys!: Table<PreKeyRecord, number>;

  /**
   * Signal Protocol signed pre-keys.
   * Primary key: keyId (number).
   */
  signedPreKeys!: Table<SignedPreKeyRecord, number>;

  /**
   * Signal Protocol Double Ratchet session records.
   * Primary key: id (string — "userId.deviceId").
   */
  sessions!: Table<SessionRecord, string>;

  /**
   * Signal Protocol Sender Key records for group E2E encryption (R14).
   * Primary key: id (string — "groupId:senderId").
   */
  senderKeys!: Table<SenderKeyRecord, string>;

  /**
   * Recent search terms for the search history UI.
   * Primary key: id (auto-incremented number).
   */
  searchHistory!: Table<SearchHistoryRecord, number>;

  /**
   * Local device registration (singleton row with id = 'local').
   * Primary key: id (string).
   */
  registration!: Table<RegistrationRecord, string>;

  constructor() {
    super('kalle-db');

    this.version(1).stores({
      // Application data tables
      messages: 'id, conversationId, timestamp',
      conversations: 'id, lastMessageAt',
      contacts: 'id, displayName, email',

      // Signal Protocol key storage tables
      identityKeys: 'id',
      preKeys: 'keyId',
      signedPreKeys: 'keyId',
      sessions: 'id',
      senderKeys: 'id',

      // Search and registration
      searchHistory: '++id, term, timestamp',
      registration: 'id',
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton Database Instance
// ---------------------------------------------------------------------------

/**
 * Singleton Dexie database instance.
 *
 * Imported by `search.ts`, `encryption.ts`, and Zustand stores.
 * Dexie manages the underlying IndexedDB connection lifecycle automatically
 * (lazy open on first query, auto-close on page unload).
 */
export const db = new KalleDatabase();

// ---------------------------------------------------------------------------
// Database Utility Functions
// ---------------------------------------------------------------------------

/**
 * Clear ALL data from every table in a single atomic transaction.
 *
 * CRITICAL: This removes decrypted messages AND encryption key material.
 * Must be called on user logout to prevent key material persistence.
 */
export async function clearAllData(): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) {
      await table.clear();
    }
  });
}

/**
 * Clear the messages table only.
 *
 * Used when the user triggers "Clear All Chats" from chat settings
 * (Figma Screen 18). Does not affect encryption keys or contacts.
 */
export async function clearMessages(): Promise<void> {
  await db.messages.clear();
}

/**
 * Estimate the total IndexedDB storage size in bytes.
 *
 * Uses the Storage Manager API (`navigator.storage.estimate()`) when available.
 * Returns 0 if the API is not supported or the estimate fails.
 *
 * Used by the "Data and Storage Usage" settings screen (Figma Screen 20).
 */
export async function getDatabaseSize(): Promise<number> {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.estimate === 'function'
    ) {
      const estimate = await navigator.storage.estimate();
      return estimate.usage ?? 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Check whether IndexedDB is accessible in the current environment.
 *
 * Returns `true` if the database can be opened and queried successfully.
 * Returns `false` if IndexedDB is blocked (e.g. private browsing in some
 * browsers, or running in a non-browser environment such as SSR).
 *
 * Used for graceful degradation — the app can fall back to in-memory
 * state when IndexedDB is unavailable.
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  try {
    if (typeof indexedDB === 'undefined') {
      return false;
    }
    // Attempt to open the database and perform a read operation
    await db.open();
    // Verify we can actually read from a table (registration is the lightest)
    await db.registration.get('local');
    return true;
  } catch {
    return false;
  }
}
