import { describe, expect, it, vi } from 'vitest';

import {
  LiveTranscriptionCoordinator,
  type LiveSpeechProvider,
  type LiveSpeechUpdate
} from './liveTranscriptionCoordinator';

// Keep provider callbacks available to verify source-timed final commits
function makeProvider() {
  let onTranscript: ((update: LiveSpeechUpdate) => void) | undefined;
  const session = {
    sendAudio: vi.fn(),
    finish: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  };
  const provider: LiveSpeechProvider = {
    connect: vi.fn(async (receive) => {
      onTranscript = receive;
      return session;
    })
  };
  return {
    provider,
    session,
    sendTranscript: (update: LiveSpeechUpdate) => onTranscript?.(update)
  };
}

describe('LiveTranscriptionCoordinator', () => {
  it('persists final speech at the latest source time and defers topic grouping', async () => {
    const provider = makeProvider();
    const releaseFinalCaption = vi.fn(async () => ({
      id: 'AB12CD34-caption-001'
    }));
    const coordinator = new LiveTranscriptionCoordinator({
      provider: provider.provider,
      publisher: { releaseFinalCaption }
    });
    const capture = await coordinator.start('AB12CD34', 1_200, vi.fn());

    capture.setPosition(3_400);
    provider.sendTranscript({
      type: 'final',
      text: '  The talk is underway.  '
    });
    await capture.flush();

    expect(releaseFinalCaption).toHaveBeenCalledWith(
      'AB12CD34',
      'The talk is underway.',
      3_400,
      { deferTopicAnalysis: true, captionId: expect.any(String) }
    );
    await capture.stop();
    expect(provider.session.finish).toHaveBeenCalledOnce();
    expect(provider.session.close).toHaveBeenCalledOnce();
  });

  it('keeps interim speech out of persistence', async () => {
    const provider = makeProvider();
    const releaseFinalCaption = vi.fn(async () => ({
      id: 'AB12CD34-caption-001'
    }));
    const coordinator = new LiveTranscriptionCoordinator({
      provider: provider.provider,
      publisher: { releaseFinalCaption }
    });
    const capture = await coordinator.start('AB12CD34', 0, vi.fn());

    provider.sendTranscript({ type: 'interim', text: 'A partial sentence' });
    await capture.flush();

    expect(releaseFinalCaption).not.toHaveBeenCalled();
    await capture.stop();
  });
});

describe('transcript recovery and ordering', () => {
  it('retries a failed durable write with one ID and flushes provider finals on stop', async () => {
    const provider = makeProvider();
    const releaseFinalCaption = vi
      .fn()
      .mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE'))
      .mockResolvedValue({});
    const coordinator = new LiveTranscriptionCoordinator({
      provider: provider.provider,
      publisher: { releaseFinalCaption }
    });
    const capture = await coordinator.start('AB12CD34', 1250, vi.fn());
    provider.session.finish.mockImplementation(async () => {
      provider.sendTranscript({
        type: 'final',
        text: 'Synthetic final on stop'
      });
    });
    await capture.stop();
    expect(releaseFinalCaption).toHaveBeenCalledTimes(2);
    expect(releaseFinalCaption.mock.calls[0]).toEqual(
      releaseFinalCaption.mock.calls[1]
    );
    provider.sendTranscript({ type: 'final', text: 'Stale callback' });
    await capture.flush();
    expect(releaseFinalCaption).toHaveBeenCalledTimes(2);
  });
  it('rejects duplicate capture and ignores repeated provider finals', async () => {
    const provider = makeProvider();
    const releaseFinalCaption = vi.fn().mockResolvedValue({});
    const coordinator = new LiveTranscriptionCoordinator({
      provider: provider.provider,
      publisher: { releaseFinalCaption }
    });
    const capture = await coordinator.start('AB12CD34', 0, vi.fn());
    await expect(coordinator.start('AB12CD34', 0, vi.fn())).rejects.toThrow();
    provider.sendTranscript({
      type: 'final',
      text: 'Synthetic repeated final'
    });
    provider.sendTranscript({
      type: 'final',
      text: 'Synthetic repeated final'
    });
    await capture.flush();
    expect(releaseFinalCaption).toHaveBeenCalledOnce();
    await capture.stop();
  });
});

it('preserves a complete finalized utterance rather than silently truncating it', async () => {
  const provider = makeProvider();
  const releaseFinalCaption = vi.fn().mockResolvedValue({});
  const coordinator = new LiveTranscriptionCoordinator({
    provider: provider.provider,
    publisher: { releaseFinalCaption }
  });
  const capture = await coordinator.start('AB12CD34', 2500, vi.fn());
  const text = 'Synthetic extended final '.repeat(150).trim();
  provider.sendTranscript({ type: 'final', text });
  await capture.flush();
  expect(releaseFinalCaption).toHaveBeenCalledWith(
    'AB12CD34',
    text,
    2500,
    expect.any(Object)
  );
  await capture.stop();
});
