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
export * from './types/websocket-events.js';
export * from './types/api-contracts.js';

// Resolve `GetMessagesQuery` ambiguity: both message.ts and api-contracts.ts
// export this name. The domain-level definition (from message.ts) includes
// `conversationId` and is the canonical query shape. The api-contracts version
// is an API-layer query-params subset. Prefer the domain definition here;
// consumers needing the API-layer shape import from the subpath directly:
//   import type { GetMessagesQuery } from '@kalle/shared/types/api-contracts';
export type { GetMessagesQuery } from './types/message.js';

// Constants
export * from './constants/index.js';

// Validators (Zod schemas)
export * from './validators/index.js';
