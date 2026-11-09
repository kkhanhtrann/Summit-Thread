import type { PreparedVisualMoment } from '../contracts/session.contract';

// Bound provider titles and alternative descriptions before they reach attendee state
export const MAX_VISUAL_TITLE_LENGTH = 120;
export const MAX_VISUAL_DESCRIPTION_LENGTH = 280;

// Describe one source interval in original source time
export interface AnalysisWindow {
  index: number;
  startMs: number;
  durationMs: number;
}

// Describe the clock and cursor fields that decide which uploaded interval may be analyzed
export interface ElapsedWindowInput {
  sourceType: 'upload' | 'camera';
  status: 'preparing' | 'ready' | 'failed';
  mediaKind: 'audio' | 'video';
  durationMs: number | null;
  playbackPositionMs: number;
  analysisWindowMinutes: number;
  analysisWindowCount: number;
  analysisThroughMs: number;
}

// Describe one provider suggestion relative to the start of its isolated clip
export interface WindowRelativeMoment {
  offsetMs: number;
  title: string;
  description: string;
}

// Signal provider output that cannot be accepted for the analyzed window
export class InvalidVisualOutputError extends Error {
  readonly category = 'invalid_output' as const;

  constructor() {
    super('Visual analysis output is invalid for its window');
    this.name = 'InvalidVisualOutputError';
  }
}

// Return the next uploaded interval only when the shared playback clock has reached its end
// The final shorter interval qualifies only once playback reaches the source end
export function nextElapsedWindow(source: ElapsedWindowInput): AnalysisWindow | null {
  if (source.sourceType !== 'upload' || source.status !== 'ready' || source.mediaKind !== 'video') return null;
  if (source.durationMs === null || source.durationMs <= 0) return null;
  const cadenceMs = source.analysisWindowMinutes * 60_000;
  if (!Number.isSafeInteger(cadenceMs) || cadenceMs <= 0) return null;

  const startMs = source.analysisThroughMs;
  if (startMs >= source.durationMs) return null;
  const endMs = Math.min(source.durationMs, startMs + cadenceMs);
  if (endMs > source.playbackPositionMs) return null;
  return { index: source.analysisWindowCount, startMs, durationMs: endMs - startMs };
}

// Confirm the latest clock and cursor still permit exactly the window being processed
export function isSameElapsedWindow(source: ElapsedWindowInput, window: AnalysisWindow): boolean {
  const current = nextElapsedWindow(source);
  return current !== null
    && current.index === window.index
    && current.startMs === window.startMs
    && current.durationMs === window.durationMs;
}

// Derive a stable room-scoped ID from the window index because each window yields at most one still
export function momentIdForWindow(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 9_999) throw new RangeError('Visual window index is invalid');
  return `moment-${String(index).padStart(4, '0')}`;
}

// Validate at most one suggestion and translate its clip offset to original source time exactly once
// Uses a half-open window so a boundary frame belongs to the later window
export function selectWindowMoment(
  window: AnalysisWindow,
  moments: readonly WindowRelativeMoment[]
): { moment: PreparedVisualMoment; offsetMs: number } | null {
  if (moments.length === 0) return null;
  if (moments.length > 1) throw new InvalidVisualOutputError();
  const [candidate] = moments as [WindowRelativeMoment];
  const title = candidate.title.trim();
  const description = candidate.description.trim();
  if (!Number.isSafeInteger(candidate.offsetMs) || candidate.offsetMs < 0 || candidate.offsetMs >= window.durationMs) {
    throw new InvalidVisualOutputError();
  }
  if (!title || title.length > MAX_VISUAL_TITLE_LENGTH || !description || description.length > MAX_VISUAL_DESCRIPTION_LENGTH) {
    throw new InvalidVisualOutputError();
  }

  return {
    offsetMs: candidate.offsetMs,
    moment: {
      id: momentIdForWindow(window.index),
      timestampMs: window.startMs + candidate.offsetMs,
      topicTitle: title,
      description
    }
  };
}
