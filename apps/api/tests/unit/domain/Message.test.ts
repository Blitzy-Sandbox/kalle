/**
 * @module Message Domain Model Unit Tests
 *
 * Comprehensive unit tests for the Message domain model class.
 * Tests validate behavior (not anemic data access) following OOD principles (R16).
 *
 * Key rules under test:
 * - R19: Message edit integrity — sender-only, 15-minute window, ciphertext swap
 * - R20: Message delete as tombstone — ciphertext nulled, row retained
 * - R12: E2E encryption — server stores only ciphertext strings
 * - R7:  Zero warnings build — TypeScript strict mode compatible
 * - R28: Structured logging — zero console.log calls
 *
 * All test ciphertext values use "encrypted-" prefix to clearly indicate
 * they are not plaintext, aligning with server-side ciphertext-only storage (R12).
 */

import { Message, MessageProps } from '../../../src/domain/models/Message';
import { MessageType, MessageStatusEnum, TTL } from '@kalle/shared';

// =============================================================================
// Test Helper Factory
// =============================================================================

/**
 * Returns a complete, valid MessageProps object with deterministic dates.
 * Supports partial overrides for targeted test scenarios.
 *
 * Fixed base timestamp: 2024-07-26T10:00:00Z
 * All ciphertext values use "encrypted-" prefix (R12 compliance).
 */
const validMessageProps = (overrides?: Partial<MessageProps>): MessageProps => ({
  id: 'msg-123',
  conversationId: 'conv-456',
  senderId: 'user-789',
  senderName: 'Alice',
  senderAvatar: 'alice.png',
  ciphertext: 'encrypted-base64-content',
  type: MessageType.TEXT,
  replyToMessageId: undefined,
  mediaId: undefined,
  linkPreview: undefined,
  isEdited: false,
  isDeleted: false,
  editedAt: undefined,
  deletedAt: undefined,
  clientMessageId: 'client-msg-001',
  serverTimestamp: new Date('2024-07-26T10:00:00Z'),
  createdAt: new Date('2024-07-26T10:00:00Z'),
  updatedAt: new Date('2024-07-26T10:00:00Z'),
  ...overrides,
});

// =============================================================================
// Phase 2: Construction Tests
// =============================================================================

describe('Message construction', () => {
  it('should construct with valid props and expose all getters correctly', () => {
    const props = validMessageProps();
    const message = new Message(props);

    expect(message.id).toBe('msg-123');
    expect(message.conversationId).toBe('conv-456');
    expect(message.senderId).toBe('user-789');
    expect(message.senderName).toBe('Alice');
    expect(message.senderAvatar).toBe('alice.png');
    expect(message.ciphertext).toBe('encrypted-base64-content');
    expect(message.type).toBe(MessageType.TEXT);
    expect(message.replyToMessageId).toBeUndefined();
    expect(message.mediaId).toBeUndefined();
    expect(message.linkPreview).toBeUndefined();
    expect(message.isEdited).toBe(false);
    expect(message.isDeleted).toBe(false);
    expect(message.editedAt).toBeUndefined();
    expect(message.deletedAt).toBeUndefined();
    expect(message.clientMessageId).toBe('client-msg-001');
    expect(message.serverTimestamp).toEqual(new Date('2024-07-26T10:00:00Z'));
    expect(message.createdAt).toEqual(new Date('2024-07-26T10:00:00Z'));
    expect(message.updatedAt).toEqual(new Date('2024-07-26T10:00:00Z'));
  });

  it('should return the encrypted ciphertext string from the getter', () => {
    const props = validMessageProps({ ciphertext: 'encrypted-signal-protocol-payload' });
    const message = new Message(props);

    expect(message.ciphertext).toBe('encrypted-signal-protocol-payload');
    expect(typeof message.ciphertext).toBe('string');
  });

  it('should handle optional senderAvatar as undefined', () => {
    const props = validMessageProps({ senderAvatar: undefined });
    const message = new Message(props);

    expect(message.senderAvatar).toBeUndefined();
  });

  it('should handle null ciphertext for pre-existing tombstone records', () => {
    const props = validMessageProps({
      ciphertext: null,
      isDeleted: true,
      deletedAt: new Date('2024-07-26T11:00:00Z'),
    });
    const message = new Message(props);

    expect(message.ciphertext).toBeNull();
    expect(message.isDeleted).toBe(true);
  });
});

