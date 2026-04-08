/**
 * ConversationController — Thin delegation controller for conversation
 * lifecycle and membership management.
 *
 * Architecture Rules Enforced:
 * - R16 (Thin Delegation): ZERO business logic — all operations delegate to ConversationService.
 * - R17 (Constructor Injection): ConversationService injected via constructor, wired in server.ts.
 * - R22 (Standardized Error Responses): Errors propagated via next(error) to global error handler.
 * - R28 (Structured Logging Only): ZERO console.log calls.
 * - R31 (Input Validation): Zod validation at route level; controller receives pre-validated data.
 * - R7 (Zero Warnings Build): TypeScript strict mode compatible.
 * - R9 (Auth Required): All endpoints require authenticated user (req.user).
 * - R14 (Group Encryption): Sender Key distribution/rotation handled by ConversationService + QueueProvider.
 *
 * @module ConversationController
 */

import { Request, Response, NextFunction } from 'express';
import type { ConversationService } from '../services/ConversationService.js';
import type {
  CreateConversationDTO,
  ConversationResponse,
  UpdateConversationDTO,
  AddParticipantDTO,
  MuteSettings,
} from '@kalle/shared';

/**
 * Controller handling conversation lifecycle endpoints:
 * - GET    /api/v1/conversations           → list()
 * - POST   /api/v1/conversations           → create()
 * - GET    /api/v1/conversations/:id       → getById()
 * - PATCH  /api/v1/conversations/:id       → update()
 * - POST   /api/v1/conversations/:id/members         → addMember()
 * - DELETE /api/v1/conversations/:id/members/:userId  → removeMember()
 *
 * All methods delegate entirely to ConversationService (R16). No admin
 * checks, membership validation, Sender Key rotation, or audit logging
 * occurs here — the service layer owns that responsibility.
 */
export class ConversationController {
  /**
   * Creates a new ConversationController with injected service dependency.
   *
   * Method binding is performed in the constructor so that route handlers
   * maintain the correct `this` context when Express invokes them.
   *
   * @param conversationService - Service handling all conversation business logic (R17)
   */
  constructor(
    private readonly conversationService: ConversationService,
  ) {
    this.list = this.list.bind(this);
    this.create = this.create.bind(this);
    this.getById = this.getById.bind(this);
    this.update = this.update.bind(this);
    this.addMember = this.addMember.bind(this);
    this.removeMember = this.removeMember.bind(this);
  }

  // ---------------------------------------------------------------------------
  // GET /api/v1/conversations — List authenticated user's conversations
  // ---------------------------------------------------------------------------

