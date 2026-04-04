/**
 * @file MessageController.ts
 * @description Thin delegation controller for encrypted message lifecycle.
 *
 * Handles sending (with BullMQ fan-out for groups, R18), editing (15-min
 * window, sender-only, R19), deleting (soft-delete tombstone, R20), and
 * fetching paginated message history. All business logic resides in
 * {@link MessageService} — this controller performs zero business logic (R16).
 *
 * Architecture Rules Enforced:
 * - R16 (Thin Delegation): ZERO business logic — pure request-to-service delegation.
 *        No edit window checks, no tombstone logic, no fan-out orchestration.
 * - R17 (Constructor Injection): MessageService injected via constructor, wired
 *        in the composition root (server.ts).
 * - R12 (E2E Encryption): Server stores only ciphertext. Controller receives
 *        encrypted content (`ciphertext` field), passes through to service.
 *        ZERO decryption logic in this file.
 * - R19 (Message Edit): Sender-only, 15-minute window, ciphertext swap. All
 *        enforcement in MessageService — controller just delegates.
 * - R20 (Message Delete): Soft-delete tombstone — ciphertext nulled, row retained.
 *        All enforcement in MessageService — controller just delegates.
 * - R18 (Fan-Out via Queue): Group message delivery to 3+ recipients goes through
 *        BullMQ. MessageService handles queueing — controller is unaware.
 * - R4  (Real-Time Message Integrity): Messages ordered by serverTimestamp.
 *        Ordering delegated entirely to service.
 * - R22 (Standardized Error Responses): Errors via DomainError subclasses
 *        propagated to global error handler via next(error).
 * - R28 (Structured Logging Only): ZERO console.log/warn/error calls.
 * - R23 (Log Hygiene): Controller NEVER logs ciphertext content. Only messageId,
 *        conversationId, userId, and action type are safe to log.
 * - R31 (Input Validation): Zod validation at route level; controller receives
 *        pre-validated data.
 * - R7  (Zero Warnings Build): TypeScript strict mode compatible.
 * - R9  (Auth Required): All message endpoints require authentication via
 *        req.user populated by auth middleware.
 *
 * Endpoint Summary:
 * - POST   /api/v1/conversations/:conversationId/messages → send()       — 201
 * - PATCH  /api/v1/messages/:messageId                    → edit()       — 200
 * - DELETE /api/v1/messages/:messageId                    → delete()     — 200
 * - GET    /api/v1/conversations/:conversationId/messages → getHistory() — 200
 *
 * @see apps/api/src/services/MessageService.ts — Business logic implementation
 * @see packages/shared/src/types/message.ts — Shared message types and DTOs
 * @see apps/api/src/routes/v1/message.routes.ts — Route definitions with Zod validation
 */

import type { Request, Response, NextFunction } from 'express';
import type { MessageService } from '../services/MessageService';
import type {
  SendMessageDTO,
  EditMessageDTO,
  MessageResponse,
  DeleteMessageResponse,
  GetMessagesQuery,
} from '@kalle/shared';

// ---------------------------------------------------------------------------
// Controller Implementation
// ---------------------------------------------------------------------------

/**
 * MessageController — Thin delegation controller for encrypted message lifecycle.
 *
 * Receives {@link MessageService} via constructor injection (R17) from the
 * composition root (`server.ts`). Every public method follows the standard
 * Express handler signature `(req, res, next) => Promise<void>` with
 * try/catch blocks delegating errors to the global error handler via
 * `next(error)` (R22).
 *
 * All methods are bound in the constructor to preserve `this` context when
 * passed as Express route handler callbacks. Without binding, `this.messageService`
 * would be `undefined` at runtime due to Express calling handlers without context.
 *
 * @example
 * ```typescript
 * // Composition root (server.ts)
 * const messageService = new MessageService(messageRepo, conversationRepo, cache, queue);
 * const messageController = new MessageController(messageService);
 *
 * // Route registration (message.routes.ts)
 * router.post('/conversations/:conversationId/messages', auth, messageController.send);
 * router.patch('/messages/:messageId', auth, messageController.edit);
 * router.delete('/messages/:messageId', auth, messageController.delete);
 * router.get('/conversations/:conversationId/messages', auth, messageController.getHistory);
 * ```
 */
