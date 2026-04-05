/**
 * @module useSocket
 *
 * Custom React hook managing the full Socket.IO WebSocket connection lifecycle.
 *
 * Responsibilities:
 * - Auto-connect when user authenticates with JWT handshake (R9)
 * - Auto-disconnect when user logs out, clearing presence state
 * - Subscribe to server-to-client presence and typing events
 * - Handle offline-to-online reconciliation via message:sync (R13)
 * - Handle connection errors and server-initiated disconnects (R33)
 * - Full cleanup of all event listeners and socket on unmount
 *
 * Zero console.log statements per R23 (Log Hygiene).
 * TypeScript strict mode compatible per R7 (Zero Warnings Build).
 * No backend module imports.
 *
 * @see AAP Section 0.7.1 Group 16
 * @see Rules R9, R13, R23, R25, R29, R33
 */

import { useEffect, useRef, useCallback } from 'react';
import {
  connectSocket,
  disconnectSocket,
  destroySocket,
  getSocket,
  setupReconnectionHandler,
  onEvent,
  offEvent,
  isConnected as checkSocketConnected,
  type TypedSocket,
} from '../lib/socket';
import { useAuthStore } from '../stores/authStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useChatStore } from '../stores/chatStore';
import type { ServerToClientEvents } from '@kalle/shared';

// =============================================================================
// Public Interface
// =============================================================================

/**
 * Return type for the useSocket hook.
 *
 * Provides a snapshot of connection state, manual connect/disconnect controls,
 * and access to the typed Socket.IO client instance for direct event emission.
 */
export interface UseSocketReturn {
  /** Current WebSocket connection state (snapshot at render time) */
  isConnected: boolean;

  /** Manually establish the WebSocket connection using the stored access token */
  connect: () => void;

  /** Manually disconnect and clear all presence state */
  disconnect: () => void;

  /** Typed Socket.IO client instance; null when not connected */
  socket: TypedSocket | null;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * useSocket — manages the full Socket.IO WebSocket connection lifecycle.
 *
 * Orchestrates five internal effects:
 * 1. Auto-connect/disconnect on auth state changes (R9)
 * 2. Reconnection handler for offline-to-online sync (R13)
 * 3. Presence and typing event listeners
 * 4. Connection error and server-disconnect handling (R33)
 * 5. Permanent cleanup on hook unmount
 *
 * @returns {UseSocketReturn} Connection state, controls, and socket instance
 */
export function useSocket(): UseSocketReturn {
  // ---------------------------------------------------------------------------
  // Auth state selectors — reactive subscriptions trigger re-renders
  // ---------------------------------------------------------------------------
  const accessToken = useAuthStore((state) => state.accessToken);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  // ---------------------------------------------------------------------------
  // Refs for non-reactive internal state tracking
  // ---------------------------------------------------------------------------

  /** Tracks connection state in callbacks without triggering re-renders */
  const connectedRef = useRef<boolean>(false);

  /** Timeout reference for reconnection backoff logic */
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  /** Guards against duplicate reconnection handler registration */
  const reconnectHandlerSetupRef = useRef<boolean>(false);

  // ---------------------------------------------------------------------------
  // Memoized connect / disconnect functions
  // ---------------------------------------------------------------------------

  /**
   * Manually establish the WebSocket connection (R9: JWT auth handshake).
   *
   * Passes the current access token via socket.auth for server-side
   * JWT verification during the handshake. No-ops if accessToken is null.
   */
  const connect = useCallback(() => {
    if (!accessToken) {
      return;
    }
    connectSocket(accessToken);
    connectedRef.current = true;
  }, [accessToken]);

  /**
   * Gracefully disconnect the WebSocket and clear all transient state.
   *
   * Calls disconnectSocket (keeps singleton alive for potential reconnect),
   * clears presence data, and cancels any pending reconnection timeout.
   */
  const disconnect = useCallback(() => {
    disconnectSocket();
    usePresenceStore.getState().clearAll();
    connectedRef.current = false;

    if (reconnectTimeoutRef.current !== null) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Effect 1: Auto-connect / disconnect on auth state changes (R9)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (isAuthenticated && accessToken) {
      connectSocket(accessToken);
      connectedRef.current = true;
    } else {
      disconnectSocket();
      usePresenceStore.getState().clearAll();
      connectedRef.current = false;
    }

    // Cleanup: disconnect on dep change or unmount (does NOT destroy singleton)
    return () => {
      disconnectSocket();
      usePresenceStore.getState().clearAll();
      connectedRef.current = false;
    };
  }, [isAuthenticated, accessToken]);

  // ---------------------------------------------------------------------------
  // Effect 2: Reconnection handler for offline-to-online sync (R13)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isAuthenticated) {
      // Reset so handler can be re-registered on next auth
      reconnectHandlerSetupRef.current = false;
      return;
    }

