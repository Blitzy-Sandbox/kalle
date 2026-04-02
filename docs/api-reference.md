# REST API Reference

> Comprehensive documentation for all REST API endpoints in the Kalle WhatsApp clone backend.

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Error Responses](#error-responses)
- [Correlation IDs](#correlation-ids)
- [Input Validation](#input-validation)
- [Pagination](#pagination)
- [Auth — `/api/v1/auth`](#auth--apiv1auth)
- [Users — `/api/v1/users`](#users--apiv1users)
- [Conversations — `/api/v1/conversations`](#conversations--apiv1conversations)
- [Messages — `/api/v1/messages`](#messages--apiv1messages)
- [Media — `/api/v1/media`](#media--apiv1media)
- [Stories — `/api/v1/stories`](#stories--apiv1stories)
- [Encryption Keys — `/api/v1/keys`](#encryption-keys--apiv1keys)
- [Health & Metrics — `/api/v1/health`](#health--metrics--apiv1health)
- [Route Registration](#route-registration)
- [Implementation Files](#implementation-files)

---

## Overview

| Property       | Value                              |
| -------------- | ---------------------------------- |
| **Base URL**   | `http://localhost:3001/api/v1/`    |
| **Protocol**   | HTTP/1.1                           |
| **Format**     | JSON (`application/json`)          |
| **Versioning** | URI-prefixed — all routes under `/api/v1/` (Rule R30) |

All request and response bodies use `application/json` unless explicitly noted otherwise. The media upload endpoint (`POST /api/v1/media/upload`) accepts `multipart/form-data`.

Real-time message delivery occurs over WebSocket (Socket.IO). See [`websocket-events.md`](./websocket-events.md) for the full event contract. REST endpoints documented here cover resource CRUD, history retrieval, and lifecycle operations.

---

## Authentication

All endpoints require a valid JWT Bearer token in the `Authorization` header **except** the following public routes:

| Public Endpoint              | Purpose              |
| ---------------------------- | -------------------- |
| `POST /api/v1/auth/register` | Account registration |
| `POST /api/v1/auth/login`    | User login           |
| `GET /api/v1/health`         | Health check         |

**Header format:**

```
Authorization: Bearer <access_token>
```

**Verification flow (Rule R9):**

1. Extract JWT from `Authorization: Bearer <token>` header.
2. Verify token signature and expiration using the `JWT_SECRET` environment variable.
3. Check the token's JTI (JWT ID) against the Redis blacklist — reject if blacklisted (Rule R33).
4. Attach the authenticated user object to the request context.
5. Proceed to the route handler.

Tokens that fail any step receive a `401 AUTHENTICATION_ERROR` response.

**Implementation:** `apps/api/src/middleware/auth.ts`

---

## Error Responses

All API errors conform to a **single, consistent response shape** (Rule R22). Controllers never craft ad-hoc error formats — the global error handler maps domain errors to this structure.

### Error Shape

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable error description",
    "details": {
      "field": "email",
      "reason": "Invalid email format"
    }
  }
}
```

| Field             | Type     | Required | Description                                         |
| ----------------- | -------- | -------- | --------------------------------------------------- |
| `error.code`      | `string` | Yes      | Machine-readable error code (see table below)       |
| `error.message`   | `string` | Yes      | Human-readable description of the error             |
| `error.details`   | `object` | No       | Additional context (field-level errors, constraints) |

### Error Codes

| HTTP Status | Error Code                | Domain Error Class           | Description                                   |
| ----------- | ------------------------- | ---------------------------- | --------------------------------------------- |
| 400         | `VALIDATION_ERROR`        | `ValidationError`            | Request body, query, or path param invalid    |
| 401         | `AUTHENTICATION_ERROR`    | `AuthenticationError`        | Missing, expired, or blacklisted JWT          |
| 403         | `AUTHORIZATION_ERROR`     | `AuthorizationError`         | Authenticated but insufficient permissions    |
| 404         | `NOT_FOUND`               | `NotFoundError`              | Requested resource does not exist             |
| 409         | `CONFLICT`                | `ConflictError`              | Duplicate resource (e.g., email already used) |
| 413         | `PAYLOAD_TOO_LARGE`       | `PayloadTooLargeError`       | File exceeds 25 MB upload limit               |
| 415         | `UNSUPPORTED_MEDIA_TYPE`  | `UnsupportedMediaTypeError`  | MIME type not in server allowlist              |
| 429         | `RATE_LIMIT_EXCEEDED`     | `RateLimitError`             | Too many requests from this client            |
| 500         | `INTERNAL_ERROR`          | *(unhandled)*                | Unexpected server error                       |

**Error classes:** `apps/api/src/errors/*.ts`
**Global handler:** `apps/api/src/middleware/error-handler.ts`

---

## Correlation IDs

Every HTTP request is assigned a **UUID v4 correlation ID** for end-to-end tracing (Rule R29).

| Behavior                         | Detail                                                                 |
| -------------------------------- | ---------------------------------------------------------------------- |
| **Assignment**                   | Server generates a UUID v4 if the client does not provide one          |
| **Client override**              | Send `X-Correlation-ID` request header to propagate your own ID        |
| **Response header**              | Always returned as `X-Correlation-ID` in every HTTP response           |
| **Log entries**                  | Every Pino log line includes the correlation ID                        |
| **Error responses**              | The correlation ID is available in the `X-Correlation-ID` header       |
| **Downstream propagation**       | Injected into BullMQ job payloads and Socket.IO event metadata         |

**Implementation:** `apps/api/src/middleware/correlation-id.ts`

---

## Input Validation

Every controller endpoint validates **request body**, **query parameters**, and **path parameters** using Zod schemas before invoking the service layer (Rule R31).

### Validation Behavior

- Invalid input returns **400** with field-level error details.
- No raw, unvalidated user input ever reaches the service layer.
- Validation schemas are defined in route files and reusable schemas live in `packages/shared/src/validators/index.ts`.

### Example Validation Error

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": {
      "issues": [
        {
          "path": ["email"],
          "message": "Invalid email format"
        },
        {
          "path": ["password"],
          "message": "String must contain at least 8 character(s)"
        }
      ]
    }
  }
}
```

**Implementation:** `apps/api/src/middleware/validation.ts`

---

## Pagination

All list endpoints use **cursor-based pagination** for consistent, efficient traversal of large datasets.

### Query Parameters

| Parameter  | Type     | Default | Description                                               |
| ---------- | -------- | ------- | --------------------------------------------------------- |
| `cursor`   | `string` | —       | Opaque cursor from the previous response's `nextCursor`   |
| `limit`    | `number` | varies  | Maximum number of items to return (endpoint-specific max) |
| `direction`| `string` | `before`| Pagination direction: `before` or `after` the cursor      |

### Response Shape

```json
{
  "data": [ ... ],
  "pagination": {
    "nextCursor": "eyJpZCI6IjEyMyJ9",
    "hasMore": true
  }
}
```

| Field                    | Type      | Description                                           |
| ------------------------ | --------- | ----------------------------------------------------- |
| `data`                   | `array`   | Array of result items                                 |
| `pagination.nextCursor`  | `string`  | Cursor to pass in the next request (null if no more)  |
| `pagination.hasMore`     | `boolean` | Whether more results exist beyond this page           |

---

## Auth — `/api/v1/auth`

Authentication endpoints for account registration, login, token management, and session revocation.

| Reference          | Path                                          |
| ------------------ | --------------------------------------------- |
| **Route file**     | `apps/api/src/routes/v1/auth.routes.ts`       |
| **Controller**     | `apps/api/src/controllers/AuthController.ts`  |
| **Service**        | `apps/api/src/services/AuthService.ts`        |

---

### `POST /api/v1/auth/register`

Register a new user account.

**Authentication:** None required

**Request Body:**

```json
{
  "email": "user@example.com",
  "password": "securePassword123!",
  "displayName": "John Doe"
}
```

| Field         | Type     | Required | Constraints                          |
| ------------- | -------- | -------- | ------------------------------------ |
| `email`       | `string` | Yes      | Valid email format, unique           |
| `password`    | `string` | Yes      | Minimum 8 characters                 |
| `displayName` | `string` | Yes      | 1–50 characters                      |

**Response `201 Created`:**

```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "displayName": "John Doe"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Errors:**

| Status | Code              | Condition                     |
| ------ | ----------------- | ----------------------------- |
| 400    | `VALIDATION_ERROR`| Invalid email, short password |
| 409    | `CONFLICT`        | Email already registered      |

**Audit:** `user.register` event written to the audit log (Rule R32).

---

### `POST /api/v1/auth/login`

Authenticate with email and password to receive JWT tokens.

**Authentication:** None required

**Request Body:**

```json
{
  "email": "user@example.com",
  "password": "securePassword123!"
}
```

| Field      | Type     | Required | Constraints        |
| ---------- | -------- | -------- | ------------------ |
| `email`    | `string` | Yes      | Valid email format  |
| `password` | `string` | Yes      | Non-empty string    |

**Response `200 OK`:**

```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "displayName": "John Doe"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Errors:**

| Status | Code                    | Condition                 |
| ------ | ----------------------- | ------------------------- |
| 400    | `VALIDATION_ERROR`      | Missing or malformed body |
| 401    | `AUTHENTICATION_ERROR`  | Invalid credentials       |

**Audit:** `user.login` on success, `user.login_failed` on failure (Rule R32).

---

### `POST /api/v1/auth/refresh`

Exchange a valid refresh token for a new access/refresh token pair. Implements **token rotation** — the consumed refresh token is immediately invalidated.

**Authentication:** Bearer token (refresh token)

**Request Body:**

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

| Field          | Type     | Required | Constraints             |
| -------------- | -------- | -------- | ----------------------- |
| `refreshToken` | `string` | Yes      | Valid, non-expired JWT  |

**Response `200 OK`:**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Errors:**

| Status | Code                    | Condition                             |
| ------ | ----------------------- | ------------------------------------- |
| 401    | `AUTHENTICATION_ERROR`  | Expired, invalid, or revoked refresh token |

---

### `POST /api/v1/auth/revoke`

Revoke the **current session** (single-session logout).

**Authentication:** Required

**Request Body:** None (empty body or `{}`)

**Server Behavior (Rule R33):**

1. Extract the access token's JTI (JWT ID).
2. Add the JTI to the Redis blacklist with a TTL equal to the token's remaining expiry time.
3. Invalidate the associated refresh token in the database.
4. Subsequent requests using the revoked access token receive `401 AUTHENTICATION_ERROR`.

**Response `200 OK`:**

```json
{
  "message": "Session revoked successfully"
}
```

**Audit:** `session.revoke` event written to the audit log (Rule R32).

---

### `POST /api/v1/auth/revoke-all`

Revoke **all active sessions** for the authenticated user (force logout everywhere).

**Authentication:** Required

**Request Body:** None (empty body or `{}`)

**Server Behavior (Rule R33):**

1. Retrieve all active session records for the authenticated user.
2. Add every access token JTI to the Redis blacklist with appropriate TTLs.
3. Invalidate all refresh tokens for the user in the database.
4. All devices and browser sessions are immediately logged out.

**Response `200 OK`:**

```json
{
  "message": "All sessions revoked successfully",
  "revokedCount": 3
}
```

**Audit:** `session.revoke_all` event written to the audit log (Rule R32).

---

## Users — `/api/v1/users`

User profile management, search, and block/unblock operations.

| Reference          | Path                                          |
| ------------------ | --------------------------------------------- |
| **Route file**     | `apps/api/src/routes/v1/user.routes.ts`       |
| **Controller**     | `apps/api/src/controllers/UserController.ts`  |
| **Service**        | `apps/api/src/services/UserService.ts`        |

---

### `GET /api/v1/users/profile`

Retrieve the authenticated user's own profile.

**Authentication:** Required

**Response `200 OK`:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "displayName": "John Doe",
  "avatarUrl": "/media/550e8400-avatar.jpg",
  "about": "Digital goodies designer",
  "phoneNumber": "+1 202 555 0181",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

| Field         | Type     | Nullable | Description                        |
| ------------- | -------- | -------- | ---------------------------------- |
| `id`          | `string` | No       | UUID v4                            |
| `email`       | `string` | No       | Verified email address             |
| `displayName` | `string` | No       | User's chosen display name         |
| `avatarUrl`   | `string` | Yes      | Relative URL to avatar media       |
| `about`       | `string` | Yes      | User bio / status text             |
| `phoneNumber` | `string` | Yes      | Phone number (display only)        |
| `createdAt`   | `string` | No       | ISO 8601 timestamp                 |

---

### `PUT /api/v1/users/profile`

Update the authenticated user's profile. Supports **partial updates** — include only the fields to change.

**Authentication:** Required

**Request Body:**

```json
{
  "displayName": "Jane Doe",
  "about": "Building great things",
  "avatarUrl": "/media/new-avatar.jpg",
  "phoneNumber": "+1 202 555 0199"
}
```

| Field         | Type     | Required | Constraints            |
| ------------- | -------- | -------- | ---------------------- |
| `displayName` | `string` | No       | 1–50 characters        |
| `about`       | `string` | No       | 0–500 characters       |
| `avatarUrl`   | `string` | No       | Valid media URL or null |
| `phoneNumber` | `string` | No       | Valid phone format      |

**Response `200 OK`:** Updated user profile object (same shape as `GET /profile`).

**Errors:**

| Status | Code               | Condition                         |
| ------ | ------------------ | --------------------------------- |
| 400    | `VALIDATION_ERROR` | Invalid field values              |

---

### `GET /api/v1/users/search`

Search users by display name or email. Results are **cursor-paginated** and exclude blocked users.

**Authentication:** Required

**Query Parameters:**

| Parameter | Type     | Required | Default | Constraints              |
| --------- | -------- | -------- | ------- | ------------------------ |
| `q`       | `string` | Yes      | —       | Search term (min 1 char) |
| `cursor`  | `string` | No       | —       | Pagination cursor        |
| `limit`   | `number` | No       | 20      | 1–50                     |

**Response `200 OK`:**

```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "displayName": "John Doe",
      "avatarUrl": "/media/avatar.jpg",
      "about": "Digital goodies designer"
    }
  ],
  "pagination": {
    "nextCursor": "eyJpZCI6IjEyMyJ9",
    "hasMore": true
  }
}
```

---

### `POST /api/v1/users/block`

Block a user. Blocked users cannot send messages to or view the blocker's profile, stories, or presence.

**Authentication:** Required

**Request Body:**

```json
{
  "userId": "660e8400-e29b-41d4-a716-446655440000"
}
```

| Field    | Type     | Required | Constraints |
| -------- | -------- | -------- | ----------- |
| `userId` | `string` | Yes      | Valid UUID  |

**Response `200 OK`:**

```json
{
  "message": "User blocked successfully"
}
```

**Errors:**

| Status | Code         | Condition                    |
| ------ | ------------ | ---------------------------- |
| 404    | `NOT_FOUND`  | Target user does not exist   |
| 409    | `CONFLICT`   | User already blocked         |

**Audit:** `user.block` event written to the audit log (Rule R32).

---

### `POST /api/v1/users/unblock`

Unblock a previously blocked user.

**Authentication:** Required

**Request Body:**

```json
{
  "userId": "660e8400-e29b-41d4-a716-446655440000"
}
```

| Field    | Type     | Required | Constraints |
| -------- | -------- | -------- | ----------- |
| `userId` | `string` | Yes      | Valid UUID  |

**Response `200 OK`:**

```json
{
  "message": "User unblocked successfully"
}
```

**Errors:**

| Status | Code         | Condition                  |
| ------ | ------------ | -------------------------- |
| 404    | `NOT_FOUND`  | Target user does not exist |
| 409    | `CONFLICT`   | User is not blocked        |

**Audit:** `user.unblock` event written to the audit log (Rule R32).

---

## Conversations — `/api/v1/conversations`

Conversation management including creation, membership, archive/mute, and listing.

| Reference          | Path                                                    |
| ------------------ | ------------------------------------------------------- |
| **Route file**     | `apps/api/src/routes/v1/conversation.routes.ts`         |
| **Controller**     | `apps/api/src/controllers/ConversationController.ts`    |
| **Service**        | `apps/api/src/services/ConversationService.ts`          |

---

### `GET /api/v1/conversations`

List the authenticated user's conversations with the **last message preview**, unread count, and participant summary. Results are cursor-paginated.

**Authentication:** Required

**Query Parameters:**

| Parameter  | Type      | Required | Default | Constraints         |
| ---------- | --------- | -------- | ------- | ------------------- |
| `cursor`   | `string`  | No       | —       | Pagination cursor   |
| `limit`    | `number`  | No       | 20      | 1–50                |
| `archived` | `boolean` | No       | `false` | Filter by archived  |

**Response `200 OK`:**

```json
{
  "data": [
    {
      "id": "conv-uuid",
      "type": "direct",
      "name": null,
      "participants": [
        {
          "id": "user-uuid",
          "displayName": "Martha Craig",
          "avatarUrl": "/media/martha-avatar.jpg"
        }
      ],
      "lastMessage": {
        "id": "msg-uuid",
        "senderId": "user-uuid",
        "ciphertext": "base64...",
        "type": "text",
        "serverTimestamp": "2026-03-30T10:30:00.000Z",
        "status": "read"
      },
      "unreadCount": 0,
      "isArchived": false,
      "isMuted": false,
      "updatedAt": "2026-03-30T10:30:00.000Z"
    }
  ],
  "pagination": {
    "nextCursor": "eyJpZCI6IjEyMyJ9",
    "hasMore": true
  }
}
```

---

### `POST /api/v1/conversations`

Create a new conversation. Supports both **direct** (1:1) and **group** types.

**Authentication:** Required

**Request Body:**

```json
{
  "type": "group",
  "participantIds": [
    "user-uuid-1",
    "user-uuid-2",
    "user-uuid-3"
  ],
  "name": "Project Team"
}
```

| Field            | Type       | Required | Constraints                                    |
| ---------------- | ---------- | -------- | ---------------------------------------------- |
| `type`           | `string`   | Yes      | `"direct"` or `"group"`                        |
| `participantIds` | `string[]` | Yes      | Array of user UUIDs (1 for direct, 1+ for group) |
| `name`           | `string`   | Conditional | Required for `"group"` type, 1–100 characters |

**Response `201 Created`:**

```json
{
  "id": "conv-uuid",
  "type": "group",
  "name": "Project Team",
  "participants": [
    {
      "id": "user-uuid-1",
      "displayName": "Alice",
      "avatarUrl": "/media/alice.jpg",
      "role": "admin"
    },
    {
      "id": "user-uuid-2",
      "displayName": "Bob",
      "avatarUrl": null,
      "role": "member"
    }
  ],
  "createdAt": "2026-03-30T10:00:00.000Z"
}
```

**Errors:**

| Status | Code               | Condition                                      |
| ------ | ------------------ | ---------------------------------------------- |
| 400    | `VALIDATION_ERROR` | Invalid type, missing participants or name      |
| 404    | `NOT_FOUND`        | One or more participant UUIDs do not exist      |
| 409    | `CONFLICT`         | Direct conversation already exists between pair |

---

### `GET /api/v1/conversations/:id`

Retrieve full conversation details including all participants.

**Authentication:** Required (must be a participant)

**Path Parameters:**

| Parameter | Type     | Description      |
| --------- | -------- | ---------------- |
| `id`      | `string` | Conversation UUID |

**Response `200 OK`:**

```json
{
  "id": "conv-uuid",
  "type": "group",
  "name": "Project Team",
  "participants": [
    {
      "id": "user-uuid",
      "displayName": "Alice",
      "avatarUrl": "/media/alice.jpg",
      "role": "admin",
      "joinedAt": "2026-03-30T10:00:00.000Z"
    }
  ],
  "createdAt": "2026-03-30T10:00:00.000Z",
  "updatedAt": "2026-03-30T12:00:00.000Z"
}
```

**Errors:**

| Status | Code                   | Condition                           |
| ------ | ---------------------- | ----------------------------------- |
| 403    | `AUTHORIZATION_ERROR`  | User is not a conversation member   |
| 404    | `NOT_FOUND`            | Conversation does not exist         |

---

### `POST /api/v1/conversations/:id/members`

Add a new member to a **group** conversation. The requester must be an admin of the group.

**Authentication:** Required (must be group admin)

**Path Parameters:**

| Parameter | Type     | Description      |
| --------- | -------- | ---------------- |
| `id`      | `string` | Conversation UUID |

**Request Body:**

```json
{
  "userId": "new-member-uuid"
}
```

| Field    | Type     | Required | Constraints |
| -------- | -------- | -------- | ----------- |
| `userId` | `string` | Yes      | Valid UUID  |

**Response `200 OK`:**

```json
{
  "message": "Member added successfully",
  "participant": {
    "id": "new-member-uuid",
    "displayName": "Charlie",
    "role": "member",
    "joinedAt": "2026-03-30T14:00:00.000Z"
  }
}
```

**Side Effects:**

- Triggers **Sender Key redistribution** to all existing members via BullMQ (Rule R14).
- New member receives fresh Sender Keys from all participants.

**Errors:**

| Status | Code                   | Condition                              |
| ------ | ---------------------- | -------------------------------------- |
| 403    | `AUTHORIZATION_ERROR`  | Requester is not a group admin         |
| 404    | `NOT_FOUND`            | Conversation or user does not exist    |
| 409    | `CONFLICT`             | User is already a member               |

**Audit:** `group.member_add` event written to the audit log (Rule R32).

---

### `DELETE /api/v1/conversations/:id/members/:userId`

Remove a member from a **group** conversation. The requester must be a group admin, or the user may remove themselves.

**Authentication:** Required (must be group admin or self)

**Path Parameters:**

| Parameter | Type     | Description                    |
| --------- | -------- | ------------------------------ |
| `id`      | `string` | Conversation UUID              |
| `userId`  | `string` | UUID of the member to remove   |

**Response `200 OK`:**

```json
{
  "message": "Member removed successfully"
}
```

**Side Effects:**

- Triggers **Sender Key rotation** for all remaining members via BullMQ (Rule R14).
- The removed member can no longer decrypt messages sent after removal.
- The remaining members generate and distribute new Sender Keys.

**Errors:**

| Status | Code                   | Condition                              |
| ------ | ---------------------- | -------------------------------------- |
| 403    | `AUTHORIZATION_ERROR`  | Not an admin and not removing self     |
| 404    | `NOT_FOUND`            | Conversation or user does not exist    |

**Audit:** `group.member_remove` event written to the audit log (Rule R32).

---

### `PUT /api/v1/conversations/:id/archive`

Archive or unarchive a conversation for the authenticated user.

**Authentication:** Required (must be a participant)

**Path Parameters:**

| Parameter | Type     | Description      |
| --------- | -------- | ---------------- |
| `id`      | `string` | Conversation UUID |

**Request Body:**

```json
{
  "archived": true
}
```

| Field      | Type      | Required | Description                           |
| ---------- | --------- | -------- | ------------------------------------- |
| `archived` | `boolean` | Yes      | `true` to archive, `false` to restore |

**Response `200 OK`:**

```json
{
  "message": "Conversation archived",
  "isArchived": true
}
```

---

### `PUT /api/v1/conversations/:id/mute`

Mute or unmute a conversation for the authenticated user. Muted conversations do not trigger push notifications.

**Authentication:** Required (must be a participant)

**Path Parameters:**

| Parameter | Type     | Description      |
| --------- | -------- | ---------------- |
| `id`      | `string` | Conversation UUID |

**Request Body:**

```json
{
  "muted": true,
  "muteDuration": "8h"
}
```

| Field          | Type     | Required | Description                                          |
| -------------- | -------- | -------- | ---------------------------------------------------- |
| `muted`        | `boolean`| Yes      | `true` to mute, `false` to unmute                    |
| `muteDuration` | `string` | No       | Duration string: `"8h"`, `"1w"`, `"always"` (default)|

**Response `200 OK`:**

```json
{
  "message": "Conversation muted",
  "isMuted": true,
  "muteExpiresAt": "2026-03-30T22:00:00.000Z"
}
```

---

## Messages — `/api/v1/messages`

Message history retrieval and lifecycle operations (edit, delete). Primary message **sending** occurs over WebSocket — see [`websocket-events.md`](./websocket-events.md) for the `message:send` event.

| Reference          | Path                                                |
| ------------------ | --------------------------------------------------- |
| **Route file**     | `apps/api/src/routes/v1/message.routes.ts`          |
| **Controller**     | `apps/api/src/controllers/MessageController.ts`     |
| **Service**        | `apps/api/src/services/MessageService.ts`           |

---

### `GET /api/v1/messages/:conversationId`

Retrieve message history for a conversation. Messages are returned as **ciphertext** — the client is responsible for decryption using Signal Protocol sessions (Rule R12).

**Authentication:** Required (must be a conversation participant)

**Path Parameters:**

| Parameter        | Type     | Description       |
| ---------------- | -------- | ----------------- |
| `conversationId` | `string` | Conversation UUID |

**Query Parameters:**

| Parameter   | Type     | Required | Default  | Constraints                    |
| ----------- | -------- | -------- | -------- | ------------------------------ |
| `cursor`    | `string` | No       | —        | Message ID for cursor position |
| `limit`     | `number` | No       | 50       | 1–100                          |
| `direction` | `string` | No       | `before` | `"before"` or `"after"`        |

**Response `200 OK`:**

```json
{
  "data": [
    {
      "id": "msg-uuid",
      "conversationId": "conv-uuid",
      "senderId": "user-uuid",
      "ciphertext": "base64-encoded-encrypted-content",
      "type": "text",
      "replyToId": null,
      "mediaId": null,
      "isEdited": false,
      "isDeleted": false,
      "serverTimestamp": "2026-03-30T10:30:00.000Z",
      "editedAt": null,
      "statuses": [
        {
          "userId": "recipient-uuid",
          "status": "read",
          "updatedAt": "2026-03-30T10:30:05.000Z"
        }
      ]
    }
  ],
  "pagination": {
    "nextCursor": "eyJpZCI6IjEyMyJ9",
    "hasMore": true
  }
}
```

| Field             | Type      | Description                                                     |
| ----------------- | --------- | --------------------------------------------------------------- |
| `ciphertext`      | `string`  | Base64-encoded encrypted message content (null if deleted)      |
| `type`            | `string`  | `"text"`, `"image"`, `"video"`, `"document"`, `"voice"`, `"link"` |
| `replyToId`       | `string`  | ID of the message being replied to (null if not a reply)        |
| `mediaId`         | `string`  | Associated media attachment ID (null if text-only)              |
| `isEdited`        | `boolean` | Whether the message has been edited                             |
| `isDeleted`       | `boolean` | Whether the message is a deletion tombstone                     |
| `statuses`        | `array`   | Delivery/read status per recipient                              |

**Errors:**

| Status | Code                   | Condition                           |
| ------ | ---------------------- | ----------------------------------- |
| 403    | `AUTHORIZATION_ERROR`  | User is not a conversation member   |
| 404    | `NOT_FOUND`            | Conversation does not exist         |

---

### `PUT /api/v1/messages/:messageId`

Edit a previously sent message. This is the REST alternative to the WebSocket `message:edit` event.

**Authentication:** Required (must be the message sender)

**Path Parameters:**

| Parameter   | Type     | Description  |
| ----------- | -------- | ------------ |
| `messageId` | `string` | Message UUID |

**Request Body:**

```json
{
  "ciphertext": "base64-encoded-new-encrypted-content"
}
```

| Field        | Type     | Required | Constraints                          |
| ------------ | -------- | -------- | ------------------------------------ |
| `ciphertext` | `string` | Yes      | Base64-encoded, non-empty            |

**Constraints (Rule R19):**

- Only the **original sender** may edit the message.
- Edits are restricted to a **15-minute window** after the message was sent (`serverTimestamp + 15 min`).
- The edit **replaces** the stored ciphertext — original ciphertext is not retained.
- An `isEdited` flag is set to `true` and `editedAt` is updated.
- All conversation participants receive a `message:edited` WebSocket event.

**Response `200 OK`:**

```json
{
  "id": "msg-uuid",
  "ciphertext": "base64-encoded-new-encrypted-content",
  "isEdited": true,
  "editedAt": "2026-03-30T10:35:00.000Z"
}
```

**Errors:**

| Status | Code                   | Condition                                         |
| ------ | ---------------------- | ------------------------------------------------- |
| 403    | `AUTHORIZATION_ERROR`  | Not the message sender                            |
| 404    | `NOT_FOUND`            | Message does not exist                            |
| 400    | `VALIDATION_ERROR`     | Edit window expired (>15 min) or message deleted  |

---

### `DELETE /api/v1/messages/:messageId`

Soft-delete a message. Creates a **tombstone** — the message row is retained but ciphertext is nulled. This is the REST alternative to the WebSocket `message:delete` event.

**Authentication:** Required (must be the message sender)

**Path Parameters:**

| Parameter   | Type     | Description  |
| ----------- | -------- | ------------ |
| `messageId` | `string` | Message UUID |

**Behavior (Rule R20):**

- Only the **original sender** may delete the message.
- The `ciphertext` field is set to `null`.
- The `isDeleted` flag is set to `true`.
- The message row is **retained** in the database (soft delete).
- All conversation participants receive a `message:deleted` WebSocket event.
- Clients render deleted messages as *"This message was deleted."*

**Response `200 OK`:**

```json
{
  "id": "msg-uuid",
  "isDeleted": true
}
```

**Errors:**

| Status | Code                   | Condition                        |
| ------ | ---------------------- | -------------------------------- |
| 403    | `AUTHORIZATION_ERROR`  | Not the message sender           |
| 404    | `NOT_FOUND`            | Message does not exist           |

**Audit:** `message.delete` event written to the audit log (Rule R32).

---

## Media — `/api/v1/media`

Encrypted media file upload and download. All media is encrypted **client-side** before upload — the server stores and serves opaque encrypted blobs without processing (Rule R12).

| Reference          | Path                                            |
| ------------------ | ----------------------------------------------- |
| **Route file**     | `apps/api/src/routes/v1/media.routes.ts`        |
| **Controller**     | `apps/api/src/controllers/MediaController.ts`   |
| **Service**        | `apps/api/src/services/MediaService.ts`         |

---

### `POST /api/v1/media/upload`

Upload an encrypted media file with an optional encrypted thumbnail.

**Authentication:** Required

**Content-Type:** `multipart/form-data`

**Form Fields:**

| Field       | Type     | Required | Constraints                                    |
| ----------- | -------- | -------- | ---------------------------------------------- |
| `file`      | `binary` | Yes      | Encrypted blob, max 25 MB (Rule R8)            |
| `mimeType`  | `string` | Yes      | Declared MIME type, validated against allowlist |
| `thumbnail` | `binary` | No       | Encrypted thumbnail blob, max 200px longest edge (Rule R27) |

**Allowed MIME Types:**

| Category   | Types                                                     |
| ---------- | --------------------------------------------------------- |
| Images     | `image/jpeg`, `image/png`, `image/gif`, `image/webp`     |
| Videos     | `video/mp4`, `video/quicktime`, `video/webm`              |
| Audio      | `audio/mpeg`, `audio/ogg`, `audio/wav`, `audio/webm`     |
| Documents  | `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.*`, `text/plain` |

**Server Behavior (Rules R8, R27):**

1. Validate file size ≤ 25 MB — return `413 PAYLOAD_TOO_LARGE` if exceeded.
2. Validate declared `mimeType` against the server allowlist — return `415 UNSUPPORTED_MEDIA_TYPE` if disallowed.
3. Store the encrypted blob to the local filesystem.
4. If a thumbnail is provided, store it as a separate encrypted blob.
5. The server performs **no image processing** — thumbnails are generated client-side before encryption (Rule R27).

**Response `201 Created`:**

```json
{
  "mediaId": "media-uuid",
  "url": "/media/media-uuid",
  "thumbnailUrl": "/media/media-uuid-thumb",
  "mimeType": "image/jpeg",
  "size": 1234567
}
```

| Field          | Type     | Nullable | Description                         |
| -------------- | -------- | -------- | ----------------------------------- |
| `mediaId`      | `string` | No       | UUID of the created media record    |
| `url`          | `string` | No       | Relative URL to download the file   |
| `thumbnailUrl` | `string` | Yes      | Relative URL to download thumbnail  |
| `mimeType`     | `string` | No       | Declared MIME type                  |
| `size`         | `number` | No       | File size in bytes                  |

**Errors:**

| Status | Code                       | Condition                            |
| ------ | -------------------------- | ------------------------------------ |
| 400    | `VALIDATION_ERROR`         | Missing file or mimeType             |
| 413    | `PAYLOAD_TOO_LARGE`        | File exceeds 25 MB                   |
| 415    | `UNSUPPORTED_MEDIA_TYPE`   | MIME type not in server allowlist     |

---

### `GET /api/v1/media/:mediaId`

Download an encrypted media file. The client is responsible for decryption.

**Authentication:** Required

**Path Parameters:**

| Parameter | Type     | Description |
| --------- | -------- | ----------- |
| `mediaId` | `string` | Media UUID  |

**Response `200 OK`:**

- **Content-Type:** `application/octet-stream`
- **Body:** Binary stream of the encrypted media blob.

**Errors:**

| Status | Code         | Condition                  |
| ------ | ------------ | -------------------------- |
| 404    | `NOT_FOUND`  | Media record does not exist |

---

## Stories — `/api/v1/stories`

Story creation, feed retrieval, view tracking, and deletion. Stories are **not encrypted** (Rule R12) and auto-expire after **24 hours** (Rule R11). Expired stories and their associated media are purged by an hourly BullMQ cleanup job.

| Reference          | Path                                            |
| ------------------ | ----------------------------------------------- |
| **Route file**     | `apps/api/src/routes/v1/story.routes.ts`        |
| **Controller**     | `apps/api/src/controllers/StoryController.ts`   |
| **Service**        | `apps/api/src/services/StoryService.ts`         |

---

### `POST /api/v1/stories`

Create a new story. Supports text stories (with colored backgrounds) and media stories (image or video).

**Authentication:** Required

**Request Body:**

```json
{
  "type": "text",
  "content": "Hello, world!",
  "backgroundColor": "#FF6B6B"
}
```

*Or for media stories:*

```json
{
  "type": "image",
  "mediaId": "media-uuid"
}
```

| Field             | Type     | Required    | Constraints                                |
| ----------------- | -------- | ----------- | ------------------------------------------ |
| `type`            | `string` | Yes         | `"text"`, `"image"`, or `"video"`          |
| `content`         | `string` | Conditional | Required for `"text"` type, 1–700 chars    |
| `mediaId`         | `string` | Conditional | Required for `"image"` / `"video"` types   |
| `backgroundColor` | `string` | No          | Hex color for text stories (default `#128C7E`) |

**Response `201 Created`:**

```json
{
  "id": "story-uuid",
  "authorId": "user-uuid",
  "type": "text",
  "content": "Hello, world!",
  "backgroundColor": "#FF6B6B",
  "mediaId": null,
  "createdAt": "2026-03-30T10:00:00.000Z",
  "expiresAt": "2026-03-31T10:00:00.000Z"
}
```

**Note:** Stories auto-expire 24 hours after creation (Rule R11). The `expiresAt` field is calculated server-side.

---

### `GET /api/v1/stories/feed`

Retrieve the story feed for the authenticated user's contacts. Returns only **non-expired** stories grouped by author.

**Authentication:** Required

**Response `200 OK`:**

```json
{
  "data": [
    {
      "author": {
        "id": "user-uuid",
        "displayName": "Martha Craig",
        "avatarUrl": "/media/martha-avatar.jpg"
      },
      "stories": [
        {
          "id": "story-uuid",
          "type": "text",
          "content": "Having a great day!",
          "backgroundColor": "#FF6B6B",
          "mediaId": null,
          "viewCount": 5,
          "hasViewed": false,
          "createdAt": "2026-03-30T09:00:00.000Z",
          "expiresAt": "2026-03-31T09:00:00.000Z"
        }
      ],
      "latestAt": "2026-03-30T09:00:00.000Z"
    }
  ]
}
```

| Field                    | Type      | Description                                    |
| ------------------------ | --------- | ---------------------------------------------- |
| `author`                 | `object`  | Story author's profile summary                 |
| `stories`                | `array`   | Array of non-expired stories from this author  |
| `stories[].viewCount`    | `number`  | Total number of unique views                   |
| `stories[].hasViewed`    | `boolean` | Whether the current user has viewed this story |
| `latestAt`               | `string`  | Timestamp of the most recent story             |

---

### `POST /api/v1/stories/:id/view`

Record that the authenticated user has viewed a story. Duplicate views from the same user are idempotent.

**Authentication:** Required

**Path Parameters:**

| Parameter | Type     | Description |
| --------- | -------- | ----------- |
| `id`      | `string` | Story UUID  |

**Response `200 OK`:**

```json
{
  "viewed": true
}
```

**Errors:**

| Status | Code         | Condition                |
| ------ | ------------ | ------------------------ |
| 404    | `NOT_FOUND`  | Story does not exist     |

---

### `DELETE /api/v1/stories/:id`

Delete a story. Only the **original author** may delete their story.

**Authentication:** Required (must be the story author)

**Path Parameters:**

| Parameter | Type     | Description |
| --------- | -------- | ----------- |
| `id`      | `string` | Story UUID  |

**Response `200 OK`:**

```json
{
  "message": "Story deleted successfully"
}
```

**Errors:**

| Status | Code                   | Condition                      |
| ------ | ---------------------- | ------------------------------ |
| 403    | `AUTHORIZATION_ERROR`  | Not the story author           |
| 404    | `NOT_FOUND`            | Story does not exist           |

---

## Encryption Keys — `/api/v1/keys`

Signal Protocol prekey bundle management. These endpoints facilitate the key exchange required to establish encrypted sessions between users. For the complete encryption architecture, see [`encryption.md`](./encryption.md).

| Reference          | Path                                                    |
| ------------------ | ------------------------------------------------------- |
| **Route file**     | `apps/api/src/routes/v1/key.routes.ts`                  |
| **Controller**     | `apps/api/src/controllers/KeyController.ts`             |
| **Service**        | `apps/api/src/services/EncryptionKeyService.ts`         |

---

### `POST /api/v1/keys/bundle`

Upload the authenticated user's prekey bundle. The bundle contains the public keys required by other users to initiate Signal Protocol sessions (X3DH key agreement).

**Authentication:** Required

**Request Body:**

```json
{
  "identityKey": "base64-encoded-identity-public-key",
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "base64-encoded-signed-prekey",
    "signature": "base64-encoded-signature"
  },
  "oneTimePreKeys": [
    {
      "keyId": 1,
      "publicKey": "base64-encoded-one-time-prekey"
    },
    {
      "keyId": 2,
      "publicKey": "base64-encoded-one-time-prekey"
    }
  ]
}
```

| Field                             | Type     | Required | Description                                  |
| --------------------------------- | -------- | -------- | -------------------------------------------- |
| `identityKey`                     | `string` | Yes      | Base64-encoded Curve25519 identity public key |
| `signedPreKey.keyId`              | `number` | Yes      | Signed prekey identifier                     |
| `signedPreKey.publicKey`          | `string` | Yes      | Base64-encoded signed prekey                 |
| `signedPreKey.signature`          | `string` | Yes      | Base64-encoded signature over the prekey     |
| `oneTimePreKeys`                  | `array`  | Yes      | Array of one-time prekeys (recommended 100)  |
| `oneTimePreKeys[].keyId`          | `number` | Yes      | One-time prekey identifier                   |
| `oneTimePreKeys[].publicKey`      | `string` | Yes      | Base64-encoded one-time prekey               |

**Response `201 Created`:**

```json
{
  "message": "Prekey bundle uploaded successfully",
  "oneTimePreKeysCount": 100
}
```

**Audit:** `keys.bundle_upload` event written to the audit log (Rule R32).

**Note:** When the server's supply of one-time prekeys drops below a threshold, it enqueues a `prekey-replenish-notification` BullMQ job to notify the client.

---

### `GET /api/v1/keys/bundle/:userId`

Fetch a user's prekey bundle to establish a new Signal Protocol session. **One-time prekeys are consumed on fetch** — each one-time prekey can only be used once.

**Authentication:** Required

**Path Parameters:**

| Parameter | Type     | Description                   |
| --------- | -------- | ----------------------------- |
| `userId`  | `string` | Target user's UUID            |

**Response `200 OK`:**

```json
{
  "userId": "target-user-uuid",
  "identityKey": "base64-encoded-identity-public-key",
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "base64-encoded-signed-prekey",
    "signature": "base64-encoded-signature"
  },
  "oneTimePreKey": {
    "keyId": 42,
    "publicKey": "base64-encoded-one-time-prekey"
  }
}
```

| Field           | Type     | Nullable | Description                                                     |
| --------------- | -------- | -------- | --------------------------------------------------------------- |
| `oneTimePreKey` | `object` | Yes      | May be null if all one-time prekeys are exhausted              |

**Errors:**

| Status | Code         | Condition                            |
| ------ | ------------ | ------------------------------------ |
| 404    | `NOT_FOUND`  | User does not exist or has no bundle |

**Note:** If `oneTimePreKey` is null, the client falls back to using only the signed prekey for session establishment (reduced forward secrecy until the target user replenishes).

---

## Health & Metrics — `/api/v1/health`

System health checks and Prometheus-compatible metrics for observability.

| Reference          | Path                                              |
| ------------------ | ------------------------------------------------- |
| **Route file**     | `apps/api/src/routes/v1/health.routes.ts`         |
| **Controller**     | `apps/api/src/controllers/HealthController.ts`    |
| **Health Service** | `apps/api/src/services/HealthService.ts`          |
| **Metrics Service**| `apps/api/src/services/MetricsService.ts`         |

---

### `GET /api/v1/health`

Component-level health check reporting the status of all backend infrastructure dependencies.

**Authentication:** None required

**Response `200 OK`:**

```json
{
  "status": "healthy",
  "timestamp": "2026-03-30T10:00:00.000Z",
  "version": "1.0.0",
  "uptime": 86400,
  "components": {
    "database": {
      "status": "up",
      "latencyMs": 5
    },
    "redis": {
      "status": "up",
      "latencyMs": 2
    },
    "bullmq": {
      "status": "up"
    },
    "storage": {
      "status": "up"
    }
  }
}
```

| Field                        | Type     | Description                                   |
| ---------------------------- | -------- | --------------------------------------------- |
| `status`                     | `string` | `"healthy"` if all components are up; `"degraded"` or `"unhealthy"` otherwise |
| `timestamp`                  | `string` | ISO 8601 timestamp of the health check        |
| `version`                    | `string` | Application version                           |
| `uptime`                     | `number` | Server uptime in seconds                      |
| `components.database.status` | `string` | PostgreSQL connectivity: `"up"` or `"down"`   |
| `components.redis.status`    | `string` | Redis connectivity: `"up"` or `"down"`        |
| `components.bullmq.status`   | `string` | BullMQ worker connectivity: `"up"` or `"down"` |
| `components.storage.status`  | `string` | File storage accessibility: `"up"` or `"down"` |

**Response `503 Service Unavailable`** (when any component is down):

```json
{
  "status": "unhealthy",
  "timestamp": "2026-03-30T10:00:00.000Z",
  "components": {
    "database": { "status": "down", "error": "Connection refused" },
    "redis": { "status": "up", "latencyMs": 2 },
    "bullmq": { "status": "up" },
    "storage": { "status": "up" }
  }
}
```

---

### `GET /api/v1/metrics`

Prometheus-compatible metrics endpoint exposing application telemetry in the Prometheus text exposition format (Rule R37).

**Authentication:** None required

**Response `200 OK`:**

- **Content-Type:** `text/plain; version=0.0.4; charset=utf-8`

**Exposed Metrics:**

| Metric Name                        | Type      | Description                                     |
| ---------------------------------- | --------- | ----------------------------------------------- |
| `http_requests_total`              | Counter   | Total HTTP requests by method, path, and status |
| `http_request_duration_seconds`    | Histogram | HTTP request latency in seconds                 |
| `websocket_connections_active`     | Gauge     | Current active WebSocket connections             |
| `bullmq_queue_depth`              | Gauge     | Number of pending jobs per queue name            |
| `bullmq_jobs_completed_total`     | Counter   | Total completed jobs by queue name               |
| `bullmq_jobs_failed_total`        | Counter   | Total failed jobs by queue name                  |
| `db_query_duration_seconds`       | Histogram | Database query latency in seconds (p50, p95, p99) |
| `db_connections_active`           | Gauge     | Active database connection pool count            |

**Example Response:**

```
# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",path="/api/v1/health",status="200"} 1024

# HELP http_request_duration_seconds HTTP request latency
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.01"} 500
http_request_duration_seconds_bucket{le="0.05"} 800
http_request_duration_seconds_bucket{le="0.1"} 950
http_request_duration_seconds_bucket{le="+Inf"} 1024

# HELP websocket_connections_active Active WebSocket connections
# TYPE websocket_connections_active gauge
websocket_connections_active 42
```

**Implementation:** OpenTelemetry SDK with Prometheus exporter (`@opentelemetry/exporter-prometheus`).

---

## Route Registration

All v1 routes are aggregated in `apps/api/src/routes/v1/index.ts` and mounted under the `/api/v1/` prefix on the Express application.

| Mount Path               | Route File                                           |
| ------------------------ | ---------------------------------------------------- |
| `/api/v1/auth`           | `apps/api/src/routes/v1/auth.routes.ts`              |
| `/api/v1/users`          | `apps/api/src/routes/v1/user.routes.ts`              |
| `/api/v1/conversations`  | `apps/api/src/routes/v1/conversation.routes.ts`      |
| `/api/v1/messages`       | `apps/api/src/routes/v1/message.routes.ts`           |
| `/api/v1/media`          | `apps/api/src/routes/v1/media.routes.ts`             |
| `/api/v1/stories`        | `apps/api/src/routes/v1/story.routes.ts`             |
| `/api/v1/keys`           | `apps/api/src/routes/v1/key.routes.ts`               |
| `/api/v1/health`         | `apps/api/src/routes/v1/health.routes.ts`            |
| `/api/v1/metrics`        | `apps/api/src/routes/v1/health.routes.ts`            |

**Middleware chain** (applied in order via `apps/api/src/app.ts`):

1. `correlation-id` — Assigns UUID v4 correlation ID (Rule R29)
2. `helmet` — Security headers
3. `compression` — Response compression
4. `cors` — Cross-origin configuration (Rule R38: `http://localhost:3000`)
5. `logger` — Pino HTTP request logging (Rule R28)
6. `metrics` — OpenTelemetry HTTP instrumentation (Rule R37)
7. `rate-limiter` — Per-IP HTTP rate limiting (Rule R25)
8. `auth` — JWT verification + Redis blacklist (Rule R9) — applied per-route
9. `validation` — Zod schema validation (Rule R31) — applied per-route
10. `error-handler` — Global error handler (Rule R22) — registered last

---

## Implementation Files

Complete mapping from route definitions to implementation layers:

| Domain         | Route File                          | Controller                        | Service                          | Repository                        |
| -------------- | ----------------------------------- | --------------------------------- | -------------------------------- | --------------------------------- |
| Auth           | `routes/v1/auth.routes.ts`          | `AuthController.ts`               | `AuthService.ts`                 | `SessionRepository.ts`            |
| Users          | `routes/v1/user.routes.ts`          | `UserController.ts`               | `UserService.ts`                 | `UserRepository.ts`               |
| Conversations  | `routes/v1/conversation.routes.ts`  | `ConversationController.ts`       | `ConversationService.ts`         | `ConversationRepository.ts`       |
| Messages       | `routes/v1/message.routes.ts`       | `MessageController.ts`            | `MessageService.ts`              | `MessageRepository.ts`            |
| Media          | `routes/v1/media.routes.ts`         | `MediaController.ts`              | `MediaService.ts`                | `MediaRepository.ts`              |
| Stories        | `routes/v1/story.routes.ts`         | `StoryController.ts`              | `StoryService.ts`                | `StoryRepository.ts`              |
| Keys           | `routes/v1/key.routes.ts`           | `KeyController.ts`                | `EncryptionKeyService.ts`        | `KeyRepository.ts`                |
| Health/Metrics | `routes/v1/health.routes.ts`        | `HealthController.ts`             | `HealthService.ts`, `MetricsService.ts` | —                          |

All route files are under `apps/api/src/routes/v1/`.
All controllers are under `apps/api/src/controllers/`.
All services are under `apps/api/src/services/`.
All repositories are under `apps/api/src/repositories/`.

**Cross-cutting services:**

| Service                | Injected Into                                                          | Purpose                           |
| ---------------------- | ---------------------------------------------------------------------- | --------------------------------- |
| `AuditService.ts`      | AuthService, UserService, ConversationService, MessageService, EncryptionKeyService | Immutable audit log (Rule R32)  |
| `LoggerProvider.ts`    | All services and middleware                                            | Structured Pino logging (Rule R28) |
| `CacheProvider.ts`     | AuthService, ConversationService, PresenceHandler                      | Redis cache (presence, blacklist) |
| `QueueProvider.ts`     | MessageService, ConversationService, StoryService                      | BullMQ job enqueuing (Rule R18)  |
| `RealtimeProvider.ts`  | MessageService, ConversationService                                    | Socket.IO event emission          |
| `StorageProvider.ts`   | MediaService                                                           | Local filesystem storage          |

---

## Related Documentation

| Document                                        | Description                                         |
| ----------------------------------------------- | --------------------------------------------------- |
| [`websocket-events.md`](./websocket-events.md)  | WebSocket event contracts for real-time messaging   |
| [`encryption.md`](./encryption.md)              | E2E encryption architecture and Signal Protocol     |
| [`architecture.md`](./architecture.md)          | System architecture and design decisions            |
