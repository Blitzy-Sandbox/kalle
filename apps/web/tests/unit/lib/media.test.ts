/**
 * @file media.test.ts
 * Unit tests for the client-side media processing module (apps/web/src/lib/media.ts).
 *
 * Covers 9 test suites:
 *   Suite 1  — validateMimeType: MIME type allowlist validation (R8)
 *   Suite 2  — validateFileSize: 25 MB file size enforcement (R8)
 *   Suite 3  — getMediaTypeFromFile: MediaType classification from MIME (R8)
 *   Suite 4  — generateThumbnail: Client-side thumbnail generation (R27)
 *   Suite 5  — encryptMedia: AES-GCM 256-bit media encryption (R12)
 *   Suite 6  — decryptMedia: AES-GCM media decryption (R12)
 *   Suite 7  — encryptMedia → decryptMedia round-trip (R12)
 *   Suite 8  — arrayBufferToBase64 / base64ToArrayBuffer: Encoding helpers
 *   Suite 9  — uploadMedia: Full upload pipeline (R8, R12, R27)
 *   Suite 10 — getMediaUrl: URL construction
 *
 * Test framework: Vitest 1.6.x with jsdom environment
 * Zero console.log statements (R28)
 * TypeScript strict mode compatible (R7)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MediaType,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_THUMBNAIL_DIMENSION,
} from '@kalle/shared';

// ---------------------------------------------------------------------------
// Module-level mock declarations (vi.hoisted ensures availability in vi.mock factory)
// ---------------------------------------------------------------------------

const {
  mockUploadFormData,
  mockApiClient,
} = vi.hoisted(() => ({
  mockUploadFormData: vi.fn(),
  mockApiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  apiClient: mockApiClient,
  uploadFormData: mockUploadFormData,
  API_BASE_URL: 'http://localhost:3001',
}));

// ---------------------------------------------------------------------------
// Import module-under-test AFTER mocks are configured
// ---------------------------------------------------------------------------

import {
  validateMimeType,
  validateFileSize,
  generateThumbnail,
  encryptMedia,
  decryptMedia,
  uploadMedia,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  getMediaUrl,
  getMediaTypeFromFile,
} from '@/lib/media';

// ---------------------------------------------------------------------------
// Web Crypto API mocks
// ---------------------------------------------------------------------------

const mockGenerateKey = vi.fn();
const mockEncryptFn = vi.fn();
const mockDecryptFn = vi.fn();
const mockExportKey = vi.fn();
const mockImportKey = vi.fn();
const mockGetRandomValues = vi.fn();

// ---------------------------------------------------------------------------
// Canvas API mocks for thumbnail generation (R27)
// ---------------------------------------------------------------------------

const mockDrawImage = vi.fn();
const mockToBlob = vi.fn();
let mockCanvasElement: {
  getContext: ReturnType<typeof vi.fn>;
  toBlob: ReturnType<typeof vi.fn>;
  width: number;
  height: number;
};

// ---------------------------------------------------------------------------
// Helper to create a mock Image class with configurable dimensions
// ---------------------------------------------------------------------------

function createMockImageClass(width: number, height: number) {
  return class MockImage {
    width = 0;
    height = 0;
    naturalWidth = 0;
    naturalHeight = 0;
    onload: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;

    set src(_: string) {
      setTimeout(() => {
        this.width = width;
        this.height = height;
        this.naturalWidth = width;
        this.naturalHeight = height;
        if (this.onload) {
          this.onload();
        }
      }, 0);
    }
  };
}

// ---------------------------------------------------------------------------
// Polyfill Blob.prototype.arrayBuffer for jsdom (does not provide it natively)
// ---------------------------------------------------------------------------

if (typeof Blob.prototype.arrayBuffer !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Blob.prototype as any).arrayBuffer = function (): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this as Blob);
    });
  };
}

// ---------------------------------------------------------------------------
// Global test lifecycle hooks
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Stub Web Crypto API
  mockGetRandomValues.mockImplementation((arr: Uint8Array) => {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = i % 256;
    }
    return arr;
  });

  vi.stubGlobal('crypto', {
    subtle: {
      generateKey: mockGenerateKey,
      encrypt: mockEncryptFn,
      decrypt: mockDecryptFn,
      exportKey: mockExportKey,
      importKey: mockImportKey,
    },
    getRandomValues: mockGetRandomValues,
  });

  // Stub Canvas API
  mockCanvasElement = {
    getContext: vi.fn().mockReturnValue({
      drawImage: mockDrawImage,
    }),
    toBlob: mockToBlob,
    width: 0,
    height: 0,
  };

  const originalCreateElement = globalThis.document?.createElement?.bind(
    globalThis.document,
  );
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'canvas') {
      return mockCanvasElement as unknown as HTMLCanvasElement;
    }
    if (originalCreateElement) {
      return originalCreateElement(tag);
    }
    return {} as HTMLElement;
  });

  // Stub Image constructor (landscape 1200×800 by default)
  vi.stubGlobal('Image', createMockImageClass(1200, 800));

  // Stub URL.createObjectURL / revokeObjectURL
  vi.stubGlobal('URL', {
    ...globalThis.URL,
    createObjectURL: vi.fn().mockReturnValue('blob:mock-url'),
    revokeObjectURL: vi.fn(),
  });

  // Reset upload mock
  mockUploadFormData.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 1: validateMimeType — MIME Type Validation (R8)
// ═══════════════════════════════════════════════════════════════════════════

describe('validateMimeType', () => {
  // --- IMAGE MIME types ---

  it('should accept image/jpeg as valid IMAGE type', () => {
    const file = new File(['data'], 'test.jpg', { type: 'image/jpeg' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.IMAGE);
  });

  it('should accept image/png as valid IMAGE type', () => {
    const file = new File(['data'], 'test.png', { type: 'image/png' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.IMAGE);
  });

  it('should accept image/gif as valid IMAGE type', () => {
    const file = new File(['data'], 'test.gif', { type: 'image/gif' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.IMAGE);
  });

  it('should accept image/webp as valid IMAGE type', () => {
    const file = new File(['data'], 'test.webp', { type: 'image/webp' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.IMAGE);
  });

  // --- VIDEO MIME types ---

  it('should accept video/mp4 as valid VIDEO type', () => {
    const file = new File(['data'], 'test.mp4', { type: 'video/mp4' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.VIDEO);
  });

  it('should accept video/webm as valid VIDEO type', () => {
    const file = new File(['data'], 'test.webm', { type: 'video/webm' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.VIDEO);
  });

  it('should accept video/quicktime as valid VIDEO type', () => {
    const file = new File(['data'], 'test.mov', { type: 'video/quicktime' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.VIDEO);
  });

  // --- DOCUMENT MIME types ---

  it('should accept application/pdf as valid DOCUMENT type', () => {
    const file = new File(['data'], 'test.pdf', { type: 'application/pdf' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.DOCUMENT);
  });

  it('should accept text/plain as valid DOCUMENT type', () => {
    const file = new File(['data'], 'test.txt', { type: 'text/plain' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.DOCUMENT);
  });

  it('should accept text/csv as valid DOCUMENT type', () => {
    const file = new File(['data'], 'test.csv', { type: 'text/csv' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.DOCUMENT);
  });

  it('should accept application/msword as valid DOCUMENT type', () => {
    const file = new File(['data'], 'test.doc', { type: 'application/msword' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.DOCUMENT);
  });

  // --- VOICE_NOTE MIME types ---

  it('should accept audio/ogg as valid VOICE_NOTE type', () => {
    const file = new File(['data'], 'test.ogg', { type: 'audio/ogg' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.VOICE_NOTE);
  });

  it('should accept audio/webm as valid VOICE_NOTE type', () => {
    const file = new File(['data'], 'test.weba', { type: 'audio/webm' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.VOICE_NOTE);
  });

  it('should accept audio/mp4 as valid VOICE_NOTE type', () => {
    const file = new File(['data'], 'test.m4a', { type: 'audio/mp4' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.VOICE_NOTE);
  });

  it('should accept audio/mpeg as valid VOICE_NOTE type', () => {
    const file = new File(['data'], 'test.mp3', { type: 'audio/mpeg' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.VOICE_NOTE);
  });

  it('should accept audio/opus as valid VOICE_NOTE type', () => {
    const file = new File(['data'], 'test.opus', { type: 'audio/opus' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.VOICE_NOTE);
  });

  // --- Disallowed MIME types ---

  it('should reject application/x-msdownload (executable) as invalid', () => {
    const file = new File(['data'], 'test.exe', { type: 'application/x-msdownload' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(false);
    expect(result.mediaType).toBeNull();
  });

  it('should reject empty MIME type as invalid', () => {
    const file = new File(['data'], 'test.unknown', { type: '' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(false);
    expect(result.mediaType).toBeNull();
  });

  it('should reject application/javascript as invalid', () => {
    const file = new File(['data'], 'test.js', { type: 'application/javascript' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(false);
    expect(result.mediaType).toBeNull();
  });

  it('should reject text/html as invalid', () => {
    const file = new File(['data'], 'test.html', { type: 'text/html' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(false);
    expect(result.mediaType).toBeNull();
  });

  it('should reject application/xml as invalid', () => {
    const file = new File(['data'], 'test.xml', { type: 'application/xml' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(false);
    expect(result.mediaType).toBeNull();
  });

  it('should handle MIME type case-insensitively', () => {
    const file = new File(['data'], 'test.jpg', { type: 'IMAGE/JPEG' });
    const result = validateMimeType(file);
    expect(result.valid).toBe(true);
    expect(result.mediaType).toBe(MediaType.IMAGE);
  });

  it('should verify ALLOWED_MIME_TYPES constant contains expected categories', () => {
    expect(ALLOWED_MIME_TYPES).toHaveProperty(MediaType.IMAGE);
    expect(ALLOWED_MIME_TYPES).toHaveProperty(MediaType.VIDEO);
    expect(ALLOWED_MIME_TYPES).toHaveProperty(MediaType.DOCUMENT);
    expect(ALLOWED_MIME_TYPES).toHaveProperty(MediaType.VOICE_NOTE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 2: validateFileSize — File Size Validation (R8)
// ═══════════════════════════════════════════════════════════════════════════

describe('validateFileSize', () => {
  it('should accept files well under 25 MB', () => {
    const file = new File([new ArrayBuffer(1024)], 'small.jpg', {
      type: 'image/jpeg',
    });
    expect(validateFileSize(file)).toBe(true);
  });

  it('should accept files exactly at 25 MB limit (MAX_FILE_SIZE)', () => {
    const file = new File([], 'max.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: MAX_FILE_SIZE });
    expect(validateFileSize(file)).toBe(true);
  });

  it('should reject files exceeding 25 MB by 1 byte', () => {
    const file = new File([], 'too-large.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: MAX_FILE_SIZE + 1 });
    expect(validateFileSize(file)).toBe(false);
  });

  it('should reject files far exceeding 25 MB', () => {
    const file = new File([], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: 100 * 1024 * 1024 });
    expect(validateFileSize(file)).toBe(false);
  });

  it('should accept zero-byte files', () => {
    const file = new File([], 'empty.jpg', { type: 'image/jpeg' });
    expect(validateFileSize(file)).toBe(true);
  });

  it('should accept a 1-byte file', () => {
    const file = new File(['x'], 'tiny.jpg', { type: 'image/jpeg' });
    expect(validateFileSize(file)).toBe(true);
  });

  it('should verify MAX_FILE_SIZE equals 25 * 1024 * 1024 bytes', () => {
    expect(MAX_FILE_SIZE).toBe(25 * 1024 * 1024);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 3: getMediaTypeFromFile — MediaType Classification
// ═══════════════════════════════════════════════════════════════════════════

describe('getMediaTypeFromFile', () => {
  it('should return MediaType.IMAGE for image/jpeg', () => {
    const file = new File(['data'], 'photo.jpg', { type: 'image/jpeg' });
    expect(getMediaTypeFromFile(file)).toBe(MediaType.IMAGE);
  });

  it('should return MediaType.VIDEO for video/mp4', () => {
    const file = new File(['data'], 'clip.mp4', { type: 'video/mp4' });
    expect(getMediaTypeFromFile(file)).toBe(MediaType.VIDEO);
  });

  it('should return MediaType.DOCUMENT for application/pdf', () => {
    const file = new File(['data'], 'doc.pdf', { type: 'application/pdf' });
    expect(getMediaTypeFromFile(file)).toBe(MediaType.DOCUMENT);
  });

  it('should return MediaType.VOICE_NOTE for audio/ogg', () => {
    const file = new File(['data'], 'voice.ogg', { type: 'audio/ogg' });
    expect(getMediaTypeFromFile(file)).toBe(MediaType.VOICE_NOTE);
  });

  it('should return null for disallowed MIME types', () => {
    const file = new File(['data'], 'script.js', { type: 'application/javascript' });
    expect(getMediaTypeFromFile(file)).toBeNull();
  });

  it('should return null for empty MIME type', () => {
    const file = new File(['data'], 'unknown', { type: '' });
    expect(getMediaTypeFromFile(file)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 4: generateThumbnail — Client-Side Thumbnail Generation (R27)
// ═══════════════════════════════════════════════════════════════════════════

describe('generateThumbnail', () => {
  /**
   * Helper that configures the mock canvas toBlob to resolve with a JPEG blob.
   */
  function setupToBlobSuccess(): void {
    mockToBlob.mockImplementation(
      (cb: (blob: Blob | null) => void, _type?: string, _quality?: number) => {
        cb(new Blob(['thumbnail-data'], { type: 'image/jpeg' }));
      },
    );
  }

  it('should produce max 200px longest edge for landscape image (1200×800 → 200×133)', async () => {
    vi.stubGlobal('Image', createMockImageClass(1200, 800));
    setupToBlobSuccess();

    const file = new File(['image-data'], 'photo.jpg', { type: 'image/jpeg' });
    const result = await generateThumbnail(file);

    expect(result.width).toBe(200);
    expect(result.height).toBe(133);
    expect(result.blob).toBeInstanceOf(Blob);
  });

  it('should produce max 200px longest edge for portrait image (800×1200 → 133×200)', async () => {
    vi.stubGlobal('Image', createMockImageClass(800, 1200));
    setupToBlobSuccess();

    const file = new File(['image-data'], 'portrait.jpg', { type: 'image/jpeg' });
    const result = await generateThumbnail(file);

    expect(result.width).toBe(133);
    expect(result.height).toBe(200);
  });

  it('should produce max 200px for square image (600×600 → 200×200)', async () => {
    vi.stubGlobal('Image', createMockImageClass(600, 600));
    setupToBlobSuccess();

    const file = new File(['image-data'], 'square.jpg', { type: 'image/jpeg' });
    const result = await generateThumbnail(file);

    expect(result.width).toBe(200);
    expect(result.height).toBe(200);
  });

  it('should not upscale small images (100×50 stays 100×50)', async () => {
    vi.stubGlobal('Image', createMockImageClass(100, 50));
    setupToBlobSuccess();

    const file = new File(['image-data'], 'small.jpg', { type: 'image/jpeg' });
    const result = await generateThumbnail(file);

    expect(result.width).toBe(100);
    expect(result.height).toBe(50);
  });

  it('should not upscale images exactly at MAX_THUMBNAIL_DIMENSION (200×150)', async () => {
    vi.stubGlobal('Image', createMockImageClass(200, 150));
    setupToBlobSuccess();

    const file = new File(['image-data'], 'exact.jpg', { type: 'image/jpeg' });
    const result = await generateThumbnail(file);

    expect(result.width).toBe(200);
    expect(result.height).toBe(150);
  });

  it('should maintain aspect ratio when scaling down', async () => {
    vi.stubGlobal('Image', createMockImageClass(1600, 900));
    setupToBlobSuccess();

    const file = new File(['image-data'], 'wide.jpg', { type: 'image/jpeg' });
    const result = await generateThumbnail(file);

    const originalRatio = 1600 / 900;
    const thumbRatio = result.width / result.height;
    expect(Math.abs(originalRatio - thumbRatio)).toBeLessThan(0.02);
  });

  it('should set canvas dimensions to computed thumbnail size', async () => {
    vi.stubGlobal('Image', createMockImageClass(1200, 800));
    setupToBlobSuccess();

    const file = new File(['image-data'], 'photo.jpg', { type: 'image/jpeg' });
    await generateThumbnail(file);

    expect(mockCanvasElement.width).toBe(200);
    expect(mockCanvasElement.height).toBe(133);
  });

  it('should call canvas drawImage with correct dimensions', async () => {
    vi.stubGlobal('Image', createMockImageClass(1200, 800));
    setupToBlobSuccess();

    const file = new File(['image-data'], 'photo.jpg', { type: 'image/jpeg' });
    await generateThumbnail(file);

    expect(mockDrawImage).toHaveBeenCalledWith(
      expect.anything(),
      0,
      0,
      200,
      133,
    );
  });

  it('should call canvas.toBlob with image/jpeg and 0.8 quality', async () => {
    vi.stubGlobal('Image', createMockImageClass(1200, 800));
    setupToBlobSuccess();

    const file = new File(['image-data'], 'photo.jpg', { type: 'image/jpeg' });
    await generateThumbnail(file);

    expect(mockToBlob).toHaveBeenCalledWith(
      expect.any(Function),
      'image/jpeg',
      0.8,
    );
  });

  it('should revoke object URL after thumbnail generation', async () => {
    vi.stubGlobal('Image', createMockImageClass(1200, 800));
    setupToBlobSuccess();

    const file = new File(['image-data'], 'photo.jpg', { type: 'image/jpeg' });
    await generateThumbnail(file);

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('should revoke object URL even when an error occurs', async () => {
    vi.stubGlobal('Image', createMockImageClass(0, 0));

    const file = new File(['image-data'], 'broken.jpg', { type: 'image/jpeg' });

    await expect(generateThumbnail(file)).rejects.toThrow();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('should verify MAX_THUMBNAIL_DIMENSION equals 200', () => {
    expect(MAX_THUMBNAIL_DIMENSION).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 5: encryptMedia — AES-GCM 256-bit Media Encryption (R12)
// ═══════════════════════════════════════════════════════════════════════════

describe('encryptMedia', () => {
  /** Shared mock setup for encryption tests */
  function setupEncryptionMocks(): void {
    mockGenerateKey.mockResolvedValue({ type: 'secret', algorithm: 'AES-GCM' });
    mockEncryptFn.mockResolvedValue(new ArrayBuffer(128));
    mockExportKey.mockResolvedValue(new ArrayBuffer(32));
  }

  it('should use AES-GCM algorithm with 256-bit key length', async () => {
    setupEncryptionMocks();

    await encryptMedia(new ArrayBuffer(1024));

    expect(mockGenerateKey).toHaveBeenCalledWith(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
  });

  it('should generate a random 12-byte initialization vector', async () => {
    setupEncryptionMocks();

    await encryptMedia(new ArrayBuffer(100));

    expect(mockGetRandomValues).toHaveBeenCalled();
    const ivArg = mockGetRandomValues.mock.calls[0][0] as Uint8Array;
    expect(ivArg).toBeInstanceOf(Uint8Array);
    expect(ivArg.length).toBe(12);
  });

  it('should call crypto.subtle.encrypt with generated key and IV', async () => {
    const mockKey = { type: 'secret' };
    mockGenerateKey.mockResolvedValue(mockKey);
    mockEncryptFn.mockResolvedValue(new ArrayBuffer(100));
    mockExportKey.mockResolvedValue(new ArrayBuffer(32));

    await encryptMedia(new ArrayBuffer(50));

    expect(mockEncryptFn).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AES-GCM' }),
      mockKey,
      expect.any(Uint8Array),
    );
  });

  it('should return base64-encoded key string', async () => {
    setupEncryptionMocks();

    const result = await encryptMedia(new ArrayBuffer(100));

    expect(typeof result.key).toBe('string');
    expect(result.key.length).toBeGreaterThan(0);
  });

  it('should return base64-encoded IV string', async () => {
    setupEncryptionMocks();

    const result = await encryptMedia(new ArrayBuffer(100));

    expect(typeof result.iv).toBe('string');
    expect(result.iv.length).toBeGreaterThan(0);
  });

  it('should return encrypted data as ArrayBuffer', async () => {
    const ciphertext = new ArrayBuffer(128);
    mockGenerateKey.mockResolvedValue({ type: 'secret' });
    mockEncryptFn.mockResolvedValue(ciphertext);
    mockExportKey.mockResolvedValue(new ArrayBuffer(32));

    const result = await encryptMedia(new ArrayBuffer(100));

    expect(result.encryptedData).toBe(ciphertext);
  });

  it('should export the key as raw bytes', async () => {
    const mockKey = { type: 'secret' };
    mockGenerateKey.mockResolvedValue(mockKey);
    mockEncryptFn.mockResolvedValue(new ArrayBuffer(100));
    mockExportKey.mockResolvedValue(new ArrayBuffer(32));

    await encryptMedia(new ArrayBuffer(100));

    expect(mockExportKey).toHaveBeenCalledWith('raw', mockKey);
  });

  it('should produce a 32-byte exported key (256 bits)', async () => {
    const rawKeyBytes = new ArrayBuffer(32);
    mockGenerateKey.mockResolvedValue({ type: 'secret' });
    mockEncryptFn.mockResolvedValue(new ArrayBuffer(100));
    mockExportKey.mockResolvedValue(rawKeyBytes);

    const result = await encryptMedia(new ArrayBuffer(100));

    // Base64 of 32 bytes should be 44 characters
    expect(result.key.length).toBe(44);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 6: decryptMedia — AES-GCM Media Decryption (R12)
// ═══════════════════════════════════════════════════════════════════════════

describe('decryptMedia', () => {
  it('should import key from base64 string using AES-GCM parameters', async () => {
    const mockKey = { type: 'secret' };
    mockImportKey.mockResolvedValue(mockKey);
    mockDecryptFn.mockResolvedValue(new ArrayBuffer(100));

    const keyBase64 = arrayBufferToBase64(new ArrayBuffer(32));
    const ivBase64 = arrayBufferToBase64(new Uint8Array(12).buffer);

    await decryptMedia(new ArrayBuffer(128), keyBase64, ivBase64);

    expect(mockImportKey).toHaveBeenCalledWith(
      'raw',
      expect.any(Uint8Array),
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
  });

  it('should call crypto.subtle.decrypt with imported key and IV', async () => {
    const mockKey = { type: 'secret' };
    mockImportKey.mockResolvedValue(mockKey);
    mockDecryptFn.mockResolvedValue(new ArrayBuffer(100));

    const keyBase64 = arrayBufferToBase64(new ArrayBuffer(32));
    const ivBase64 = arrayBufferToBase64(new Uint8Array(12).buffer);

    await decryptMedia(new ArrayBuffer(128), keyBase64, ivBase64);

    expect(mockDecryptFn).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AES-GCM' }),
      mockKey,
      expect.any(Uint8Array),
    );
  });

  it('should return decrypted data as ArrayBuffer', async () => {
    const plaintext = new ArrayBuffer(100);
    mockImportKey.mockResolvedValue({ type: 'secret' });
    mockDecryptFn.mockResolvedValue(plaintext);

    const keyBase64 = arrayBufferToBase64(new ArrayBuffer(32));
    const ivBase64 = arrayBufferToBase64(new Uint8Array(12).buffer);

    const result = await decryptMedia(new ArrayBuffer(128), keyBase64, ivBase64);

    expect(result).toBe(plaintext);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 7: encryptMedia → decryptMedia Round-Trip (R12)
// ═══════════════════════════════════════════════════════════════════════════

describe('encryptMedia → decryptMedia round-trip', () => {
  it('should return original data after encrypt then decrypt', async () => {
    const originalData = new TextEncoder().encode('Hello, encrypted media!').buffer;

    // Configure mocks to simulate a realistic round-trip
    const mockKey = { type: 'secret' };
    const encryptedBuffer = new ArrayBuffer(originalData.byteLength + 16);

    mockGenerateKey.mockResolvedValue(mockKey);
    mockEncryptFn.mockResolvedValue(encryptedBuffer);
    mockExportKey.mockResolvedValue(new ArrayBuffer(32));
    mockImportKey.mockResolvedValue(mockKey);
    mockDecryptFn.mockResolvedValue(originalData);

    const encrypted = await encryptMedia(originalData);

    expect(encrypted.encryptedData).toBe(encryptedBuffer);
    expect(typeof encrypted.key).toBe('string');
    expect(typeof encrypted.iv).toBe('string');

    const decrypted = await decryptMedia(
      encrypted.encryptedData,
      encrypted.key,
      encrypted.iv,
    );

    expect(decrypted).toBe(originalData);
  });

  it('should use the same key/IV pair across encrypt/decrypt', async () => {
    const data = new ArrayBuffer(64);
    const mockKey = { type: 'secret' };

    mockGenerateKey.mockResolvedValue(mockKey);
    mockEncryptFn.mockResolvedValue(new ArrayBuffer(80));
    mockExportKey.mockResolvedValue(new ArrayBuffer(32));
    mockImportKey.mockResolvedValue(mockKey);
    mockDecryptFn.mockResolvedValue(data);

    const encrypted = await encryptMedia(data);
    await decryptMedia(encrypted.encryptedData, encrypted.key, encrypted.iv);

    // Verify importKey received the same key bytes that exportKey produced
    expect(mockImportKey).toHaveBeenCalled();
    expect(mockDecryptFn).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 8: arrayBufferToBase64 / base64ToArrayBuffer — Encoding Helpers
// ═══════════════════════════════════════════════════════════════════════════

describe('arrayBufferToBase64', () => {
  it('should encode ArrayBuffer to a non-empty base64 string', () => {
    const buffer = new Uint8Array([72, 101, 108, 108, 111]).buffer; // "Hello"
    const base64 = arrayBufferToBase64(buffer);
    expect(typeof base64).toBe('string');
    expect(base64.length).toBeGreaterThan(0);
  });

  it('should produce known base64 for known input bytes', () => {
    // "Hello" → "SGVsbG8="
    const buffer = new Uint8Array([72, 101, 108, 108, 111]).buffer;
    const base64 = arrayBufferToBase64(buffer);
    expect(base64).toBe('SGVsbG8=');
  });

  it('should handle empty buffer', () => {
    const buffer = new ArrayBuffer(0);
    const base64 = arrayBufferToBase64(buffer);
    expect(typeof base64).toBe('string');
    expect(base64).toBe('');
  });

  it('should handle single-byte buffer', () => {
    const buffer = new Uint8Array([65]).buffer; // "A"
    const base64 = arrayBufferToBase64(buffer);
    expect(base64).toBe('QQ==');
  });

  it('should handle binary data with full byte range (0–255)', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      bytes[i] = i;
    }
    const base64 = arrayBufferToBase64(bytes.buffer);
    expect(typeof base64).toBe('string');
    expect(base64.length).toBeGreaterThan(0);
  });
});

describe('base64ToArrayBuffer', () => {
  it('should decode base64 string to ArrayBuffer', () => {
    const base64 = 'SGVsbG8='; // "Hello"
    const buffer = base64ToArrayBuffer(base64);
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(buffer.byteLength).toBe(5);
  });

  it('should produce correct bytes for known base64 input', () => {
    const buffer = base64ToArrayBuffer('SGVsbG8=');
    const view = new Uint8Array(buffer);
    expect(Array.from(view)).toEqual([72, 101, 108, 108, 111]);
  });

  it('should handle empty string', () => {
    const buffer = base64ToArrayBuffer('');
    expect(buffer.byteLength).toBe(0);
  });

  it('should handle single character base64', () => {
    const buffer = base64ToArrayBuffer('QQ==');
    const view = new Uint8Array(buffer);
    expect(view[0]).toBe(65); // "A"
  });
});

describe('Base64 round-trip', () => {
  it('should round-trip "Hello" bytes through encode → decode', () => {
    const original = new Uint8Array([72, 101, 108, 108, 111]).buffer;
    const base64 = arrayBufferToBase64(original);
    const decoded = base64ToArrayBuffer(base64);
    expect(new Uint8Array(decoded)).toEqual(new Uint8Array(original));
  });

  it('should round-trip empty buffer', () => {
    const original = new ArrayBuffer(0);
    const base64 = arrayBufferToBase64(original);
    const decoded = base64ToArrayBuffer(base64);
    expect(decoded.byteLength).toBe(0);
  });

  it('should round-trip full byte range (0–255)', () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      original[i] = i;
    }
    const base64 = arrayBufferToBase64(original.buffer);
    const decoded = base64ToArrayBuffer(base64);
    expect(new Uint8Array(decoded)).toEqual(original);
  });

  it('should round-trip large buffer (4096 bytes)', () => {
    const original = new Uint8Array(4096);
    for (let i = 0; i < 4096; i++) {
      original[i] = i % 256;
    }
    const base64 = arrayBufferToBase64(original.buffer);
    const decoded = base64ToArrayBuffer(base64);
    expect(new Uint8Array(decoded)).toEqual(original);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 9: uploadMedia — Full Upload Pipeline (R8, R12, R27)
// ═══════════════════════════════════════════════════════════════════════════

describe('uploadMedia', () => {
  /** Sets up all mocks for a successful upload flow */
  function setupSuccessfulUploadMocks(): void {
    // Web Crypto mocks
    mockGenerateKey.mockResolvedValue({ type: 'secret' });
    mockEncryptFn.mockResolvedValue(new ArrayBuffer(100));
    mockExportKey.mockResolvedValue(new ArrayBuffer(32));

    // Canvas/thumbnail mocks
    mockToBlob.mockImplementation(
      (cb: (blob: Blob | null) => void) => {
        cb(new Blob(['thumb'], { type: 'image/jpeg' }));
      },
    );

    // Upload mock
    mockUploadFormData.mockResolvedValue({
      id: 'media-123',
      uploaderId: 'user-1',
      type: MediaType.IMAGE,
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
      fileSize: 100,
      url: 'http://localhost:3001/api/v1/media/media-123',
    });
  }

  it('should reject files with invalid MIME type before processing', async () => {
    const file = new File(['data'], 'test.exe', { type: 'application/x-msdownload' });
    await expect(uploadMedia(file)).rejects.toThrow('Unsupported file type');
  });

  it('should reject files exceeding MAX_FILE_SIZE before processing', async () => {
    const file = new File([], 'big.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: MAX_FILE_SIZE + 1 });
    await expect(uploadMedia(file)).rejects.toThrow(/exceeds the maximum/);
  });

  it('should reject files with empty MIME type', async () => {
    const file = new File(['data'], 'no-type', { type: '' });
    await expect(uploadMedia(file)).rejects.toThrow('Unsupported file type');
  });

  it('should call encryptMedia for valid image files', async () => {
    setupSuccessfulUploadMocks();
    vi.stubGlobal('Image', createMockImageClass(400, 300));

    const file = new File(['image-data'], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: 1024 });

    await uploadMedia(file);

    // generateKey should be called at least twice: once for file, once for thumbnail
    expect(mockGenerateKey).toHaveBeenCalled();
    expect(mockEncryptFn).toHaveBeenCalled();
  });

  it('should generate thumbnail for IMAGE type (R27)', async () => {
    setupSuccessfulUploadMocks();
    vi.stubGlobal('Image', createMockImageClass(800, 600));

    const file = new File(['image-data'], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: 2048 });

    await uploadMedia(file);

    // Canvas should have been used for thumbnail generation
    expect(mockDrawImage).toHaveBeenCalled();
    expect(mockToBlob).toHaveBeenCalled();
  });

  it('should NOT generate thumbnail for DOCUMENT type', async () => {
    mockGenerateKey.mockResolvedValue({ type: 'secret' });
    mockEncryptFn.mockResolvedValue(new ArrayBuffer(100));
    mockExportKey.mockResolvedValue(new ArrayBuffer(32));
    mockUploadFormData.mockResolvedValue({
      id: 'media-456',
      uploaderId: 'user-1',
      type: MediaType.DOCUMENT,
      mimeType: 'application/pdf',
      fileName: 'doc.pdf',
      fileSize: 100,
      url: 'http://localhost:3001/api/v1/media/media-456',
    });

    const file = new File(['doc-data'], 'doc.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 1024 });

    await uploadMedia(file);

    // Thumbnail generation (drawImage / toBlob) should NOT have been called
    expect(mockDrawImage).not.toHaveBeenCalled();
  });

  it('should NOT generate thumbnail for VIDEO type', async () => {
    mockGenerateKey.mockResolvedValue({ type: 'secret' });
    mockEncryptFn.mockResolvedValue(new ArrayBuffer(100));
    mockExportKey.mockResolvedValue(new ArrayBuffer(32));
    mockUploadFormData.mockResolvedValue({
      id: 'media-789',
      uploaderId: 'user-1',
      type: MediaType.VIDEO,
      mimeType: 'video/mp4',
      fileName: 'clip.mp4',
      fileSize: 100,
      url: 'http://localhost:3001/api/v1/media/media-789',
    });

    const file = new File(['video-data'], 'clip.mp4', { type: 'video/mp4' });
    Object.defineProperty(file, 'size', { value: 2048 });

    await uploadMedia(file);

    expect(mockDrawImage).not.toHaveBeenCalled();
  });

  it('should NOT generate thumbnail for VOICE_NOTE type', async () => {
    mockGenerateKey.mockResolvedValue({ type: 'secret' });
    mockEncryptFn.mockResolvedValue(new ArrayBuffer(100));
    mockExportKey.mockResolvedValue(new ArrayBuffer(32));
    mockUploadFormData.mockResolvedValue({
      id: 'media-audio',
      uploaderId: 'user-1',
      type: MediaType.VOICE_NOTE,
      mimeType: 'audio/ogg',
      fileName: 'voice.ogg',
      fileSize: 100,
      url: 'http://localhost:3001/api/v1/media/media-audio',
    });

    const file = new File(['audio-data'], 'voice.ogg', { type: 'audio/ogg' });
    Object.defineProperty(file, 'size', { value: 512 });

    await uploadMedia(file);

    expect(mockDrawImage).not.toHaveBeenCalled();
  });

  it('should call onProgress with encrypting status', async () => {
    setupSuccessfulUploadMocks();
    vi.stubGlobal('Image', createMockImageClass(400, 300));

    const onProgress = vi.fn();
    const file = new File(['image-data'], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: 1024 });

    await uploadMedia(file, { onProgress });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'encrypting' }),
    );
  });

  it('should call onProgress with uploading status', async () => {
    setupSuccessfulUploadMocks();
    vi.stubGlobal('Image', createMockImageClass(400, 300));

    const onProgress = vi.fn();
    const file = new File(['image-data'], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: 1024 });

    await uploadMedia(file, { onProgress });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'uploading' }),
    );
  });

  it('should call onProgress with complete status on success', async () => {
    setupSuccessfulUploadMocks();
    vi.stubGlobal('Image', createMockImageClass(400, 300));

    const onProgress = vi.fn();
    const file = new File(['image-data'], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: 1024 });

    await uploadMedia(file, { onProgress });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'complete', progress: 100 }),
    );
  });

  it('should call onProgress with error status on upload failure', async () => {
    mockGenerateKey.mockResolvedValue({ type: 'secret' });
    mockEncryptFn.mockResolvedValue(new ArrayBuffer(100));
    mockExportKey.mockResolvedValue(new ArrayBuffer(32));
    mockUploadFormData.mockRejectedValue(new Error('Network error'));

    const onProgress = vi.fn();
    const file = new File(['data'], 'doc.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 1024 });

    await expect(uploadMedia(file, { onProgress })).rejects.toThrow('Network error');

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('should call uploadFormData with the media upload endpoint', async () => {
    setupSuccessfulUploadMocks();

    const file = new File(['doc-data'], 'doc.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 512 });

    await uploadMedia(file);

    expect(mockUploadFormData).toHaveBeenCalledWith(
      '/api/v1/media',
      expect.any(FormData),
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
  });

  it('should return server response on successful upload', async () => {
    setupSuccessfulUploadMocks();

    const file = new File(['doc-data'], 'doc.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 512 });

    const result = await uploadMedia(file);

    expect(result).toEqual(expect.objectContaining({ id: 'media-123' }));
  });

  it('should work without onProgress callback', async () => {
    setupSuccessfulUploadMocks();

    const file = new File(['doc-data'], 'doc.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 512 });

    const result = await uploadMedia(file);

    expect(result.id).toBe('media-123');
  });

  it('should pass messageId and storyId options through to metadata', async () => {
    setupSuccessfulUploadMocks();

    const file = new File(['doc-data'], 'doc.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 512 });

    await uploadMedia(file, { messageId: 'msg-1', storyId: 'story-1' });

    expect(mockUploadFormData).toHaveBeenCalled();
    const formDataArg = mockUploadFormData.mock.calls[0][1] as FormData;
    const metadataJson = formDataArg.get('metadata') as string;
    const metadata = JSON.parse(metadataJson);
    expect(metadata.messageId).toBe('msg-1');
    expect(metadata.storyId).toBe('story-1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 10: getMediaUrl — URL Construction
// ═══════════════════════════════════════════════════════════════════════════

describe('getMediaUrl', () => {
  it('should construct URL with API_BASE_URL and media ID', () => {
    const url = getMediaUrl('abc-123');
    expect(url).toBe('http://localhost:3001/api/v1/media/abc-123');
  });

  it('should handle UUID-format media IDs', () => {
    const url = getMediaUrl('550e8400-e29b-41d4-a716-446655440000');
    expect(url).toBe(
      'http://localhost:3001/api/v1/media/550e8400-e29b-41d4-a716-446655440000',
    );
  });

  it('should include /api/v1/ prefix (R30)', () => {
    const url = getMediaUrl('test-id');
    expect(url).toContain('/api/v1/media/');
  });
});
