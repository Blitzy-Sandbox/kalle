/**
 * @module socket.test
 * Unit tests for the Socket.IO client singleton module (@/lib/socket).
 *
 * Covers:
 * - Singleton lifecycle (getSocket, connectSocket, disconnectSocket, destroySocket)
 * - Event helpers (emitEvent, onEvent, offEvent)
 * - Reconnection handler (setupReconnectionHandler, onReconnect)
 * - Connection state (isConnected, getSocketId)
 * - Correlation ID generation (generateCorrelationId)
 *
 * Mocks socket.io-client to prevent real network connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock socket.io-client ──────────────────────────────────────────────
// We must mock socket.io-client BEFORE importing the module under test,
// because the module eagerly calls `io()` from the factory on first access.

/** A mock socket instance that mimics the Socket.IO Socket API */
function createMockSocket() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const ioListeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  const mockSocket = {
    connected: false,
    id: undefined as string | undefined,
    auth: {} as Record<string, unknown>,

    connect: vi.fn(() => {
      mockSocket.connected = true;
      mockSocket.id = 'mock-socket-id-123';
    }),
    disconnect: vi.fn(() => {
      // Fire disconnect listeners
      const handlers = listeners['disconnect'] ?? [];
      for (const handler of handlers) {
        handler();
      }
      mockSocket.connected = false;
      mockSocket.id = undefined;
    }),
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      // Wrap the handler so it auto-removes after first invocation
      const wrapped = (...args: unknown[]) => {
        listeners[event] = (listeners[event] ?? []).filter((h) => h !== wrapped);
        handler(...args);
      };
      listeners[event].push(wrapped);
    }),
    off: vi.fn((event: string, handler?: (...args: unknown[]) => void) => {
      if (handler) {
        listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
      } else {
        delete listeners[event];
      }
    }),
    removeAllListeners: vi.fn(() => {
      Object.keys(listeners).forEach((key) => delete listeners[key]);
      Object.keys(ioListeners).forEach((key) => delete ioListeners[key]);
    }),

    // Manager-level (socket.io) object
    io: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (!ioListeners[event]) ioListeners[event] = [];
        ioListeners[event].push(handler);
      }),
    },

    // Test helpers — not part of the real API
    _listeners: listeners,
    _ioListeners: ioListeners,
    _simulateConnect: () => {
      mockSocket.connected = true;
      mockSocket.id = 'mock-socket-id-123';
      const handlers = listeners['connect'] ?? [];
      for (const handler of handlers) {
        handler();
      }
    },
    _simulateDisconnect: () => {
      const handlers = listeners['disconnect'] ?? [];
      for (const handler of handlers) {
        handler();
      }
      mockSocket.connected = false;
      mockSocket.id = undefined;
    },
    _simulateReconnect: () => {
      const handlers = ioListeners['reconnect'] ?? [];
      for (const handler of handlers) {
        handler();
      }
    },
  };

  return mockSocket;
}

let mockSocketInstance = createMockSocket();

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocketInstance),
}));

// ─── Import module under test (AFTER mock registration) ─────────────────
// Each test resets the module to ensure singleton isolation.
let socketModule: typeof import('@/lib/socket');

async function reimportModule() {
  vi.resetModules();
  // Recreate mock instance for the fresh module
  mockSocketInstance = createMockSocket();
  socketModule = await import('@/lib/socket');
}

// =============================================================================
// Tests
// =============================================================================

