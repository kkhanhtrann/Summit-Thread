import type { SessionRecordingView } from '../contracts/session.contract';

// Describe the persisted recording fields needed to build the attendee recording view
export type RecordingViewSource = Omit<SessionRecordingView, 'mediaUrl'>;

// Build the attendee recording view with stable room routes and no storage paths
// Shared with the media workflow so recording events stay identical across owners
export function toRecordingView(sessionId: string, recording: RecordingViewSource): SessionRecordingView {
  return {
    sourceType: recording.sourceType,
    status: recording.status,
    preparationStage: recording.preparationStage,
    mediaKind: recording.mediaKind,
    mimeType: recording.mimeType,
    durationMs: recording.durationMs,
    playbackPositionMs: recording.playbackPositionMs,
    playbackUpdatedAt: recording.playbackUpdatedAt,
    isPlaying: recording.isPlaying,
    analysisWindowMinutes: recording.analysisWindowMinutes,
    visualReviewSkippedWindowCount: recording.visualReviewSkippedWindowCount,
    analysisThroughMs: recording.analysisThroughMs,
    analysisState: recording.analysisState,
    mediaUrl: `/api/sessions/${encodeURIComponent(sessionId)}/recording/media`
  };
}
