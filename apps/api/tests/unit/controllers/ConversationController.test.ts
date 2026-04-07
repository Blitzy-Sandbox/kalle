/**
 * Unit tests for ConversationController — per R16.
 */
import { Request, Response, NextFunction } from 'express';
import { ConversationController } from '../../../src/controllers/ConversationController';

const mockConversationService = {
  getConversations: jest.fn(),
  createConversation: jest.fn(),
  getConversationById: jest.fn(),
  archiveConversation: jest.fn(),
  unarchiveConversation: jest.fn(),
  muteConversation: jest.fn(),
  unmuteConversation: jest.fn(),
  updateGroupDetails: jest.fn(),
  addParticipant: jest.fn(),
  removeParticipant: jest.fn(),
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

describe('ConversationController', () => {
  let ctrl: ConversationController;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    ctrl = new ConversationController(mockConversationService as any);
    next = jest.fn();
  });

  // ── list ────────────────────────────────────────────────────────
  it('list returns 200 with conversations', async () => {
    const result = { items: [{ id: 'c-1' }], cursor: 'c2', hasMore: true };
    mockConversationService.getConversations.mockResolvedValue(result);
    const req = buildReq({ query: { cursor: 'c1', limit: '5', includeArchived: 'true' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.list(req as Request, res as Response, next);

    expect(mockConversationService.getConversations).toHaveBeenCalledWith('u-1', {
      cursor: 'c1',
      limit: 5,
      includeArchived: true,
    });
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({
      data: result.items,
      cursor: 'c2',
      hasMore: true,
    });
  });

  it('list delegates errors to next', async () => {
    mockConversationService.getConversations.mockRejectedValue(new Error('fail'));
    const req = buildReq();
    const { res } = buildRes();

    await ctrl.list(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── create ──────────────────────────────────────────────────────
  it('create returns 201 with new conversation', async () => {
    const conv = { id: 'c-new', type: 'DIRECT' };
    mockConversationService.createConversation.mockResolvedValue(conv);
    const dto = { type: 'DIRECT', participantIds: ['u-2'] };
    const req = buildReq({ body: dto });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.create(req as Request, res as Response, next);

    expect(mockConversationService.createConversation).toHaveBeenCalledWith(dto, 'u-1');
    expect(statusFn).toHaveBeenCalledWith(201);
    expect(jsonFn).toHaveBeenCalledWith({ data: conv });
  });

  it('create delegates errors to next', async () => {
    mockConversationService.createConversation.mockRejectedValue(new Error('fail'));
    const req = buildReq({ body: { type: 'DIRECT', participantIds: ['u-2'] } });
    const { res } = buildRes();

    await ctrl.create(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── getById ─────────────────────────────────────────────────────
  it('getById returns 200 with conversation', async () => {
    const conv = { id: 'c-1' };
    mockConversationService.getConversationById.mockResolvedValue(conv);
    const req = buildReq({ params: { conversationId: 'c-1' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.getById(req as Request, res as Response, next);

    expect(mockConversationService.getConversationById).toHaveBeenCalledWith('c-1', 'u-1');
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({ data: conv });
  });

  it('getById delegates errors to next', async () => {
    mockConversationService.getConversationById.mockRejectedValue(new Error('fail'));
    const req = buildReq({ params: { conversationId: 'c-1' } });
    const { res } = buildRes();

    await ctrl.getById(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── update (archive) ───────────────────────────────────────────
  it('update with isArchived=true calls archiveConversation', async () => {
    const conv = { id: 'c-1', isArchived: true };
    mockConversationService.archiveConversation.mockResolvedValue(conv);
    const req = buildReq({ params: { conversationId: 'c-1' }, body: { isArchived: true } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.update(req as Request, res as Response, next);

    expect(mockConversationService.archiveConversation).toHaveBeenCalledWith('c-1', 'u-1');
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({ data: conv });
  });

  // ── update (mute) ──────────────────────────────────────────────
  it('update with isMuted=true calls muteConversation', async () => {
    const conv = { id: 'c-1', isMuted: true };
    mockConversationService.muteConversation.mockResolvedValue(conv);
    const req = buildReq({ params: { conversationId: 'c-1' }, body: { isMuted: true } });
    const { res, statusFn } = buildRes();

    await ctrl.update(req as Request, res as Response, next);

    expect(mockConversationService.muteConversation).toHaveBeenCalled();
    expect(statusFn).toHaveBeenCalledWith(200);
  });

  // ── update (groupName) ─────────────────────────────────────────
  it('update with groupName calls updateGroupDetails', async () => {
    const conv = { id: 'c-1', groupName: 'New' };
    mockConversationService.updateGroupDetails.mockResolvedValue(conv);
    const req = buildReq({ params: { conversationId: 'c-1' }, body: { groupName: 'New' } });
    const { res, statusFn } = buildRes();

    await ctrl.update(req as Request, res as Response, next);

    expect(mockConversationService.updateGroupDetails).toHaveBeenCalledWith(
      'c-1',
      { groupName: 'New', groupAvatar: undefined },
      'u-1',
    );
    expect(statusFn).toHaveBeenCalledWith(200);
  });

  // ── update (no fields) ─────────────────────────────────────────
  it('update with empty body fetches current conversation', async () => {
    const conv = { id: 'c-1' };
    mockConversationService.getConversationById.mockResolvedValue(conv);
    const req = buildReq({ params: { conversationId: 'c-1' }, body: {} });
    const { res, statusFn } = buildRes();

    await ctrl.update(req as Request, res as Response, next);

    expect(mockConversationService.getConversationById).toHaveBeenCalledWith('c-1', 'u-1');
    expect(statusFn).toHaveBeenCalledWith(200);
  });

  it('update delegates errors to next', async () => {
    mockConversationService.archiveConversation.mockRejectedValue(new Error('fail'));
    const req = buildReq({ params: { conversationId: 'c-1' }, body: { isArchived: true } });
    const { res } = buildRes();

    await ctrl.update(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── addMember ───────────────────────────────────────────────────
  it('addMember returns 200 with updated conversation', async () => {
    const conv = { id: 'c-1' };
    mockConversationService.addParticipant.mockResolvedValue(conv);
    const req = buildReq({
      params: { conversationId: 'c-1' },
      body: { userId: 'u-3', role: 'MEMBER' },
    });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.addMember(req as Request, res as Response, next);

    expect(mockConversationService.addParticipant).toHaveBeenCalledWith('c-1', 'u-3', 'u-1', 'MEMBER');
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({ data: conv });
  });

  it('addMember delegates errors to next', async () => {
    mockConversationService.addParticipant.mockRejectedValue(new Error('fail'));
    const req = buildReq({ params: { conversationId: 'c-1' }, body: { userId: 'u-3' } });
    const { res } = buildRes();

    await ctrl.addMember(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── removeMember ────────────────────────────────────────────────
  it('removeMember returns 200 with updated conversation', async () => {
    const conv = { id: 'c-1' };
    mockConversationService.removeParticipant.mockResolvedValue(conv);
    const req = buildReq({ params: { conversationId: 'c-1', userId: 'u-3' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.removeMember(req as Request, res as Response, next);

    expect(mockConversationService.removeParticipant).toHaveBeenCalledWith('c-1', 'u-3', 'u-1');
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({ data: conv });
  });

  it('removeMember delegates errors to next', async () => {
    mockConversationService.removeParticipant.mockRejectedValue(new Error('fail'));
    const req = buildReq({ params: { conversationId: 'c-1', userId: 'u-3' } });
    const { res } = buildRes();

    await ctrl.removeMember(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
