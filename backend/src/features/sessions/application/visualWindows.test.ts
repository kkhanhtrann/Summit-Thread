import { describe, expect, it } from 'vitest';

import { InvalidVisualOutputError, isSameElapsedWindow, momentIdForWindow, nextElapsedWindow, selectWindowMoment, type ElapsedWindowInput } from './visualWindows';

// Build a ready uploaded video with a five-minute cadence and a 12-minute source
function source(overrides: Partial<ElapsedWindowInput> = {}): ElapsedWindowInput {
  return {
    sourceType: 'upload',
    status: 'ready',
    mediaKind: 'video',
    durationMs: 720_000,
    playbackPositionMs: 0,
    analysisWindowMinutes: 5,
    analysisWindowCount: 0,
    analysisThroughMs: 0,
    ...overrides
  };
}

describe('elapsed window boundaries', () => {
  it('permits 0:00-5:00 only at or after 5:00', () => {
    expect(nextElapsedWindow(source({ playbackPositionMs: 299_999 }))).toBeNull();
    expect(nextElapsedWindow(source({ playbackPositionMs: 300_000 }))).toEqual({ index: 0, startMs: 0, durationMs: 300_000 });
  });

  it('permits 5:00-10:00 only at or after 10:00', () => {
    const afterFirst = { analysisWindowCount: 1, analysisThroughMs: 300_000 };
    expect(nextElapsedWindow(source({ ...afterFirst, playbackPositionMs: 599_999 }))).toBeNull();
    expect(nextElapsedWindow(source({ ...afterFirst, playbackPositionMs: 600_000 }))).toEqual({ index: 1, startMs: 300_000, durationMs: 300_000 });
  });

  it('permits the final shorter interval only at the source end', () => {
    const afterSecond = { analysisWindowCount: 2, analysisThroughMs: 600_000 };
    expect(nextElapsedWindow(source({ ...afterSecond, playbackPositionMs: 719_999 }))).toBeNull();
    expect(nextElapsedWindow(source({ ...afterSecond, playbackPositionMs: 720_000 }))).toEqual({ index: 2, startMs: 600_000, durationMs: 120_000 });
    expect(nextElapsedWindow(source({ analysisWindowCount: 3, analysisThroughMs: 720_000, playbackPositionMs: 720_000 }))).toBeNull();
  });

  it('never selects audio-only, camera, or unready sources', () => {
    expect(nextElapsedWindow(source({ mediaKind: 'audio', playbackPositionMs: 720_000 }))).toBeNull();
    expect(nextElapsedWindow(source({ sourceType: 'camera', playbackPositionMs: 720_000 }))).toBeNull();
    expect(nextElapsedWindow(source({ status: 'preparing', playbackPositionMs: 720_000 }))).toBeNull();
  });

  it('rejects a window once the clock moves back before its end', () => {
    const window = { index: 0, startMs: 0, durationMs: 300_000 };
    expect(isSameElapsedWindow(source({ playbackPositionMs: 300_000 }), window)).toBe(true);
    expect(isSameElapsedWindow(source({ playbackPositionMs: 120_000 }), window)).toBe(false);
  });
});

describe('window moment validation', () => {
  const window = { index: 1, startMs: 300_000, durationMs: 300_000 };

  it('translates a window offset to source time once', () => {
    const selected = selectWindowMoment(window, [{ offsetMs: 190_000, title: ' Architecture slide ', description: ' A diagram of three services. ' }]);
    expect(selected).toEqual({
      offsetMs: 190_000,
      moment: { id: 'moment-0001', timestampMs: 490_000, topicTitle: 'Architecture slide', description: 'A diagram of three services.' }
    });
  });

  it('accepts a window that legitimately yields no moment', () => {
    expect(selectWindowMoment(window, [])).toBeNull();
  });

  it('rejects out-of-range offsets, extra moments, and unbounded text', () => {
    const valid = { offsetMs: 0, title: 'Slide', description: 'A chart.' };
    expect(() => selectWindowMoment(window, [{ ...valid, offsetMs: 300_000 }])).toThrow(InvalidVisualOutputError);
    expect(() => selectWindowMoment(window, [{ ...valid, offsetMs: -1 }])).toThrow(InvalidVisualOutputError);
    expect(() => selectWindowMoment(window, [valid, valid])).toThrow(InvalidVisualOutputError);
    expect(() => selectWindowMoment(window, [{ ...valid, description: 'x'.repeat(281) }])).toThrow(InvalidVisualOutputError);
    expect(() => selectWindowMoment(window, [{ ...valid, title: '  ' }])).toThrow(InvalidVisualOutputError);
  });

  it('derives stable moment IDs from window indexes', () => {
    expect(momentIdForWindow(0)).toBe('moment-0000');
    expect(momentIdForWindow(42)).toBe('moment-0042');
    expect(() => momentIdForWindow(10_000)).toThrow(RangeError);
  });
});