// =============================================================================
// Phase 2: Static Factory Method Tests
// =============================================================================

describe('Message.create()', () => {
  it('should create a message with valid DTO — sets isEdited=false, isDeleted=false, serverTimestamp to now', () => {
    const beforeCreate = new Date();
    const message = Message.create({
      conversationId: 'conv-100',
      senderId: 'user-200',
      senderName: 'Bob',
      senderAvatar: 'bob.png',
      ciphertext: 'encrypted-hello-world',
      type: MessageType.TEXT,
      clientMessageId: 'client-msg-new',
    });
    const afterCreate = new Date();

    expect(message.id).toBeDefined();
    expect(typeof message.id).toBe('string');
    expect(message.id.length).toBeGreaterThan(0);
    expect(message.conversationId).toBe('conv-100');
    expect(message.senderId).toBe('user-200');
    expect(message.senderName).toBe('Bob');
    expect(message.ciphertext).toBe('encrypted-hello-world');
    expect(message.type).toBe(MessageType.TEXT);
    expect(message.isEdited).toBe(false);
    expect(message.isDeleted).toBe(false);
    expect(message.editedAt).toBeUndefined();
    expect(message.deletedAt).toBeUndefined();
    expect(message.clientMessageId).toBe('client-msg-new');

    // serverTimestamp should be within the creation time window
    expect(message.serverTimestamp.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
    expect(message.serverTimestamp.getTime()).toBeLessThanOrEqual(afterCreate.getTime());
    expect(message.createdAt.getTime()).toBe(message.serverTimestamp.getTime());
    expect(message.updatedAt.getTime()).toBe(message.serverTimestamp.getTime());
  });

  it('should throw Error for empty ciphertext', () => {
    expect(() =>
      Message.create({
        conversationId: 'conv-100',
        senderId: 'user-200',
        senderName: 'Bob',
        ciphertext: '',
        type: MessageType.TEXT,
        clientMessageId: 'client-msg-002',
      })
    ).toThrow('Message ciphertext must not be empty');
  });

  it('should throw Error for whitespace-only ciphertext', () => {
    expect(() =>
      Message.create({
        conversationId: 'conv-100',
        senderId: 'user-200',
        senderName: 'Bob',
        ciphertext: '   ',
        type: MessageType.TEXT,
        clientMessageId: 'client-msg-003',
      })
    ).toThrow('Message ciphertext must not be empty');
  });

  it('should throw Error for empty conversationId', () => {
    expect(() =>
      Message.create({
        conversationId: '',
        senderId: 'user-200',
        senderName: 'Bob',
        ciphertext: 'encrypted-content',
        type: MessageType.TEXT,
        clientMessageId: 'client-msg-004',
      })
    ).toThrow('Message conversationId must not be empty');
  });

  it('should throw Error for empty senderId', () => {
    expect(() =>
      Message.create({
        conversationId: 'conv-100',
        senderId: '',
        senderName: 'Bob',
        ciphertext: 'encrypted-content',
        type: MessageType.TEXT,
        clientMessageId: 'client-msg-005',
      })
    ).toThrow('Message senderId must not be empty');
  });

  it('should throw Error for empty clientMessageId', () => {
    expect(() =>
      Message.create({
        conversationId: 'conv-100',
        senderId: 'user-200',
        senderName: 'Bob',
        ciphertext: 'encrypted-content',
        type: MessageType.TEXT,
        clientMessageId: '',
      })
    ).toThrow('Message clientMessageId must not be empty');
  });

  it('should create message with optional replyToMessageId and mediaId', () => {
    const message = Message.create({
      conversationId: 'conv-100',
      senderId: 'user-200',
      senderName: 'Bob',
      ciphertext: 'encrypted-reply-content',
      type: MessageType.TEXT,
      replyToMessageId: 'msg-original',
      mediaId: 'media-001',
      clientMessageId: 'client-msg-006',
    });

    expect(message.replyToMessageId).toBe('msg-original');
    expect(message.mediaId).toBe('media-001');
  });
});

// =============================================================================
// Phase 3: canEdit() Tests — CRITICAL (R19: 15-Minute Window)
// =============================================================================

describe('canEdit()', () => {
  const baseTimestamp = new Date('2024-07-26T10:00:00Z');
  const senderId = 'user-789';

  it('should return true when userId matches senderId AND within 15 minutes of serverTimestamp', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    // 14 minutes elapsed = 840,000 ms
    const now = new Date(baseTimestamp.getTime() + 14 * 60 * 1000);

    expect(message.canEdit(senderId, now)).toBe(true);
  });

  it('should return true at exactly 15 minutes (900,000ms) — inclusive boundary (> not >=)', () => {
    // Implementation uses `elapsedMs > TTL.MESSAGE_EDIT_WINDOW_MS` (strictly greater than)
    // At exactly 900,000ms elapsed, 900000 > 900000 is false, so canEdit returns true
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now = new Date(baseTimestamp.getTime() + TTL.MESSAGE_EDIT_WINDOW_MS);

    expect(message.canEdit(senderId, now)).toBe(true);
  });

  it('should return true at 14 minutes 59 seconds (899,000ms)', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    // 14 minutes 59 seconds = 899,000 ms
    const now = new Date(baseTimestamp.getTime() + 899_000);

    expect(message.canEdit(senderId, now)).toBe(true);
  });

  it('should return false when 1ms past the 15-minute window (900,001ms)', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now = new Date(baseTimestamp.getTime() + TTL.MESSAGE_EDIT_WINDOW_MS + 1);

    expect(message.canEdit(senderId, now)).toBe(false);
  });

  it('should return false when 16 minutes have elapsed', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    // 16 minutes = 960,000 ms
    const now = new Date(baseTimestamp.getTime() + 16 * 60 * 1000);

    expect(message.canEdit(senderId, now)).toBe(false);
  });

  it('should return false when userId does NOT match senderId even within window', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now = new Date(baseTimestamp.getTime() + 5 * 60 * 1000); // 5 minutes

    expect(message.canEdit('different-user-999', now)).toBe(false);
  });

  it('should return false when message isDeleted is true', () => {
    const message = new Message(
      validMessageProps({
        serverTimestamp: baseTimestamp,
        isDeleted: true,
        deletedAt: new Date('2024-07-26T10:01:00Z'),
        ciphertext: null,
      })
    );
    const now = new Date(baseTimestamp.getTime() + 1 * 60 * 1000); // 1 minute

    expect(message.canEdit(senderId, now)).toBe(false);
  });

  it('should return false when ciphertext is null (tombstone state)', () => {
    const message = new Message(
      validMessageProps({
        serverTimestamp: baseTimestamp,
        ciphertext: null,
        isDeleted: true,
      })
    );
    const now = new Date(baseTimestamp.getTime() + 1 * 60 * 1000);

    expect(message.canEdit(senderId, now)).toBe(false);
  });

  it('should use injected now parameter for deterministic time calculation', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));

    // Inject a time well within the window
    const earlyNow = new Date(baseTimestamp.getTime() + 1_000);
    expect(message.canEdit(senderId, earlyNow)).toBe(true);

    // Inject a time well past the window
    const lateNow = new Date(baseTimestamp.getTime() + 2 * 60 * 60 * 1000); // 2 hours
    expect(message.canEdit(senderId, lateNow)).toBe(false);
  });

  it('should return true when called immediately after creation (0ms elapsed)', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now = new Date(baseTimestamp.getTime());

    expect(message.canEdit(senderId, now)).toBe(true);
  });
});

