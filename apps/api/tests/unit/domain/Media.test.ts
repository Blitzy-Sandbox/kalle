/**
 * @module apps/api/tests/unit/domain/Media.test.ts
 *
 * Comprehensive unit tests for the Media domain model.
 *
 * Rules verified:
 * - R8  — MIME type validation against server-side allowlist + 25 MB file size limit
 * - R12 — E2E encryption metadata (encryptionKey, encryptionIv) must be present
 * - R27 — Client-side thumbnail required for IMAGE type, max 200 px, encrypted separately
 * - R16 — OOD layering: tests target domain model behaviour only, zero infrastructure
 * - R7  — TypeScript strict mode with zero warnings
 * - R28 — Zero console.log calls
 */

import { Media, MediaProps, ThumbnailInfo } from '../../../src/domain/models/Media';
import { MediaType } from '@kalle/shared';
import { SIZE_LIMITS, MIME_TYPES, ALL_ALLOWED_MIME_TYPES } from '@kalle/shared';

// ---------------------------------------------------------------------------
// Test Helper Factories
// ---------------------------------------------------------------------------

/** Creates a valid ThumbnailInfo object for IMAGE media tests (R27). */
const validThumbnail = (overrides?: Partial<ThumbnailInfo>): ThumbnailInfo => ({
  url: 'https://example.com/thumb.enc',
  width: 150,
  height: 100,
  encryptionKey: 'thumb-key-base64',
  encryptionIv: 'thumb-iv-base64',
  ...overrides,
});

/**
 * Creates a complete, valid MediaProps object for IMAGE media.
 * Includes thumbnail by default (R27 requirement for IMAGE).
 */
const validImageProps = (overrides?: Partial<MediaProps>): MediaProps => ({
  id: 'media-1',
  uploaderId: 'user-1',
  type: MediaType.IMAGE,
  mimeType: 'image/jpeg',
  fileName: 'photo.jpg',
  fileSize: 2 * 1024 * 1024, // 2 MB
  url: 'https://example.com/encrypted.blob',
  encryptionKey: 'media-key-base64',
  encryptionIv: 'media-iv-base64',
  thumbnail: validThumbnail(),
  width: 1920,
  height: 1080,
  duration: undefined,
  waveform: undefined,
  messageId: 'msg-1',
  storyId: undefined,
  createdAt: new Date('2024-07-01T12:00:00Z'),
  updatedAt: new Date('2024-07-01T12:00:00Z'),
  ...overrides,
});

/**
 * Creates a complete, valid MediaProps object for VOICE_NOTE media.
 * Includes waveform data and duration; no thumbnail.
 */
const validVoiceNoteProps = (overrides?: Partial<MediaProps>): MediaProps => ({
  ...validImageProps(),
  id: 'media-2',
  type: MediaType.VOICE_NOTE,
  mimeType: 'audio/ogg',
  fileName: 'recording.ogg',
  fileSize: 500 * 1024, // 500 KB
  thumbnail: undefined,
  width: undefined,
  height: undefined,
  duration: 14,
  waveform: [0.1, 0.3, 0.5, 0.8, 0.4, 0.2],
  ...overrides,
});

/**
 * Builds a create() DTO from full MediaProps, stripping auto-generated fields
 * (id, createdAt, updatedAt) that the factory method generates internally.
 */
const toCreateDTO = (props: MediaProps) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, createdAt, updatedAt, ...dto } = props;
  return dto;
};

// ===========================================================================
// Phase 2: MIME Type Validation Tests — CRITICAL (R8)
// ===========================================================================

