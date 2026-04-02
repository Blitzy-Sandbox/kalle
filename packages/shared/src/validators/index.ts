/**
 * @kalle/shared — Shared Zod Validation Schemas
 *
 * Single barrel file exporting ALL reusable Zod validation schemas shared across
 * the Kalle monorepo. Each schema exports BOTH the Zod schema object and the
 * inferred TypeScript type.
 *
 * Consumed by:
 * - Backend controllers for request validation (R31)
 * - Backend validation middleware for Zod-based middleware factory
 * - Frontend forms for client-side pre-validation
 * - Backend services for parameter validation
 *
 * Rules enforced:
 * - R31: Every controller validates via Zod before invoking service methods
 * - R7:  Zero warnings build — tsc --noEmit --strict passes clean
 * - R22: Standardized error responses with field-level validation details
 * - R8:  Media upload validation — 25MB size limit, MIME type required
 * - R12: Ciphertext fields validated as non-empty strings (opaque blobs)
 * - R30: Path param schemas validate UUIDs for all route parameters
 *
 * @module @kalle/shared/validators
 */

import { z } from 'zod';

// ============================================================================
// Phase 1: Base Primitive Schemas
// ============================================================================

/**
 * UUID Schema — reusable for ALL ID fields
 * (userId, conversationId, messageId, mediaId, storyId, etc.)
 */
export const uuidSchema = z.string().uuid('Invalid UUID format');

/** Inferred UUID type from uuidSchema */
export type UUID = z.infer<typeof uuidSchema>;

/**
 * Email Schema — validated email format for RegisterDTO, LoginDTO.
 * Normalizes to lowercase and trims whitespace.
 */
export const emailSchema = z
  .string()
  .email('Invalid email format')
  .max(255, 'Email must be at most 255 characters')
  .toLowerCase()
  .trim();

/** Inferred Email type from emailSchema */
export type Email = z.infer<typeof emailSchema>;

/**
 * Password Schema — for RegisterDTO, LoginDTO.
 * Requires minimum 8 characters with at least one uppercase letter,
 * one lowercase letter, one digit, and one special character.
 */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one digit')
  .regex(
    /[^A-Za-z0-9]/,
    'Password must contain at least one special character',
  );

/** Inferred Password type from passwordSchema */
export type Password = z.infer<typeof passwordSchema>;

/**
 * Display Name Schema — for user registration and profile updates.
 * Required, 1–100 characters, trimmed.
 */
export const displayNameSchema = z
  .string()
  .min(1, 'Display name is required')
  .max(100, 'Display name must be at most 100 characters')
  .trim();

/** Inferred DisplayName type from displayNameSchema */
export type DisplayName = z.infer<typeof displayNameSchema>;

/**
 * Phone Number Schema — optional, for user profile.
 * Validates international phone number format allowing digits,
 * spaces, dashes, parentheses, and optional leading +.
 */
export const phoneNumberSchema = z
  .string()
  .min(7, 'Phone number must be at least 7 characters')
  .max(20, 'Phone number must be at most 20 characters')
  .regex(/^\+?[0-9\s\-()]+$/, 'Invalid phone number format')
  .optional();

/** Inferred PhoneNumber type from phoneNumberSchema */
export type PhoneNumber = z.infer<typeof phoneNumberSchema>;

/**
 * About Text Schema — for user profile "about" field.
 * Optional, max 500 characters, trimmed.
 */
export const aboutSchema = z
  .string()
  .max(500, 'About text must be at most 500 characters')
  .trim()
  .optional();

/** Inferred About type from aboutSchema */
export type About = z.infer<typeof aboutSchema>;

// ============================================================================
// Phase 2: Pagination Schemas
// ============================================================================

/**
 * Pagination Query Schema — cursor-based pagination used across all list
 * endpoints. Limit defaults to 20, max 100.
 * Aligned with PaginationQuery from types/api-contracts.ts and
 * PAGINATION constants from constants/index.ts.
 */
export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .number({ coerce: true })
    .int('Limit must be an integer')
    .min(1, 'Limit must be at least 1')
    .max(100, 'Limit must be at most 100')
    .default(20)
    .optional(),
});

/** Inferred PaginationInput type from paginationSchema */
export type PaginationInput = z.infer<typeof paginationSchema>;

