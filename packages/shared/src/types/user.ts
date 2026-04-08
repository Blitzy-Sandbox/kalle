/**
 * @module @kalle/shared/types/user
 *
 * User domain types and DTOs for the Kalle WhatsApp clone.
 *
 * The User is the foundational domain entity — referenced by conversations,
 * messages, stories, media, sessions, audit logs, and encryption keys.
 * This is the most-depended-upon type file in the shared package.
 *
 * Key design decisions:
 * - Registration uses email+password (NOT phone OTP) per AAP Section 0.8.2
 * - All date/time fields use ISO 8601 string format for cross-platform compatibility
 * - Password is included in CreateUserDTO but NEVER in any response type (R23: log hygiene)
 * - UserStatus is a string-valued enum for serialization safety across JSON boundaries
 * - Optional fields use TypeScript's optional modifier (`?`) for partial update patterns
 *
 * This file contains ZERO runtime code — only TypeScript types, interfaces, and enums.
 * It has ZERO imports from other type files to prevent circular dependencies.
 */

// =============================================================================
// Enums
// =============================================================================

/**
 * UserStatus — represents the user's current online/activity status.
 *
 * Used in real-time presence tracking via WebSocket events and displayed
 * in contact info, chat headers, and conversation list items.
 *
 * String-valued enum ensures safe JSON serialization between frontend and backend.
 */
export enum UserStatus {
  /** User is currently connected and active */
  ONLINE = 'ONLINE',
  /** User is not connected; lastSeen timestamp indicates last activity */
  OFFLINE = 'OFFLINE',
}

// =============================================================================
// Data Transfer Objects (DTOs) — Input Payloads
// =============================================================================

/**
 * CreateUserDTO — payload for creating a new user during registration.
 *
 * Used by:
 * - POST /api/v1/auth/register (via AuthService.register)
 * - prisma/seed.ts (deterministic seed data generation)
 *
 * Notes:
 * - `email` must be unique across all users (enforced by database unique index)
 * - `password` will be hashed via bcryptjs before storage — never stored in plaintext
 * - `displayName` is the user-facing name shown in chat UIs and contact lists
 * - Optional fields default to sensible values in the service layer
 */
export interface CreateUserDTO {
  /** Unique email address — validated format, used for login authentication */
  email: string;

  /** Plain-text password — hashed via bcryptjs before persistence (R23: never logged) */
  password: string;

  /** Display name shown in the UI across chat lists, messages, and contacts */
  displayName: string;

  /** Optional phone number (e.g., "+1 202 555 0181") */
  phoneNumber?: string;

  /** Optional avatar image URL */
  avatar?: string;

  /** Optional status/about text (defaults to "Hey there! I am using WhatsApp") */
  about?: string;
}

/**
 * UpdateProfileDTO — payload for updating user profile fields.
 *
 * Used by:
 * - PATCH /api/v1/users/me (via UserService.updateProfile)
 * - Figma Screen 15: Edit Profile (displayName, avatar, about, phoneNumber)
 *
 * All fields are optional — supports partial update pattern where only provided
 * fields are modified. Omitted fields retain their current values.
 */
export interface UpdateProfileDTO {
  /** Updated display name */
  displayName?: string;

  /** Updated avatar URL, or undefined to keep current value */
  avatar?: string;

  /** Updated status/about text (Figma Screen 15: "Digital goodies designer - Pixsellz") */
  about?: string;

  /** Updated phone number */
  phoneNumber?: string;
}

// =============================================================================
// Response Types — API Output Shapes
// =============================================================================

/**
 * UserResponse — full user representation returned from the API.
 *
 * Excludes sensitive fields (password hash) per security requirements (R23).
 * Used in:
 * - GET /api/v1/users/me
 * - POST /api/v1/auth/register (response)
 * - POST /api/v1/auth/login (response)
 * - Contact detail views
 *
 * All date fields use ISO 8601 string format (e.g., "2026-03-30T12:00:00.000Z").
 */
