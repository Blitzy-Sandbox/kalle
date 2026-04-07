/**
 * Unit tests for KeyController — per R16.
 */
import { Request, Response, NextFunction } from 'express';
import { KeyController } from '../../../src/controllers/KeyController';

const mockKeyService = {
  uploadBundle: jest.fn(),
  fetchBundle: jest.fn(),
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

describe('KeyController', () => {
  let ctrl: KeyController;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    ctrl = new KeyController(mockKeyService as any);
    next = jest.fn();
  });

  // ── uploadBundle ───────────────────────────────────────────────
  it('uploadBundle returns 201 with success message', async () => {
    mockKeyService.uploadBundle.mockResolvedValue(undefined);
    const req = buildReq({
      body: { identityKey: 'ik', signedPreKey: {}, preKeys: [] },
    });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.uploadBundle(req as Request, res as Response, next);

    expect(mockKeyService.uploadBundle).toHaveBeenCalledWith('u-1', req.body);
    expect(statusFn).toHaveBeenCalledWith(201);
    expect(jsonFn).toHaveBeenCalledWith({
      data: { message: 'PreKey bundle uploaded successfully' },
    });
  });

  it('uploadBundle delegates errors to next', async () => {
    mockKeyService.uploadBundle.mockRejectedValue(new Error('fail'));
    const req = buildReq({ body: {} });
    const { res } = buildRes();

    await ctrl.uploadBundle(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── getBundle ──────────────────────────────────────────────────
  it('getBundle returns 200 with bundle data', async () => {
    const bundle = { identityKey: 'ik', signedPreKey: {}, preKey: {} };
    mockKeyService.fetchBundle.mockResolvedValue({
      bundle,
      lowPreKeys: false,
      remainingPreKeys: 50,
    });
    const req = buildReq({ params: { userId: 'u-2' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.getBundle(req as Request, res as Response, next);

    expect(mockKeyService.fetchBundle).toHaveBeenCalledWith('u-2');
    expect(statusFn).toHaveBeenCalledWith(200);
    const call = jsonFn.mock.calls[0][0];
    expect(call.data).toEqual(bundle);
  });

  it('getBundle delegates errors to next', async () => {
    mockKeyService.fetchBundle.mockRejectedValue(new Error('fail'));
    const req = buildReq({ params: { userId: 'u-2' } });
    const { res } = buildRes();

    await ctrl.getBundle(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
