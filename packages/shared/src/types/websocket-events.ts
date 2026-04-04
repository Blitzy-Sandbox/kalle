/**
 * @module @kalle/shared/types/websocket-events
 *
 * WebSocket (Socket.IO) event payload contracts for real-time communication
 * between the frontend Socket.IO client and backend WebSocket server.
 *
 * These typed event payloads ensure compile-time type safety for every
 * WebSocket event emitted and received across the application. Socket.IO
 * uses these interfaces as generic type parameters to enforce correct
 * payload shapes on both client and server sides.
 *
 * Key design decisions:
 * - Every event payload includes EventMetadata (correlationId + timestamp) per R29
 * - AckCallback provides a typed acknowledgment pattern for request-response events
 * - ClientToServerEvents and ServerToClientEvents are Socket.IO typed maps
 * - InterServerEvents covers cross-instance communication via Redis adapter
 * - SocketData stores per-connection metadata on the socket instance
 * - All message payloads use ciphertext — server NEVER sees plaintext (R12)
 * - PresenceStatus is a string literal union ('online' | 'offline')
 * - MessageSyncRequestPayload supports per-conversation cursor for offline sync (R13)
 * - ConnectionErrorPayload omits EventMetadata (connection-level, pre-auth)
 *
 * Rate limiting per R25:
 * - message:send — max 30/min per connection
 * - typing:start — max 10/min per connection
 * - all others — max 60/min per connection
 *
 * This file contains ZERO runtime code — only TypeScript interfaces and types.
 * It has a single dependency on message.ts for MessageResponse and MessageStatusEnum.
 */

import type { MessageResponse, MessageStatusEnum } from './message.js';

// =============================================================================
// Common WebSocket Types
// =============================================================================

/**
 * EventMetadata — attached to all event payloads for traceability (R29).
 *
 * Every WebSocket event includes a UUID v4 correlation ID and an ISO 8601
 * timestamp. The correlation ID propagates through log entries, error
 * responses, and BullMQ job payloads originating from the event.
 */
export interface EventMetadata {
  /** UUID v4 correlation ID for request tracing across services (R29) */
  correlationId: string;

  /** ISO 8601 timestamp when the event was created */
  timestamp: string;
}

/**
 * AckCallback — generic acknowledgment callback for Socket.IO ack pattern.
 *
 * Used for request-response style events where the client needs confirmation
 * from the server. The response always includes a `success` boolean, optional
 * `data` on success, and optional `error` on failure.
 *
 * @template T - The type of data returned on success (defaults to void)
 *
 * Usage in ClientToServerEvents:
 * - message:send → AckCallback<MessageResponse> (returns created message)
 * - message:edit → AckCallback<void> (success/failure only)
 * - message:delete → AckCallback<void> (success/failure only)
 * - message:sync → AckCallback<MessageSyncResponsePayload> (returns missed messages)
 */
export interface AckCallback<T = void> {
  (response: {
    success: boolean;
    data?: T;
    error?: { code: string; message: string };
  }): void;
}

// =============================================================================
// Message Events
// =============================================================================

/**
 * MessageSendPayload — client sends an encrypted message to the server.
 *
 * Emitted by the client after encrypting message content via Signal Protocol.
 * The server stores only the ciphertext and never performs decryption (R12).
 * For group conversations with 3+ recipients, delivery is fanned out via
 * BullMQ (R18). The `clientMessageId` enables idempotency and deduplication (R4).
 *
 * Event: 'message:send' (ClientToServerEvents)
 * Rate limit: max 30/min per connection (R25)
 */
export interface MessageSendPayload extends EventMetadata {
  /** Target conversation ID (UUID) */
  conversationId: string;

  /** Encrypted message content — Base64-encoded Signal Protocol ciphertext (R12) */
  ciphertext: string;

  /** MessageType enum value determining rendering and media handling */
  type: string;

  /** Optional: ID of the message being replied to (inline reply/quote) */
  replyToMessageId?: string;

  /** Optional: ID of an already-uploaded encrypted media attachment */
  mediaId?: string;

  /** Client-generated UUID v4 for idempotency and deduplication (R4) */
  clientMessageId: string;
}

/**
 * MessageNewPayload — server broadcasts a new message to conversation participants.
 *
 * Emitted to all participants in the conversation room (except the sender, who
 * already has the optimistic local copy). Contains the full MessageResponse
 * including server-assigned ID, serverTimestamp, and initial SENT status.
 *
 * Event: 'message:new' (ServerToClientEvents)
 */
export interface MessageNewPayload extends EventMetadata {
  /** Complete message representation with server-assigned fields */
  message: MessageResponse;
}

