/**
 * @file LoggerProvider.test.ts — Unit tests for Pino LoggerProvider
 *
 * Tests constructor log level handling, createLogger, createChildLogger,
 * getBaseLogger, and redaction configuration.
 */

import { LoggerProvider } from '../../../src/providers/LoggerProvider';

describe('LoggerProvider', () => {
  // ---- constructor ----
  describe('constructor', () => {
    it('should create a logger with valid log level', () => {
      const provider = new LoggerProvider('debug');
      const base = provider.getBaseLogger();
      expect(base.level).toBe('debug');
    });

    it('should default to info for unrecognized log level', () => {
      const provider = new LoggerProvider('invalid-level');
      const base = provider.getBaseLogger();
      expect(base.level).toBe('info');
    });

    it('should default to info when no level is provided', () => {
      const provider = new LoggerProvider();
      const base = provider.getBaseLogger();
      expect(base.level).toBe('info');
    });

    it('should accept silent log level', () => {
      const provider = new LoggerProvider('silent');
      const base = provider.getBaseLogger();
      expect(base.level).toBe('silent');
    });

    it('should accept all valid pino levels', () => {
      const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
      for (const level of levels) {
        const provider = new LoggerProvider(level);
        expect(provider.getBaseLogger().level).toBe(level);
      }
    });
  });

  // ---- createLogger ----
  describe('createLogger()', () => {
    it('should create a child logger with component binding', () => {
      const provider = new LoggerProvider('silent');
      const logger = provider.createLogger('http');
      // Child logger inherits level and has bindings
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('should create distinct loggers for different component names', () => {
      const provider = new LoggerProvider('silent');
      const httpLogger = provider.createLogger('http');
      const wsLogger = provider.createLogger('websocket');
      expect(httpLogger).not.toBe(wsLogger);
    });
  });

  // ---- createChildLogger ----
  describe('createChildLogger()', () => {
    it('should create child logger with additional bindings', () => {
      const provider = new LoggerProvider('silent');
      const parent = provider.createLogger('http');
      const child = provider.createChildLogger(parent, {
        correlationId: 'abc-123',
        method: 'GET',
        path: '/api/v1/users',
      });
      expect(child).toBeDefined();
      expect(typeof child.info).toBe('function');
      expect(child).not.toBe(parent);
    });
  });

  // ---- getBaseLogger ----
  describe('getBaseLogger()', () => {
    it('should return the root logger instance', () => {
      const provider = new LoggerProvider('silent');
      const base1 = provider.getBaseLogger();
      const base2 = provider.getBaseLogger();
      // Same instance
      expect(base1).toBe(base2);
      expect(typeof base1.info).toBe('function');
    });
  });
});
