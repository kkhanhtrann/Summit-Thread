import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PrivateChatPage } from './PrivateChatPage';
const api = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock('./PrivateChatPanel', () => ({ formatTimestamp: () => '00:23', PrivateChatPanel: ({ onOpenCitation }: { onOpenCitation: (id: string) => void }) => <><button onClick={() => onOpenCitation('released')}>Open citation</button><textarea aria-label="Your question" /></> }));
vi.mock('./api/privateChatApi', () => ({
  getPrivateAskContext: api.context.mockResolvedValue({ session: { id: 'A5000001', title: 'Synthetic room' }, captions: [], suggestedQuestions: [] })
}));
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('keeps the private Ask introduction, skip link and return-to-talk navigation', async () => {
  render(<PrivateChatPage sessionId="A5000001" />);
  expect(await screen.findByText('Synthetic room')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Ask about the talk' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Skip to private chat' })).toHaveAttribute('href', '#private-chat');
  expect(screen.getByRole('link', { name: 'Return to the talk' })).toHaveAttribute('href', '/rooms/A5000001');
});

it('keeps follow-up question focus when released context refreshes', async () => {
  vi.useFakeTimers();
  api.context.mockImplementation(async () => ({ session: { id: 'A5000001', title: 'Synthetic room' }, captions: [{ id: 'released', timestampMs: 23000, text: 'Synthetic passage' }], suggestedQuestions: [] }));
  render(<PrivateChatPage sessionId="A5000001" />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Open citation' }));
  expect(screen.getByRole('region', { name: 'Released transcript passage' })).toHaveFocus();
  const question = screen.getByRole('textbox', { name: 'Your question' });
  question.focus();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(api.context.mock.calls.length).toBeGreaterThan(1);
  expect(question).toHaveFocus();
});