/**
 * MessageEditPayload — client edits an existing message (R19).
 *
 * Restricted to the message sender within a 15-minute window from the
 * original serverTimestamp. The new ciphertext replaces the old ciphertext
 * server-side — the original content is NOT retained.
 *
 * Event: 'message:edit' (ClientToServerEvents)
 */
export interface MessageEditPayload extends EventMetadata {
  /** ID of the message being edited */
  messageId: string;

  /** New encrypted content replacing the original ciphertext */
  ciphertext: string;
}

/**
 * MessageEditedPayload — server broadcasts an edited message to participants.
 *
 * Emitted to all conversation participants after a successful edit. Clients
 * update their local message store with the new ciphertext and editedAt
 * timestamp. The UI displays an "edited" indicator on the message (R19).
 *
 * Event: 'message:edited' (ServerToClientEvents)
 */
export interface MessageEditedPayload extends EventMetadata {
  /** ID of the edited message */
  messageId: string;

  /** Conversation containing the edited message */
  conversationId: string;

  /** New encrypted content after edit */
  ciphertext: string;

  /** ISO 8601 timestamp when the edit was applied */
  editedAt: string;
}

/**
 * MessageDeletePayload — client deletes their own message (R20).
 *
 * Deletion is a soft-delete: ciphertext is nulled server-side, but the
 * message row is retained as a tombstone. All participants see
 * "This message was deleted" in the UI.
 *
 * Event: 'message:delete' (ClientToServerEvents)
 */
export interface MessageDeletePayload extends EventMetadata {
  /** ID of the message to delete */
  messageId: string;
}

/**
 * MessageDeletedPayload — server broadcasts a deletion tombstone to participants.
 *
 * Emitted to all conversation participants after a successful deletion.
 * Clients null the local ciphertext and render the tombstone UI (R20).
 *
 * Event: 'message:deleted' (ServerToClientEvents)
 */
export interface MessageDeletedPayload extends EventMetadata {
  /** ID of the deleted message */
  messageId: string;

  /** Conversation containing the deleted message */
  conversationId: string;

  /** ISO 8601 timestamp when the deletion occurred */
  deletedAt: string;
}

/**
 * MessageDeliveredPayload — client acknowledges message delivery.
 *
 * Sent by the receiving client when a message arrives and is stored locally.
 * The server updates the per-user MessageStatus record and broadcasts
 * a message:status event to the sender.
 *
 * Event: 'message:delivered' (ClientToServerEvents)
 */
export interface MessageDeliveredPayload extends EventMetadata {
  /** ID of the delivered message */
  messageId: string;

  /** Conversation containing the delivered message */
  conversationId: string;
}

/**
 * MessageReadPayload — client acknowledges message read.
 *
 * Sent when the user opens a conversation and views unread messages.
 * Supports batch read receipts — multiple message IDs in a single event
 * for efficiency. The server broadcasts message:status events to senders.
 *
 * Event: 'message:read' (ClientToServerEvents)
 */
export interface MessageReadPayload extends EventMetadata {
  /** IDs of all messages marked as read (batch read receipts) */
  messageIds: string[];

  /** Conversation containing the read messages */
  conversationId: string;
}

/**
 * MessageStatusPayload — server broadcasts a status update to the message sender.
 *
 * Emitted when a recipient confirms delivery (DELIVERED) or marks a message
 * as read (READ). The sender's UI updates checkmark indicators in real-time:
 * - SENT: single gray checkmark
 * - DELIVERED: double gray checkmarks
 * - READ: double blue checkmarks (#007AFF)
 *
 * Event: 'message:status' (ServerToClientEvents)
 */
export interface MessageStatusPayload extends EventMetadata {
  /** ID of the message whose status changed */
  messageId: string;

  /** Conversation containing the message */
  conversationId: string;

  /** ID of the user who delivered or read the message */
  userId: string;

  /** New delivery/read status (SENT, DELIVERED, or READ) */
  status: MessageStatusEnum;
}

// =============================================================================
// Typing Events
// =============================================================================

/**
 * TypingStartPayload — client starts typing in a conversation.
 *
 * Server debounces typing indicators at 3-second intervals with 5-second
 * expiry to prevent excessive broadcasts. If no typing:stop is received
 * within 5 seconds, the server automatically clears the indicator.
 *
 * Event: 'typing:start' (ClientToServerEvents)
 * Rate limit: max 10/min per connection (R25)
 */
export interface TypingStartPayload extends EventMetadata {
  /** Conversation where the user is typing */
  conversationId: string;
}

