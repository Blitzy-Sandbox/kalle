/**
 * Unit tests for UserController
 * Verifies thin delegation to UserService, correct HTTP status codes,
 * and error propagation via next() — per R16.
 */
import { Request, Response, NextFunction } from 'express';
import { UserController } from '../../../src/controllers/UserController';

const mockUserService = {
  getProfile: jest.fn(),
  updateProfile: jest.fn(),
  searchUsers: jest.fn(),
  getUserById: jest.fn(),
  blockUser: jest.fn(),
  unblockUser: jest.fn(),
  getBlockedUsers: jest.fn(),
};

function buildReq(overrides: Record<string, unknown> = {}): Partial<Request> {
  return {
    user: { userId: 'u-1', email: 'a@b.com' },
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as Partial<Request>;
}

function buildRes(): { res: Partial<Response>; statusFn: jest.Mock; jsonFn: jest.Mock } {
  const jsonFn = jest.fn();
  const statusFn = jest.fn().mockReturnValue({ json: jsonFn });
  return { res: { status: statusFn } as Partial<Response>, statusFn, jsonFn };
}

describe('UserController', () => {
  let ctrl: UserController;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    ctrl = new UserController(mockUserService as any);
    next = jest.fn();
  });

  // ── getProfile ──────────────────────────────────────────────────
  it('getProfile returns 200 with user data', async () => {
    const user = { id: 'u-1', displayName: 'A' };
    mockUserService.getProfile.mockResolvedValue(user);
    const req = buildReq();
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.getProfile(req as Request, res as Response, next);

    expect(mockUserService.getProfile).toHaveBeenCalledWith('u-1');
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({ data: user });
  });

  it('getProfile delegates errors to next', async () => {
    mockUserService.getProfile.mockRejectedValue(new Error('fail'));
    const req = buildReq();
    const { res } = buildRes();

    await ctrl.getProfile(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── updateProfile ───────────────────────────────────────────────
  it('updateProfile returns 200 with updated user', async () => {
    const updated = { id: 'u-1', displayName: 'B' };
    mockUserService.updateProfile.mockResolvedValue(updated);
    const req = buildReq({ body: { displayName: 'B' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.updateProfile(req as Request, res as Response, next);

    expect(mockUserService.updateProfile).toHaveBeenCalledWith('u-1', { displayName: 'B' });
    expect(statusFn).toHaveBeenCalledWith(200);
  });

  it('updateProfile delegates errors to next', async () => {
    mockUserService.updateProfile.mockRejectedValue(new Error('fail'));
    const req = buildReq({ body: { displayName: 'B' } });
    const { res } = buildRes();

    await ctrl.updateProfile(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── search ──────────────────────────────────────────────────────
  it('search returns 200 with results and pagination', async () => {
    const result = { items: [{ id: 'u-2' }], cursor: 'c2', hasMore: false };
    mockUserService.searchUsers.mockResolvedValue(result);
    const req = buildReq({ query: { q: 'test', cursor: 'c1', limit: '10' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.search(req as Request, res as Response, next);

    expect(mockUserService.searchUsers).toHaveBeenCalledWith({
      query: 'test',
      currentUserId: 'u-1',
      cursor: 'c1',
      limit: 10,
    });
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({
      data: result.items,
      pagination: { cursor: 'c2', hasMore: false },
    });
  });

  it('search uses undefined limit when not provided', async () => {
    const result = { items: [], cursor: undefined, hasMore: false };
    mockUserService.searchUsers.mockResolvedValue(result);
    const req = buildReq({ query: { q: 'test' } });
    const { res } = buildRes();

    await ctrl.search(req as Request, res as Response, next);

    expect(mockUserService.searchUsers).toHaveBeenCalledWith({
      query: 'test',
      currentUserId: 'u-1',
      cursor: undefined,
      limit: undefined,
    });
  });

  it('search delegates errors to next', async () => {
    mockUserService.searchUsers.mockRejectedValue(new Error('fail'));
    const req = buildReq({ query: { q: 'test' } });
    const { res } = buildRes();

    await ctrl.search(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── getUserById ─────────────────────────────────────────────────
  it('getUserById returns 200 with user', async () => {
    const user = { id: 'u-2' };
    mockUserService.getProfile.mockResolvedValue(user);
    const req = buildReq({ params: { userId: 'u-2' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.getUserById(req as Request, res as Response, next);

    // getUserById delegates to userService.getProfile(targetUserId)
    expect(mockUserService.getProfile).toHaveBeenCalledWith('u-2');
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({ data: user });
  });

  it('getUserById delegates errors to next', async () => {
    mockUserService.getProfile.mockRejectedValue(new Error('fail'));
    const req = buildReq({ params: { userId: 'u-2' } });
    const { res } = buildRes();

    await ctrl.getUserById(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── block ───────────────────────────────────────────────────────
  it('block returns 200 with confirmation', async () => {
    const blockedInfo = { blockedId: 'u-2', displayName: 'User2' };
    mockUserService.blockUser.mockResolvedValue(blockedInfo);
    const req = buildReq({ params: { userId: 'u-2' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.block(req as Request, res as Response, next);

    expect(mockUserService.blockUser).toHaveBeenCalledWith({
      blockerId: 'u-1',
      blockedId: 'u-2',
    });
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({
      data: {
        message: 'User blocked successfully',
        blockedUser: blockedInfo,
      },
    });
  });

  it('block delegates errors to next', async () => {
    mockUserService.blockUser.mockRejectedValue(new Error('fail'));
    const req = buildReq({ params: { userId: 'u-2' } });
    const { res } = buildRes();

    await ctrl.block(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── unblock ─────────────────────────────────────────────────────
  it('unblock returns 200 with confirmation', async () => {
    mockUserService.unblockUser.mockResolvedValue(undefined);
    const req = buildReq({ params: { userId: 'u-2' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.unblock(req as Request, res as Response, next);

    expect(mockUserService.unblockUser).toHaveBeenCalledWith({
      blockerId: 'u-1',
      blockedId: 'u-2',
    });
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({
      data: { message: 'User unblocked successfully' },
    });
  });

  it('unblock delegates errors to next', async () => {
    mockUserService.unblockUser.mockRejectedValue(new Error('fail'));
    const req = buildReq({ params: { userId: 'u-2' } });
    const { res } = buildRes();

    await ctrl.unblock(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── getBlockedUsers ─────────────────────────────────────────────
  it('getBlockedUsers returns 200 with list', async () => {
    const list = [{ id: 'u-2' }];
    mockUserService.getBlockedUsers.mockResolvedValue(list);
    const req = buildReq();
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.getBlockedUsers(req as Request, res as Response, next);

    expect(mockUserService.getBlockedUsers).toHaveBeenCalledWith('u-1');
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({ data: list });
  });

  it('getBlockedUsers delegates errors to next', async () => {
    mockUserService.getBlockedUsers.mockRejectedValue(new Error('fail'));
    const req = buildReq();
    const { res } = buildRes();

    await ctrl.getBlockedUsers(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
