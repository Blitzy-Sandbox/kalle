/**
 * Unit tests for MediaController — per R16.
 */
import { Request, Response, NextFunction } from 'express';
import { MediaController } from '../../../src/controllers/MediaController';

const mockMediaService = {
  uploadMedia: jest.fn(),
  getMediaById: jest.fn(),
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

describe('MediaController', () => {
  let ctrl: MediaController;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    ctrl = new MediaController(mockMediaService as any);
    next = jest.fn();
  });

  // ── upload ──────────────────────────────────────────────────────
  it('upload returns 201 with media data when file present', async () => {
    const media = { id: 'media-1', url: '/uploads/a.enc' };
    mockMediaService.uploadMedia.mockResolvedValue(media);
    const req = buildReq({
      file: { buffer: Buffer.from('data'), originalname: 'photo.jpg', mimetype: 'image/jpeg', size: 1024 },
      body: { type: 'image/jpeg', fileName: 'photo.jpg', mimeType: 'image/jpeg' },
    });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.upload(req as Request, res as Response, next);

    expect(mockMediaService.uploadMedia).toHaveBeenCalled();
    expect(statusFn).toHaveBeenCalledWith(201);
    expect(jsonFn).toHaveBeenCalledWith({ data: media });
  });

  it('upload returns 400 when no file is provided', async () => {
    const req = buildReq({ file: undefined });
    const { res } = buildRes();

    await ctrl.upload(req as Request, res as Response, next);

    // Error should be passed to next for the global error handler
    expect(next).toHaveBeenCalled();
  });

  it('upload delegates errors to next', async () => {
    mockMediaService.uploadMedia.mockRejectedValue(new Error('fail'));
    const req = buildReq({
      file: { buffer: Buffer.from('data'), originalname: 'a.jpg', mimetype: 'image/jpeg', size: 100 },
      body: {},
    });
    const { res } = buildRes();

    await ctrl.upload(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── getMedia ────────────────────────────────────────────────────
  it('getMedia returns 200 with media record', async () => {
    const media = { id: 'media-1', url: '/uploads/a.enc' };
    mockMediaService.getMediaById.mockResolvedValue(media);
    const req = buildReq({ params: { mediaId: 'media-1' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.getMedia(req as Request, res as Response, next);

    expect(mockMediaService.getMediaById).toHaveBeenCalledWith('media-1');
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({ data: media });
  });

  it('getMedia delegates errors to next', async () => {
    mockMediaService.getMediaById.mockRejectedValue(new Error('fail'));
    const req = buildReq({ params: { mediaId: 'media-1' } });
    const { res } = buildRes();

    await ctrl.getMedia(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