describe('socket.ts — Socket.IO Client Singleton', () => {
  beforeEach(async () => {
    await reimportModule();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────
  // getSocket — Singleton Creation
  // ─────────────────────────────────────────────────────────────────────
  describe('getSocket()', () => {
    it('returns a socket instance on first call', () => {
      const socket = socketModule.getSocket();
      expect(socket).toBeDefined();
      expect(socket).toBe(mockSocketInstance);
    });

    it('returns the same instance on subsequent calls (singleton)', () => {
      const first = socketModule.getSocket();
      const second = socketModule.getSocket();
      expect(first).toBe(second);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // connectSocket — Connection with Auth Token
  // ─────────────────────────────────────────────────────────────────────
  describe('connectSocket()', () => {
    it('sets the auth token and calls connect()', () => {
      const token = 'jwt-access-token-abc';
      const result = socketModule.connectSocket(token);

      expect(mockSocketInstance.auth).toEqual({ token });
      expect(mockSocketInstance.connect).toHaveBeenCalledOnce();
      expect(result).toBe(mockSocketInstance);
    });

    it('disconnects before reconnecting if already connected', () => {
      // First connection
      socketModule.connectSocket('token-1');
      mockSocketInstance.connected = true;

      // Second connection with new token
      socketModule.connectSocket('token-2');

      expect(mockSocketInstance.disconnect).toHaveBeenCalled();
      expect(mockSocketInstance.auth).toEqual({ token: 'token-2' });
      // connect() called for both invocations
      expect(mockSocketInstance.connect).toHaveBeenCalledTimes(2);
    });

    it('returns the singleton socket instance', () => {
      const socket = socketModule.connectSocket('token');
      const singleton = socketModule.getSocket();
      expect(socket).toBe(singleton);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // disconnectSocket — Graceful Disconnect (Without Destroying)
  // ─────────────────────────────────────────────────────────────────────
  describe('disconnectSocket()', () => {
    it('disconnects a connected socket', () => {
      socketModule.connectSocket('token');
      mockSocketInstance.connected = true;
      socketModule.disconnectSocket();

      expect(mockSocketInstance.disconnect).toHaveBeenCalled();
    });

    it('does nothing if socket is not connected', () => {
      socketModule.getSocket();
      mockSocketInstance.connected = false;
      socketModule.disconnectSocket();

      // disconnect() should NOT be called when not connected
      expect(mockSocketInstance.disconnect).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // destroySocket — Full Teardown
  // ─────────────────────────────────────────────────────────────────────
  describe('destroySocket()', () => {
    it('removes all listeners, disconnects, and nulls the singleton', () => {
      socketModule.connectSocket('token');
      socketModule.destroySocket();

      expect(mockSocketInstance.removeAllListeners).toHaveBeenCalledOnce();
      expect(mockSocketInstance.disconnect).toHaveBeenCalled();
    });

    it('allows getSocket() to create a fresh instance after destroy', async () => {
      socketModule.connectSocket('token');
      socketModule.destroySocket();

      // After destroy, the next getSocket() call should create a new instance
      // Since we mock at module level, reimport to test this properly
      await reimportModule();
      const newSocket = socketModule.getSocket();
      expect(newSocket).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // setupReconnectionHandler — Reconnection Detection (R13)
  // ─────────────────────────────────────────────────────────────────────
  describe('setupReconnectionHandler()', () => {
    it('registers disconnect and connect listeners', () => {
      const callback = vi.fn();
      socketModule.setupReconnectionHandler(callback);

      // Should have registered handlers for both events
      expect(mockSocketInstance.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
      expect(mockSocketInstance.on).toHaveBeenCalledWith('connect', expect.any(Function));
    });

    it('does NOT fire callback on initial connect (no prior disconnect)', () => {
      const callback = vi.fn();
      socketModule.setupReconnectionHandler(callback);

      // Simulate initial connection (no prior disconnect)
      mockSocketInstance._simulateConnect();

      expect(callback).not.toHaveBeenCalled();
    });

    it('fires callback on reconnect after a prior disconnect', () => {
      const callback = vi.fn();
      socketModule.setupReconnectionHandler(callback);

      // First: simulate a disconnect (sets hasBeenConnected = true internally)
      mockSocketInstance._simulateDisconnect();
      expect(callback).not.toHaveBeenCalled();

      // Then: simulate reconnection
      mockSocketInstance._simulateConnect();
      expect(callback).toHaveBeenCalledOnce();
    });

    it('fires callback on each subsequent reconnection', () => {
      const callback = vi.fn();
      socketModule.setupReconnectionHandler(callback);

      // First disconnect + reconnect
      mockSocketInstance._simulateDisconnect();
      mockSocketInstance._simulateConnect();
      expect(callback).toHaveBeenCalledTimes(1);

      // Second disconnect + reconnect
      mockSocketInstance._simulateDisconnect();
      mockSocketInstance._simulateConnect();
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // onReconnect — Manager-Level Reconnect Listener
  // ─────────────────────────────────────────────────────────────────────
  describe('onReconnect()', () => {
    it('registers a listener on the socket.io manager reconnect event', () => {
      const callback = vi.fn();
      socketModule.onReconnect(callback);

      expect(mockSocketInstance.io.on).toHaveBeenCalledWith('reconnect', expect.any(Function));
    });

    it('fires callback when manager emits reconnect', () => {
      const callback = vi.fn();
      socketModule.onReconnect(callback);

      mockSocketInstance._simulateReconnect();
      expect(callback).toHaveBeenCalledOnce();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // emitEvent — Type-Safe Event Emission
  // ─────────────────────────────────────────────────────────────────────
  describe('emitEvent()', () => {
    it('emits an event on the connected socket', () => {
      socketModule.connectSocket('token');
      mockSocketInstance.connected = true;

      // Use type assertion since we're testing the generic wrapper
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (socketModule.emitEvent as any)('message:send', { data: 'test' });
      expect(mockSocketInstance.emit).toHaveBeenCalledWith('message:send', { data: 'test' });
    });

    it('throws if socket is not connected', () => {
      socketModule.getSocket();
      mockSocketInstance.connected = false;

      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (socketModule.emitEvent as any)('message:send', {});
      }).toThrow('socket is not connected');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // onEvent — Type-Safe Event Subscription
  // ─────────────────────────────────────────────────────────────────────
  describe('onEvent()', () => {
    it('registers a listener on the socket', () => {
      const handler = vi.fn();
      socketModule.onEvent('message:new' as never, handler as never);

      expect(mockSocketInstance.on).toHaveBeenCalledWith('message:new', handler);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // offEvent — Type-Safe Event Unsubscription
  // ─────────────────────────────────────────────────────────────────────
  describe('offEvent()', () => {
    it('removes a specific listener when handler is provided', () => {
      const handler = vi.fn();
      socketModule.offEvent('message:new' as never, handler as never);

      expect(mockSocketInstance.off).toHaveBeenCalledWith('message:new', handler);
    });

    it('removes all listeners for event when no handler is provided', () => {
      socketModule.offEvent('message:new' as never);

      expect(mockSocketInstance.off).toHaveBeenCalledWith('message:new');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // isConnected — Connection State Query
  // ─────────────────────────────────────────────────────────────────────
  describe('isConnected()', () => {
    it('returns false before any connection', () => {
      expect(socketModule.isConnected()).toBe(false);
    });

    it('returns true when socket is connected', () => {
      socketModule.connectSocket('token');
      mockSocketInstance.connected = true;

      expect(socketModule.isConnected()).toBe(true);
    });

    it('returns false after disconnect', () => {
      socketModule.connectSocket('token');
      mockSocketInstance.connected = true;
      mockSocketInstance.connected = false;

      expect(socketModule.isConnected()).toBe(false);
    });

    it('returns false after destroySocket()', () => {
      socketModule.connectSocket('token');
      mockSocketInstance.connected = true;
      socketModule.destroySocket();

      // After destroy, socket is null so isConnected returns false
      expect(socketModule.isConnected()).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // getSocketId — Transport ID Query
  // ─────────────────────────────────────────────────────────────────────
  describe('getSocketId()', () => {
    it('returns undefined before connection', () => {
      expect(socketModule.getSocketId()).toBeUndefined();
    });

    it('returns the socket id when connected', () => {
      socketModule.connectSocket('token');
      mockSocketInstance.connected = true;
      mockSocketInstance.id = 'test-id-xyz';

      expect(socketModule.getSocketId()).toBe('test-id-xyz');
    });

    it('returns undefined after destroy', () => {
      socketModule.connectSocket('token');
      mockSocketInstance.id = 'some-id';
      socketModule.destroySocket();

      expect(socketModule.getSocketId()).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // generateCorrelationId — UUID v4 Generation (R29)
  // ─────────────────────────────────────────────────────────────────────
  describe('generateCorrelationId()', () => {
    it('returns a string in UUID v4 format', () => {
      const id = socketModule.generateCorrelationId();
      // UUID v4 regex: 8-4-4-4-12 hex with version 4 and variant [89ab]
      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(id).toMatch(uuidV4Regex);
    });

    it('generates unique IDs across multiple calls', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(socketModule.generateCorrelationId());
      }
      // All 100 should be unique
      expect(ids.size).toBe(100);
    });

    it('uses crypto.randomUUID when available', () => {
      const mockUUID = '12345678-1234-4123-a123-123456789abc';
      const spy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(mockUUID as `${string}-${string}-${string}-${string}-${string}`);

      const result = socketModule.generateCorrelationId();
      expect(result).toBe(mockUUID);
      expect(spy).toHaveBeenCalledOnce();

      spy.mockRestore();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Integration: Full Connection Lifecycle
  // ─────────────────────────────────────────────────────────────────────
  describe('full connection lifecycle', () => {
    it('connect → use → disconnect → reconnect → destroy', () => {
      // 1. Connect with auth token
      const socket = socketModule.connectSocket('my-jwt-token');
      expect(socket).toBeDefined();
      expect(mockSocketInstance.auth).toEqual({ token: 'my-jwt-token' });
      expect(mockSocketInstance.connect).toHaveBeenCalledTimes(1);

      // 2. Register event handlers
      const messageHandler = vi.fn();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (socketModule.onEvent as any)('message:new', messageHandler);

      // 3. Emit events (simulate connected state)
      mockSocketInstance.connected = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (socketModule.emitEvent as any)('message:send', {});
      expect(mockSocketInstance.emit).toHaveBeenCalledTimes(1);

      // 4. Graceful disconnect
      socketModule.disconnectSocket();
      expect(mockSocketInstance.disconnect).toHaveBeenCalled();

      // 5. Reconnect with new token
      mockSocketInstance.connected = false;
      socketModule.connectSocket('new-jwt-token');
      expect(mockSocketInstance.auth).toEqual({ token: 'new-jwt-token' });

      // 6. Full destroy
      socketModule.destroySocket();
      expect(mockSocketInstance.removeAllListeners).toHaveBeenCalledOnce();
      expect(socketModule.isConnected()).toBe(false);
      expect(socketModule.getSocketId()).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Error Handling
  // ─────────────────────────────────────────────────────────────────────
  describe('error handling', () => {
    it('emitEvent throws descriptive error with event name when disconnected', () => {
      socketModule.getSocket();
      mockSocketInstance.connected = false;

      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (socketModule.emitEvent as any)('typing:start', {});
      }).toThrow('typing:start');
    });
  });
});