// =============================================================================
// Phase 4: edit() Tests — CRITICAL (R19: Ciphertext Swap)
// =============================================================================

describe('edit()', () => {
  const baseTimestamp = new Date('2024-07-26T10:00:00Z');
  const senderId = 'user-789';

  it('should replace ciphertext with newCiphertext when canEdit returns true', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now = new Date(baseTimestamp.getTime() + 5 * 60 * 1000); // 5 minutes

    message.edit('encrypted-new-content', senderId, now);

    expect(message.ciphertext).toBe('encrypted-new-content');
  });

  it('should set isEdited to true after successful edit', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now = new Date(baseTimestamp.getTime() + 5 * 60 * 1000);

    expect(message.isEdited).toBe(false);
    message.edit('encrypted-edited-content', senderId, now);
    expect(message.isEdited).toBe(true);
  });

  it('should set editedAt to the injected now time', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const editTime = new Date(baseTimestamp.getTime() + 5 * 60 * 1000);

    message.edit('encrypted-edited-content', senderId, editTime);

    expect(message.editedAt).toEqual(editTime);
  });

  it('should update updatedAt after successful edit', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const originalUpdatedAt = message.updatedAt;
    const editTime = new Date(baseTimestamp.getTime() + 5 * 60 * 1000);

    message.edit('encrypted-edited-content', senderId, editTime);

    expect(message.updatedAt).toEqual(editTime);
    expect(message.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
  });

  it('should NOT retain original ciphertext — only new ciphertext exists after edit (R19)', () => {
    const originalCiphertext = 'encrypted-original-content';
    const message = new Message(
      validMessageProps({ serverTimestamp: baseTimestamp, ciphertext: originalCiphertext })
    );
    const now = new Date(baseTimestamp.getTime() + 5 * 60 * 1000);

    message.edit('encrypted-replacement-content', senderId, now);

    expect(message.ciphertext).toBe('encrypted-replacement-content');
    expect(message.ciphertext).not.toBe(originalCiphertext);
  });

  it('should throw Error when userId does not match senderId (wrong user)', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now = new Date(baseTimestamp.getTime() + 5 * 60 * 1000);

    expect(() => message.edit('encrypted-new', 'wrong-user-999', now)).toThrow(
      'Only the message sender can edit this message'
    );
  });

  it('should throw Error when past 15-minute window', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    // 16 minutes past = well beyond the window
    const now = new Date(baseTimestamp.getTime() + 16 * 60 * 1000);

    expect(() => message.edit('encrypted-late-edit', senderId, now)).toThrow(
      'Message edit window has expired'
    );
  });

  it('should throw Error when message is already deleted', () => {
    const message = new Message(
      validMessageProps({
        serverTimestamp: baseTimestamp,
        isDeleted: true,
        deletedAt: new Date('2024-07-26T10:01:00Z'),
        ciphertext: null,
      })
    );
    const now = new Date(baseTimestamp.getTime() + 2 * 60 * 1000);

    expect(() => message.edit('encrypted-edit-attempt', senderId, now)).toThrow(
      'Cannot edit a deleted message'
    );
  });

  it('should throw Error for empty newCiphertext', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now = new Date(baseTimestamp.getTime() + 5 * 60 * 1000);

    expect(() => message.edit('', senderId, now)).toThrow(
      'New ciphertext must not be empty'
    );
  });

  it('should throw Error for whitespace-only newCiphertext', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now = new Date(baseTimestamp.getTime() + 5 * 60 * 1000);

    expect(() => message.edit('   ', senderId, now)).toThrow(
      'New ciphertext must not be empty'
    );
  });

  it('should allow multiple sequential edits within the window', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now1 = new Date(baseTimestamp.getTime() + 3 * 60 * 1000);
    const now2 = new Date(baseTimestamp.getTime() + 7 * 60 * 1000);

    message.edit('encrypted-edit-v1', senderId, now1);
    expect(message.ciphertext).toBe('encrypted-edit-v1');
    expect(message.isEdited).toBe(true);

    message.edit('encrypted-edit-v2', senderId, now2);
    expect(message.ciphertext).toBe('encrypted-edit-v2');
    expect(message.editedAt).toEqual(now2);
  });
});

