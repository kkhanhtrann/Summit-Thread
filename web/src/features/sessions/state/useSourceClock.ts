import { useEffect, useState } from 'react';

import type { SessionRecording } from '../api/sessionsApi';

// Describe the committed presenter clock fields needed to estimate source time
type SourceClock = Pick<SessionRecording, 'playbackPositionMs' | 'playbackUpdatedAt' | 'isPlaying' | 'durationMs'>;

// Estimate the shared source position between presenter clock updates
// Derive elapsed time from the committed update time so every view ticks in step
export function useSourceClock(recording: SourceClock | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const isPlaying = Boolean(recording?.isPlaying);

  useEffect(() => {
    setNow(Date.now());
    if (!isPlaying) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [isPlaying, recording?.playbackPositionMs, recording?.playbackUpdatedAt]);

  if (!recording) return 0;
  const elapsedMs = isPlaying ? Math.max(0, now - Date.parse(recording.playbackUpdatedAt)) : 0;
  const estimated = recording.playbackPositionMs + elapsedMs;
  return recording.durationMs === null ? estimated : Math.min(estimated, recording.durationMs);
}
