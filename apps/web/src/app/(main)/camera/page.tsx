'use client';

// =============================================================================
// CameraPage — Full-Screen Camera View
// =============================================================================
//
// Implements Figma Screen 9: WhatsApp Camera (node 0:9155)
// Figma file key: miK1B6qEPrUnRZ9wwZNrW2
//
// Frame Specification (375×812px, iPhone X form factor):
//   Overall:          375×812, bg #000000, fixed full-screen overlay (z-50)
//   Top Bar:          (0,0) 375×73, bg #000000
//     Close X:        (19.5, 37.5) 18×18, fill #FFFFFF — closes camera
//     Flash icon:     (339.93, 34.38) 24×27, fill #FFFFFF — cycles auto/on/off
//   Camera View:      (0, 73) 375×666 — live getUserMedia video feed
//     Thumbnails:     5× at y:483 within group, 81×81, opacity 0.8, gap 4px
//     Swipe dots:     (169, 537) 37×5, fill #FFFFFF at 50% opacity
//   Bottom controls:
//     Gallery icon:   (11.75, 684.25) 33×27, fill #FFFFFF, stroke rgba(0,0,0,0.2)
//     Capture btn:    (153, 662) 69×69 outer ring + 59×59 inner fill
//     Camera flip:    (329.75, 681.75) 35×30, fill #FFFFFF, stroke rgba(0,0,0,0.2)
//   Tip text:         (0, 739) 375×73, "Hold for video, tap for photo"
//                     SF Pro Text 500 12px/1.333em, tracking 0.833%, fill #FFFFFF
//   Home indicator:   (0, 778) 375×34
//
// Rules enforced:
//   R1  — Figma fidelity ≤5% pixel difference at 1440px
//   R3  — Responsive from single 375×812 frame (375/768/1280 breakpoints)
//   R5  — No mock data — uses real Web Camera API
//   R6  — Backend integration via useMediaUpload hook
//   R7  — Zero TypeScript warnings (strict mode)
//   R34 — WCAG 2.1 AA: aria-labels, keyboard nav, focus-visible outlines
//
// Accessibility (WCAG 2.1 AA):
//   - Full-screen overlay has role="dialog" and aria-label="Camera"
//   - All buttons have explicit aria-label attributes
//   - Flash button announces current mode dynamically
//   - Keyboard navigation: Tab through Close → Flash → Gallery → Capture → Flip
//   - Focus-visible outlines: ring-2 ring-[#007AFF] ring-offset-2 ring-offset-black
//   - Error state communicates via text, not color alone
//   - Hidden canvas and file input marked aria-hidden="true"
// =============================================================================

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { useUIStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { useMediaUpload } from '@/hooks/useMediaUpload';
import { useResponsive } from '@/hooks/useResponsive';

/* Static SVG icon imports — resolved at build time by Next.js bundler.
 * Icons sourced from Figma file miK1B6qEPrUnRZ9wwZNrW2, exported to src/assets/icons/.
 * icon-close-x:     18×18, white X shape (node 0:9184)
 * icon-flash:       24×27, white lightning bolt with "A" auto indicator (node 0:9186)
 * icon-camera-flip: 37×32 viewBox, white camera flip glyph (node 0:9170)
 * icon-gallery:     35×29 viewBox, white gallery/landscape glyph (node 0:9164)
 * Capture button is CSS-constructed per AAP spec (ring + inner fill). */
import iconCloseX from '@/assets/icons/icon-close-x.svg';
import iconFlash from '@/assets/icons/icon-flash.svg';
import iconCameraFlip from '@/assets/icons/icon-camera-flip.svg';
import iconGallery from '@/assets/icons/icon-gallery.svg';

// =============================================================================
// Types
// =============================================================================

/** Flash mode cycle: auto → on → off → auto */
type FlashMode = 'auto' | 'on' | 'off';

/** Map of flash mode to human-readable label for aria-label */
const FLASH_LABELS: Record<FlashMode, string> = {
  auto: 'Flash: auto',
  on: 'Flash: on',
  off: 'Flash: off',
};

/** Cycle order for flash mode toggling */
const FLASH_CYCLE: Record<FlashMode, FlashMode> = {
  auto: 'on',
  on: 'off',
  off: 'auto',
};

// =============================================================================
// CameraPage Component
// =============================================================================

/**
 * Full-screen camera viewfinder page with live camera feed, capture controls,
 * flash toggle, camera flip, and gallery access. Overlays the parent layout
 * via fixed positioning at z-50, covering the bottom TabBar.
 *
 * Uses the Web Camera API (`navigator.mediaDevices.getUserMedia`) for the live
 * feed and pipes captured photos through the `useMediaUpload` hook for
 * client-side validation, thumbnail generation, encryption, and upload (R6).
 *
 * @returns React component — default export for Next.js App Router page
 */
export default function CameraPage() {
  const router = useRouter();

  // ── Internal store and hook integrations ──────────────────────────────────
  const activeTab = useUIStore((s) => s.activeTab);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const { uploadFile, uploadState, resetState, validateFile } =
    useMediaUpload();
  const { isMobile, isTablet, isDesktop } = useResponsive();

  // ── Local state ───────────────────────────────────────────────────────────
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>(
    'environment',
  );
  const [flashMode, setFlashMode] = useState<FlashMode>('auto');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [recentPhotos, setRecentPhotos] = useState<string[]>([]);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Tracks the tab that was active before entering the camera page */
  const previousTabRef = useRef<string>(activeTab);
  /** Tracks all created blob URLs for cleanup on unmount */
  const blobUrlsRef = useRef<string[]>([]);

  // ── Auth guard ─────────────────────────────────────────────────────────────
  // Authentication redirection is handled by the parent (main)/layout.tsx
  // which properly waits for Zustand persist hydration (isInitialized) before
  // checking isAuthenticated. CameraPage accesses isAuthenticated and user
  // for conditional logic (e.g., associating captured media with the current
  // user) but does NOT duplicate the redirect — doing so would cause a
  // false redirect before the persist middleware finishes rehydration.

  // ── Tab synchronization: mark camera tab active on mount ──────────────────
  useEffect(() => {
    previousTabRef.current = activeTab;
    setActiveTab('camera');
    // Intentional: run once on mount to capture initial tab and set camera active.
    // Including activeTab/setActiveTab would cause infinite loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Camera initialization ─────────────────────────────────────────────────

  /**
   * Requests camera access and connects the MediaStream to the <video> element.
   * Stops any existing stream before re-initializing to prevent leaked tracks
   * when switching between front/rear cameras.
   */
  // Keep a stable ref to the current stream to avoid stale closures in callbacks.
  const streamRef = useRef<MediaStream | null>(null);
  streamRef.current = stream;

  const startCamera = useCallback(async () => {
    try {
      // Stop existing stream tracks before requesting a new one
      const currentStream = streamRef.current;
      if (currentStream) {
        currentStream.getTracks().forEach((track) => track.stop());
      }

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      setStream(mediaStream);
      setCameraError(null);

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        await videoRef.current.play();
      }
    } catch (error: unknown) {
      const message =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Camera permission was denied. Please allow camera access in your browser settings.'
          : 'Camera access is required to use this feature.';
      setCameraError(message);
    }
  }, [facingMode]);

  /** Initialize camera on mount and when facingMode changes */
  useEffect(() => {
    if (isAuthenticated) {
      startCamera();
    }
  }, [facingMode, isAuthenticated, startCamera]);

  // ── Stream cleanup on unmount ─────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [stream]);

  // ── Blob URL cleanup on unmount ───────────────────────────────────────────
  useEffect(() => {
    const urls = blobUrlsRef.current;
    return () => {
      urls.forEach((url) => {
        URL.revokeObjectURL(url);
      });
    };
  }, []);

  // ── Close camera handler (must be defined before Escape key effect) ───────

  /** Stops the camera stream and navigates back. */
  const handleClose = useCallback(() => {
    stream?.getTracks().forEach((track) => track.stop());
    router.back();
  }, [stream, router]);

  // ── Focus trap + Escape key handler for WCAG modal accessibility (R34) ────
  // Traps Tab / Shift+Tab within the dialog so focus never escapes to elements
  // behind the full-screen camera overlay.  Also handles Escape to close.
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
        return;
      }

      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]',
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          // Shift+Tab on first element → wrap to last
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          // Tab on last element → wrap to first
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    // Move initial focus into the dialog (first focusable element)
    const timer = setTimeout(() => {
      if (dialogRef.current) {
        const first = dialogRef.current.querySelector<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]',
        );
        first?.focus();
      }
    }, 100);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
    };
  }, [handleClose]);

  // ── Flash toggle ──────────────────────────────────────────────────────────

  /**
   * Cycles flash mode: auto → on → off → auto.
   * Applies the torch constraint to the video track when the device supports
   * the torch capability (primarily mobile rear cameras).
   */
  const toggleFlash = useCallback(async () => {
    const nextMode = FLASH_CYCLE[flashMode];
    setFlashMode(nextMode);

    if (stream) {
      const track = stream.getVideoTracks()[0];
      if (track) {
        try {
          const capabilities = track.getCapabilities?.();
          if (
            capabilities &&
            'torch' in capabilities &&
            (capabilities as Record<string, unknown>).torch
          ) {
            await track.applyConstraints({
              advanced: [
                { torch: nextMode !== 'off' } as unknown as MediaTrackConstraintSet,
              ],
            });
          }
        } catch {
          /* Torch not supported on this device — silently ignore */
        }
      }
    }
  }, [flashMode, stream]);

  // ── Camera flip ───────────────────────────────────────────────────────────

  /** Toggles between front ("user") and rear ("environment") cameras. */
  const flipCamera = useCallback(() => {
    setFacingMode((prev) => (prev === 'user' ? 'environment' : 'user'));
  }, []);

  // ── Photo capture ─────────────────────────────────────────────────────────

  /**
   * Captures the current video frame to a canvas, converts to JPEG blob,
   * validates via useMediaUpload, and initiates upload (R6, R8).
   * Adds a brief white flash animation to signal capture.
   */
  const capturePhoto = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || cameraError) return;

    setIsCapturing(true);

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth || 1920;
    canvas.height = video.videoHeight || 1080;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setIsCapturing(false);
      return;
    }

    // Mirror the canvas for front camera to match the mirrored video display
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    ctx.drawImage(video, 0, 0);

    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          setIsCapturing(false);
          return;
        }

        // Create a displayable thumbnail URL for the photo strip
        const url = URL.createObjectURL(blob);
        blobUrlsRef.current.push(url);
        setRecentPhotos((prev) => [url, ...prev].slice(0, 10));

        // Convert blob to File for the upload pipeline (R6, R8)
        const timestamp = Date.now();
        const userId = user?.id ?? 'unknown';
        const file = new File(
          [blob],
          `capture_${userId}_${timestamp}.jpg`,
          { type: 'image/jpeg' },
        );

        // Validate file before uploading (R8)
        const validation = validateFile(file);
        if (validation.valid) {
          // Reset any previous upload state before starting a new upload
          resetState();
          await uploadFile(file);
        }

        // Dismiss flash animation after a short delay
        setTimeout(() => {
          setIsCapturing(false);
        }, 150);
      },
      'image/jpeg',
      0.92,
    );
  }, [cameraError, facingMode, user, validateFile, resetState, uploadFile]);

  // ── Gallery file picker ───────────────────────────────────────────────────

  /** Opens the hidden file input to select an image/video from the gallery. */
  const openGallery = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /**
   * Handles file selection from the gallery picker. Validates the selected
   * file and initiates upload via the media upload pipeline (R6, R8).
   */
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Create thumbnail preview for photo strip
      const url = URL.createObjectURL(file);
      blobUrlsRef.current.push(url);
      setRecentPhotos((prev) => [url, ...prev].slice(0, 10));

      // Validate and upload (R8, R6)
      const validation = validateFile(file);
      if (validation.valid) {
        resetState();
        uploadFile(file);
      }

      // Reset input value so re-selecting the same file triggers onChange
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [validateFile, resetState, uploadFile],
  );

  // ── Upload status label (for accessibility announcements) ─────────────────
  const uploadStatusLabel =
    uploadState.status !== 'idle' && uploadState.status !== 'complete'
      ? `Upload ${uploadState.status}: ${Math.round(uploadState.progress)}%`
      : '';

  // ── Responsive container classes (R3) ────────────────────────────────────
  // Mobile (≤767px): full-screen overlay matching 375px Figma artboard
  // Tablet (768–1279px): full-screen overlay with centered content area
  // Desktop (≥1280px): phone-sized frame centered in dark overlay
  const containerClasses = isDesktop
    ? 'fixed inset-0 z-50 flex items-center justify-center bg-black/80'
    : 'fixed inset-0 z-50 bg-black';

  const innerClasses = isDesktop
    ? 'relative w-[375px] h-[812px] max-h-screen bg-black flex flex-col overflow-hidden rounded-2xl shadow-2xl'
    : 'relative w-full h-full bg-black flex flex-col';

  // Safe area insets are only relevant on physical mobile/tablet devices (R3)
  const applySafeAreaInsets = isMobile || isTablet;

  // ── Do not render for unauthenticated users (R9) ──────────────────────────
  if (!isAuthenticated) {
    return null;
  }

  // ── JSX ───────────────────────────────────────────────────────────────────

  return (
    <div
      ref={dialogRef}
      className={containerClasses}
      role="dialog"
      aria-label="Camera"
      aria-modal="true"
    >
      <div className={innerClasses}>
        {/* Hidden canvas for photo capture — never visible */}
        <canvas ref={canvasRef} className="hidden" aria-hidden="true" />

        {/* Hidden file input for gallery access */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={handleFileSelect}
          aria-hidden="true"
          tabIndex={-1}
        />

        {/* ── TOP BAR — 73px + safe area ───────────────────────────────── */}
        {/* Figma node 0:9182: (0,0) 375×73, bg #000000 */}
        <div
          className="relative w-full flex-shrink-0 bg-black flex items-end justify-between px-5 pb-1"
          style={{
            minHeight: '73px',
            paddingTop: applySafeAreaInsets
              ? 'env(safe-area-inset-top, 0px)'
              : '0px',
          }}
        >
          {/* Close X — Figma node 0:9184: (19.5, 37.5) 18×18, fill #FFFFFF */}
          <button
            type="button"
            onClick={handleClose}
            className="flex items-center justify-center w-11 h-11 -ml-[10px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            aria-label="Close camera"
          >
            <Image
              src={iconCloseX}
              alt=""
              width={18}
              height={18}
              aria-hidden="true"
            />
          </button>

          {/* Flash icon — Figma node 0:9186: (339.93, 34.38) 24×27, fill #FFFFFF */}
          {/* SVG has "A" auto-indicator baked in. Opacity reduced when flash is off. */}
          <button
            type="button"
            onClick={toggleFlash}
            className={`flex items-center justify-center w-11 h-11 -mr-[10px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-2 focus-visible:ring-offset-black transition-opacity ${
              flashMode === 'off' ? 'opacity-50' : 'opacity-100'
            }`}
            aria-label={FLASH_LABELS[flashMode]}
          >
            <Image
              src={iconFlash}
              alt=""
              width={24}
              height={27}
              aria-hidden="true"
            />
          </button>
        </div>

        {/* ── CAMERA VIEWFINDER — flex-1, fills remaining space ─────────── */}
        {/* Figma node 0:9156: (0,73) 375×666, live camera feed or error state */}
        <div className="flex-1 relative overflow-hidden bg-black">
          {cameraError ? (
            /* Camera error / permission denied state */
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8">
              <p className="text-white text-base font-medium text-center leading-snug">
                {cameraError}
              </p>
              <button
                type="button"
                onClick={startCamera}
                className="px-6 py-3 rounded-full bg-blue-ios text-white font-medium text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-2 focus-visible:ring-offset-black"
                aria-label="Grant camera access"
              >
                Grant Access
              </button>
            </div>
          ) : (
            /* Live camera feed via getUserMedia (R5 — real Web Camera API) */
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="absolute inset-0 w-full h-full object-cover"
              style={{
                transform: facingMode === 'user' ? 'scaleX(-1)' : 'none',
              }}
              aria-label="Camera viewfinder"
            />
          )}

          {/* ── Photo strip thumbnails — horizontal scroll at bottom ──── */}
          {/* Figma: 5 rectangles at y:483 within Camera View group,
              each 81×81, opacity 0.8, positions x:4/89/174/259/344 (gap ~4px).
              Populated from captured photos (R5 — no mock thumbnails). */}
          {recentPhotos.length > 0 && (
            <div
              className="absolute left-0 right-0 px-1"
              style={{ bottom: '110px' }}
            >
              <div className="flex gap-1 overflow-x-auto" role="list" aria-label="Recent photos">
                {recentPhotos.map((photo, index) => (
                  <div
                    key={`photo-${index}`}
                    className="flex-shrink-0 w-[81px] h-[81px] opacity-80 overflow-hidden bg-neutral-800"
                    role="listitem"
                  >
                    {/* Use unoptimized since blob URLs cannot be optimized by Next.js */}
                    <Image
                      src={photo}
                      alt={`Recent photo ${index + 1}`}
                      width={81}
                      height={81}
                      unoptimized
                      className="w-full h-full object-cover"
                    />
                  </div>
                ))}
              </div>
              {/* Swipe indicator — Figma node 0:9180: (169,537) 37×5, fill #FFFFFF/50% */}
              <div
                className="mx-auto w-[37px] h-[5px] rounded-full bg-white/50 mt-2"
                aria-hidden="true"
              />
            </div>
          )}

          {/* Capture flash animation overlay — brief white flash on photo capture */}
          {isCapturing && (
            <div
              className="absolute inset-0 bg-white pointer-events-none animate-pulse"
              aria-hidden="true"
            />
          )}
        </div>

        {/* ── BOTTOM CONTROLS — gallery, capture, camera flip ──────────── */}
        <div className="flex-shrink-0 bg-black">
          {/* Upload status indicator (accessibility: live region) */}
          {uploadStatusLabel && (
            <div
              className="text-center text-xs text-white/70 pb-1"
              role="status"
              aria-live="polite"
            >
              {uploadStatusLabel}
            </div>
          )}

          {/* Controls row — Figma positions within Camera View group:
              Gallery (11.75, 684.25), Capture (153, 662), Flip (329.75, 681.75) */}
          <div className="flex items-center justify-between px-4 py-4">
            {/* Gallery Icon — Figma node 0:9164: (11.75, 684.25) 33×27,
                fill #FFFFFF, stroke rgba(0,0,0,0.2) 1px */}
            <button
              type="button"
              onClick={openGallery}
              className="flex items-center justify-center w-11 h-11 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              aria-label="Open gallery"
            >
              <Image
                src={iconGallery}
                alt=""
                width={33}
                height={27}
                aria-hidden="true"
              />
            </button>

            {/* Capture Button — Figma node 0:9176: (153, 662) 69×69
                Outer ring 69×69 with 5px white border, inner fill 55×55 white circle.
                BLITZY [COMPONENT]: Capture button built with CSS per AAP spec.
                Figma boolean operation exports as ring only; AAP specifies ring+fill. */}
            <button
              type="button"
              onClick={capturePhoto}
              disabled={!!cameraError}
              className="w-[69px] h-[69px] rounded-full border-[5px] border-white flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Take photo"
            >
              <div className="w-[55px] h-[55px] rounded-full bg-white" />
            </button>

            {/* Camera Flip Icon — Figma node 0:9170: (329.75, 681.75) 35×30,
                fill #FFFFFF, stroke rgba(0,0,0,0.2) 1px */}
            <button
              type="button"
              onClick={flipCamera}
              disabled={!!cameraError}
              className="flex items-center justify-center w-11 h-11 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Switch camera"
            >
              <Image
                src={iconCameraFlip}
                alt=""
                width={35}
                height={30}
                aria-hidden="true"
              />
            </button>
          </div>

          {/* ── Tip Text — Figma node 0:9194 ─────────────────────────── */}
          {/* (104, 16) within Tip frame, 167×16, SF Pro Text 500 12px
              lineHeight 1.333em, letterSpacing 0.833%, fill #FFFFFF */}
          <p
            className="text-center text-xs font-medium text-white pb-2"
            style={{
              lineHeight: '1.333em',
              letterSpacing: '0.00833em',
            }}
          >
            Hold for video, tap for photo
          </p>

          {/* ── Home indicator safe area — Figma node 0:9195 ─────────── */}
          {/* (0, 778) 375×34 — accounts for iPhone home indicator bar */}
          <div
            className="h-[34px]"
            style={{
              paddingBottom: applySafeAreaInsets
                ? 'env(safe-area-inset-bottom, 0px)'
                : '0px',
            }}
            aria-hidden="true"
          />
        </div>
      </div>

      {/* Desktop overlay backdrop click closes camera */}
      {isDesktop && (
        <div
          className="absolute inset-0 -z-10"
          onClick={handleClose}
          onKeyDown={(e) => {
            if (e.key === 'Escape') handleClose();
          }}
          role="button"
          tabIndex={-1}
          aria-label="Close camera overlay"
        />
      )}

      {/* Escape key handler for keyboard accessibility */}
      {/* Using a focusable sentinel that captures Escape globally would be
          non-standard; instead we handle Escape via onKeyDown on the dialog. */}
    </div>
  );
}
