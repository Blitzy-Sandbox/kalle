/**
 * Voice Note Recording and Waveform Generation Library
 *
 * Provides voice note recording via Web Audio API / MediaRecorder,
 * waveform visualization data generation via AnalyserNode, and
 * audio playback helpers. Produces audio blobs ready for client-side
 * encryption and upload through the media pipeline.
 *
 * Waveform data feeds the VoiceNotePlayer UI component for real-time
 * and playback visualization.
 */

// ============================================================
// Types and Interfaces
// ============================================================

/**
 * Completed voice recording result containing the audio blob,
 * duration, waveform visualization data, and MIME type.
 */
export interface VoiceRecording {
  /** Audio blob (audio/webm, audio/ogg, or audio/mp4 format) */
  blob: Blob;
  /** Recording duration in seconds */
  duration: number;
  /** Normalized waveform amplitudes (0.0–1.0), ~50 samples */
  waveform: number[];
  /** MIME type of the recording (e.g. audio/webm;codecs=opus) */
  mimeType: string;
}

/**
 * Live recording state emitted during active recording sessions
 * for real-time UI visualization updates.
 */
export interface RecordingState {
  /** Whether recording is currently active */
  isRecording: boolean;
  /** Whether recording is currently paused */
  isPaused: boolean;
  /** Current elapsed time in seconds */
  duration: number;
  /** Live waveform data for real-time visualization */
  waveformData: number[];
}

/**
 * Callback function type for receiving live recording state updates.
 */
export type RecordingCallback = (state: RecordingState) => void;

// ============================================================
// Constants
// ============================================================

/** MIME types to attempt in priority order */
const MIME_TYPE_CANDIDATES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
];

/** Target number of waveform samples for stored recordings */
const TARGET_WAVEFORM_SAMPLES = 50;

/** Interval between waveform samples in milliseconds */
const WAVEFORM_SAMPLE_INTERVAL_MS = 100;

/** MediaRecorder chunk interval in milliseconds */
const RECORDER_CHUNK_INTERVAL_MS = 100;

/** AnalyserNode FFT size for waveform analysis */
const ANALYSER_FFT_SIZE = 256;

/** AnalyserNode smoothing constant */
const ANALYSER_SMOOTHING = 0.8;

// ============================================================
// Internal Type Helpers
// ============================================================

/** Extended window interface for webkit AudioContext fallback */
interface AudioContextWindow {
  webkitAudioContext?: typeof AudioContext;
}

// ============================================================
// Internal Helper Functions
// ============================================================

/**
 * Resolves the AudioContext constructor, including the
 * webkit-prefixed fallback for older Safari versions.
 *
 * @returns AudioContext constructor or undefined if unavailable
 */
function getAudioContextClass(): typeof AudioContext | undefined {
  if (typeof AudioContext !== 'undefined') {
    return AudioContext;
  }
  if (typeof window !== 'undefined') {
    const win = window as unknown as AudioContextWindow;
    if (typeof win.webkitAudioContext !== 'undefined') {
      return win.webkitAudioContext;
    }
  }
  return undefined;
}

/**
 * Downsamples a waveform array to the target number of samples
 * by grouping adjacent values and averaging.
 *
 * @param samples - Raw waveform samples to downsample
 * @param targetCount - Desired output sample count
 * @returns Downsampled waveform array of length targetCount
 */
function downsampleWaveform(samples: number[], targetCount: number): number[] {
  if (samples.length === 0) {
    return new Array<number>(targetCount).fill(0);
  }

  if (samples.length <= targetCount) {
    const result = [...samples];
    while (result.length < targetCount) {
      result.push(0);
    }
    return result;
  }

  const segmentLength = samples.length / targetCount;
  const result: number[] = [];

  for (let i = 0; i < targetCount; i++) {
    const start = Math.floor(i * segmentLength);
    const end = Math.floor((i + 1) * segmentLength);
    let sum = 0;
    let count = 0;

    for (let j = start; j < end && j < samples.length; j++) {
      sum += samples[j];
      count++;
    }

    result.push(count > 0 ? sum / count : 0);
  }

  return result;
}

