/**
 * @module MediaService.test
 *
 * Comprehensive unit tests for the MediaService class — the encrypted media
 * upload service handling MIME type verification against an allowlist, 25 MB
 * size enforcement, encrypted blob storage, and thumbnail handling.
 *
 * Tests validate:
 * - R8  (Media Upload Validation): 25 MB size limit (413). MIME type verified
 *       against allowlist (415). Two DISTINCT errors for two violations.
 * - R12 (E2E Encryption): Media encrypted client-side. Server stores opaque
 *       encrypted blobs — zero processing, zero decryption.
 * - R27 (Client-Side Thumbnail Generation): Thumbnails generated client-side.
 *       Server stores metadata about both full-size and thumbnail blobs.
 * - R17 (Interface-Driven Dependencies): Receives IMediaRepository and
 *       IStorageProvider via constructor injection — interfaces only.
 * - R22 (Standardized Error Responses): Typed domain errors thrown.
 * - R28 (Structured Logging Only): Zero console.log in test code.
 * - R7  (Zero Warnings Build): TypeScript strict mode, zero warnings.
 *
 * Coverage target: ≥80%
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Module-level mock — uuid must be mocked BEFORE any import that uses it
 * so that generateStorageKey() inside MediaService uses deterministic keys.
 * ──────────────────────────────────────────────────────────────────────────── */

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('mock-uuid-v4'),
}));

/* ────────────────────────────────────────────────────────────────────────────
 * Imports
 * ──────────────────────────────────────────────────────────────────────────── */

import {
  MediaService,
  type UploadMediaInput,
} from '../../../src/services/MediaService';

import type { IMediaRepository } from '../../../src/domain/interfaces/IMediaRepository';
import type { IStorageProvider } from '../../../src/domain/interfaces/IStorageProvider';

import { PayloadTooLargeError } from '../../../src/errors/PayloadTooLargeError';
import { UnsupportedMediaTypeError } from '../../../src/errors/UnsupportedMediaTypeError';
import { NotFoundError } from '../../../src/errors/NotFoundError';

import { MediaType, ALLOWED_MIME_TYPES, MAX_FILE_SIZE } from '@kalle/shared';
import type { MediaResponse } from '@kalle/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Constants
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 25 MB in bytes — the exact boundary value for size validation (R8).
 * Equals 26 214 400 bytes.
 */
const TWENTY_FIVE_MB = 25 * 1024 * 1024; // 26_214_400

/* ────────────────────────────────────────────────────────────────────────────
 * Test Data Factories
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Builds a deterministic, valid MediaResponse fixture for repository mock
 * returns. All fields are populated with sensible defaults that tests can
 * verify against.
 */
