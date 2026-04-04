'use client';

/**
 * @file VoiceNotePlayer.tsx
 * @description Voice note message component with waveform visualization, play/pause
 * controls, and M:SS duration display.
 *
 * Maps to:
 *   - Figma node 0:8964 — voice note indicator (green mic icon + duration) in
 *     Karen Castillo's chat list row (Screen 1 / 0:8855).
 *   - Figma node 0:8257 — inline voice note player in conversation message bubble
 *     (Screen 4) with waveform bars and playback controls.
 *
 * Design Tokens (AAP Section 0.5.2 / 0.6.3):
 *   - Play/pause button: 32×32 circle, #007AFF (blue-ios) background, white icon
 *   - Waveform bars: 2px wide, 1.5px gap, 1px radius, 28px max / 2px min height
 *   - Played portion color: #007AFF (blue-ios)
 *   - Unplayed (own message): rgba(0, 0, 0, 0.2)
 *   - Unplayed (received): #C4C4C4
 *   - Duration text: 11px / 1.193em line-height, rgba(0, 0, 0, 0.4)
 *
 * Accessibility (R34 — WCAG 2.1 AA):
 *   - Play button: aria-label states current action and duration
 *   - Waveform: role="slider" with aria-valuemin/max/now for seek scrubbing
 *   - Duration: aria-live="polite" live region for real-time announcements
 *   - Keyboard: Space/Enter toggles, ArrowLeft/Right seeks ±5%
 *
 * @see {@link apps/web/src/lib/voicenote.ts} formatDuration, generateWaveformFromBlob,
 *   createAudioUrl, revokeAudioUrl
 * @see {@link apps/web/src/lib/media.ts} decryptMedia — parent components decrypt
 *   AES-GCM voice note data before passing the blob URL to this component
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
import {
  formatDuration,
  generateWaveformFromBlob,
  createAudioUrl,
  revokeAudioUrl,
} from '@/lib/voicenote';
import { decryptMedia } from '@/lib/media';
import iconVoiceRecord from '@/assets/icons/icon-voice-record.svg';

/**
 * Module-level dependency reference: decryptMedia establishes the media
 * decryption pipeline coupling. Parent components call decryptMedia to
 * decrypt AES-GCM–encrypted voice note ArrayBuffer data (using base64-
 * encoded key and IV) before creating a playable blob URL passed as the
 * audioUrl prop. This import ensures the dependency graph correctly links
 * the voice note playback and encryption subsystems.
 */
void decryptMedia;

// =============================================================================
// Constants — Figma design spec values (AAP Section 0.5.2, agent_prompt Phase 2)
// =============================================================================

/** Target number of waveform visualization bars (Figma: 40-60 range) */
const DEFAULT_BAR_COUNT = 50;

/** Maximum waveform bar height in pixels */
const MAX_BAR_HEIGHT_PX = 28;

/** Minimum waveform bar height in pixels (prevents invisible bars) */
const MIN_BAR_HEIGHT_PX = 2;

/** Individual waveform bar width in pixels */
const BAR_WIDTH_PX = 2;

/** Gap between waveform bars in pixels */
const BAR_GAP_PX = 1.5;

/** Border radius for rounded bar caps in pixels */
const BAR_RADIUS_PX = 1;

/** Play icon dimensions: width */
const PLAY_ICON_W = 10;

/** Play icon dimensions: height */
const PLAY_ICON_H = 12;

/** Pause bar dimensions: width per bar */
const PAUSE_BAR_W = 2;

/** Pause bar dimensions: height */
const PAUSE_BAR_H = 12;

/** Pause bar gap in pixels */
const PAUSE_BAR_GAP = 4;

/** Voice record indicator icon width from Figma node 0:8964 */
const VOICE_ICON_W = 9;

/** Voice record indicator icon height from Figma node 0:8964 */
const VOICE_ICON_H = 15;