/**
 * Calculates the RMS (Root Mean Square) amplitude from
 * AnalyserNode time-domain data (Uint8Array where 128 = silence).
 *
 * @param dataArray - Byte time-domain data from AnalyserNode
 * @returns Normalized amplitude value in range 0.0–1.0
 */
function calculateRmsFromTimeDomain(dataArray: Uint8Array): number {
  let sumOfSquares = 0;
  const length = dataArray.length;

  for (let i = 0; i < length; i++) {
    // Normalize byte value: 128 = center/silence, range 0–255
    const normalized = (dataArray[i] - 128) / 128;
    sumOfSquares += normalized * normalized;
  }

  return Math.sqrt(sumOfSquares / length);
}

// ============================================================
// Exported Utility Functions
// ============================================================

/**
 * Formats a duration in seconds to "M:SS" string format.
 * Matches the Figma "0:14" pattern used in voice note duration
 * displays (e.g., Karen Castillo's chat row).
 *
 * @param seconds - Duration in seconds (non-negative)
 * @returns Formatted string in "M:SS" format (e.g., "0:14", "1:23", "10:05")
 */
export function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

/**
 * Detects and returns the first supported audio MIME type
 * for MediaRecorder in the current browser.
 *
 * Priority order:
 *   audio/webm;codecs=opus (Chrome, Edge)
 *   → audio/ogg;codecs=opus (Firefox)
 *   → audio/mp4 (Safari)
 *   → audio/mpeg
 *
 * @returns The first supported MIME type string
 * @throws Error if MediaRecorder is unavailable or no MIME type is supported
 */
export function getSupportedMimeType(): string {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder API is not available in this browser');
  }

  for (const mimeType of MIME_TYPE_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  throw new Error(
    'No supported audio MIME type found. Tried: ' +
      MIME_TYPE_CANDIDATES.join(', ')
  );
}

/**
 * Checks whether all required browser APIs for voice note recording
 * are available in the current environment.
 *
 * Verifies: navigator.mediaDevices.getUserMedia, MediaRecorder, AudioContext
 *
 * @returns true if all required APIs are present, false otherwise
 */
export function isVoiceNoteSupported(): boolean {
  const hasGetUserMedia =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof navigator.mediaDevices.getUserMedia === 'function';

  const hasMediaRecorder = typeof MediaRecorder !== 'undefined';

  const hasAudioContext =
    typeof AudioContext !== 'undefined' ||
    (typeof window !== 'undefined' &&
      typeof (window as unknown as AudioContextWindow).webkitAudioContext !==
        'undefined');

  return hasGetUserMedia && hasMediaRecorder && hasAudioContext;
}

/**
 * Creates an object URL for an audio Blob.
 * Used by VoiceNotePlayer to set the audio source element.
 *
 * @param blob - Audio Blob to create a URL for
 * @returns Object URL string
 */
export function createAudioUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

/**
 * Revokes a previously created object URL to free memory.
 * Should be called when VoiceNotePlayer unmounts.
 *
 * @param url - Object URL to revoke
 */
export function revokeAudioUrl(url: string): void {
  URL.revokeObjectURL(url);
}

/**
 * Generates normalized waveform amplitude data from an existing audio Blob.
 * Used to create waveform visualization for received voice notes
 * and voice notes loaded from IndexedDB.
 *
 * Decodes the audio, extracts PCM channel data, calculates RMS amplitude
 * for equally-spaced segments, and normalizes to 0.0–1.0 range.
 *
 * @param audioBlob - Audio Blob to analyze
 * @param sampleCount - Number of waveform samples to produce (default: 50)
 * @returns Array of normalized amplitudes (0.0–1.0)
 */
