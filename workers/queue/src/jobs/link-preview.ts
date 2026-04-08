// =============================================================================
// Kalle — WhatsApp Clone · BullMQ Link Preview Extraction Job
// =============================================================================
//
// URL OG metadata extraction job processor (Rule R18).
// When a message contains a URL, the API server enqueues a `link-preview` job.
// This processor:
//   1. Validates the URL (protocol, SSRF protection)
//   2. Verifies the originating message still exists and is not deleted
//   3. Fetches Open Graph metadata via `open-graph-scraper` with 5-second timeout
//   4. Sanitises and truncates extracted fields
//   5. Persists the preview data to the database
//   6. Publishes a `link:preview` event via Redis pub/sub for Socket.IO broadcast
//
// Non-critical failures (no OG tags, 404, timeout) are logged and discarded.
// Retryable failures (network, DNS, DB) are re-thrown for BullMQ retry.
//
// Critical Rules:
//   R7  — Zero warnings build; strict TypeScript; no `any` types.
//   R12 — Messages are E2E encrypted; the URL is explicitly provided in the
//          job payload by the client or a pre-encryption processing step.
//   R18 — Link preview extraction goes through BullMQ.
//   R23 — No full URLs in logs; only domain for safety.
//   R28 — All logging via Pino JSON. Zero console.log.
//   R29 — Correlation ID in every log entry.
// =============================================================================

import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import ogs from 'open-graph-scraper';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Job payload received from the API server's queue producer. */
interface LinkPreviewPayload {
  /** UUID v4 for end-to-end request tracing (Rule R29). */
  correlationId: string;
  /** Primary key of the message that contains the URL. */
  messageId: string;
  /** Conversation the message belongs to (for Socket.IO room targeting). */
  conversationId: string;
  /** URL to scrape for Open Graph metadata. */
  url: string;
}

/**
 * Shared worker execution context injected by the parent worker bootstrap
 * (`workers/queue/src/index.ts`). Defined locally to avoid circular imports
 * — mirrors the exported `WorkerContext` interface from `index.ts`.
 */
interface WorkerContext {
  /** Prisma ORM client for database access. */
  prisma: PrismaClient;
  /** Root Pino logger instance — child logger created per job. */
  logger: Logger;
  /** IORedis connection used for pub/sub event emission. */
  redisConnection: RedisPublisher;
}

/**
 * Minimal Redis publish contract. Avoids importing `ioredis` directly —
 * the actual IORedis instance satisfies this interface at runtime.
 */
interface RedisPublisher {
  publish(channel: string, message: string): Promise<number>;
}

/** Sanitised Open Graph metadata extracted from a URL. */
interface LinkPreviewData {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
}

/** WebSocket event payload published via Redis for Socket.IO broadcast. */
interface LinkPreviewEvent {
  messageId: string;
  conversationId: string;
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  correlationId: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * OG scraper HTTP timeout in **seconds** (open-graph-scraper uses seconds).
 * 5-second limit per AAP folder requirements.
 */
const OGS_TIMEOUT_SECONDS = 5;

/** Maximum characters retained for a preview title. */
const MAX_TITLE_LENGTH = 500;

/** Maximum characters retained for a preview description. */
const MAX_DESCRIPTION_LENGTH = 1_000;

/** Maximum characters retained for site name. */
const MAX_SITE_NAME_LENGTH = 200;

/** Redis pub/sub channel prefix for link-preview events. */
const LINK_PREVIEW_CHANNEL_PREFIX = 'kalle:events:link-preview';

/** User-Agent header sent with OG scraper requests. */
const OGS_USER_AGENT = 'KalleBot/1.0 (+https://github.com/kalle)';

/** Allowed URL protocols — all others are rejected (SSRF prevention). */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Regular expressions matching private / reserved IP ranges and hostnames.
 * Used to prevent Server-Side Request Forgery (SSRF) attacks by blocking
 * requests to internal network resources.
 */
const PRIVATE_IP_PATTERNS: readonly RegExp[] = [
  /^127\./,                           // IPv4 loopback
  /^10\./,                            // Class A private
  /^172\.(1[6-9]|2\d|3[01])\./,      // Class B private
  /^192\.168\./,                      // Class C private
  /^0\./,                             // Current network
  /^169\.254\./,                      // IPv4 link-local
  /^::1$/,                            // IPv6 loopback
  /^fc00:/i,                          // IPv6 unique-local
  /^fe80:/i,                          // IPv6 link-local
  /^localhost$/i,                     // localhost alias
];

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the hostname resolves to a private or reserved address.
 * Prevents SSRF by blocking requests to internal network resources.
 */
function isPrivateHostname(hostname: string): boolean {
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname));
}

