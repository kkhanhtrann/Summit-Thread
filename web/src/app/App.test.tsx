import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

vi.mock('../features/sessions/public', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/sessions/public')>()),
  createSession: vi.fn(async () => ({ session: { id: 'AB12CD34' } })),
  useSessionFeed: () => ({
    snapshot: null,
    connectionState: 'loading',
    error: null,
    retry: vi.fn()
  }),
  uploadRecording: vi.fn(),
  updateRecordingPlayback: vi.fn()
}));
describe('room navigation', () => {
  beforeEach(() => {
    history.replaceState({}, '', '/');
  });
  it('normalizes a room code and opens only that attendee room', async () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText('Room code'), {
      target: { value: ' ab12cd34 ' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
    await waitFor(() => expect(location.pathname).toBe('/rooms/AB12CD34'));
  });
  it('creates a room from a title without capture permission', async () => {
    history.replaceState({}, '', '/presenter');
    render(<App />);
    fireEvent.change(screen.getByLabelText('Session name'), {
      target: { value: 'Synthetic fixture talk' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(location.pathname).toBe('/presenter/AB12CD34'));
  });
});
