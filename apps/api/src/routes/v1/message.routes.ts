/**
 * @file apps/api/src/routes/v1/message.routes.ts
 * @description Message Operations Route Definitions
 *
 * Defines all message-related Express routes:
 * - GET /conversations/:conversationId/messages — Get message history (cursor-paginated)
 * - POST /conversations/:conversationId/messages — Send a message (encrypted ciphertext)
 * - PATCH /:messageId — Edit a message (15-min window, sender-only)
 * - DELETE /:messageId — Delete a message (soft-delete tombstone)
 *
 * Architecture Rules Enforced:
 * - R12: Server stores only ciphertext — zero decryption occurs server-side
 * - R19: Edit route accepts new ciphertext; 15-min window enforced by MessageService
 * - R20: Delete route triggers soft-delete tombstone; logic in MessageService
 * - R18: Group message fan-out via BullMQ — transparent to route layer
 * - R9: ALL message endpoints require authentication
 * - R31: ALL inputs validated via Zod schemas before reaching controller
 * - R30: Sub-paths only — conversation-scoped routes mounted under
 *        /api/v1/conversations/:conversationId/messages, message-level routes
 *        mounted under /api/v1/messages by v1 index router
 * - R28: ZERO direct console calls — structured logging only
 * - R7: TypeScript strict mode — zero warnings build
 * - R4: clientMessageId required for send (UUID) for deduplication
 */

import { Router, RequestHandler } from 'express';
import { z } from 'zod';
import { validate, validateParams } from '../../middleware/validation';
import { apiRateLimiter } from '../../middleware/rate-limiter';
import type { MessageController } from '../../controllers/MessageController';

// ---------------------------------------------------------------------------
// Zod Validation Schemas (Rule R31)
// ---------------------------------------------------------------------------

/**
 * Schema for POST /conversations/:conversationId/messages request body.
 * Validates the encrypted message payload. Ciphertext is validated as a
 * non-empty string only — the server does NOT inspect, parse, or validate
 * the encrypted content (Rule R12: E2E Encryption Integrity).
 */
const sendMessageSchema = z.object({
  /** Encrypted message content — non-empty string, server-opaque (R12) */
  ciphertext: z.string().min(1, 'Ciphertext is required'),

  /** Message content type — defaults to TEXT if omitted */
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE_NOTE']).default('TEXT'),

  /** Optional UUID reference to a message being replied to */
  replyToMessageId: z.string().uuid().optional(),

  /** Optional UUID reference to an uploaded media attachment */
  mediaId: z.string().uuid().optional(),

  /**
   * Client-generated UUID for deduplication (Rule R4).
   * Required — the client must generate a unique ID per message to prevent
   * duplicates during reconnection or retry scenarios.
   */
  clientMessageId: z.string().uuid('Client message ID must be a UUID'),
});

/**
 * Schema for PATCH /:messageId request body.
 * Only the new ciphertext is required — the 15-minute edit window and
 * sender-only enforcement are handled by MessageService (Rule R19).
 */
const editMessageSchema = z.object({
  /** Replacement encrypted content — non-empty string (R12) */
  ciphertext: z.string().min(1, 'New ciphertext is required'),
});

/**
 * Schema for conversation-scoped route path parameters.
 * Used on GET and POST /conversations/:conversationId/messages.
 */
const conversationIdParamSchema = z.object({
  conversationId: z.string().uuid('Invalid conversation ID'),
});

/**
 * Schema for message-level route path parameters.
 * Used on PATCH and DELETE /:messageId.
 */
const messageIdParamSchema = z.object({
  messageId: z.string().uuid('Invalid message ID'),
});

/**
 * Schema for GET /conversations/:conversationId/messages query parameters.
 * Supports cursor-based pagination with an optional timestamp filter.
 *
 * - cursor: UUID of the last message from the previous page
 * - limit: Number of messages per page (1–100, default 50)
 * - before: ISO 8601 datetime — only return messages before this timestamp
 */
const getHistoryQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Creates an Express Router for **conversation-scoped** message endpoints.
 *
 * This router is mounted at `/conversations/:conversationId/messages` by the
 * v1 index router, so routes here define sub-paths relative to that mount
 * point.  `mergeParams: true` ensures the `:conversationId` parameter from the
 * mount path is accessible in `req.params`.
 *
 * Routes:
 * - GET  / → auth → rate → validate({params,query}) → getHistory
 * - POST / → auth → rate → validate({params,body})  → send
 *
 * @param messageController - MessageController instance from composition root
 * @param authMiddleware - JWT authentication middleware (Rule R9)
 * @returns Configured Express Router
 */
export function createConversationMessageRoutes(
  messageController: MessageController,
  authMiddleware: RequestHandler
): Router {
  const router = Router({ mergeParams: true });

  // Apply auth + rate limiter to ALL conversation-scoped message routes (Rules R9, R25)
  router.use(authMiddleware);
  router.use(apiRateLimiter);

  // -------------------------------------------------------------------------
  // GET / (mounted at /conversations/:conversationId/messages)
  // Retrieve message history with cursor-based pagination.
  // Returns messages in reverse-chronological order, grouped by conversation.
  // -------------------------------------------------------------------------
  router.get(
    '/',
    validate({
      params: conversationIdParamSchema,
      query: getHistoryQuerySchema,
    }),
    messageController.getHistory
  );

  // -------------------------------------------------------------------------
  // POST / (mounted at /conversations/:conversationId/messages)
  // Send a new message with encrypted ciphertext (Rule R12).
  // The server stores ciphertext as-is — zero decryption logic.
  // Group delivery is handled via BullMQ fan-out (Rule R18).
  // -------------------------------------------------------------------------
  router.post(
    '/',
    validate({
      params: conversationIdParamSchema,
      body: sendMessageSchema,
    }),
    messageController.send
  );

  return router;
}

/**
 * Creates an Express Router for **message-level** endpoints (edit and delete).
 *
 * This router is mounted at `/messages` by the v1 index router, so routes
 * here define sub-paths relative to that mount point.
 *
 * Routes:
 * - PATCH  /:messageId → auth → rate → validate({params,body})  → edit
 * - DELETE /:messageId → auth → rate → validateParams(params)   → delete
 *
 * @param messageController - MessageController instance from composition root
 * @param authMiddleware - JWT authentication middleware (Rule R9)
 * @returns Configured Express Router
 */
export function createMessageRoutes(
  messageController: MessageController,
  authMiddleware: RequestHandler
): Router {
  const router = Router();

  // Apply auth + rate limiter to ALL message-level routes (Rules R9, R25)
  router.use(authMiddleware);
  router.use(apiRateLimiter);

  // -------------------------------------------------------------------------
  // PATCH /:messageId
  // Edit a message by replacing its ciphertext (Rule R19).
  // 15-minute edit window and sender-only enforcement are in MessageService.
  // Original ciphertext is NOT retained.
  // -------------------------------------------------------------------------
  router.patch(
    '/:messageId',
    validate({
      params: messageIdParamSchema,
      body: editMessageSchema,
    }),
    messageController.edit
  );

  // -------------------------------------------------------------------------
  // DELETE /:messageId
  // Soft-delete a message as a tombstone (Rule R20).
  // Ciphertext is nulled, row retained, all participants notified via
  // message:deleted WebSocket event.
  // -------------------------------------------------------------------------
  router.delete(
    '/:messageId',
    validateParams(messageIdParamSchema),
    messageController.delete
  );

  return router;
}
