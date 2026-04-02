/**
 * @kalle/shared — Barrel Export
 *
 * Re-exports all types, DTOs, enums, constants, and Zod validators from the
 * shared package. Enables a single-import pattern for all consuming packages:
 *   import { UserResponse, emailSchema, RATE_LIMITS } from '@kalle/shared';
 */

// Types — Domain DTOs and interfaces
export * from './types/user.js';
export * from './types/conversation.js';
export * from './types/message.js';
export * from './types/media.js';
export * from './types/story.js';
export * from './types/auth.js';
export * from './types/encryption.js';
export * from './types/audit.js';
export * from './types/error.js';

// Constants
export * from './constants/index.js';

// Validators (Zod schemas)
export * from './validators/index.js';
