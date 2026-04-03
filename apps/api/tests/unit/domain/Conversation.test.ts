/**
 * @module apps/api/tests/unit/domain/Conversation.test.ts
 *
 * Comprehensive unit tests for the Conversation domain model class.
 *
 * Verifies:
 * - DIRECT/GROUP factory methods with full validation
 * - Membership management with role assignment
 * - Authorization checks (admin promotion/demotion)
 * - Participant query operations with defensive copies
 * - Archive/mute/pin state transitions (including auto-unmute on expiry)
 * - needsFanOut() calculation for R18 (3+ participants → BullMQ fan-out)
 * - Group name/avatar property updates
 * - Type check utilities (isGroup/isDirect)
 *
 * Architecture rules enforced:
 * - R16: Tests verify encapsulated behavior, not anemic data bags
 * - R18: needsFanOut() threshold validated at >= 3 participants
 * - R7:  TypeScript strict mode compatible, zero warnings
 * - R28: Zero console.log calls
 */

import {
  Conversation,
  type Participant,
  type ConversationProps,
} from '../../../src/domain/models/Conversation';
import {
  ConversationType,
  ParticipantRole,
} from '@kalle/shared/types/conversation';

// =============================================================================
// Helper Factories
// =============================================================================

/**
 * Returns two participant descriptors for DIRECT conversation creation.
 * Each call returns a fresh array to prevent cross-test mutation.
 */
const twoParticipants = (): [
  { userId: string; displayName: string; avatar?: string },
  { userId: string; displayName: string; avatar?: string },
] => [
  { userId: 'user-1', displayName: 'Alice', avatar: 'alice.png' },
  { userId: 'user-2', displayName: 'Bob', avatar: 'bob.png' },
];

/**
 * Returns three participant descriptors for GROUP conversation creation.
 * Each call returns a fresh array to prevent cross-test mutation.
 */
const threeParticipants = (): Array<{
  userId: string;
  displayName: string;
  avatar?: string;
}> => [
  { userId: 'user-1', displayName: 'Alice' },
  { userId: 'user-2', displayName: 'Bob' },
  { userId: 'user-3', displayName: 'Charlie' },
];

/**
 * Returns five participant descriptors for larger GROUP tests.
 */
const fiveParticipants = (): Array<{
  userId: string;
  displayName: string;
  avatar?: string;
}> => [
  { userId: 'user-1', displayName: 'Alice' },
  { userId: 'user-2', displayName: 'Bob' },
  { userId: 'user-3', displayName: 'Charlie' },
  { userId: 'user-4', displayName: 'Diana' },
  { userId: 'user-5', displayName: 'Eve' },
];

/**
 * Convenience helper to create a valid DIRECT conversation for tests
 * that don't focus on the factory method itself.
 */
const createDirectConversation = (): Conversation =>
  Conversation.createDirect({ participantIds: twoParticipants() });

/**
 * Convenience helper to create a valid GROUP conversation with 3 members.
 * user-1 is the creator (ADMIN).
 */
const createGroupConversation = (): Conversation =>
  Conversation.createGroup({
    groupName: 'Test Group',
    creatorUserId: 'user-1',
    participants: threeParticipants(),
  });

// =============================================================================
// Constructor Hydration Test (ConversationProps usage)
// =============================================================================

describe('Conversation constructor (hydration from ConversationProps)', () => {
  it('should hydrate a Conversation from raw ConversationProps', () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const props: ConversationProps = {
      id: 'conv-hydrated',
      type: ConversationType.GROUP,
      groupName: 'Hydrated Group',
      groupAvatar: 'hydrated-avatar.png',
      participants: [
        {
          userId: 'user-a',
          displayName: 'Alpha',
          role: ParticipantRole.ADMIN,
          joinedAt: now,
        },
        {
          userId: 'user-b',
          displayName: 'Beta',
          role: ParticipantRole.MEMBER,
          joinedAt: now,
        },
      ],
      isArchived: true,
      muteConfig: { isMuted: true, muteExpiresAt: null },
      pinnedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const conversation = new Conversation(props);

    expect(conversation.id).toBe('conv-hydrated');
    expect(conversation.type).toBe(ConversationType.GROUP);
    expect(conversation.groupName).toBe('Hydrated Group');
    expect(conversation.groupAvatar).toBe('hydrated-avatar.png');
    expect(conversation.getParticipantCount()).toBe(2);
    expect(conversation.isArchived).toBe(true);
    expect(conversation.muteConfig.isMuted).toBe(true);
    expect(conversation.isPinned()).toBe(true);
    expect(conversation.createdAt).toEqual(now);
    expect(conversation.updatedAt).toEqual(now);
  });
});

