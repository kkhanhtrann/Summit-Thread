import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSourceClock } from './useSourceClock';

// Describe a synthetic shared clock committed by the presenter
function clock(positionMs: number, isPlaying: boolean, durationMs: number | null = 723_000) {
  return { playbackPositionMs: positionMs, playbackUpdatedAt: new Date(Date.now()).toISOString(), isPlaying, durationMs };
}

describe('useSourceClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('advances from the committed playback time while the source plays', () => {
    const value = clock(48_000, true);
    const { result } = renderHook(() => useSourceClock(value));
    expect(result.current).toBe(48_000);

    act(() => vi.advanceTimersByTime(3_000));
    expect(result.current).toBe(51_000);
  });

  it('holds the committed position while playback is paused', () => {
    const value = clock(48_000, false);
    const { result } = renderHook(() => useSourceClock(value));

    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current).toBe(48_000);
  });

  it('restarts from each newly committed presenter position', () => {
    const { result, rerender } = renderHook(({ value }) => useSourceClock(value), {
      initialProps: { value: clock(10_000, true, null) }
    });
    act(() => vi.advanceTimersByTime(2_000));
    rerender({ value: clock(60_000, true, null) });

    expect(result.current).toBe(60_000);
  });

  it('stops at the end of the recording', () => {
    const value = clock(9_000, true, 10_000);
    const { result } = renderHook(() => useSourceClock(value));

    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current).toBe(10_000);
  });

  it('reports zero without a recording', () => {
    const { result } = renderHook(() => useSourceClock(null));
    expect(result.current).toBe(0);
  });
});
