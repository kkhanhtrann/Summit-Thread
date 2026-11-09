import { describe, expect, it } from 'vitest';

import type { components } from '../../../lib/api/generated';
import { applySessionEvent, requiresSessionRefresh } from './sessionFeedState';

type Snapshot = components['schemas']['SessionSnapshot'];
type SessionEvent = components['schemas']['SessionEvent'];

// Represent a persisted room revision received by one attendee
const currentSnapshot: Snapshot = {
  session: {
    id: 'AB12CD34',
    title: 'Opening keynote',
    eventName: 'Conference session',
    speakerName: 'Presenter',
    contentLabel: 'Live session',
    revision: 8,
    releasedCount: 3,
    isLive: true
  },
  captions: [],
  threads: [],
  activeOccurrenceId: null,
  suggestedQuestions: [],
  topicAnalysisSkippedCaptionCount: 0,
  recording: null,
  visualMoments: []
};

// Create a topic update that arrived behind a newer room revision
const staleTopicEvent: SessionEvent = {
  type: 'topic_updated',
  revision: 7,
  snapshot: currentSnapshot
};

describe('requiresSessionRefresh', () => {
  it('refreshes a persisted snapshot when a late topic event could be stale', () => {
    expect(requiresSessionRefresh(currentSnapshot, staleTopicEvent)).toBe(true);
  });

  it('refreshes when a revision gap indicates an update may be missing', () => {
    const event: SessionEvent = {
      type: 'live_status_changed',
      revision: 10,
      isLive: false
    };

    expect(requiresSessionRefresh(currentSnapshot, event)).toBe(true);
  });

  it('keeps an in-order update on the existing event path', () => {
    const event: SessionEvent = {
      type: 'caption_released',
      revision: 9,
      caption: {
        id: 'AB12CD34-caption-003',
        sequence: 3,
        timestampMs: 4_000,
        text: 'A new released sentence'
      }
    };

    expect(requiresSessionRefresh(currentSnapshot, event)).toBe(false);
  });
});

const recording: components['schemas']['SessionRecording'] = {
  sourceType: 'upload',
  status: 'ready',
  preparationStage: null,
  mediaKind: 'audio',
  mimeType: 'audio/wav',
  durationMs: 60000,
  playbackPositionMs: 1200,
  playbackUpdatedAt: '2026-01-01T00:00:00Z',
  isPlaying: false,
  analysisWindowMinutes: 5,
  visualReviewSkippedWindowCount: null,
  analysisThroughMs: 0,
  analysisState: 'waiting',
  mediaUrl: '/synthetic-media'
};
it.each([true, false])(
  'keeps room activity consistent with atomic recording updates: %s',
  (isPlaying) => {
    const result = applySessionEvent(currentSnapshot, {
      type: 'recording_updated',
      revision: 9,
      recording: { ...recording, isPlaying }
    });
    expect(result?.session.isLive).toBe(isPlaying);
    expect(result?.session.revision).toBe(9);
  }
);
it('ignores stale revisions and deduplicates caption IDs across reconnect updates', () => {
  const caption = {
    id: 'synthetic-stable',
    sequence: 0,
    timestampMs: 1200,
    text: 'Synthetic finalized fixture'
  };
  const current = {
    ...currentSnapshot,
    captions: [caption],
    session: { ...currentSnapshot.session, releasedCount: 1 }
  };
  const event = { type: 'caption_released', revision: 9, caption } as const;
  expect(applySessionEvent(current, event)?.captions).toEqual([caption]);
  expect(applySessionEvent(current, { ...event, revision: 7 })).toBe(current);
});
