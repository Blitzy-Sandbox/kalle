/**
 * @file UserController.ts
 * @description Thin delegation controller for user profile management,
 * cursor-paginated user search, and block/unblock functionality.
 *
 * This controller receives {@link UserService} via constructor injection (R17)
 * and delegates ALL business logic to it (R16). The controller:
 * - Extracts request parameters (userId, body, query)
 * - Delegates to UserService methods
 * - Formats and returns HTTP responses
 * - Forwards errors to global error handler via next(error)
 *
 * Architecture Rules Enforced:
 * - R16 (Thin Delegation): ZERO business logic — no password checks, no
 *   search ranking, no block validation.
 * - R17 (Constructor Injection): `new UserController(userService)` wired in
 *   the composition root (server.ts).
 * - R22 (Standardized Error Responses): Errors thrown as typed DomainError
 *   subclasses, caught by the global error handler middleware.
 * - R23 (Log Hygiene): NEVER logs passwords, tokens, or sensitive profile
 *   data beyond userId.
 * - R28 (Structured Logging Only): ZERO `console.log`, `console.warn`, or
 *   `console.error` calls.
 * - R31 (Input Validation): Zod validation applied at route level — controller
 *   receives pre-validated data.
 * - R7  (Zero Warnings Build): TypeScript strict mode with zero warnings.
 * - R9  (Auth Required): All user endpoints require authentication.
 *
 * @example
 * ```typescript
 * // Composition root (server.ts)
 * const userController = new UserController(userService);
 *
 * // Route registration (user.routes.ts)
 * router.get('/me', authMiddleware, userController.getProfile);
 * router.patch('/me', authMiddleware, validate(updateProfileSchema), userController.updateProfile);
 * router.get('/search', authMiddleware, validate(searchSchema), userController.search);
 * router.get('/blocked', authMiddleware, userController.getBlockedUsers);
 * router.get('/:userId', authMiddleware, userController.getUserById);
 * router.post('/:userId/block', authMiddleware, userController.block);
 * router.delete('/:userId/block', authMiddleware, userController.unblock);
 * ```
 */

import { Request, Response, NextFunction } from 'express';
import type { UserService } from '../services/UserService.js';
import type {
  UserResponse,
  UserSearchResult,
  UpdateProfileDTO,
  BlockedUserInfo,
} from '@kalle/shared';

// =============================================================================
// UserController Class
// =============================================================================

/**
 * UserController — thin delegation controller for user-related REST endpoints.
 *
 * All methods follow the same pattern:
 * 1. Extract parameters from the authenticated request
 * 2. Delegate to UserService (zero business logic)
 * 3. Return standardized JSON response
 * 4. Forward any errors to the global error handler via next(error)
 *
 * Endpoints:
 * - `GET    /api/v1/users/me`            → {@link getProfile}
 * - `PATCH  /api/v1/users/me`            → {@link updateProfile}
 * - `GET    /api/v1/users/search`        → {@link search}
 * - `GET    /api/v1/users/blocked`       → {@link getBlockedUsers}
 * - `GET    /api/v1/users/:userId`       → {@link getUserById}
 * - `POST   /api/v1/users/:userId/block` → {@link block}
 * - `DELETE /api/v1/users/:userId/block` → {@link unblock}
 */
export class UserController {
  /**
   * Creates a new UserController instance with injected dependencies.
   *
   * All methods are bound in the constructor to preserve `this` context
   * when used as Express route handler callbacks. Without binding,
   * `this.userService` would be `undefined` at runtime because Express
   * invokes handlers without the class context.
   *
   * @param userService - User service for all user business logic (R17:
   *   interface-driven DI). Provides getProfile, updateProfile, searchUsers,
   *   blockUser, unblockUser, and getBlockedUsers operations.
   */
  constructor(private readonly userService: UserService) {
    this.getProfile = this.getProfile.bind(this);
    this.updateProfile = this.updateProfile.bind(this);
    this.search = this.search.bind(this);
    this.getUserById = this.getUserById.bind(this);
    this.block = this.block.bind(this);
    this.unblock = this.unblock.bind(this);
    this.getBlockedUsers = this.getBlockedUsers.bind(this);
  }

  // ---------------------------------------------------------------------------
  // Profile Operations
  // ---------------------------------------------------------------------------