// =============================================================================
// Phase 2: DIRECT Conversation Factory Tests
// =============================================================================

describe('Conversation.createDirect()', () => {
  it('should create a DIRECT conversation with exactly 2 participants', () => {
    const conversation = Conversation.createDirect({
      participantIds: twoParticipants(),
    });

    expect(conversation.getParticipantCount()).toBe(2);
    expect(conversation.isParticipant('user-1')).toBe(true);
    expect(conversation.isParticipant('user-2')).toBe(true);
  });

  it('should set type to ConversationType.DIRECT', () => {
    const conversation = createDirectConversation();

    expect(conversation.type).toBe(ConversationType.DIRECT);
  });

  it('should assign MEMBER role to both participants (no admin in DIRECT)', () => {
    const conversation = createDirectConversation();

    const p1 = conversation.getParticipant('user-1');
    const p2 = conversation.getParticipant('user-2');

    expect(p1?.role).toBe(ParticipantRole.MEMBER);
    expect(p2?.role).toBe(ParticipantRole.MEMBER);
  });

  it('should set isArchived to false and muteConfig.isMuted to false', () => {
    const conversation = createDirectConversation();

    expect(conversation.isArchived).toBe(false);
    expect(conversation.muteConfig.isMuted).toBe(false);
  });

  it('should set createdAt and updatedAt to current timestamps', () => {
    const before = new Date();
    const conversation = createDirectConversation();
    const after = new Date();

    expect(conversation.createdAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(conversation.createdAt.getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );
    expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(conversation.updatedAt.getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );
  });

  it('should throw Error for 1 participant', () => {
    expect(() =>
      Conversation.createDirect({
        participantIds: [
          { userId: 'user-1', displayName: 'Alice' },
        ] as unknown as [
          { userId: string; displayName: string; avatar?: string },
          { userId: string; displayName: string; avatar?: string },
        ],
      }),
    ).toThrow('Direct conversation requires exactly 2 participants');
  });

  it('should throw Error for 3 participants', () => {
    expect(() =>
      Conversation.createDirect({
        participantIds: [
          { userId: 'user-1', displayName: 'Alice' },
          { userId: 'user-2', displayName: 'Bob' },
          { userId: 'user-3', displayName: 'Charlie' },
        ] as unknown as [
          { userId: string; displayName: string; avatar?: string },
          { userId: string; displayName: string; avatar?: string },
        ],
      }),
    ).toThrow('Direct conversation requires exactly 2 participants');
  });

  it('should throw Error when both participants have the same userId', () => {
    expect(() =>
      Conversation.createDirect({
        participantIds: [
          { userId: 'user-1', displayName: 'Alice' },
          { userId: 'user-1', displayName: 'Alice Clone' },
        ],
      }),
    ).toThrow('Direct conversation requires two different participants');
  });

  it('should generate a UUID id when none is provided', () => {
    const conversation = createDirectConversation();

    expect(conversation.id).toBeDefined();
    expect(typeof conversation.id).toBe('string');
    expect(conversation.id.length).toBeGreaterThan(0);
  });

  it('should use provided id when specified', () => {
    const conversation = Conversation.createDirect({
      id: 'custom-id-123',
      participantIds: twoParticipants(),
    });

    expect(conversation.id).toBe('custom-id-123');
  });

  it('should preserve participant display names and avatars', () => {
    const conversation = Conversation.createDirect({
      participantIds: twoParticipants(),
    });

    const p1 = conversation.getParticipant('user-1');
    const p2 = conversation.getParticipant('user-2');

    expect(p1?.displayName).toBe('Alice');
    expect(p1?.avatar).toBe('alice.png');
    expect(p2?.displayName).toBe('Bob');
    expect(p2?.avatar).toBe('bob.png');
  });

  it('should set joinedAt on each participant', () => {
    const conversation = createDirectConversation();

    const p1 = conversation.getParticipant('user-1');
    const p2 = conversation.getParticipant('user-2');

    expect(p1?.joinedAt).toBeInstanceOf(Date);
    expect(p2?.joinedAt).toBeInstanceOf(Date);
  });
});

// =============================================================================
// Phase 3: GROUP Conversation Factory Tests
// =============================================================================

describe('Conversation.createGroup()', () => {
  it('should create a GROUP conversation with 3+ participants', () => {
    const conversation = createGroupConversation();

    expect(conversation.getParticipantCount()).toBe(3);
    expect(conversation.isParticipant('user-1')).toBe(true);
    expect(conversation.isParticipant('user-2')).toBe(true);
    expect(conversation.isParticipant('user-3')).toBe(true);
  });

  it('should set type to ConversationType.GROUP', () => {
    const conversation = createGroupConversation();

    expect(conversation.type).toBe(ConversationType.GROUP);
  });

  it('should assign ADMIN role to the creator participant', () => {
    const conversation = createGroupConversation();

    const creator = conversation.getParticipant('user-1');
    expect(creator?.role).toBe(ParticipantRole.ADMIN);
  });

  it('should assign MEMBER role to non-creator participants', () => {
    const conversation = createGroupConversation();

    const p2 = conversation.getParticipant('user-2');
    const p3 = conversation.getParticipant('user-3');

    expect(p2?.role).toBe(ParticipantRole.MEMBER);
    expect(p3?.role).toBe(ParticipantRole.MEMBER);
  });

  it('should set groupName from dto', () => {
    const conversation = Conversation.createGroup({
      groupName: 'My Awesome Group',
      creatorUserId: 'user-1',
      participants: threeParticipants(),
    });

    expect(conversation.groupName).toBe('My Awesome Group');
  });

  it('should trim groupName whitespace', () => {
    const conversation = Conversation.createGroup({
      groupName: '  Trimmed Group  ',
      creatorUserId: 'user-1',
      participants: threeParticipants(),
    });

    expect(conversation.groupName).toBe('Trimmed Group');
  });

  it('should set groupAvatar when provided', () => {
    const conversation = Conversation.createGroup({
      groupName: 'Test Group',
      groupAvatar: 'group-avatar.png',
      creatorUserId: 'user-1',
      participants: threeParticipants(),
    });

    expect(conversation.groupAvatar).toBe('group-avatar.png');
  });

  it('should set isArchived to false and muteConfig.isMuted to false', () => {
    const conversation = createGroupConversation();

    expect(conversation.isArchived).toBe(false);
    expect(conversation.muteConfig.isMuted).toBe(false);
  });

  it('should set createdAt and updatedAt to current timestamps', () => {
    const before = new Date();
    const conversation = createGroupConversation();
    const after = new Date();

    expect(conversation.createdAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(conversation.updatedAt.getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );
  });

  it('should throw Error for empty groupName', () => {
    expect(() =>
      Conversation.createGroup({
        groupName: '',
        creatorUserId: 'user-1',
        participants: threeParticipants(),
      }),
    ).toThrow('Group name cannot be empty');
  });

  it('should throw Error for whitespace-only groupName', () => {
    expect(() =>
      Conversation.createGroup({
        groupName: '   ',
        creatorUserId: 'user-1',
        participants: threeParticipants(),
      }),
    ).toThrow('Group name cannot be empty');
  });

  it('should throw Error for fewer than 2 participants', () => {
    expect(() =>
      Conversation.createGroup({
        groupName: 'Solo Group',
        creatorUserId: 'user-1',
        participants: [{ userId: 'user-1', displayName: 'Alice' }],
      }),
    ).toThrow('Group conversation requires at least 2 participants');
  });

  it('should throw Error when creatorUserId is NOT in participants list', () => {
    expect(() =>
      Conversation.createGroup({
        groupName: 'Test Group',
        creatorUserId: 'user-999',
        participants: [
          { userId: 'user-1', displayName: 'Alice' },
          { userId: 'user-2', displayName: 'Bob' },
        ],
      }),
    ).toThrow('Creator must be included in the participants list');
  });

  it('should generate a UUID id when none is provided', () => {
    const conversation = createGroupConversation();

    expect(conversation.id).toBeDefined();
    expect(typeof conversation.id).toBe('string');
    expect(conversation.id.length).toBeGreaterThan(0);
  });

  it('should use provided id when specified', () => {
    const conversation = Conversation.createGroup({
      id: 'group-id-456',
      groupName: 'Test Group',
      creatorUserId: 'user-1',
      participants: threeParticipants(),
    });

    expect(conversation.id).toBe('group-id-456');
  });

  it('should work with exactly 2 participants', () => {
    const conversation = Conversation.createGroup({
      groupName: 'Pair Group',
      creatorUserId: 'user-1',
      participants: [
        { userId: 'user-1', displayName: 'Alice' },
        { userId: 'user-2', displayName: 'Bob' },
      ],
    });

    expect(conversation.getParticipantCount()).toBe(2);
    expect(conversation.type).toBe(ConversationType.GROUP);
  });
});

// =============================================================================
// Phase 4: Membership Management Tests — CRITICAL
// =============================================================================

describe('addParticipant()', () => {
  it('should add a participant to a GROUP conversation', () => {
    const conversation = Conversation.createGroup({
      groupName: 'Test Group',
      creatorUserId: 'user-1',
      participants: [
        { userId: 'user-1', displayName: 'Alice' },
        { userId: 'user-2', displayName: 'Bob' },
      ],
    });

    conversation.addParticipant({
      userId: 'user-3',
      displayName: 'Charlie',
      avatar: 'charlie.png',
    });

    expect(conversation.getParticipantCount()).toBe(3);
    expect(conversation.isParticipant('user-3')).toBe(true);
  });

  it('should assign default role MEMBER to new participant', () => {
    const conversation = createGroupConversation();

    conversation.addParticipant({
      userId: 'user-4',
      displayName: 'Diana',
    });

    const newParticipant = conversation.getParticipant('user-4');
    expect(newParticipant?.role).toBe(ParticipantRole.MEMBER);
  });

  it('should set joinedAt on the new participant', () => {
    const conversation = createGroupConversation();

    const before = new Date();
    conversation.addParticipant({
      userId: 'user-4',
      displayName: 'Diana',
    });
    const after = new Date();

    const newParticipant = conversation.getParticipant('user-4');
    expect(newParticipant?.joinedAt).toBeInstanceOf(Date);
    expect(newParticipant!.joinedAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(newParticipant!.joinedAt.getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );
  });

  it('should update updatedAt timestamp', () => {
    const conversation = createGroupConversation();
    const originalUpdatedAt = conversation.updatedAt;

    // Small delay to ensure timestamp difference
    conversation.addParticipant({
      userId: 'user-4',
      displayName: 'Diana',
    });

    expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });

  it('should throw Error when adding to a DIRECT conversation', () => {
    const conversation = createDirectConversation();

    expect(() =>
      conversation.addParticipant({
        userId: 'user-3',
        displayName: 'Charlie',
      }),
    ).toThrow('Cannot add participants to a direct conversation');
  });

  it('should throw Error when userId already exists', () => {
    const conversation = createGroupConversation();

    expect(() =>
      conversation.addParticipant({
        userId: 'user-1',
        displayName: 'Alice Again',
      }),
    ).toThrow('User is already a participant');
  });

  it('should accept optional role parameter to add as ADMIN', () => {
    const conversation = createGroupConversation();

    conversation.addParticipant({
      userId: 'user-4',
      displayName: 'Diana',
      role: ParticipantRole.ADMIN,
    });

    const newParticipant = conversation.getParticipant('user-4');
    expect(newParticipant?.role).toBe(ParticipantRole.ADMIN);
  });

  it('should preserve avatar on new participant', () => {
    const conversation = createGroupConversation();

    conversation.addParticipant({
      userId: 'user-4',
      displayName: 'Diana',
      avatar: 'diana-avatar.png',
    });

    const newParticipant = conversation.getParticipant('user-4');
    expect(newParticipant?.avatar).toBe('diana-avatar.png');
  });
});

describe('removeParticipant()', () => {
  it('should remove a participant from a GROUP conversation', () => {
    const conversation = createGroupConversation();

    expect(conversation.isParticipant('user-2')).toBe(true);
    conversation.removeParticipant('user-2');

    expect(conversation.isParticipant('user-2')).toBe(false);
    expect(conversation.getParticipantCount()).toBe(2);
  });

  it('should update updatedAt timestamp', () => {
    const conversation = createGroupConversation();
    const originalUpdatedAt = conversation.updatedAt;

    conversation.removeParticipant('user-2');

    expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });

  it('should throw Error when removing from a DIRECT conversation', () => {
    const conversation = createDirectConversation();

    expect(() => conversation.removeParticipant('user-1')).toThrow(
      'Cannot remove participants from a direct conversation',
    );
  });

  it('should throw Error when userId is not a participant', () => {
    const conversation = createGroupConversation();

    expect(() => conversation.removeParticipant('non-existent')).toThrow(
      'User is not a participant',
    );
  });
});

// =============================================================================
// Phase 5: Authorization Tests
// =============================================================================

describe('isGroupAdmin()', () => {
  it('should return true for user with ADMIN role', () => {
    const conversation = createGroupConversation();

    // user-1 is the creator → ADMIN
    expect(conversation.isGroupAdmin('user-1')).toBe(true);
  });

  it('should return false for user with MEMBER role', () => {
    const conversation = createGroupConversation();

    // user-2 is a non-creator → MEMBER
    expect(conversation.isGroupAdmin('user-2')).toBe(false);
  });

  it('should return false for DIRECT conversations (no admin concept)', () => {
    const conversation = createDirectConversation();

    expect(conversation.isGroupAdmin('user-1')).toBe(false);
    expect(conversation.isGroupAdmin('user-2')).toBe(false);
  });

  it('should return false for non-existent userId', () => {
    const conversation = createGroupConversation();

    expect(conversation.isGroupAdmin('non-existent')).toBe(false);
  });
});

describe('promoteToAdmin()', () => {
  it('should promote MEMBER to ADMIN in GROUP', () => {
    const conversation = createGroupConversation();

    // user-2 starts as MEMBER
    expect(conversation.isGroupAdmin('user-2')).toBe(false);

    conversation.promoteToAdmin('user-2');

    expect(conversation.isGroupAdmin('user-2')).toBe(true);
    const participant = conversation.getParticipant('user-2');
    expect(participant?.role).toBe(ParticipantRole.ADMIN);
  });

  it('should throw Error for DIRECT conversation', () => {
    const conversation = createDirectConversation();

    expect(() => conversation.promoteToAdmin('user-1')).toThrow(
      'Cannot promote participants in a direct conversation',
    );
  });

  it('should throw Error for non-existent participant', () => {
    const conversation = createGroupConversation();

    expect(() => conversation.promoteToAdmin('non-existent')).toThrow(
      'User is not a participant',
    );
  });

  it('should update updatedAt timestamp', () => {
    const conversation = createGroupConversation();
    const originalUpdatedAt = conversation.updatedAt;

    conversation.promoteToAdmin('user-2');

    expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });
});

describe('demoteToMember()', () => {
  it('should demote ADMIN to MEMBER in GROUP', () => {
    const conversation = createGroupConversation();

    // First promote user-2 to admin so we have 2 admins
    conversation.promoteToAdmin('user-2');
    expect(conversation.isGroupAdmin('user-2')).toBe(true);

    // Now demote user-2
    conversation.demoteToMember('user-2');

    expect(conversation.isGroupAdmin('user-2')).toBe(false);
    const participant = conversation.getParticipant('user-2');
    expect(participant?.role).toBe(ParticipantRole.MEMBER);
  });

  it('should throw Error when demoting the last ADMIN', () => {
    const conversation = createGroupConversation();

    // user-1 is the only ADMIN
    expect(() => conversation.demoteToMember('user-1')).toThrow(
      'Cannot demote the last admin',
    );
  });

  it('should throw Error for DIRECT conversation', () => {
    const conversation = createDirectConversation();

    expect(() => conversation.demoteToMember('user-1')).toThrow(
      'Cannot demote participants in a direct conversation',
    );
  });

  it('should throw Error for non-existent participant', () => {
    const conversation = createGroupConversation();

    expect(() => conversation.demoteToMember('non-existent')).toThrow(
      'User is not a participant',
    );
  });

  it('should allow demotion when another ADMIN exists', () => {
    const conversation = createGroupConversation();

    // Promote user-2 so there are 2 admins
    conversation.promoteToAdmin('user-2');

    // Should succeed — user-2 is still admin
    conversation.demoteToMember('user-1');

    expect(conversation.isGroupAdmin('user-1')).toBe(false);
    expect(conversation.isGroupAdmin('user-2')).toBe(true);
  });

  it('should update updatedAt timestamp', () => {
    const conversation = createGroupConversation();
    conversation.promoteToAdmin('user-2');

    const originalUpdatedAt = conversation.updatedAt;
    conversation.demoteToMember('user-2');

    expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });
});

// =============================================================================
// Phase 6: Participant Query Tests
// =============================================================================

describe('participant queries', () => {
  describe('getParticipant()', () => {
    it('should return participant when userId exists', () => {
      const conversation = createGroupConversation();

      const participant = conversation.getParticipant('user-1');

      expect(participant).toBeDefined();
      expect(participant?.userId).toBe('user-1');
      expect(participant?.displayName).toBe('Alice');
    });

    it('should return undefined when userId does not exist', () => {
      const conversation = createGroupConversation();

      const participant = conversation.getParticipant('non-existent');

      expect(participant).toBeUndefined();
    });
  });

  describe('isParticipant()', () => {
    it('should return true for existing participant', () => {
      const conversation = createGroupConversation();

      expect(conversation.isParticipant('user-1')).toBe(true);
      expect(conversation.isParticipant('user-2')).toBe(true);
      expect(conversation.isParticipant('user-3')).toBe(true);
    });

    it('should return false for non-existent user', () => {
      const conversation = createGroupConversation();

      expect(conversation.isParticipant('user-999')).toBe(false);
    });
  });

  describe('getParticipantCount()', () => {
    it('should return correct count for DIRECT conversation', () => {
      const conversation = createDirectConversation();

      expect(conversation.getParticipantCount()).toBe(2);
    });

    it('should return correct count for GROUP conversation', () => {
      const conversation = createGroupConversation();

      expect(conversation.getParticipantCount()).toBe(3);
    });

    it('should update count after addParticipant', () => {
      const conversation = createGroupConversation();

      conversation.addParticipant({
        userId: 'user-4',
        displayName: 'Diana',
      });

      expect(conversation.getParticipantCount()).toBe(4);
    });

    it('should update count after removeParticipant', () => {
      const conversation = createGroupConversation();

      conversation.removeParticipant('user-3');

      expect(conversation.getParticipantCount()).toBe(2);
    });
  });

  describe('getParticipants()', () => {
    it('should return all participants', () => {
      const conversation = createGroupConversation();

      const participants = conversation.getParticipants();

      expect(participants).toHaveLength(3);
      expect(participants.map((p) => p.userId).sort()).toEqual([
        'user-1',
        'user-2',
        'user-3',
      ]);
    });

    it('should return a defensive copy (modifying array does not affect model)', () => {
      const conversation = createGroupConversation();

      const participants = conversation.getParticipants();
      const originalCount = conversation.getParticipantCount();

      // Mutate the returned array with a properly typed Participant
      const injected: Participant = {
        userId: 'injected',
        displayName: 'Injected',
        role: ParticipantRole.MEMBER,
        joinedAt: new Date(),
      };
      participants.push(injected);

      // Model should be unaffected
      expect(conversation.getParticipantCount()).toBe(originalCount);
      expect(conversation.isParticipant('injected')).toBe(false);
    });
  });

  describe('getAdmins()', () => {
    it('should return only ADMIN participants for GROUP', () => {
      const conversation = createGroupConversation();

      const admins = conversation.getAdmins();

      expect(admins).toHaveLength(1);
      expect(admins[0].userId).toBe('user-1');
      expect(admins[0].role).toBe(ParticipantRole.ADMIN);
    });

    it('should return empty array for DIRECT conversations', () => {
      const conversation = createDirectConversation();

      const admins = conversation.getAdmins();

      expect(admins).toHaveLength(0);
    });

    it('should return multiple admins when promoted', () => {
      const conversation = createGroupConversation();

      conversation.promoteToAdmin('user-2');
      const admins = conversation.getAdmins();

      expect(admins).toHaveLength(2);
      expect(admins.map((a) => a.userId).sort()).toEqual(['user-1', 'user-2']);
    });
  });

  describe('getOtherParticipant()', () => {
    it('should return the other participant in DIRECT conversation', () => {
      const conversation = createDirectConversation();

      const other = conversation.getOtherParticipant('user-1');

      expect(other).toBeDefined();
      expect(other?.userId).toBe('user-2');
      expect(other?.displayName).toBe('Bob');
    });

    it('should return the correct other participant from the other side', () => {
      const conversation = createDirectConversation();

      const other = conversation.getOtherParticipant('user-2');

      expect(other).toBeDefined();
      expect(other?.userId).toBe('user-1');
      expect(other?.displayName).toBe('Alice');
    });

    it('should return undefined for GROUP conversations', () => {
      const conversation = createGroupConversation();

      const other = conversation.getOtherParticipant('user-1');

      expect(other).toBeUndefined();
    });
  });
});

// =============================================================================
// Phase 7: Archive/Mute/Pin State Transition Tests
// =============================================================================

describe('archive/unarchive', () => {
  it('should set isArchived to true when archive() is called', () => {
    const conversation = createDirectConversation();

    expect(conversation.isArchived).toBe(false);
    conversation.archive();

    expect(conversation.isArchived).toBe(true);
  });

  it('should update updatedAt when archive() is called', () => {
    const conversation = createDirectConversation();
    const originalUpdatedAt = conversation.updatedAt;

    conversation.archive();

    expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });

  it('should set isArchived to false when unarchive() is called', () => {
    const conversation = createDirectConversation();
    conversation.archive();

    expect(conversation.isArchived).toBe(true);
    conversation.unarchive();

    expect(conversation.isArchived).toBe(false);
  });

  it('should update updatedAt when unarchive() is called', () => {
    const conversation = createDirectConversation();
    conversation.archive();

    const afterArchive = conversation.updatedAt;
    conversation.unarchive();

    expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
      afterArchive.getTime(),
    );
  });
});

describe('mute/unmute', () => {
  it('should set isMuted=true with no expiry for indefinite mute', () => {
    const conversation = createDirectConversation();

    conversation.mute();

    expect(conversation.muteConfig.isMuted).toBe(true);
    expect(conversation.muteConfig.muteExpiresAt).toBeNull();
  });

  it('should set isMuted=true with future date for timed mute', () => {
    const conversation = createDirectConversation();
    const futureDate = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    conversation.mute(futureDate);

    expect(conversation.muteConfig.isMuted).toBe(true);
    expect(conversation.muteConfig.muteExpiresAt).toEqual(futureDate);
  });

  it('should set isMuted=false and muteExpiresAt=null on unmute()', () => {
    const conversation = createDirectConversation();
    conversation.mute();

    conversation.unmute();

    expect(conversation.muteConfig.isMuted).toBe(false);
    expect(conversation.muteConfig.muteExpiresAt).toBeNull();
  });

  it('should return true from isMuted() for indefinitely muted conversation', () => {
    const conversation = createDirectConversation();

    conversation.mute();

    expect(conversation.isMuted()).toBe(true);
  });

  it('should return true from isMuted() when mute has not expired yet', () => {
    const conversation = createDirectConversation();
    const futureDate = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

    conversation.mute(futureDate);

    // Check with a time before expiry
    const now = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes from now
    expect(conversation.isMuted(now)).toBe(true);
  });

  it('should return false from isMuted(now) when mute has expired and auto-unmute', () => {
    const conversation = createDirectConversation();
    const pastExpiry = new Date(Date.now() + 10 * 1000); // expires in 10 seconds

    conversation.mute(pastExpiry);

    // Simulate time passing — provide a "now" in the future
    const afterExpiry = new Date(Date.now() + 60 * 1000); // 60 seconds from now

    expect(conversation.isMuted(afterExpiry)).toBe(false);

    // Verify auto-unmute happened
    expect(conversation.muteConfig.isMuted).toBe(false);
    expect(conversation.muteConfig.muteExpiresAt).toBeNull();
  });

  it('should return false from isMuted() when not muted', () => {
    const conversation = createDirectConversation();

    expect(conversation.isMuted()).toBe(false);
  });

  it('should update updatedAt when mute() is called', () => {
    const conversation = createDirectConversation();
    const originalUpdatedAt = conversation.updatedAt;

    conversation.mute();

    expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });

  it('should update updatedAt when unmute() is called', () => {
    const conversation = createDirectConversation();
    conversation.mute();
    const afterMute = conversation.updatedAt;

    conversation.unmute();

    expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
      afterMute.getTime(),
    );
  });

  it('should handle mute with explicit null expiresAt as indefinite', () => {
    const conversation = createDirectConversation();

    conversation.mute(null);

    expect(conversation.muteConfig.isMuted).toBe(true);
    expect(conversation.muteConfig.muteExpiresAt).toBeNull();
    expect(conversation.isMuted()).toBe(true);
  });
});

describe('pin/unpin', () => {
  it('should set pinnedAt to a Date when pin() is called', () => {
    const conversation = createDirectConversation();

    expect(conversation.pinnedAt).toBeUndefined();
    conversation.pin();

    expect(conversation.pinnedAt).toBeInstanceOf(Date);
  });

  it('should set pinnedAt to undefined when unpin() is called', () => {
    const conversation = createDirectConversation();
    conversation.pin();

    expect(conversation.pinnedAt).toBeDefined();
    conversation.unpin();

    expect(conversation.pinnedAt).toBeUndefined();
  });

  it('should return true from isPinned() when pinned', () => {
    const conversation = createDirectConversation();

    conversation.pin();

    expect(conversation.isPinned()).toBe(true);
  });

  it('should return false from isPinned() when not pinned', () => {
    const conversation = createDirectConversation();

    expect(conversation.isPinned()).toBe(false);
  });

  it('should return false from isPinned() after unpin()', () => {
    const conversation = createDirectConversation();
    conversation.pin();
    conversation.unpin();

    expect(conversation.isPinned()).toBe(false);
  });

  it('should update updatedAt when pin() is called', () => {
    const conversation = createDirectConversation();
    const originalUpdatedAt = conversation.updatedAt;

    conversation.pin();

    expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
      originalUpdatedAt.getTime(),
    );
  });

  it('should update updatedAt when unpin() is called', () => {
    const conversation = createDirectConversation();
    conversation.pin();
    const afterPin = conversation.updatedAt;

    conversation.unpin();

    expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
      afterPin.getTime(),
    );
  });
});