/**
 * Message Pagination Schema — larger default for message history (50 per page,
 * max 200). Includes optional `before` timestamp for time-based cursoring.
 */
export const messagePaginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .number({ coerce: true })
    .int('Limit must be an integer')
    .min(1, 'Limit must be at least 1')
    .max(200, 'Limit must be at most 200')
    .default(50)
    .optional(),
  before: z.string().datetime({ offset: true }).optional(),
});

/** Inferred MessagePaginationInput type from messagePaginationSchema */
export type MessagePaginationInput = z.infer<typeof messagePaginationSchema>;

// ============================================================================
// Phase 3: Auth Schemas (aligned with types/auth.ts)
// ============================================================================

/**
 * Register Schema — matches RegisterDTO.
 * Composes emailSchema, passwordSchema, displayNameSchema, phoneNumberSchema.
 */
export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  phoneNumber: phoneNumberSchema,
});

/** Inferred RegisterInput type from registerSchema */
export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Login Schema — matches LoginDTO.
 * Uses emailSchema for email but only requires password to be non-empty
 * (full password validation happens at registration, not login).
 */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});

/** Inferred LoginInput type from loginSchema */
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Refresh Token Schema — matches RefreshTokenDTO.
 * Requires a non-empty refresh token string.
 */
export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

/** Inferred RefreshTokenInput type from refreshTokenSchema */
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

/**
 * Revoke Session Schema — for session revocation endpoint.
 * Requires the refresh token to identify the session being revoked.
 */
export const revokeSessionSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

/** Inferred RevokeSessionInput type from revokeSessionSchema */
export type RevokeSessionInput = z.infer<typeof revokeSessionSchema>;

// ============================================================================
// Phase 4: User Schemas (aligned with types/user.ts)
// ============================================================================

/**
 * Update Profile Schema — matches UpdateProfileDTO.
 * All fields are optional — clients send only the fields they want to change.
 */
export const updateProfileSchema = z.object({
  displayName: displayNameSchema.optional(),
  avatar: z.string().url('Invalid avatar URL').nullable().optional(),
  about: aboutSchema,
  phoneNumber: phoneNumberSchema,
});

/** Inferred UpdateProfileInput type from updateProfileSchema */
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/**
 * User Search Schema — for GET /api/v1/users/search.
 * Requires a non-empty search query string with pagination support.
 */
export const userSearchSchema = z.object({
  q: z
    .string()
    .min(1, 'Search query is required')
    .max(100, 'Search query too long')
    .trim(),
  cursor: z.string().optional(),
  limit: z
    .number({ coerce: true })
    .int()
    .min(1)
    .max(100)
    .default(20)
    .optional(),
});

/** Inferred UserSearchInput type from userSearchSchema */
export type UserSearchInput = z.infer<typeof userSearchSchema>;

// ============================================================================
// Phase 5: Conversation Schemas (aligned with types/conversation.ts)
// ============================================================================

/**
 * Create Conversation Schema — matches CreateConversationDTO.
 * Supports DIRECT (1:1) and GROUP conversation types.
 * GROUP conversations require a groupName via cross-field refinement.
 */
export const createConversationSchema = z
  .object({
    type: z.enum(['DIRECT', 'GROUP']),
    participantIds: z
      .array(uuidSchema)
      .min(1, 'At least one participant is required'),
    groupName: z.string().min(1).max(100).trim().optional(),
    groupAvatar: z.string().url('Invalid avatar URL').optional(),
  })
  .refine(
    (data) => {
      if (data.type === 'GROUP' && !data.groupName) {
        return false;
      }
      return true;
    },
    {
      message: 'Group name is required for group conversations',
      path: ['groupName'],
    },
  );

/** Inferred CreateConversationInput type from createConversationSchema */
export type CreateConversationInput = z.infer<
  typeof createConversationSchema
>;

/**
 * Update Conversation Schema — for archive/unarchive, mute/unmute,
 * and group name/avatar updates. All fields optional.
 */
export const updateConversationSchema = z.object({
  isArchived: z.boolean().optional(),
  isMuted: z.boolean().optional(),
  muteExpiresAt: z
    .string()
    .datetime({ offset: true })
    .nullable()
    .optional(),
  groupName: z.string().min(1).max(100).trim().optional(),
  groupAvatar: z.string().url('Invalid avatar URL').nullable().optional(),
});

