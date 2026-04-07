# REST API Reference

> Comprehensive documentation for all REST API endpoints in the Kalle WhatsApp clone backend.

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Error Responses](#error-responses)
- [Correlation IDs](#correlation-ids)
- [Input Validation](#input-validation)
- [Pagination](#pagination)
- [Auth — `/api/v1/auth`](#auth-apiv1auth)
- [Users — `/api/v1/users`](#users-apiv1users)
- [Conversations — `/api/v1/conversations`](#conversations-apiv1conversations)
- [Messages — `/api/v1/messages`](#messages-apiv1messages)
- [Media — `/api/v1/media`](#media-apiv1media)
- [Stories — `/api/v1/stories`](#stories-apiv1stories)
- [Encryption Keys — `/api/v1/keys`](#encryption-keys-apiv1keys)
- [Health & Metrics — `/api/v1/health`](#health-metrics-apiv1health)
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

All request and response bodies use `application/json` unless explicitly noted otherwise. The media upload endpoint (`POST /api/v1/media`) accepts `multipart/form-data`.

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
| `cursor`   | `string` | —       | Opaque cursor from the previous response's `cursor` field |
| `limit`    | `number` | varies  | Maximum number of items to return (endpoint-specific max) |
| `direction`| `string` | `before`| Pagination direction: `before` or `after` the cursor      |

### Response Shape

Most endpoints use a nested `pagination` object:

```json
{
  "data": [ ... ],
  "pagination": {
    "cursor": "eyJpZCI6IjEyMyJ9",
    "hasMore": true
  }
}
```

Some endpoints (e.g., conversation list) use top-level pagination fields:

```json
{
  "data": [ ... ],
  "cursor": "eyJpZCI6IjEyMyJ9",
  "hasMore": true
}
```

| Field                   | Type      | Description                                           |
| ----------------------- | --------- | ----------------------------------------------------- |
| `data`                  | `array`   | Array of result items                                 |
| `pagination.cursor` or `cursor` | `string`  | Cursor to pass in the next request (null if no more)  |
| `pagination.hasMore` or `hasMore` | `boolean` | Whether more results exist beyond this page           |

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
  "data": {
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@example.com",
      "displayName": "John Doe"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
  }
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
  "data": {
    "user": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "user@example.com",
      "displayName": "John Doe"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
  }
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
  "data": {
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1NiIs...",
      "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
    }
  }
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
  "data": {
    "message": "Session revoked successfully"
  }
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
  "data": {
    "message": "All sessions revoked successfully",
    "revokedCount": 3
  }
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

### `GET /api/v1/users/me`

Retrieve the authenticated user's own profile.

**Authentication:** Required

**Response `200 OK`:**

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "displayName": "John Doe",
    "avatar": "/media/550e8400-avatar.jpg",
    "about": "Digital goodies designer",
    "phoneNumber": "+1 202 555 0181",
    "status": "ONLINE",
    "lastSeen": "2026-03-30T09:00:00.000Z",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-03-30T10:00:00.000Z"
  }
}
```

| Field         | Type     | Nullable | Description                        |
| ------------- | -------- | -------- | ---------------------------------- |
| `id`          | `string` | No       | UUID v4                            |
| `email`       | `string` | No       | Verified email address             |
| `displayName` | `string` | No       | User's chosen display name         |
| `avatar`      | `string` | Yes      | Relative URL to avatar media       |
| `about`       | `string` | Yes      | User bio / status text             |
| `phoneNumber` | `string` | Yes      | Phone number (display only)        |
| `status`      | `string` | No       | `"ONLINE"`, `"OFFLINE"`, `"AWAY"` |
| `lastSeen`    | `string` | Yes      | ISO 8601 timestamp of last activity|
| `createdAt`   | `string` | No       | ISO 8601 timestamp                 |
| `updatedAt`   | `string` | No       | ISO 8601 timestamp of last update  |

---

### `PATCH /api/v1/users/me`

Update the authenticated user's profile. Supports **partial updates** — include only the fields to change.

**Authentication:** Required

**Request Body:**

```json
{
  "displayName": "Jane Doe",
  "about": "Building great things",
  "avatar": "/media/new-avatar.jpg",
  "phoneNumber": "+1 202 555 0199"
}
```

| Field         | Type     | Required | Constraints            |
| ------------- | -------- | -------- | ---------------------- |
| `displayName` | `string` | No       | 1–50 characters        |
| `about`       | `string` | No       | 0–500 characters       |
| `avatar`      | `string` | No       | Valid media URL or null |
| `phoneNumber` | `string` | No       | Valid phone format      |

**Response `200 OK`:** Updated user profile object wrapped in `data` (same shape as `GET /users/me`).

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
      "avatar": "/media/avatar.jpg",
      "about": "Digital goodies designer"
    }
  ],
  "pagination": {
    "cursor": "eyJpZCI6IjEyMyJ9",
    "hasMore": true
  }
}
```

---

### `POST /api/v1/users/:userId/block`

Block a user. Blocked users cannot send messages to or view the blocker's profile, stories, or presence.

**Authentication:** Required

**Path Parameters:**

| Parameter | Type     | Description                   |
| --------- | -------- | ----------------------------- |
| `userId`  | `string` | UUID of the user to block     |

**Request Body:** None

**Response `200 OK`:**

```json
{
  "data": {
    "message": "User blocked successfully",
    "blockedUser": {
      "userId": "blocked-user-uuid",
      "displayName": "John Doe",
      "avatar": "/media/avatar.jpg",
      "blockedAt": "2026-03-30T10:00:00.000Z"
    }
  }
}
```

| Field                   | Type     | Description                         |
| ----------------------- | -------- | ----------------------------------- |
| `blockedUser.userId`    | `string` | UUID of the blocked user            |
| `blockedUser.displayName` | `string` | Display name of the blocked user  |
| `blockedUser.avatar`    | `string` | Avatar URL (nullable)               |
| `blockedUser.blockedAt` | `string` | ISO 8601 timestamp of the block     |

**Errors:**

| Status | Code         | Condition                    |
| ------ | ------------ | ---------------------------- |
| 404    | `NOT_FOUND`  | Target user does not exist   |
| 409    | `CONFLICT`   | User already blocked         |

**Audit:** `user.block` event written to the audit log (Rule R32).

---

### `DELETE /api/v1/users/:userId/block`

Unblock a previously blocked user.

**Authentication:** Required

**Path Parameters:**

| Parameter | Type     | Description                     |
| --------- | -------- | ------------------------------- |
| `userId`  | `string` | UUID of the user to unblock     |

**Request Body:** None

**Response `200 OK`:**

```json
{
  "data": {
    "message": "User unblocked successfully"
  }
}
```

**Errors:**

| Status | Code         | Condition                  |
| ------ | ------------ | -------------------------- |
| 404    | `NOT_FOUND`  | Target user does not exist |
| 409    | `CONFLICT`   | User is not blocked        |

**Audit:** `user.unblock` event written to the audit log (Rule R32).

---

### `GET /api/v1/users/blocked`

Retrieve the list of users blocked by the authenticated user.

**Authentication:** Required

**Response `200 OK`:**

```json
{
  "data": [
    {
      "userId": "blocked-user-uuid",
      "displayName": "Blocked User",
      "avatar": "https://example.com/avatar.jpg",
      "blockedAt": "2026-03-30T10:00:00.000Z"
    }
  ]
}
```

| Field         | Type     | Nullable | Description                             |
| ------------- | -------- | -------- | --------------------------------------- |
| `userId`      | `string` | No       | UUID of the blocked user                |
| `displayName` | `string` | No       | Display name of the blocked user        |
| `avatar`      | `string` | Yes      | Avatar URL (may be absent)              |
| `blockedAt`   | `string` | No       | ISO 8601 timestamp of when block occurred |

---

### `GET /api/v1/users/:userId`

Retrieve a specific user's public profile by UUID.

**Authentication:** Required

**Path Parameters:**

| Parameter | Type     | Description                |
| --------- | -------- | -------------------------- |
| `userId`  | `string` | UUID of the target user    |

**Response `200 OK`:**

```json
{
  "data": {
    "id": "target-user-uuid",
    "email": "user@example.com",
    "displayName": "Jane Doe",
    "avatar": "https://example.com/avatar.jpg",
    "about": "Hello there!",
    "lastSeen": "2026-03-30T10:00:00.000Z",
    "createdAt": "2026-03-01T00:00:00.000Z"
  }
}
```

**Errors:**

| Status | Code         | Condition                  |
| ------ | ------------ | -------------------------- |
| 404    | `NOT_FOUND`  | User does not exist        |

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
| `cursor`          | `string`  | No       | —       | Pagination cursor          |
| `limit`           | `number`  | No       | 20      | 1–50                       |
| `includeArchived` | `string`  | No       | `"false"` | Set `"true"` to include archived conversations |

**Response `200 OK`:**

```json
{
  "data": [
    {
      "id": "conv-uuid",
      "type": "DIRECT",
      "groupName": null,
      "participants": [
        {
          "userId": "user-uuid",
          "displayName": "Martha Craig",
          "avatar": "/media/martha-avatar.jpg",
          "role": "MEMBER",
          "joinedAt": "2026-03-30T10:00:00.000Z"
        }
      ],
      "lastMessage": {
        "id": "msg-uuid",
        "senderId": "user-uuid",
        "senderName": "Martha Craig",
        "ciphertext": "base64...",
        "type": "TEXT",
        "serverTimestamp": "2026-03-30T10:30:00.000Z",
        "isDeleted": false
      },
      "unreadCount": 0,
      "isArchived": false,
      "muteSettings": {
        "isMuted": false
      },
      "createdAt": "2026-03-30T09:00:00.000Z",
      "updatedAt": "2026-03-30T10:30:00.000Z"
    }
  ],
  "cursor": "eyJpZCI6IjEyMyJ9",
  "hasMore": true
}
```

---

### `POST /api/v1/conversations`

Create a new conversation. Supports both **direct** (1:1) and **group** types.

**Authentication:** Required

**Request Body:**

```json
{
  "type": "GROUP",
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
| `type`           | `string`   | Yes      | `"DIRECT"` or `"GROUP"`                        |
| `participantIds` | `string[]` | Yes      | Array of user UUIDs (1 for direct, 1+ for group) |
| `name`           | `string`   | Conditional | Required for `"GROUP"` type, 1–100 characters |

**Response `201 Created`:**

```json
{
  "data": {
    "id": "conv-uuid",
    "type": "GROUP",
    "groupName": "Project Team",
    "participants": [
      {
        "userId": "user-uuid-1",
        "displayName": "Alice",
        "avatar": "/media/alice.jpg",
        "role": "ADMIN",
        "joinedAt": "2026-03-30T10:00:00.000Z"
      },
      {
        "userId": "user-uuid-2",
        "displayName": "Bob",
        "avatar": null,
        "role": "MEMBER",
        "joinedAt": "2026-03-30T10:00:00.000Z"
      }
    ],
    "unreadCount": 0,
    "isArchived": false,
    "muteSettings": {
      "isMuted": false
    },
    "createdAt": "2026-03-30T10:00:00.000Z",
    "updatedAt": "2026-03-30T10:00:00.000Z"
  }
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
  "data": {
    "id": "conv-uuid",
    "type": "GROUP",
    "groupName": "Project Team",
    "participants": [
      {
        "userId": "user-uuid",
        "displayName": "Alice",
        "avatar": "/media/alice.jpg",
        "role": "ADMIN",
        "joinedAt": "2026-03-30T10:00:00.000Z"
      }
    ],
    "unreadCount": 0,
    "isArchived": false,
    "muteSettings": {
      "isMuted": false
    },
    "createdAt": "2026-03-30T10:00:00.000Z",
    "updatedAt": "2026-03-30T12:00:00.000Z"
  }
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

Returns the updated full conversation object including the newly added member:

```json
{
  "data": {
    "id": "conv-uuid",
    "type": "GROUP",
    "groupName": "Project Team",
    "participants": [
      {
        "userId": "admin-uuid",
        "displayName": "Alice",
        "avatar": "/media/alice-avatar.jpg",
        "role": "ADMIN",
        "joinedAt": "2026-03-30T12:00:00.000Z"
      },
      {
        "userId": "new-member-uuid",
        "displayName": "Charlie",
        "avatar": "/media/charlie-avatar.jpg",
        "role": "MEMBER",
        "joinedAt": "2026-03-30T14:00:00.000Z"
      }
    ],
    "unreadCount": 0,
    "isArchived": false,
    "muteSettings": {
      "isMuted": false,
      "muteExpiresAt": null
    },
    "createdAt": "2026-03-30T12:00:00.000Z",
    "updatedAt": "2026-03-30T14:00:00.000Z"
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

Returns the updated full conversation object without the removed member:

```json
{
  "data": {
    "id": "conv-uuid",
    "type": "GROUP",
    "groupName": "Project Team",
    "participants": [
      {
        "userId": "admin-uuid",
        "displayName": "Alice",
        "avatar": "/media/alice-avatar.jpg",
        "role": "ADMIN",
        "joinedAt": "2026-03-30T12:00:00.000Z"
      }
    ],
    "unreadCount": 0,
    "isArchived": false,
    "muteSettings": {
      "isMuted": false,
      "muteExpiresAt": null
    },
    "createdAt": "2026-03-30T12:00:00.000Z",
    "updatedAt": "2026-03-30T14:01:00.000Z"
  }
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

### `PATCH /api/v1/conversations/:id`

Update conversation settings for the authenticated user. Supports **partial updates** — include only the fields to change. Use this endpoint for archive, mute, and renaming operations.

**Authentication:** Required (must be a participant)

**Path Parameters:**

| Parameter | Type     | Description      |
| --------- | -------- | ---------------- |
| `id`      | `string` | Conversation UUID |

**Request Body (archive example):**

```json
{
  "isArchived": true
}
```

**Request Body (mute example):**

```json
{
  "isMuted": true
}
```

**Request Body (rename group example):**

```json
{
  "name": "New Group Name"
}
```

| Field        | Type      | Required | Description                             |
| ------------ | --------- | -------- | --------------------------------------- |
| `isArchived` | `boolean` | No       | `true` to archive, `false` to restore   |
| `isMuted`    | `boolean` | No       | `true` to mute, `false` to unmute       |
| `name`       | `string`  | No       | New conversation name (group only)      |

**Response `200 OK`:**

```json
{
  "data": {
    "id": "conv-uuid",
    "type": "GROUP",
    "groupName": "New Group Name",
    "isArchived": true,
    "muteSettings": {
      "isMuted": false
    },
    "createdAt": "2026-03-30T10:00:00.000Z",
    "updatedAt": "2026-03-30T14:00:00.000Z"
  }
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

### `GET /api/v1/messages/conversations/:conversationId/messages`

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
      "senderName": "User Name",
      "senderAvatar": "https://example.com/avatar.jpg",
      "ciphertext": "base64-encoded-encrypted-content",
      "type": "TEXT",
      "status": "READ",
      "replyTo": null,
      "mediaId": null,
      "linkPreview": null,
      "isEdited": false,
      "isDeleted": false,
      "editedAt": null,
      "deletedAt": null,
      "clientMessageId": "client-generated-uuid",
      "serverTimestamp": "2026-03-30T10:30:00.000Z",
      "createdAt": "2026-03-30T10:30:00.000Z"
    }
  ],
  "pagination": {
    "cursor": "eyJpZCI6IjEyMyJ9",
    "hasMore": true
  }
}
```

| Field              | Type      | Description                                                     |
| ------------------ | --------- | --------------------------------------------------------------- |
| `senderName`       | `string`  | Display name of the message sender                              |
| `senderAvatar`     | `string?` | Avatar URL of the sender (optional)                             |
| `ciphertext`       | `string?` | Base64-encoded encrypted message content (null if deleted)      |
| `type`             | `string`  | `"TEXT"`, `"IMAGE"`, `"VIDEO"`, `"DOCUMENT"`, `"VOICE"`, `"LINK"` |
| `status`           | `string`  | Aggregate status: `"SENT"`, `"DELIVERED"`, `"READ"`             |
| `replyTo`          | `object?` | Reply-to message preview (null if not a reply)                  |
| `mediaId`          | `string?` | Associated media attachment ID (null if text-only)              |
| `linkPreview`      | `object?` | Extracted OG metadata for link messages (null if none)          |
| `clientMessageId`  | `string`  | Client-generated UUID for idempotency                           |
| `isEdited`        | `boolean` | Whether the message has been edited                             |
| `isDeleted`       | `boolean` | Whether the message is a deletion tombstone                     |
| `statuses`        | `array`   | Delivery/read status per recipient                              |

**Errors:**

| Status | Code                   | Condition                           |
| ------ | ---------------------- | ----------------------------------- |
| 403    | `AUTHORIZATION_ERROR`  | User is not a conversation member   |
| 404    | `NOT_FOUND`            | Conversation does not exist         |

---

### `POST /api/v1/messages/conversations/:conversationId/messages`

Send a new encrypted message to a conversation. The server stores only the ciphertext — zero decryption is performed server-side (Rule R12). For group conversations (3+ recipients), delivery is fanned out via BullMQ (Rule R18).

**Authentication:** Required (must be a conversation participant)

**Path Parameters:**

| Parameter        | Type     | Description           |
| ---------------- | -------- | --------------------- |
| `conversationId` | `string` | Target conversation UUID |

**Request Body:**

```json
{
  "ciphertext": "base64-encoded-signal-protocol-ciphertext",
  "type": "TEXT",
  "replyToMessageId": "optional-message-uuid",
  "mediaId": "optional-media-uuid",
  "clientMessageId": "client-generated-uuid-v4"
}
```

| Field              | Type     | Required | Description                                        |
| ------------------ | -------- | -------- | -------------------------------------------------- |
| `ciphertext`       | `string` | Yes      | Base64-encoded encrypted message content (R12)     |
| `type`             | `string` | Yes      | Message type: `TEXT`, `IMAGE`, `VIDEO`, `AUDIO`, `DOCUMENT`, `VOICE_NOTE` |
| `replyToMessageId` | `string` | No       | UUID of message being replied to                   |
| `mediaId`          | `string` | No       | UUID of pre-uploaded encrypted media attachment    |
| `clientMessageId`  | `string` | Yes      | Client-generated UUID v4 for idempotency (R4)     |

**Response `201 Created`:**

```json
{
  "data": {
    "id": "message-uuid",
    "conversationId": "conversation-uuid",
    "senderId": "sender-uuid",
    "senderName": "Sender Name",
    "senderAvatar": "https://example.com/avatar.jpg",
    "ciphertext": "base64-encoded-ciphertext",
    "type": "TEXT",
    "status": "SENT",
    "replyTo": null,
    "mediaId": null,
    "linkPreview": null,
    "clientMessageId": "client-uuid",
    "isEdited": false,
    "isDeleted": false,
    "editedAt": null,
    "deletedAt": null,
    "serverTimestamp": "2026-03-30T10:00:00.000Z",
    "createdAt": "2026-03-30T10:00:00.000Z"
  }
}
```

**Errors:**

| Status | Code                   | Condition                             |
| ------ | ---------------------- | ------------------------------------- |
| 400    | `VALIDATION_ERROR`     | Invalid body (missing ciphertext, invalid type) |
| 403    | `AUTHORIZATION_ERROR`  | User is not a conversation participant |
| 404    | `NOT_FOUND`            | Conversation does not exist           |

---

### `PATCH /api/v1/messages/:messageId`

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

Returns the full updated `MessageResponse`:

```json
{
  "data": {
    "id": "msg-uuid",
    "conversationId": "conv-uuid",
    "senderId": "sender-uuid",
    "senderName": "Sender Name",
    "ciphertext": "base64-encoded-new-encrypted-content",
    "type": "TEXT",
    "status": "READ",
    "isEdited": true,
    "isDeleted": false,
    "editedAt": "2026-03-30T10:35:00.000Z",
    "clientMessageId": "client-uuid",
    "serverTimestamp": "2026-03-30T10:30:00.000Z",
    "createdAt": "2026-03-30T10:30:00.000Z"
  }
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
  "data": {
    "id": "msg-uuid",
    "conversationId": "conv-uuid",
    "isDeleted": true,
    "deletedAt": "2026-03-30T11:00:00.000Z"
  }
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

### `POST /api/v1/media`

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
| Images     | `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/heic`, `image/heif` |
| Videos     | `video/mp4`, `video/quicktime`, `video/webm`, `video/3gpp` |
| Audio      | `audio/mpeg`, `audio/mp4`, `audio/ogg`, `audio/webm`, `audio/wav`, `audio/aac` |
| Documents  | `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-powerpoint`, `application/vnd.openxmlformats-officedocument.presentationml.presentation`, `text/plain`, `text/csv`, `application/zip`, `application/x-rar-compressed` |

**Server Behavior (Rules R8, R27):**

1. Validate file size ≤ 25 MB — return `413 PAYLOAD_TOO_LARGE` if exceeded.
2. Validate declared `mimeType` against the server allowlist — return `415 UNSUPPORTED_MEDIA_TYPE` if disallowed.
3. Store the encrypted blob to the local filesystem.
4. If a thumbnail is provided, store it as a separate encrypted blob.
5. The server performs **no image processing** — thumbnails are generated client-side before encryption (Rule R27).

**Response `201 Created`:**

```json
{
  "data": {
    "mediaId": "media-uuid",
    "url": "/media/media-uuid",
    "thumbnailUrl": "/media/media-uuid-thumb",
    "mimeType": "image/jpeg",
    "size": 1234567
  }
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

Retrieve metadata for an encrypted media file. Returns a JSON object with the media record details. The client uses the `url` field to download the encrypted blob and is responsible for decryption.

**Authentication:** Required

**Path Parameters:**

| Parameter | Type     | Description |
| --------- | -------- | ----------- |
| `mediaId` | `string` | Media UUID  |

**Response `200 OK`:**

```json
{
  "data": {
    "id": "media-uuid",
    "userId": "uploader-uuid",
    "url": "/uploads/encrypted-file.bin",
    "thumbnailUrl": "/uploads/encrypted-thumb.bin",
    "mimeType": "image/jpeg",
    "size": 2457600,
    "encryptionKey": "base64-encoded-encryption-key",
    "encryptionIv": "base64-encoded-iv",
    "width": 1920,
    "height": 1080,
    "duration": null,
    "waveform": null,
    "createdAt": "2026-03-30T10:00:00.000Z"
  }
}
```

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
  "type": "TEXT",
  "content": "Hello, world!",
  "backgroundColor": "#FF6B6B"
}
```

*Or for media stories:*

```json
{
  "type": "IMAGE",
  "mediaId": "media-uuid"
}
```

| Field             | Type     | Required    | Constraints                                |
| ----------------- | -------- | ----------- | ------------------------------------------ |
| `type`            | `string` | Yes         | `"TEXT"`, `"IMAGE"`, or `"VIDEO"`          |
| `content`         | `string` | Conditional | Required for `"TEXT"` type, 1–700 chars    |
| `mediaId`         | `string` | Conditional | Required for `"IMAGE"` / `"VIDEO"` types   |
| `backgroundColor` | `string` | No          | Hex color for text stories (default `#128C7E`) |
| `fontStyle`       | `string` | No          | Font style identifier for text stories     |
| `duration`        | `number` | No          | Display duration in seconds (default 5)    |

**Response `201 Created`:**

```json
{
  "data": {
    "id": "story-uuid",
    "authorId": "user-uuid",
    "authorName": "alice@example.com",
    "type": "TEXT",
    "content": "Hello, world!",
    "backgroundColor": "#FF6B6B",
    "fontStyle": "sans-serif",
    "duration": 5,
    "viewCount": 0,
    "isExpired": false,
    "expiresAt": "2026-03-31T10:00:00.000Z",
    "createdAt": "2026-03-30T10:00:00.000Z"
  }
}
```

For media stories, the response additionally includes `mediaUrl` and `thumbnailUrl` fields.

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
      "userId": "user-uuid",
      "userName": "Martha Craig",
      "userAvatar": "/media/martha-avatar.jpg",
      "stories": [
        {
          "id": "story-uuid",
          "authorId": "user-uuid",
          "authorName": "Martha Craig",
          "type": "TEXT",
          "content": "Having a great day!",
          "backgroundColor": "#FF6B6B",
          "duration": 5,
          "viewCount": 5,
          "isExpired": false,
          "expiresAt": "2026-03-31T09:00:00.000Z",
          "createdAt": "2026-03-30T09:00:00.000Z"
        }
      ],
      "hasUnviewed": true,
      "latestStoryAt": "2026-03-30T09:00:00.000Z"
    }
  ]
}
```

| Field                    | Type      | Description                                    |
| ------------------------ | --------- | ---------------------------------------------- |
| `userId`                 | `string`  | Story author's user ID                         |
| `userName`               | `string`  | Story author's display name                    |
| `userAvatar`             | `string`  | Story author's avatar URL (optional)           |
| `stories`                | `array`   | Array of non-expired `StoryResponse` objects   |
| `stories[].viewCount`    | `number`  | Total number of unique views                   |
| `hasUnviewed`            | `boolean` | Whether the current user has unseen stories    |
| `latestStoryAt`          | `string`  | Timestamp of the most recent story             |

---

### `GET /api/v1/stories/me`

Retrieve the authenticated user's own active (non-expired) stories, sorted chronologically.

**Authentication:** Required

**Response `200 OK`:**

```json
{
  "data": [
    {
      "id": "story-uuid",
      "authorId": "current-user-uuid",
      "authorName": "alice@example.com",
      "type": "TEXT",
      "content": "Hello world!",
      "backgroundColor": "#FF6B6B",
      "fontStyle": "sans-serif",
      "duration": 5,
      "viewCount": 12,
      "isExpired": false,
      "expiresAt": "2026-03-31T10:00:00.000Z",
      "createdAt": "2026-03-30T10:00:00.000Z"
    }
  ]
}
```

---

### `POST /api/v1/stories/:storyId/view`

Record that the authenticated user has viewed a story. Duplicate views from the same user are idempotent.

**Authentication:** Required

**Path Parameters:**

| Parameter | Type     | Description |
| --------- | -------- | ----------- |
| `storyId` | `string` | Story UUID  |

**Response `200 OK`:**

Returns the created `StoryView` record, or `null` if the view was already recorded (idempotent duplicate):

```json
{
  "data": {
    "id": "view-uuid",
    "storyId": "story-uuid",
    "viewerId": "viewer-uuid",
    "viewerName": "John Doe",
    "viewerAvatar": "/media/avatar.jpg",
    "viewedAt": "2026-03-30T12:00:00.000Z"
  }
}
```

| Field          | Type     | Nullable | Description                         |
| -------------- | -------- | -------- | ----------------------------------- |
| `id`           | `string` | No       | View record UUID                    |
| `storyId`      | `string` | No       | ID of the story viewed              |
| `viewerId`     | `string` | No       | ID of the user who viewed           |
| `viewerName`   | `string` | No       | Display name of the viewer          |
| `viewerAvatar` | `string` | Yes      | Avatar URL of the viewer            |
| `viewedAt`     | `string` | No       | ISO 8601 timestamp of the view      |

> **Note:** If `data` is `null`, it indicates the view was already recorded on a prior request.

**Errors:**

| Status | Code         | Condition                |
| ------ | ------------ | ------------------------ |
| 404    | `NOT_FOUND`  | Story does not exist     |

---

### `DELETE /api/v1/stories/:storyId`

Delete a story. Only the **original author** may delete their story.

**Authentication:** Required (must be the story author)

**Path Parameters:**

| Parameter | Type     | Description |
| --------- | -------- | ----------- |
| `storyId` | `string` | Story UUID  |

**Response `200 OK`:**

```json
{
  "data": {
    "message": "Story deleted successfully"
  }
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
  "identityKey": {
    "publicKey": "base64-encoded-identity-public-key",
    "fingerprint": "optional-fingerprint-string"
  },
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "base64-encoded-signed-prekey",
    "signature": "base64-encoded-signature",
    "timestamp": 1711800000000
  },
  "preKeys": [
    {
      "keyId": 1,
      "publicKey": "base64-encoded-one-time-prekey"
    },
    {
      "keyId": 2,
      "publicKey": "base64-encoded-one-time-prekey"
    }
  ],
  "registrationId": 12345
}
```

| Field                             | Type     | Required | Description                                       |
| --------------------------------- | -------- | -------- | ------------------------------------------------- |
| `identityKey`                     | `object` | Yes      | Identity key object                               |
| `identityKey.publicKey`           | `string` | Yes      | Base64-encoded Curve25519 identity public key      |
| `identityKey.fingerprint`         | `string` | No       | Optional fingerprint for key verification          |
| `signedPreKey`                    | `object` | Yes      | Signed prekey object                              |
| `signedPreKey.keyId`              | `number` | Yes      | Signed prekey identifier                          |
| `signedPreKey.publicKey`          | `string` | Yes      | Base64-encoded signed prekey                      |
| `signedPreKey.signature`          | `string` | Yes      | Base64-encoded signature over the prekey          |
| `signedPreKey.timestamp`          | `number` | Yes      | Epoch milliseconds when the signed prekey was generated |
| `preKeys`                         | `array`  | Yes      | Array of one-time prekeys (recommended 10)        |
| `preKeys[].keyId`                 | `number` | Yes      | One-time prekey identifier                        |
| `preKeys[].publicKey`             | `string` | Yes      | Base64-encoded one-time prekey                    |
| `registrationId`                  | `number` | Yes      | Signal Protocol registration ID                   |

**Response `201 Created`:**

```json
{
  "data": {
    "message": "Prekey bundle uploaded successfully",
    "preKeysCount": 10
  }
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
  "data": {
    "userId": "target-user-uuid",
    "identityKey": {
      "publicKey": "base64-encoded-identity-public-key"
    },
    "signedPreKey": {
      "keyId": 1,
      "publicKey": "base64-encoded-signed-prekey",
      "signature": "base64-encoded-signature",
      "timestamp": 1711800000000
    },
    "preKey": {
      "keyId": 42,
      "publicKey": "base64-encoded-one-time-prekey"
    },
    "registrationId": 12345
  }
}
```

| Field            | Type     | Nullable | Description                                                     |
| ---------------- | -------- | -------- | --------------------------------------------------------------- |
| `identityKey`    | `object` | No       | Contains `publicKey` (string)                                   |
| `signedPreKey`   | `object` | No       | Contains `keyId`, `publicKey`, `signature`, `timestamp`         |
| `preKey`         | `object` | Yes      | May be null if all one-time prekeys are exhausted               |
| `registrationId` | `number` | No       | Signal Protocol registration ID                                 |

**Errors:**

| Status | Code         | Condition                            |
| ------ | ------------ | ------------------------------------ |
| 404    | `NOT_FOUND`  | User does not exist or has no bundle |

**Note:** If `preKey` is null, the client falls back to using only the signed prekey for session establishment (reduced forward secrecy until the target user replenishes).

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
  "data": {
    "status": "healthy",
    "timestamp": "2026-03-30T10:00:00.000Z",
    "uptime": 86400,
    "components": {
      "database": {
        "status": "up",
        "latency": 5
      },
      "redis": {
        "status": "up",
        "latency": 2
      },
      "queue": {
        "status": "up",
        "latency": 1
      },
      "storage": {
        "status": "up",
        "latency": 0
      }
    }
  }
}
```

| Field                        | Type     | Description                                   |
| ---------------------------- | -------- | --------------------------------------------- |
| `data.status`                | `string` | `"healthy"` if all components are up; `"degraded"` or `"unhealthy"` otherwise |
| `data.timestamp`             | `string` | ISO 8601 timestamp of the health check        |
| `data.uptime`                | `number` | Server uptime in seconds                      |
| `data.components.database`   | `object` | PostgreSQL connectivity: `status` (`"up"` or `"down"`), `latency` (ms) |
| `data.components.redis`      | `object` | Redis connectivity: `status`, `latency`       |
| `data.components.queue`      | `object` | Queue (BullMQ via Redis) connectivity: `status`, `latency` |
| `data.components.storage`    | `object` | File storage accessibility: `status`, `latency` |

**Response `503 Service Unavailable`** (when any critical component is down):

```json
{
  "data": {
    "status": "unhealthy",
    "timestamp": "2026-03-30T10:00:00.000Z",
    "uptime": 86400,
    "components": {
      "database": {
        "status": "down",
        "latency": -1
      },
      "redis": {
        "status": "up",
        "latency": 2
      },
      "queue": {
        "status": "up",
        "latency": 1
      },
      "storage": {
        "status": "up",
        "latency": 0
      }
    }
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

| Metric Name                        | Type            | Description                                         |
| ---------------------------------- | --------------- | --------------------------------------------------- |
| `http_requests_total`              | Counter         | Total HTTP requests by method, path, and status     |
| `http_request_duration_seconds`    | Histogram       | HTTP request latency in seconds                     |
| `http_active_requests`             | UpDownCounter   | Currently in-flight HTTP requests                   |
| `ws_connections_total`             | Counter         | Total WebSocket connections established             |
| `ws_active_connections`            | UpDownCounter   | Current active WebSocket connections                |
| `ws_messages_total`                | Counter         | Total WebSocket messages processed                  |
| `bullmq_jobs_total`               | Counter         | Total jobs enqueued by queue name and status        |
| `bullmq_job_duration`             | Histogram       | BullMQ job processing duration in seconds           |
| `bullmq_queue_depth`              | UpDownCounter   | Number of pending jobs per queue name               |
| `db_query_duration`               | Histogram       | Database query latency in seconds (p50, p95, p99)   |
| `db_active_connections`           | UpDownCounter   | Active database connection pool count               |

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

# HELP ws_active_connections Active WebSocket connections
# TYPE ws_active_connections gauge
ws_active_connections 42
```

**Implementation:** OpenTelemetry SDK with Prometheus exporter (`@opentelemetry/exporter-prometheus`).

---

## Calls — `/api/v1/calls` (Stub)

Call history endpoints. **Note:** WebRTC voice/video calling is out of scope (AAP §0.8.2). These stub endpoints exist so the Calls UI screen (Figma Screen 11) renders a graceful empty state instead of a 404 error. They are defined inline in `apps/api/src/routes/v1/index.ts`.

---

### `GET /api/v1/calls`

Retrieve call history. Returns an empty array (stub).

**Authentication:** Required

**Response `200 OK`:**

```json
{
  "data": [],
  "hasMore": false
}
```

---

### `DELETE /api/v1/calls/:callId`

Delete a single call history entry. No-op stub.

**Authentication:** Required

**Response `204 No Content`:** Empty body.

---

### `DELETE /api/v1/calls`

Clear all call history. No-op stub.

**Authentication:** Required

**Response `204 No Content`:** Empty body.

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
| `/api/v1/calls`          | Inline stubs in `apps/api/src/routes/v1/index.ts`    |
| `/api/v1/health`         | `apps/api/src/routes/v1/health.routes.ts`            |
| `/api/v1/metrics`        | `apps/api/src/routes/v1/health.routes.ts`            |

**Middleware chain** (applied in order via `apps/api/src/app.ts`):

1. `trust proxy` — Enables reverse proxy support
2. `cors` — Cross-origin configuration (Rule R38: `http://localhost:3000`)
3. `helmet` — Security headers
4. `compression` — Response compression
5. `express.json` — JSON body parsing (26 MB limit)
6. `express.urlencoded` — URL-encoded body parsing
7. `correlation-id` — Assigns UUID v4 correlation ID (Rule R29)
8. `pino-http` — Structured HTTP request logging (Rule R28)
9. `metrics` — OpenTelemetry HTTP instrumentation (Rule R37)
10. **API v1 routes** — All `/api/v1/*` route handlers (auth + validation applied per-route)
11. `404 catch-all` — Returns 404 for unmatched routes
12. `error-handler` — Global error handler (Rule R22) — registered last

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
