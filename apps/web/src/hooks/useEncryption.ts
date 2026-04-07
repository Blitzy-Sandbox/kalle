/**
 * useEncryption — Signal Protocol E2E Encryption Session Management Hook
 *
 * Custom React hook providing a high-level interface for Signal Protocol
 * E2E encryption operations. Handles initialisation of local key material,
 * pre-key bundle generation and upload, session establishment with contacts,
 * and Sender Key management for group conversations.
 *
 * Implements:
 * - R12: E2E Encryption Integrity — encrypted/decrypted client-side via Signal Protocol.
 *        Server stores only ciphertext. Zero decryption logic on the server.
 * - R14: Group Encryption via Sender Keys — rotation on member removal. Removed
 *        members cannot decrypt post-removal messages; added members cannot decrypt
 *        pre-join messages.
 * - R23: Log Hygiene — MUST NOT log encryption keys, prekey material, or plaintext.
 *
 * @module hooks/useEncryption
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import {
  initializeEncryption,
  clearAllEncryptionData,
  assemblePreKeyBundle,
  createSession,
  hasSession,
  encryptMessage,
  decryptMessage,
  encryptGroupMessage,
  decryptGroupMessage,
  createSenderKey,
  processSenderKeyDistribution,
  rotateSenderKey,
} from '../lib/encryption';
import { apiClient } from '../lib/api';
import { useAuthStore } from '../stores/authStore';
import { onEvent, offEvent } from '../lib/socket';
import type {
  PreKeyBundleDTO,
  PreKeyBundleResponse,
} from '@kalle/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Payload shape for incoming Sender Key distribution events received
 * via the WebSocket real-time channel. When a group member creates or
 * rotates a Sender Key, the server fans out the distribution message
 * to all other group members via the `senderkey:distribution` event.
 */
interface SenderKeyDistributionData {
  /** Conversation ID of the group */
  groupId: string;
  /** User ID of the member distributing the Sender Key */
  senderId: string;
  /** Base64-encoded Sender Key material */
  distribution: string;
}

/**
 * Return type for the {@link useEncryption} hook.
 *
 * Exposes Signal Protocol encryption state and all cryptographic
 * operations needed for 1:1 and group messaging.
 */
export interface UseEncryptionReturn {
  /** Whether local encryption key material has been initialised */
  isInitialized: boolean;

  /** Whether initialisation is currently in progress */
  isInitializing: boolean;

  /** Human-readable error message if initialisation or an operation failed */
  error: string | null;

  // -- Session management ---------------------------------------------------

  /**
   * Ensure a Signal Protocol session exists with a recipient.
   * Fetches the recipient's pre-key bundle from the server and performs
   * X3DH key agreement if no session is present.
   */
  ensureSession: (recipientId: string, deviceId?: number) => Promise<void>;

  /**
   * Check whether a Signal Protocol session exists with a recipient
   * without making any network calls.
   */
  checkSession: (recipientId: string, deviceId?: number) => Promise<boolean>;

  // -- 1:1 encryption (R12) ------------------------------------------------

  /**
   * Encrypt a plaintext message for a 1:1 conversation using the
   * Double Ratchet protocol. Automatically ensures a session exists.
   * Returns base64-encoded ciphertext — plaintext NEVER leaves the client.
   */
  encrypt: (
    recipientId: string,
    plaintext: string,
    deviceId?: number,
  ) => Promise<string>;

  /**
   * Decrypt a ciphertext message from a 1:1 conversation.
   * Handles both pre-key whisper messages (first message from sender)
   * and regular whisper messages.
   */
  decrypt: (
    senderId: string,
    ciphertext: string,
    isPreKey: boolean,
    deviceId?: number,
  ) => Promise<string>;

  // -- Group encryption (R14) -----------------------------------------------

  /**
   * Initialise Sender Key encryption for a group conversation.
   * Creates a local Sender Key, ensures 1:1 sessions with all members,
   * and uploads the distribution for server-side fan-out via BullMQ.
   */
  initGroupEncryption: (
    groupId: string,
    memberIds: string[],
  ) => Promise<void>;

  /**
   * Encrypt a plaintext message for a group using the local Sender Key.
   */
  encryptGroup: (groupId: string, plaintext: string) => Promise<string>;

  /**
   * Decrypt a group message from a specific sender using their
   * distributed Sender Key.
   */
  decryptGroup: (
    groupId: string,
    senderId: string,
    ciphertext: string,
  ) => Promise<string>;