describe('Media.validateMimeType()', () => {
  // ---- Accept valid MIME types per category ----

  it('accepts image/jpeg for MediaType.IMAGE', () => {
    expect(() => Media.validateMimeType('image/jpeg', MediaType.IMAGE)).not.toThrow();
  });

  it('accepts image/png for MediaType.IMAGE', () => {
    expect(() => Media.validateMimeType('image/png', MediaType.IMAGE)).not.toThrow();
  });

  it('accepts image/gif for MediaType.IMAGE', () => {
    expect(() => Media.validateMimeType('image/gif', MediaType.IMAGE)).not.toThrow();
  });

  it('accepts image/webp for MediaType.IMAGE', () => {
    expect(() => Media.validateMimeType('image/webp', MediaType.IMAGE)).not.toThrow();
  });

  it('accepts video/mp4 for MediaType.VIDEO', () => {
    expect(() => Media.validateMimeType('video/mp4', MediaType.VIDEO)).not.toThrow();
  });

  it('accepts video/webm for MediaType.VIDEO', () => {
    expect(() => Media.validateMimeType('video/webm', MediaType.VIDEO)).not.toThrow();
  });

  it('accepts application/pdf for MediaType.DOCUMENT', () => {
    expect(() => Media.validateMimeType('application/pdf', MediaType.DOCUMENT)).not.toThrow();
  });

  it('accepts text/plain for MediaType.DOCUMENT', () => {
    expect(() => Media.validateMimeType('text/plain', MediaType.DOCUMENT)).not.toThrow();
  });

  it('accepts audio/ogg for MediaType.VOICE_NOTE', () => {
    expect(() => Media.validateMimeType('audio/ogg', MediaType.VOICE_NOTE)).not.toThrow();
  });

  it('accepts audio/webm for MediaType.VOICE_NOTE', () => {
    expect(() => Media.validateMimeType('audio/webm', MediaType.VOICE_NOTE)).not.toThrow();
  });

  // ---- Verify all MIME_TYPES constants entries pass for each category ----

  it('accepts every MIME_TYPES.IMAGE entry for MediaType.IMAGE', () => {
    for (const mime of MIME_TYPES.IMAGE) {
      expect(() => Media.validateMimeType(mime, MediaType.IMAGE)).not.toThrow();
    }
  });

  it('accepts every MIME_TYPES.VIDEO entry for MediaType.VIDEO', () => {
    for (const mime of MIME_TYPES.VIDEO) {
      expect(() => Media.validateMimeType(mime, MediaType.VIDEO)).not.toThrow();
    }
  });

  it('accepts every MIME_TYPES.DOCUMENT entry for MediaType.DOCUMENT', () => {
    for (const mime of MIME_TYPES.DOCUMENT) {
      expect(() => Media.validateMimeType(mime, MediaType.DOCUMENT)).not.toThrow();
    }
  });

  it('accepts every MIME_TYPES.AUDIO entry for MediaType.VOICE_NOTE', () => {
    for (const mime of MIME_TYPES.AUDIO) {
      expect(() => Media.validateMimeType(mime, MediaType.VOICE_NOTE)).not.toThrow();
    }
  });

  // ---- Reject disallowed MIME types ----

  it('throws for application/x-malicious (not in global allowlist)', () => {
    expect(() => Media.validateMimeType('application/x-malicious', MediaType.DOCUMENT)).toThrow();
  });

  it('throws for image/svg+xml (not in IMAGE allowlist)', () => {
    expect(() => Media.validateMimeType('image/svg+xml', MediaType.IMAGE)).toThrow();
  });

  it('throws for application/exe (not in any allowlist)', () => {
    expect(() => Media.validateMimeType('application/exe', MediaType.DOCUMENT)).toThrow();
  });

  it('throws for mismatched category: image/jpeg with MediaType.DOCUMENT', () => {
    expect(() => Media.validateMimeType('image/jpeg', MediaType.DOCUMENT)).toThrow();
  });

  it('throws for empty MIME type string', () => {
    expect(() => Media.validateMimeType('', MediaType.IMAGE)).toThrow();
  });

  it('throws for whitespace-only MIME type string', () => {
    expect(() => Media.validateMimeType('   ', MediaType.IMAGE)).toThrow();
  });

  // ---- Verify all entries in ALL_ALLOWED_MIME_TYPES constant are accepted ----

  it('accepts every entry from ALL_ALLOWED_MIME_TYPES in its correct category', () => {
    // Map MIME prefixes to their correct MediaType for category-aware validation
    const mimeToMediaType = (mime: string): MediaType => {
      if (mime.startsWith('image/')) return MediaType.IMAGE;
      if (mime.startsWith('video/')) return MediaType.VIDEO;
      if (mime.startsWith('audio/')) return MediaType.VOICE_NOTE;
      return MediaType.DOCUMENT;
    };

    for (const mime of ALL_ALLOWED_MIME_TYPES) {
      const mediaType = mimeToMediaType(mime);
      expect(() => Media.validateMimeType(mime, mediaType)).not.toThrow();
    }
  });
});

// ===========================================================================
// Phase 3: File Size Validation Tests — CRITICAL (R8: 25 MB Limit)
// ===========================================================================

