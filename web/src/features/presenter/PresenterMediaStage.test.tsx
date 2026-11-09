import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PresenterMediaStage } from './PresenterMediaStage';
import type { SessionRecording } from '../sessions/public';
const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  update: vi.fn(),
  stop: vi.fn(),
  position: vi.fn()
}));
vi.mock('../transcription/public', () => ({
  connectLiveTranscription: mocks.connect
}));
vi.mock('../sessions/public', () => ({
  updateRecordingPlayback: mocks.update
}));
class FakeStream {
  constructor(public tracks: MediaStreamTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}
const recording: SessionRecording = {
  sourceType: 'upload',
  status: 'ready',
  preparationStage: null,
  mediaKind: 'video',
  mimeType: 'video/mp4',
  durationMs: 60000,
  playbackPositionMs: 0,
  playbackUpdatedAt: '2026-01-01T00:00:00Z',
  isPlaying: false,
  analysisWindowMinutes: 5,
  visualReviewSkippedWindowCount: null,
  analysisThroughMs: 0,
  analysisState: 'waiting',
  mediaUrl: '/fixture'
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('MediaStream', FakeStream);
  mocks.stop.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue({});
  mocks.connect.mockResolvedValue({
    stop: mocks.stop,
    setPosition: mocks.position
  });
});
it('captures file audio and flushes transcription before persisting pause', async () => {
  render(<PresenterMediaStage sessionId="AB12CD34" recording={recording} />);
  const player = screen.getByLabelText('Talk video player') as HTMLVideoElement;
  Object.defineProperty(player, 'captureStream', {
    value: () =>
      new FakeStream([{ readyState: 'live', stop: vi.fn() } as never])
  });
  player.currentTime = 4.2;
  fireEvent.playing(player);
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
  expect(mocks.connect).toHaveBeenCalledWith(
    'AB12CD34',
    expect.any(FakeStream),
    expect.any(Function),
    expect.objectContaining({ initialPositionMs: 4200 })
  );
  fireEvent.pause(player);
  await waitFor(() =>
    expect(mocks.update).toHaveBeenLastCalledWith('AB12CD34', 4200, false)
  );
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.update.mock.invocationCallOrder.at(-1)!
  );
});
it('stops the old capture before replacing it after a backward seek', async () => {
  render(<PresenterMediaStage sessionId="AB12CD34" recording={recording} />);
  const player = screen.getByLabelText('Talk video player') as HTMLVideoElement;
  Object.defineProperty(player, 'paused', { value: false });
  Object.defineProperty(player, 'captureStream', {
    value: () =>
      new FakeStream([{ readyState: 'live', stop: vi.fn() } as never])
  });
  player.currentTime = 20;
  fireEvent.playing(player);
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledOnce());
  fireEvent.seeking(player);
  player.currentTime = 2;
  fireEvent.seeked(player);
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(2));
  expect(mocks.stop).toHaveBeenCalled();
  expect(mocks.connect.mock.calls[1]?.[3]).toMatchObject({
    initialPositionMs: 2000
  });
});
it('waits for a late capture setup and flush before persisting pause', async () => {
  let resolve!: (capture: unknown) => void;
  mocks.connect.mockImplementationOnce(
    () =>
      new Promise((value) => {
        resolve = value;
      })
  );
  render(<PresenterMediaStage sessionId="AB12CD34" recording={recording} />);
  const player = screen.getByLabelText('Talk video player') as HTMLVideoElement;
  Object.defineProperty(player, 'captureStream', {
    value: () =>
      new FakeStream([{ readyState: 'live', stop: vi.fn() } as never])
  });
  fireEvent.playing(player);
  await waitFor(() => expect(mocks.connect).toHaveBeenCalled());
  fireEvent.pause(player);
  expect(mocks.update).not.toHaveBeenCalledWith('AB12CD34', 0, false);
  resolve({ stop: mocks.stop, setPosition: mocks.position });
  await waitFor(() =>
    expect(mocks.update).toHaveBeenLastCalledWith('AB12CD34', 0, false)
  );
  expect(mocks.stop).toHaveBeenCalledOnce();
});
it('keeps a failed transcript disconnected until the presenter retries playback', async () => {
  mocks.connect.mockRejectedValueOnce(
    new Error('Synthetic unavailable provider')
  );
  render(<PresenterMediaStage sessionId="AB12CD34" recording={recording} />);
  const player = screen.getByLabelText('Talk video player') as HTMLVideoElement;
  Object.defineProperty(player, 'captureStream', {
    value: () =>
      new FakeStream([{ readyState: 'live', stop: vi.fn() } as never])
  });
  fireEvent.playing(player);
  await screen.findByText(/The transcript could not connect/);
  fireEvent.playing(player);
  await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
  expect(mocks.connect).toHaveBeenCalledOnce();
  fireEvent.pause(player);
  fireEvent.playing(player);
  await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(2));
});
it('keeps the changing source clock outside the connection announcement', () => {
  render(<PresenterMediaStage sessionId="AB12CD34" recording={recording} />);
  expect(screen.getByRole('status').textContent).not.toContain('Source');
  expect(screen.getByText(/Source 0:00/)).toBeInTheDocument();
});
