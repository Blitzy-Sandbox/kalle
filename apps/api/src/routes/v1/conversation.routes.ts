/**
 * @file apps/api/src/routes/v1/conversation.routes.ts
 * @description Conversation CRUD and Membership Route Definitions
 *
 * Defines all conversation-related Express routes:
 * - `GET    /`                              — List conversations (cursor-paginated)
 * - `POST   /`                              — Create conversation (DIRECT or GROUP)
 * - `GET    /:conversationId`               — Get conversation details
 * - `PATCH  /:conversationId`               — Update conversation (archive/mute/rename)
 * - `POST   /:conversationId/members`       — Add member to group conversation
 * - `DELETE /:conversationId/members/:userId` — Remove member from group conversation
 *
 * ALL endpoints require authentication (Rule R9). Rate limiting applied at
 * router level via `apiRateLimiter` (100 req/min per IP). Input validation
 * enforced via Zod schemas per Rule R31.
 *
 * Architecture Rules Enforced:
 * - R9  (Auth Required): All conversation endpoints require authentication via
 *       `authMiddleware` applied at router level.
 * - R31 (Input Validation via Zod): Every endpoint with user input validates
 *       request body, query params, or path params via Zod schemas before
 *       invoking the controller method.
 * - R14 (Group Encryption): Sender Key distribution/rotation is triggered
 *       automatically by ConversationService on membership changes — routes
 *       are fully unaware of encryption concerns.
 * - R30 (API Versioning): Sub-paths only — `/api/v1/conversations` prefix
 *       applied by the v1 index router.
 * - R28 (Structured Logging Only): ZERO `console.log`, `console.warn`, or
 *       `console.error` calls in this file.
 * - R7  (Zero Warnings Build): Compiles under `tsc --noEmit --strict` with
 *       zero warnings.
 *
 * @example
 * ```typescript
 * // Mounted in v1/index.ts:
 * import { createConversationRoutes } from './conversation.routes';
 * router.use('/conversations', createConversationRoutes(conversationController, authMiddleware));
 *
 * // Resulting endpoint paths:
 * // GET    /api/v1/conversations
 * // POST   /api/v1/conversations
 * // GET    /api/v1/conversations/:conversationId
 * // PATCH  /api/v1/conversations/:conversationId
 * // POST   /api/v1/conversations/:conversationId/members
 * // DELETE /api/v1/conversations/:conversationId/members/:userId
 * ```
 */

import { Router, RequestHandler } from 'express';
import { z } from 'zod';

import { validate, validateBody, validateParams, validateQuery } from '../../middleware/validation';
import { apiRateLimiter } from '../../middleware/rate-limiter';
import type { ConversationController } from '../../controllers/ConversationController';

// =============================================================================
// Zod Validation Schemas (Rule R31)
// =============================================================================

/**
 * Zod schema for POST / request body (create conversation).
 *
 * Validates the conversation creation payload:
 * - `type`           — Conversation type: DIRECT (1:1) or GROUP
 * - `participantIds` — Array of UUID strings (at least one participant required)
 * - `groupName`      — Required when `type` is GROUP; optional for DIRECT
 * - `groupAvatar`    — Optional URL for group avatar image
 *
 * The `.refine()` check enforces a cross-field constraint: GROUP conversations
 * MUST have a `groupName`. DIRECT conversations do not require one.
 */
const createConversationSchema = z
  .object({
    type: z.enum(['DIRECT', 'GROUP']),
    participantIds: z.array(z.string().uuid()).min(1, 'At least one participant required'),
    groupName: z.string().min(1).max(100).optional(),
    groupAvatar: z.string().url().optional(),
  })
  .refine(
    (data) => {
      if (data.type === 'GROUP' && !data.groupName) {
        return false;
      }
      return true;
    },
    {
      message: 'Group name is required for GROUP conversations',
      path: ['groupName'],
    },
  );

/**
 * Zod schema for PATCH /:conversationId request body (update conversation).
 *
 * All fields are optional, but at least one must be provided (enforced
 * via `.refine()`). Validates:
 * - `isArchived`    — Boolean to archive/unarchive the conversation
 * - `isMuted`       — Boolean to mute/unmute the conversation
 * - `muteExpiresAt` — ISO 8601 datetime for mute expiry, or null to clear
 * - `groupName`     — 1–100 characters for renaming (group only)
 * - `groupAvatar`   — Valid URL for group avatar, or null to remove
 *
 * The `.refine()` check ensures the client cannot send an empty `{}` body,
 * which would be a no-op update and waste a database round-trip.
 */
