'use client';

/**
 * @file VoiceNotePlayer.tsx
 * @description Voice note waveform visualization and playback controls component.
 *
 * Renders an interactive audio player matching Figma Screen 1 (Karen Castillo
 * row) and Screen 4 voice note styling:
 *   - Waveform visualization with 50 bars showing amplitude data
 *   - Play/pause toggle with animated state
 *   - Current position / total duration counter in "M:SS" format
 *   - Playback progress indicator that fills waveform bars as audio plays
 *
 * Figma Mapping:
 *   Screen 1 (0:8855): Voice note indicator in chat list row — green
 *   microphone icon with "0:14" duration label.
 *   Screen 4 (0:8257): Inline voice note player in message bubble with
 *   waveform bars and playback controls.
 *
 * Design Tokens:
 *   - Waveform active: #25D366 (whatsapp-green) for sent, #8E8E93 (secondary) for received
 *   - Waveform played: #007AFF (link/blue) overlay on played portion
 *   - Duration text: SF Pro Text 400 12px #8E8E93
 *   - Play/pause icon: 28×28 circle, filled with primary action color
 *
 * Accessibility (R34):
 *   - Play/pause button has ARIA labels reflecting current state
 *   - Waveform has role="progressbar" with aria-valuenow/valuemin/valuemax
 *   - Keyboard navigable: Space/Enter to toggle playback
 *   - Duration and state announced to screen readers via sr-only live region
 *
 * @see {@link apps/web/src/lib/voicenote.ts} for recording and waveform generation
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatDuration } from '@/lib/voicenote';

// =============================================================================
// Constants
// =============================================================================

/** Default number of waveform bars to render */
const WAVEFORM_BAR_COUNT = 50;

/** Interval for updating playback position (milliseconds) */
const POSITION_UPDATE_INTERVAL_MS = 50;

/** Minimum bar height as a fraction of max height (prevents invisible bars) */
const MIN_BAR_HEIGHT_FRACTION = 0.08;

// =============================================================================
// Types
// =============================================================================

export interface VoiceNotePlayerProps {
  /** Audio source URL (object URL or network URL) */
  src: string;

  /** Duration of the voice note in seconds */
  duration: number;

  /** Normalized waveform amplitude data (0.0–1.0), typically 50 samples */
  waveform: number[];

  /** Whether this voice note is in a sent (right-aligned green) bubble */
  isSent?: boolean;

  /** Optional CSS class name for layout customization */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * VoiceNotePlayer renders an interactive audio player with waveform
 * visualization and playback controls for voice note messages.
 *
 * The waveform bars are rendered as individual div elements whose heights
 * represent the audio amplitude at each sample point. During playback,
 * bars transition from inactive to active color as the playhead advances,
 * providing visual feedback of progress.
 */
export default function VoiceNotePlayer({
  src,
  duration,
  waveform,
  isSent = false,
  className = '',
}: VoiceNotePlayerProps): React.JSX.Element {
  // ── State ─────────────────────────────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);

  // ── Refs ──────────────────────────────────────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Derived values ────────────────────────────────────────────────────
  const progressFraction = duration > 0 ? currentTime / duration : 0;
  const playedBars = Math.floor(progressFraction * WAVEFORM_BAR_COUNT);
  const displayDuration = isPlaying ? formatDuration(currentTime) : formatDuration(duration);

  // Normalize waveform to exactly WAVEFORM_BAR_COUNT bars
  const normalizedWaveform = normalizeWaveform(waveform, WAVEFORM_BAR_COUNT);

  // ── Audio element management ──────────────────────────────────────────
  useEffect(() => {
    const audio = new Audio(src);
    audio.preload = 'metadata';
    audioRef.current = audio;

    const handleLoadedMetadata = (): void => {
      setIsLoaded(true);
    };

    const handleEnded = (): void => {
      setIsPlaying(false);
      setCurrentTime(0);
      clearPositionTracking();
    };

    const handleError = (): void => {
      setIsPlaying(false);
      setIsLoaded(false);
      clearPositionTracking();
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    return (): void => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
      audio.pause();
      audio.src = '';
      audioRef.current = null;
      clearPositionTracking();
    };
  }, [src]); // Only re-run when audio source changes

  // ── Position tracking ─────────────────────────────────────────────────
  const clearPositionTracking = useCallback((): void => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const startPositionTracking = useCallback((): void => {
    clearPositionTracking();
    intervalRef.current = setInterval(() => {
      if (audioRef.current) {
        setCurrentTime(audioRef.current.currentTime);
      }
    }, POSITION_UPDATE_INTERVAL_MS);
  }, [clearPositionTracking]);

  // ── Playback toggle ───────────────────────────────────────────────────
  const togglePlayback = useCallback(async (): Promise<void> => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      clearPositionTracking();
    } else {
      try {
        await audio.play();
        setIsPlaying(true);
        startPositionTracking();
      } catch {
        // Play was prevented (e.g., autoplay policy) — reset state
        setIsPlaying(false);
      }
    }
  }, [isPlaying, clearPositionTracking, startPositionTracking]);

