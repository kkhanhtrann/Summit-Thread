import { act, render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LiveCameraPublisher } from './LiveCameraPublisher';
import type { SessionRecording } from '../sessions/public';

const mocks = vi.hoisted(() => ({ state: undefined as ((connected: boolean) => void) | undefined, stop: vi.fn().mockResolvedValue({}), close: vi.fn() }));
vi.mock('../sessions/public', () => ({
  connectLiveMedia: (_id: string, _role: string, _events: unknown, state: (connected: boolean) => void) => { mocks.state = state; return { socket: {}, close: mocks.close }; },
  sendLiveSignal: vi.fn(), stopLiveCapture: mocks.stop, uploadLiveWindow: vi.fn(), updateRecordingPlayback: vi.fn().mockResolvedValue({})
}));
vi.mock('../transcription/public', () => ({ connectLiveTranscription: vi.fn().mockResolvedValue({ stop: async () => undefined, setPosition: () => undefined }) }));

it.each([false, true])('ends capture after signaling loss even if API shutdown fails: %s', async fails => {
  mocks.stop.mockReset();
  if (fails) mocks.stop.mockRejectedValue(new Error('Synthetic dependency failure'));
  else mocks.stop.mockResolvedValue({});
  class Recorder {
    static isTypeSupported() { return true; }
    state = 'inactive';
    onstop: (() => void) | null = null;
    mimeType = 'video/webm';
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  const trackStop = vi.fn();
  const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
  const ended = vi.fn();
  const view = render(<LiveCameraPublisher sessionId="AB12CD34" stream={stream} recording={{ analysisWindowMinutes: 1 } as SessionRecording} onEnded={ended} />);
  await act(async () => { mocks.state?.(false); });
  await waitFor(() => expect(ended).toHaveBeenCalledOnce());
  expect(mocks.stop).toHaveBeenCalledWith('AB12CD34');
  view.unmount();
  expect(trackStop).toHaveBeenCalled();
});