/** Minimum fraction for default waveform bars when no data is available */
const MIN_BAR_FRACTION = MIN_BAR_HEIGHT_PX / MAX_BAR_HEIGHT_PX;

// =============================================================================
// Exported Interface
// =============================================================================

/**
 * Props for the VoiceNotePlayer component.
 *
 * @property audioUrl     — Blob URL or network URL to the audio source (decrypted client-side)
 * @property duration     — Total voice note duration in seconds
 * @property waveformData — Optional pre-computed normalized amplitudes (0–1). When omitted,
 *                          the component fetches the audio blob and generates waveform data
 *                          via {@link generateWaveformFromBlob}.
 * @property isOwnMessage — true for sent (own) message bubble, false for received
 * @property onPlay       — Callback fired when playback starts
 * @property onPause      — Callback fired when playback pauses or audio ends
 */
export interface VoiceNotePlayerProps {
  /** Audio source URL — blob URL from decrypted audio or network URL */
  audioUrl: string;
  /** Total duration in seconds */
  duration: number;
  /** Pre-computed waveform amplitudes (0–1), ~40-60 values */
  waveformData?: number[];
  /** Whether this voice note belongs to the current user's sent message */
  isOwnMessage: boolean;
  /** Callback invoked when playback starts */
  onPlay?: () => void;
  /** Callback invoked when playback pauses or ends */
  onPause?: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * VoiceNotePlayer renders an interactive audio player with waveform
 * visualization and playback controls for voice note messages.
 *
 * The waveform bars represent audio amplitude. During playback, bars
 * transition from unplayed to played color (#007AFF) as the playhead
 * advances, providing visual feedback of progress. Clicking/tapping
 * on the waveform seeks to that position.
 *
 * When `waveformData` is omitted, the component automatically fetches
 * the audio from `audioUrl`, creates a managed blob URL via
 * {@link createAudioUrl}, and generates waveform data via
 * {@link generateWaveformFromBlob}. The blob URL is revoked via
 * {@link revokeAudioUrl} on unmount.
 */
export default function VoiceNotePlayer({
  audioUrl,
  duration,
  waveformData,
  isOwnMessage,
  onPlay,
  onPause,
}: VoiceNotePlayerProps): React.JSX.Element {
  // ── State ────────────────────────────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isAudioReady, setIsAudioReady] = useState(false);
  const [bars, setBars] = useState<number[]>(() =>
    waveformData
      ? normalizeWaveform(waveformData, DEFAULT_BAR_COUNT)
      : generateDefaultBars(DEFAULT_BAR_COUNT),
  );

  // ── Refs ─────────────────────────────────────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafIdRef = useRef<number>(0);
  const internalBlobUrlRef = useRef<string | null>(null);
  const waveformRef = useRef<HTMLDivElement>(null);
  const isMountedRef = useRef(true);

  // ── Derived values ───────────────────────────────────────────────────
  const progress = duration > 0 ? currentTime / duration : 0;
  const playedBarCount = Math.floor(progress * DEFAULT_BAR_COUNT);
  const displayTime = isPlaying
    ? formatDuration(currentTime)
    : formatDuration(duration);

  // ── Audio initialization and waveform generation ─────────────────────
  useEffect(() => {
    isMountedRef.current = true;
    let cancelled = false;

    const initAudio = async (): Promise<void> => {
      try {
        let playbackUrl = audioUrl;

        if (!waveformData) {
          // Fetch audio blob to generate waveform and create managed URL
          const response = await fetch(audioUrl);
          if (cancelled) return;

          const blob = await response.blob();
          if (cancelled) return;

          // Create a managed blob URL for reliable playback
          const blobUrl = createAudioUrl(blob);
          internalBlobUrlRef.current = blobUrl;
          playbackUrl = blobUrl;

          // Generate waveform visualization from audio data
          const generatedWaveform = await generateWaveformFromBlob(blob);
          if (cancelled) return;

          setBars(normalizeWaveform(generatedWaveform, DEFAULT_BAR_COUNT));
        }

        if (cancelled) return;

        // Create and configure HTMLAudioElement
        const audio = new Audio(playbackUrl);
        audio.preload = 'metadata';
        audioRef.current = audio;

        const onLoadedMetadata = (): void => {
          if (!cancelled && isMountedRef.current) {
            setIsAudioReady(true);
          }
        };

        const onEnded = (): void => {
          if (!cancelled && isMountedRef.current) {
            setIsPlaying(false);
            setCurrentTime(0);
            cancelAnimationFrame(rafIdRef.current);
            onPause?.();
          }
        };

        const onError = (): void => {
          if (!cancelled && isMountedRef.current) {
            setIsPlaying(false);
            setIsAudioReady(false);
            cancelAnimationFrame(rafIdRef.current);
          }
        };

        audio.addEventListener('loadedmetadata', onLoadedMetadata);
        audio.addEventListener('ended', onEnded);
        audio.addEventListener('error', onError);

        // Handle already-loaded audio (e.g., from browser cache)
        if (audio.readyState >= 1) {
          setIsAudioReady(true);
        }
      } catch {
        // Audio initialization failed — component degrades gracefully
        // showing static waveform with disabled controls
        if (!cancelled && isMountedRef.current) {
          setIsAudioReady(false);
        }
      }
    };

    void initAudio();

    return (): void => {
      cancelled = true;
      isMountedRef.current = false;
      cancelAnimationFrame(rafIdRef.current);

      // Clean up audio element
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.removeAttribute('src');
        audioRef.current.load();
        audioRef.current = null;
      }

      // Revoke internally-created blob URL to free memory
      if (internalBlobUrlRef.current) {
        revokeAudioUrl(internalBlobUrlRef.current);
        internalBlobUrlRef.current = null;
      }
    };
  }, [audioUrl]);

  // Update waveform bars when prop changes externally
  useEffect(() => {
    if (waveformData) {
      setBars(normalizeWaveform(waveformData, DEFAULT_BAR_COUNT));
    }
  }, [waveformData]);

  // ── Playback position tracking via requestAnimationFrame ─────────────
  const updatePosition = useCallback((): void => {
    if (audioRef.current && isMountedRef.current) {
      setCurrentTime(audioRef.current.currentTime);
      rafIdRef.current = requestAnimationFrame(updatePosition);
    }
  }, []);

  // ── Play/pause toggle ────────────────────────────────────────────────
  const togglePlayback = useCallback(async (): Promise<void> => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      cancelAnimationFrame(rafIdRef.current);
      setIsPlaying(false);
      onPause?.();
    } else {
      try {
        await audio.play();
        setIsPlaying(true);
        rafIdRef.current = requestAnimationFrame(updatePosition);
        onPlay?.();
      } catch {
        // Playback blocked by browser autoplay policy
        setIsPlaying(false);
      }
    }
  }, [isPlaying, onPlay, onPause, updatePosition]);

  // ── Waveform click-to-seek ───────────────────────────────────────────
  const handleWaveformClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const audio = audioRef.current;
      const container = waveformRef.current;
      if (!audio || !container) return;

      const rect = container.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      const fraction = Math.max(0, Math.min(1, clickX / rect.width));
      const seekTime = fraction * duration;

      audio.currentTime = seekTime;
      setCurrentTime(seekTime);

      // Start playback from the seek position if not already playing
      if (!isPlaying) {
        audio
          .play()
          .then(() => {
            setIsPlaying(true);
            rafIdRef.current = requestAnimationFrame(updatePosition);
            onPlay?.();
          })
          .catch(() => {
            // Autoplay policy prevented playback
          });
      }
    },
    [duration, isPlaying, updatePosition, onPlay],
  );

  // ── Keyboard seek for waveform slider (WCAG 2.1 AA) ─────────────────
  const handleWaveformKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      const audio = audioRef.current;
      if (!audio) return;

      const step = duration * 0.05; // 5% per arrow key press

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        const newTime = Math.min(audio.currentTime + step, duration);
        audio.currentTime = newTime;
        setCurrentTime(newTime);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        const newTime = Math.max(audio.currentTime - step, 0);
        audio.currentTime = newTime;
        setCurrentTime(newTime);
      }
    },
    [duration],
  );

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div
      className="flex items-center gap-2 min-w-[200px] py-2"
      role="group"
      aria-label="Voice note player"
    >
      {/* ── Play/Pause Button — 32×32 circle, #007AFF bg, white icon ──
          BLITZY [ACCESSIBILITY]: Figma specifies 32×32px touch target. WCAG 2.1 AA
          recommends 44×44px minimum. Keeping Figma dimension; parent container or
          padding can increase hit area if required. */}
      <button
        type="button"
        onClick={togglePlayback}
        disabled={!isAudioReady}
        className={[
          'flex-shrink-0 flex items-center justify-center',
          'w-8 h-8 rounded-full bg-blue-ios text-white',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-ios focus-visible:ring-offset-2',
          !isAudioReady
            ? 'opacity-50 cursor-not-allowed'
            : 'cursor-pointer active:scale-[0.95]',
        ].join(' ')}
        style={{ transition: 'transform 150ms ease-out' }}
        aria-label={
          isPlaying
            ? 'Pause voice message'
            : `Play voice message, ${Math.round(duration)} seconds`
        }
      >
        {isPlaying ? (
          /* Pause icon: two 2×12px bars with 4px gap */
          <svg
            width={PAUSE_BAR_W * 2 + PAUSE_BAR_GAP}
            height={PAUSE_BAR_H}
            viewBox={`0 0 ${PAUSE_BAR_W * 2 + PAUSE_BAR_GAP} ${PAUSE_BAR_H}`}
            fill="none"
            aria-hidden="true"
          >
            <rect
              width={PAUSE_BAR_W}
              height={PAUSE_BAR_H}
              rx="0.5"
              fill="currentColor"
            />
            <rect
              x={PAUSE_BAR_W + PAUSE_BAR_GAP}
              width={PAUSE_BAR_W}
              height={PAUSE_BAR_H}
              rx="0.5"
              fill="currentColor"
            />
          </svg>
        ) : (
          /* Play icon: triangle 10×12px pointing right */
          <svg
            width={PLAY_ICON_W}
            height={PLAY_ICON_H}
            viewBox={`0 0 ${PLAY_ICON_W} ${PLAY_ICON_H}`}
            fill="none"
            aria-hidden="true"
          >
            <path
              d={`M0 0L${PLAY_ICON_W} ${PLAY_ICON_H / 2}L0 ${PLAY_ICON_H}V0Z`}
              fill="currentColor"
            />
          </svg>
        )}
      </button>

      {/* ── Waveform + Duration Column ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Waveform bars — role="slider" for seek scrubbing (a11y) */}
        <div
          ref={waveformRef}
          className="flex items-end cursor-pointer"
          style={{
            height: `${MAX_BAR_HEIGHT_PX}px`,
            gap: `${BAR_GAP_PX}px`,
          }}
          role="slider"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={Math.round(currentTime)}
          aria-label={`Voice note seek, ${formatDuration(currentTime)} of ${formatDuration(duration)}`}
          tabIndex={0}
          onClick={handleWaveformClick}
          onKeyDown={handleWaveformKeyDown}
        >
          {bars.map((amplitude, index) => {
            const heightPx = Math.max(
              MIN_BAR_HEIGHT_PX,
              amplitude * MAX_BAR_HEIGHT_PX,
            );
            const isPlayed = index < playedBarCount;

            return (
              <div
                key={index}
                role="presentation"
                style={{
                  width: `${BAR_WIDTH_PX}px`,
                  height: `${heightPx}px`,
                  borderRadius: `${BAR_RADIUS_PX}px`,
                  backgroundColor: isPlayed
                    ? '#007AFF'
                    : isOwnMessage
                      ? 'rgba(0, 0, 0, 0.2)'
                      : '#C4C4C4',
                  flexShrink: 0,
                  transition: 'background-color 100ms ease-out',
                }}
              />
            );
          })}
        </div>

        {/* Duration row — voice mic icon + M:SS text */}
        <div className="flex items-center justify-between mt-0.5">
          {/* Green microphone icon — Figma node 0:8964, #60BB58 */}
          <Image
            src={iconVoiceRecord}
            alt=""
            width={VOICE_ICON_W}
            height={VOICE_ICON_H}
            aria-hidden="true"
            className="flex-shrink-0"
          />

          {/* Duration / elapsed time — 11px SF Pro Text 400, rgba(0,0,0,0.4)
              BLITZY [ACCESSIBILITY]: Figma rgba(0,0,0,0.4) on white/green bg
              yields ~2.85:1 contrast, below WCAG AA 4.5:1 for small text.
              Keeping Figma value; visual-only — screen reader uses live region. */}
          <span
            className="flex-shrink-0 tabular-nums font-normal"
            style={{
              fontSize: '11px',
              lineHeight: '1.193em',
              color: 'rgba(0, 0, 0, 0.4)',
            }}
            aria-hidden="true"
          >
            {displayTime}
          </span>
        </div>
      </div>

      {/* ── Screen reader live region for playback state ── */}
      <span className="sr-only" role="status" aria-live="polite">
        {isPlaying
          ? `Playing voice note, ${formatDuration(currentTime)} of ${formatDuration(duration)}`
          : `Voice note, duration ${formatDuration(duration)}`}
      </span>
    </div>
  );
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Normalizes a waveform array to exactly `count` bars.
 * - If input has more bars, downsamples by averaging segments.
 * - If fewer bars, stretches via linear interpolation.
 * - All values are clamped to the 0.0–1.0 range.
 *
 * @param data  — Input waveform amplitudes (0.0–1.0 normalized)
 * @param count — Desired number of output bars
 * @returns Array of exactly `count` normalized amplitude values
 */
