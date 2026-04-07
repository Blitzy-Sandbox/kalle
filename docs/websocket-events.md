# WebSocket Event Contracts

Complete documentation of all WebSocket event contracts for real-time communication in the Kalle WhatsApp clone. This document covers connection setup, authentication, event payloads, rate limiting, and the offline sync protocol.

All event payload TypeScript types are defined in [`packages/shared/src/types/websocket-events.ts`](../packages/shared/src/types/websocket-events.ts).

> **Related documentation:**
>
> - [Architecture Overview](./architecture.md)
> - [REST API Reference](./api-reference.md) — REST counterparts for message, conversation, and user endpoints
> - [End-to-End Encryption](./encryption.md) — details on ciphertext generation, Signal Protocol sessions, and Sender Key distribution

---

## Table of Contents

- [Connection Setup](#connection-setup)
- [Authentication](#authentication)
- [Rate Limiting](#rate-limiting)
- [Message Events](#message-events)
- [Typing Events](#typing-events)
- [Presence Events](#presence-events)
- [Offline Sync Protocol](#offline-sync-protocol)
- [Link Preview Events](#link-preview-events)
- [Correlation IDs](#correlation-ids)
- [Error Events](#error-events)
- [Event Summary Table](#event-summary-table)
- [Implementation Files](#implementation-files)

---

## Connection Setup

Real-time communication is powered by **Socket.IO 4.x** running on the same HTTP server as the Express REST API. Horizontal scaling is achieved via the **`@socket.io/redis-adapter`**, which synchronizes events across multiple API server instances through Redis Pub/Sub.

### Server Details

| Property            | Value                                                      |
| ------------------- | ---------------------------------------------------------- |
| **URL**             | `ws://localhost:3001` (same origin as REST API)            |
| **Transports**      | WebSocket (primary), HTTP long-polling (fallback)          |
| **Path**            | `/socket.io/` (Socket.IO default)                         |
| **Redis Adapter**   | `@socket.io/redis-adapter` for cross-server session sharing |
| **Ping Interval**   | 25 000 ms                                                 |
| **Ping Timeout**    | 20 000 ms                                                 |

### Client Connection Example

```typescript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3001', {
  auth: {
    token: `Bearer ${accessToken}`,
  },
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});
```

### Key Implementation Files

| Role   | File                                    |
| ------ | --------------------------------------- |
| Server | `apps/api/src/websocket/index.ts`       |
| Client | `apps/web/src/lib/socket.ts`            |

### Rooms and Namespaces

- The server uses the **default namespace** (`/`).
- Upon successful authentication, the server joins the socket to a **user-specific room** named `user:<userId>` for direct event delivery.
- The server also joins the socket to every **conversation room** the user participates in, named `conversation:<conversationId>`.
- Room membership is updated in real time when conversations are created, users are added/removed from groups, or conversations are archived/deleted.

---

## Authentication

All WebSocket connections require a valid JWT access token (**Rule R9**). Unauthenticated connection attempts are rejected immediately.

### Connection Handshake

1. **Client** initiates the connection with the JWT in the `auth` option:

   ```typescript
   const socket = io('http://localhost:3001', {
     auth: {
       token: 'Bearer <jwt_access_token>',
     },
   });
   ```

2. **Server middleware** (`apps/api/src/websocket/middleware/ws-auth.ts`) processes the handshake:

   | Step | Action                                                               |
   | ---- | -------------------------------------------------------------------- |
   | 1    | Extract the JWT string from `socket.handshake.auth.token`            |
   | 2    | Strip the `Bearer ` prefix and verify the token (expiry, signature)  |
   | 3    | Check the Redis token blacklist for revoked tokens (**Rule R33**)    |
   | 4    | Attach the authenticated user context (`userId`, `email`) to `socket.data` |
   | 5    | Call `next()` on success, or `next(new Error('authentication_error'))` on failure |

3. **On failure**, the client receives a `connect_error` event with the message `authentication_error`. The socket is **not** connected.

4. **On token expiry during an active session**, the server will reject the next connection attempt. The client should:
   1. Detect disconnection or `connect_error` from the server.
   2. Refresh the access token via `POST /api/v1/auth/refresh` (see [API Reference](./api-reference.md)).
   3. Reconnect with the new access token in the `auth` option.

### Session Revocation

Per **Rule R33**, revoked access tokens are blacklisted in Redis keyed by JTI (JWT ID) with a TTL equal to the token's remaining expiry time. The WebSocket auth middleware checks this blacklist on every new connection. Active sockets for a revoked token are forcibly disconnected when `revoke` or `revoke-all` is triggered via the REST API.

---

## Rate Limiting

Per-connection rate limiting is enforced by the server middleware at `apps/api/src/websocket/middleware/ws-rate-limiter.ts` to prevent abuse and ensure fair resource usage (**Rule R25**).

### Rate Limit Table

| Event Category      | Event(s)           | Max Rate    | Action on Exceed                          |
| ------------------- | ------------------ | ----------- | ----------------------------------------- |
| Message send        | `message:send`     | 30 / minute | Disconnect with `RATE_LIMIT_EXCEEDED` code |
| Typing indicator    | `typing:start`     | 10 / minute | Disconnect with `RATE_LIMIT_EXCEEDED` code |
| All other events    | *(everything else)* | 60 / minute | Disconnect with `RATE_LIMIT_EXCEEDED` code |

### Behavior on Exceeding Limits

When a client exceeds any rate limit:

1. The server emits a `connection:error` event with code `RATE_LIMIT_EXCEEDED` and a human-readable message indicating which limit was exceeded.
2. The server **forcibly disconnects** the socket.
3. The client may reconnect after a back-off period — the recommended minimum is 5 seconds.

### Rate Limit Window

Rate limits use a **sliding window** algorithm tracked per socket connection. Counters reset when the connection is closed. A new connection starts with a fresh counter.

---

## Message Events

All message events are handled by `apps/api/src/websocket/handlers/message-handler.ts`. Message content is always **end-to-end encrypted** — the server stores and transmits only ciphertext and **never performs decryption** (**Rule R12**). See [End-to-End Encryption](./encryption.md) for details on how ciphertext is produced and consumed.

### `message:send`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Client → Server      |
| Purpose   | Send an encrypted message to a conversation |
| Rate Limit | 30 / minute         |

**Payload:**

```typescript
{
  // EventMetadata fields (included in all event payloads):
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  conversationId: string;      // UUID of the target conversation
  ciphertext: string;          // Base64-encoded encrypted message content
  type: MessageType;           // Message type: "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "VOICE_NOTE"
  clientMessageId: string;     // Client-generated UUID for deduplication
  replyToMessageId?: string;   // Optional: UUID of the message being replied to
  mediaId?: string;            // Optional: UUID of already-uploaded media attachment
}
```

**Server Behavior:**

1. Validates the payload fields (non-empty `conversationId`, `ciphertext`, `clientMessageId`).
2. Verifies the sender is a participant of the conversation.
3. Persists the message row with ciphertext in the `Message` table. The server **never** decrypts the content (**Rule R12**).
4. **1:1 conversations:** Emits `message:new` directly to the recipient's socket room.
5. **Group conversations (3+ participants):** Enqueues a BullMQ `message-fanout` job for asynchronous delivery to all participants (**Rule R18**). The event returns to the sender **before** all deliveries complete.
6. **Acknowledges** the sender via the Socket.IO **acknowledgment callback** (`AckCallback<MessageResponse>`) with the full persisted message including the server-assigned `id` and `serverTimestamp`. There is no separate `message:sent` event — the ack callback serves this purpose.
7. If the message body contains URLs, enqueues a BullMQ `link-preview` job for asynchronous OG metadata extraction.

---

### `message:new`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Server → Client      |
| Purpose   | Deliver a new message to the recipient(s) |

**Payload:**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  // Payload:
  message: {                   // Full MessageResponse object
    id: string;                // Server-assigned UUID
    conversationId: string;    // UUID of the conversation
    senderId: string;          // UUID of the message author
    senderName: string;        // Display name of the sender
    senderAvatar?: string;     // Avatar URL of the sender (optional)
    ciphertext: string | null; // Base64-encoded encrypted content (null if deleted)
    type: MessageType;         // "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "VOICE_NOTE"
    status: MessageStatusEnum; // "SENT" | "DELIVERED" | "READ"
    replyTo?: ReplyToMessage;  // Quoted message reference (optional)
    mediaId?: string;          // UUID of attached media (optional)
    linkPreview?: LinkPreviewData; // OG metadata if URLs detected (optional)
    isEdited: boolean;         // Whether the message has been edited
    isDeleted: boolean;        // Whether the message has been soft-deleted
    editedAt?: string;         // ISO 8601 edit timestamp (optional)
    deletedAt?: string;        // ISO 8601 deletion timestamp (optional)
    clientMessageId: string;   // Original client-generated UUID
    serverTimestamp: string;   // ISO 8601 UTC timestamp assigned by server
    createdAt: string;         // ISO 8601 creation timestamp
  }
}
```

**Client Behavior:**

1. Decrypt the `ciphertext` using the appropriate Signal Protocol session (1:1) or Sender Key session (group). See [encryption.md](./encryption.md).
2. Store the decrypted plaintext in the local IndexedDB index (via Dexie.js) for client-side search (**Rule R21**).
3. Display the message in the conversation view.
4. Emit `message:delivered` back to the server to confirm receipt.

---

### Acknowledgment Callback (`AckCallback`)

| Property  | Value                     |
| --------- | ------------------------- |
| Direction | Server → Client (inline acknowledgment) |
| Purpose   | Confirm the server received and stored the message |

The `message:send` event uses Socket.IO's built-in acknowledgment mechanism (`AckCallback<MessageResponse>`) instead of a separate event. The server invokes the ack callback with:

**Success Response:**

```typescript
{
  success: true,
  data: MessageResponse   // Full persisted message object (see MessageResponse type)
}
```

**Failure Response:**

```typescript
{
  success: false,
  error: {
    code: string,         // Error code (e.g., "VALIDATION_ERROR", "RATE_LIMIT")
    message: string       // Human-readable error description
  }
}
```

**Client Behavior on Ack:**

1. Match the `clientMessageId` in the returned `MessageResponse` to the locally-queued optimistic message.
2. Replace the temporary client ID with the permanent server-assigned `id`.
3. Update the message timestamp to `serverTimestamp`.
4. Display a single gray checkmark (✓) indicating the message was sent.


### `message:edit`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Client → Server      |
| Purpose   | Edit a previously sent message |

**Payload:**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  messageId: string;           // UUID of the message to edit
  ciphertext: string;          // New Base64-encoded encrypted content
}
```

**Server Behavior:**

1. Validates that the authenticated user is the **sender** of the message.
2. Validates the message was sent within the last **15 minutes** (**Rule R19**). Rejects with `FORBIDDEN` if the window has elapsed.
3. **Replaces** the stored ciphertext with the new value. The original ciphertext is **not retained** (**Rule R19**).
4. Sets the `editedAt` timestamp on the message row.
5. Emits `message:edited` to **all** participants in the conversation.

**Error Responses:**

| Condition                   | Error Code     | HTTP-Equivalent |
| --------------------------- | -------------- | --------------- |
| Message not found           | `NOT_FOUND`    | 404             |
| Not the message sender      | `FORBIDDEN`    | 403             |
| Edit window expired (>15 min) | `FORBIDDEN`  | 403             |

---

### `message:edited`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Server → Client      |
| Purpose   | Notify all participants that a message was edited |

**Payload:**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  messageId: string;           // UUID of the edited message
  conversationId: string;      // UUID of the conversation
  ciphertext: string;          // New Base64-encoded encrypted content
  editedAt: string;            // ISO 8601 UTC timestamp of the edit
}
```

**Client Behavior:**

1. Decrypt the new `ciphertext`.
2. Replace the message content in the local view and IndexedDB index.
3. Display an "edited" indicator on the message bubble.

---

### `message:delete`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Client → Server      |
| Purpose   | Soft-delete a message (tombstone) |

**Payload:**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  messageId: string;           // UUID of the message to delete
}
```

**Server Behavior:**

1. Validates that the authenticated user is the **sender** of the message.
2. Performs a **soft delete**: sets the `ciphertext` column to `NULL` (tombstone). The message row is **retained** in the database (**Rule R20**).
3. Sets the `deletedAt` timestamp on the message row.
4. Emits `message:deleted` to **all** participants in the conversation.
5. Writes an audit log entry for the deletion (**Rule R32**).

---

### `message:deleted`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Server → Client      |
| Purpose   | Notify all participants that a message was deleted |

**Payload:**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  messageId: string;           // UUID of the deleted message
  conversationId: string;      // UUID of the conversation
  deletedAt: string;           // ISO 8601 UTC timestamp of the deletion
}
```

**Client Behavior:**

1. Remove the decrypted content from the local IndexedDB search index.
2. Replace the message bubble content with the text **"This message was deleted"** (rendered in italics, gray text).
3. Remove any media preview associated with the message.

---

### `message:delivered`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Client → Server      |
| Purpose   | Acknowledge that the message was delivered to the client's device |

**Payload:**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  messageId: string;           // UUID of the delivered message
  conversationId: string;      // UUID of the conversation
}
```

**Server Behavior:**

1. Updates the `MessageStatus` record for this user + message to `DELIVERED`.
2. Emits a `message:status` event to the **sender's** socket room so the sender can update the message status indicator from single checkmark (✓) to double gray checkmark (✓✓).

---

### `message:read`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Client → Server      |
| Purpose   | Mark a message as read by the recipient |

**Payload:**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  messageIds: string[];        // Array of UUIDs of the read messages (batch operation)
  conversationId: string;      // UUID of the conversation
}
```

**Server Behavior:**

1. Updates the `MessageStatus` records for this user + all messages in the `messageIds` array to `READ`.
2. Emits `message:status` events to the **sender's** socket room.
3. The sender's client updates the message status indicators to **blue double checkmarks** (✓✓).

**Status Indicator Lifecycle:**

| Status      | Visual Indicator              | Trigger                  |
| ----------- | ----------------------------- | ------------------------ |
| `SENT`      | Single gray checkmark (✓)     | Acknowledgment callback received |
| `DELIVERED` | Double gray checkmark (✓✓)    | `message:delivered` sent by recipient |
| `READ`      | Double blue checkmark (✓✓)    | `message:read` sent by recipient |

---

### `message:status`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Server → Client      |
| Purpose   | Notify the sender about a delivery or read status change on their message |

**Payload (`MessageStatusPayload`):**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  messageId: string;           // UUID of the message
  conversationId: string;      // UUID of the conversation
  userId: string;              // UUID of the user who triggered the status change
  status: MessageStatusEnum;   // "SENT" | "DELIVERED" | "READ"
}
```

**Client Behavior:**

1. Match the `messageId` in the current conversation view.
2. Update the message status indicator:
   - `DELIVERED` → Double gray checkmark (✓✓)
   - `READ` → Double blue checkmark (✓✓)
3. In group conversations, aggregate `message:status` events from multiple recipients.

**Trigger:** This event is emitted by the server when it receives `message:delivered` or `message:read` from a recipient. The sender receives this event to update their UI.

---

## Typing Events

Typing indicators provide real-time feedback when a user is composing a message. Events are handled by `apps/api/src/websocket/handlers/typing-handler.ts`.

### `typing:start`

| Property   | Value                |
| ---------- | -------------------- |
| Direction  | Client → Server      |
| Purpose    | Signal that the user has started typing in a conversation |
| Rate Limit | 10 / minute          |

**Payload:**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  conversationId: string;      // UUID of the conversation
}
```

**Server Behavior:**

1. **TTL-based suppression:** The server uses a Redis key `typing:{conversationId}:{userId}` with a **5-second TTL** (set via `setNx`). If the key already exists (within the suppression window), re-emission is suppressed and only the TTL is refreshed. If the key does not exist, it is set and a `typing:indicator` event is broadcast.
2. Emits `typing:indicator` (with `isTyping: true`) to all **other** participants in the conversation room (only on first event within the suppression window).
3. **Note:** The server does **not** automatically emit `isTyping: false` when the TTL expires. The client is responsible for timing out the typing indicator locally (recommended: 5-second timeout on the client side).

---

### `typing:stop`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Client → Server      |
| Purpose   | Signal that the user has stopped typing |

**Payload:**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  conversationId: string;      // UUID of the conversation
}
```

**Server Behavior:**

1. Deletes the Redis typing key (`typing:{conversationId}:{userId}`) for this user + conversation.
2. Immediately emits `typing:indicator` (with `isTyping: false`) to all other participants in the conversation room.

---

### `typing:indicator`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Server → Client      |
| Purpose   | Notify participants about a user's typing state |

**Payload:**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  conversationId: string;      // UUID of the conversation
  userId: string;              // UUID of the user who is typing (or stopped)
  displayName: string;         // Display name of the typing user
  isTyping: boolean;           // true = typing, false = stopped
}
```

**Client Behavior:**

1. When `isTyping` is `true`: Display the typing animation indicator (three animated dots) below the conversation's last message or in the chat header subtitle area.
2. When `isTyping` is `false`: Remove the typing animation indicator.
3. In group conversations, the client may display multiple concurrent typing indicators (e.g., "Alice and Bob are typing…").

---

## Presence Events

Presence tracking provides online/offline status and last-seen timestamps for contacts. Events are handled by `apps/api/src/websocket/handlers/presence-handler.ts`.

### `user:presence`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Server → Client      |
| Purpose   | Broadcast a user's online/offline status to their contacts |

**Payload:**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  userId: string;              // UUID of the user whose presence changed
  status: PresenceStatus;      // "ONLINE" | "OFFLINE" (UPPERCASE enum)
  lastSeen?: string;           // ISO 8601 UTC timestamp — present only when status is "OFFLINE"
}
```

**Server Behavior — On Connect:**

1. Mark the user as **online** in the Redis presence cache (key: `presence:<userId>`, value: `online`).
2. Broadcast `user:presence` with `status: 'online'` to all socket rooms of users who have this user in their contact list.

**Server Behavior — On Disconnect:**

1. Mark the user as **offline** in the Redis presence cache.
2. Set the `lastSeen` timestamp to the current UTC time.
3. Broadcast `user:presence` with `status: 'offline'` and `lastSeen` to all socket rooms of users who have this user in their contact list.

**Client Behavior:**

1. Update the Zustand `presenceStore` with the received status.
2. Display "online" or "last seen <relative time>" below the contact name in the chat header and contact info views.

### Presence Query on Connect

When a client first connects, it does **not** receive a bulk presence dump. Instead, the client relies on incremental `user:presence` updates as contacts come online/go offline. There is no dedicated REST endpoint for presence queries — presence is managed entirely through the WebSocket layer.

---

## Offline Sync Protocol

The offline sync protocol ensures **zero message loss** when a client reconnects after a period of disconnection (**Rule R13**). All missed messages must arrive in send order within **3 seconds** of reconnection (**Rules R4, R13**).

Handler: `apps/api/src/websocket/handlers/sync-handler.ts`

### `message:sync`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Client → Server      |
| Purpose   | Request all messages missed during the offline period |

**Payload:**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  lastMessageIds: Record<string, string>;
  // Map of conversationId → lastKnownMessageId
  // Example:
  // {
  //   "conv-uuid-1": "msg-uuid-42",
  //   "conv-uuid-2": "msg-uuid-99"
  // }
}
```

**When to Send:**

The client emits `message:sync` immediately after a successful reconnection (i.e., after the `connect` event fires following a period of disconnection). The `lastMessageIds` map is built from the client's local IndexedDB message store — one entry per conversation containing the most recent `messageId` the client has already received and processed.

**Server Behavior:**

1. For **each conversation** in the `lastMessageIds` map:
   - Verify the user is a participant of the conversation.
   - Fetch all messages with a `serverTimestamp` **after** the message identified by `lastKnownMessageId`.
2. Aggregate all missed messages across all conversations.
3. Sort messages by `serverTimestamp` in ascending order (send order — **Rule R4**).
4. Invoke the **acknowledgment callback** (`AckCallback<MessageSyncResponsePayload>`) with the complete list. The sync uses Socket.IO's ack mechanism — there is **no separate `message:sync:response` event** emitted.
5. All missed messages must be delivered within **3 seconds** (**Rule R13**). If the result set is very large, the response includes `hasMore: true` to indicate additional data.

---

### Sync Response (via Acknowledgment Callback)

| Property  | Value                |
| --------- | -------------------- |
| Direction | Server → Client (ack callback, not a separate event) |
| Purpose   | Deliver all missed messages after an offline period |

> **Note:** The sync response is delivered through the `message:sync` acknowledgment callback, not as a separate `message:sync:response` event. The server handler invokes `ack({ success: true, data: ... })`.

**Ack Callback Payload (`MessageSyncResponsePayload`):**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  messages: MessageResponse[];  // Array of full MessageResponse objects (see Message Events)
  // Each MessageResponse includes: id, conversationId, senderId, senderName,
  // senderAvatar?, ciphertext, type, status, replyTo?, mediaId?, linkPreview?,
  // isEdited, isDeleted, editedAt?, deletedAt?, clientMessageId, serverTimestamp, createdAt
  hasMore: boolean;             // true if additional pages of sync data exist
}
```

**Client Behavior:**

1. Process messages in the order received (already sorted by `serverTimestamp`).
2. For each message:
   - If `isDeleted` is `true` and `ciphertext` is `null`: render as "This message was deleted."
   - If `isEdited` is `true`: decrypt and render with an "edited" indicator.
   - Otherwise: decrypt `ciphertext` and render normally.
3. Store all decrypted messages in the local IndexedDB search index.
4. Emit `message:delivered` for each newly received message.
5. If `hasMore` is `true`, the client may emit another `message:sync` to fetch the next page.

### Deduplication

The server uses the `clientMessageId` field to prevent duplicate message delivery. If the client already has a message matching a given `clientMessageId` in its local store, it should skip processing that message.

---

## Link Preview Events

Link previews are generated **asynchronously** via BullMQ jobs. When a message containing URLs is sent, the server enqueues a `link-preview` job that extracts Open Graph (OG) metadata from the target URL. Once extraction completes, the result is pushed to the conversation participants via WebSocket.

### `link:preview`

| Property  | Value                |
| --------- | -------------------- |
| Direction | Server → Client      |
| Purpose   | Deliver extracted OG metadata for a URL found in a message |

**Payload:**

```typescript
{
  // EventMetadata fields:
  correlationId: string;       // UUID v4 correlation ID for request tracing
  timestamp: string;           // ISO 8601 UTC timestamp of the event

  messageId: string;           // UUID of the message containing the URL
  conversationId: string;      // UUID of the conversation
  url: string;                 // The original URL that was resolved
  title?: string;              // OG title tag value
  description?: string;        // OG description tag value
  imageUrl?: string;           // OG image URL (may be a proxied URL)
  siteName?: string;           // OG site_name tag value
}
```

**Client Behavior:**

1. Match the `messageId` to a message in the current conversation view.
2. Render a link preview card below the message content showing the title, description, and optional thumbnail image.
3. If the message is not currently visible (scrolled away), cache the preview data locally so it renders when the user scrolls to the message.

**Notes:**

- Link preview extraction is performed **server-side** using the `open-graph-scraper` library. This is the one case where the server processes message-related metadata — however, link preview extraction operates on the **URL** (found via a regex match on plaintext URLs before encryption or passed as metadata), **not** on the encrypted message content. The E2E encryption integrity (**Rule R12**) is maintained because the server never decrypts the ciphertext itself.
- If OG extraction fails (timeout, invalid URL, blocked by robots.txt), no `link:preview` event is emitted.
- The BullMQ `link-preview` job has a 10-second timeout per URL.

---

## Correlation IDs

Per **Rule R29**, every WebSocket connection and its associated events are tagged with a **UUID v4 correlation ID** for distributed tracing and debugging.

### Assignment

1. When a WebSocket connection is established, the server generates a UUID v4 correlation ID and stores it on `socket.data.correlationId`.
2. If the client passes an `X-Correlation-ID` header in the initial handshake, the server uses that value instead of generating a new one. This allows the client to trace a flow end-to-end from a REST call through a WebSocket event.

### Propagation

The correlation ID appears in:

| Context                     | How It Appears                                                |
| --------------------------- | ------------------------------------------------------------- |
| **Server log entries**      | Injected into the Pino logger child context for every event handler invocation |
| **Error event payloads**    | Included as `correlationId` field in the error event payload  |
| **BullMQ job payloads**     | Passed in the job data so worker logs can reference the originating request |
| **Response headers**        | Returned as `X-Correlation-ID` header on any HTTP fallback transport responses |

### Example Log Entry

```json
{
  "level": 30,
  "time": 1711900000000,
  "correlationId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "userId": "user-uuid-123",
  "event": "message:send",
  "conversationId": "conv-uuid-456",
  "msg": "Message received and persisted"
}
```

---

## Error Events

All WebSocket error events follow the same standardized shape as REST API errors (**Rule R22**). Errors are emitted on the `connection:error` event channel.

### Error Payload Shape (`ConnectionErrorPayload`)

```typescript
{
  code: string;                // Machine-readable error code (e.g., "RATE_LIMIT_EXCEEDED", "AUTHENTICATION_ERROR")
  message: string;             // Human-readable error description
}
```

> **Note:** Unlike other event payloads, `ConnectionErrorPayload` does **not** extend `EventMetadata` — it contains only `code` and `message` fields.

### Error Code Reference

| Error Code               | Description                                             | Typical Trigger                              |
| ------------------------ | ------------------------------------------------------- | -------------------------------------------- |
| `AUTHENTICATION_ERROR`   | JWT is invalid, expired, or revoked                     | Invalid token on connect; revoked token (R33) |
| `RATE_LIMIT_EXCEEDED`    | Per-connection rate limit exceeded                      | Too many events in the sliding window (R25)  |
| `VALIDATION_ERROR`       | Event payload failed Zod schema validation              | Missing or malformed fields in event data    |
| `NOT_FOUND`              | Referenced resource does not exist                      | Unknown `messageId`, `conversationId`        |
| `FORBIDDEN`              | User lacks permission for the requested action          | Editing another user's message; expired edit window (R19) |
| `INTERNAL_ERROR`         | Unexpected server-side failure                          | Database connection loss; unhandled exception |

### Error Handling Best Practices (Client)

1. **`AUTHENTICATION_ERROR`**: Attempt to refresh the access token. If refresh succeeds, reconnect. If refresh fails, redirect to login.
2. **`RATE_LIMIT_EXCEEDED`**: Back off for at least 5 seconds before reconnecting. Implement exponential back-off on repeated disconnections.
3. **`VALIDATION_ERROR`**: Log the error and review the event payload construction. This indicates a client-side bug.
4. **`NOT_FOUND`** / **`FORBIDDEN`**: Display an appropriate user-facing error message. Do not retry the same operation.
5. **`INTERNAL_ERROR`**: Retry with exponential back-off (max 3 retries). If persistent, surface a "connection issue" banner in the UI.

---

## Event Summary Table

A complete reference of all WebSocket events, their direction, and associated rate limits.

| Event                    | Direction        | Category  | Rate Limit  | Description                                 |
| ------------------------ | ---------------- | --------- | ----------- | ------------------------------------------- |
| `message:send`           | Client → Server  | Message   | 30/min      | Send an encrypted message (ack: `MessageResponse`) |
| `message:new`            | Server → Client  | Message   | —           | Deliver a new message to recipient(s)       |
| `message:status`         | Server → Client  | Status    | —           | Notify sender of delivery/read status change |
| `message:edit`           | Client → Server  | Message   | 60/min      | Edit a sent message (15-min window, ack: `void`) |
| `message:edited`         | Server → Client  | Message   | —           | Notify participants of an edit              |
| `message:delete`         | Client → Server  | Message   | 60/min      | Soft-delete a sent message (ack: `void`)    |
| `message:deleted`        | Server → Client  | Message   | —           | Notify participants of a deletion           |
| `message:delivered`      | Client → Server  | Status    | 60/min      | Confirm message delivery to device          |
| `message:read`           | Client → Server  | Status    | 60/min      | Mark messages as read (batch)               |
| `typing:start`           | Client → Server  | Typing    | 10/min      | Signal typing started                       |
| `typing:stop`            | Client → Server  | Typing    | 60/min      | Signal typing stopped                       |
| `typing:indicator`       | Server → Client  | Typing    | —           | Broadcast typing state to participants      |
| `user:presence`          | Server → Client  | Presence  | —           | Broadcast online/offline status             |
| `message:sync`           | Client → Server  | Sync      | 60/min      | Request missed messages (ack: sync response) |
| `link:preview`           | Server → Client  | Preview   | —           | Deliver extracted link OG metadata          |
| `connection:error`       | Server → Client  | Error     | —           | Deliver error information                   |

**Legend:**
- **Client → Server**: Events emitted by the client socket and handled by the server.
- **Server → Client**: Events emitted by the server and handled by the client.
- **Rate Limit "—"**: Server-originated events are not rate-limited at the client.

---

## Implementation Files

A complete mapping of all source files involved in the WebSocket real-time communication layer.

### Server-Side

| File                                                            | Purpose                                          |
| --------------------------------------------------------------- | ------------------------------------------------ |
| `packages/shared/src/types/websocket-events.ts`                | All WebSocket event payload TypeScript type contracts |
| `apps/api/src/websocket/index.ts`                               | Socket.IO server setup with Redis adapter        |
| `apps/api/src/websocket/handlers/message-handler.ts`            | Message event handlers (`message:*`)             |
| `apps/api/src/websocket/handlers/typing-handler.ts`             | Typing indicator handlers with 5s TTL-based suppression |
| `apps/api/src/websocket/handlers/presence-handler.ts`           | Presence (online/offline) handlers               |
| `apps/api/src/websocket/handlers/sync-handler.ts`               | Offline sync handler (`message:sync`)            |
| `apps/api/src/websocket/middleware/ws-auth.ts`                   | WebSocket JWT authentication middleware          |
| `apps/api/src/websocket/middleware/ws-rate-limiter.ts`           | Per-connection sliding-window rate limiting       |
| `apps/api/src/providers/RealtimeProvider.ts`                     | Socket.IO + Redis adapter provider abstraction   |
| `apps/api/src/services/MessageService.ts`                        | Message business logic (send, edit, delete, history) |
| `apps/api/src/services/AuditService.ts`                          | Audit log writes for security-sensitive message actions |
| `workers/queue/src/jobs/message-fanout.ts`                       | BullMQ job: group message delivery fan-out       |
| `workers/queue/src/jobs/link-preview.ts`                         | BullMQ job: URL OG metadata extraction           |

### Client-Side

| File                                          | Purpose                                        |
| --------------------------------------------- | ---------------------------------------------- |
| `apps/web/src/lib/socket.ts`                  | Socket.IO client singleton with auto-reconnect |
| `apps/web/src/hooks/useSocket.ts`             | React hook for Socket.IO connection management |
| `apps/web/src/hooks/usePresence.ts`           | React hook for presence subscription and state |
| `apps/web/src/hooks/useMessages.ts`           | React hook for message send/receive/edit/delete |
| `apps/web/src/stores/chatStore.ts`            | Zustand store for conversations and messages   |
| `apps/web/src/stores/presenceStore.ts`        | Zustand store for online/offline/typing state  |
| `apps/web/src/lib/encryption.ts`              | Signal Protocol wrapper for encrypt/decrypt    |
| `apps/web/src/lib/db.ts`                      | Dexie.js IndexedDB schema for message index    |

---

## Rules Reference

This document enforces and references the following project rules:

| Rule   | Summary                                                                 | Sections                        |
| ------ | ----------------------------------------------------------------------- | ------------------------------- |
| **R4** | Messages arrive in send order with zero drops or duplicates             | Offline Sync Protocol           |
| **R9** | All WebSocket connections require valid JWT                             | Authentication                  |
| **R12** | Server stores/transmits only ciphertext — never decrypts               | Message Events                  |
| **R13** | Client syncs all missed messages on reconnect within 3 seconds         | Offline Sync Protocol           |
| **R18** | Group delivery (3+ recipients) goes through BullMQ fan-out             | Message Events (`message:send`) |
| **R19** | Message edit: sender-only, 15-minute window, ciphertext replaced       | Message Events (`message:edit`) |
| **R20** | Message delete: soft-delete tombstone, ciphertext nulled               | Message Events (`message:delete`) |
| **R22** | All errors use single consistent shape                                 | Error Events                    |
| **R25** | Per-connection rate limits (30/10/60 per minute)                       | Rate Limiting                   |
| **R29** | Every connection receives UUID v4 correlation ID                       | Correlation IDs                 |
| **R32** | Security-sensitive actions logged to immutable audit trail             | Message Events (`message:delete`) |
| **R33** | Revoked tokens blacklisted in Redis; auth middleware checks blacklist  | Authentication                  |
