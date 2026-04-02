# Kalle — WhatsApp Clone

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)

A **production-grade, horizontally scalable WhatsApp clone web application** built as a Figma-to-code pipeline demo artifact for a technical audience. Every feature functions against a live backend with persistent data — no mocks, no stubs, no localStorage-only persistence.

---

## Features

- **Real-Time Encrypted Messaging (1:1 and Group)** — End-to-end encryption via Signal Protocol. 1:1 conversations use standard Signal sessions; group conversations use Sender Key distribution with automatic rotation on membership changes. The server stores only ciphertext and contains zero decryption logic.
- **Media Sharing with Client-Side Encryption** — Image, video, document, and voice note uploads encrypted client-side before upload (≤ 25 MB). Thumbnails generated client-side before encryption. Voice notes include waveform visualization and playback controls.
- **Message Lifecycle Operations** — Message editing (sender-only, 15-minute window), message deletion (soft-delete tombstone with ciphertext nulled), reply-to with inline quoted preview, and asynchronous link preview extraction via BullMQ.
- **Real-Time Presence and Status Indicators** — Online/offline/last-seen presence, typing indicators (server-side debounced at 3-second intervals with 5-second expiry), and message status tracking (sent → delivered → read receipts).
- **Stories / Status** — Text and image/video stories with 24-hour expiration, view tracking, and automated media cleanup via hourly BullMQ job.
- **Client-Side Message Search** — Full-text search against decrypted messages persisted in IndexedDB. Zero plaintext or search tokens sent to the server.
- **Contact and Conversation Management** — User search, contact list, block/unblock, conversation archive/unarchive, mute/unmute, unread count badges, and user profile editing (avatar, display name, about).
- **Offline-to-Online Reconciliation** — On WebSocket reconnect the client syncs all missed messages via the `message:sync` protocol with zero message loss or duplication.
- **Session Security** — JWT-based authentication with Redis-backed token blacklist, single-session and all-sessions force logout (revoke / revoke-all), and refresh token rotation.
- **Observability Stack** — Structured Pino JSON logging with correlation ID propagation, Prometheus-compatible metrics endpoint via OpenTelemetry, and component-level health checks.
- **Immutable Audit Trail** — Append-only audit log for security-sensitive actions with restricted database permissions (no UPDATE/DELETE on the `audit_log` table).
- **Docker-First Local Development** — Entire stack runs via `docker compose up` — PostgreSQL 16, Redis 7, backend, frontend, BullMQ worker, backup service, and OpenTelemetry collector — with hot reload, automatic migrations, and deterministic seed data.

---

## Architecture