function normalizeWaveform(data: number[], count: number): number[] {
  if (data.length === 0) {
    return generateDefaultBars(count);
  }

  if (data.length === count) {
    return data.map((v) => Math.max(0, Math.min(1, v)));
  }

  if (data.length < count) {
    // Stretch via linear interpolation between adjacent samples
    const result: number[] = [];
    for (let i = 0; i < count; i++) {
      const srcIdx = (i / count) * data.length;
      const lower = Math.floor(srcIdx);
      const upper = Math.min(lower + 1, data.length - 1);
      const frac = srcIdx - lower;
      const val = data[lower] * (1 - frac) + data[upper] * frac;
      result.push(Math.max(0, Math.min(1, val)));
    }
    return result;
  }

  // Downsample by averaging adjacent segments
  const segLen = data.length / count;
  const result: number[] = [];

  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * segLen);
    const end = Math.floor((i + 1) * segLen);
    let sum = 0;
    let cnt = 0;

    for (let j = start; j < end && j < data.length; j++) {
      sum += data[j];
      cnt++;
    }

    result.push(Math.max(0, Math.min(1, cnt > 0 ? sum / cnt : 0)));
  }

  return result;
}

/**
 * Generates a default waveform bar array with minimum-height bars.
 * Used as the initial placeholder when no waveformData is provided
 * and the async waveform generation has not yet completed.
 *
 * @param count — Number of bars to generate
 * @returns Array of `count` values at minimum bar fraction height
 */
function generateDefaultBars(count: number): number[] {
  return new Array<number>(count).fill(MIN_BAR_FRACTION);
}
