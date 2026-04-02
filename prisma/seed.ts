/* eslint-disable no-console -- Seed is a CLI script; console output is intentional */
// =============================================================================
// Kalle — WhatsApp Clone · Deterministic Idempotent Database Seed
// =============================================================================
//
// Populates PostgreSQL with realistic demo data including users, conversations,
// messages, encryption key bundles, stories, and media records.
//
// Critical Rules Enforced:
//   R10 — Idempotent: running twice produces identical logical state.
//   R5  — No mock data: all demo flows use live backend with persistent data.
//   R12 — Server stores only ciphertext; no plaintext message content.
//   R23 — Audit metadata does NOT contain passwords, tokens, or keys.
//   R32 — Audit log is INSERT-only (seed bypasses for cleanup).
//
// Usage:
//   npx tsx prisma/seed.ts
//   (also invoked via `npx prisma db seed`)
//
// =============================================================================

import {
  PrismaClient,
  ConversationType,
  ParticipantRole,
  MessageType,
  MessageDeliveryStatus,
  AuditAction,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// =============================================================================
// Global Instances and Constants
// =============================================================================

const prisma = new PrismaClient();

/** bcrypt hash cost factor for demo user passwords. */
const SALT_ROUNDS = 10;

/** Stable prefix for all deterministic generation, ensuring cross-run consistency. */
const SEED_PREFIX = 'kalle-seed-v1';

/**
 * Fixed base date for deterministic timestamps.
 * All seed timestamps are computed as offsets from this anchor.
 */
const BASE_DATE = new Date('2026-03-28T10:00:00.000Z');

// =============================================================================
// Deterministic Helper Functions
// =============================================================================

/**
 * Generates a deterministic UUID v4–formatted string from a seed phrase.
 * The same input always produces the same UUID, ensuring idempotency (R10).
 */
function deterministicUUID(seed: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${SEED_PREFIX}:${seed}`)
    .digest('hex');
  const p1 = hash.slice(0, 8);
  const p2 = hash.slice(8, 12);
  const p3 = '4' + hash.slice(13, 16);
  const varNibble = ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  const p4 = varNibble + hash.slice(17, 20);
  const p5 = hash.slice(20, 32);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

/**
 * Generates a deterministic Base64-encoded 32-byte key from components.
 * Used for identity keys, signed pre-keys, and individual pre-keys.
 */
function generateDeterministicKey(
  seed: string,
  userId: string,
  purpose: string,
): string {
  return crypto
    .createHash('sha256')
    .update(`${seed}:${userId}:${purpose}`)
    .digest('base64');
}

/**
 * Generates a deterministic Base64-encoded 64-byte signature by concatenating
 * two SHA-256 digests derived from related inputs.
 */
function generateDeterministicSignature(
  seed: string,
  userId: string,
  purpose: string,
): string {
  const part1 = crypto
    .createHash('sha256')
    .update(`${seed}:${userId}:${purpose}:sig-part1`)
    .digest();
  const part2 = crypto
    .createHash('sha256')
    .update(`${seed}:${userId}:${purpose}:sig-part2`)
    .digest();
  return Buffer.concat([part1, part2]).toString('base64');
}

/**
 * Generates deterministic Base64-encoded simulated ciphertext.
 * The marker format ensures content is identifiable as seed data while
 * satisfying the requirement that no plaintext is stored server-side (R12).
 */
function generateDeterministicCiphertext(
  content: string,
  nonce: number,
): string {
  return Buffer.from(`SEED_CIPHERTEXT:${content}:${nonce}`).toString('base64');
}

/**
 * Returns a Date offset from BASE_DATE by the given number of hours.
 * Negative offsets produce dates before BASE_DATE.
 */
function offsetDate(hoursOffset: number): Date {
  return new Date(BASE_DATE.getTime() + hoursOffset * 3_600_000);
}

/**
 * Hashes a plaintext password using bcrypt with configured salt rounds.
 */
async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

// =============================================================================
// Seed Data Definitions
// =============================================================================

/** Demo user definitions matching Figma screen names. */
const SEED_USERS = [
  { email: 'martin.randolph@demo.kalle.app', password: 'Demo@Pass123!', displayName: 'Martin Randolph', about: 'Available' },
  { email: 'andrew.parker@demo.kalle.app', password: 'Demo@Pass123!', displayName: 'Andrew Parker', about: 'Hey there! I am using Kalle' },
  { email: 'karen.castillo@demo.kalle.app', password: 'Demo@Pass123!', displayName: 'Karen Castillo', about: 'At work' },
  { email: 'max.jacobson@demo.kalle.app', password: 'Demo@Pass123!', displayName: 'Maximillian Jacobson', about: 'Available' },
  { email: 'martha.craig@demo.kalle.app', password: 'Demo@Pass123!', displayName: 'Martha Craig', about: 'Design adds value faster, than it adds cost' },
  { email: 'tabitha.potter@demo.kalle.app', password: 'Demo@Pass123!', displayName: 'Tabitha Potter', about: 'Busy' },
  { email: 'maisy.humphrey@demo.kalle.app', password: 'Demo@Pass123!', displayName: 'Maisy Humphrey', about: 'Available' },
  { email: 'kieron.dotson@demo.kalle.app', password: 'Demo@Pass123!', displayName: 'Kieron Dotson', about: 'In a meeting' },
  { email: 'sabohiddin@demo.kalle.app', password: 'Demo@Pass123!', displayName: 'Sabohiddin', about: 'Digital goodies designer - Pixsellz' },
  { email: 'jamie.franco@demo.kalle.app', password: 'Demo@Pass123!', displayName: 'Jamie Franco', about: 'Available' },
  { email: 'alice.whitman@demo.kalle.app', password: 'Demo@Pass123!', displayName: 'Alice Whitman', about: 'Exploring the world \u{1F30D}' },
  { email: 'bob.johnson@demo.kalle.app', password: 'Demo@Pass123!', displayName: 'Bob Johnson', about: 'Available' },
] as const;

/** Readable user-index aliases for seed data wiring. */
const IDX_MARTIN = 0;
const IDX_ANDREW = 1;
const IDX_KAREN = 2;
const IDX_MAX = 3;
const IDX_MARTHA = 4;
const IDX_TABITHA = 5;
const IDX_MAISY = 6;
const IDX_KIERON = 7;
const IDX_SABOHIDDIN = 8;
const IDX_JAMIE = 9;
const IDX_ALICE = 10;
const IDX_BOB = 11;

/** Conversation template definitions (3 DIRECT + 2 GROUP). */
interface ConversationDef {
  type: ConversationType;
  title: string | null;
  participantIndices: readonly number[];
  creatorIndex: number;
}

const CONVERSATION_DEFS: readonly ConversationDef[] = [
  { type: ConversationType.DIRECT, title: null, participantIndices: [IDX_SABOHIDDIN, IDX_MARTHA], creatorIndex: IDX_SABOHIDDIN },
  { type: ConversationType.DIRECT, title: null, participantIndices: [IDX_SABOHIDDIN, IDX_ANDREW], creatorIndex: IDX_ANDREW },
  { type: ConversationType.DIRECT, title: null, participantIndices: [IDX_SABOHIDDIN, IDX_KAREN], creatorIndex: IDX_KAREN },
  { type: ConversationType.GROUP, title: 'Design Team', participantIndices: [IDX_SABOHIDDIN, IDX_MARTHA, IDX_MAX, IDX_TABITHA], creatorIndex: IDX_SABOHIDDIN },
  { type: ConversationType.GROUP, title: 'Weekend Plans', participantIndices: [IDX_SABOHIDDIN, IDX_ANDREW, IDX_KAREN, IDX_KIERON, IDX_JAMIE], creatorIndex: IDX_ANDREW },
];

/** Message template definitions (26 messages across 5 conversations). */
interface MessageDef {
  convIndex: number;
  senderIndex: number;
  type: MessageType;
  contentKey: string;
  hoursOffset: number;
  replyToMsgIndex?: number;
  isEdited?: boolean;
  editedHoursOffset?: number;
  isDeleted?: boolean;
}

const MESSAGE_DEFS: readonly MessageDef[] = [
  // ── Conversation 0: Sabohiddin ↔ Martha Craig (DIRECT) ──
  { convIndex: 0, senderIndex: IDX_MARTHA,     type: MessageType.TEXT,     contentKey: 'design-review-question',      hoursOffset: -24 },
  { convIndex: 0, senderIndex: IDX_SABOHIDDIN, type: MessageType.TEXT,     contentKey: 'almost-done-mockups',         hoursOffset: -23.5 },
  { convIndex: 0, senderIndex: IDX_MARTHA,     type: MessageType.TEXT,     contentKey: 'share-latest-file',           hoursOffset: -23, replyToMsgIndex: 1 },
  { convIndex: 0, senderIndex: IDX_SABOHIDDIN, type: MessageType.IMAGE,   contentKey: 'latest-design-screenshot',    hoursOffset: -22.5 },
  { convIndex: 0, senderIndex: IDX_MARTHA,     type: MessageType.TEXT,     contentKey: 'looks-amazing',               hoursOffset: -22, isEdited: true, editedHoursOffset: -21.8 },
  { convIndex: 0, senderIndex: IDX_SABOHIDDIN, type: MessageType.DOCUMENT,contentKey: 'design-document-img0475',     hoursOffset: -21.5 },
  { convIndex: 0, senderIndex: IDX_MARTHA,     type: MessageType.TEXT,     contentKey: 'deleted-message',             hoursOffset: -21, isDeleted: true },

  // ── Conversation 1: Sabohiddin ↔ Andrew Parker (DIRECT) ──
  { convIndex: 1, senderIndex: IDX_ANDREW,     type: MessageType.TEXT,     contentKey: 'meetup-tonight',              hoursOffset: -20 },
  { convIndex: 1, senderIndex: IDX_SABOHIDDIN, type: MessageType.TEXT,     contentKey: 'definitely-what-time',        hoursOffset: -19.5 },
  { convIndex: 1, senderIndex: IDX_ANDREW,     type: MessageType.TEXT,     contentKey: 'seven-pm-usual-place',        hoursOffset: -19 },
  { convIndex: 1, senderIndex: IDX_SABOHIDDIN, type: MessageType.TEXT,     contentKey: 'perfect-see-you',             hoursOffset: -18.5 },

  // ── Conversation 2: Sabohiddin ↔ Karen Castillo (DIRECT) ──
  { convIndex: 2, senderIndex: IDX_KAREN,      type: MessageType.VOICE,   contentKey: 'voice-note-014',              hoursOffset: -16 },
  { convIndex: 2, senderIndex: IDX_SABOHIDDIN, type: MessageType.TEXT,     contentKey: 'got-it-check-back',           hoursOffset: -15.5 },
  { convIndex: 2, senderIndex: IDX_KAREN,      type: MessageType.TEXT,     contentKey: 'thanks',                      hoursOffset: -15 },

  // ── Conversation 3: Design Team (GROUP) ──
  { convIndex: 3, senderIndex: IDX_SABOHIDDIN, type: MessageType.TEXT,     contentKey: 'review-latest-designs',       hoursOffset: -12 },
  { convIndex: 3, senderIndex: IDX_MARTHA,     type: MessageType.TEXT,     contentKey: 'updated-component-library',   hoursOffset: -11.5 },
  { convIndex: 3, senderIndex: IDX_MAX,        type: MessageType.TEXT,     contentKey: 'great-minor-tweaks',          hoursOffset: -11 },
  { convIndex: 3, senderIndex: IDX_TABITHA,    type: MessageType.TEXT,     contentKey: 'agreed-noticed-too',          hoursOffset: -10.5, replyToMsgIndex: 16 },
  { convIndex: 3, senderIndex: IDX_SABOHIDDIN, type: MessageType.DOCUMENT,contentKey: 'design-specs-document',       hoursOffset: -10 },
  { convIndex: 3, senderIndex: IDX_MARTHA,     type: MessageType.IMAGE,   contentKey: 'updated-mockup-image',        hoursOffset: -9.5 },

  // ── Conversation 4: Weekend Plans (GROUP) ──
  { convIndex: 4, senderIndex: IDX_ANDREW,     type: MessageType.TEXT,     contentKey: 'anyone-free-saturday',        hoursOffset: -8 },
  { convIndex: 4, senderIndex: IDX_KAREN,      type: MessageType.TEXT,     contentKey: 'im-in-whats-plan',            hoursOffset: -7.5 },
  { convIndex: 4, senderIndex: IDX_KIERON,     type: MessageType.TEXT,     contentKey: 'hiking-at-trails',            hoursOffset: -7 },
  { convIndex: 4, senderIndex: IDX_JAMIE,      type: MessageType.TEXT,     contentKey: 'sounds-perfect',              hoursOffset: -6.5 },
  { convIndex: 4, senderIndex: IDX_SABOHIDDIN, type: MessageType.TEXT,     contentKey: 'count-me-in',                 hoursOffset: -6 },
  { convIndex: 4, senderIndex: IDX_ANDREW,     type: MessageType.TEXT,     contentKey: 'great-idea-meet-9am',         hoursOffset: -5.5, replyToMsgIndex: 22 },
];

// =============================================================================
// Database Cleanup
// =============================================================================

/**
 * Deletes ALL data in reverse foreign-key dependency order.
 * Ensures clean slate before re-seeding (idempotency guarantee per R10).
 *
 * NOTE: In production, the audit_log table has restricted permissions (R32).
 * The seed script bypasses this restriction using direct Prisma operations.
 */
async function cleanDatabase(): Promise<void> {
  console.log('  \u{1F5D1}\u{FE0F}  Cleaning existing data...');
  // Use $transaction for atomic cleanup — all deletes succeed or none do.
  // Operations execute sequentially in FK-dependency order within one DB transaction.
  await prisma.$transaction([
    prisma.storyView.deleteMany(),
    prisma.story.deleteMany(),
    prisma.messageStatus.deleteMany(),
    prisma.media.deleteMany(),
    prisma.message.deleteMany(),
    prisma.conversationParticipant.deleteMany(),
    prisma.conversation.deleteMany(),
    prisma.preKeyBundle.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.session.deleteMany(),
    prisma.blockedUser.deleteMany(),
    prisma.user.deleteMany(),
  ]);
  console.log('  \u2713 Database cleaned');
}

// =============================================================================
// Individual Seeding Functions
// =============================================================================

/**
 * Creates all demo users with hashed passwords and deterministic IDs.
 * Returns the ordered array of user IDs matching SEED_USERS indices.
 */
async function seedUsers(passwordHash: string): Promise<string[]> {
  console.log('  \u{1F464} Seeding users...');
  const userIds: string[] = [];

  for (let i = 0; i < SEED_USERS.length; i++) {
    const u = SEED_USERS[i];
    const id = deterministicUUID(`user:${u.email}`);
    userIds.push(id);

    await prisma.user.create({
      data: {
        id,
        email: u.email,
        passwordHash,
        displayName: u.displayName,
        about: u.about,
        lastSeen: offsetDate(-2 + i * 0.5),
        isOnline: i === IDX_SABOHIDDIN,
        createdAt: offsetDate(-72 + i),
      },
    });
  }

  console.log(`  \u2713 ${userIds.length} users created`);
  return userIds;
}

/**
 * Creates conversations and their participants.
 * Returns conversation IDs and a map of conversationId -> participant userIds.
 */
async function seedConversations(
  userIds: string[],
): Promise<{ conversationIds: string[]; participantMap: Map<string, string[]> }> {
  console.log('  \u{1F4AC} Seeding conversations...');
  const conversationIds: string[] = [];
  const participantMap = new Map<string, string[]>();

  for (let i = 0; i < CONVERSATION_DEFS.length; i++) {
    const def = CONVERSATION_DEFS[i];
    const convId = deterministicUUID(`conversation:${i}`);
    conversationIds.push(convId);

    await prisma.conversation.create({
      data: {
        id: convId,
        type: def.type,
        title: def.title,
        createdBy: userIds[def.creatorIndex],
        createdAt: offsetDate(-48 + i * 2),
      },
    });

    const participantUserIds: string[] = [];
    for (let j = 0; j < def.participantIndices.length; j++) {
      const userIndex = def.participantIndices[j];
      const pid = deterministicUUID(`participant:${i}:${j}`);
      const isGroupAdmin =
        def.type === ConversationType.GROUP && userIndex === def.creatorIndex;

      await prisma.conversationParticipant.create({
        data: {
          id: pid,
          userId: userIds[userIndex],
          conversationId: convId,
          role: isGroupAdmin ? ParticipantRole.ADMIN : ParticipantRole.MEMBER,
          joinedAt: offsetDate(-48 + i * 2),
        },
      });
      participantUserIds.push(userIds[userIndex]);
    }
    participantMap.set(convId, participantUserIds);
  }

  console.log(`  \u2713 ${conversationIds.length} conversations created`);
  return { conversationIds, participantMap };
}

/**
 * Creates all seed messages across conversations.
 * Returns the ordered array of message IDs matching MESSAGE_DEFS indices.
 */
async function seedMessages(
  userIds: string[],
  conversationIds: string[],
): Promise<string[]> {
  console.log('  \u{1F4E8} Seeding messages...');
  const messageIds: string[] = [];

  for (let i = 0; i < MESSAGE_DEFS.length; i++) {
    const def = MESSAGE_DEFS[i];
    const msgId = deterministicUUID(`message:${i}`);
    messageIds.push(msgId);

    const isTombstone = def.isDeleted === true;
    const ciphertext = isTombstone
      ? null
      : generateDeterministicCiphertext(def.contentKey, i);

    const replyToId =
      def.replyToMsgIndex !== undefined
        ? messageIds[def.replyToMsgIndex]
        : null;

    await prisma.message.create({
      data: {
        id: msgId,
        conversationId: conversationIds[def.convIndex],
        senderId: userIds[def.senderIndex],
        ciphertext,
        type: def.type,
        replyToId,
        isEdited: def.isEdited ?? false,
        isDeleted: isTombstone,
        editedAt:
          def.isEdited && def.editedHoursOffset !== undefined
            ? offsetDate(def.editedHoursOffset)
            : null,
        serverTimestamp: offsetDate(def.hoursOffset),
        clientTimestamp: offsetDate(def.hoursOffset - 0.001),
      },
    });
  }

  console.log(`  \u2713 ${messageIds.length} messages created`);
  return messageIds;
}

/**
 * Creates per-recipient delivery statuses for every message.
 * DIRECT conversations: one status for the non-sender participant.
 * GROUP conversations: one status per non-sender participant.
 */
async function seedMessageStatuses(
  messageIds: string[],
  userIds: string[],
  conversationIds: string[],
  participantMap: Map<string, string[]>,
): Promise<void> {
  console.log('  \u2705 Seeding message statuses...');
  let statusCount = 0;

  for (let i = 0; i < MESSAGE_DEFS.length; i++) {
    const def = MESSAGE_DEFS[i];
    const convId = conversationIds[def.convIndex];
    const senderId = userIds[def.senderIndex];
    const participants = participantMap.get(convId) ?? [];
    const recipients = participants.filter((uid) => uid !== senderId);

    for (let r = 0; r < recipients.length; r++) {
      const recipientId = recipients[r];
      const statusId = deterministicUUID(`msgstatus:${i}:${r}`);

      // Vary delivery statuses for realism:
      //   older messages -> READ, mid-range -> DELIVERED, newest -> SENT
      let status: MessageDeliveryStatus;
      let deliveredAt: Date | null = null;
      let readAt: Date | null = null;

      if (def.hoursOffset < -15) {
        status = MessageDeliveryStatus.READ;
        deliveredAt = offsetDate(def.hoursOffset + 0.1);
        readAt = offsetDate(def.hoursOffset + 0.5);
      } else if (def.hoursOffset < -8) {
        status = MessageDeliveryStatus.DELIVERED;
        deliveredAt = offsetDate(def.hoursOffset + 0.1);
      } else {
        status = MessageDeliveryStatus.SENT;
      }

      await prisma.messageStatus.create({
        data: {
          id: statusId,
          messageId: messageIds[i],
          userId: recipientId,
          status,
          deliveredAt,
          readAt,
        },
      });
      statusCount++;
    }
  }

  console.log(`  \u2713 ${statusCount} message statuses created`);
}

/**
 * Creates Media records for IMAGE, DOCUMENT, and VOICE messages.
 */
async function seedMedia(
  userIds: string[],
  messageIds: string[],
): Promise<void> {
  console.log('  \u{1F4CE} Seeding media...');

  interface MediaDef {
    msgIndex: number;
    senderIndex: number;
    mimeType: string;
    filename: string;
    size: number;
    hasThumbnail: boolean;
  }

  const mediaDefs: MediaDef[] = [
    { msgIndex: 3,  senderIndex: IDX_SABOHIDDIN, mimeType: 'image/jpeg',       filename: 'design_screenshot.jpg',  size: 1_845_200,  hasThumbnail: true },
    { msgIndex: 5,  senderIndex: IDX_SABOHIDDIN, mimeType: 'image/png',        filename: 'IMG_0475.png',           size: 2_516_582,  hasThumbnail: true },
    { msgIndex: 11, senderIndex: IDX_KAREN,      mimeType: 'audio/ogg',        filename: 'voice_note_001.ogg',     size: 48_320,     hasThumbnail: false },
    { msgIndex: 18, senderIndex: IDX_SABOHIDDIN, mimeType: 'application/pdf',  filename: 'design_specs.pdf',       size: 3_145_728,  hasThumbnail: false },
    { msgIndex: 19, senderIndex: IDX_MARTHA,     mimeType: 'image/jpeg',       filename: 'updated_mockup.jpg',     size: 2_097_152,  hasThumbnail: true },
  ];

  for (let i = 0; i < mediaDefs.length; i++) {
    const md = mediaDefs[i];
    const mediaId = deterministicUUID(`media:${i}`);
    const encryptedPath = `/uploads/encrypted/${mediaId}/${md.filename}`;
    const thumbPath = md.hasThumbnail
      ? `/uploads/encrypted/${mediaId}/thumb_${md.filename}`
      : null;

    await prisma.media.create({
      data: {
        id: mediaId,
        userId: userIds[md.senderIndex],
        messageId: messageIds[md.msgIndex],
        mimeType: md.mimeType,
        encryptedUrl: encryptedPath,
        thumbnailUrl: thumbPath,
        size: md.size,
        filename: md.filename,
        createdAt: offsetDate(MESSAGE_DEFS[md.msgIndex].hoursOffset),
      },
    });
  }

  console.log(`  \u2713 ${mediaDefs.length} media records created`);
}

/**
 * Creates stories with views and one expired story for cleanup-demo.
 * Stories are NOT encrypted per R12 -- only messages use E2E encryption.
 */
async function seedStories(userIds: string[]): Promise<void> {
  console.log('  \u{1F4F1} Seeding stories...');

  // Story 1: Sabohiddin text status (coral background, matches Figma Screen 10)
  const story1Id = deterministicUUID('story:0');
  await prisma.story.create({
    data: {
      id: story1Id,
      authorId: userIds[IDX_SABOHIDDIN],
      textContent: 'Working on something exciting!',
      backgroundColor: '#FF6B6B',
      createdAt: offsetDate(-6),
      expiresAt: offsetDate(18),
    },
  });

  // Story 2: Martha image story
  const story2Id = deterministicUUID('story:1');
  await prisma.story.create({
    data: {
      id: story2Id,
      authorId: userIds[IDX_MARTHA],
      createdAt: offsetDate(-4),
      expiresAt: offsetDate(20),
    },
  });
  // Attach media to story 2
  await prisma.media.create({
    data: {
      id: deterministicUUID('story-media:0'),
      userId: userIds[IDX_MARTHA],
      storyId: story2Id,
      mimeType: 'image/jpeg',
      encryptedUrl: `/uploads/stories/${story2Id}/story_image.jpg`,
      thumbnailUrl: `/uploads/stories/${story2Id}/thumb_story_image.jpg`,
      size: 1_024_000,
      filename: 'story_image.jpg',
      createdAt: offsetDate(-4),
    },
  });

  // Story 3: Andrew expired story (demonstrates cleanup per R11/R35)
  const story3Id = deterministicUUID('story:2');
  await prisma.story.create({
    data: {
      id: story3Id,
      authorId: userIds[IDX_ANDREW],
      textContent: 'Beautiful sunset!',
      backgroundColor: '#4A90D9',
      createdAt: offsetDate(-30),
      expiresAt: offsetDate(-6),
    },
  });

  // Story 4: Karen active text story
  const story4Id = deterministicUUID('story:3');
  await prisma.story.create({
    data: {
      id: story4Id,
      authorId: userIds[IDX_KAREN],
      textContent: 'Monday motivation \u{1F4AA}',
      backgroundColor: '#2ECC71',
      createdAt: offsetDate(-3),
      expiresAt: offsetDate(21),
    },
  });

  // Story views
  const storyViewDefs = [
    { storyId: story1Id, viewerIndex: IDX_MARTHA,     hoursOffset: -5 },
    { storyId: story1Id, viewerIndex: IDX_ANDREW,     hoursOffset: -4.5 },
    { storyId: story1Id, viewerIndex: IDX_KAREN,      hoursOffset: -4 },
    { storyId: story1Id, viewerIndex: IDX_MARTIN,     hoursOffset: -3.8 },
    { storyId: story2Id, viewerIndex: IDX_SABOHIDDIN, hoursOffset: -3 },
    { storyId: story2Id, viewerIndex: IDX_MAISY,      hoursOffset: -2.5 },
    { storyId: story4Id, viewerIndex: IDX_SABOHIDDIN, hoursOffset: -2 },
    { storyId: story4Id, viewerIndex: IDX_ANDREW,     hoursOffset: -1.5 },
    { storyId: story4Id, viewerIndex: IDX_ALICE,      hoursOffset: -1 },
    { storyId: story4Id, viewerIndex: IDX_BOB,        hoursOffset: -0.5 },
  ];

  for (let i = 0; i < storyViewDefs.length; i++) {
    const sv = storyViewDefs[i];
    await prisma.storyView.create({
      data: {
        id: deterministicUUID(`storyview:${i}`),
        storyId: sv.storyId,
        viewerId: userIds[sv.viewerIndex],
        viewedAt: offsetDate(sv.hoursOffset),
      },
    });
  }

  console.log('  \u2713 4 stories and 10 story views created');
}

/**
 * Creates audit log entries for security-sensitive demo events.
 * Metadata fields are sanitized -- no passwords, tokens, or keys (R23, R32).
 */
async function seedAuditLogs(userIds: string[]): Promise<void> {
  console.log('  \u{1F4DD} Seeding audit logs...');

  interface AuditDef {
    actorIndex: number;
    action: AuditAction;
    targetType: string;
    targetIdSeed: string;
    metadata: Record<string, string>;
    hoursOffset: number;
  }

  const auditDefs: AuditDef[] = [
    {
      actorIndex: IDX_SABOHIDDIN,
      action: AuditAction.USER_REGISTER,
      targetType: 'User',
      targetIdSeed: `user:${SEED_USERS[IDX_SABOHIDDIN].email}`,
      metadata: { method: 'email', userAgent: 'Mozilla/5.0 (seed)' },
      hoursOffset: -72,
    },
    {
      actorIndex: IDX_MARTHA,
      action: AuditAction.USER_REGISTER,
      targetType: 'User',
      targetIdSeed: `user:${SEED_USERS[IDX_MARTHA].email}`,
      metadata: { method: 'email', userAgent: 'Mozilla/5.0 (seed)' },
      hoursOffset: -68,
    },
    {
      actorIndex: IDX_ANDREW,
      action: AuditAction.USER_REGISTER,
      targetType: 'User',
      targetIdSeed: `user:${SEED_USERS[IDX_ANDREW].email}`,
      metadata: { method: 'email', userAgent: 'Mozilla/5.0 (seed)' },
      hoursOffset: -71,
    },
    {
      actorIndex: IDX_SABOHIDDIN,
      action: AuditAction.USER_LOGIN,
      targetType: 'Session',
      targetIdSeed: 'session:sabohiddin:0',
      metadata: { userAgent: 'Mozilla/5.0 (seed)', method: 'credentials' },
      hoursOffset: -48,
    },
    {
      actorIndex: IDX_MARTHA,
      action: AuditAction.USER_LOGIN,
      targetType: 'Session',
      targetIdSeed: 'session:martha:0',
      metadata: { userAgent: 'Mozilla/5.0 (seed)', method: 'credentials' },
      hoursOffset: -46,
    },
    {
      actorIndex: IDX_SABOHIDDIN,
      action: AuditAction.GROUP_MEMBER_ADD,
      targetType: 'ConversationParticipant',
      targetIdSeed: 'participant:3:1',
      metadata: { conversationTitle: 'Design Team', addedUser: 'Martha Craig' },
      hoursOffset: -44,
    },
  ];

  for (let i = 0; i < auditDefs.length; i++) {
    const ad = auditDefs[i];
    await prisma.auditLog.create({
      data: {
        id: deterministicUUID(`audit:${i}`),
        actorId: userIds[ad.actorIndex],
        action: ad.action,
        targetType: ad.targetType,
        targetId: deterministicUUID(ad.targetIdSeed),
        metadata: ad.metadata,
        ipAddress: '127.0.0.1',
        createdAt: offsetDate(ad.hoursOffset),
      },
    });
  }

  console.log(`  \u2713 ${auditDefs.length} audit log entries created`);
}

/**
 * Creates active and expired session records for the primary demo user.
 */
async function seedSessions(userIds: string[]): Promise<void> {
  console.log('  \u{1F510} Seeding sessions...');

  // Active session for Sabohiddin
  await prisma.session.create({
    data: {
      id: deterministicUUID('session:sabohiddin:active'),
      userId: userIds[IDX_SABOHIDDIN],
      jti: deterministicUUID('jti:sabohiddin:active'),
      deviceInfo: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/124.0',
      createdAt: offsetDate(-2),
      expiresAt: offsetDate(22),
      isRevoked: false,
    },
  });

  // Older expired session for Sabohiddin
  await prisma.session.create({
    data: {
      id: deterministicUUID('session:sabohiddin:expired'),
      userId: userIds[IDX_SABOHIDDIN],
      jti: deterministicUUID('jti:sabohiddin:expired'),
      deviceInfo: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4) Safari/604.1',
      createdAt: offsetDate(-96),
      expiresAt: offsetDate(-72),
      isRevoked: true,
    },
  });

  console.log('  \u2713 2 sessions created');
}

/**
 * Creates a PreKeyBundle for every user with deterministic key material.
 * Each bundle includes an identity key, signed pre-key, signature,
 * 10 one-time pre-keys, and a registration ID (R10 determinism).
 */
async function seedPreKeyBundles(userIds: string[]): Promise<void> {
  console.log('  \u{1F511} Seeding pre-key bundles...');

  for (let i = 0; i < userIds.length; i++) {
    const userId = userIds[i];
    const identityKey = generateDeterministicKey(SEED_PREFIX, userId, 'identity');
    const signedPreKey = generateDeterministicKey(SEED_PREFIX, userId, 'signed-pre-key');
    const signedPreKeySignature = generateDeterministicSignature(
      SEED_PREFIX,
      userId,
      'signed-pre-key',
    );

    // Generate 10 one-time pre-keys
    const preKeys: Array<{ keyId: number; publicKey: string }> = [];
    for (let k = 0; k < 10; k++) {
      preKeys.push({
        keyId: k + 1,
        publicKey: generateDeterministicKey(SEED_PREFIX, userId, `prekey-${k}`),
      });
    }

    // Deterministic registration ID: integer in [1, 16384]
    const regHash = crypto
      .createHash('sha256')
      .update(`${SEED_PREFIX}:${userId}:registration`)
      .digest();
    const registrationId = (regHash.readUInt16BE(0) % 16384) + 1;

    await prisma.preKeyBundle.create({
      data: {
        id: deterministicUUID(`prekey-bundle:${i}`),
        userId,
        identityKey,
        signedPreKey,
        signedPreKeySignature,
        preKeys,
        registrationId,
        createdAt: offsetDate(-72 + i),
      },
    });
  }

  console.log(`  \u2713 ${userIds.length} pre-key bundles created`);
}

// =============================================================================
// Main Seed Entry Point
// =============================================================================

/**
 * Primary seed orchestrator. Cleans all existing data then populates the
 * database in foreign-key dependency order. Designed for idempotent
 * execution -- running twice produces identical logical state (R10).
 */
export async function main(): Promise<void> {
  console.log('\u{1F331} Starting Kalle database seed...');
  console.log(`  Base date: ${BASE_DATE.toISOString()}`);

  // Hash the shared demo password once (bcrypt salt varies per run, which is
  // acceptable -- the password 'Demo@Pass123!' always authenticates correctly).
  const passwordHash = await hashPassword('Demo@Pass123!');

  // Step 1: Clean all existing data (reverse FK dependency order)
  await cleanDatabase();

  // Step 2: Create users
  const userIds = await seedUsers(passwordHash);

  // Step 3: Create conversations and participants
  const { conversationIds, participantMap } = await seedConversations(userIds);

  // Step 4: Create messages
  const messageIds = await seedMessages(userIds, conversationIds);

  // Step 5: Create per-recipient message statuses
  await seedMessageStatuses(messageIds, userIds, conversationIds, participantMap);

  // Step 6: Create media records for image/document/voice messages
  await seedMedia(userIds, messageIds);

  // Step 7: Create stories and story views
  await seedStories(userIds);

  // Step 8: Create audit log entries
  await seedAuditLogs(userIds);

  // Step 9: Create session records
  await seedSessions(userIds);

  // Step 10: Create pre-key bundles for all users
  await seedPreKeyBundles(userIds);

  console.log('\u2705 Seed complete!');
}

// =============================================================================
// Script Execution
// =============================================================================

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
