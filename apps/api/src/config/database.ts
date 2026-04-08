// =============================================================================
// Kalle — WhatsApp Clone · Prisma Client Initialization with Connection Pooling
// =============================================================================
//
// Creates and configures a PrismaClient instance with event-based logging and
// optional datasource URL override. Called by the composition root (server.ts)
// to produce the single PrismaClient instance shared by all repositories.
//
// Architecture Rules:
//   R16 — Repositories import PrismaClient; services/controllers NEVER do.
//   R28 — Zero console.log calls; Prisma log levels emit events for Pino.
//   R7  — Compiles under tsc --noEmit --strict with zero warnings.
//   R26 — This module does NOT validate env vars; it receives a pre-validated
//         databaseUrl string from the composition root.
//   R24 — Only creates the client; migration execution is external.
//
// Connection Pooling:
//   Prisma automatically manages a connection pool via its query engine.
//   Pool size is controlled by the `connection_limit` query parameter in the
//   DATABASE_URL (e.g., ?connection_limit=10). The default pool size is
//   num_cpus × 2 + 1, which is typically sufficient for Docker development.
//
// =============================================================================

import { PrismaClient } from '@prisma/client';

/**
 * Factory function that creates and returns a new PrismaClient instance.
 *
 * The composition root (`server.ts`) calls this function exactly once, then
 * passes the resulting client to every repository via dependency injection.
 * Singleton behavior is enforced by the composition root — not by this module.
 *
 * @param databaseUrl - Optional PostgreSQL connection string override.
 *   When provided, overrides the `env("DATABASE_URL")` declared in
 *   `prisma/schema.prisma`. When omitted, Prisma falls back to the
 *   `DATABASE_URL` environment variable.
 *
 * @returns A configured `PrismaClient` ready for `$connect()`.
 *
 * @remarks
 * - **No `$connect()` call is made here.** The composition root is responsible
 *   for calling `await prisma.$connect()` to verify connectivity before
 *   accepting traffic. This keeps the factory pure and testable.
 * - **Log levels are configured as events**, not stdout. This allows the
 *   composition root to attach Pino-based event handlers so that Prisma logs
 *   flow through the same structured logging pipeline with correlation IDs
 *   (Rule R28 / Rule R29).
 *
 * @example
 * ```typescript
 * // In server.ts (composition root):
 * import { createPrismaClient } from './config/database.js';
 *
 * const prisma = createPrismaClient(env.DATABASE_URL);
 * await prisma.$connect();
 * logger.info('PostgreSQL connected');
 * ```
 */
export function createPrismaClient(databaseUrl?: string): PrismaClient {
  const prisma = new PrismaClient({
    // When a databaseUrl is supplied, override the datasource declared in
    // schema.prisma. Otherwise leave undefined so Prisma reads DATABASE_URL
    // from the process environment automatically.
    datasources: databaseUrl
      ? {
          db: {
            url: databaseUrl,
          },
        }
      : undefined,

    // Emit all log levels as events rather than writing to stdout/stderr.
    // The composition root attaches Pino event handlers to these events,
    // ensuring every Prisma log entry goes through the structured logging
    // pipeline complete with correlation IDs and JSON formatting (Rule R28).
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'info' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });

  return prisma;
}

// Re-export PrismaClient as a *type* so that consumers (server.ts, repository
// constructors, HealthService) can type their parameters without importing
// directly from @prisma/client. This keeps the dependency on Prisma centralised
// in this configuration module.
export type { PrismaClient } from '@prisma/client';