describe('Media.validateFileSize()', () => {
  it('accepts 1 MB file (well under limit)', () => {
    expect(() => Media.validateFileSize(1 * 1024 * 1024)).not.toThrow();
  });

  it('accepts exactly 25 MB file (SIZE_LIMITS.MAX_UPLOAD_BYTES boundary)', () => {
    expect(() => Media.validateFileSize(SIZE_LIMITS.MAX_UPLOAD_BYTES)).not.toThrow();
  });

  it('throws for 25 MB + 1 byte (26,214,401 bytes)', () => {
    expect(() => Media.validateFileSize(SIZE_LIMITS.MAX_UPLOAD_BYTES + 1)).toThrow();
  });

  it('throws for 50 MB file', () => {
    expect(() => Media.validateFileSize(50 * 1024 * 1024)).toThrow();
  });

  it('throws for 0 bytes (file size must be positive)', () => {
    expect(() => Media.validateFileSize(0)).toThrow();
  });

  it('throws for negative file size', () => {
    expect(() => Media.validateFileSize(-1)).toThrow();
  });

  it('accepts 1-byte file (minimum valid size)', () => {
    expect(() => Media.validateFileSize(1)).not.toThrow();
  });

  it('uses SIZE_LIMITS.MAX_UPLOAD_BYTES constant (26,214,400)', () => {
    expect(SIZE_LIMITS.MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});

// ===========================================================================
// Phase 4: Factory Tests — Media.create()
// ===========================================================================

describe('Media.create()', () => {
  it('creates IMAGE media with valid props including thumbnail', () => {
    const dto = toCreateDTO(validImageProps());
    const media = Media.create(dto);

    expect(media.type).toBe(MediaType.IMAGE);
    expect(media.mimeType).toBe('image/jpeg');
    expect(media.fileName).toBe('photo.jpg');
    expect(media.fileSize).toBe(2 * 1024 * 1024);
    expect(media.uploaderId).toBe('user-1');
    expect(media.encryptionKey).toBe('media-key-base64');
    expect(media.encryptionIv).toBe('media-iv-base64');
    expect(media.thumbnail).toBeDefined();
    expect(media.id).toBeDefined();
    expect(media.createdAt).toBeInstanceOf(Date);
    expect(media.updatedAt).toBeInstanceOf(Date);
  });

  it('creates VIDEO media with valid props', () => {
    const dto = toCreateDTO(validImageProps({
      type: MediaType.VIDEO,
      mimeType: 'video/mp4',
      fileName: 'clip.mp4',
      thumbnail: undefined,
      duration: 120,
    }));
    const media = Media.create(dto);

    expect(media.type).toBe(MediaType.VIDEO);
    expect(media.mimeType).toBe('video/mp4');
    expect(media.duration).toBe(120);
  });

  it('creates DOCUMENT media with valid props', () => {
    const dto = toCreateDTO(validImageProps({
      type: MediaType.DOCUMENT,
      mimeType: 'application/pdf',
      fileName: 'report.pdf',
      thumbnail: undefined,
      width: undefined,
      height: undefined,
    }));
    const media = Media.create(dto);

    expect(media.type).toBe(MediaType.DOCUMENT);
    expect(media.mimeType).toBe('application/pdf');
    expect(media.fileName).toBe('report.pdf');
  });

  it('creates VOICE_NOTE media with valid props including waveform', () => {
    const dto = toCreateDTO(validVoiceNoteProps());
    const media = Media.create(dto);

    expect(media.type).toBe(MediaType.VOICE_NOTE);
    expect(media.mimeType).toBe('audio/ogg');
    expect(media.duration).toBe(14);
    expect(media.waveform).toEqual([0.1, 0.3, 0.5, 0.8, 0.4, 0.2]);
  });

  it('throws for IMAGE type WITHOUT thumbnail (R27)', () => {
    const dto = toCreateDTO(validImageProps({ thumbnail: undefined }));
    expect(() => Media.create(dto)).toThrow(/thumbnail/i);
  });

  it('throws for VOICE_NOTE type WITHOUT waveform', () => {
    const dto = toCreateDTO(validVoiceNoteProps({ waveform: undefined }));
    expect(() => Media.create(dto)).toThrow(/waveform/i);
  });

  it('throws for VOICE_NOTE type with empty waveform array', () => {
    const dto = toCreateDTO(validVoiceNoteProps({ waveform: [] }));
    expect(() => Media.create(dto)).toThrow(/waveform/i);
  });

  it('throws for empty encryptionKey (R12)', () => {
    const dto = toCreateDTO(validImageProps({ encryptionKey: '' }));
    expect(() => Media.create(dto)).toThrow(/encryption/i);
  });

  it('throws for whitespace-only encryptionKey (R12)', () => {
    const dto = toCreateDTO(validImageProps({ encryptionKey: '   ' }));
    expect(() => Media.create(dto)).toThrow(/encryption/i);
  });

  it('throws for empty encryptionIv (R12)', () => {
    const dto = toCreateDTO(validImageProps({ encryptionIv: '' }));
    expect(() => Media.create(dto)).toThrow(/encryption/i);
  });

  it('throws for empty uploaderId', () => {
    const dto = toCreateDTO(validImageProps({ uploaderId: '' }));
    expect(() => Media.create(dto)).toThrow(/uploader/i);
  });

  it('throws for whitespace-only uploaderId', () => {
    const dto = toCreateDTO(validImageProps({ uploaderId: '   ' }));
    expect(() => Media.create(dto)).toThrow(/uploader/i);
  });

  it('throws for empty fileName', () => {
    const dto = toCreateDTO(validImageProps({ fileName: '' }));
    expect(() => Media.create(dto)).toThrow(/file name/i);
  });

  it('calls validateMimeType and validateFileSize internally', () => {
    // Invalid MIME type should be caught by create()
    const dto = toCreateDTO(validImageProps({ mimeType: 'application/x-invalid' }));
    expect(() => Media.create(dto)).toThrow();

    // Oversized file should be caught by create()
    const dtoLarge = toCreateDTO(validImageProps({
      fileSize: SIZE_LIMITS.MAX_UPLOAD_BYTES + 1,
    }));
    expect(() => Media.create(dtoLarge)).toThrow();
  });

  it('generates a unique UUID for each created media', () => {
    const dto = toCreateDTO(validImageProps());
    const m1 = Media.create(dto);
    const m2 = Media.create(dto);
    expect(m1.id).not.toBe(m2.id);
  });
});

// ===========================================================================
// Phase 5: Thumbnail Validation Tests — CRITICAL (R27)
// ===========================================================================

describe('thumbnail validation', () => {
  it('hasThumbnail() returns true for IMAGE with thumbnail set', () => {
    const media = new Media(validImageProps());
    expect(media.hasThumbnail()).toBe(true);
  });

  it('hasThumbnail() returns false for VIDEO without thumbnail', () => {
    const media = new Media(validImageProps({
      type: MediaType.VIDEO,
      mimeType: 'video/mp4',
      thumbnail: undefined,
    }));
    expect(media.hasThumbnail()).toBe(false);
  });

  it('IMAGE type created via factory passes thumbnail validation', () => {
    const dto = toCreateDTO(validImageProps());
    const media = Media.create(dto);
    expect(() => media.validateThumbnail()).not.toThrow();
  });

  it('thumbnail width within SIZE_LIMITS.THUMBNAIL_MAX_DIMENSION_PX (200px)', () => {
    const media = new Media(validImageProps({
      thumbnail: validThumbnail({ width: SIZE_LIMITS.THUMBNAIL_MAX_DIMENSION_PX }),
    }));
    expect(() => media.validateThumbnail()).not.toThrow();
  });

  it('thumbnail height within SIZE_LIMITS.THUMBNAIL_MAX_DIMENSION_PX (200px)', () => {
    const media = new Media(validImageProps({
      thumbnail: validThumbnail({ height: SIZE_LIMITS.THUMBNAIL_MAX_DIMENSION_PX }),
    }));
    expect(() => media.validateThumbnail()).not.toThrow();
  });

  it('throws when thumbnail width exceeds THUMBNAIL_MAX_DIMENSION_PX', () => {
    const media = new Media(validImageProps({
      thumbnail: validThumbnail({ width: SIZE_LIMITS.THUMBNAIL_MAX_DIMENSION_PX + 1 }),
    }));
    expect(() => media.validateThumbnail()).toThrow(/width/i);
  });

  it('throws when thumbnail height exceeds THUMBNAIL_MAX_DIMENSION_PX', () => {
    const media = new Media(validImageProps({
      thumbnail: validThumbnail({ height: SIZE_LIMITS.THUMBNAIL_MAX_DIMENSION_PX + 1 }),
    }));
    expect(() => media.validateThumbnail()).toThrow(/height/i);
  });

  it('thumbnail must have its own separate encryptionKey (R27)', () => {
    const media = new Media(validImageProps({
      thumbnail: validThumbnail({ encryptionKey: '' }),
    }));
    expect(() => media.validateThumbnail()).toThrow(/encryption/i);
  });

  it('thumbnail must have its own separate encryptionIv (R27)', () => {
    const media = new Media(validImageProps({
      thumbnail: validThumbnail({ encryptionIv: '' }),
    }));
    expect(() => media.validateThumbnail()).toThrow(/encryption/i);
  });

  it('THUMBNAIL_MAX_DIMENSION_PX constant equals 200', () => {
    expect(SIZE_LIMITS.THUMBNAIL_MAX_DIMENSION_PX).toBe(200);
  });

  it('validateThumbnail() returns immediately for non-IMAGE types', () => {
    const media = new Media(validVoiceNoteProps());
    // Should not throw even though no thumbnail is present
    expect(() => media.validateThumbnail()).not.toThrow();
  });
});

// ===========================================================================
// Phase 6: Encryption Metadata Validation Tests (R12)
// ===========================================================================

describe('encryption metadata', () => {
  it('validateEncryptionMetadata() passes with valid key and iv', () => {
    const media = new Media(validImageProps());
    expect(() => media.validateEncryptionMetadata()).not.toThrow();
  });

  it('validateEncryptionMetadata() fails with empty encryptionKey', () => {
    const media = new Media(validImageProps({ encryptionKey: '' }));
    expect(() => media.validateEncryptionMetadata()).toThrow(/encryption/i);
  });

  it('validateEncryptionMetadata() fails with whitespace-only encryptionKey', () => {
    const media = new Media(validImageProps({ encryptionKey: '   ' }));
    expect(() => media.validateEncryptionMetadata()).toThrow(/encryption/i);
  });

  it('validateEncryptionMetadata() fails with empty encryptionIv', () => {
    const media = new Media(validImageProps({ encryptionIv: '' }));
    expect(() => media.validateEncryptionMetadata()).toThrow(/encryption/i);
  });

  it('validateEncryptionMetadata() fails with whitespace-only encryptionIv', () => {
    const media = new Media(validImageProps({ encryptionIv: '   ' }));
    expect(() => media.validateEncryptionMetadata()).toThrow(/encryption/i);
  });

  it('thumbnail has separate encryption metadata from main media', () => {
    const thumb = validThumbnail();
    const props = validImageProps({ thumbnail: thumb });
    const media = new Media(props);

    // Main media keys and thumbnail keys must be independent
    expect(media.encryptionKey).not.toBe(media.thumbnail!.encryptionKey);
    expect(media.encryptionIv).not.toBe(media.thumbnail!.encryptionIv);
  });

  it('validateEncryptionMetadata() checks thumbnail encryption when thumbnail present', () => {
    const media = new Media(validImageProps({
      thumbnail: validThumbnail({ encryptionKey: '' }),
    }));
    expect(() => media.validateEncryptionMetadata()).toThrow(/thumbnail/i);
  });

  it('validateEncryptionMetadata() checks thumbnail IV when thumbnail present', () => {
    const media = new Media(validImageProps({
      thumbnail: validThumbnail({ encryptionIv: '' }),
    }));
    expect(() => media.validateEncryptionMetadata()).toThrow(/thumbnail/i);
  });
});

// ===========================================================================
// Phase 7: Type Guard Tests
// ===========================================================================

describe('type guards', () => {
  it('isImage() returns true for MediaType.IMAGE', () => {
    const media = new Media(validImageProps());
    expect(media.isImage()).toBe(true);
  });

  it('isImage() returns false for non-IMAGE types', () => {
    const media = new Media(validVoiceNoteProps());
    expect(media.isImage()).toBe(false);
  });

  it('isVideo() returns true for MediaType.VIDEO', () => {
    const media = new Media(validImageProps({
      type: MediaType.VIDEO,
      mimeType: 'video/mp4',
      thumbnail: undefined,
    }));
    expect(media.isVideo()).toBe(true);
  });

  it('isVideo() returns false for non-VIDEO types', () => {
    const media = new Media(validImageProps());
    expect(media.isVideo()).toBe(false);
  });

  it('isDocument() returns true for MediaType.DOCUMENT', () => {
    const media = new Media(validImageProps({
      type: MediaType.DOCUMENT,
      mimeType: 'application/pdf',
      thumbnail: undefined,
    }));
    expect(media.isDocument()).toBe(true);
  });

  it('isDocument() returns false for non-DOCUMENT types', () => {
    const media = new Media(validImageProps());
    expect(media.isDocument()).toBe(false);
  });

  it('isVoiceNote() returns true for MediaType.VOICE_NOTE', () => {
    const media = new Media(validVoiceNoteProps());
    expect(media.isVoiceNote()).toBe(true);
  });

  it('isVoiceNote() returns false for non-VOICE_NOTE types', () => {
    const media = new Media(validImageProps());
    expect(media.isVoiceNote()).toBe(false);
  });

  it('type guards are mutually exclusive', () => {
    const image = new Media(validImageProps());
    expect([image.isImage(), image.isVideo(), image.isDocument(), image.isVoiceNote()]
      .filter(Boolean).length).toBe(1);

    const voiceNote = new Media(validVoiceNoteProps());
    expect([voiceNote.isImage(), voiceNote.isVideo(), voiceNote.isDocument(), voiceNote.isVoiceNote()]
      .filter(Boolean).length).toBe(1);

    const video = new Media(validImageProps({
      type: MediaType.VIDEO,
      mimeType: 'video/mp4',
      thumbnail: undefined,
    }));
    expect([video.isImage(), video.isVideo(), video.isDocument(), video.isVoiceNote()]
      .filter(Boolean).length).toBe(1);

    const doc = new Media(validImageProps({
      type: MediaType.DOCUMENT,
      mimeType: 'application/pdf',
      thumbnail: undefined,
    }));
    expect([doc.isImage(), doc.isVideo(), doc.isDocument(), doc.isVoiceNote()]
      .filter(Boolean).length).toBe(1);
  });
});

// ===========================================================================
// Phase 8: Utility Method Tests
// ===========================================================================

describe('utility methods', () => {
  describe('hasWaveform()', () => {
    it('returns true for voice note with waveform data', () => {
      const media = new Media(validVoiceNoteProps());
      expect(media.hasWaveform()).toBe(true);
    });

    it('returns false for image (no waveform)', () => {
      const media = new Media(validImageProps());
      expect(media.hasWaveform()).toBe(false);
    });

    it('returns false when waveform is empty array', () => {
      const media = new Media(validVoiceNoteProps({ waveform: [] }));
      expect(media.hasWaveform()).toBe(false);
    });
  });

  describe('isAssociatedWithMessage()', () => {
    it('returns true when messageId is set', () => {
      const media = new Media(validImageProps({ messageId: 'msg-1' }));
      expect(media.isAssociatedWithMessage()).toBe(true);
    });

    it('returns false when messageId is undefined', () => {
      const media = new Media(validImageProps({ messageId: undefined }));
      expect(media.isAssociatedWithMessage()).toBe(false);
    });
  });

  describe('isAssociatedWithStory()', () => {
    it('returns true when storyId is set', () => {
      const media = new Media(validImageProps({ storyId: 'story-1' }));
      expect(media.isAssociatedWithStory()).toBe(true);
    });

    it('returns false when storyId is undefined', () => {
      const media = new Media(validImageProps({ storyId: undefined }));
      expect(media.isAssociatedWithStory()).toBe(false);
    });
  });

  describe('getFileSizeFormatted()', () => {
    it('returns "500.0 KB" for 500 * 1024 bytes', () => {
      const media = new Media(validImageProps({ fileSize: 500 * 1024 }));
      expect(media.getFileSizeFormatted()).toBe('500.0 KB');
    });

    it('returns "2.0 MB" for 2 * 1024 * 1024 bytes', () => {
      const media = new Media(validImageProps({ fileSize: 2 * 1024 * 1024 }));
      expect(media.getFileSizeFormatted()).toBe('2.0 MB');
    });

    it('returns "512 B" for 512 bytes', () => {
      const media = new Media(validImageProps({ fileSize: 512 }));
      expect(media.getFileSizeFormatted()).toBe('512 B');
    });

    it('returns "1.0 KB" for exactly 1024 bytes', () => {
      const media = new Media(validImageProps({ fileSize: 1024 }));
      expect(media.getFileSizeFormatted()).toBe('1.0 KB');
    });

    it('returns "1.0 MB" for exactly 1 MB', () => {
      const media = new Media(validImageProps({ fileSize: 1024 * 1024 }));
      expect(media.getFileSizeFormatted()).toBe('1.0 MB');
    });
  });

  describe('getDimensionsString()', () => {
    it('returns "1920x1080" for image with dimensions', () => {
      const media = new Media(validImageProps({ width: 1920, height: 1080 }));
      expect(media.getDimensionsString()).toBe('1920x1080');
    });

    it('returns undefined when no dimensions set', () => {
      const media = new Media(validVoiceNoteProps({ width: undefined, height: undefined }));
      expect(media.getDimensionsString()).toBeUndefined();
    });

    it('returns undefined when only width is set', () => {
      const media = new Media(validImageProps({ width: 800, height: undefined }));
      expect(media.getDimensionsString()).toBeUndefined();
    });
  });

  describe('getDurationFormatted()', () => {
    it('returns "0:14" for 14-second voice note', () => {
      const media = new Media(validVoiceNoteProps({ duration: 14 }));
      expect(media.getDurationFormatted()).toBe('0:14');
    });

    it('returns "1:05" for 65-second duration', () => {
      const media = new Media(validVoiceNoteProps({ duration: 65 }));
      expect(media.getDurationFormatted()).toBe('1:05');
    });

    it('returns "0:00" for 0-second duration', () => {
      const media = new Media(validVoiceNoteProps({ duration: 0 }));
      expect(media.getDurationFormatted()).toBe('0:00');
    });

    it('returns undefined when no duration set', () => {
      const media = new Media(validImageProps({ duration: undefined }));
      expect(media.getDurationFormatted()).toBeUndefined();
    });

    it('returns "10:00" for 600-second duration', () => {
      const media = new Media(validVoiceNoteProps({ duration: 600 }));
      expect(media.getDurationFormatted()).toBe('10:00');
    });
  });
});

// ===========================================================================
// Phase 9: Serialization Tests — toResponse()
// ===========================================================================

describe('toResponse()', () => {
  it('returns all expected fields for IMAGE media', () => {
    const media = new Media(validImageProps());
    const response = media.toResponse();

    expect(response.id).toBe('media-1');
    expect(response.uploaderId).toBe('user-1');
    expect(response.type).toBe(MediaType.IMAGE);
    expect(response.mimeType).toBe('image/jpeg');
    expect(response.fileName).toBe('photo.jpg');
    expect(response.fileSize).toBe(2 * 1024 * 1024);
    expect(response.url).toBe('https://example.com/encrypted.blob');
    expect(response.encryptionKey).toBe('media-key-base64');
    expect(response.encryptionIv).toBe('media-iv-base64');
    expect(response.width).toBe(1920);
    expect(response.height).toBe(1080);
  });

  it('includes thumbnail metadata when present', () => {
    const media = new Media(validImageProps());
    const response = media.toResponse();

    expect(response.thumbnail).toBeDefined();
    expect(response.thumbnail!.url).toBe('https://example.com/thumb.enc');
    expect(response.thumbnail!.width).toBe(150);
    expect(response.thumbnail!.height).toBe(100);
    expect(response.thumbnail!.encryptionKey).toBe('thumb-key-base64');
    expect(response.thumbnail!.encryptionIv).toBe('thumb-iv-base64');
  });

  it('includes waveform when present', () => {
    const media = new Media(validVoiceNoteProps());
    const response = media.toResponse();

    expect(response.waveform).toEqual([0.1, 0.3, 0.5, 0.8, 0.4, 0.2]);
  });

  it('converts Date fields to ISO 8601 strings', () => {
    const fixedDate = new Date('2024-07-01T12:00:00.000Z');
    const media = new Media(validImageProps({ createdAt: fixedDate }));
    const response = media.toResponse();

    expect(typeof response.createdAt).toBe('string');
    expect(response.createdAt).toBe('2024-07-01T12:00:00.000Z');
  });

  it('does not include messageId or storyId in response', () => {
    const media = new Media(validImageProps({ messageId: 'msg-1', storyId: 'story-1' }));
    const response = media.toResponse();

    // MediaResponse interface does not define messageId or storyId
    expect('messageId' in response).toBe(false);
    expect('storyId' in response).toBe(false);
  });

  it('does not include updatedAt in response', () => {
    const media = new Media(validImageProps());
    const response = media.toResponse();

    expect('updatedAt' in response).toBe(false);
  });

  it('returns undefined thumbnail for non-IMAGE media', () => {
    const media = new Media(validVoiceNoteProps());
    const response = media.toResponse();

    expect(response.thumbnail).toBeUndefined();
  });

  it('returns a defensive copy of waveform (not reference equality)', () => {
    const media = new Media(validVoiceNoteProps());
    const r1 = media.toResponse();
    const r2 = media.toResponse();

    expect(r1.waveform).toEqual(r2.waveform);
    expect(r1.waveform).not.toBe(r2.waveform);
  });
});

// ===========================================================================
// Phase 10: Edge Cases
// ===========================================================================

describe('edge cases', () => {
  it('exactly 25 MB passes file size validation (boundary test)', () => {
    const exactBytes = SIZE_LIMITS.MAX_UPLOAD_BYTES; // 26,214,400
    expect(() => Media.validateFileSize(exactBytes)).not.toThrow();
  });

  it('25 MB + 1 byte fails file size validation', () => {
    expect(() => Media.validateFileSize(SIZE_LIMITS.MAX_UPLOAD_BYTES + 1)).toThrow();
  });

  it('IMAGE without thumbnail in factory throws (R27)', () => {
    const dto = toCreateDTO(validImageProps({ thumbnail: undefined }));
    expect(() => Media.create(dto)).toThrow(/thumbnail/i);
  });

  it('VOICE_NOTE without waveform in factory throws', () => {
    const dto = toCreateDTO(validVoiceNoteProps({ waveform: undefined }));
    expect(() => Media.create(dto)).toThrow(/waveform/i);
  });

  it('VIDEO type without thumbnail does NOT throw (thumbnail only required for IMAGE)', () => {
    const dto = toCreateDTO(validImageProps({
      type: MediaType.VIDEO,
      mimeType: 'video/mp4',
      thumbnail: undefined,
      width: undefined,
      height: undefined,
    }));
    expect(() => Media.create(dto)).not.toThrow();
  });

  it('DOCUMENT type without thumbnail does NOT throw', () => {
    const dto = toCreateDTO(validImageProps({
      type: MediaType.DOCUMENT,
      mimeType: 'application/pdf',
      thumbnail: undefined,
      width: undefined,
      height: undefined,
    }));
    expect(() => Media.create(dto)).not.toThrow();
  });

  it('constructor creates defensive copy of thumbnail', () => {
    const thumb = validThumbnail();
    const media = new Media(validImageProps({ thumbnail: thumb }));

    // Mutating the original should not affect the Media instance
    thumb.url = 'MUTATED';
    expect(media.thumbnail!.url).toBe('https://example.com/thumb.enc');
  });

  it('constructor creates defensive copy of waveform', () => {
    const waveform = [0.1, 0.5, 0.9];
    const media = new Media(validVoiceNoteProps({ waveform }));

    // Mutating the original should not affect the Media instance
    waveform.push(1.0);
    expect(media.waveform).toEqual([0.1, 0.5, 0.9]);
  });

  it('getter returns defensive copy of waveform (not same reference)', () => {
    const media = new Media(validVoiceNoteProps());
    const w1 = media.waveform;
    const w2 = media.waveform;
    expect(w1).toEqual(w2);
    expect(w1).not.toBe(w2);
  });

  it('getter returns defensive copy of thumbnail (not same reference)', () => {
    const media = new Media(validImageProps());
    const t1 = media.thumbnail;
    const t2 = media.thumbnail;
    expect(t1).toEqual(t2);
    expect(t1).not.toBe(t2);
  });
});

// ===========================================================================
// Getter Accessor Coverage
// ===========================================================================

describe('getter accessors', () => {
  it('exposes all MediaProps fields via getters', () => {
    const props = validImageProps();
    const media = new Media(props);

    expect(media.id).toBe(props.id);
    expect(media.uploaderId).toBe(props.uploaderId);
    expect(media.type).toBe(props.type);
    expect(media.mimeType).toBe(props.mimeType);
    expect(media.fileName).toBe(props.fileName);
    expect(media.fileSize).toBe(props.fileSize);
    expect(media.url).toBe(props.url);
    expect(media.encryptionKey).toBe(props.encryptionKey);
    expect(media.encryptionIv).toBe(props.encryptionIv);
    expect(media.width).toBe(props.width);
    expect(media.height).toBe(props.height);
    expect(media.duration).toBe(props.duration);
    expect(media.messageId).toBe(props.messageId);
    expect(media.storyId).toBe(props.storyId);
    expect(media.createdAt).toEqual(props.createdAt);
    expect(media.updatedAt).toEqual(props.updatedAt);
  });

  it('exposes VOICE_NOTE-specific fields via getters', () => {
    const props = validVoiceNoteProps();
    const media = new Media(props);

    expect(media.duration).toBe(14);
    expect(media.waveform).toEqual([0.1, 0.3, 0.5, 0.8, 0.4, 0.2]);
  });
});
