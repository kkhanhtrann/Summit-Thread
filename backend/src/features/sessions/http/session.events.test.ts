import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createApp } from '../../../app';
import type {
  SessionEvent,
  SessionSnapshot
} from '../contracts/session.contract';

it('subscribes before the snapshot and sends only newer buffered revisions', async () => {
  let publish: ((event: SessionEvent) => void) | undefined;
  let resolveSnapshot!: (snapshot: SessionSnapshot) => void;
  const unsubscribe = vi.fn();
  const sessions = {
    createSession: vi.fn(),
    getSnapshot: vi.fn(
      () =>
        new Promise<SessionSnapshot>((resolve) => {
          resolveSnapshot = resolve;
        })
    ),
    subscribe: vi.fn((_id, listener) => {
      publish = listener;
      return unsubscribe;
    })
  };
  const recordings = {
    upload: vi.fn(),
    updatePlayback: vi.fn(),
    getMediaFile: vi.fn()
  };
  const server = createServer(createApp(undefined, { sessions, recordings }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing port');
  const controller = new AbortController();
  try {
    const opening = fetch(
      `http://127.0.0.1:${address.port}/api/sessions/AB12CD34/events`,
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(publish).toBeTypeOf('function'));
    publish?.({ type: 'live_status_changed', revision: 1, isLive: true });
    publish?.({
      type: 'caption_released',
      revision: 2,
      caption: {
        id: 'synthetic-final',
        sequence: 0,
        timestampMs: 1200,
        text: 'Synthetic final'
      }
    });
    resolveSnapshot({
      session: {
        id: 'AB12CD34',
        title: 'Synthetic SSE fixture',
        eventName: 'Conference session',
        speakerName: 'Presenter',
        contentLabel: 'Recording playback',
        revision: 1,
        releasedCount: 0,
        isLive: true
      },
      captions: [],
      threads: [],
      activeOccurrenceId: null,
      suggestedQuestions: [],
      topicAnalysisSkippedCaptionCount: 0,
      recording: null,
      visualMoments: []
    });
    const response = await opening;
    const reader = response.body!.getReader();
    let output = '';
    while (!output.includes('synthetic-final'))
      output += new TextDecoder().decode((await reader.read()).value);
    expect(output.indexOf('event: snapshot')).toBeLessThan(
      output.indexOf('event: caption_released')
    );
    expect(output).not.toContain('event: live_status_changed');
    controller.abort();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalled());
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