// =============================================================================
// Phase 5: markDeleted() Tests — CRITICAL (R20: Tombstone)
// =============================================================================

describe('markDeleted()', () => {
  const senderId = 'user-789';

  it('should set ciphertext to null (R20: ciphertext nulled)', () => {
    const message = new Message(validMessageProps());

    message.markDeleted(senderId);

    expect(message.ciphertext).toBeNull();
  });

  it('should set isDeleted to true', () => {
    const message = new Message(validMessageProps());

    message.markDeleted(senderId);

    expect(message.isDeleted).toBe(true);
  });

  it('should set deletedAt to a Date instance', () => {
    const beforeDelete = new Date();
    const message = new Message(validMessageProps());

    message.markDeleted(senderId);

    expect(message.deletedAt).toBeInstanceOf(Date);
    expect(message.deletedAt!.getTime()).toBeGreaterThanOrEqual(beforeDelete.getTime());
  });

  it('should update updatedAt', () => {
    const message = new Message(validMessageProps());

    const beforeDelete = new Date();
    message.markDeleted(senderId);

    expect(message.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeDelete.getTime());
    // updatedAt should match deletedAt
    expect(message.updatedAt.getTime()).toBe(message.deletedAt!.getTime());
  });

  it('should throw Error when userId does not match senderId (sender-only deletion)', () => {
    const message = new Message(validMessageProps());

    expect(() => message.markDeleted('different-user-999')).toThrow(
      'Only the message sender can delete this message'
    );
  });

  it('should be idempotent — calling markDeleted twice does not throw and state is unchanged', () => {
    const message = new Message(validMessageProps());

    message.markDeleted(senderId);
    const firstDeletedAt = message.deletedAt;
    const firstUpdatedAt = message.updatedAt;

    // Second call should not throw
    expect(() => message.markDeleted(senderId)).not.toThrow();

    // State should remain from first deletion (idempotent)
    expect(message.ciphertext).toBeNull();
    expect(message.isDeleted).toBe(true);
    expect(message.deletedAt).toEqual(firstDeletedAt);
    expect(message.updatedAt).toEqual(firstUpdatedAt);
  });

  it('should make isTombstone() return true after markDeleted', () => {
    const message = new Message(validMessageProps());

    expect(message.isTombstone()).toBe(false);
    message.markDeleted(senderId);
    expect(message.isTombstone()).toBe(true);
  });

  it('should make canEdit() return false after markDeleted', () => {
    const message = new Message(
      validMessageProps({ serverTimestamp: new Date('2024-07-26T10:00:00Z') })
    );
    const now = new Date('2024-07-26T10:05:00Z'); // 5 minutes

    expect(message.canEdit(senderId, now)).toBe(true);
    message.markDeleted(senderId);
    expect(message.canEdit(senderId, now)).toBe(false);
  });
});

