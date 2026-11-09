import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PresenterPage } from './PresenterPage';
import type { SessionSnapshot } from '../sessions/public';

const start = vi.hoisted(() => vi.fn());
vi.mock('../sessions/public', async importOriginal => ({ ...await importOriginal<object>(), startLiveCapture: start, useSessionFeed: () => ({ snapshot: currentSnapshot, connectionState: 'connected', error: null, retry: vi.fn() }) }));
vi.mock('./LiveCameraPublisher', () => ({ LiveCameraPublisher: () => <p>Camera publisher connected</p> }));
const snapshot = { session: { id: 'AB12CD34' }, recording: null, captions: [], threads: [] } as unknown as SessionSnapshot;

let currentSnapshot = snapshot;

describe('camera intake', () => {
  it('requests capture only after the presenter starts it and uses the selected cadence', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [] });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    vi.stubGlobal('MediaRecorder', class {});
    start.mockResolvedValue({ recording: { sourceType: 'camera', status: 'ready', analysisWindowMinutes: 1 } });
    render(<PresenterPage initialSessionId="AB12CD34" />);
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Update topic threads'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go live with camera' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('AB12CD34', 1));
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(await screen.findByText('Camera publisher connected')).toBeInTheDocument();
  });
});

it('retains device ownership when the committed camera event arrives before the start response', async () => {
  currentSnapshot = snapshot;
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
  vi.stubGlobal('MediaRecorder', class {});
  let complete!: (value: unknown) => void;
  start.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const view = render(<PresenterPage initialSessionId="AB12CD34" />);
  fireEvent.click(screen.getByRole('button', { name: 'Go live with camera' }));
  await waitFor(() => expect(complete).toBeDefined());
  const recording = { sourceType: 'camera', status: 'ready', analysisWindowMinutes: 1 } as NonNullable<SessionSnapshot['recording']>;
  currentSnapshot = { ...snapshot, recording };
  view.rerender(<PresenterPage initialSessionId="AB12CD34" />);
  await act(async () => { complete({ recording }); });
  expect(await screen.findByText('Camera publisher connected')).toBeInTheDocument();
});
