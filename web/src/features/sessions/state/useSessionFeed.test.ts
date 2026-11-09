import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { components } from '../../../lib/api/generated';
import { useSessionFeed } from './useSessionFeed';

type Snapshot = components['schemas']['SessionSnapshot'];
type SessionEvent = components['schemas']['SessionEvent'];

// Replace the HTTP and event-stream adapters with controllable room updates
const apiMocks = vi.hoisted(() => ({
  fetchSession: vi.fn(),
  subscribeSession: vi.fn()
}));

vi.mock('../api/sessionsApi', () => ({
  fetchSession: apiMocks.fetchSession,
  subscribeSession: apiMocks.subscribeSession
}));

// Build a room snapshot at the requested persisted revision
function makeSnapshot(revision: number): Snapshot {
  return {
    session: {
      id: 'AB12CD34',
      title: 'Opening keynote',
      eventName: 'Conference session',
      speakerName: 'Presenter',
      contentLabel: 'Live session',
      revision,
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
}

describe('useSessionFeed', () => {
  let publish: ((event: SessionEvent) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    publish = undefined;
    apiMocks.subscribeSession.mockImplementation(
      (_sessionId: string, onEvent: (event: SessionEvent) => void) => {
        publish = onEvent;
        return vi.fn();
      }
    );
  });

  it('replays updates received during an authoritative catch-up without losing newer revisions', async () => {
    let resolveFirstRefresh: (snapshot: Snapshot) => void = () => undefined;
    apiMocks.fetchSession
      .mockResolvedValueOnce(makeSnapshot(8))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRefresh = resolve;
          })
      );

    const { result } = renderHook(() => useSessionFeed('AB12CD34'));
    await waitFor(() => expect(publish).toBeTypeOf('function'));

    act(() =>
      publish?.({
        type: 'topic_updated',
        revision: 7,
        snapshot: makeSnapshot(7)
      })
    );
    await waitFor(() => expect(apiMocks.fetchSession).toHaveBeenCalledTimes(2));

    act(() =>
      publish?.({ type: 'live_status_changed', revision: 10, isLive: false })
    );
    await act(async () => resolveFirstRefresh(makeSnapshot(9)));
    expect(apiMocks.fetchSession).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(result.current.snapshot?.session.revision).toBe(10)
    );
  });
  it('clears the selected room and ignores late updates from an old subscription', async () => {
    const stop = vi.fn();
    let oldPublish: ((event: SessionEvent) => void) | undefined;
    apiMocks.fetchSession
      .mockResolvedValueOnce(makeSnapshot(1))
      .mockImplementationOnce(() => new Promise(() => {}));
    apiMocks.subscribeSession.mockImplementationOnce((_id, onEvent) => {
      oldPublish = onEvent;
      return stop;
    });
    const { result, rerender } = renderHook(({ id }) => useSessionFeed(id), {
      initialProps: { id: 'AB12CD34' }
    });
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    rerender({ id: 'DEADBEEF' });
    expect(result.current.snapshot).toBeNull();
    act(() =>
      oldPublish?.({ type: 'live_status_changed', revision: 2, isLive: false })
    );
    expect(result.current.snapshot).toBeNull();
    expect(stop).toHaveBeenCalledOnce();
  });
  it('retries an API that is temporarily unavailable during startup', async () => {
    apiMocks.fetchSession
      .mockRejectedValueOnce(
        Object.assign(new Error('Unavailable'), { statusCode: 503 })
      )
      .mockResolvedValue(makeSnapshot(0));
    const { result } = renderHook(() => useSessionFeed('AB12CD34'));
    await waitFor(() =>
      expect(result.current.connectionState).toBe('reconnecting')
    );
    await waitFor(
      () => expect(result.current.snapshot?.session.id).toBe('AB12CD34'),
      { timeout: 2500 }
    );
  });
});
