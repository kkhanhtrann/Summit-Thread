import { describe, expect, it } from 'vitest';

import type { VisualMoment, VisualReviewRecording } from '../contracts';
import { describeVisualReview, formatSourceTime, mergeReleasedMoment } from './visualMomentState';

// Synthetic released moment for state tests
const moment = (id: string, timestampMs: number, captionId: string | null = null): VisualMoment => ({
  id, timestampMs, topicTitle: 'Synthetic slide', description: 'A synthetic chart.', imageUrl: `/img/${id}`, captionId, occurrenceId: null, threadId: null
});

// Synthetic uploaded video recording state
const recording = (overrides: Partial<VisualReviewRecording> = {}): VisualReviewRecording => ({
  sourceType: 'upload', status: 'ready', preparationStage: null, mediaKind: 'video', mimeType: 'video/mp4', durationMs: 600_000,
  playbackPositionMs: 0, isPlaying: true, analysisWindowMinutes: 5, visualReviewSkippedWindowCount: 0, analysisThroughMs: 0,
  analysisState: 'waiting', mediaUrl: '/media', ...overrides
});

describe('visual moment state', () => {
  it('merges repeated events and reconnect snapshots without duplicates, in source order', () => {
    const merged = [moment('moment-0001', 490_000), moment('moment-0000', 10_000), moment('moment-0001', 490_000, 'caption-9')]
      .reduce(mergeReleasedMoment, [] as VisualMoment[]);
    expect(merged.map(({ id, captionId }) => [id, captionId])).toEqual([['moment-0000', null], ['moment-0001', 'caption-9']]);
  });

  it('describes pending, audio-only, failed, and complete review states', () => {
    expect(describeVisualReview(null, 0)).toBeNull();
    expect(describeVisualReview(recording(), 0)?.status).toBe('Stills appear after each 5-minute interval has played');
    expect(describeVisualReview(recording({ mediaKind: 'audio' }), 0)?.status).toBe('Audio only · no stills to review');
    expect(describeVisualReview(recording({ analysisState: 'failed' }), 0)?.status).toContain('will retry');
    expect(describeVisualReview(recording({ analysisState: 'complete' }), 0)?.status).toBe('No useful stills were found');
    expect(describeVisualReview(recording({ analysisState: 'complete' }), 2)?.status).toBe('2 stills selected');
  });

  it('reports partial review honestly when windows were skipped or history is unknown', () => {
    expect(describeVisualReview(recording({ visualReviewSkippedWindowCount: 1, analysisState: 'complete' }), 1)?.partial).toContain('1 interval of video couldn’t be checked');
    expect(describeVisualReview(recording({ visualReviewSkippedWindowCount: null }), 0)?.partial).toBe('Review history for earlier video is unavailable');
    expect(describeVisualReview(recording(), 0)?.partial).toBeNull();
  });

  it('formats original source offsets', () => {
    expect(formatSourceTime(490_000)).toBe('8:10');
    expect(formatSourceTime(3_725_000)).toBe('1:02:05');
  });
});
