/**
 * @module apps/api/src/domain/models/User
 *
 * User domain model implementing core business logic with encapsulated behavior.
 * Provides email validation, password complexity checks, profile updates with
 * field validation, online status management, and safe serialization excluding
 * the password hash.
 *
 * This is the foundational entity referenced by conversations, messages, stories,
 * media, sessions, audit logs, and encryption keys. Zero Prisma dependencies —
 * pure TypeScript class.
 *
 * Architecture rules enforced:
 * - R16 (OOD Layering): Business logic encapsulated in methods, not anemic data bags
 * - R17 (Interface-Driven): Zero Prisma imports — ORM-agnostic pure TypeScript
 * - R23 (Log Hygiene): passwordHash NEVER in toResponse() or serialized output
 * - R7 (Zero Warnings): TypeScript strict mode compatible with zero warnings
 * - R28 (Structured Logging): Zero direct stdout/stderr logging calls — use Pino only
 */

import { randomUUID } from 'node:crypto';

import { UserStatus } from '@kalle/shared/types/user';
import type { UpdateProfileDTO, UserResponse } from '@kalle/shared/types/user';

// =============================================================================
// Constants
// =============================================================================

/** Minimum required password length for registration (used by validatePassword) */
const MIN_PASSWORD_LENGTH = 8;

/** Maximum allowed display name length in characters */
const MAX_DISPLAY_NAME_LENGTH = 100;

/** Maximum allowed "about" text length in characters */
const MAX_ABOUT_LENGTH = 500;

/** Default "about" text assigned to new users when no about text is provided */
const DEFAULT_ABOUT = 'Hey there! I am using WhatsApp';

/**
 * Regex pattern for basic email format validation.
 * Requires: local-part@domain.tld
 * - At least one non-whitespace, non-@ character before @
 * - At least one non-whitespace, non-@ character between @ and the last dot
 * - At least one non-whitespace, non-@ character after the last dot
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Regex pattern for phone number format validation.
 * Allows: digits (0-9), spaces, plus (+), hyphen (-), and parentheses.
 */
const PHONE_REGEX = /^[0-9+\-\s()]+$/;

// =============================================================================
// Interface
// =============================================================================

/**
 * UserProps — constructor input shape for creating a User domain model instance.
 *
 * This interface is used when reconstituting a User from persistence (repository
 * layer) and when constructing new User instances via the static create() factory.
 *
 * NOTE: passwordHash is included here for internal use (bcrypt comparison in
 * AuthService) but MUST NEVER be included in toResponse() or any serialized output.
 */
export interface UserProps {
  /** Unique user identifier (UUID v4) */
  id: string;

  /** User's email address — unique across all users */
  email: string;

  /** bcrypt password hash — NEVER exposed in API responses (R23) */
  passwordHash: string;

  /** User-facing display name shown in chat UIs and contact lists */
  displayName: string;

  /** Optional phone number (e.g., "+1 202 555 0181") */
  phoneNumber?: string;

  /** Optional avatar image URL */
  avatar?: string;

  /** Optional status/about text. Defaults to "Hey there! I am using WhatsApp" */
  about?: string;

  /** Current online/offline status */
  status: UserStatus;

  /** When user was last active — set when user transitions to offline */
  lastSeen?: Date;

  /** Timestamp of account creation */
  createdAt: Date;

  /** Timestamp of last profile update */
  updatedAt: Date;
}

// =============================================================================
// Domain Model
// =============================================================================

/**
 * User domain model — the foundational entity in the Kalle WhatsApp clone.
 *
 * Encapsulates all user-related business logic:
 * - Email format validation (regex-based)
 * - Password complexity validation (8+ chars, uppercase, lowercase, digit, special)
 * - Profile update with field-level validation and partial update support
 * - Online/offline status management with last-seen tracking
 * - Safe serialization (toResponse excludes passwordHash per R23)
 * - Lightweight search result serialization
 * - Case-insensitive search matching across displayName and email
 *
 * This class has ZERO external dependencies — no database, no HTTP, no filesystem.
 * It is a pure domain model that can be unit-tested in complete isolation.
 */
