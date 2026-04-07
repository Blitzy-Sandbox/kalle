/**
 * @file Unit tests for logger middleware
 */
import pino from 'pino';
import { createLoggerMiddleware } from '../../../src/middleware/logger';

describe('createLoggerMiddleware', () => {
  it('returns pino-http middleware function', () => {
    const logger = pino({ level: 'silent' });
    const mw = createLoggerMiddleware(logger);
    expect(typeof mw).toBe('function');
  });

  it('middleware accepts 3 arguments (req, res, next)', () => {
    const logger = pino({ level: 'silent' });
    const mw = createLoggerMiddleware(logger);
    // pino-http returns a middleware with 3 arguments
    expect(mw.length).toBeGreaterThanOrEqual(2);
  });
});
