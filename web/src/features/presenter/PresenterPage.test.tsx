import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PresenterPage } from './PresenterPage';
import type { SessionSnapshot } from '../sessions/public';

const start = vi.hoisted(() => vi.fn());
vi.mock('../sessions/public', async importOriginal => ({ ...await importOriginal<object>(), startLiveCapture: start }));
vi.mock('./LiveCameraPublisher', () => ({ LiveCameraPublisher: () => <p>Camera publisher connected</p> }));
const snapshot = { session: { id: 'AB12CD34' }, recording: null, captions: [] } as unknown as SessionSnapshot;

describe('camera intake', () => {
  it('requests capture only after the presenter starts it and uses the selected cadence', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [] });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    vi.stubGlobal('MediaRecorder', class {});
    start.mockResolvedValue({ recording: { sourceType: 'camera', status: 'ready', analysisWindowMinutes: 1 } });
    render(<PresenterPage snapshot={snapshot} />);
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Thread update interval'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go live with camera' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('AB12CD34', 1));
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(await screen.findByText('Camera publisher connected')).toBeInTheDocument();
  });
});