const updateConversationSchema = z
  .object({
    isArchived: z.boolean().optional(),
    isMuted: z.boolean().optional(),
    muteExpiresAt: z.string().datetime().nullable().optional(),
    groupName: z.string().min(1).max(100).optional(),
    groupAvatar: z.string().url().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

/**
 * Zod schema for POST /:conversationId/members request body (add member).
 *
 * Validates:
 * - `userId` — UUID of the user to add to the group conversation
 * - `role`   — Participant role: ADMIN or MEMBER (defaults to MEMBER)
 *
 * Authorization checks (e.g., is the requester an admin, is the conversation
 * a group) are handled by ConversationService — the route layer only validates
 * input shape and format.
 */
const addMemberSchema = z.object({
  userId: z.string().uuid('Invalid user ID'),
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
});

/**
 * Zod schema for the `:conversationId` path parameter.
 *
 * Validates that the `conversationId` segment is a valid UUID v4. Applied to:
 * - GET    /:conversationId
 * - PATCH  /:conversationId (combined with body via `validate()`)
 * - POST   /:conversationId/members (combined with body via `validate()`)
 */
const conversationIdParamSchema = z.object({
  conversationId: z.string().uuid('Invalid conversation ID'),
});

/**
 * Zod schema for the DELETE /:conversationId/members/:userId path parameters.
 *
 * Validates both path segments simultaneously:
 * - `conversationId` — UUID of the group conversation
 * - `userId`         — UUID of the member to remove
 *
 * Business logic (e.g., admin permission check, Sender Key rotation on removal
 * per Rule R14) is handled entirely by ConversationService.
 */
const removeMemberParamSchema = z.object({
  conversationId: z.string().uuid('Invalid conversation ID'),
  userId: z.string().uuid('Invalid user ID'),
});

/**
 * Zod schema for GET / query parameters (conversation listing).
 *
 * Supports cursor-based pagination:
 * - `cursor` — Optional UUID of the last conversation from the previous page
 * - `limit`  — Results per page; defaults to 20, clamped between 1 and 100
 *
 * Query parameters arrive as strings from the HTTP layer, so `limit` uses
 * `z.coerce.number()` to parse the string into an integer automatically.
 */
const listQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// =============================================================================
// Route Factory Function
// =============================================================================

/**
 * Creates and returns an Express Router configured with all conversation-related
 * routes, authentication middleware, rate limiting, and Zod validation.
 *
 * This is a factory function following the Dependency Injection pattern
 * (Rule R17). The `ConversationController` instance and auth middleware are
 * injected from the composition root (`server.ts`) via `v1/index.ts`.
 *
 * Middleware chain (applied in order per request):
 * 1. `authMiddleware` — JWT verification + Redis blacklist check (router-level)
 * 2. `apiRateLimiter` — 100 requests/minute per IP (router-level)
 * 3. Per-route validation — Zod schema validation on body/query/params
 * 4. Controller handler — Thin delegation to ConversationService
 *
 * @param conversationController - ConversationController instance with bound
 *   handler methods (list, create, getById, update, addMember, removeMember)
 * @param authMiddleware - Express middleware for JWT authentication (Rule R9).
 *   Created by the auth middleware factory in the composition root.
 * @returns Configured Express Router with all conversation routes
 */
export function createConversationRoutes(
  conversationController: ConversationController,
  authMiddleware: RequestHandler,
): Router {
  const router = Router();

  // ---------------------------------------------------------------------------
  // Router-Level Middleware (applies to ALL routes in this router)
  // ---------------------------------------------------------------------------

  // Rule R9: All conversation endpoints require authentication
  router.use(authMiddleware);

  // 100 requests per minute per IP for all conversation routes
  router.use(apiRateLimiter);

  // ---------------------------------------------------------------------------
  // GET / — List conversations (cursor-paginated)
  //
  // Returns the authenticated user's conversations in reverse-chronological
  // order (most recently active first). Supports cursor-based pagination via
  // query parameters.
  //
  // Query params validated by listQuerySchema:
  // - cursor: UUID of the last conversation from previous page (optional)
  // - limit:  1–100, defaults to 20
  //
  // Returns: 200 { data: ConversationResponse[], pagination: { cursor?, hasMore } }
  // ---------------------------------------------------------------------------
  router.get(
    '/',
    validateQuery(listQuerySchema),
    conversationController.list,
  );

  // ---------------------------------------------------------------------------
  // POST / — Create conversation (DIRECT or GROUP)
  //
  // Creates a new 1:1 (DIRECT) or group (GROUP) conversation with the
  // specified participants. For GROUP conversations, a `groupName` is required.
  // Sender Key distribution for group E2E encryption (Rule R14) is handled
  // transparently by ConversationService + QueueProvider.
  //
  // Body validated by createConversationSchema:
  // - type:           DIRECT | GROUP
  // - participantIds: UUID[] (min 1)
  // - groupName:      string (required for GROUP, max 100 chars)
  // - groupAvatar:    URL (optional)
  //
  // Returns: 201 { data: ConversationResponse }
  // ---------------------------------------------------------------------------
  router.post(
    '/',
    validateBody(createConversationSchema),
    conversationController.create,
  );

  // ---------------------------------------------------------------------------
  // GET /:conversationId — Get conversation details
  //
  // Returns the full conversation object including participant list, group
  // metadata (if GROUP), and the caller's membership state (muted, archived).
  //
  // Params validated by conversationIdParamSchema:
  // - conversationId: UUID
  //
  // Returns: 200 { data: ConversationResponse }
  // Errors:  404 NotFoundError if conversation does not exist or user is not a member
  // ---------------------------------------------------------------------------
  router.get(
    '/:conversationId',
    validateParams(conversationIdParamSchema),
    conversationController.getById,
  );

  // ---------------------------------------------------------------------------
  // PATCH /:conversationId — Update conversation (archive/mute/rename)
  //
  // Partial update of conversation properties. At least one field must be
  // provided. Archive/mute apply per-user (ConversationParticipant), while
  // groupName/groupAvatar apply to the Conversation itself (admin-only).
  //
  // Params and body validated simultaneously via validate():
  // - params.conversationId: UUID
  // - body: { isArchived?, isMuted?, muteExpiresAt?, groupName?, groupAvatar? }
  //
  // Returns: 200 { data: ConversationResponse }
  // Errors:  404 NotFoundError, 403 AuthorizationError (non-admin rename)
  // ---------------------------------------------------------------------------
  router.patch(
    '/:conversationId',
    validate({
      params: conversationIdParamSchema,
      body: updateConversationSchema,
    }),
    conversationController.update,
  );

  // ---------------------------------------------------------------------------
  // POST /:conversationId/members — Add member to group conversation
  //
  // Adds a new participant to a group conversation. The authenticated user
  // must be an admin of the group. Sender Key distribution to the new member
  // is triggered automatically by ConversationService (Rule R14).
  //
  // Params and body validated simultaneously via validate():
  // - params.conversationId: UUID
  // - body.userId:           UUID of user to add
  // - body.role:             ADMIN | MEMBER (defaults to MEMBER)
  //
  // Returns: 200 { data: ConversationResponse }
  // Errors:  404 NotFoundError, 403 AuthorizationError, 409 ConflictError (already member)
  // ---------------------------------------------------------------------------
  router.post(
    '/:conversationId/members',
    validate({
      params: conversationIdParamSchema,
      body: addMemberSchema,
    }),
    conversationController.addMember,
  );

  // ---------------------------------------------------------------------------
  // DELETE /:conversationId/members/:userId — Remove member from group
  //
  // Removes a participant from a group conversation. The authenticated user
  // must be an admin (or removing themselves). Sender Key rotation is triggered
  // automatically by ConversationService to prevent the removed member from
  // decrypting future messages (Rule R14).
  //
  // Params validated by removeMemberParamSchema:
  // - conversationId: UUID
  // - userId:         UUID of member to remove
  //
  // Returns: 200 { data: ConversationResponse }
  // Errors:  404 NotFoundError, 403 AuthorizationError
  // ---------------------------------------------------------------------------
  router.delete(
    '/:conversationId/members/:userId',
    validateParams(removeMemberParamSchema),
    conversationController.removeMember,
  );

  return router;
}
