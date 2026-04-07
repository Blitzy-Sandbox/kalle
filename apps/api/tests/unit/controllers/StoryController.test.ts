/**
 * Unit tests for StoryController — per R16.
 */
import { Request, Response, NextFunction } from 'express';
import { StoryController } from '../../../src/controllers/StoryController';

const mockStoryService = {
  createStory: jest.fn(),
  getStoryFeed: jest.fn(),
  getMyStories: jest.fn(),
  viewStory: jest.fn(),
  deleteStory: jest.fn(),
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

describe('StoryController', () => {
  let ctrl: StoryController;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    ctrl = new StoryController(mockStoryService as any);
    next = jest.fn();
  });

  // ── create ─────────────────────────────────────────────────────
  it('create returns 201 with story data', async () => {
    const story = { id: 's-1', type: 'TEXT' };
    mockStoryService.createStory.mockResolvedValue(story);
    const req = buildReq({ body: { type: 'TEXT', content: 'hi' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.create(req as Request, res as Response, next);

    expect(mockStoryService.createStory).toHaveBeenCalled();
    expect(statusFn).toHaveBeenCalledWith(201);
    expect(jsonFn).toHaveBeenCalledWith({ data: story });
  });

  it('create delegates errors to next', async () => {
    mockStoryService.createStory.mockRejectedValue(new Error('fail'));
    const req = buildReq({ body: {} });
    const { res } = buildRes();

    await ctrl.create(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── getFeed ────────────────────────────────────────────────────
  it('getFeed returns 200 with stories', async () => {
    const stories = [{ id: 's-1' }];
    mockStoryService.getStoryFeed.mockResolvedValue(stories);
    const req = buildReq();
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.getFeed(req as Request, res as Response, next);

    expect(mockStoryService.getStoryFeed).toHaveBeenCalledWith('u-1', []);
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({ data: stories });
  });

  it('getFeed delegates errors to next', async () => {
    mockStoryService.getStoryFeed.mockRejectedValue(new Error('fail'));
    const req = buildReq();
    const { res } = buildRes();

    await ctrl.getFeed(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── getMyStories ───────────────────────────────────────────────
  it('getMyStories returns 200', async () => {
    const myStories = [{ id: 's-2' }];
    mockStoryService.getMyStories.mockResolvedValue(myStories);
    const req = buildReq();
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.getMyStories(req as Request, res as Response, next);

    expect(mockStoryService.getMyStories).toHaveBeenCalledWith('u-1');
    expect(statusFn).toHaveBeenCalledWith(200);
    expect(jsonFn).toHaveBeenCalledWith({ data: myStories });
  });

  it('getMyStories delegates errors to next', async () => {
    mockStoryService.getMyStories.mockRejectedValue(new Error('fail'));
    const req = buildReq();
    const { res } = buildRes();

    await ctrl.getMyStories(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  // ── view ───────────────────────────────────────────────────────
  it('view returns 200', async () => {
    mockStoryService.viewStory.mockResolvedValue(undefined);
    const req = buildReq({ params: { storyId: 's-1' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.view(req as Request, res as Response, next);

    expect(mockStoryService.viewStory).toHaveBeenCalledWith('s-1', 'u-1');
    expect(statusFn).toHaveBeenCalledWith(200);
  });

  // ── deleteStory ────────────────────────────────────────────────
  it('delete returns 200 (storyId first, userId second)', async () => {
    mockStoryService.deleteStory.mockResolvedValue(undefined);
    const req = buildReq({ params: { storyId: 's-1' } });
    const { res, statusFn, jsonFn } = buildRes();

    await ctrl.delete(req as Request, res as Response, next);

    expect(mockStoryService.deleteStory).toHaveBeenCalledWith('s-1', 'u-1');
    expect(statusFn).toHaveBeenCalledWith(200);
  });
});