function createMediaResponse(overrides: Partial<MediaResponse> = {}): MediaResponse {
  return {
    id: 'media-uuid-001',
    uploaderId: 'user-1',
    type: MediaType.IMAGE,
    mimeType: 'image/jpeg',
    fileName: 'photo.jpg',
    fileSize: 1024,
    url: 'https://storage/media/mock-uuid-v4-photo.jpg',
    encryptionKey: 'base64key==',
    encryptionIv: 'base64iv==',
    createdAt: '2026-01-15T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * Builds a valid UploadMediaInput with sensible defaults.
 * Overrides can be applied at any depth.
 */
function createValidUpload(overrides: Partial<UploadMediaInput> = {}): UploadMediaInput {
  return {
    uploaderId: 'user-1',
    file: {
      buffer: Buffer.alloc(1024),
      originalname: 'photo.jpg',
      mimetype: 'image/jpeg',
      size: 1024,
    },
    type: MediaType.IMAGE,
    encryptionKey: 'base64key==',
    encryptionIv: 'base64iv==',
    ...overrides,
  };
}

/**
 * Builds an UploadMediaInput that includes thumbnail data (R27).
 */
function createUploadWithThumbnail(
  overrides: Partial<UploadMediaInput> = {},
): UploadMediaInput {
  return createValidUpload({
    thumbnailBuffer: Buffer.alloc(512),
    thumbnailMimetype: 'image/jpeg',
    thumbnailEncryptionKey: 'thumb-key==',
    thumbnailEncryptionIv: 'thumb-iv==',
    thumbnailWidth: 150,
    thumbnailHeight: 100,
    ...overrides,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Test Suite
 * ──────────────────────────────────────────────────────────────────────────── */

describe('MediaService', () => {
  let service: MediaService;

  /**
   * Typed mock of IMediaRepository — every repository method is a jest.fn()
   * so tests can configure return values and assert call arguments (R17).
   */
  let mockMediaRepository: jest.Mocked<IMediaRepository>;

  /**
   * Typed mock of IStorageProvider — every storage method is a jest.fn()
   * so tests can verify that encrypted blobs are delegated correctly (R12).
   */
  let mockStorageProvider: jest.Mocked<IStorageProvider>;

  /**
   * Prepare fresh mocks and a new MediaService instance before each test.
   * Mocks are reset to ensure test isolation.
   */
  beforeEach(() => {
    jest.clearAllMocks();

    mockMediaRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      findByMessage: jest.fn(),
      findByStory: jest.fn(),
      findByUploader: jest.fn(),
      delete: jest.fn(),
      deleteByStory: jest.fn(),
    };

    mockStorageProvider = {
      store: jest.fn(),
      retrieve: jest.fn(),
      delete: jest.fn(),
      exists: jest.fn(),
      getUrl: jest.fn(),
    };

    // Default: storageProvider.store resolves with a deterministic URL.
    mockStorageProvider.store.mockResolvedValue(
      'https://storage/media/mock-uuid-v4-photo.jpg',
    );

    // Default: mediaRepository.create resolves with a valid MediaResponse.
    mockMediaRepository.create.mockResolvedValue(createMediaResponse());

    // Construct service with interface-typed mocks (R17).
    service = new MediaService(mockMediaRepository, mockStorageProvider);
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * uploadMedia — Size Validation (R8)
   * ──────────────────────────────────────────────────────────────────────── */

  describe('uploadMedia — Size Validation (R8)', () => {
    it('should accept files well under 25 MB', async () => {
      const input = createValidUpload({ file: { buffer: Buffer.alloc(1024), originalname: 'small.jpg', mimetype: 'image/jpeg', size: 1024 } });

      const result = await service.uploadMedia(input);

      expect(result).toBeDefined();
      expect(result.id).toBe('media-uuid-001');
      expect(mockStorageProvider.store).toHaveBeenCalledTimes(1);
    });

    it('should accept files exactly at the 25 MB boundary', async () => {
      const input = createValidUpload({
        file: {
          buffer: Buffer.alloc(0), // buffer size doesn't matter — size field drives validation
          originalname: 'big.jpg',
          mimetype: 'image/jpeg',
          size: TWENTY_FIVE_MB,
        },
      });

      const result = await service.uploadMedia(input);

      expect(result).toBeDefined();
      expect(mockStorageProvider.store).toHaveBeenCalledTimes(1);
    });

    it('should throw PayloadTooLargeError for files exceeding 25 MB (R8)', async () => {
      const overSize = TWENTY_FIVE_MB + 1;
      const input = createValidUpload({
        file: {
          buffer: Buffer.alloc(0),
          originalname: 'too-big.jpg',
          mimetype: 'image/jpeg',
          size: overSize,
        },
      });

      await expect(service.uploadMedia(input)).rejects.toThrow(PayloadTooLargeError);

      try {
        await service.uploadMedia(input);
      } catch (error: unknown) {
        const err = error as PayloadTooLargeError;
        expect(err.statusCode).toBe(413);
        expect(err.code).toBe('PAYLOAD_TOO_LARGE');
        expect(err.details).toBeDefined();
        expect(err.details!.maxSize).toBe(MAX_FILE_SIZE);
        expect(err.details!.actualSize).toBe(overSize);
      }
    });

    it('should check size BEFORE MIME type — size validation takes priority (R8)', async () => {
      // Both violations present: oversized AND invalid MIME type.
      // Size check must fire first, yielding PayloadTooLargeError (not UnsupportedMediaTypeError).
      const input = createValidUpload({
        file: {
          buffer: Buffer.alloc(0),
          originalname: 'bad-file.exe',
          mimetype: 'application/x-executable',
          size: TWENTY_FIVE_MB + 100,
        },
      });

      await expect(service.uploadMedia(input)).rejects.toThrow(PayloadTooLargeError);
      await expect(service.uploadMedia(input)).rejects.not.toThrow(UnsupportedMediaTypeError);
    });

    it('should reject files that are 1 byte over the 25 MB limit', async () => {
      const input = createValidUpload({
        file: {
          buffer: Buffer.alloc(0),
          originalname: 'borderline.jpg',
          mimetype: 'image/jpeg',
          size: TWENTY_FIVE_MB + 1,
        },
      });

      await expect(service.uploadMedia(input)).rejects.toThrow(PayloadTooLargeError);
      expect(mockStorageProvider.store).not.toHaveBeenCalled();
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * uploadMedia — MIME Type Validation (R8)
   * ──────────────────────────────────────────────────────────────────────── */

  describe('uploadMedia — MIME Type Validation (R8)', () => {
    it('should accept allowed image MIME types', async () => {
      const imageTypes = ALLOWED_MIME_TYPES[MediaType.IMAGE];

      for (const mimetype of imageTypes) {
        jest.clearAllMocks();
        mockStorageProvider.store.mockResolvedValue(`https://storage/media/mock-uuid-v4-img`);
        mockMediaRepository.create.mockResolvedValue(
          createMediaResponse({ mimeType: mimetype as string }),
        );

        const input = createValidUpload({
          file: {
            buffer: Buffer.alloc(512),
            originalname: `test.${mimetype === 'image/jpeg' ? 'jpg' : 'png'}`,
            mimetype: mimetype as string,
            size: 512,
          },
          type: MediaType.IMAGE,
        });

        const result = await service.uploadMedia(input);
        expect(result).toBeDefined();
      }
    });

    it('should accept allowed video MIME types', async () => {
      const videoTypes = ALLOWED_MIME_TYPES[MediaType.VIDEO];

      for (const mimetype of videoTypes) {
        jest.clearAllMocks();
        mockStorageProvider.store.mockResolvedValue(`https://storage/media/mock-uuid-v4-vid`);
        mockMediaRepository.create.mockResolvedValue(
          createMediaResponse({ mimeType: mimetype as string, type: MediaType.VIDEO }),
        );

        const input = createValidUpload({
          file: {
            buffer: Buffer.alloc(2048),
            originalname: 'test.mp4',
            mimetype: mimetype as string,
            size: 2048,
          },
          type: MediaType.VIDEO,
        });

        const result = await service.uploadMedia(input);
        expect(result).toBeDefined();
      }
    });

    it('should accept allowed audio/voice-note MIME types', async () => {
      const audioTypes = ALLOWED_MIME_TYPES[MediaType.VOICE_NOTE];

      for (const mimetype of audioTypes) {
        jest.clearAllMocks();
        mockStorageProvider.store.mockResolvedValue(`https://storage/media/mock-uuid-v4-aud`);
        mockMediaRepository.create.mockResolvedValue(
          createMediaResponse({ mimeType: mimetype as string, type: MediaType.VOICE_NOTE }),
        );

        const input = createValidUpload({
          file: {
            buffer: Buffer.alloc(4096),
            originalname: 'voice.ogg',
            mimetype: mimetype as string,
            size: 4096,
          },
          type: MediaType.VOICE_NOTE,
        });

        const result = await service.uploadMedia(input);
        expect(result).toBeDefined();
      }
    });

    it('should accept allowed document MIME types', async () => {
      const docTypes = ALLOWED_MIME_TYPES[MediaType.DOCUMENT];

      for (const mimetype of docTypes) {
        jest.clearAllMocks();
        mockStorageProvider.store.mockResolvedValue(`https://storage/media/mock-uuid-v4-doc`);
        mockMediaRepository.create.mockResolvedValue(
          createMediaResponse({ mimeType: mimetype as string, type: MediaType.DOCUMENT }),
        );

        const input = createValidUpload({
          file: {
            buffer: Buffer.alloc(8192),
            originalname: 'document.pdf',
            mimetype: mimetype as string,
            size: 8192,
          },
          type: MediaType.DOCUMENT,
        });

        const result = await service.uploadMedia(input);
        expect(result).toBeDefined();
      }
    });

    it('should throw UnsupportedMediaTypeError for disallowed MIME types (R8)', async () => {
      const input = createValidUpload({
        file: {
          buffer: Buffer.alloc(256),
          originalname: 'malware.exe',
          mimetype: 'application/x-executable',
          size: 256,
        },
      });

      await expect(service.uploadMedia(input)).rejects.toThrow(UnsupportedMediaTypeError);

      try {
        await service.uploadMedia(input);
      } catch (error: unknown) {
        const err = error as UnsupportedMediaTypeError;
        expect(err.statusCode).toBe(415);
        expect(err.code).toBe('UNSUPPORTED_MEDIA_TYPE');
        expect(err.details).toBeDefined();
        expect(err.details!.mimeType).toBe('application/x-executable');
        expect(err.details!.allowedTypes).toBeDefined();
        expect(Array.isArray(err.details!.allowedTypes)).toBe(true);
      }
    });

    it('should reject executable MIME types', async () => {
      const executableTypes = ['application/x-executable', 'application/x-msdos-program'];

      for (const mimetype of executableTypes) {
        const input = createValidUpload({
          file: {
            buffer: Buffer.alloc(128),
            originalname: 'program.exe',
            mimetype,
            size: 128,
          },
        });

        await expect(service.uploadMedia(input)).rejects.toThrow(UnsupportedMediaTypeError);
      }
    });

    it('should reject script MIME types', async () => {
      const scriptTypes = ['application/javascript', 'text/html', 'application/x-httpd-php'];

      for (const mimetype of scriptTypes) {
        const input = createValidUpload({
          file: {
            buffer: Buffer.alloc(128),
            originalname: 'script.js',
            mimetype,
            size: 128,
          },
        });

        await expect(service.uploadMedia(input)).rejects.toThrow(UnsupportedMediaTypeError);
      }
    });

    it('should reject an arbitrary unknown MIME type', async () => {
      const input = createValidUpload({
        file: {
          buffer: Buffer.alloc(128),
          originalname: 'unknown.xyz',
          mimetype: 'application/x-unknown-format',
          size: 128,
        },
      });

      await expect(service.uploadMedia(input)).rejects.toThrow(UnsupportedMediaTypeError);
    });

    it('should not call storageProvider.store when MIME type is rejected', async () => {
      const input = createValidUpload({
        file: {
          buffer: Buffer.alloc(128),
          originalname: 'bad.exe',
          mimetype: 'application/x-executable',
          size: 128,
        },
      });

      await expect(service.uploadMedia(input)).rejects.toThrow(UnsupportedMediaTypeError);
      expect(mockStorageProvider.store).not.toHaveBeenCalled();
      expect(mockMediaRepository.create).not.toHaveBeenCalled();
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * uploadMedia — Storage (R12)
   * ──────────────────────────────────────────────────────────────────────── */

  describe('uploadMedia — Storage (R12)', () => {
    it('should store encrypted blob via storageProvider.store', async () => {
      const fileBuffer = Buffer.from('encrypted-content-bytes');
      const input = createValidUpload({
        file: {
          buffer: fileBuffer,
          originalname: 'photo.jpg',
          mimetype: 'image/jpeg',
          size: fileBuffer.length,
        },
      });

      await service.uploadMedia(input);

      expect(mockStorageProvider.store).toHaveBeenCalledTimes(1);
      const storeCall = mockStorageProvider.store.mock.calls[0];
      // Key must contain 'media/' prefix
      expect(storeCall[0]).toContain('media/');
      // Buffer is passed through as-is (opaque encrypted blob — R12)
      expect(storeCall[1]).toBe(fileBuffer);
      // MIME type forwarded for content-type headers
      expect(storeCall[2]).toBe('image/jpeg');
    });

    it('should create media metadata record via mediaRepository.create', async () => {
      const input = createValidUpload({
        encryptionKey: 'my-aes-key==',
        encryptionIv: 'my-aes-iv==',
      });

      await service.uploadMedia(input);

      expect(mockMediaRepository.create).toHaveBeenCalledTimes(1);
      const createArg = mockMediaRepository.create.mock.calls[0][0];
      expect(createArg.uploaderId).toBe('user-1');
      expect(createArg.type).toBe(MediaType.IMAGE);
      expect(createArg.mimeType).toBe('image/jpeg');
      expect(createArg.fileName).toBe('photo.jpg');
      expect(createArg.fileSize).toBe(1024);
      expect(createArg.encryptionKey).toBe('my-aes-key==');
      expect(createArg.encryptionIv).toBe('my-aes-iv==');
      expect(createArg.url).toBe('https://storage/media/mock-uuid-v4-photo.jpg');
    });

    it('should return MediaResponse with stored URL', async () => {
      const expectedUrl = 'https://storage/media/mock-uuid-v4-photo.jpg';
      mockStorageProvider.store.mockResolvedValue(expectedUrl);
      mockMediaRepository.create.mockResolvedValue(
        createMediaResponse({ url: expectedUrl }),
      );

      const input = createValidUpload();
      const result = await service.uploadMedia(input);

      expect(result.url).toBe(expectedUrl);
      expect(result.id).toBe('media-uuid-001');
      expect(result.uploaderId).toBe('user-1');
    });

    it('should pass through optional metadata fields (width, height, duration, waveform)', async () => {
      const waveformData = [0.1, 0.5, 0.8, 0.3, 0.9];
      const input = createValidUpload({
        width: 1920,
        height: 1080,
        duration: 30,
        waveform: waveformData,
        messageId: 'msg-123',
        storyId: 'story-456',
      });

      await service.uploadMedia(input);

      const createArg = mockMediaRepository.create.mock.calls[0][0];
      expect(createArg.width).toBe(1920);
      expect(createArg.height).toBe(1080);
      expect(createArg.duration).toBe(30);
      expect(createArg.waveform).toEqual(waveformData);
      expect(createArg.messageId).toBe('msg-123');
      expect(createArg.storyId).toBe('story-456');
    });

    it('should generate a unique storage key with media/ prefix and uuid', async () => {
      const input = createValidUpload({
        file: {
          buffer: Buffer.alloc(64),
          originalname: 'vacation.png',
          mimetype: 'image/png',
          size: 64,
        },
      });

      await service.uploadMedia(input);

      const key = mockStorageProvider.store.mock.calls[0][0];
      expect(key).toMatch(/^media\//);
      expect(key).toContain('mock-uuid-v4');
      expect(key).toContain('vacation.png');
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * uploadMedia — Thumbnail Handling (R27)
   * ──────────────────────────────────────────────────────────────────────── */

  describe('uploadMedia — Thumbnail Handling (R27)', () => {
    it('should store thumbnail as separate blob when provided', async () => {
      mockStorageProvider.store
        .mockResolvedValueOnce('https://storage/media/mock-uuid-v4-photo.jpg')
        .mockResolvedValueOnce('https://storage/media/thumb/mock-uuid-v4-thumb.bin');

      const input = createUploadWithThumbnail();

      await service.uploadMedia(input);

      // storageProvider.store must be called TWICE: full-size + thumbnail
      expect(mockStorageProvider.store).toHaveBeenCalledTimes(2);

      // First call: full-size encrypted blob
      const firstCall = mockStorageProvider.store.mock.calls[0];
      expect(firstCall[0]).toContain('media/');

      // Second call: thumbnail blob with 'thumb' in key
      const secondCall = mockStorageProvider.store.mock.calls[1];
      expect(secondCall[0]).toContain('thumb');
    });

    it('should include thumbnail metadata in the media record', async () => {
      mockStorageProvider.store
        .mockResolvedValueOnce('https://storage/media/full.jpg')
        .mockResolvedValueOnce('https://storage/media/thumb/thumb.bin');

      mockMediaRepository.create.mockResolvedValue(
        createMediaResponse({
          thumbnail: {
            url: 'https://storage/media/thumb/thumb.bin',
            width: 150,
            height: 100,
            encryptionKey: 'thumb-key==',
            encryptionIv: 'thumb-iv==',
          },
        }),
      );

      const input = createUploadWithThumbnail();

      await service.uploadMedia(input);

      const createArg = mockMediaRepository.create.mock.calls[0][0];
      expect(createArg.thumbnailUrl).toBe('https://storage/media/thumb/thumb.bin');
      expect(createArg.thumbnailWidth).toBe(150);
      expect(createArg.thumbnailHeight).toBe(100);
      expect(createArg.thumbnailEncryptionKey).toBe('thumb-key==');
      expect(createArg.thumbnailEncryptionIv).toBe('thumb-iv==');
    });

    it('should not store thumbnail when thumbnailBuffer is not provided', async () => {
      const input = createValidUpload(); // No thumbnail fields

      await service.uploadMedia(input);

      // storageProvider.store called only ONCE (full-size blob only)
      expect(mockStorageProvider.store).toHaveBeenCalledTimes(1);
    });

    it('should not include thumbnail metadata when thumbnail is absent', async () => {
      const input = createValidUpload();

      await service.uploadMedia(input);

      const createArg = mockMediaRepository.create.mock.calls[0][0];
      expect(createArg.thumbnailUrl).toBeUndefined();
      expect(createArg.thumbnailWidth).toBeUndefined();
      expect(createArg.thumbnailHeight).toBeUndefined();
    });

    it('should use fallback MIME type for thumbnail when thumbnailMimetype is omitted', async () => {
      mockStorageProvider.store
        .mockResolvedValueOnce('https://storage/media/full.jpg')
        .mockResolvedValueOnce('https://storage/media/thumb/thumb.bin');

      const input = createUploadWithThumbnail({
        thumbnailMimetype: undefined, // Omitted — should default to application/octet-stream
      });

      await service.uploadMedia(input);

      // Second store call (thumbnail) should use fallback content type
      const thumbStoreCall = mockStorageProvider.store.mock.calls[1];
      expect(thumbStoreCall[2]).toBe('application/octet-stream');
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * getMediaById
   * ──────────────────────────────────────────────────────────────────────── */

  describe('getMediaById', () => {
    it('should return media when found by ID', async () => {
      const expectedMedia = createMediaResponse({ id: 'media-999' });
      mockMediaRepository.findById.mockResolvedValue(expectedMedia);

      const result = await service.getMediaById('media-999');

      expect(result).toEqual(expectedMedia);
      expect(mockMediaRepository.findById).toHaveBeenCalledWith('media-999');
    });

    it('should throw NotFoundError when media does not exist', async () => {
      mockMediaRepository.findById.mockResolvedValue(null);

      await expect(service.getMediaById('nonexistent-id')).rejects.toThrow(NotFoundError);

      try {
        await service.getMediaById('nonexistent-id');
      } catch (error: unknown) {
        const err = error as NotFoundError;
        expect(err.statusCode).toBe(404);
        expect(err.code).toBe('NOT_FOUND');
        expect(err.details).toBeDefined();
        expect(err.details!.resource).toBe('Media');
        expect(err.details!.id).toBe('nonexistent-id');
      }
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * getMediaByMessage
   * ──────────────────────────────────────────────────────────────────────── */

  describe('getMediaByMessage', () => {
    it('should delegate to mediaRepository.findByMessage and return results', async () => {
      const mediaList = [
        createMediaResponse({ id: 'media-1' }),
        createMediaResponse({ id: 'media-2' }),
      ];
      mockMediaRepository.findByMessage.mockResolvedValue(mediaList);

      const result = await service.getMediaByMessage('msg-abc');

      expect(result).toEqual(mediaList);
      expect(result).toHaveLength(2);
      expect(mockMediaRepository.findByMessage).toHaveBeenCalledWith('msg-abc');
    });

    it('should return empty array when no media is associated with the message', async () => {
      mockMediaRepository.findByMessage.mockResolvedValue([]);

      const result = await service.getMediaByMessage('msg-no-media');

      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * getMediaByStory
   * ──────────────────────────────────────────────────────────────────────── */

  describe('getMediaByStory', () => {
    it('should delegate to mediaRepository.findByStory and return results', async () => {
      const mediaList = [createMediaResponse({ id: 'story-media-1' })];
      mockMediaRepository.findByStory.mockResolvedValue(mediaList);

      const result = await service.getMediaByStory('story-xyz');

      expect(result).toEqual(mediaList);
      expect(mockMediaRepository.findByStory).toHaveBeenCalledWith('story-xyz');
    });

    it('should return empty array when no media is associated with the story', async () => {
      mockMediaRepository.findByStory.mockResolvedValue([]);

      const result = await service.getMediaByStory('story-empty');

      expect(result).toEqual([]);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * deleteMedia
   * ──────────────────────────────────────────────────────────────────────── */

  describe('deleteMedia', () => {
    it('should delete from storage and repository', async () => {
      const media = createMediaResponse({
        id: 'media-to-delete',
        url: 'https://storage/media/blob-key',
      });
      mockMediaRepository.findById.mockResolvedValue(media);
      mockStorageProvider.delete.mockResolvedValue(undefined);
      mockMediaRepository.delete.mockResolvedValue(undefined);

      await service.deleteMedia('media-to-delete');

      // Verify storage blob deleted
      expect(mockStorageProvider.delete).toHaveBeenCalledWith('https://storage/media/blob-key');
      // Verify metadata record deleted
      expect(mockMediaRepository.delete).toHaveBeenCalledWith('media-to-delete');
    });

    it('should also delete thumbnail from storage when thumbnail exists', async () => {
      const media = createMediaResponse({
        id: 'media-with-thumb',
        url: 'https://storage/media/full-blob-key',
        thumbnail: {
          url: 'https://storage/media/thumb/thumb-blob-key',
          width: 150,
          height: 100,
          encryptionKey: 'thumb-key==',
          encryptionIv: 'thumb-iv==',
        },
      });
      mockMediaRepository.findById.mockResolvedValue(media);
      mockStorageProvider.delete.mockResolvedValue(undefined);
      mockMediaRepository.delete.mockResolvedValue(undefined);

      await service.deleteMedia('media-with-thumb');

      // storageProvider.delete called TWICE: primary blob + thumbnail blob
      expect(mockStorageProvider.delete).toHaveBeenCalledTimes(2);
      expect(mockStorageProvider.delete).toHaveBeenCalledWith(
        'https://storage/media/full-blob-key',
      );
      expect(mockStorageProvider.delete).toHaveBeenCalledWith(
        'https://storage/media/thumb/thumb-blob-key',
      );
      expect(mockMediaRepository.delete).toHaveBeenCalledWith('media-with-thumb');
    });

    it('should only delete primary blob when no thumbnail exists', async () => {
      const media = createMediaResponse({
        id: 'media-no-thumb',
        url: 'https://storage/media/blob',
      });
      // Ensure thumbnail is explicitly undefined
      delete (media as unknown as Record<string, unknown>).thumbnail;
      mockMediaRepository.findById.mockResolvedValue(media);
      mockStorageProvider.delete.mockResolvedValue(undefined);
      mockMediaRepository.delete.mockResolvedValue(undefined);

      await service.deleteMedia('media-no-thumb');

      // storageProvider.delete called only ONCE (primary blob only)
      expect(mockStorageProvider.delete).toHaveBeenCalledTimes(1);
      expect(mockStorageProvider.delete).toHaveBeenCalledWith('https://storage/media/blob');
    });

    it('should throw NotFoundError when media to delete does not exist', async () => {
      mockMediaRepository.findById.mockResolvedValue(null);

      await expect(service.deleteMedia('nonexistent')).rejects.toThrow(NotFoundError);

      try {
        await service.deleteMedia('nonexistent');
      } catch (error: unknown) {
        const err = error as NotFoundError;
        expect(err.statusCode).toBe(404);
        expect(err.code).toBe('NOT_FOUND');
      }
    });

    it('should not attempt storage or repository delete when media is not found', async () => {
      mockMediaRepository.findById.mockResolvedValue(null);

      await expect(service.deleteMedia('ghost')).rejects.toThrow(NotFoundError);

      expect(mockStorageProvider.delete).not.toHaveBeenCalled();
      expect(mockMediaRepository.delete).not.toHaveBeenCalled();
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Constructor — Interface-Driven Dependencies (R17)
   * ──────────────────────────────────────────────────────────────────────── */

  describe('Constructor — Interface-Driven Dependencies (R17)', () => {
    it('should accept IMediaRepository and IStorageProvider as constructor arguments', () => {
      // If constructor rejects incorrect shapes, this would throw.
      const svc = new MediaService(mockMediaRepository, mockStorageProvider);
      expect(svc).toBeInstanceOf(MediaService);
    });
  });
});
