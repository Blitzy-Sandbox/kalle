/**
 * @module jest.integration.config
 * @description Dedicated Jest configuration for backend integration tests.
 *
 * Integration tests require live infrastructure (PostgreSQL, Redis) and exercise
 * the full request pipeline: controllers → middleware → services → repositories → DB.
 *
 * Usage:
 *   npx jest --config jest.integration.config.ts
 *
 * Prerequisites:
 *   docker-compose up -d postgres redis   (or full stack via docker-compose up)
 *
 * Environment variables are set with sensible defaults in each test file's
 * `setupTestEnv()` helper, matching the values from .env.example / Docker Compose.
 */
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  // Only integration test directory
  roots: ['<rootDir>/tests/integration'],
  testMatch: ['**/*.test.ts'],

  moduleFileExtensions: ['ts', 'js', 'json'],

  // Longer timeouts for DB/Redis operations
  testTimeout: 30_000,

  // Coverage collection from all backend source
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
  ],
  coverageDirectory: 'coverage-integration',
  coverageReporters: ['text', 'lcov', 'clover'],

  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@kalle/shared(.*)$': '<rootDir>/../../packages/shared/src$1',
  },

  // Run tests sequentially — integration tests share a real database
  maxWorkers: 1,

  // Do NOT pass with no tests — integration tests MUST exist and run
  passWithNoTests: false,
};

export default config;