    // Prevent duplicate listener registration on the socket singleton
    if (reconnectHandlerSetupRef.current) {
      return;
    }

    setupReconnectionHandler(() => {
      // R13: Gather last known message ID per conversation for sync cursor
      const { conversations, messages } = useChatStore.getState();
      const lastMessageIds: Record<string, string> = {};

      for (const conv of conversations) {
        const convMessages = messages.get(conv.id);
        if (convMessages && convMessages.length > 0) {
          lastMessageIds[conv.id] =
            convMessages[convMessages.length - 1].id;
        }
      }

      // Emit message:sync with cursor map (R13 + R29 correlationId)
      const socket = getSocket();
      if (socket.connected) {
        socket.emit(
          'message:sync',
          {
            correlationId: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            lastMessageIds,
          },
          (response) => {
            if (response.success && response.data) {
              // Group missed messages by conversation for batch insert
              const missedMessages = response.data.messages;
              const grouped = new Map<string, typeof missedMessages>();

              for (const msg of missedMessages) {
                const existing = grouped.get(msg.conversationId);
                if (existing) {
                  existing.push(msg);
                } else {
                  grouped.set(msg.conversationId, [msg]);
                }
              }

              // Add to chat store — addMessages handles dedup and ordering (R4)
              const chatState = useChatStore.getState();
              grouped.forEach((msgs, conversationId) => {
                chatState.addMessages(conversationId, msgs);
              });
            }
          },
        );
      }

      // Update connection tracking ref after successful reconnection
      connectedRef.current = true;
    });

    reconnectHandlerSetupRef.current = true;
    // No cleanup needed — handler lives with the socket singleton and is
    // cleaned up when destroySocket() is called in the unmount effect.
  }, [isAuthenticated]);

  // ---------------------------------------------------------------------------
  // Effect 3: Presence and typing event listeners
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    /**
     * Handle user:presence events — update online/offline state.
     * Server broadcasts when a user connects/disconnects from WebSocket.
     */
    const handlePresence: ServerToClientEvents['user:presence'] = (data) => {
      if (data.status === 'online') {
        usePresenceStore.getState().setOnline(data.userId);
      } else {
        usePresenceStore.getState().setOffline(data.userId, data.lastSeen);
      }
    };

    /**
     * Handle typing:indicator events — update typing state.
     * Server debounces at 3-second intervals with 5-second expiry.
     */
    const handleTyping: ServerToClientEvents['typing:indicator'] = (data) => {
      if (data.isTyping) {
        usePresenceStore.getState().setTyping(
          data.conversationId,
          data.userId,
        );
      } else {
        usePresenceStore.getState().clearTyping(
          data.conversationId,
          data.userId,
        );
      }
    };

    onEvent('user:presence', handlePresence);
    onEvent('typing:indicator', handleTyping);

    return () => {
      offEvent('user:presence', handlePresence);
      offEvent('typing:indicator', handleTyping);
    };
  }, [isAuthenticated]);

  // ---------------------------------------------------------------------------
  // Effect 4: Connection error and disconnect handling (R25, R33)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    const socket = getSocket();

    /** Track successful connection to update ref */
    const handleConnect = (): void => {
      connectedRef.current = true;
    };

    /**
     * Handle connection errors — token expiry, rate limiting (R25).
     * Socket.IO auto-reconnect handles transient failures; we update state.
     */
    const handleConnectError = (_error: Error): void => {
      connectedRef.current = false;
    };

    /**
     * Handle disconnects — detect server-initiated kicks (R33).
     *
     * Reason values:
     * - 'io server disconnect': Server forcefully disconnected the client.
     *   Indicates possible session revocation (R33) — clear all presence.
     * - 'io client disconnect': Client called socket.disconnect().
     * - 'ping timeout': No pong response within pingTimeout.
     * - 'transport close': Network connection lost.
     * - 'transport error': Transport encountered an error.
     */
    const handleDisconnect = (reason: string): void => {
      connectedRef.current = false;

      // Server-initiated disconnect indicates possible session revocation (R33)
      if (reason === 'io server disconnect') {
        usePresenceStore.getState().clearAll();
      }
    };

    socket.on('connect', handleConnect);
    socket.on('connect_error', handleConnectError);
    socket.on('disconnect', handleDisconnect);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('connect_error', handleConnectError);
      socket.off('disconnect', handleDisconnect);
    };
  }, [isAuthenticated]);

  // ---------------------------------------------------------------------------
  // Effect 5: Permanent cleanup on hook unmount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      // Full singleton destruction — removes all listeners, nulls instance
      destroySocket();
      reconnectHandlerSetupRef.current = false;

      if (reconnectTimeoutRef.current !== null) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Return value
  // ---------------------------------------------------------------------------
  const connected = checkSocketConnected();

  return {
    isConnected: connected,
    connect,
    disconnect,
    socket: connected ? getSocket() : null,
  };
}