  /**
   * Get the authenticated user's own profile.
   *
   * Maps to: `GET /api/v1/users/me` (authenticated)
   *
   * Extracts the userId from the JWT-authenticated request and delegates
   * to UserService.getProfile(). Returns the full UserResponse shape
   * (excludes password hash per R23).
   *
   * @param req  - Express request with authenticated user on `req.user`
   * @param res  - Express response — returns 200 with `{ data: UserResponse }`
   * @param next - Express next function for error propagation to global handler
   */
  async getProfile(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const user: UserResponse = await this.userService.getProfile(userId);
      res.status(200).json({ data: user });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update the authenticated user's profile fields (partial update).
   *
   * Maps to: `PATCH /api/v1/users/me` (authenticated)
   *
   * Accepts an UpdateProfileDTO with optional fields:
   * - `displayName` — user display name
   * - `avatar` — avatar URL or null to remove
   * - `about` — status/about text (Figma Screen 15: "Digital goodies designer - Pixsellz")
   * - `phoneNumber` — phone number string
   *
   * Zod validation at the route level ensures the body matches the DTO shape
   * before reaching this handler. The service enforces that at least one
   * field is provided and that the user exists.
   *
   * @param req  - Express request with validated UpdateProfileDTO body
   * @param res  - Express response — returns 200 with `{ data: UserResponse }`
   * @param next - Express next function for error propagation to global handler
   */
  async updateProfile(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const updateData: UpdateProfileDTO = req.body as UpdateProfileDTO;
      const updatedUser: UserResponse =
        await this.userService.updateProfile(userId, updateData);
      res.status(200).json({ data: updatedUser });
    } catch (error) {
      next(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Search Operations
  // ---------------------------------------------------------------------------

  /**
   * Search for users by query string with cursor-based pagination.
   *
   * Maps to: `GET /api/v1/users/search` (authenticated, cursor-paginated)
   *
   * Query parameters (validated at route level via Zod):
   * - `q: string` — search query (searches displayName and email)
   * - `cursor?: string` — cursor-based pagination token
   * - `limit?: number` — results per page (default 20, max 100)
   *
   * The service searches by displayName and email with case-insensitive
   * matching. Blocked users are automatically excluded from results.
   * The authenticated user is also excluded from their own search results.
   *
   * @param req  - Express request with validated query parameters
   * @param res  - Express response — returns 200 with paginated UserSearchResult[]
   * @param next - Express next function for error propagation to global handler
   */
  async search(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const query: string = req.query.q as string;
      const cursor: string | undefined = req.query.cursor as string | undefined;
      const limitParam: string | undefined = req.query.limit as string | undefined;
      const limit: number | undefined = limitParam
        ? parseInt(limitParam, 10)
        : undefined;

      const result: {
        items: UserSearchResult[];
        cursor?: string;
        hasMore: boolean;
      } = await this.userService.searchUsers({
        query,
        currentUserId: userId,
        cursor,
        limit,
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
  // User Lookup
  // ---------------------------------------------------------------------------

  /**
   * Get a user's public profile by their ID.
   *
   * Maps to: `GET /api/v1/users/:userId` (authenticated)
   *
   * Returns the full UserResponse shape for the specified user. The service
   * throws NotFoundError if no user exists with the given ID.
   *
   * @param req  - Express request with `userId` path parameter
   * @param res  - Express response — returns 200 with `{ data: UserResponse }`
   * @param next - Express next function for error propagation to global handler
   */
  async getUserById(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const targetUserId: string = req.params.userId;
      const user: UserResponse = await this.userService.getProfile(targetUserId);
      res.status(200).json({ data: user });
    } catch (error) {
      next(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Block/Unblock Operations
  // ---------------------------------------------------------------------------

  /**
   * Block another user.
   *
   * Maps to: `POST /api/v1/users/:userId/block` (authenticated)
   *
   * The service handles all business logic:
   * - Validates target user exists (throws NotFoundError)
   * - Prevents self-block (throws ValidationError)
   * - Creates the block record (idempotent — returns existing block if duplicate)
   * - Writes an immutable audit log entry (R32: user.block)
   *
   * @param req  - Express request with `userId` path parameter
   * @param res  - Express response — returns 200 with success message and BlockedUserInfo
   * @param next - Express next function for error propagation to global handler
   */
  async block(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const actingUserId: string = req.user!.userId;
      const targetUserId: string = req.params.userId;

      const blockedInfo: BlockedUserInfo = await this.userService.blockUser({
        blockerId: actingUserId,
        blockedId: targetUserId,
      });

      res.status(200).json({
        data: {
          message: 'User blocked successfully',
          blockedUser: blockedInfo,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Unblock a previously blocked user.
   *
   * Maps to: `DELETE /api/v1/users/:userId/block` (authenticated)
   *
   * The service handles all business logic:
   * - Verifies the block relationship exists (throws NotFoundError)
   * - Removes the block record
   * - Writes an immutable audit log entry (R32: user.unblock)
   *
   * @param req  - Express request with `userId` path parameter
   * @param res  - Express response — returns 200 with success message
   * @param next - Express next function for error propagation to global handler
   */
  async unblock(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const actingUserId: string = req.user!.userId;
      const targetUserId: string = req.params.userId;

      await this.userService.unblockUser({
        blockerId: actingUserId,
        blockedId: targetUserId,
      });

      res.status(200).json({
        data: {
          message: 'User unblocked successfully',
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get all users blocked by the authenticated user.
   *
   * Maps to: `GET /api/v1/users/blocked` (authenticated)
   *
   * Returns the complete block list including display names, avatars,
   * and block timestamps for each blocked user.
   *
   * @param req  - Express request with authenticated user
   * @param res  - Express response — returns 200 with BlockedUserInfo[]
   * @param next - Express next function for error propagation to global handler
   */
  async getBlockedUsers(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const userId: string = req.user!.userId;
      const blockedUsers: BlockedUserInfo[] =
        await this.userService.getBlockedUsers(userId);
      res.status(200).json({ data: blockedUsers });
    } catch (error) {
      next(error);
    }
  }
}

// =============================================================================
// Exports — Both named and default (R7: zero warnings build compatibility)
// =============================================================================

export default UserController;