/** Inferred UpdateConversationInput type from updateConversationSchema */
export type UpdateConversationInput = z.infer<
  typeof updateConversationSchema
>;

/**
 * Add Member Schema — for POST /api/v1/conversations/:conversationId/members.
 * Requires userId (UUID) and an optional role defaulting to MEMBER.
 */
export const addMemberSchema = z.object({
  userId: uuidSchema,
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER').optional(),
});

/** Inferred AddMemberInput type from addMemberSchema */
export type AddMemberInput = z.infer<typeof addMemberSchema>;

// ============================================================================
// Phase 6: Message Schemas (aligned with types/message.ts)
// ============================================================================

/**
 * Send Message Schema — matches SendMessageDTO.
 * Note: `ciphertext` is validated as a non-empty string only (opaque encrypted
 * blob per R12 — server cannot inspect or validate ciphertext structure).
 * `clientMessageId` is a client-generated UUID for idempotency.
 */
export const sendMessageSchema = z.object({
  conversationId: uuidSchema,
  ciphertext: z.string().min(1, 'Ciphertext is required'),
  type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE_NOTE']),
  replyToMessageId: uuidSchema.optional(),
  mediaId: uuidSchema.optional(),
  clientMessageId: uuidSchema,
});

/** Inferred SendMessageInput type from sendMessageSchema */
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/**
 * Edit Message Schema — matches EditMessageDTO (R19: ciphertext swap).
 * Only the new ciphertext is required — message ID comes from path params.
 * The 15-minute edit window is enforced server-side, not in the schema.
 */
export const editMessageSchema = z.object({
  ciphertext: z.string().min(1, 'New ciphertext is required'),
});

/** Inferred EditMessageInput type from editMessageSchema */
export type EditMessageInput = z.infer<typeof editMessageSchema>;

// ============================================================================
// Phase 7: Media Schemas (aligned with types/media.ts)
// ============================================================================

/**
 * Upload Media Metadata Schema — for the metadata portion of multipart upload.
 * Enforces R8: 25MB (25 * 1024 * 1024 bytes) file size limit.
 * Actual binary file validation happens at multer/middleware level.
 * Encryption fields required per R12 (client-side encryption before upload).
 */
export const uploadMediaSchema = z.object({
  type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE_NOTE']),
  mimeType: z.string().min(1, 'MIME type is required'),
  fileName: z.string().min(1, 'File name is required').max(255),
  fileSize: z
    .number()
    .int()
    .positive('File size must be positive')
    .max(25 * 1024 * 1024, 'File size exceeds 25MB limit'),
  encryptionKey: z.string().min(1, 'Encryption key is required'),
  encryptionIv: z.string().min(1, 'Encryption IV is required'),
  messageId: uuidSchema.optional(),
  storyId: uuidSchema.optional(),
  hasThumbnail: z.boolean(),
  thumbnailEncryptionKey: z.string().min(1).optional(),
  thumbnailEncryptionIv: z.string().min(1).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration: z.number().positive().optional(),
  waveform: z.array(z.number().min(0).max(1)).optional(),
});

/** Inferred UploadMediaInput type from uploadMediaSchema */
export type UploadMediaInput = z.infer<typeof uploadMediaSchema>;

// ============================================================================
// Phase 8: Story Schemas (aligned with types/story.ts)
// ============================================================================

/**
 * Create Story Schema — matches CreateStoryDTO.
 * R11: 24-hour expiry is managed server-side, not in the schema.
 * Cross-field validation ensures:
 * - TEXT stories require `content`
 * - IMAGE/VIDEO stories require `mediaId`
 */
export const createStorySchema = z
  .object({
    type: z.enum(['TEXT', 'IMAGE', 'VIDEO']),
    content: z.string().max(700, 'Story text too long').optional(),
    mediaId: uuidSchema.optional(),
    backgroundColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color format')
      .optional(),
    fontStyle: z.string().max(50).optional(),
    duration: z.number().positive().max(30).optional(),
  })
  .refine(
    (data) => {
      if (data.type === 'TEXT' && !data.content) {
        return false;
      }
      if (
        (data.type === 'IMAGE' || data.type === 'VIDEO') &&
        !data.mediaId
      ) {
        return false;
      }
      return true;
    },
    {
      message:
        'TEXT stories require content; IMAGE/VIDEO stories require mediaId',
    },
  );