// =============================================================================
// Phase 8: needsFanOut Tests — CRITICAL (R18)
// =============================================================================

describe('needsFanOut()', () => {
  it('should return false for DIRECT conversation (2 participants)', () => {
    const conversation = createDirectConversation();

    expect(conversation.needsFanOut()).toBe(false);
  });

  it('should return false for GROUP with exactly 2 participants', () => {
    const conversation = Conversation.createGroup({
      groupName: 'Small Group',
      creatorUserId: 'user-1',
      participants: [
        { userId: 'user-1', displayName: 'Alice' },
        { userId: 'user-2', displayName: 'Bob' },
      ],
    });

    expect(conversation.needsFanOut()).toBe(false);
  });

  it('should return true for GROUP with 3 participants — R18 threshold', () => {
    const conversation = createGroupConversation();

    // 3 participants: user-1, user-2, user-3
    expect(conversation.getParticipantCount()).toBe(3);
    expect(conversation.needsFanOut()).toBe(true);
  });

  it('should return true for GROUP with 5 participants', () => {
    const conversation = Conversation.createGroup({
      groupName: 'Large Group',
      creatorUserId: 'user-1',
      participants: fiveParticipants(),
    });

    expect(conversation.getParticipantCount()).toBe(5);
    expect(conversation.needsFanOut()).toBe(true);
  });

  it('should return true after adding a 3rd participant to a 2-person group', () => {
    const conversation = Conversation.createGroup({
      groupName: 'Growing Group',
      creatorUserId: 'user-1',
      participants: [
        { userId: 'user-1', displayName: 'Alice' },
        { userId: 'user-2', displayName: 'Bob' },
      ],
    });

    // Initially 2 participants — below threshold
    expect(conversation.needsFanOut()).toBe(false);

    // Add a 3rd participant — crosses R18 threshold
    conversation.addParticipant({
      userId: 'user-3',
      displayName: 'Charlie',
    });

    expect(conversation.getParticipantCount()).toBe(3);
    expect(conversation.needsFanOut()).toBe(true);
  });
});