  /**
   * Lists conversations for the authenticated user with cursor-based pagination.
   *
   * Query parameters (pre-validated at route level via Zod):
   * - `cursor` (optional): Opaque cursor for pagination
   * - `limit` (optional): Number of results per page (default 20, max 100)
   * - `includeArchived` (optional): Whether to include archived conversations
   *
   * @returns 200 with paginated conversation list
   */
  async list(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const cursor: string | undefined = req.query.cursor as string | undefined;
      const limit: number = req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : 20;
      const includeArchived: boolean = req.query.includeArchived === 'true';

      const result = await this.conversationService.getConversations(userId, {
        cursor,
        limit,
        includeArchived,
      });

      res.status(200).json({
        data: result.items,
        pagination: {
          cursor: result.cursor ?? null,
          hasMore: result.hasMore,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/v1/conversations — Create a new conversation
  // ---------------------------------------------------------------------------

  /**
   * Creates a new DIRECT or GROUP conversation.
   *
   * Request body (pre-validated at route level via Zod — CreateConversationDTO):
   * - `type`: ConversationType — DIRECT or GROUP
   * - `participantIds`: string[] — User IDs to include (2 for DIRECT, 2+ for GROUP)
   * - `groupName` (optional): Group display name (required for GROUP)
   * - `groupAvatar` (optional): Group avatar URL
   *
   * The service handles:
   * - Participant count validation per conversation type
   * - Duplicate DIRECT conversation detection (throws ConflictError)
   * - Participant record creation
   * - Sender Key distribution for GROUP conversations (R14) via QueueProvider
   *
   * @returns 201 with created ConversationResponse
   */
  async create(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const dto: CreateConversationDTO = req.body as CreateConversationDTO;

      const conversation: ConversationResponse =
        await this.conversationService.createConversation(dto, userId);

      res.status(201).json({ data: conversation });
    } catch (error) {
      next(error);
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/v1/conversations/:conversationId — Get conversation details
  // ---------------------------------------------------------------------------

  /**
   * Retrieves full details of a specific conversation.
   *
   * The service verifies the authenticated user is a participant and throws
   * NotFoundError if the conversation does not exist or the user is not a member.
   *
   * @returns 200 with ConversationResponse including participants, lastMessage, settings
   */
  async getById(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const conversationId: string = req.params.conversationId;

      const conversation: ConversationResponse =
        await this.conversationService.getConversationById(conversationId, userId);

      res.status(200).json({ data: conversation });
    } catch (error) {
      next(error);
    }
  }

  // ---------------------------------------------------------------------------
  // PATCH /api/v1/conversations/:conversationId — Update conversation settings
  // ---------------------------------------------------------------------------

  /**
   * Updates per-user or group conversation settings.
   *
   * Request body (pre-validated at route level — UpdateConversationDTO):
   * - `isArchived` (optional): boolean — archive/unarchive
   * - `isMuted` (optional): boolean — mute/unmute
   * - `muteExpiresAt` (optional): string | null — ISO timestamp or null for indefinite
   * - `groupName` (optional): string — GROUP only, admin required
   * - `groupAvatar` (optional): string — GROUP only, admin required
   *
   * This controller method decomposes the UpdateConversationDTO and routes to
   * the appropriate ConversationService methods:
   * 1. Archive state changes → archiveConversation / unarchiveConversation
   * 2. Mute state changes → muteConversation / unmuteConversation
   * 3. Group metadata changes → updateGroupDetails
   *
   * The service layer handles admin role verification for group updates.
   *
   * @returns 200 with updated ConversationResponse (last operation's result)
   */
  async update(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const conversationId: string = req.params.conversationId;
      const dto: UpdateConversationDTO = req.body as UpdateConversationDTO;

      // Track the latest response from any delegated operation.
      // Multiple fields may be set in a single PATCH request; each is
      // delegated to its dedicated service method.
      let conversation: ConversationResponse | undefined;

      // 1. Handle archive state change
      if (dto.isArchived === true) {
        conversation = await this.conversationService.archiveConversation(
          conversationId,
          userId,
        );
      } else if (dto.isArchived === false) {
        conversation = await this.conversationService.unarchiveConversation(
          conversationId,
          userId,
        );
      }

      // 2. Handle mute state change
      if (dto.isMuted === true) {
        const muteSettings: MuteSettings = {
          isMuted: true,
          muteExpiresAt: dto.muteExpiresAt,
        };
        conversation = await this.conversationService.muteConversation(
          conversationId,
          userId,
          muteSettings,
        );
      } else if (dto.isMuted === false) {
        conversation = await this.conversationService.unmuteConversation(
          conversationId,
          userId,
        );
      }

      // 3. Handle group detail updates (name and/or avatar)
      if (dto.groupName !== undefined || dto.groupAvatar !== undefined) {
        conversation = await this.conversationService.updateGroupDetails(
          conversationId,
          { groupName: dto.groupName, groupAvatar: dto.groupAvatar },
          userId,
        );
      }

      // If no fields matched any known operation, still fetch the
      // conversation to return a valid response rather than undefined.
      if (!conversation) {
        conversation = await this.conversationService.getConversationById(
          conversationId,
          userId,
        );
      }

      res.status(200).json({ data: conversation });
    } catch (error) {
      next(error);
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/v1/conversations/:conversationId/members — Add a member
  // ---------------------------------------------------------------------------

  /**
   * Adds a new participant to a GROUP conversation.
   *
   * Request body (pre-validated at route level — AddParticipantDTO):
   * - `userId`: string — User to add to the conversation
   * - `role` (optional): ParticipantRole — Defaults to MEMBER
   *
   * The service handles:
   * - Verification that acting user is a group admin
   * - Verification that conversation is GROUP type
   * - Participant record creation
   * - Sender Key distribution (R14) via QueueProvider
   * - Audit log entry (group.member_add, R32)
   *
   * @returns 200 with updated ConversationResponse
   */
  async addMember(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const actingUserId: string = req.user!.userId;
      const conversationId: string = req.params.conversationId;
      const dto: AddParticipantDTO = req.body as AddParticipantDTO;

      const conversation: ConversationResponse =
        await this.conversationService.addParticipant(
          conversationId,
          dto.userId,
          actingUserId,
          dto.role,
        );

      res.status(200).json({ data: conversation });
    } catch (error) {
      next(error);
    }
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/v1/conversations/:conversationId/members/:userId — Remove member
  // ---------------------------------------------------------------------------

  /**
   * Removes a participant from a GROUP conversation.
   *
   * Path parameters:
   * - `conversationId`: Conversation to modify
   * - `userId`: Participant to remove
   *
   * The service handles:
   * - Verification that acting user is admin OR target is self (leave)
   * - Participant record removal
   * - Sender Key rotation (R14: removed members can't decrypt post-removal messages)
   * - Audit log entry (group.member_remove, R32)
   *
   * @returns 200 with updated ConversationResponse
   */
  async removeMember(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const actingUserId: string = req.user!.userId;
      const conversationId: string = req.params.conversationId;
      const targetUserId: string = req.params.userId;

      const conversation: ConversationResponse =
        await this.conversationService.removeParticipant(
          conversationId,
          targetUserId,
          actingUserId,
        );

      res.status(200).json({ data: conversation });
    } catch (error) {
      next(error);
    }
  }
}

export default ConversationController;
