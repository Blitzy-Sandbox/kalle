/**
 * @file IStorageProvider.ts
 * @description Storage provider contract abstracting file storage for encrypted media blobs.
 *
 * In the local development environment, the concrete implementation
 * (`apps/api/src/providers/StorageProvider.ts`) uses the local filesystem.
 * This interface is designed to be swappable for cloud storage (S3, GCS)
 * in production without changing any service code.
 *
 * Architecture Rules:
 * - R17: Services code against this interface — never import StorageProvider concrete class.
 * - R12: Media is encrypted client-side before upload. The storage provider stores and
 *         retrieves opaque encrypted blobs — it has ZERO knowledge of content.
 * - R8:  25MB size limit is enforced at the controller/service layer, NOT here.
 *        The storage provider stores whatever it receives.
 * - R16: Provider interface abstracting infrastructure (file system). Zero business logic.
 * - R7:  TypeScript strict mode, zero warnings.
 * - R28: Zero console.log calls.
 */

/**
 * Contract for file storage operations on encrypted media blobs.
 *
 * All methods are asynchronous to support both local filesystem and remote
 * cloud storage implementations (S3, GCS, Azure Blob Storage, etc.).
 *
 * The storage provider is content-agnostic — it treats all data as opaque
 * byte buffers. Encryption, decryption, MIME validation, and size enforcement
 * are the responsibility of the service and controller layers.
 */
export interface IStorageProvider {
  /**
   * Store a file (encrypted blob) and return its access URL.
   *
   * The concrete implementation determines the physical storage location
   * (local directory, S3 bucket, GCS bucket, etc.) based on the provided key.
   *
   * @param key - Unique storage key/path for the file (e.g., 'media/uuid-filename').
   *              The key serves as a logical path and must be unique within the
   *              storage namespace. Forward slashes are treated as directory separators.
   * @param data - File content as a Node.js Buffer. This is the raw encrypted blob
   *               uploaded by the client — the provider must not modify or inspect it.
   * @param contentType - Optional MIME type of the file (e.g., 'image/jpeg',
   *                      'application/octet-stream'). Used for setting content-type
   *                      headers on retrieval. Defaults to 'application/octet-stream'
   *                      if not provided.
   * @returns URL string to access the stored file. For local filesystem this is a
   *          relative URL path; for cloud storage this may be a pre-signed URL or
   *          CDN URL.
   */
  store(key: string, data: Buffer, contentType?: string): Promise<string>;

  /**
   * Retrieve a file by its storage key.
   *
   * Returns the raw byte content of the stored file as a Buffer. The caller
   * is responsible for decrypting the content if needed.
   *
   * @param key - Storage key/path of the file (as used in the original `store` call).
   * @returns File content as a Node.js Buffer.
   * @throws Error if the file does not exist at the specified key.
   */
  retrieve(key: string): Promise<Buffer>;

  /**
   * Delete a file by its storage key.
   *
   * This operation is idempotent — calling delete on a non-existent key
   * completes successfully without throwing an error. This simplifies
   * cleanup logic in callers such as the story cleanup job (R11, R35)
   * and message delete operations.
   *
   * @param key - Storage key/path of the file to delete.
   */
  delete(key: string): Promise<void>;

  /**
   * Check if a file exists at the given storage key.
   *
   * Used for health checks (verifying storage accessibility) and for
   * pre-condition validation before retrieval or deletion.
   *
   * @param key - Storage key/path to check.
   * @returns `true` if a file exists at the specified key, `false` otherwise.
   */
  exists(key: string): Promise<boolean>;

  /**
   * Get the public URL for an already-stored file.
   *
   * This method resolves a storage key to an externally-accessible URL without
   * reading the file content. The URL format depends on the concrete implementation:
   * - Local filesystem: returns a relative URL path (e.g., '/uploads/media/uuid-file').
   * - Cloud storage (S3/GCS): returns a pre-signed URL or CDN URL with appropriate
   *   expiry and access controls.
   *
   * @param key - Storage key/path of an existing file.
   * @returns URL string to access the file.
   */
  getUrl(key: string): Promise<string>;
}
