import type { VisualMoment, VisualReviewRecording } from '../contracts';

// Merge one released moment by stable ID so repeated events or reconnect snapshots never duplicate it
// A newer copy replaces an older one, keeping late speech/topic links from the latest snapshot
export function mergeReleasedMoment(moments: readonly VisualMoment[], incoming: VisualMoment): VisualMoment[] {
  return [...moments.filter((moment) => moment.id !== incoming.id), incoming]
    .sort((left, right) => left.timestampMs - right.timestampMs);
}

// Describe visual review progress plainly, including honest partial-review diagnostics
export function describeVisualReview(recording: VisualReviewRecording | null, releasedCount: number): { status: string; partial: string | null } | null {
  if (!recording) return null;
  if (recording.mediaKind === 'audio') return { status: 'Audio only · no stills to review', partial: null };
  if (recording.status === 'preparing') return { status: 'Video is processing', partial: null };
  if (recording.status === 'failed') return { status: 'Video unavailable', partial: null };

  const skipped = recording.visualReviewSkippedWindowCount;
  const partial = skipped === null
    ? 'Review history for earlier video is unavailable'
    : skipped > 0
      ? `${skipped} ${skipped === 1 ? 'interval' : 'intervals'} of video couldn’t be checked, so some stills may be missing`
      : null;
  const selected = `${releasedCount} ${releasedCount === 1 ? 'still' : 'stills'} so far`;

  if (recording.analysisState === 'analyzing') {
    return { status: releasedCount > 0 ? `${selected} · Checking the latest finished interval` : 'Checking the latest finished interval for a useful still', partial };
  }
  if (recording.analysisState === 'failed') return { status: 'Visual review hit a problem and will retry · Captions and topics are unaffected', partial };
  if (recording.analysisState === 'complete') {
    return { status: releasedCount > 0 ? `${releasedCount} ${releasedCount === 1 ? 'still' : 'stills'} selected` : 'No useful stills were found', partial };
  }
  const cadence = recording.sourceType === 'camera'
    ? 'Stills appear after each captured interval is checked'
    : `Stills appear after each ${recording.analysisWindowMinutes}-minute interval has played`;
  return { status: releasedCount > 0 ? `${selected} · ${cadence}` : cadence, partial };
}

// Format an original source offset as m:ss or h:mm:ss
export function formatSourceTime(timestampMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timestampMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

// Express a source offset as an ISO 8601 duration for the time element
export function sourceTimeDuration(timestampMs: number): string {
  return `PT${Math.max(0, Math.floor(timestampMs / 1_000))}S`;
}