Kalle is organized as a **monorepo** using npm workspaces and [Turborepo](https://turbo.build/) for build orchestration. Shared TypeScript types and DTOs live in a dedicated package consumed by both the frontend and the backend.

```
kalle/
├── docker-compose.yml          # Full-stack orchestration
├── .env.example                # Environment variable template
├── package.json                # Root workspace configuration
├── turbo.json                  # Monorepo build pipeline
├── tsconfig.base.json          # Shared TypeScript compiler options
├── packages/
│   └── shared/                 # Shared TypeScript types, DTOs, Zod validators
├── apps/
│   ├── web/                    # Next.js 14 App Router frontend
│   └── api/                    # Express 4 backend + Socket.IO server
├── workers/
│   └── queue/                  # BullMQ worker process
├── prisma/                     # Database schema, migrations, seed script
├── scripts/                    # Docker entrypoint, wait-for-it, backup scripts
├── docs/                       # Architecture, API reference, WebSocket events, encryption
├── e2e/                        # Playwright end-to-end tests
└── backups/                    # Database backup volume mount
```

### Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Frontend** | Next.js (App Router) | 14.x |
| **UI Framework** | React | 18.x |
| **State Management** | Zustand | 4.x |
| **Styling** | Tailwind CSS | 3.x |
| **Real-Time (Client)** | Socket.IO Client | 4.x |
| **E2E Encryption** | libsignal-protocol-javascript | 1.6.x |
| **Client Search** | Dexie.js (IndexedDB) | 4.x |
| **Backend** | Express | 4.x |
| **Real-Time (Server)** | Socket.IO + Redis Adapter | 4.x |
| **Database** | PostgreSQL | 16 |
| **ORM** | Prisma | 5.x |
| **Cache / Pub-Sub** | Redis | 7 |
| **Job Queue** | BullMQ | 5.x |
| **Validation** | Zod | 3.x |
| **Logging** | Pino | 8.x |
| **Metrics** | OpenTelemetry SDK → Prometheus | 1.x |
| **Language** | TypeScript | 5.4.x |
| **Build System** | Turborepo | 2.x |
| **E2E Testing** | Playwright | 1.44.x |
| **Containers** | Docker Compose | — |

### High-Level Data Flow

```
┌──────────────┐   REST / WS   ┌──────────────┐
│  Next.js 14  │◄─────────────►│  Express API  │
│  (Frontend)  │               │  + Socket.IO  │
└──────────────┘               └──────┬───────┘
                                      │
                     ┌────────────────┼────────────────┐
                     │                │                │
              ┌──────▼──────┐  ┌──────▼──────┐  ┌─────▼──────┐
              │ PostgreSQL  │  │    Redis     │  │  BullMQ    │
              │   (Data)    │  │ (Cache/PubSub│  │  (Worker)  │
              └─────────────┘  └─────────────┘  └────────────┘
```

---

## Getting Started

### Prerequisites

| Requirement | Minimum Version |
|-------------|----------------|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | 24.x |
| [Git](https://git-scm.com/) | 2.x |

No other tools, cloud accounts, SaaS subscriptions, or external API keys are required. The entire stack runs locally inside Docker.

### Single-Command Bootstrap

```bash
git clone https://github.com/Blitzy-Sandbox/kalle.git && cd kalle
cp .env.example .env
docker compose up
```

That is all. On first boot the system automatically:

1. Starts PostgreSQL 16 and Redis 7 containers.
2. Waits for database readiness.
3. Runs all Prisma migrations to create the schema.
4. Seeds the database with deterministic demo data (users, conversations, messages with valid ciphertext, encryption key bundles).
5. Starts the Express API server, Next.js frontend, BullMQ worker, backup service, and OpenTelemetry collector.

### Access Points

| Service | URL |
|---------|-----|
| **Frontend** | [http://localhost:3000](http://localhost:3000) |
| **API** | [http://localhost:3001](http://localhost:3001) |
| **Health Check** | [http://localhost:3001/api/v1/health](http://localhost:3001/api/v1/health) |
| **Metrics (Prometheus)** | [http://localhost:3001/api/v1/metrics](http://localhost:3001/api/v1/metrics) |
| **OTel Collector (Prometheus export)** | [http://localhost:8889/metrics](http://localhost:8889/metrics) |

---

## Development Guide

### Hot Reload

Both the frontend and backend support hot reload via Docker volume mounts — source file changes are reflected immediately without restarting containers.

| Service | Mechanism |
|---------|-----------|
| Frontend (Next.js) | Fast Refresh via `next dev` |
| Backend (Express) | File watching via `tsx watch` / `nodemon` |
| Worker (BullMQ) | File watching via `tsx watch` |

### Running Without Docker

If you prefer running services directly on your host for debugging:

```bash
# Install dependencies
npm install --legacy-peer-deps

# Generate Prisma client (requires DATABASE_URL in .env pointing to a running PostgreSQL)
npx prisma generate

# Run database migrations
npx prisma migrate dev

# Seed the database
npx prisma db seed

# Start the API server (development)
npm run dev --workspace=apps/api

# Start the frontend (development)
npm run dev --workspace=apps/web

# Start the worker (development)
npm run dev --workspace=workers/queue
```

### Build

```bash
# Build all packages via Turborepo
npx turbo run build

# Build individual packages
npx turbo run build --filter=@kalle/shared
npx turbo run build --filter=@kalle/api
npx turbo run build --filter=@kalle/web
npx turbo run build --filter=@kalle/worker
```

### Testing

```bash
# Unit tests — backend (Jest)
cd apps/api && npx jest --watchAll=false --ci

# Unit tests — frontend (Vitest)
cd apps/web && npx vitest run

# TypeScript type checking across all packages
npx turbo run typecheck

# End-to-end tests (Playwright — requires running stack)
npm run test:e2e
```

### Linting and Formatting

The project enforces a **zero-warnings build** policy. Both `tsc --noEmit --strict` and ESLint must pass with zero warnings or errors.

```bash
# Lint all packages
npm run lint

# Format all files with Prettier
npm run format

# Check formatting without writing changes
npm run format:check
```

### Database Operations

All schema changes use [Prisma Migrate](https://www.prisma.io/docs/concepts/components/prisma-migrate) — never `prisma db push`. Migration files are committed to version control.

```bash
# Create a new migration after editing prisma/schema.prisma
npx prisma migrate dev --name describe_your_change

# Apply pending migrations (production / CI)
npx prisma migrate deploy

# Re-seed the database with deterministic demo data
npx prisma db seed

# Open Prisma Studio (visual database browser)
npx prisma studio
```

### Environment Variables

All required environment variables are defined in [`.env.example`](.env.example) with sensible local defaults. Copy it to `.env` before running:

```bash
cp .env.example .env
```

The API server validates every required variable on boot via a Zod schema (`apps/api/src/config/env.ts`). If any variable is missing or invalid the server fails immediately with a descriptive error listing every problem.

Key variable groups:

| Group | Variables | Purpose |
|-------|----------|---------|
| Database | `DATABASE_URL`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | PostgreSQL connection |
| Redis | `REDIS_URL`, `BULL_REDIS_URL` | Cache, pub-sub, job queue |
| Auth | `JWT_SECRET`, `JWT_ACCESS_TOKEN_EXPIRY`, `JWT_REFRESH_TOKEN_EXPIRY` | JWT signing and rotation |
| Server | `PORT`, `API_PORT`, `WEB_PORT`, `NODE_ENV` | Ports and runtime mode |
| CORS | `CORS_ORIGIN` | Allowed frontend origins |
| Storage | `UPLOAD_DIR`, `MAX_FILE_SIZE` | Encrypted media uploads (25 MB limit) |
| Logging | `LOG_LEVEL` | Pino structured log level |
| Telemetry | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` | OpenTelemetry collector |
| Backup | `BACKUP_RETENTION_DAYS`, `BACKUP_CRON`, `BACKUP_DIR` | Daily pg_dump archives |

---

## API Reference

All REST endpoints are prefixed with **`/api/v1/`**. Every endpoint (except auth and health) requires a valid JWT in the `Authorization: Bearer <token>` header.

### Endpoint Groups

| Prefix | Purpose | Auth Required |
|--------|---------|:---:|
| `/api/v1/auth` | Register, login, token refresh, session revocation | No |
| `/api/v1/users` | Profile CRUD, user search, block/unblock | Yes |
| `/api/v1/conversations` | Conversation list, create, membership, archive, mute | Yes |
| `/api/v1/messages` | Send, edit, delete, message history (cursor-paginated) | Yes |
| `/api/v1/media` | Encrypted media upload with MIME validation | Yes |
| `/api/v1/stories` | Create, feed, view tracking, delete | Yes |
| `/api/v1/keys` | PreKey bundle upload and fetch (Signal Protocol) | Yes |
| `/api/v1/health` | Component-level health checks (DB, Redis, BullMQ, storage) | No |
| `/api/v1/metrics` | Prometheus-compatible metrics (HTTP latency, WS connections, queue depth) | No |

### WebSocket Events

Real-time communication uses [Socket.IO](https://socket.io/) with a Redis adapter for horizontal scaling. Connections authenticate via JWT during the handshake.

| Event | Direction | Description |
|-------|-----------|-------------|
| `message:send` | Client → Server | Send an encrypted message |
| `message:new` | Server → Client | Deliver a new message to recipients |
| `message:edit` | Client → Server | Edit message ciphertext (15-min window) |
| `message:edited` | Server → Client | Broadcast edited message to participants |
| `message:delete` | Client → Server | Soft-delete a message (tombstone) |
| `message:deleted` | Server → Client | Broadcast deletion to participants |
| `message:delivered` | Client → Server | Acknowledge message delivery |
| `message:read` | Client → Server | Mark messages as read |
| `message:status` | Server → Client | Delivery/read receipt update |
| `message:sync` | Client → Server | Request missed messages after reconnect |
| `message:sync:response` | Server → Client | Batch of missed messages |
| `typing:start` | Client → Server | User started typing (debounced 3 s) |
| `typing:stop` | Client → Server | User stopped typing |
| `typing:indicator` | Server → Client | Typing state broadcast to conversation |
| `user:presence` | Server → Client | Online/offline/last-seen updates |

> For complete request/response schemas see [`docs/api-reference.md`](docs/api-reference.md) and [`docs/websocket-events.md`](docs/websocket-events.md).

---

## Security and Encryption

### End-to-End Encryption

All messages are encrypted and decrypted exclusively on the client using the **Signal Protocol** (`libsignal-protocol-javascript`). The server stores and transmits only ciphertext — there is zero decryption logic anywhere in the backend codebase.

- **1:1 Conversations** — Standard Signal Protocol sessions (X3DH key agreement + Double Ratchet).
- **Group Conversations** — Sender Key distribution. Keys automatically rotate when a member is removed, ensuring removed members cannot decrypt post-removal messages and added members cannot decrypt pre-join messages.
- **Media** — Files are encrypted client-side before upload. The client generates a thumbnail (max 200 px longest edge) and encrypts it separately from the full-size file. Both are uploaded as distinct encrypted blobs.

### Authentication and Sessions

- JWT access tokens (short-lived) with refresh token rotation.
- Revoked tokens are blacklisted in Redis (keyed by JTI, TTL equals remaining token expiry). The auth middleware checks the blacklist on every request.
- `revoke-all` invalidates every active session for the user.
- Single active session per user — a second login invalidates the previous session.

### Audit Trail

Security-sensitive actions (login, login failure, session revocation, block/unblock, group membership changes, message deletion, key bundle upload) are recorded in an append-only `audit_log` table. The application database role has no `UPDATE` or `DELETE` permissions on this table. Metadata fields never contain message content, encryption keys, tokens, or file contents.

### Log Hygiene

Application logs never contain JWT tokens, passwords, plaintext message content, encryption keys, or prekey material. All backend logging uses Pino with structured JSON output and per-request correlation IDs.

> For a detailed encryption implementation guide see [`docs/encryption.md`](docs/encryption.md).

---

## Docker Services

The `docker-compose.yml` orchestrates seven services:

| Service | Image | Port(s) | Health Check |
|---------|-------|---------|-------------|
| **postgres** | `postgres:16-alpine` | 5432 | `pg_isready` |
| **redis** | `redis:7-alpine` | 6379 | `redis-cli ping` |
| **api** | Custom (`Dockerfile.api`) | 3001 | `GET /api/v1/health` |
| **web** | Custom (`Dockerfile.web`) | 3000 | HTTP 200 on root |
| **worker** | Custom (`Dockerfile.worker`) | — | BullMQ worker active |
| **backup** | Custom (`Dockerfile.backup`) | — | Backup file recency |
| **otel-collector** | `otel/opentelemetry-collector` | 4317, 8889 | gRPC health |

The backup service produces daily `pg_dump` archives to `./backups/` with a configurable retention period (default: 7 days).

---

## Project Documentation

| Document | Description |
|----------|-------------|
| [`docs/architecture.md`](docs/architecture.md) | Architecture decision records and system design |
| [`docs/api-reference.md`](docs/api-reference.md) | Complete REST API endpoint documentation |
| [`docs/websocket-events.md`](docs/websocket-events.md) | WebSocket event payload contracts |
| [`docs/encryption.md`](docs/encryption.md) | End-to-end encryption implementation guide |

---

## Contributing

1. Fork the repository and create a feature branch.
2. Ensure your changes pass the zero-warnings build: `npx turbo run typecheck && npm run lint`.
3. Write or update tests for any new or changed functionality.
4. Run the full test suite: `npm run test && npm run test:e2e`.
5. Submit a pull request with a clear description of the changes.

---

## License

This project is licensed under the **MIT License**. See [LICENSE](LICENSE) for details.

© 2026 Blitzy Sandbox