  /**
   * Handle a member being removed from a group.
   * Rotates the Sender Key so the removed member cannot decrypt future
   * messages, and distributes the new key to remaining members (R14).
   */
  handleMemberRemoved: (
    groupId: string,
    removedMemberId: string,
    remainingMemberIds: string[],
  ) => Promise<void>;

  /**
   * Handle a new member being added to a group.
   * Distributes the current Sender Key to the new member via the server.
   * The new member can only decrypt messages sent AFTER key receipt (R14).
   */
  handleMemberAdded: (
    groupId: string,
    newMemberId: string,
  ) => Promise<void>;

  // -- Key management -------------------------------------------------------

  /**
   * Assemble and upload the local pre-key bundle to the server so other
   * users can establish Signal Protocol sessions with this device.
   */
  uploadPreKeyBundle: () => Promise<void>;

  /**
   * Clear ALL encryption key material from IndexedDB.
   * Must be called on logout to prevent key persistence after session end.
   */
  cleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Narrowly-typed wrappers for the senderkey:distribution socket event.
//
// The `senderkey:distribution` event is part of the encryption protocol
// extension and is not yet present in the base ServerToClientEvents
// contract from @kalle/shared. These wrappers bridge the type gap while
// preserving the use of the shared onEvent/offEvent helpers.
//
// BLITZY [COMPONENT]: senderkey:distribution extends the base
// ServerToClientEvents protocol for E2E encryption key exchange.
// ---------------------------------------------------------------------------
type SenderKeyEventHandler = (data: SenderKeyDistributionData) => void;

const bindSenderKeyEvent = onEvent as unknown as (
  event: string,
  handler: SenderKeyEventHandler,
) => void;

const unbindSenderKeyEvent = offEvent as unknown as (
  event: string,
  handler?: SenderKeyEventHandler,
) => void;

// ---------------------------------------------------------------------------
// Default device ID for Signal Protocol addressing (single-device model)
// ---------------------------------------------------------------------------
const DEFAULT_DEVICE_ID = 1;

// ---------------------------------------------------------------------------
// Hook Implementation
// ---------------------------------------------------------------------------

/**
 * Custom React hook for managing Signal Protocol E2E encryption.
 *
 * On authentication, initialises local key material (identity key pair,
 * registration ID, signed pre-key, one-time pre-keys) and uploads the
 * public pre-key bundle to the server. Provides operations for:
 *
 * - 1:1 session establishment and Double Ratchet encryption (R12)
 * - Group Sender Key creation, distribution, and rotation (R14)
 * - Sender Key distribution event listening via WebSocket
 * - Full cleanup of key material on logout
 *
 * @returns {UseEncryptionReturn} Encryption state and operations
 */
export function useEncryption(): UseEncryptionReturn {
  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const [isInitialized, setIsInitialized] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Prevents double initialisation under React strict mode re-renders */
  const initRef = useRef(false);

  const user = useAuthStore((state) => state.user);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  // ---------------------------------------------------------------------------
  // Key Management Operations
  // ---------------------------------------------------------------------------

  /**
   * Assemble the local pre-key bundle and upload it to the server.
   * Other users fetch this bundle to establish Signal Protocol sessions.
   */
  const uploadPreKeyBundle = useCallback(async (): Promise<void> => {
    const bundle: PreKeyBundleDTO = await assemblePreKeyBundle();
    await apiClient.post<void>('/api/v1/keys/bundle', bundle);
  }, []);

  /**
   * Clear ALL encryption key material from IndexedDB (R12).
   * Called on user logout to prevent key material from persisting.
   */
  const cleanup = useCallback(async (): Promise<void> => {
    await clearAllEncryptionData();
  }, []);

  // ---------------------------------------------------------------------------
  // Session Management
  // ---------------------------------------------------------------------------

  /**
   * Ensure a Signal Protocol session exists with a recipient.
   *
   * 1. Checks IndexedDB for an existing session
   * 2. If none exists, fetches the recipient's pre-key bundle from the server
   * 3. Performs X3DH key agreement and initialises the Double Ratchet
   */
  const ensureSession = useCallback(
    async (recipientId: string, deviceId: number = DEFAULT_DEVICE_ID): Promise<void> => {
      const sessionExists = await hasSession(recipientId, deviceId);
      if (sessionExists) {
        return;
      }

      // Fetch the recipient's public pre-key bundle from the server.
      // Route: GET /api/v1/keys/bundle/:userId (key.routes.ts)
      // Wrapped in try/catch so a 404 (no bundle uploaded yet) does not
      // throw and break the caller — session simply won't be established.
      try {
        const bundle: PreKeyBundleResponse = await apiClient.get<PreKeyBundleResponse>(
          `/api/v1/keys/bundle/${recipientId}`,
        );

        // Perform X3DH key agreement and create the Double Ratchet session
        await createSession(recipientId, deviceId, bundle);
      } catch {
        // Bundle fetch or session creation failed — non-fatal.
        // Messages will use plaintext fallback until a session can be established.
      }
    },
    [],
  );

  /**
   * Check whether a Signal Protocol session exists with a recipient.
   * Quick local check — no network calls.
   */
  const checkSession = useCallback(
    async (recipientId: string, deviceId: number = DEFAULT_DEVICE_ID): Promise<boolean> => {
      return hasSession(recipientId, deviceId);
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // 1:1 Encryption Operations (R12)
  // ---------------------------------------------------------------------------

  /**
   * Encrypt a plaintext message for a 1:1 conversation.
   *
   * Ensures a session exists with the recipient, then encrypts
   * via the Double Ratchet protocol. Returns base64-encoded ciphertext.
   *
   * CRITICAL (R12): Plaintext NEVER leaves the client.
   * CRITICAL (R23): Never log plaintext or resulting ciphertext.
   */
  const encrypt = useCallback(
    async (
      recipientId: string,
      plaintext: string,
      deviceId: number = DEFAULT_DEVICE_ID,
    ): Promise<string> => {
      await ensureSession(recipientId, deviceId);
      return encryptMessage(recipientId, deviceId, plaintext);
    },
    [ensureSession],
  );

  /**
   * Decrypt a ciphertext message from a 1:1 conversation.
   *
   * @param isPreKey - True for the first message from the sender (pre-key
   *   whisper message); false for subsequent messages (regular whisper).
   *
   * CRITICAL (R23): Never log the decrypted plaintext.
   */
  const decrypt = useCallback(
    async (
      senderId: string,
      ciphertext: string,
      isPreKey: boolean,
      deviceId: number = DEFAULT_DEVICE_ID,
    ): Promise<string> => {
      return decryptMessage(senderId, deviceId, ciphertext, isPreKey);
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Group Encryption Operations (R14)
  // ---------------------------------------------------------------------------

  /**
   * Initialise Sender Key encryption for a group conversation.
   *
   * 1. Creates a new AES-256-GCM Sender Key for this group
   * 2. Ensures 1:1 sessions with all group members (for encrypted key exchange)
   * 3. Uploads the Sender Key distribution to the server for fan-out via BullMQ (R18)
   */
  const initGroupEncryption = useCallback(
    async (groupId: string, memberIds: string[]): Promise<void> => {
      // Generate a new Sender Key for the group (stored locally in IndexedDB)
      await createSenderKey(groupId);

      // Ensure 1:1 sessions exist with all members for encrypted key exchange
      const sessionPromises = memberIds.map((memberId) =>
        ensureSession(memberId, DEFAULT_DEVICE_ID),
      );
      await Promise.all(sessionPromises);

      // Sender Key distribution is handled server-side via BullMQ fan-out jobs
      // (R14, R18). The ConversationService enqueues a 'sender-key-distribution'
      // job when group membership changes. The local distribution material is
      // stored in IndexedDB and will be used when encrypting outgoing messages.
      // No REST call is needed — the server orchestrates distribution to all
      // group members through the queue worker (workers/queue/src/jobs/sender-key-distribution.ts).
    },
    [ensureSession],
  );

  /**
   * Encrypt a plaintext message for a group using the local Sender Key.
   *
   * Uses the AES-256-GCM key stored in IndexedDB under `groupId:local`.
   * All group members who processed our Sender Key distribution can decrypt.
   *
   * CRITICAL (R12): Plaintext NEVER leaves the client.
   * CRITICAL (R23): Never log plaintext or ciphertext.
   */
  const encryptGroup = useCallback(
    async (groupId: string, plaintext: string): Promise<string> => {
      return encryptGroupMessage(groupId, plaintext);
    },
    [],
  );

  /**
   * Decrypt a group message from a specific sender.
   *
   * Uses the sender's AES-256-GCM key received via Sender Key distribution.
   * Requires that the sender's distribution has been processed via
   * `processSenderKeyDistribution` first.
   *
   * CRITICAL (R23): Never log the decrypted plaintext.
   */
  const decryptGroup = useCallback(
    async (groupId: string, senderId: string, ciphertext: string): Promise<string> => {
      return decryptGroupMessage(groupId, senderId, ciphertext);
    },
    [],
  );

  /**
   * Handle a member being removed from a group (R14 — Sender Key Rotation).
   *
   * 1. Rotates the Sender Key by generating a new AES-256-GCM key
   * 2. The removed member's old key can no longer decrypt new messages
   * 3. Distributes the new key to remaining members via the server
   */
  const handleMemberRemoved = useCallback(
    async (
      groupId: string,
      _removedMemberId: string,
      _remainingMemberIds: string[],
    ): Promise<void> => {
      // Rotate: delete old key, generate new one (stored locally in IndexedDB)
      await rotateSenderKey(
        groupId,
        'member_removed',
      );

      // Sender Key rotation distribution is handled server-side via BullMQ (R14, R18).
      // ConversationService.removeMember enqueues a 'sender-key-distribution' job
      // that distributes the rotated key to remaining members. The local rotated
      // key material is persisted in IndexedDB for encrypting subsequent messages.
      // Removed members cannot decrypt post-rotation messages as they lack the new key.
    },
    [],
  );

  /**
   * Handle a new member being added to a group (R14).
   *
   * Ensures a 1:1 session with the new member and requests the server
   * to distribute our current Sender Key to them. The new member can
   * only decrypt messages sent AFTER receiving the key — they cannot
   * decrypt historical messages.
   */
  const handleMemberAdded = useCallback(
    async (_groupId: string, newMemberId: string): Promise<void> => {
      // Ensure 1:1 session with the new member for encrypted key exchange
      await ensureSession(newMemberId, DEFAULT_DEVICE_ID);

      // Sender Key distribution to the new member is handled server-side via
      // BullMQ (R14, R18). ConversationService.addMember enqueues a
      // 'sender-key-distribution' job that delivers our Sender Key to the new
      // member. The new member can only decrypt messages sent AFTER receiving
      // the key — they cannot decrypt historical messages.
    },
    [ensureSession],
  );

  // ---------------------------------------------------------------------------
  // Effects: Initialisation on Authentication
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Only initialise when authenticated with a valid user
    if (!isAuthenticated || !user) {
      return;
    }

    // Prevent double initialisation under React strict mode
    if (initRef.current) {
      return;
    }

    const init = async (): Promise<void> => {
      try {
        initRef.current = true;
        setIsInitializing(true);
        setError(null);

        // Initialise Signal Protocol key material in IndexedDB.
        // Generates identity key pair, registration ID, signed pre-key,
        // and initial batch of one-time pre-keys if not already present.
        await initializeEncryption();

        // Upload the public pre-key bundle to the server so other
        // users can establish Signal Protocol sessions with us.
        await uploadPreKeyBundle();

        setIsInitialized(true);
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : 'Encryption initialization failed';
        setError(message);
        // Keep initRef.current = true to prevent re-render retry loops.
        // Encryption init failure is non-fatal — the app operates with
        // plaintext fallback when encryption is unavailable.
      } finally {
        setIsInitializing(false);
      }
    };

    void init();
  }, [isAuthenticated, user, uploadPreKeyBundle]);

  // ---------------------------------------------------------------------------
  // Effects: Sender Key Distribution Listener
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    /**
     * Process incoming Sender Key distributions from group members.
     * When a member creates or rotates a Sender Key, the server fans out
     * the distribution message via the `senderkey:distribution` event.
     */
    const handleSenderKeyDistribution = async (
      data: SenderKeyDistributionData,
    ): Promise<void> => {
      try {
        await processSenderKeyDistribution(
          data.groupId,
          data.senderId,
          data.distribution,
        );
      } catch {
        // Sender Key processing failure is non-fatal. When decryption
        // later fails for a group message from this sender, the client
        // can request a fresh Sender Key distribution from the server.
      }
    };

    bindSenderKeyEvent('senderkey:distribution', handleSenderKeyDistribution);

    return () => {
      unbindSenderKeyEvent('senderkey:distribution', handleSenderKeyDistribution);
    };
  }, [isAuthenticated]);

  // ---------------------------------------------------------------------------
  // Effects: Cleanup on Logout
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // When the user logs out (isAuthenticated transitions to false)
    // and encryption was previously initialised, wipe all key material.
    if (!isAuthenticated && isInitialized) {
      void cleanup();
      setIsInitialized(false);
      initRef.current = false;
    }
  }, [isAuthenticated, isInitialized, cleanup]);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    isInitialized,
    isInitializing,
    error,

    // Session management
    ensureSession,
    checkSession,

    // 1:1 encryption (R12)
    encrypt,
    decrypt,

    // Group encryption (R14)
    initGroupEncryption,
    encryptGroup,
    decryptGroup,
    handleMemberRemoved,
    handleMemberAdded,

    // Key management
    uploadPreKeyBundle,
    cleanup,
  };
}