// =============================================================================
// Phase 6: Type Guard Tests
// =============================================================================

describe('type guards', () => {
  it('should return true from isText() for MessageType.TEXT and false for all others', () => {
    const message = new Message(validMessageProps({ type: MessageType.TEXT }));

    expect(message.isText()).toBe(true);
    expect(message.isImage()).toBe(false);
    expect(message.isVideo()).toBe(false);
    expect(message.isDocument()).toBe(false);
    expect(message.isVoiceNote()).toBe(false);
  });

  it('should return true from isImage() for MessageType.IMAGE', () => {
    const message = new Message(validMessageProps({ type: MessageType.IMAGE }));

    expect(message.isImage()).toBe(true);
    expect(message.isText()).toBe(false);
    expect(message.isVideo()).toBe(false);
    expect(message.isDocument()).toBe(false);
    expect(message.isVoiceNote()).toBe(false);
  });

  it('should return true from isVideo() for MessageType.VIDEO', () => {
    const message = new Message(validMessageProps({ type: MessageType.VIDEO }));

    expect(message.isVideo()).toBe(true);
    expect(message.isText()).toBe(false);
    expect(message.isImage()).toBe(false);
    expect(message.isDocument()).toBe(false);
    expect(message.isVoiceNote()).toBe(false);
  });

  it('should return true from isDocument() for MessageType.DOCUMENT', () => {
    const message = new Message(validMessageProps({ type: MessageType.DOCUMENT }));

    expect(message.isDocument()).toBe(true);
    expect(message.isText()).toBe(false);
    expect(message.isImage()).toBe(false);
    expect(message.isVideo()).toBe(false);
    expect(message.isVoiceNote()).toBe(false);
  });

  it('should return true from isVoiceNote() for MessageType.VOICE_NOTE', () => {
    const message = new Message(validMessageProps({ type: MessageType.VOICE_NOTE }));

    expect(message.isVoiceNote()).toBe(true);
    expect(message.isText()).toBe(false);
    expect(message.isImage()).toBe(false);
    expect(message.isVideo()).toBe(false);
    expect(message.isDocument()).toBe(false);
  });

  it('should ensure type guards are mutually exclusive across all MessageType values', () => {
    const types = [
      MessageType.TEXT,
      MessageType.IMAGE,
      MessageType.VIDEO,
      MessageType.DOCUMENT,
      MessageType.VOICE_NOTE,
    ];

    for (const messageType of types) {
      const message = new Message(validMessageProps({ type: messageType }));
      const guards = [
        message.isText(),
        message.isImage(),
        message.isVideo(),
        message.isDocument(),
        message.isVoiceNote(),
      ];
      // Exactly one guard should be true for each type
      const trueCount = guards.filter(Boolean).length;
      expect(trueCount).toBe(1);
    }
  });
});