export class MessageController {
  /**
   * Creates a new MessageController instance with injected dependencies.
   *
   * @param messageService - Message lifecycle management service (R17:
   *   interface-driven DI). All message operations are delegated to this
   *   service. The controller performs zero business logic per R16 — no edit
   *   window checks, no tombstone logic, no fan-out orchestration, no
   *   participant validation, no message ordering.
   */
  constructor(private readonly messageService: MessageService) {
    // Bind all public methods to preserve `this` context when used as
    // Express route handler callbacks. Express invokes handler functions
    // without a receiver, so unbound methods would have `this === undefined`.
    this.send = this.send.bind(this);
    this.edit = this.edit.bind(this);
    this.delete = this.delete.bind(this);
    this.getHistory = this.getHistory.bind(this);
  }

  // -------------------------------------------------------------------------
  // POST /api/v1/conversations/:conversationId/messages — Send Message
  // -------------------------------------------------------------------------

  /**
   * Send a new encrypted message to a conversation.
   *
   * Extracts the authenticated user ID, conversation ID from the URL path,
   * and the pre-validated {@link SendMessageDTO} from the request body.
   * Delegates to {@link MessageService.sendMessage} and returns the created
   * message with HTTP 201 Created.
   *
   * The service handles all business logic (R16):
   * - Participant validation (user must be a conversation member)
   * - serverTimestamp assignment for ordering (R4)
   * - BullMQ fan-out for group conversations with 3+ recipients (R18)
   * - Deduplication via clientMessageId
   * - Link preview extraction queueing for URLs in TEXT messages
   *
   * The controller passes ciphertext as-is from the client — ZERO decryption
   * logic (R12). The server never has access to plaintext message content.
   *
   * @param req - Express request with:
   *   - `req.user` (authenticated via auth middleware, R9)
   *   - `req.params.conversationId` (target conversation UUID)
   *   - `req.body` (Zod-validated SendMessageDTO with ciphertext, type, etc.)
   * @param res - Express response — 201 with `{ data: MessageResponse }`
   * @param next - Express next function for error delegation to global handler
   */
  async send(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const conversationId: string = req.params.conversationId;
      const body: SendMessageDTO = req.body as SendMessageDTO;

      // Delegate to the service. The sendMessage method expects
      // SendMessageParams which extends SendMessageDTO with sender context.
      // req.user.email is used as senderName since the auth middleware's
      // AuthenticatedUser provides userId and email.
      const message: MessageResponse = await this.messageService.sendMessage({
        senderId: userId,
        senderName: req.user!.email,
        conversationId,
        ciphertext: body.ciphertext,
        type: body.type,
        replyToMessageId: body.replyToMessageId,
        mediaId: body.mediaId,
        clientMessageId: body.clientMessageId,
      });

      res.status(201).json({ data: message });
    } catch (error) {
      next(error);
    }
  }

  // -------------------------------------------------------------------------
  // PATCH /api/v1/messages/:messageId — Edit Message
  // -------------------------------------------------------------------------

  /**
   * Edit an existing message (replace ciphertext).
   *
   * Extracts the authenticated user ID, message ID from the URL path, and
   * the pre-validated {@link EditMessageDTO} from the request body. Delegates
   * to {@link MessageService.editMessage} and returns the updated message
   * with HTTP 200 OK.
   *
   * The service handles all business logic (R16):
   * - Sender ownership verification (only the original sender can edit)
   * - 15-minute edit window enforcement (R19)
   * - Ciphertext swap (old ciphertext replaced, not retained)
   * - isEdited=true and editedAt timestamp assignment
   * - Real-time notification to conversation participants via message:edited
   *
   * Errors thrown by the service (handled by global error handler, R22):
   * - AuthorizationError if the authenticated user is not the message sender
   * - ValidationError if the 15-minute edit window has expired
   * - NotFoundError if the message does not exist
   *
   * @param req - Express request with:
   *   - `req.user` (authenticated)
   *   - `req.params.messageId` (message to edit)
   *   - `req.body` (Zod-validated EditMessageDTO with new ciphertext)
   * @param res - Express response — 200 with `{ data: MessageResponse }`
   * @param next - Express next function for error delegation to global handler
   */
  async edit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const messageId: string = req.params.messageId;
      const body: EditMessageDTO = req.body as EditMessageDTO;

      // Delegate to the service. editMessage expects EditMessageParams:
      // { messageId, senderId, newCiphertext }
      const updatedMessage: MessageResponse = await this.messageService.editMessage({
        messageId,
        senderId: userId,
        newCiphertext: body.ciphertext,
      });

      res.status(200).json({ data: updatedMessage });
    } catch (error) {
      next(error);
    }
  }

  // -------------------------------------------------------------------------
  // DELETE /api/v1/messages/:messageId — Delete Message (Tombstone)
  // -------------------------------------------------------------------------

  /**
   * Delete a message (soft-delete tombstone).
   *
   * Extracts the authenticated user ID and message ID from the URL path.
   * Delegates to {@link MessageService.deleteMessage} and returns a
   * {@link DeleteMessageResponse} tombstone confirmation with HTTP 200 OK.
   *
   * The service handles all business logic (R16):
   * - Sender ownership verification (only the original sender can delete)
   * - Soft-delete: ciphertext set to null (tombstone), row retained (R20)
   * - isDeleted=true and deletedAt timestamp assignment
   * - Real-time notification to conversation participants via message:deleted
   *
   * The response is formatted as {@link DeleteMessageResponse} containing
   * only the tombstone-relevant fields (id, conversationId, isDeleted,
   * deletedAt) — not the full {@link MessageResponse}.
   *
   * Errors thrown by the service (handled by global error handler, R22):
   * - AuthorizationError if the authenticated user is not the message sender
   * - NotFoundError if the message does not exist
   *
   * @param req - Express request with:
   *   - `req.user` (authenticated)
   *   - `req.params.messageId` (message to delete)
   * @param res - Express response — 200 with `{ data: DeleteMessageResponse }`
   * @param next - Express next function for error delegation to global handler
   */
  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const messageId: string = req.params.messageId;

      // Delegate to the service. deleteMessage expects DeleteMessageParams:
      // { messageId, senderId }
      const result: MessageResponse = await this.messageService.deleteMessage({
        messageId,
        senderId: userId,
      });

      // Format the response as DeleteMessageResponse — extract only the
      // tombstone-relevant fields from the full MessageResponse. This is
      // standard controller-boundary response formatting, not business logic.
      const deleteResult: DeleteMessageResponse = {
        id: result.id,
        conversationId: result.conversationId,
        isDeleted: result.isDeleted,
        deletedAt: result.deletedAt ?? new Date().toISOString(),
      };

      res.status(200).json({ data: deleteResult });
    } catch (error) {
      next(error);
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/v1/conversations/:conversationId/messages — Message History
  // -------------------------------------------------------------------------

  /**
   * Retrieve paginated message history for a conversation.
   *
   * Extracts the authenticated user ID, conversation ID from the URL path,
   * and cursor-based pagination parameters from the query string. Delegates
   * to {@link MessageService.getMessageHistory} and returns a paginated
   * response with HTTP 200 OK.
   *
   * The service handles all business logic (R16):
   * - Participant validation (user must be a conversation member)
   * - Messages ordered by serverTimestamp DESC (newest first)
   * - Cursor-based pagination with configurable limit (default 50, max 100)
   *
   * Query parameters (validated by Zod at route level, R31):
   * - `cursor?: string` — serverTimestamp of the last message for pagination
   * - `limit?: number` — number of messages per page (default 50, max 100)
   * - `before?: string` — ISO timestamp to fetch messages before
   *
   * @param req - Express request with:
   *   - `req.user` (authenticated)
   *   - `req.params.conversationId` (conversation to fetch messages from)
   *   - `req.query` (Zod-validated pagination parameters)
   * @param res - Express response — 200 with paginated MessageResponse[]
   * @param next - Express next function for error delegation to global handler
   */
  async getHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const conversationId: string = req.params.conversationId;

      // Extract pagination parameters from the query string.
      // These are pre-validated by Zod at the route level (R31).
      const query = req.query as unknown as GetMessagesQuery;
      const limit: number | undefined = query.limit
        ? Number(query.limit)
        : undefined;

      // Delegate to the service. getMessageHistory expects
      // GetMessageHistoryParams: { conversationId, userId, cursor?, limit? }
      const result = await this.messageService.getMessageHistory({
        conversationId,
        userId,
        cursor: query.cursor,
        limit,
      });

      // Format as paginated response with data and pagination metadata.
      // The service returns { items, cursor?, hasMore } which we map to
      // the standard API pagination envelope.
      res.status(200).json({
        data: result.items,
        pagination: {
          cursor: result.cursor,
          hasMore: result.hasMore,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

// ---------------------------------------------------------------------------
// Default Export
// ---------------------------------------------------------------------------

export default MessageController;
