'use client';

import React, { useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types & Interface
// ---------------------------------------------------------------------------

/**
 * Supported media attachment types within chat message bubbles.
 * - image: decrypted thumbnail / full image
 * - video: decrypted thumbnail with play-button overlay
 * - document: file-card with icon, name, size, and extension
 */
export type MediaType = 'image' | 'video' | 'document';

/**
 * Props for the MediaMessage component.
 * All visual tokens derive from the Figma design specification for
 * WhatsApp Chat screen (0:8257), nodes 0:8327, 0:8301, 0:8379, 0:8353.
 */
export interface MediaMessageProps {
  /** Attachment type — determines rendering branch */
  type: MediaType;
  /** Display name without extension, e.g. "IMG_0475" */
  fileName: string;
  /** Human-readable file size, e.g. "2.4 MB" */
  fileSize: string;
  /** Lowercase file extension, e.g. "png", "pdf", "mp4" */
  fileExtension: string;
  /** Client-generated decrypted thumbnail URL */
  thumbnailUrl?: string;
  /** Full-resolution decrypted media URL */
  fullUrl?: string;
  /** True when the current user sent this message (affects bubble bg) */
  isOwnMessage: boolean;
  /** Callback invoked when the user taps the download action */
  onDownload?: () => void;
  /** Callback invoked when the user taps the preview / open action */
  onPreview?: () => void;
}

// ---------------------------------------------------------------------------
// Inline SVG: Document file-type icon (22×27)
// Matches Figma node within 0:8327 and icon-document.svg asset exactly.
// Rendered inline for pixel-perfect fidelity — the imported SVG asset
// (apps/web/src/assets/icons/icon-document.svg) is the canonical fallback.
// ---------------------------------------------------------------------------

const DocumentIcon: React.FC = () => (
  <svg
    width="22"
    height="27"
    viewBox="0 0 22 27"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    className="flex-shrink-0"
  >
    {/* Outer page rectangle */}
    <path
      d="M1.5 0.200195H15.4795C15.8237 0.200195 16.1538 0.336989 16.3975 0.580078L21.418 5.58691C21.6625 5.8308 21.7998 6.16246 21.7998 6.50781V25.5C21.7998 26.218 21.218 26.7998 20.5 26.7998H1.5C0.78203 26.7998 0.200195 26.218 0.200195 25.5V1.5C0.200196 0.78203 0.78203 0.200195 1.5 0.200195Z"
      fill="white"
      stroke="#D1D1D6"
      strokeWidth="0.4"
    />
    {/* Corner fold */}
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M22 6.5H17C16.1716 6.5 15.5 5.82843 15.5 5V0.000136014C15.8899 0.00538346 16.2627 0.162278 16.5391 0.438003L21.5593 5.44557C21.8397 5.7252 21.998 6.10425 22 6.5Z"
      fill="#EFEFEF"
    />
    {/* Fold border (uses mask for inset stroke) */}
    <path
      d="M17 7.5H22V6.5C21.998 6.10425 21.8397 5.7252 21.5593 5.44557L16.5391 0.438003C16.2627 0.162278 15.8899 0.00538346 15.5 0.000136014V5C15.5 5.82843 16.1716 6.5 17 6.5H22V7.5H17C15.6193 7.5 14.5 6.38071 14.5 5V0H15.5V5C15.5 5.82843 16.1716 6.5 17 6.5Z"
      fill="#D1D1D6"
    />
    {/* Four decorative text lines — fill #007AFF */}
    <path d="M8.6 9.1V9.9H15.9V9.1H8.6Z" fill="#007AFF" />
    <path d="M6.1 18.1V18.9H13.4V18.1H6.1Z" fill="#007AFF" />
    <path d="M6.1 12.1V12.9H15.9V12.1H6.1Z" fill="#007AFF" />
    <path d="M6.1 15.1V15.9H15.9V15.1H6.1Z" fill="#007AFF" />
  </svg>
);

// ---------------------------------------------------------------------------
// Sub-component: Download / Preview overlay button
// Renders a small circular button overlaid on image/video thumbnails.
// ---------------------------------------------------------------------------

interface OverlayButtonProps {
  label: string;
  onClick?: () => void;
}

const DownloadOverlayButton: React.FC<OverlayButtonProps> = ({
  label,
  onClick,
}) => {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClick?.();
    },
    [onClick],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        onClick?.();
      }
    },
    [onClick],
  );

  return (
    <button
      type="button"
      aria-label={label}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className="
        absolute bottom-2 right-2 z-10
        flex items-center justify-center
        w-[28px] h-[28px] rounded-full
        bg-black/40 text-white
        focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios
      "
    >
      {/* Download arrow icon */}
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M7 1V10M7 10L3.5 6.5M7 10L10.5 6.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M2 12H12"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
};

// ---------------------------------------------------------------------------
// Sub-component: Video play button overlay
// Semi-transparent circle with a white play triangle.
// ---------------------------------------------------------------------------