export async function generateWaveformFromBlob(
  audioBlob: Blob,
  sampleCount: number = TARGET_WAVEFORM_SAMPLES
): Promise<number[]> {
  const AudioContextClass = getAudioContextClass();
  if (!AudioContextClass) {
    return new Array<number>(sampleCount).fill(0);
  }

  const audioContext = new AudioContextClass();

  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    const totalSamples = channelData.length;

    if (totalSamples === 0) {
      return new Array<number>(sampleCount).fill(0);
    }

    const segmentLength = Math.floor(totalSamples / sampleCount);

    if (segmentLength === 0) {
      return new Array<number>(sampleCount).fill(0);
    }

    const waveform: number[] = [];
    let maxAmplitude = 0;

    // Calculate RMS amplitude for each segment
    for (let i = 0; i < sampleCount; i++) {
      const start = i * segmentLength;
      const end = Math.min(start + segmentLength, totalSamples);
      let sumOfSquares = 0;

      for (let j = start; j < end; j++) {
        sumOfSquares += channelData[j] * channelData[j];
      }

      const rms = Math.sqrt(sumOfSquares / (end - start));
      waveform.push(rms);

      if (rms > maxAmplitude) {
        maxAmplitude = rms;
      }
    }

    // Normalize all values to 0.0–1.0 range
    if (maxAmplitude > 0) {
      for (let i = 0; i < waveform.length; i++) {
        waveform[i] = waveform[i] / maxAmplitude;
      }
    }

    return waveform;
  } catch {
    // Return silent waveform for undecodable audio data
    return new Array<number>(sampleCount).fill(0);
  } finally {
    await audioContext.close();
  }
}

// ============================================================
// VoiceNoteRecorder Class
// ============================================================

/**
 * Records voice notes using MediaRecorder API with real-time
 * waveform visualization via Web Audio API AnalyserNode.
 *
 * Produces audio blobs ready for client-side encryption and upload.
 * Emits live recording state updates via an optional callback for
 * UI visualization during recording.
 *
 * @example
 * ```typescript
 * const recorder = new VoiceNoteRecorder((state) => {
 *   updateUI(state.duration, state.waveformData);
 * });
 *
 * await recorder.startRecording();
 * // ... user records voice note ...
 * const recording = await recorder.stopRecording();
 * // recording.blob — ready for encryption and upload
 * // recording.duration — seconds
 * // recording.waveform — 50-sample amplitude array
 * // recording.mimeType — detected audio format
 * ```
 */