/**
 * Truncates a string to `maxLength` characters, returning `null` for
 * undefined, null, or empty values.
 */
function truncate(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  if (!value) return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/**
 * Resolves a possibly-relative image URL against the page's base URL.
 * Rejects non-HTTP(S) protocols and returns `null` on parsing failure.
 */
function resolveImageUrl(
  imageUrl: string | null | undefined,
  baseUrl: string,
): string | null {
  if (!imageUrl) return null;
  try {
    // Absolute URL — validate protocol and return
    const parsed = new URL(imageUrl);
    if (ALLOWED_PROTOCOLS.has(parsed.protocol)) return parsed.href;
    return null;
  } catch {
    // Relative URL — resolve against the source page
    try {
      const resolved = new URL(imageUrl, baseUrl);
      if (ALLOWED_PROTOCOLS.has(resolved.protocol)) return resolved.href;
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Determines whether an error is transient and warrants a BullMQ retry.
 *
 * Retryable: network / DNS failures, HTTP 5xx server errors, database errors.
 * Non-retryable: invalid URL, HTTP 4xx client errors, timeouts, missing OG tags.
 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();

  // Network / DNS failures → retry
  if (
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('econnreset') ||
    msg.includes('epipe') ||
    msg.includes('ehostunreach') ||
    msg.includes('enetunreach')
  ) {
    return true;
  }

  // HTTP 5xx server errors → retry
  if (
    msg.includes('status code 500') ||
    msg.includes('status code 502') ||
    msg.includes('status code 503') ||
    msg.includes('status code 504') ||
    msg.includes('internal server error') ||
    msg.includes('bad gateway') ||
    msg.includes('service unavailable')
  ) {
    return true;
  }

  // Prisma / database connectivity errors → retry
  if (
    msg.includes('prisma') ||
    msg.includes('database') ||
    msg.includes('connection') ||
    msg.includes('p1001') || // Prisma: Can't reach database server
    msg.includes('p1002')    // Prisma: Timed out connecting to database
  ) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Exported Processor
// ---------------------------------------------------------------------------

/**
 * BullMQ job processor for link preview extraction.
 *
 * **Flow:**
 *  1. Validate & parse the URL (protocol + SSRF check)
 *  2. Verify the originating message still exists and is not deleted
 *  3. Fetch OG metadata via `open-graph-scraper` with 5 s timeout
 *  4. Sanitise & truncate extracted fields
 *  5. Persist the preview data in the database (raw SQL — the Prisma Message
 *     model does not include a dedicated link-preview column)
 *  6. Publish a `link:preview` event via Redis for Socket.IO broadcast
 *
 * **Error policy:**
 *  - Non-critical (no OG tags, 404, 403, timeout) → log + return (no retry)
 *  - Retryable (network, DNS, 5xx, DB) → log + re-throw (BullMQ retries)
 */
export async function processLinkPreview(
  job: Job<LinkPreviewPayload>,
  context: WorkerContext,
): Promise<void> {
  const { correlationId, messageId, conversationId, url } = job.data;

  // Child logger with per-job correlation context (Rule R29)
  const logger = context.logger.child({
    correlationId,
    jobId: job.id,
    messageId,
  });

  const startTime = Date.now();

  // -----------------------------------------------------------------------
  // 1. URL Validation & SSRF Prevention
  // -----------------------------------------------------------------------

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    logger.warn({ messageId }, 'Invalid URL format — skipping link preview');
    return; // Non-retryable: malformed URL
  }

  // Log only the domain, never the full URL (Rule R23)
  const urlDomain = parsedUrl.hostname;

  // Protocol whitelist — reject file://, ftp://, data:, etc.
  if (!ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
    logger.warn(
      { urlDomain, protocol: parsedUrl.protocol, messageId },
      'Rejected URL with disallowed protocol',
    );
    return; // Non-retryable
  }

  // Private / reserved IP check — SSRF prevention
  if (isPrivateHostname(urlDomain)) {
    logger.warn(
      { urlDomain, messageId },
      'Rejected URL targeting private/internal address',
    );
    return; // Non-retryable: SSRF attempt
  }

  logger.info({ urlDomain, conversationId }, 'Starting link preview extraction');

  try {
    // -------------------------------------------------------------------
    // 2. Verify originating message still exists
    // -------------------------------------------------------------------

    const message = await context.prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, isDeleted: true },
    });

    if (!message) {
      logger.warn({ messageId }, 'Message not found — skipping link preview');
      return; // Non-retryable: message deleted between enqueue and processing
    }

    if (message.isDeleted) {
      logger.info({ messageId }, 'Message already deleted — skipping link preview');
      return; // Non-retryable
    }

    // -------------------------------------------------------------------
    // 3. Fetch OG metadata via open-graph-scraper
    // -------------------------------------------------------------------

    const ogsResponse = await ogs({
      url,
      timeout: OGS_TIMEOUT_SECONDS,
      fetchOptions: {
        headers: {
          'User-Agent': OGS_USER_AGENT,
        },
      },
    });

    // open-graph-scraper v6.x returns SuccessResult | ErrorResult.
    // SuccessResult: { error: false, result: OgObject, html, response }
    // ErrorResult:   { error: true,  result: OgObject (partial), html: undefined }
    if (ogsResponse.error) {
      logger.warn({ urlDomain, messageId }, 'OG metadata extraction returned error');
      return; // Non-retryable: missing link preview is acceptable
    }

    const ogResult = ogsResponse.result;

    // Bail out if the OgObject indicates failure
    if (ogResult.success === false) {
      logger.warn({ urlDomain, messageId }, 'OG scraper reported unsuccessful extraction');
      return;
    }

    // -------------------------------------------------------------------
    // 4. Extract, resolve, and sanitise metadata
    // -------------------------------------------------------------------

    const rawTitle: string | undefined = ogResult.ogTitle ?? ogResult.dcTitle;
    const rawDescription: string | undefined = ogResult.ogDescription ?? ogResult.dcDescription;
    const rawSiteName: string | undefined = ogResult.ogSiteName;

    // ogImage is ImageObject[] — take the first entry
    const rawImageUrl: string | undefined = Array.isArray(ogResult.ogImage) && ogResult.ogImage.length > 0
      ? ogResult.ogImage[0].url
      : undefined;

    const linkPreview: LinkPreviewData = {
      url,
      title: truncate(rawTitle, MAX_TITLE_LENGTH),
      description: truncate(rawDescription, MAX_DESCRIPTION_LENGTH),
      imageUrl: resolveImageUrl(rawImageUrl, url),
      siteName: truncate(rawSiteName, MAX_SITE_NAME_LENGTH),
    };

    // If no useful metadata was extracted, skip storing
    if (!linkPreview.title && !linkPreview.description && !linkPreview.imageUrl) {
      logger.info({ urlDomain, messageId }, 'URL returned no usable OG metadata');
      return;
    }

    // -------------------------------------------------------------------
    // 5. Persist link preview in database
    // -------------------------------------------------------------------
    // NOTE: The Prisma Message model does not currently include a dedicated
    // `link_preview` column. We use raw SQL so that:
    //   a) If the column has been added via a migration, the data is stored.
    //   b) If the column does not exist yet, the error is caught gracefully
    //      and the WebSocket event still fires (primary delivery mechanism).
    // When the schema is extended, this can be migrated to a typed
    // `context.prisma.message.update(...)` call.
    // -------------------------------------------------------------------

    const linkPreviewJson = JSON.stringify(linkPreview);

    try {
      await context.prisma.$executeRawUnsafe(
        'UPDATE "messages" SET "link_preview" = $1::jsonb WHERE "id" = $2',
        linkPreviewJson,
        messageId,
      );
    } catch (dbError: unknown) {
      const dbMsg = dbError instanceof Error ? dbError.message : String(dbError);

      // Column missing — log and continue; WebSocket event is the primary path
      if (dbMsg.includes('column') && dbMsg.includes('does not exist')) {
        logger.warn(
          { urlDomain, messageId },
          'link_preview column not found on messages table — skipping DB storage',
        );
      } else {
        // Other database errors are retryable
        logger.error(
          { urlDomain, messageId, error: dbMsg },
          'Database error storing link preview',
        );
        throw dbError;
      }
    }

    // -------------------------------------------------------------------
    // 6. Publish link:preview event via Redis pub/sub
    // -------------------------------------------------------------------
    // The API server's Socket.IO Redis adapter (or a dedicated subscriber)
    // picks up this event and broadcasts it to the conversation room so
    // all connected participants receive the link preview card.
    // -------------------------------------------------------------------

    const event: LinkPreviewEvent = {
      messageId,
      conversationId,
      url: linkPreview.url,
      title: linkPreview.title,
      description: linkPreview.description,
      imageUrl: linkPreview.imageUrl,
      siteName: linkPreview.siteName,
      correlationId,
      timestamp: new Date().toISOString(),
    };

    try {
      await context.redisConnection.publish(
        `${LINK_PREVIEW_CHANNEL_PREFIX}:${conversationId}`,
        JSON.stringify(event),
      );
    } catch (pubError: unknown) {
      const pubMsg = pubError instanceof Error ? pubError.message : String(pubError);
      logger.error(
        { urlDomain, messageId, error: pubMsg },
        'Failed to publish link preview event via Redis',
      );
      throw pubError; // Retryable: Redis connectivity issue
    }

    // -------------------------------------------------------------------
    // 7. Log successful completion
    // -------------------------------------------------------------------

    const duration = Date.now() - startTime;
    logger.info(
      {
        urlDomain,
        messageId,
        hasTitle: !!linkPreview.title,
        hasDescription: !!linkPreview.description,
        hasImage: !!linkPreview.imageUrl,
        duration,
      },
      'Link preview extraction completed',
    );
  } catch (error: unknown) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Timeout errors are non-critical — the scraper took too long
    if (
      errorMessage.includes('timeout') ||
      errorMessage.includes('ETIMEDOUT') ||
      errorMessage.includes('AbortError') ||
      errorMessage.includes('aborted')
    ) {
      logger.warn(
        { urlDomain, messageId, duration },
        'Link preview extraction timed out',
      );
      return; // Non-retryable: timeout is acceptable
    }

    // Classify error for retry decision
    if (isRetryableError(error)) {
      logger.error(
        { urlDomain, messageId, error: errorMessage, duration },
        'Retryable error during link preview extraction',
      );
      throw error; // Re-throw for BullMQ retry
    }

    // Non-retryable error — log warning and discard
    logger.warn(
      { urlDomain, messageId, error: errorMessage, duration },
      'Non-retryable error during link preview extraction',
    );
  }
}