const PlayButtonOverlay: React.FC = () => (
  <div
    className="
      absolute inset-0 z-[5]
      flex items-center justify-center
      pointer-events-none
    "
    aria-hidden="true"
  >
    <div className="flex items-center justify-center w-[48px] h-[48px] rounded-full bg-black/50">
      <svg
        width="20"
        height="24"
        viewBox="0 0 20 24"
        fill="none"
        aria-hidden="true"
      >
        <path d="M2 2L18 12L2 22V2Z" fill="white" />
      </svg>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Sub-component: Document attachment card
// Matches Figma node 0:8327 (IMG_0475 file card).
// ---------------------------------------------------------------------------

interface DocumentCardProps {
  fileName: string;
  fileSize: string;
  fileExtension: string;
  onPreview?: () => void;
}

const DocumentCard: React.FC<DocumentCardProps> = ({
  fileName,
  fileSize,
  fileExtension,
  onPreview,
}) => {
  const handlePreview = useCallback(() => {
    onPreview?.();
  }, [onPreview]);

  return (
    <div>
      {/* File card container: 150×41, bg file-bg, rounded-[6px] */}
      <div
        role="button"
        tabIndex={0}
        onClick={handlePreview}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handlePreview();
          }
        }}
        aria-label={`Preview ${fileName}`}
        className="
          flex items-center
          w-[150px] h-[41px]
          bg-file-bg rounded-[6px]
          cursor-pointer
          focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios
        "
      >
        {/* Document icon — 22×27 at (7,7) within card */}
        <div className="flex-shrink-0 ml-[7px]">
          <DocumentIcon />
        </div>

        {/* Filename text — 16px, rgba(0,0,0,0.7), letterSpacing -1.875%, max ~100px truncated */}
        <span
          className="
            ml-[7px]
            max-w-[100px]
            text-[16px] font-normal leading-[1.193em]
            tracking-[-0.01875em]
            text-file-name
            truncate
          "
        >
          {fileName}
        </span>
      </div>

      {/* File info row below card: size · extension */}
      <div className="flex items-center mt-[4px] ml-[5px] gap-0">
        {/* File size */}
        <span
          className="
            text-[11px] font-normal leading-[1.193em]
            tracking-[0.0091em]
            text-[rgba(0,0,0,0.4)]
          "
        >
          {fileSize}
        </span>

        {/* Dot separator: 2.5×2.5 circle */}
        <span
          className="
            inline-block mx-[4px]
            w-[2.5px] h-[2.5px]
            rounded-full
            bg-[rgba(0,0,0,0.2)]
            flex-shrink-0
          "
          aria-hidden="true"
        />

        {/* File extension */}
        <span
          className="
            text-[11px] font-normal leading-[1.193em]
            tracking-[0.0091em]
            text-[rgba(0,0,0,0.4)]
          "
        >
          {fileExtension}
        </span>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sub-component: Image / Video media renderer
// Shows decrypted thumbnail with optional play overlay and download button.
// ---------------------------------------------------------------------------

interface ImageVideoMediaProps {
  type: 'image' | 'video';
  fileName: string;
  thumbnailUrl?: string;
  fullUrl?: string;
  onPreview?: () => void;
  onDownload?: () => void;
}

const ImageVideoMedia: React.FC<ImageVideoMediaProps> = ({
  type,
  fileName,
  thumbnailUrl,
  fullUrl,
  onPreview,
  onDownload,
}) => {
  const displayUrl = thumbnailUrl || fullUrl;

  const handleClick = useCallback(() => {
    onPreview?.();
  }, [onPreview]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPreview?.();
      }
    },
    [onPreview],
  );

  if (!displayUrl) {
    // Placeholder when no thumbnail or full URL is available
    return (
      <div
        className="
          flex items-center justify-center
          w-full min-h-[120px]
          bg-file-bg rounded-lg
          text-[rgba(0,0,0,0.4)] text-[13px]
        "
        role="img"
        aria-label={fileName}
      >
        {/* BLITZY [ASSET]: Image missing from decrypted data. Replace with production asset. */}
        <span className="text-center px-4">
          {type === 'video' ? 'Video' : 'Image'} not available
        </span>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={`Preview ${fileName}`}
      className="
        relative
        w-full overflow-hidden
        rounded-lg cursor-pointer
        focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios
      "
    >
      {/* Thumbnail image */}
      <img
        src={displayUrl}
        alt={fileName}
        loading="lazy"
        decoding="async"
        className="
          block w-full
          max-h-[300px]
          object-cover rounded-lg
          bg-[rgba(0,0,0,0.05)]
        "
        width={240}
        height={180}
      />

      {/* Video play button overlay */}
      {type === 'video' && <PlayButtonOverlay />}

      {/* Download overlay button at bottom-right */}
      {onDownload && (
        <DownloadOverlayButton
          label={`Download ${fileName}`}
          onClick={onDownload}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Component: MediaMessage
// Renders the correct sub-component based on `type` prop.
// ---------------------------------------------------------------------------

const MediaMessage: React.FC<MediaMessageProps> = ({
  type,
  fileName,
  fileSize,
  fileExtension,
  thumbnailUrl,
  fullUrl,
  isOwnMessage,
  onDownload,
  onPreview,
}) => {
  const handleDownload = useCallback(() => {
    onDownload?.();
  }, [onDownload]);

  const handlePreview = useCallback(() => {
    onPreview?.();
  }, [onPreview]);

  return (
    <div
      aria-label={`${fileName}.${fileExtension}, ${fileSize}`}
      data-own-message={isOwnMessage}
      className="w-full"
    >
      {type === 'document' ? (
        <DocumentCard
          fileName={fileName}
          fileSize={fileSize}
          fileExtension={fileExtension}
          onPreview={onPreview ? handlePreview : undefined}
        />
      ) : (
        <ImageVideoMedia
          type={type}
          fileName={fileName}
          thumbnailUrl={thumbnailUrl}
          fullUrl={fullUrl}
          onPreview={onPreview ? handlePreview : undefined}
          onDownload={onDownload ? handleDownload : undefined}
        />
      )}
    </div>
  );
};

export default MediaMessage;
