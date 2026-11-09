import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PrivateChatPage } from './PrivateChatPage';
vi.mock('./api/privateChatApi', () => ({
  getPrivateAskContext: vi.fn().mockResolvedValue({ session: { id: 'A5000001', title: 'Synthetic room' }, captions: [], suggestedQuestions: [] })
}));
afterEach(cleanup);
it('keeps the private Ask introduction, skip link and return-to-talk navigation', async () => {
  render(<PrivateChatPage sessionId="A5000001" />);
  expect(await screen.findByText('Synthetic room')).toBeInTheDocument();
  expect(screen.getByText('Ask privately about what’s been said so far.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Skip to private chat' })).toHaveAttribute('href', '#private-chat');
  expect(screen.getByRole('link', { name: 'Return to the talk' })).toHaveAttribute('href', '/rooms/A5000001');
});