  // ── Waveform seek (click on a bar to seek to that position) ───────────
  const handleWaveformClick = useCallback(
    (barIndex: number): void => {
      const audio = audioRef.current;
      if (!audio || !isLoaded) return;

      const seekFraction = barIndex / WAVEFORM_BAR_COUNT;
      const seekTime = seekFraction * duration;
      audio.currentTime = seekTime;
      setCurrentTime(seekTime);

      // If not playing, start playback from the seek position
      if (!isPlaying) {
        audio.play().then(() => {
          setIsPlaying(true);
          startPositionTracking();
        }).catch(() => {
          // Autoplay policy blocked — just update position
        });
      }
    },
    [duration, isLoaded, isPlaying, startPositionTracking],
  );

  // ── Keyboard handler for waveform ─────────────────────────────────────
  const handleWaveformKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      const audio = audioRef.current;
      if (!audio || !isLoaded) return;

      const seekStep = duration * 0.05; // 5% seek increment

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const newTime = Math.min(audio.currentTime + seekStep, duration);
        audio.currentTime = newTime;
        setCurrentTime(newTime);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const newTime = Math.max(audio.currentTime - seekStep, 0);
        audio.currentTime = newTime;
        setCurrentTime(newTime);
      }
    },
    [duration, isLoaded],
  );

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div
      className={`flex items-center gap-2 py-1 ${className}`}
      role="group"
      aria-label="Voice note player"
    >
      {/* Play/Pause Button */}
      <button
        type="button"
        onClick={togglePlayback}
        disabled={!isLoaded && !audioRef.current}
        className={`
          flex-shrink-0 flex items-center justify-center
          w-7 h-7 rounded-full transition-colors
          focus:outline-none focus-visible:ring-2 focus-visible:ring-link focus-visible:ring-offset-2
          ${isSent
            ? 'bg-whatsapp-green text-white hover:bg-whatsapp-green/90'
            : 'bg-link text-white hover:bg-link/90'
          }
          ${(!isLoaded && !audioRef.current) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        `}
        aria-label={isPlaying ? 'Pause voice note' : 'Play voice note'}
      >
        {isPlaying ? (
          /* Pause icon: two vertical bars */
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="2" y="1" width="3" height="10" rx="0.5" fill="currentColor" />
            <rect x="7" y="1" width="3" height="10" rx="0.5" fill="currentColor" />
          </svg>
        ) : (
          /* Play icon: triangle pointing right */
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 1.5V10.5L10.5 6L3 1.5Z" fill="currentColor" />
          </svg>
        )}
      </button>

      {/* Waveform Visualization */}
      <div
        className="flex-1 flex items-end gap-px h-8 cursor-pointer"
        role="progressbar"
        aria-valuenow={Math.round(progressFraction * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Voice note progress: ${Math.round(progressFraction * 100)}%`}
        tabIndex={0}
        onKeyDown={handleWaveformKeyDown}
      >
        {normalizedWaveform.map((amplitude, index) => {
          const barHeight = Math.max(MIN_BAR_HEIGHT_FRACTION, amplitude) * 100;
          const isPlayedBar = index < playedBars;

          return (
            <div
              key={index}
              className={`
                flex-1 rounded-full transition-colors duration-100
                ${isPlayedBar
                  ? 'bg-link'
                  : isSent
                    ? 'bg-whatsapp-green/50'
                    : 'bg-secondary/40'
                }
              `}
              style={{ height: `${barHeight}%` }}
              onClick={() => handleWaveformClick(index)}
              role="presentation"
            />
          );
        })}
      </div>

      {/* Duration Label */}
      <span
        className="flex-shrink-0 text-xs font-normal text-secondary tabular-nums min-w-[32px] text-right"
        aria-hidden="true"
      >
        {displayDuration}
      </span>

      {/* Screen reader live region for playback state announcements */}
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
 * Normalizes a waveform array to exactly `targetCount` bars.
 * If the input has more bars, it downsamples by averaging segments.
 * If fewer, it pads with minimum values. All values are clamped to 0.0–1.0.
 *
 * @param waveform - Input waveform amplitudes (0.0–1.0 normalized)
 * @param targetCount - Desired number of output bars
 * @returns Array of exactly `targetCount` normalized amplitude values
 */
function normalizeWaveform(waveform: number[], targetCount: number): number[] {
  if (waveform.length === 0) {
    return new Array<number>(targetCount).fill(MIN_BAR_HEIGHT_FRACTION);
  }

  if (waveform.length === targetCount) {
    return waveform.map((v) => Math.min(1, Math.max(0, v)));
  }

  if (waveform.length < targetCount) {
    // Stretch by linear interpolation
    const result: number[] = [];
    for (let i = 0; i < targetCount; i++) {
      const srcIndex = (i / targetCount) * waveform.length;
      const lower = Math.floor(srcIndex);
      const upper = Math.min(lower + 1, waveform.length - 1);
      const fraction = srcIndex - lower;
      const value = waveform[lower] * (1 - fraction) + waveform[upper] * fraction;
      result.push(Math.min(1, Math.max(0, value)));
    }
    return result;
  }

  // Downsample by averaging segments
  const segmentLength = waveform.length / targetCount;
  const result: number[] = [];

  for (let i = 0; i < targetCount; i++) {
    const start = Math.floor(i * segmentLength);
    const end = Math.floor((i + 1) * segmentLength);
    let sum = 0;
    let count = 0;

    for (let j = start; j < end && j < waveform.length; j++) {
      sum += waveform[j];
      count++;
    }

    const avg = count > 0 ? sum / count : 0;
    result.push(Math.min(1, Math.max(0, avg)));
  }

  return result;
}
