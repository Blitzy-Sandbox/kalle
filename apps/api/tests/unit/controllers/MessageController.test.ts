/**
 * Unit tests for MessageController — per R16.
 */
import { Request, Response, NextFunction } from 'express';
import { MessageController } from '../../../src/controllers/MessageController';

const mockMessageService = {
  sendMessage: jest.fn(),
  editMessage: jest.fn(),
  deleteMessage: jest.fn(),
  getMessageHistory: jest.fn(),
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

describe('MessageController', () => {
  let ctrl: MessageController;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    ctrl = new MessageController(mockMessageService as any);
    next = jest.fn();
  });

  // ── send ────────────────────────────────────────────────────────
  it('send returns 201 with created message', async () => {
    const msg = { id: 'm-1', ciphertext: 'enc' };
    mockMessageService.sendMessage.mockResolvedValue(msg);
    const req = buildReq({
      params: { conversationId: 'c-1' },
      body: { ciphertext: 'enc', type: 'TEXT' },
    });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.send(req as Request, res as Response, next);

    expect(mockMessageService.sendMessage).toHaveBeenCalled();
    expect(statusFn).toHaveBeenCalledWith(201);
    expect(jsonFn).toHaveBeenCalledWith({ data: msg });
  });

  it('send delegates errors to next', async () => {
    mockMessageService.sendMessage.mockRejectedValue(new Error('fail'));
    const req = buildReq({ params: { conversationId: 'c-1' }, body: {} });
    const { res } = buildRes();

    await ctrl.send(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── edit ────────────────────────────────────────────────────────
  it('edit returns 200 with updated message', async () => {
    const msg = { id: 'm-1', ciphertext: 'enc2' };
    mockMessageService.editMessage.mockResolvedValue(msg);
    const req = buildReq({
      params: { messageId: 'm-1' },
      body: { ciphertext: 'enc2' },
    });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.edit(req as Request, res as Response, next);

    expect(mockMessageService.editMessage).toHaveBeenCalled();
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({ data: msg });
  });

  it('edit delegates errors to next', async () => {
    mockMessageService.editMessage.mockRejectedValue(new Error('fail'));
    const req = buildReq({ params: { messageId: 'm-1' }, body: {} });
    const { res } = buildRes();

    await ctrl.edit(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── delete ──────────────────────────────────────────────────────
  it('delete returns 200 with tombstone data', async () => {
    const result = {
      id: 'm-1',
      conversationId: 'c-1',
      isDeleted: true,
      deletedAt: '2025-01-01T00:00:00.000Z',
    };
    mockMessageService.deleteMessage.mockResolvedValue(result);
    const req = buildReq({ params: { messageId: 'm-1' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.delete(req as Request, res as Response, next);

    expect(mockMessageService.deleteMessage).toHaveBeenCalledWith({
      messageId: 'm-1',
      senderId: 'u-1',
    });
    expect(statusFn).toHaveBeenCalledWith(200);
    const call = jsonFn.mock.calls[0][0];
    expect(call.data.id).toBe('m-1');
    expect(call.data.isDeleted).toBe(true);
  });

  it('delete delegates errors to next', async () => {
    mockMessageService.deleteMessage.mockRejectedValue(new Error('fail'));
    const req = buildReq({ params: { messageId: 'm-1' } });
    const { res } = buildRes();

    await ctrl.delete(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── getHistory ──────────────────────────────────────────────────
  it('getHistory returns 200 with messages and pagination', async () => {
    const result = { messages: [{ id: 'm-1' }], nextCursor: 'mc', hasMore: false };
    mockMessageService.getMessageHistory.mockResolvedValue(result);
    const req = buildReq({
      params: { conversationId: 'c-1' },
      query: { cursor: 'mc0', limit: '25' },
    });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.getHistory(req as Request, res as Response, next);

    expect(mockMessageService.getMessageHistory).toHaveBeenCalled();
    expect(statusFn).toHaveBeenCalledWith(200);
    const call = jsonFn.mock.calls[0][0];
    expect(call).toHaveProperty('data');
    expect(call).toHaveProperty('pagination');
  });

  it('getHistory delegates errors to next', async () => {
    mockMessageService.getMessageHistory.mockRejectedValue(new Error('fail'));
    const req = buildReq({ params: { conversationId: 'c-1' } });
    const { res } = buildRes();

    await ctrl.getHistory(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