// =============================================================================
// Phase 7: State Query Tests
// =============================================================================

describe('state queries', () => {
  describe('isTombstone()', () => {
    it('should return true only when isDeleted=true AND ciphertext=null', () => {
      const message = new Message(
        validMessageProps({ isDeleted: true, ciphertext: null })
      );

      expect(message.isTombstone()).toBe(true);
    });

    it('should return false for non-deleted message', () => {
      const message = new Message(validMessageProps());

      expect(message.isTombstone()).toBe(false);
    });

    it('should return false when isDeleted=true but ciphertext is still set', () => {
      // Edge case: isDeleted is true but ciphertext was not nulled (should not happen in practice)
      const message = new Message(
        validMessageProps({ isDeleted: true, ciphertext: 'encrypted-still-present' })
      );

      expect(message.isTombstone()).toBe(false);
    });

    it('should return false when ciphertext is null but isDeleted is false', () => {
      const message = new Message(
        validMessageProps({ isDeleted: false, ciphertext: null })
      );

      expect(message.isTombstone()).toBe(false);
    });
  });

  describe('hasMedia()', () => {
    it('should return true when mediaId is set', () => {
      const message = new Message(validMessageProps({ mediaId: 'media-001' }));

      expect(message.hasMedia()).toBe(true);
    });

    it('should return false when mediaId is undefined', () => {
      const message = new Message(validMessageProps({ mediaId: undefined }));

      expect(message.hasMedia()).toBe(false);
    });
  });

  describe('hasLinkPreview()', () => {
    it('should return true when linkPreview is set', () => {
      const message = new Message(
        validMessageProps({
          linkPreview: {
            url: 'https://example.com',
            title: 'Example',
            description: 'An example page',
          },
        })
      );

      expect(message.hasLinkPreview()).toBe(true);
    });

    it('should return false when linkPreview is undefined', () => {
      const message = new Message(validMessageProps({ linkPreview: undefined }));

      expect(message.hasLinkPreview()).toBe(false);
    });
  });

  describe('hasReply()', () => {
    it('should return true when replyToMessageId is set', () => {
      const message = new Message(
        validMessageProps({ replyToMessageId: 'msg-original' })
      );

      expect(message.hasReply()).toBe(true);
    });

    it('should return false when replyToMessageId is undefined', () => {
      const message = new Message(validMessageProps({ replyToMessageId: undefined }));

      expect(message.hasReply()).toBe(false);
    });
  });
});

// =============================================================================
// Phase 8: Serialization Tests
// =============================================================================

