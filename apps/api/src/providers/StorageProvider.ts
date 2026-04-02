/**
 * @file StorageProvider.ts — Local Filesystem Storage Implementation
 *
 * Concrete implementation of the IStorageProvider interface. Stores encrypted
 * media blobs on the local filesystem under a configurable upload directory.
 * Designed for the Docker development environment where media files are stored
 * in a Docker volume mount. The interface is swappable for cloud storage
 * (S3, GCS) in production without changing any service code.
 *
 * Architecture Rules Enforced:
 * - R17: Interface-Driven Dependencies — only the composition root (server.ts)
 *        imports this concrete class. All other consumers import IStorageProvider.
 * - R12: E2E Encryption Integrity — stores OPAQUE encrypted blobs. Zero knowledge
 *        of content. No decryption, no content inspection, no MIME sniffing.
 * - R8:  Media Upload Validation — 25MB size limit enforced at controller/service
 *        layer, NOT here. The storage provider stores whatever it receives.
 * - R28: Structured Logging Only — zero console.log calls.
 * - R7:  Zero Warnings Build — compiles under tsc --noEmit --strict with zero warnings.
 * - R38: Zero External Dependencies — uses only Node.js built-in fs and path modules.
 */

import fs from 'fs/promises';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { IStorageProvider } from '../domain/interfaces/IStorageProvider';

/**
 * Local filesystem storage provider for encrypted media blobs.
 *
 * Stores files under a configurable base directory, creating subdirectories
 * as needed based on the storage key structure. All file content is treated
 * as opaque — no content inspection, validation, or transformation is performed.
 *
 * @example
 * ```typescript
 * // Instantiation in composition root (server.ts)
 * const storage = new StorageProvider(env.UPLOAD_DIR || './uploads');
 *
 * // Storing an encrypted blob
 * const url = await storage.store('media/uuid-photo.enc', encryptedBuffer);
 * // url => '/uploads/media/uuid-photo.enc'
 *
 * // Retrieving the encrypted blob
 * const data = await storage.retrieve('media/uuid-photo.enc');
 * // data => Buffer containing the encrypted bytes
 * ```
 */
export class StorageProvider implements IStorageProvider {
  /**
   * Absolute path to the base upload directory on the local filesystem.
   * Resolved from the uploadDir constructor parameter via path.resolve().
   */
  private readonly basePath: string;