/** Inferred CreateStoryInput type from createStorySchema */
export type CreateStoryInput = z.infer<typeof createStorySchema>;

// ============================================================================
// Phase 9: Encryption Key Schemas (aligned with types/encryption.ts)
// ============================================================================

/**
 * PreKey Bundle Upload Schema — for POST /api/v1/keys/bundle (R12).
 * Validates the Signal Protocol key bundle structure:
 * - identityKey: public key + optional fingerprint
 * - signedPreKey: signed pre-key with ID, public key, signature, timestamp
 * - preKeys: array of one-time pre-keys (1–200 per upload)
 * - registrationId: client registration identifier
 */
export const preKeyBundleSchema = z.object({
  identityKey: z.object({
    publicKey: z.string().min(1, 'Public key is required'),
    fingerprint: z.string().optional(),
  }),
  signedPreKey: z.object({
    keyId: z.number().int().nonnegative(),
    publicKey: z
      .string()
      .min(1, 'Signed prekey public key is required'),
    signature: z.string().min(1, 'Signature is required'),
    timestamp: z.number().int().positive(),
  }),
  preKeys: z
    .array(
      z.object({
        keyId: z.number().int().nonnegative(),
        publicKey: z
          .string()
          .min(1, 'Prekey public key is required'),
      }),
    )
    .min(1, 'At least one prekey is required')
    .max(200, 'Too many prekeys in single upload'),
  registrationId: z.number().int().nonnegative(),
});

/** Inferred PreKeyBundleInput type from preKeyBundleSchema */
export type PreKeyBundleInput = z.infer<typeof preKeyBundleSchema>;

// ============================================================================
// Phase 10: Path Parameter Schemas
// ============================================================================

/**
 * Common path parameter schemas for validating route parameters.
 * Each wraps a single UUID field matching Express route param names.
 * Used by validation middleware on all resource endpoints (R30).
 */

/** Validates :userId path parameter as UUID */
export const userIdParamSchema = z.object({ userId: uuidSchema });

/** Inferred UserIdParam type from userIdParamSchema */
export type UserIdParam = z.infer<typeof userIdParamSchema>;

/** Validates :conversationId path parameter as UUID */
export const conversationIdParamSchema = z.object({
  conversationId: uuidSchema,
});

/** Inferred ConversationIdParam type from conversationIdParamSchema */
export type ConversationIdParam = z.infer<
  typeof conversationIdParamSchema
>;

/** Validates :messageId path parameter as UUID */
export const messageIdParamSchema = z.object({
  messageId: uuidSchema,
});

/** Inferred MessageIdParam type from messageIdParamSchema */
export type MessageIdParam = z.infer<typeof messageIdParamSchema>;

/** Validates :mediaId path parameter as UUID */
export const mediaIdParamSchema = z.object({ mediaId: uuidSchema });

/** Inferred MediaIdParam type from mediaIdParamSchema */
export type MediaIdParam = z.infer<typeof mediaIdParamSchema>;

/** Validates :storyId path parameter as UUID */
export const storyIdParamSchema = z.object({ storyId: uuidSchema });

/** Inferred StoryIdParam type from storyIdParamSchema */
export type StoryIdParam = z.infer<typeof storyIdParamSchema>;

// ============================================================================
// Phase 11: Audit Log Query Schema
// ============================================================================

/**
 * Audit Log Query Schema — for filtering and paginating audit logs.
 * Supports filtering by action type, actor, and date range.
 * Default limit is 50, max 100.
 */
export const auditLogQuerySchema = z.object({
  action: z.string().optional(),
  actorId: uuidSchema.optional(),
  startDate: z.string().datetime({ offset: true }).optional(),
  endDate: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().optional(),
  limit: z
    .number({ coerce: true })
    .int()
    .min(1)
    .max(100)
    .default(50)
    .optional(),
});

/** Inferred AuditLogQueryInput type from auditLogQuerySchema */
export type AuditLogQueryInput = z.infer<typeof auditLogQuerySchema>;
