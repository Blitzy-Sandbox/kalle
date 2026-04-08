import { User, UserProps } from '../../../src/domain/models/User';
import { UserStatus } from '@kalle/shared/types/user';

/**
 * Helper factory returning a complete, valid UserProps object for test convenience.
 * Uses fixed dates for deterministic time-sensitive tests.
 */
const validUserProps = (): UserProps => ({
  id: 'user-123',
  email: 'test@example.com',
  passwordHash: '$2a$10$hashedpasswordvalue',
  displayName: 'Test User',
  phoneNumber: '+1234567890',
  avatar: 'https://example.com/avatar.png',
  about: 'Hey there! I am using Kalle',
  status: UserStatus.OFFLINE,
  lastSeen: new Date('2024-01-01T00:00:00Z'),
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
});

// ---------------------------------------------------------------------------
// Phase 2: Construction Tests
// ---------------------------------------------------------------------------
describe('User construction', () => {
  it('should construct with valid props and expose all getters correctly', () => {
    const props = validUserProps();
    const user = new User(props);

    expect(user.id).toBe('user-123');
    expect(user.email).toBe('test@example.com');
    expect(user.displayName).toBe('Test User');
    expect(user.phoneNumber).toBe('+1234567890');
    expect(user.avatar).toBe('https://example.com/avatar.png');
    expect(user.about).toBe('Hey there! I am using Kalle');
    expect(user.status).toBe(UserStatus.OFFLINE);
    expect(user.lastSeen).toEqual(new Date('2024-01-01T00:00:00Z'));
    expect(user.createdAt).toEqual(new Date('2024-01-01T00:00:00Z'));
    expect(user.updatedAt).toEqual(new Date('2024-01-01T00:00:00Z'));
  });

  it('should expose passwordHash getter for internal service use', () => {
    const props = validUserProps();
    const user = new User(props);

    expect(user.passwordHash).toBe('$2a$10$hashedpasswordvalue');
  });

  it('should have immutable id, email, and createdAt fields', () => {
    const props = validUserProps();
    const user = new User(props);

    // Verify the id, email, and createdAt remain unchanged after construction
    const originalId = user.id;
    const originalEmail = user.email;
    const originalCreatedAt = user.createdAt;

    // After performing a state change, immutable fields should not change
    user.setOnline();

    expect(user.id).toBe(originalId);
    expect(user.email).toBe(originalEmail);
    expect(user.createdAt).toEqual(originalCreatedAt);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Static Factory Method Tests
// ---------------------------------------------------------------------------
describe('User.create()', () => {
  it('should create a user with default about text when not provided', () => {
    const user = User.create({
      email: 'alice@example.com',
      displayName: 'Alice',
      passwordHash: '$2a$10$somehash',
    });

    expect(user.about).toBe('Hey there! I am using Kalle');
  });

  it('should create a user with custom about text when provided', () => {
    const user = User.create({
      email: 'alice@example.com',
      displayName: 'Alice',
      passwordHash: '$2a$10$somehash',
      about: 'Custom about text',
    });

    expect(user.about).toBe('Custom about text');
  });

  it('should set status to UserStatus.OFFLINE for new users', () => {
    const user = User.create({
      email: 'alice@example.com',
      displayName: 'Alice',
      passwordHash: '$2a$10$somehash',
    });

    expect(user.status).toBe(UserStatus.OFFLINE);
  });

  it('should set createdAt and updatedAt to the current time', () => {
    const before = new Date();
    const user = User.create({
      email: 'alice@example.com',
      displayName: 'Alice',
      passwordHash: '$2a$10$somehash',
    });
    const after = new Date();

    expect(user.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(user.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(user.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(user.updatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('should throw Error with "Invalid email format" for invalid email', () => {
    expect(() =>
      User.create({
        email: 'not-an-email',
        displayName: 'Alice',
        passwordHash: '$2a$10$somehash',
      }),
    ).toThrow('Invalid email format');
  });

  it('should throw Error for empty email string', () => {
    expect(() =>
      User.create({
        email: '',
        displayName: 'Alice',
        passwordHash: '$2a$10$somehash',
      }),
    ).toThrow();
  });

  it('should throw Error for empty displayName', () => {
    expect(() =>
      User.create({
        email: 'alice@example.com',
        displayName: '',
        passwordHash: '$2a$10$somehash',
      }),
    ).toThrow();
  });

  it('should throw Error for empty passwordHash', () => {
    expect(() =>
      User.create({
        email: 'alice@example.com',
        displayName: 'Alice',
        passwordHash: '',
      }),
    ).toThrow();
  });

  it('should accept valid email with various formats', () => {
    const user1 = User.create({
      email: 'user@domain.com',
      displayName: 'User1',
      passwordHash: '$2a$10$somehash',
    });
    expect(user1.email).toBe('user@domain.com');

    const user2 = User.create({
      email: 'user.name@domain.co.uk',
      displayName: 'User2',
      passwordHash: '$2a$10$somehash',
    });
    expect(user2.email).toBe('user.name@domain.co.uk');
  });
});

// ---------------------------------------------------------------------------
// Phase 4: Email Validation Tests — CRITICAL
// ---------------------------------------------------------------------------
describe('User.validateEmail()', () => {
  it('should accept valid email "user@example.com"', () => {
    expect(() => User.validateEmail('user@example.com')).not.toThrow();
  });

  it('should accept valid email "user.name@domain.co.uk"', () => {
    expect(() => User.validateEmail('user.name@domain.co.uk')).not.toThrow();
  });

  it('should accept valid email "user+tag@domain.com"', () => {
    expect(() => User.validateEmail('user+tag@domain.com')).not.toThrow();
  });

  it('should trim whitespace and accept " user@domain.com "', () => {
    expect(() => User.validateEmail(' user@domain.com ')).not.toThrow();
  });

  it('should throw for "user@domain" (no TLD)', () => {
    expect(() => User.validateEmail('user@domain')).toThrow('Invalid email format');
  });

  it('should throw for "@domain.com" (no local part)', () => {
    expect(() => User.validateEmail('@domain.com')).toThrow('Invalid email format');
  });

  it('should throw for "user@" (no domain)', () => {
    expect(() => User.validateEmail('user@')).toThrow('Invalid email format');
  });

  it('should throw for empty string', () => {
    expect(() => User.validateEmail('')).toThrow('Invalid email format');
  });

  it('should throw for "user domain.com" (spaces, no @)', () => {
    expect(() => User.validateEmail('user domain.com')).toThrow('Invalid email format');
  });
});

// ---------------------------------------------------------------------------
// Phase 5: Password Validation Tests
// ---------------------------------------------------------------------------
describe('User.validatePassword()', () => {
  it('should return { isValid: true, errors: [] } for "Abcdefg1!"', () => {
    const result = User.validatePassword('Abcdefg1!');
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('should return isValid: false with error for "short" (< 8 chars)', () => {
    const result = User.validatePassword('short');
    expect(result.isValid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('8'))).toBe(true);
  });

  it('should return isValid: false with error for "abcdefgh" (no uppercase)', () => {
    const result = User.validatePassword('abcdefgh');
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('uppercase'))).toBe(true);
  });

  it('should return isValid: false with error for "ABCDEFGH" (no lowercase)', () => {
    const result = User.validatePassword('ABCDEFGH');
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('lowercase'))).toBe(true);
  });

  it('should return isValid: false with error for "Abcdefgh" (no digit)', () => {
    const result = User.validatePassword('Abcdefgh');
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('digit') || e.toLowerCase().includes('number'))).toBe(true);
  });

  it('should return isValid: false with error for "Abcdefg1" (no special character)', () => {
    const result = User.validatePassword('Abcdefg1');
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('special'))).toBe(true);
  });

  it('should return isValid: false with 3 errors for "abcdefgh" (no uppercase, no digit, no special)', () => {
    const result = User.validatePassword('abcdefgh');
    expect(result.isValid).toBe(false);
    // At least 3 errors: no uppercase, no digit, no special character
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('should return isValid: false with 4 errors for "abc" (too short, no uppercase, no digit, no special)', () => {
    const result = User.validatePassword('abc');
    expect(result.isValid).toBe(false);
    // At least 4 errors: too short, no uppercase, no digit, no special character
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Phase 6: Profile Update Tests
// ---------------------------------------------------------------------------
describe('updateProfile()', () => {
  it('should update displayName when provided', () => {
    const user = new User(validUserProps());
    user.updateProfile({ displayName: 'New Name' });

    expect(user.displayName).toBe('New Name');
  });

  it('should update avatar when provided', () => {
    const user = new User(validUserProps());
    user.updateProfile({ avatar: 'https://example.com/new-avatar.png' });

    expect(user.avatar).toBe('https://example.com/new-avatar.png');
  });

  it('should update about when provided', () => {
    const user = new User(validUserProps());
    user.updateProfile({ about: 'New about text' });

    expect(user.about).toBe('New about text');
  });

  it('should update phoneNumber when provided', () => {
    const user = new User(validUserProps());
    user.updateProfile({ phoneNumber: '+9876543210' });

    expect(user.phoneNumber).toBe('+9876543210');
  });

  it('should skip undefined fields (partial update) — only updates provided fields', () => {
    const user = new User(validUserProps());
    const originalAvatar = user.avatar;
    const originalAbout = user.about;

    user.updateProfile({ displayName: 'Changed Only Name' });

    expect(user.displayName).toBe('Changed Only Name');
    expect(user.avatar).toBe(originalAvatar);
    expect(user.about).toBe(originalAbout);
  });

  it('should update updatedAt timestamp after profile update', () => {
    const props = validUserProps();
    const user = new User(props);
    const originalUpdatedAt = user.updatedAt;

    user.updateProfile({ displayName: 'Updated Name' });

    expect(user.updatedAt.getTime()).toBeGreaterThanOrEqual(originalUpdatedAt.getTime());
  });

  it('should throw for empty displayName', () => {
    const user = new User(validUserProps());

    expect(() => user.updateProfile({ displayName: '' })).toThrow();
  });

  it('should throw for displayName exceeding 100 characters', () => {
    const user = new User(validUserProps());
    const longName = 'A'.repeat(101);

    expect(() => user.updateProfile({ displayName: longName })).toThrow();
  });

  it('should throw for about exceeding 500 characters', () => {
    const user = new User(validUserProps());
    const longAbout = 'A'.repeat(501);

    expect(() => user.updateProfile({ about: longAbout })).toThrow();
  });

  it('should accept null avatar to remove it', () => {
    const user = new User(validUserProps());
    expect(user.avatar).toBeTruthy();

    user.updateProfile({ avatar: null as unknown as string | undefined });

    expect(user.avatar).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 7: Online/Offline State Transition Tests
// ---------------------------------------------------------------------------
describe('setOnline() / setOffline() / isOnline()', () => {
  it('should set status to UserStatus.ONLINE via setOnline()', () => {
    const user = new User(validUserProps());
    expect(user.status).toBe(UserStatus.OFFLINE);

    user.setOnline();

    expect(user.status).toBe(UserStatus.ONLINE);
  });

  it('should update updatedAt when setOnline() is called', () => {
    const user = new User(validUserProps());
    const originalUpdatedAt = user.updatedAt;

    user.setOnline();

    expect(user.updatedAt.getTime()).toBeGreaterThanOrEqual(originalUpdatedAt.getTime());
  });

  it('should return true for isOnline() after setOnline()', () => {
    const user = new User(validUserProps());
    user.setOnline();

    expect(user.isOnline()).toBe(true);
  });

  it('should set status to UserStatus.OFFLINE via setOffline()', () => {
    const user = new User(validUserProps());
    user.setOnline();
    expect(user.status).toBe(UserStatus.ONLINE);

    user.setOffline();

    expect(user.status).toBe(UserStatus.OFFLINE);
  });

  it('should set lastSeen to current time when setOffline() is called', () => {
    const user = new User(validUserProps());
    user.setOnline();

    const before = new Date();
    user.setOffline();
    const after = new Date();

    expect(user.lastSeen).toBeDefined();
    expect(user.lastSeen!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(user.lastSeen!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('should update updatedAt when setOffline() is called', () => {
    const user = new User(validUserProps());
    user.setOnline();
    const updatedAtAfterOnline = user.updatedAt;

    user.setOffline();

    expect(user.updatedAt.getTime()).toBeGreaterThanOrEqual(updatedAtAfterOnline.getTime());
  });

  it('should return false for isOnline() after setOffline()', () => {
    const user = new User(validUserProps());
    user.setOnline();
    user.setOffline();

    expect(user.isOnline()).toBe(false);
  });

  it('should NOT clear lastSeen when setOnline() is called (retains last offline time)', () => {
    const user = new User(validUserProps());
    const originalLastSeen = user.lastSeen;

    user.setOnline();

    // lastSeen should still exist from original props
    expect(user.lastSeen).toEqual(originalLastSeen);
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Serialization Tests — SECURITY CRITICAL (R23)
// ---------------------------------------------------------------------------
describe('toResponse()', () => {
  it('should return object with all expected fields', () => {
    const user = new User(validUserProps());
    const response = user.toResponse();

    expect(response).toHaveProperty('id', 'user-123');
    expect(response).toHaveProperty('email', 'test@example.com');
    expect(response).toHaveProperty('displayName', 'Test User');
    expect(response).toHaveProperty('avatar', 'https://example.com/avatar.png');
    expect(response).toHaveProperty('about', 'Hey there! I am using Kalle');
    expect(response).toHaveProperty('phoneNumber', '+1234567890');
    expect(response).toHaveProperty('status', UserStatus.OFFLINE);
    expect(response).toHaveProperty('lastSeen');
    expect(response).toHaveProperty('createdAt');
    expect(response).toHaveProperty('updatedAt');
  });

  it('CRITICAL — must verify passwordHash is NOT present in returned object (R23)', () => {
    const user = new User(validUserProps());
    const response = user.toResponse();

    // Direct property check
    expect(response).not.toHaveProperty('passwordHash');

    // Deep serialization check — ensure the hash value itself does not leak
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('hashedpassword');
    expect(serialized).not.toContain('$2a$10$');
  });

  it('should convert Date fields to ISO 8601 strings or Date objects', () => {
    const user = new User(validUserProps());
    const response = user.toResponse();

    // Dates in the response should be ISO strings or Date objects
    if (typeof response.createdAt === 'string') {
      expect(response.createdAt).toBe('2024-01-01T00:00:00.000Z');
    } else {
      expect(response.createdAt).toEqual(new Date('2024-01-01T00:00:00Z'));
    }

    if (typeof response.updatedAt === 'string') {
      expect(response.updatedAt).toBe('2024-01-01T00:00:00.000Z');
    } else {
      expect(response.updatedAt).toEqual(new Date('2024-01-01T00:00:00Z'));
    }
  });

  it('should handle undefined lastSeen (when user has never been offline)', () => {
    const props = validUserProps();
    props.lastSeen = undefined as unknown as Date;
    const user = new User(props);
    const response = user.toResponse();

    // lastSeen can be undefined or null when not set
    expect(
      response.lastSeen === undefined || response.lastSeen === null,
    ).toBe(true);
  });
});

describe('toSearchResult()', () => {
  it('should return only id, displayName, email, avatar, about, status', () => {
    const user = new User(validUserProps());
    const result = user.toSearchResult();

    expect(result).toHaveProperty('id', 'user-123');
    expect(result).toHaveProperty('displayName', 'Test User');
    expect(result).toHaveProperty('email', 'test@example.com');
    expect(result).toHaveProperty('avatar', 'https://example.com/avatar.png');
    expect(result).toHaveProperty('about', 'Hey there! I am using Kalle');
    expect(result).toHaveProperty('status', UserStatus.OFFLINE);
  });

  it('should NOT include passwordHash, phoneNumber, lastSeen, or timestamps', () => {
    const user = new User(validUserProps());
    const result = user.toSearchResult();

    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('phoneNumber');
    expect(result).not.toHaveProperty('lastSeen');
    expect(result).not.toHaveProperty('createdAt');
    expect(result).not.toHaveProperty('updatedAt');
  });
});

// ---------------------------------------------------------------------------
// Phase 9: Utility Method Tests
// ---------------------------------------------------------------------------
describe('matchesSearch()', () => {
  it('should return true when query matches displayName (case-insensitive)', () => {
    const user = new User(validUserProps());

    expect(user.matchesSearch('test user')).toBe(true);
    expect(user.matchesSearch('TEST USER')).toBe(true);
  });

  it('should return true when query matches email (case-insensitive)', () => {
    const user = new User(validUserProps());

    expect(user.matchesSearch('test@example')).toBe(true);
    expect(user.matchesSearch('TEST@EXAMPLE')).toBe(true);
  });

  it('should return false when query matches neither displayName nor email', () => {
    const user = new User(validUserProps());

    expect(user.matchesSearch('nonexistent')).toBe(false);
    expect(user.matchesSearch('zzz')).toBe(false);
  });

  it('should handle partial matches', () => {
    const user = new User(validUserProps());

    // "test" is a partial match for "Test User"
    expect(user.matchesSearch('test')).toBe(true);
    // "user" is a partial match for "Test User"
    expect(user.matchesSearch('user')).toBe(true);
    // "example" is a partial match for "test@example.com"
    expect(user.matchesSearch('example')).toBe(true);
  });
});

describe('getTimeSinceLastSeen()', () => {
  it('should return undefined when user is online (status ONLINE)', () => {
    const user = new User(validUserProps());
    user.setOnline();

    expect(user.getTimeSinceLastSeen()).toBeUndefined();
  });

  it('should return milliseconds since lastSeen when offline', () => {
    const props = validUserProps();
    props.lastSeen = new Date('2024-01-01T00:00:00Z');
    props.status = UserStatus.OFFLINE;
    const user = new User(props);

    const referenceTime = new Date('2024-01-01T01:00:00Z');
    const result = user.getTimeSinceLastSeen(referenceTime);

    // 1 hour = 3_600_000 milliseconds
    expect(result).toBe(3_600_000);
  });

  it('should return undefined when lastSeen is undefined', () => {
    const props = validUserProps();
    props.lastSeen = undefined as unknown as Date;
    props.status = UserStatus.OFFLINE;
    const user = new User(props);

    expect(user.getTimeSinceLastSeen()).toBeUndefined();
  });
});