  /**
   * Creates a new StorageProvider instance.
   *
   * Synchronous directory creation in the constructor is intentional — the
   * base upload directory MUST exist before the server accepts any storage
   * requests. This runs exactly once at boot time.
   *
   * @param uploadDir - Configurable upload directory path. In Docker, this is
   *                    typically '/app/uploads' via volume mount. Defaults to
   *                    './uploads' for local development. Relative paths are
   *                    resolved to absolute via path.resolve().
   */
  constructor(uploadDir: string) {
    this.basePath = path.resolve(uploadDir);

    // Synchronous boot-time initialization: ensure base directory exists
    // before the server can process any storage requests.
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
    }
  }

  /**
   * Store an encrypted blob on the local filesystem and return its access URL.
   *
   * Creates any necessary subdirectories based on the key structure. For example,
   * a key of 'media/uuid-photo.enc' will create the 'media/' subdirectory under
   * the base upload path if it does not already exist.
   *
   * The contentType parameter is accepted for interface compatibility with cloud
   * storage implementations but is not used for local filesystem storage.
   *
   * @param key - Unique storage key/path for the file (e.g., 'media/uuid-filename').
   *              Forward slashes are treated as directory separators.
   * @param data - File content as a Node.js Buffer. This is the raw encrypted blob
   *               uploaded by the client — the provider does not modify or inspect it.
   * @param contentType - Optional MIME type. Accepted for interface compatibility but
   *                      not used in local filesystem storage. Could be persisted as
   *                      a sidecar metadata file in future implementations.
   * @returns URL path to access the stored file (e.g., '/uploads/media/uuid-filename').
   */
  async store(key: string, data: Buffer, contentType?: string): Promise<string> {
    const filePath = this.getFilePath(key);

    // Ensure the subdirectory tree exists for nested keys
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // Write the encrypted blob to disk — no transformation applied
    await fs.writeFile(filePath, data);

    // Return URL-friendly relative path for API access.
    // In production cloud implementations, this would return a CDN or pre-signed URL.
    // contentType parameter is available for future metadata sidecar support
    void contentType;
    return `/uploads/${this.sanitizeKeyForUrl(key)}`;
  }

  /**
   * Retrieve an encrypted blob from the local filesystem.
   *
   * Returns the raw byte content as a Buffer. The caller (client-side code)
   * is responsible for decrypting the content.
   *
   * @param key - Storage key/path of the file (as used in the original store() call).
   * @returns File content as a Node.js Buffer.
   * @throws Error with descriptive message if the file does not exist (ENOENT)
   *         or if any other filesystem error occurs (permissions, disk failure).
   */
  async retrieve(key: string): Promise<Buffer> {
    const filePath = this.getFilePath(key);

    try {
      return await fs.readFile(filePath);
    } catch (error: unknown) {
      if (this.isErrnoException(error) && error.code === 'ENOENT') {
        throw new Error(`File not found: ${key}`);
      }
      throw error;
    }
  }

  /**
   * Delete a file from the local filesystem by its storage key.
   *
   * This operation is idempotent — calling delete on a non-existent key
   * completes successfully without throwing an error. This simplifies
   * cleanup logic in callers such as the story cleanup job (R11, R35)
   * and message delete operations.
   *
   * @param key - Storage key/path of the file to delete.
   * @throws Error for filesystem errors other than ENOENT (e.g., permission denied).
   */
  async delete(key: string): Promise<void> {
    const filePath = this.getFilePath(key);

    try {
      await fs.unlink(filePath);
    } catch (error: unknown) {
      // Idempotent: silently ignore file-not-found errors
      if (this.isErrnoException(error) && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  /**
   * Check if a file exists at the given storage key.
   *
   * Uses fs.access() to check file accessibility without reading content.
   * Returns false for any error condition (missing file, permission denied, etc.).
   *
   * @param key - Storage key/path to check.
   * @returns `true` if a file exists and is accessible, `false` otherwise.
   */
  async exists(key: string): Promise<boolean> {
    const filePath = this.getFilePath(key);

    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the public URL for an already-stored file.
   *
   * For local filesystem storage, returns a relative URL path that matches
   * the Express static file serving configuration (express.static(uploadDir)
   * mounted at the '/uploads' route).
   *
   * No existence check is performed — callers should use exists() first
   * if they need to verify the file is present.
   *
   * @param key - Storage key/path of an existing file.
   * @returns URL path to access the file (e.g., '/uploads/media/uuid-file').
   */
  async getUrl(key: string): Promise<string> {
    // For local filesystem, return the relative URL path.
    // Cloud storage implementations would return pre-signed URLs or CDN URLs.
    return `/uploads/${this.sanitizeKeyForUrl(key)}`;
  }

  /**
   * Resolve a storage key to an absolute filesystem path.
   *
   * Sanitizes the key to prevent directory traversal attacks by:
   * 1. Removing all '..' path segments (prevents escaping the upload directory)
   * 2. Stripping leading '/' (prevents absolute path injection)
   * 3. Using path.join() for OS-appropriate path construction
   *
   * @param key - Storage key to resolve.
   * @returns Absolute filesystem path within the base upload directory.
   */
  private getFilePath(key: string): string {
    // Sanitize key to prevent directory traversal attacks
    const sanitizedKey = key.replace(/\.\./g, '').replace(/^\//, '');
    return path.join(this.basePath, sanitizedKey);
  }

  /**
   * Sanitize a storage key for URL construction.
   *
   * Applies the same traversal prevention as getFilePath but returns
   * the sanitized key string (not a full filesystem path) for URL building.
   *
   * @param key - Storage key to sanitize.
   * @returns Sanitized key safe for URL inclusion.
   */
  private sanitizeKeyForUrl(key: string): string {
    return key.replace(/\.\./g, '').replace(/^\//, '');
  }

  /**
   * Type guard for Node.js filesystem errors (NodeJS.ErrnoException).
   *
   * Used to safely narrow unknown error types in catch blocks for
   * checking the .code property (e.g., 'ENOENT', 'EACCES').
   *
   * @param error - The caught error value.
   * @returns True if the error has a 'code' property (ErrnoException shape).
   */
  private isErrnoException(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
  }
}