export interface UserResponse {
  /** Unique user identifier (UUID v4) */
  id: string;

  /** User's email address */
  email: string;

  /** Display name shown in UI */
  displayName: string;

  /** Avatar image URL */
  avatar?: string;

  /** Status/about text (Figma Screen 15: "Digital goodies designer - Pixsellz") */
  about?: string;

  /** Phone number */
  phoneNumber?: string;

  /** Current online/offline status — populated from real-time presence data */
  status: UserStatus;

  /** ISO 8601 timestamp of last activity (set when user goes offline) */
  lastSeen?: string;

  /** ISO 8601 timestamp of account creation */
  createdAt: string;

  /** ISO 8601 timestamp of last profile update */
  updatedAt: string;
}

/**
 * UserSearchResult — lightweight user representation for search results.
 *
 * Used in cursor-paginated user search (GET /api/v1/users/search).
 * Contains only the fields necessary for rendering search result list items.
 * Omits timestamps and phone number to minimize payload size.
 */
export interface UserSearchResult {
  /** Unique user identifier */
  id: string;

  /** Display name for rendering in search results */
  displayName: string;

  /** Email address for additional identification context */
  email: string;

  /** Avatar image URL */
  avatar?: string;

  /** Status/about text shown as subtitle in search results */
  about?: string;

  /** Current online/offline status indicator */
  status: UserStatus;
}

/**
 * BlockedUserInfo — information about a user that has been blocked.
 *
 * Used in:
 * - GET /api/v1/users/blocked (list of blocked users)
 * - POST /api/v1/users/:userId/block (response)
 *
 * Contains minimal identifying info plus the timestamp of when the block occurred.
 */
export interface BlockedUserInfo {
  /** ID of the blocked user */
  userId: string;

  /** Display name of the blocked user */
  displayName: string;

  /** Avatar image URL of the blocked user */
  avatar?: string;

  /** ISO 8601 timestamp of when the block was created */
  blockedAt: string;
}

/**
 * UserPresenceInfo — lightweight presence data for real-time updates.
 *
 * Emitted via WebSocket `user:presence` events to connected clients.
 * Contains only the fields needed to update presence indicators in the UI:
 * online/offline badge and last-seen timestamp.
 */
export interface UserPresenceInfo {
  /** ID of the user whose presence changed */
  userId: string;

  /** Current online/offline status */
  status: UserStatus;

  /** ISO 8601 timestamp of last activity (present when status is OFFLINE) */
  lastSeen?: string;
}

// =============================================================================
// Contact Types — Extended User Info
// =============================================================================

/**
 * ContactInfo — extended user information for the contact detail page.
 *
 * Maps to Figma Screen 6 (WhatsApp Contact Info) which shows:
 * - Profile photo, name, phone number
 * - Action row (message, video call, phone call)
 * - Status text with date
 * - "Media, Links, and Docs" count (e.g., "12")
 * - "Starred Messages" row
 * - Block status
 * - Shared group count
 *
 * Extends UserResponse with relationship-specific data (isBlocked,
 * sharedGroupCount, mediaCount) that depends on the requesting user's context.
 */
export interface ContactInfo {
  /** Unique user identifier */
  id: string;

  /** Display name of the contact */
  displayName: string;

  /** Email address of the contact */
  email: string;

  /** Avatar image URL */
  avatar?: string;

  /** Status/about text (Figma Screen 6: "Design adds value faster, than it adds cost") */
  about?: string;

  /** Phone number (Figma Screen 6: "+1 202 555 0181") */
  phoneNumber?: string;

  /** Current online/offline status */
  status: UserStatus;

  /** ISO 8601 timestamp of last activity */
  lastSeen?: string;

  /** Whether the requesting user has blocked this contact */
  isBlocked: boolean;

  /** Number of group conversations shared between the requesting user and this contact */
  sharedGroupCount?: number;

  /** Total count of shared media, links, and documents (Figma Screen 6: "12") */
  mediaCount?: number;
}
