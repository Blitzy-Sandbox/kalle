/**
 * @file Unit tests for AuthController — all 5 endpoints
 */
import { Request, Response, NextFunction } from 'express';
import { AuthController } from '../../../src/controllers/AuthController';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    body: {},
    headers: {},
    correlationId: 'corr-1',
    ip: '127.0.0.1',
    get: jest.fn().mockReturnValue('test-agent'),
    user: { userId: 'user-1', jti: 'jti-1' },
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('AuthController', () => {
  let authService: any;
  let controller: AuthController;
  let next: NextFunction;

  beforeEach(() => {
    authService = {
      register: jest.fn(),
      login: jest.fn(),
      refreshToken: jest.fn(),
      revokeSession: jest.fn(),
      revokeAllSessions: jest.fn(),
    };
    controller = new AuthController(authService);
    next = jest.fn();
  });

  describe('register', () => {
    it('returns 201 with auth response on success', async () => {
      const authResult = { user: { id: 'u1' }, tokens: { accessToken: 'at' } };
      authService.register.mockResolvedValue(authResult);
      const req = mockReq({ body: { email: 'a@b.com', password: 'pass', displayName: 'A' } });
      const res = mockRes();
      await controller.register(req, res, next);
      expect(authService.register).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ data: authResult });
    });

    it('passes errors to next()', async () => {
      const error = new Error('conflict');
      authService.register.mockRejectedValue(error);
      const req = mockReq({ body: {} });
      const res = mockRes();
      await controller.register(req, res, next);
      expect(next).toHaveBeenCalledWith(error);
    });
  });

  describe('login', () => {
    it('returns 200 with auth response on success', async () => {
      const authResult = { user: { id: 'u1' }, tokens: { accessToken: 'at' } };
      authService.login.mockResolvedValue(authResult);
      const req = mockReq({ body: { email: 'a@b.com', password: 'pass' } });
      const res = mockRes();
      await controller.login(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ data: authResult });
    });

    it('passes errors to next()', async () => {
      authService.login.mockRejectedValue(new Error('bad creds'));
      const req = mockReq({ body: {} });
      const res = mockRes();
      await controller.login(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('refresh', () => {
    it('returns 200 with new tokens wrapped in data.tokens', async () => {
      const tokens = { accessToken: 'new-at', refreshToken: 'new-rt' };
      authService.refreshToken.mockResolvedValue(tokens);
      const req = mockReq({ body: { refreshToken: 'old-rt' } });
      const res = mockRes();
      await controller.refresh(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ data: { tokens } });
    });

    it('passes errors to next()', async () => {
      authService.refreshToken.mockRejectedValue(new Error('expired'));
      const req = mockReq({ body: { refreshToken: 'bad' } });
      const res = mockRes();
      await controller.refresh(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('revoke', () => {
    it('returns 200 on successful revoke', async () => {
      authService.revokeSession.mockResolvedValue(undefined);
      const req = mockReq({ headers: { authorization: 'Bearer test-token' } });
      const res = mockRes();
      await controller.revoke(req, res, next);
      expect(authService.revokeSession).toHaveBeenCalledWith('test-token', 'user-1', expect.any(Object));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('passes errors to next()', async () => {
      authService.revokeSession.mockRejectedValue(new Error('fail'));
      const req = mockReq({ headers: { authorization: 'Bearer tk' } });
      const res = mockRes();
      await controller.revoke(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('revokeAll', () => {
    it('returns 200 with revokedCount', async () => {
      authService.revokeAllSessions.mockResolvedValue(3);
      const req = mockReq();
      const res = mockRes();
      await controller.revokeAll(req, res, next);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ revokedCount: 3 }),
      }));
    });

    it('passes errors to next()', async () => {
      authService.revokeAllSessions.mockRejectedValue(new Error('fail'));
      const req = mockReq();
      const res = mockRes();
      await controller.revokeAll(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