describe('toResponse()', () => {
  it('should return an object with all expected fields', () => {
    const message = new Message(validMessageProps());
    const response = message.toResponse();

    expect(response).toEqual(
      expect.objectContaining({
        id: 'msg-123',
        conversationId: 'conv-456',
        senderId: 'user-789',
        senderName: 'Alice',
        senderAvatar: 'alice.png',
        ciphertext: 'encrypted-base64-content',
        type: MessageType.TEXT,
        clientMessageId: 'client-msg-001',
        isEdited: false,
        isDeleted: false,
      })
    );
  });

  it('should convert Date fields to ISO 8601 strings', () => {
    const message = new Message(validMessageProps());
    const response = message.toResponse();

    expect(response.serverTimestamp).toBe('2024-07-26T10:00:00.000Z');
    expect(response.createdAt).toBe('2024-07-26T10:00:00.000Z');
    expect(response.updatedAt).toBe('2024-07-26T10:00:00.000Z');
    expect(typeof response.serverTimestamp).toBe('string');
    expect(typeof response.createdAt).toBe('string');
    expect(typeof response.updatedAt).toBe('string');
  });

  it('should include isEdited and isDeleted flags in response', () => {
    const editedMessage = new Message(
      validMessageProps({
        isEdited: true,
        editedAt: new Date('2024-07-26T10:05:00Z'),
      })
    );
    const response = editedMessage.toResponse();

    expect(response.isEdited).toBe(true);
    expect(response.isDeleted).toBe(false);
  });

  it('should have ciphertext as null for tombstone messages', () => {
    const tombstone = new Message(
      validMessageProps({
        isDeleted: true,
        ciphertext: null,
        deletedAt: new Date('2024-07-26T10:10:00Z'),
      })
    );
    const response = tombstone.toResponse();

    expect(response.ciphertext).toBeNull();
    expect(response.isDeleted).toBe(true);
  });

  it('should serialize editedAt and deletedAt as ISO strings when set, undefined when not', () => {
    // Case 1: editedAt and deletedAt not set
    const normalMessage = new Message(validMessageProps());
    const normalResponse = normalMessage.toResponse();

    expect(normalResponse.editedAt).toBeUndefined();
    expect(normalResponse.deletedAt).toBeUndefined();

    // Case 2: editedAt is set
    const editedMessage = new Message(
      validMessageProps({
        isEdited: true,
        editedAt: new Date('2024-07-26T10:05:00Z'),
      })
    );
    const editedResponse = editedMessage.toResponse();

    expect(editedResponse.editedAt).toBe('2024-07-26T10:05:00.000Z');
    expect(typeof editedResponse.editedAt).toBe('string');

    // Case 3: deletedAt is set
    const deletedMessage = new Message(
      validMessageProps({
        isDeleted: true,
        ciphertext: null,
        deletedAt: new Date('2024-07-26T10:10:00Z'),
      })
    );
    const deletedResponse = deletedMessage.toResponse();

    expect(deletedResponse.deletedAt).toBe('2024-07-26T10:10:00.000Z');
    expect(typeof deletedResponse.deletedAt).toBe('string');
  });

  it('should include status field from getStatus() — defaults to SENT for messages without recipient status', () => {
    const message = new Message(validMessageProps());
    const response = message.toResponse();

    expect(response.status).toBe(MessageStatusEnum.SENT);
  });

  it('should include optional fields (mediaId, linkPreview, replyTo) in response', () => {
    const message = new Message(
      validMessageProps({
        mediaId: 'media-099',
        linkPreview: {
          url: 'https://github.com',
          title: 'GitHub',
          description: 'Where the world builds software',
          siteName: 'GitHub',
        },
      })
    );
    const response = message.toResponse();

    expect(response.mediaId).toBe('media-099');
    expect(response.linkPreview).toEqual({
      url: 'https://github.com',
      title: 'GitHub',
      description: 'Where the world builds software',
      siteName: 'GitHub',
    });
  });
});

// =============================================================================
// Phase 9: Boundary and Edge Case Tests
// =============================================================================