export class User {
  // -------------------------------------------------------------------------
  // Immutable fields — set once at creation, never changed
  // -------------------------------------------------------------------------
  private readonly _id: string;
  private readonly _email: string;
  private readonly _passwordHash: string;
  private readonly _createdAt: Date;

  // -------------------------------------------------------------------------
  // Mutable fields — updated through domain methods
  // -------------------------------------------------------------------------
  private _displayName: string;
  private _phoneNumber: string | undefined;
  private _avatar: string | undefined;
  private _about: string | undefined;
  private _status: UserStatus;
  private _lastSeen: Date | undefined;
  private _updatedAt: Date;

  /**
   * Constructs a User instance from UserProps.
   *
   * This constructor is intentionally permissive — validation is performed
   * in the static create() factory method and updateProfile() method.
   * The constructor is used both for new user creation and for reconstituting
   * existing users from the persistence layer (repository).
   *
   * @param props - Complete user properties including all required fields
   */
  constructor(props: UserProps) {
    this._id = props.id;
    this._email = props.email;
    this._passwordHash = props.passwordHash;
    this._displayName = props.displayName;
    this._phoneNumber = props.phoneNumber;
    this._avatar = props.avatar;
    this._about = props.about;
    this._status = props.status;
    this._lastSeen = props.lastSeen;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  // =========================================================================
  // Getter Accessors
  // =========================================================================

  /** Unique user identifier (UUID v4) */
  get id(): string {
    return this._id;
  }

  /** User's email address */
  get email(): string {
    return this._email;
  }

  /**
   * bcrypt password hash — accessible for internal service use only.
   * AuthService needs it for bcrypt.compare during login verification.
   * MUST NOT appear in toResponse() or any serialized output (R23: log hygiene).
   */
  get passwordHash(): string {
    return this._passwordHash;
  }

  /** User-facing display name */
  get displayName(): string {
    return this._displayName;
  }

  /** Phone number (optional) */
  get phoneNumber(): string | undefined {
    return this._phoneNumber;
  }

  /** Avatar image URL (optional) */
  get avatar(): string | undefined {
    return this._avatar;
  }

  /** Status/about text (optional) */
  get about(): string | undefined {
    return this._about;
  }

  /** Current online/offline status */
  get status(): UserStatus {
    return this._status;
  }

  /** Timestamp of last activity — set when user transitions to offline */
  get lastSeen(): Date | undefined {
    return this._lastSeen;
  }

  /** Timestamp of account creation (immutable) */
  get createdAt(): Date {
    return this._createdAt;
  }

  /** Timestamp of last profile update */
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // =========================================================================
  // Static Factory Method
  // =========================================================================

  /**
   * Creates a new User instance with full validation.
   *
   * This is the primary entry point for creating new users during registration.
   * Performs validation on email format, display name presence/length, and
   * password hash presence. Optional fields are validated if provided.
   *
   * NOTE: The `passwordHash` parameter should already be hashed by the service
   * layer (via bcryptjs). This method does NOT hash passwords — it only validates
   * that a hash was provided.
   *
   * @param dto - New user data with email, passwordHash, displayName, and optional fields
   * @returns A new User instance in OFFLINE status with generated UUID
   * @throws Error if email is empty or has invalid format
   * @throws Error if displayName is empty or exceeds 100 characters
   * @throws Error if passwordHash is empty
   * @throws Error if about exceeds 500 characters
   * @throws Error if phoneNumber has invalid format
   */
  static create(dto: {
    email: string;
    passwordHash: string;
    displayName: string;
    phoneNumber?: string;
    avatar?: string;
    about?: string;
  }): User {
    // Validate email is not empty and has valid format
    const trimmedEmail = dto.email.trim();
    if (trimmedEmail.length === 0) {
      throw new Error('Email is required');
    }
    User.validateEmail(trimmedEmail);

    // Validate displayName is not empty and within length bounds
    const trimmedDisplayName = dto.displayName.trim();
    if (trimmedDisplayName.length === 0) {
      throw new Error('Display name is required');
    }
    if (trimmedDisplayName.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new Error(
        `Display name must not exceed ${MAX_DISPLAY_NAME_LENGTH} characters`
      );
    }

    // Validate passwordHash is not empty (should already be hashed by service layer)
    if (!dto.passwordHash || dto.passwordHash.length === 0) {
      throw new Error('Password hash is required');
    }

    // Validate optional about length
    if (dto.about !== undefined && dto.about.length > MAX_ABOUT_LENGTH) {
      throw new Error(
        `About text must not exceed ${MAX_ABOUT_LENGTH} characters`
      );
    }

    // Validate optional phone number format
    if (
      dto.phoneNumber !== undefined &&
      dto.phoneNumber.length > 0 &&
      !PHONE_REGEX.test(dto.phoneNumber)
    ) {
      throw new Error(
        'Invalid phone number format. Only digits, spaces, +, -, and parentheses are allowed'
      );
    }

    const now = new Date();

    return new User({
      id: randomUUID(),
      email: trimmedEmail,
      passwordHash: dto.passwordHash,
      displayName: trimmedDisplayName,
      phoneNumber: dto.phoneNumber,
      avatar: dto.avatar,
      about: dto.about ?? DEFAULT_ABOUT,
      status: UserStatus.OFFLINE,
      lastSeen: undefined,
      createdAt: now,
      updatedAt: now,
    });
  }

  // =========================================================================
  // Validation Methods
  // =========================================================================

  /**
   * Validates an email address format.
   *
   * Uses a regex pattern that requires:
   * - Characters before the @ symbol (local part)
   * - Characters between @ and the last dot (domain)
   * - Characters after the last dot (TLD)
   * - No whitespace characters anywhere
   *
   * Input is trimmed before validation.
   *
   * @param email - Email address to validate
   * @throws Error with message "Invalid email format" if validation fails
   */
  static validateEmail(email: string): void {
    const trimmed = email.trim();
    if (!EMAIL_REGEX.test(trimmed)) {
      throw new Error('Invalid email format');
    }
  }

  /**
   * Validates a password against complexity requirements.
   *
   * Checks:
   * - Minimum 8 characters
   * - At least one uppercase letter (A-Z)
   * - At least one lowercase letter (a-z)
   * - At least one digit (0-9)
   * - At least one special character (!@#$%^&*()_+-=[]{}|;:',.<>?/)
   *
   * This is a STATIC method used by the AuthService BEFORE hashing. The User
   * model only stores the hash — it never sees the plaintext password at runtime.
   *
   * @param password - Plaintext password to validate
   * @returns Object with isValid boolean and array of specific error messages
   */
  static validatePassword(password: string): {
    isValid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (password.length < MIN_PASSWORD_LENGTH) {
      errors.push(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`
      );
    }

    if (!/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }

    if (!/[a-z]/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }

    if (!/[0-9]/.test(password)) {
      errors.push('Password must contain at least one digit');
    }

    if (!/[!@#$%^&*()_+\-=[\]{}|;:',.<>?/]/.test(password)) {
      errors.push('Password must contain at least one special character');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  // =========================================================================
  // Profile Update Methods
  // =========================================================================

  /**
   * Updates user profile fields with validation.
   *
   * Supports partial updates — only provided fields are modified. Undefined
   * fields are skipped, preserving current values. Validates each provided
   * field before applying the update.
   *
   * @param dto - Partial profile update with optional displayName, avatar, about, phoneNumber
   * @throws Error if displayName is empty or exceeds 100 characters
   * @throws Error if about exceeds 500 characters
   * @throws Error if phoneNumber has invalid format
   */
  updateProfile(dto: UpdateProfileDTO): void {
    // Validate and update displayName if provided
    if (dto.displayName !== undefined) {
      const trimmed = dto.displayName.trim();
      if (trimmed.length === 0) {
        throw new Error('Display name cannot be empty');
      }
      if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
        throw new Error(
          `Display name must not exceed ${MAX_DISPLAY_NAME_LENGTH} characters`
        );
      }
      this._displayName = trimmed;
    }

    // Update avatar if provided (accepts string URL or undefined to keep current)
    if (dto.avatar !== undefined) {
      this._avatar = dto.avatar;
    }

    // Validate and update about if provided
    if (dto.about !== undefined) {
      if (dto.about.length > MAX_ABOUT_LENGTH) {
        throw new Error(
          `About text must not exceed ${MAX_ABOUT_LENGTH} characters`
        );
      }
      this._about = dto.about;
    }

    // Validate and update phoneNumber if provided
    if (dto.phoneNumber !== undefined) {
      if (dto.phoneNumber.length > 0 && !PHONE_REGEX.test(dto.phoneNumber)) {
        throw new Error(
          'Invalid phone number format. Only digits, spaces, +, -, and parentheses are allowed'
        );
      }
      this._phoneNumber = dto.phoneNumber;
    }

    // Update the modification timestamp
    this._updatedAt = new Date();
  }

  /**
   * Transitions the user to ONLINE status.
   *
   * Called when the user establishes a WebSocket connection. Does NOT clear
   * lastSeen — it represents the last time the user was seen online and is
   * retained for display when the user eventually goes offline again.
   */
  setOnline(): void {
    this._status = UserStatus.ONLINE;
    this._updatedAt = new Date();
  }

  /**
   * Transitions the user to OFFLINE status and records the current time
   * as lastSeen.
   *
   * Called when the user's WebSocket connection is lost or intentionally
   * closed. Sets lastSeen to the current time so other users can see
   * "last seen at X" in the contact info and chat headers.
   */
  setOffline(): void {
    this._status = UserStatus.OFFLINE;
    this._lastSeen = new Date();
    this._updatedAt = new Date();
  }

  /**
   * Checks whether the user is currently online.
   *
   * @returns true if the user's status is ONLINE, false otherwise
   */
  isOnline(): boolean {
    return this._status === UserStatus.ONLINE;
  }

  // =========================================================================
  // Serialization Methods
  // =========================================================================

  /**
   * Serializes the user to a safe API response format.
   *
   * CRITICAL (R23 — Log Hygiene / Security):
   * This method MUST NEVER include passwordHash in the returned object.
   * The password hash is sensitive authentication data that must not be exposed
   * in API responses, logs, or any serialized output.
   *
   * Date fields are converted to ISO 8601 string format for cross-platform
   * JSON serialization compatibility.
   *
   * @returns UserResponse object safe for API serialization — excludes passwordHash
   */
  toResponse(): UserResponse {
    return {
      id: this._id,
      email: this._email,
      displayName: this._displayName,
      avatar: this._avatar,
      about: this._about,
      phoneNumber: this._phoneNumber,
      status: this._status,
      lastSeen: this._lastSeen?.toISOString(),
      createdAt: this._createdAt.toISOString(),
      updatedAt: this._updatedAt.toISOString(),
    };
  }

  /**
   * Serializes the user to a lightweight search result format.
   *
   * Contains only the fields necessary for rendering search result list items.
   * MUST NOT include passwordHash, phoneNumber, lastSeen, or timestamps
   * to minimize payload size and avoid leaking sensitive data.
   *
   * @returns Lightweight user representation for search results
   */
  toSearchResult(): {
    id: string;
    displayName: string;
    email: string;
    avatar?: string;
    about?: string;
    status: UserStatus;
  } {
    return {
      id: this._id,
      displayName: this._displayName,
      email: this._email,
      avatar: this._avatar,
      about: this._about,
      status: this._status,
    };
  }

  // =========================================================================
  // Utility Methods
  // =========================================================================

  /**
   * Checks if the user matches a search query.
   *
   * Performs case-insensitive substring matching against the user's displayName
   * and email fields. Used for server-side user search endpoint.
   *
   * @param query - Search query string
   * @returns true if the query matches displayName or email (case-insensitive)
   */
  matchesSearch(query: string): boolean {
    const lowerQuery = query.toLowerCase();
    return (
      this._displayName.toLowerCase().includes(lowerQuery) ||
      this._email.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Calculates the time elapsed since the user was last seen online.
   *
   * Returns undefined if the user is currently online (no "time since" is
   * meaningful) or if lastSeen has never been set (user has never gone offline).
   *
   * @param now - Optional reference time (defaults to current time). Useful for deterministic testing.
   * @returns Milliseconds since lastSeen, or undefined if online or lastSeen not set
   */
  getTimeSinceLastSeen(now?: Date): number | undefined {
    if (this.isOnline()) {
      return undefined;
    }
    if (this._lastSeen === undefined) {
      return undefined;
    }
    const reference = now ?? new Date();
    return reference.getTime() - this._lastSeen.getTime();
  }
}