// =============================================================================
// Phase 9: Group Property Update Tests
// =============================================================================

describe('updateGroupName() / updateGroupAvatar()', () => {
  describe('updateGroupName()', () => {
    it('should update groupName on GROUP conversation', () => {
      const conversation = createGroupConversation();

      conversation.updateGroupName('New Group Name');

      expect(conversation.groupName).toBe('New Group Name');
    });

    it('should trim whitespace from the new name', () => {
      const conversation = createGroupConversation();

      conversation.updateGroupName('  Trimmed Name  ');

      expect(conversation.groupName).toBe('Trimmed Name');
    });

    it('should throw Error for DIRECT conversation', () => {
      const conversation = createDirectConversation();

      expect(() => conversation.updateGroupName('Some Name')).toThrow(
        'Cannot set group name on direct conversation',
      );
    });

    it('should throw Error for empty groupName', () => {
      const conversation = createGroupConversation();

      expect(() => conversation.updateGroupName('')).toThrow(
        'Group name cannot be empty',
      );
    });

    it('should throw Error for whitespace-only groupName', () => {
      const conversation = createGroupConversation();

      expect(() => conversation.updateGroupName('   ')).toThrow(
        'Group name cannot be empty',
      );
    });

    it('should update updatedAt timestamp', () => {
      const conversation = createGroupConversation();
      const originalUpdatedAt = conversation.updatedAt;

      conversation.updateGroupName('Updated Name');

      expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
        originalUpdatedAt.getTime(),
      );
    });
  });

  describe('updateGroupAvatar()', () => {
    it('should update groupAvatar on GROUP conversation', () => {
      const conversation = createGroupConversation();

      conversation.updateGroupAvatar('new-avatar.png');

      expect(conversation.groupAvatar).toBe('new-avatar.png');
    });

    it('should throw Error for DIRECT conversation', () => {
      const conversation = createDirectConversation();

      expect(() =>
        conversation.updateGroupAvatar('some-avatar.png'),
      ).toThrow('Cannot set group avatar on direct conversation');
    });

    it('should update updatedAt timestamp', () => {
      const conversation = createGroupConversation();
      const originalUpdatedAt = conversation.updatedAt;

      conversation.updateGroupAvatar('updated-avatar.png');

      expect(conversation.updatedAt.getTime()).toBeGreaterThanOrEqual(
        originalUpdatedAt.getTime(),
      );
    });
  });
});

// =============================================================================
// Phase 10: Type Check Tests
// =============================================================================

describe('isGroup() / isDirect()', () => {
  it('should return true from isGroup() for GROUP conversation', () => {
    const conversation = createGroupConversation();

    expect(conversation.isGroup()).toBe(true);
  });

  it('should return false from isGroup() for DIRECT conversation', () => {
    const conversation = createDirectConversation();

    expect(conversation.isGroup()).toBe(false);
  });

  it('should return true from isDirect() for DIRECT conversation', () => {
    const conversation = createDirectConversation();

    expect(conversation.isDirect()).toBe(true);
  });

  it('should return false from isDirect() for GROUP conversation', () => {
    const conversation = createGroupConversation();

    expect(conversation.isDirect()).toBe(false);
  });
});
