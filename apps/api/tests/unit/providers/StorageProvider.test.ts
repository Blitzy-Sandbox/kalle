/**
 * @file StorageProvider.test.ts — Unit tests for local filesystem StorageProvider
 *
 * Tests all IStorageProvider interface methods: store, retrieve, delete, exists,
 * getUrl — plus constructor directory creation and path sanitization.
 */

import path from 'path';

// Mock fs/promises BEFORE importing StorageProvider
const mockMkdir = jest.fn().mockResolvedValue(undefined);
const mockWriteFile = jest.fn().mockResolvedValue(undefined);
const mockReadFile = jest.fn();
const mockUnlink = jest.fn();
const mockAccess = jest.fn();

jest.mock('fs/promises', () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  unlink: mockUnlink,
  access: mockAccess,
}));

// Mock synchronous fs
const mockExistsSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.mock('fs', () => ({
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
}));

import { StorageProvider } from '../../../src/providers/StorageProvider';

describe('StorageProvider', () => {
  const testUploadDir = '/tmp/test-uploads';
  let storage: StorageProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: directory exists so constructor won't create it
    mockExistsSync.mockReturnValue(true);
    storage = new StorageProvider(testUploadDir);
  });

  // ---- constructor ----
  describe('constructor', () => {
    it('should create base directory if it does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      new StorageProvider('/tmp/new-uploads');
      expect(mockMkdirSync).toHaveBeenCalledWith(
        path.resolve('/tmp/new-uploads'),
        { recursive: true },
      );
    });

    it('should not create directory if it already exists', () => {
      mockExistsSync.mockReturnValue(true);
      new StorageProvider('/tmp/existing-uploads');
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });
  });

  // ---- store ----
  describe('store()', () => {
    it('should create subdirectory and write file', async () => {
      const data = Buffer.from('encrypted-blob');
      const url = await storage.store('media/photo.enc', data);

      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining('media'),
        { recursive: true },
      );
      expect(mockWriteFile).toHaveBeenCalledWith(
        path.join(path.resolve(testUploadDir), 'media/photo.enc'),
        data,
      );
      expect(url).toBe('/uploads/media/photo.enc');
    });

    it('should accept optional contentType parameter without effect', async () => {
      const data = Buffer.from('blob');
      const url = await storage.store('file.enc', data, 'image/png');
      expect(url).toBe('/uploads/file.enc');
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('should sanitize directory traversal in key', async () => {
      const data = Buffer.from('data');
      const url = await storage.store('../../../etc/passwd', data);
      expect(url).not.toContain('..');
    });
  });

  // ---- retrieve ----
  describe('retrieve()', () => {
    it('should return file content as buffer', async () => {
      const content = Buffer.from('encrypted-data');
      mockReadFile.mockResolvedValue(content);
      const result = await storage.retrieve('media/photo.enc');
      expect(result).toBe(content);
    });

    it('should throw descriptive error for missing file (ENOENT)', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadFile.mockRejectedValue(error);
      await expect(storage.retrieve('missing.enc')).rejects.toThrow('File not found: missing.enc');
    });

    it('should re-throw non-ENOENT errors', async () => {
      const error = new Error('EACCES') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      mockReadFile.mockRejectedValue(error);
      await expect(storage.retrieve('file.enc')).rejects.toThrow('EACCES');
    });
  });

  // ---- delete ----
  describe('delete()', () => {
    it('should unlink the file', async () => {
      mockUnlink.mockResolvedValue(undefined);
      await storage.delete('media/photo.enc');
      expect(mockUnlink).toHaveBeenCalledWith(
        path.join(path.resolve(testUploadDir), 'media/photo.enc'),
      );
    });

    it('should silently ignore ENOENT (idempotent delete)', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockUnlink.mockRejectedValue(error);
      await expect(storage.delete('missing.enc')).resolves.toBeUndefined();
    });

    it('should re-throw non-ENOENT errors', async () => {
      const error = new Error('EACCES') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      mockUnlink.mockRejectedValue(error);
      await expect(storage.delete('file.enc')).rejects.toThrow('EACCES');
    });
  });

  // ---- exists ----
  describe('exists()', () => {
    it('should return true when file is accessible', async () => {
      mockAccess.mockResolvedValue(undefined);
      const result = await storage.exists('media/photo.enc');
      expect(result).toBe(true);
    });

    it('should return false when access throws', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      const result = await storage.exists('missing.enc');
      expect(result).toBe(false);
    });
  });

  // ---- getUrl ----
  describe('getUrl()', () => {
    it('should return URL path for the key', async () => {
      const url = await storage.getUrl('media/photo.enc');
      expect(url).toBe('/uploads/media/photo.enc');
    });

    it('should sanitize directory traversal in URL', async () => {
      const url = await storage.getUrl('../secret/file');
      expect(url).not.toContain('..');
    });
  });
});
