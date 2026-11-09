import type { components } from '../../../lib/api/generated';

type Snapshot = components['schemas']['SessionSnapshot'];
type SessionEvent = components['schemas']['SessionEvent'];

// Fetch a persisted room snapshot when SSE delivery leaves a revision gap
export function requiresSessionRefresh(
  current: Snapshot | null,
  event: SessionEvent
): boolean {
  if (!current || event.type === 'snapshot') return false;

  // Reconcile a stale full-topic payload against persisted state
  return (
    event.revision > current.session.revision + 1 ||
    (event.type === 'topic_updated' &&
      event.revision <= current.session.revision)
  );
}

// Apply only newer room revisions and deduplicate captions during SSE reconnects
export function applySessionEvent(
  current: Snapshot | null,
  event: SessionEvent
): Snapshot | null {
  if (event.type === 'snapshot') {
    if (current && event.session.revision < current.session.revision)
      return current;
    return {
      session: event.session,
      captions: event.captions,
      threads: event.threads,
      activeOccurrenceId: event.activeOccurrenceId,
      suggestedQuestions: event.suggestedQuestions,
      topicAnalysisSkippedCaptionCount: event.topicAnalysisSkippedCaptionCount,
      recording: event.recording,
      visualMoments: event.visualMoments
    };
  }
  if (!current || event.revision <= current.session.revision) return current;

  if (event.type === 'topic_updated') {
    // Replace the full snapshot so topic history and question prompts stay synchronized
    return event.snapshot;
  }

  if (event.type === 'caption_released') {
    const captions = current.captions.some(
      (caption) => caption.id === event.caption.id
    )
      ? current.captions
      : [...current.captions, event.caption].sort(
          (left, right) => left.sequence - right.sequence
        );
    return {
      session: {
        ...current.session,
        revision: event.revision,
        releasedCount: Math.max(
          current.session.releasedCount,
          event.caption.sequence + 1
        )
      },
      captions,
      threads: current.threads,
      activeOccurrenceId: current.activeOccurrenceId,
      suggestedQuestions: current.suggestedQuestions,
      topicAnalysisSkippedCaptionCount:
        current.topicAnalysisSkippedCaptionCount,
      recording: current.recording,
      visualMoments: current.visualMoments
    };
  }

  if (event.type === 'recording_updated') {
    return {
      ...current,
      session: {
        ...current.session,
        revision: event.revision,
        isLive: event.recording.isPlaying
      },
      recording: event.recording
    };
  }

  if (event.type === 'visual_moment_released') {
    const visualMoments = current.visualMoments.some(
      (moment) => moment.id === event.moment.id
    )
      ? current.visualMoments
      : [...current.visualMoments, event.moment].sort(
          (left, right) => left.timestampMs - right.timestampMs
        );
    return {
      ...current,
      session: { ...current.session, revision: event.revision },
      visualMoments
    };
  }

  return {
    ...current,
    session: {
      ...current.session,
      revision: event.revision,
      isLive: event.isLive
    }
  };
}