/**
 * TypingStopPayload — client stops typing in a conversation.
 *
 * Sent when the user clears the input field or after a debounce timeout.
 * The server broadcasts a typing:indicator with isTyping=false to
 * conversation participants.
 *
 * Event: 'typing:stop' (ClientToServerEvents)
 */
export interface TypingStopPayload extends EventMetadata {
  /** Conversation where the user stopped typing */
  conversationId: string;
}

/**
 * TypingIndicatorPayload — server broadcasts typing state to participants.
 *
 * Emitted to all participants in the conversation except the typist.
 * The client renders an animated typing indicator (three bouncing dots)
 * when isTyping is true and removes it when false.
 *
 * Event: 'typing:indicator' (ServerToClientEvents)
 */
export interface TypingIndicatorPayload extends EventMetadata {
  /** Conversation where typing is occurring */
  conversationId: string;

  /** ID of the user who is typing */
  userId: string;

  /** Display name of the typist (for group chat "X is typing..." label) */
  displayName: string;

  /** Whether the user is currently typing (true) or stopped (false) */
  isTyping: boolean;
}

// =============================================================================
// Presence Events
// =============================================================================

/**
 * PresenceStatus — user online/offline state.
 *
 * A string literal union representing the two possible presence states.
 * 'online' indicates the user has at least one active WebSocket connection.
 * 'offline' indicates all connections are closed.
 */
export type PresenceStatus = 'online' | 'offline';

/**
 * UserPresencePayload — server broadcasts user online/offline/last-seen state.
 *
 * Emitted when a user connects (online) or disconnects (offline). The
 * lastSeen field is populated only when status is 'offline', indicating
 * the ISO 8601 timestamp of the user's last activity.
 *
 * Event: 'user:presence' (ServerToClientEvents)
 */
export interface UserPresencePayload extends EventMetadata {
  /** ID of the user whose presence changed */
  userId: string;

  /** Current presence state ('online' or 'offline') */
  status: PresenceStatus;

  /** ISO 8601 timestamp of last activity; set when status is 'offline' */
  lastSeen?: string;
}

// =============================================================================
// Sync Events (R13: Offline Reconciliation)
// =============================================================================

/**
 * MessageSyncRequestPayload — client requests missed messages on reconnect.
 *
 * Sent after WebSocket reconnection to retrieve all messages missed during
 * the offline period. The client provides the last known message ID per
 * conversation so the server can return only new messages (R13).
 *
 * The server responds with a message:sync:response event (or via ack callback)
 * containing all missed messages in chronological order within 3 seconds.
 *
 * Event: 'message:sync' (ClientToServerEvents)
 */
export interface MessageSyncRequestPayload extends EventMetadata {
  /**
   * Map of conversation IDs to the last known message ID in each conversation.
   * The server returns all messages after each cursor.
   * Format: { [conversationId: string]: lastKnownMessageId }
   */
  lastMessageIds: Record<string, string>;
}

/**
 * MessageSyncResponsePayload — server responds with missed messages.
 *
 * Contains all messages missed during the offline period, ordered
 * chronologically by serverTimestamp. If the result set is large,
 * hasMore indicates that the client should issue another sync request.
 *
 * Event: 'message:sync:response' (ServerToClientEvents)
 * Also returned via AckCallback for the 'message:sync' event.
 */
export interface MessageSyncResponsePayload extends EventMetadata {
  /** All missed messages across conversations, ordered by serverTimestamp */
  messages: MessageResponse[];

  /** Whether more messages are available for sync (pagination) */
  hasMore: boolean;
}

// =============================================================================
// Link Preview Events
// =============================================================================

/**
 * LinkPreviewPayload — server sends extracted OG metadata after async processing.
 *
 * After a message is sent, a BullMQ job asynchronously scrapes OG metadata
 * from any URLs detected in the message. Once extracted, this event is
 * emitted to all conversation participants so the UI can render a rich
 * link preview card (title, description, image, site name).
 *
 * Event: 'link:preview' (ServerToClientEvents)
 */
export interface LinkPreviewPayload extends EventMetadata {
  /** ID of the message containing the URL */
  messageId: string;

  /** Conversation containing the message */
  conversationId: string;

  /** The URL that was scraped for OG metadata */
  url: string;

  /** OG title tag content */
  title?: string;

  /** OG description tag content */
  description?: string;

  /** OG image URL for the preview thumbnail */
  imageUrl?: string;

  /** OG site_name tag content (e.g., "GitHub", "YouTube") */
  siteName?: string;
}

// =============================================================================
// Connection Events
// =============================================================================