describe('edge cases', () => {
  const baseTimestamp = new Date('2024-07-26T10:00:00Z');
  const senderId = 'user-789';

  it('should throw when edit() is called after markDeleted() (cannot edit tombstone)', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now = new Date(baseTimestamp.getTime() + 5 * 60 * 1000);

    message.markDeleted(senderId);

    expect(() => message.edit('encrypted-late-edit', senderId, now)).toThrow(
      'Cannot edit a deleted message'
    );
  });

  it('should return true from canEdit() with exactly TTL.MESSAGE_EDIT_WINDOW_MS elapsed (inclusive boundary)', () => {
    // The implementation uses `>` (strictly greater than), so at exactly 900,000ms
    // the comparison 900000 > 900000 = false, meaning canEdit returns true
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now = new Date(baseTimestamp.getTime() + TTL.MESSAGE_EDIT_WINDOW_MS);

    expect(TTL.MESSAGE_EDIT_WINDOW_MS).toBe(900_000);
    expect(message.canEdit(senderId, now)).toBe(true);
  });

  it('should return true from canEdit() with TTL.MESSAGE_EDIT_WINDOW_MS - 1 ms elapsed', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now = new Date(baseTimestamp.getTime() + TTL.MESSAGE_EDIT_WINDOW_MS - 1);

    expect(message.canEdit(senderId, now)).toBe(true);
  });

  it('should return false from canEdit() with TTL.MESSAGE_EDIT_WINDOW_MS + 1 ms elapsed', () => {
    const message = new Message(validMessageProps({ serverTimestamp: baseTimestamp }));
    const now = new Date(baseTimestamp.getTime() + TTL.MESSAGE_EDIT_WINDOW_MS + 1);

    expect(message.canEdit(senderId, now)).toBe(false);
  });

  it('should be idempotent when markDeleted() is called twice (no error, no state change)', () => {
    const message = new Message(validMessageProps());

    message.markDeleted(senderId);
    const stateAfterFirst = {
      ciphertext: message.ciphertext,
      isDeleted: message.isDeleted,
      deletedAt: message.deletedAt?.getTime(),
      updatedAt: message.updatedAt.getTime(),
    };

    message.markDeleted(senderId);
    const stateAfterSecond = {
      ciphertext: message.ciphertext,
      isDeleted: message.isDeleted,
      deletedAt: message.deletedAt?.getTime(),
      updatedAt: message.updatedAt.getTime(),
    };

    expect(stateAfterSecond).toEqual(stateAfterFirst);
  });

  it('should not throw when create() is called with MessageType.IMAGE (media messages valid)', () => {
    expect(() =>
      Message.create({
        conversationId: 'conv-100',
        senderId: 'user-200',
        senderName: 'Bob',
        ciphertext: 'encrypted-image-data',
        type: MessageType.IMAGE,
        mediaId: 'media-img-001',
        clientMessageId: 'client-msg-img-001',
      })
    ).not.toThrow();

    const message = Message.create({
      conversationId: 'conv-100',
      senderId: 'user-200',
      senderName: 'Bob',
      ciphertext: 'encrypted-image-data',
      type: MessageType.IMAGE,
      mediaId: 'media-img-001',
      clientMessageId: 'client-msg-img-001',
    });
    expect(message.type).toBe(MessageType.IMAGE);
    expect(message.isImage()).toBe(true);
  });

  it('should properly report hasReply() when replyToMessageId is set', () => {
    const message = new Message(
      validMessageProps({ replyToMessageId: 'msg-parent-001' })
    );

    expect(message.hasReply()).toBe(true);
    expect(message.replyToMessageId).toBe('msg-parent-001');
  });

  it('should not allow editing a message with a different user even when message is deleted', () => {
    const message = new Message(
      validMessageProps({
        serverTimestamp: baseTimestamp,
        isDeleted: true,
        ciphertext: null,
      })
    );
    const now = new Date(baseTimestamp.getTime() + 1 * 60 * 1000);

    // Should throw deleted error first (checked before senderId in the error cascade)
    expect(() => message.edit('encrypted-new', 'wrong-user', now)).toThrow();
  });

  it('should verify TTL.MESSAGE_EDIT_WINDOW_MS is exactly 900,000ms (15 minutes)', () => {
    // Ensures the shared constant matches the expected 15-minute window
    expect(TTL.MESSAGE_EDIT_WINDOW_MS).toBe(900_000);
    expect(TTL.MESSAGE_EDIT_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it('should create messages with all five MessageType values without throwing', () => {
    const allTypes = [
      MessageType.TEXT,
      MessageType.IMAGE,
      MessageType.VIDEO,
      MessageType.DOCUMENT,
      MessageType.VOICE_NOTE,
    ];

    for (const messageType of allTypes) {
      expect(() =>
        Message.create({
          conversationId: 'conv-100',
          senderId: 'user-200',
          senderName: 'Bob',
          ciphertext: 'encrypted-content-for-' + messageType,
          type: messageType,
          clientMessageId: 'client-msg-' + messageType,
        })
      ).not.toThrow();
    }
  });

  it('should handle message with all optional fields populated', () => {
    const fullMessage = new Message(
      validMessageProps({
        replyToMessageId: 'msg-parent',
        mediaId: 'media-full',
        linkPreview: {
          url: 'https://example.com',
          title: 'Full Test',
          description: 'All fields populated',
          imageUrl: 'https://example.com/image.png',
          siteName: 'Example',
        },
        isEdited: true,
        editedAt: new Date('2024-07-26T10:05:00Z'),
      })
    );

    expect(fullMessage.hasReply()).toBe(true);
    expect(fullMessage.hasMedia()).toBe(true);
    expect(fullMessage.hasLinkPreview()).toBe(true);
    expect(fullMessage.isEdited).toBe(true);

    const response = fullMessage.toResponse();
    expect(response.replyTo).toBeUndefined(); // replyTo is populated by service layer
    expect(response.mediaId).toBe('media-full');
    expect(response.linkPreview?.url).toBe('https://example.com');
    expect(response.editedAt).toBe('2024-07-26T10:05:00.000Z');
  });
});