export class VoiceNoteRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private chunks: Blob[] = [];
  private startTime: number = 0;
  private animationFrameId: number | null = null;
  private waveformSamples: number[] = [];
  private lastSampleTime: number = 0;
  private mimeType: string = '';
  private readonly onStateChange: RecordingCallback | null;

  /**
   * Creates a new VoiceNoteRecorder instance.
   *
   * @param onStateChange - Optional callback invoked with live recording
   *   state (duration, waveform) on each animation frame sample (~100ms)
   */
  constructor(onStateChange?: RecordingCallback) {
    this.onStateChange = onStateChange ?? null;
  }

  /**
   * Starts recording audio from the user's microphone.
   *
   * Requests microphone permission, initializes AudioContext with
   * AnalyserNode (fftSize=256, smoothing=0.8) for real-time waveform
   * data, and begins capturing audio via MediaRecorder in 100ms chunks.
   *
   * @throws Error if recording is already in progress
   * @throws Error if microphone access is denied
   * @throws Error if AudioContext is unavailable
   */
  async startRecording(): Promise<void> {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      throw new Error('Recording is already in progress');
    }

    // Reset internal state
    this.chunks = [];
    this.waveformSamples = [];
    this.lastSampleTime = 0;
    this.startTime = 0;

    // Request microphone access
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    // Initialize AudioContext and AnalyserNode
    const AudioContextClass = getAudioContextClass();
    if (!AudioContextClass) {
      this.releaseMediaStream();
      throw new Error('AudioContext is not available in this browser');
    }

    this.audioContext = new AudioContextClass();
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = ANALYSER_FFT_SIZE;
    this.analyserNode.smoothingTimeConstant = ANALYSER_SMOOTHING;

    // Connect media stream source to analyser for waveform visualization
    this.sourceNode = this.audioContext.createMediaStreamSource(
      this.mediaStream
    );
    this.sourceNode.connect(this.analyserNode);

    // Detect supported MIME type for recording
    this.mimeType = getSupportedMimeType();

    // Create and configure MediaRecorder
    this.mediaRecorder = new MediaRecorder(this.mediaStream, {
      mimeType: this.mimeType,
    });

    this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };

    // Start recording in 100ms chunks
    this.mediaRecorder.start(RECORDER_CHUNK_INTERVAL_MS);
    this.startTime = Date.now();

    // Start waveform sampling animation loop
    this.startWaveformSampling();
  }

  /**
   * Stops the current recording and returns the completed VoiceRecording.
   *
   * Resolves with the recorded audio blob, duration, downsampled waveform
   * data (~50 samples), and MIME type. All resources (microphone, AudioContext)
   * are released after the recording is finalized.
   *
   * @returns Promise resolving to VoiceRecording with blob, duration, waveform, mimeType
   * @throws Error if no recording is in progress
   */
  async stopRecording(): Promise<VoiceRecording> {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
      throw new Error('No recording in progress');
    }

    const recorder = this.mediaRecorder;
    const capturedMimeType = this.mimeType;
    const capturedStartTime = this.startTime;
    const capturedChunks = this.chunks;
    const capturedWaveformSamples = this.waveformSamples;

    // Stop the waveform animation loop before stopping the recorder
    this.stopWaveformSampling();

    return new Promise<VoiceRecording>((resolve, reject) => {
      recorder.onstop = () => {
        try {
          const blob = new Blob(capturedChunks, { type: capturedMimeType });
          const duration = (Date.now() - capturedStartTime) / 1000;
          const waveform = downsampleWaveform(
            capturedWaveformSamples,
            TARGET_WAVEFORM_SAMPLES
          );

          // Release all hardware and system resources
          this.cleanup();

          resolve({
            blob,
            duration,
            waveform,
            mimeType: capturedMimeType,
          });
        } catch (error) {
          this.cleanup();
          reject(error);
        }
      };

      recorder.onerror = () => {
        this.cleanup();
        reject(new Error('MediaRecorder encountered an error during stop'));
      };

      // Trigger the stop — fires onstop when all chunks are flushed
      recorder.stop();
    });
  }

  /**
   * Cancels the current recording without producing output.
   * Releases microphone and all allocated resources immediately.
   * Does not throw if no recording is active.
   */
  cancelRecording(): void {
    this.stopWaveformSampling();

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      // Detach handlers to prevent resolving any pending promises
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onerror = null;
      this.mediaRecorder.stop();
    }

    this.cleanup();
  }

  /**
   * Returns the current elapsed recording duration in seconds.
   *
   * @returns Duration in seconds, or 0 if not currently recording
   */
  getDuration(): number {
    if (this.startTime === 0) {
      return 0;
    }
    return (Date.now() - this.startTime) / 1000;
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * Starts the requestAnimationFrame loop for waveform sampling.
   * Samples RMS amplitude every ~100ms and emits state change events.
   */
  private startWaveformSampling(): void {
    const sample = (timestamp: number): void => {
      if (!this.analyserNode) {
        return;
      }

      // Only sample every ~100ms to control data volume
      if (timestamp - this.lastSampleTime >= WAVEFORM_SAMPLE_INTERVAL_MS) {
        this.lastSampleTime = timestamp;

        const bufferLength = this.analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        this.analyserNode.getByteTimeDomainData(dataArray);

        const rms = calculateRmsFromTimeDomain(dataArray);
        this.waveformSamples.push(rms);

        // Emit live state update via callback
        if (this.onStateChange) {
          this.onStateChange({
            isRecording: true,
            isPaused: false,
            duration: this.getDuration(),
            waveformData: [...this.waveformSamples],
          });
        }
      }

      this.animationFrameId = requestAnimationFrame(sample);
    };

    this.animationFrameId = requestAnimationFrame(sample);
  }

  /**
   * Stops the waveform sampling animation loop.
   */
  private stopWaveformSampling(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Releases the active MediaStream by stopping all tracks.
   * This releases the microphone hardware.
   */
  private releaseMediaStream(): void {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => {
        track.stop();
      });
      this.mediaStream = null;
    }
  }

  /**
   * Cleans up all allocated resources: disconnects source node,
   * closes AudioContext, releases MediaStream, and resets all
   * internal state. Safe to call multiple times.
   */
  private cleanup(): void {
    this.stopWaveformSampling();

    // Disconnect the audio source node
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // Source node may already be disconnected
      }
      this.sourceNode = null;
    }

    // Release microphone hardware
    this.releaseMediaStream();

    // Close the AudioContext
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {
        // Silently handle close failure — context may already be closed
      });
    }

    this.audioContext = null;
    this.analyserNode = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.startTime = 0;
  }
}