/**
 * ConnectionErrorPayload — server emits connection-level errors.
 *
 * Used for errors that occur during or after the WebSocket handshake,
 * such as authentication failures, rate limit violations, or server-side
 * errors. This payload intentionally omits EventMetadata because
 * connection errors may occur before a correlation ID is assigned.
 *
 * Event: 'connection:error' (ServerToClientEvents)
 */
export interface ConnectionErrorPayload {
  /** Machine-readable error code (e.g., 'AUTH_FAILED', 'RATE_LIMITED') */
  code: string;

  /** Human-readable error description */
  message: string;
}

// =============================================================================
// Socket.IO Typed Event Maps
// =============================================================================

/**
 * ClientToServerEvents — all events the client can emit to the server.
 *
 * Used as the first generic type parameter in Socket.IO's Server and Socket types:
 *   - Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>
 *   - Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>
 *
 * Events with AckCallback expect the server to call the callback with a
 * response. Events without AckCallback are fire-and-forget.
 *
 * Rate limits per R25:
 * - message:send: max 30/min per connection
 * - typing:start: max 10/min per connection
 * - all others: max 60/min per connection
 */
export interface ClientToServerEvents {
  /** Send an encrypted message — returns the created MessageResponse via ack */
  'message:send': (
    payload: MessageSendPayload,
    ack: AckCallback<MessageResponse>,
  ) => void;

  /** Edit an existing message (R19: sender-only, 15-min window) */
  'message:edit': (
    payload: MessageEditPayload,
    ack: AckCallback<void>,
  ) => void;

  /** Delete own message as tombstone (R20: soft-delete) */
  'message:delete': (
    payload: MessageDeletePayload,
    ack: AckCallback<void>,
  ) => void;

  /** Acknowledge message delivery (fire-and-forget) */
  'message:delivered': (payload: MessageDeliveredPayload) => void;

  /** Acknowledge batch message read (fire-and-forget) */
  'message:read': (payload: MessageReadPayload) => void;

  /** Start typing indicator (R25: max 10/min, server debounces at 3s) */
  'typing:start': (payload: TypingStartPayload) => void;

  /** Stop typing indicator */
  'typing:stop': (payload: TypingStopPayload) => void;

  /** Request missed messages for offline reconciliation (R13) */
  'message:sync': (
    payload: MessageSyncRequestPayload,
    ack: AckCallback<MessageSyncResponsePayload>,
  ) => void;
}

/**
 * ServerToClientEvents — all events the server broadcasts to the client.
 *
 * Used as the second generic type parameter in Socket.IO's Server and Socket types.
 * All events are fire-and-forget from the server's perspective — the client
 * does not send acknowledgments for server-initiated events.
 */
export interface ServerToClientEvents {
  /** New message broadcast to conversation participants */
  'message:new': (payload: MessageNewPayload) => void;

  /** Edited message broadcast to conversation participants (R19) */
  'message:edited': (payload: MessageEditedPayload) => void;

  /** Deleted message tombstone broadcast to conversation participants (R20) */
  'message:deleted': (payload: MessageDeletedPayload) => void;

  /** Message delivery/read status update broadcast to sender */
  'message:status': (payload: MessageStatusPayload) => void;

  /** Typing indicator broadcast to conversation participants */
  'typing:indicator': (payload: TypingIndicatorPayload) => void;

  /** User presence (online/offline) broadcast */
  'user:presence': (payload: UserPresencePayload) => void;

  /** Offline sync response with missed messages (R13) */
  'message:sync:response': (payload: MessageSyncResponsePayload) => void;

  /** Link preview OG metadata broadcast after async extraction */
  'link:preview': (payload: LinkPreviewPayload) => void;

  /** Connection-level error (auth failure, rate limit, server error) */
  'connection:error': (payload: ConnectionErrorPayload) => void;
}

/**
 * InterServerEvents — events between Socket.IO server instances.
 *
 * Used for cross-instance communication via the Redis adapter when
 * horizontally scaling the WebSocket layer. Currently only includes
 * a health check ping.
 *
 * Used as the third generic type parameter in Socket.IO's Server type.
 */
export interface InterServerEvents {
  /** Health check ping between server instances */
  ping: () => void;
}

/**
 * SocketData — per-connection data stored on the socket instance.
 *
 * Populated during the WebSocket authentication middleware handshake.
 * Available via `socket.data.userId` and `socket.data.correlationId`
 * throughout the connection lifecycle.
 *
 * Used as the fourth generic type parameter in Socket.IO's Server type.
 */
export interface SocketData {
  /** Authenticated user ID extracted from JWT during handshake */
  userId: string;

  /** Authenticated user's display name extracted from JWT during handshake */
  displayName: string;

  /** UUID v4 correlation ID assigned during connection setup (R29) */
  correlationId: string;
}
