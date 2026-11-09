import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateChatPanel } from './PrivateChatPanel';
import type { PrivateAskContext } from './api/privateChatApi';
const api = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock('./api/privateChatApi', () => ({ askPrivateQuestion: api.ask }));
const snapshot: PrivateAskContext = {
 session: { id: 'A5000001', title: 'Synthetic test room' },
 captions: [{ id: 'released', sequence: 0, timestampMs: 23000, text: 'SYNTHETIC shade cools paths.' }],
 suggestedQuestions: ['How does shade help?']
};
const response = { answer: 'Shade cools the route.', citations: [{ kind: 'caption' as const, captionId: 'released', timestampMs: 23000, text: snapshot.captions[0]!.text }] };
describe('private conversation', () => {
 afterEach(cleanup);
 beforeEach(() => { api.ask.mockReset(); });
 it('labels presenter material citations separately from spoken transcript passages', async () => {
  // Synthetic test fixture: a labeled presenter passage, not real material
  const material = { kind: 'material' as const, passageId: 'm-1:3', materialTitle: 'Fixture slides', page: 4, text: 'SYNTHETIC slide: reflective roofs.' };
  api.ask.mockResolvedValue({ answer: 'The slides note reflective roofs.', citations: [...response.citations, material] });
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  const user = userEvent.setup();
  render(<PrivateChatPanel sessionId="A5000001" snapshot={snapshot} connectionState="connected" />);
  await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'What about roofs?');
  await user.click(screen.getByRole('button', { name: 'Ask' }));

  expect(await screen.findByRole('button', { name: 'View transcript at 00:23' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'View presenter material: Fixture slides, page 4' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('From the presenter’s materials, not spoken in the talk');
  expect(dialog).toHaveTextContent(material.text);
  expect(screen.queryByRole('link', { name: 'View in transcript' })).not.toBeInTheDocument();
 });
 it('fills a suggestion and waits for Ask before sending it', async () => {
  api.ask.mockResolvedValue(response);
  const user = userEvent.setup();
  render(<PrivateChatPanel sessionId="A5000001" snapshot={snapshot} connectionState="connected" />);
  await user.click(screen.getByRole('button', { name: 'How does shade help?' }));
  expect(api.ask).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Your question' })).toHaveValue('How does shade help?');
  await user.click(screen.getByRole('button', { name: 'Ask' }));
  expect(await screen.findByText(response.answer)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'View transcript at 00:23' })).toBeInTheDocument();
 });
 it('clears caption context when selecting a different suggested question', async () => {
  api.ask.mockResolvedValue(response);
  const user = userEvent.setup();
  render(<PrivateChatPanel sessionId="A5000001" snapshot={snapshot} connectionState="connected" initialQuestion={{ id: 1, question: 'Explain this passage', contextCaptionId: 'released' }} />);
  await user.click(screen.getByRole('button', { name: 'How does shade help?' }));
  await user.click(screen.getByRole('button', { name: 'Ask' }));
  expect(api.ask).toHaveBeenCalledWith('A5000001', expect.objectContaining({ contextCaptionId: undefined }), expect.any(AbortSignal));
 });
 it('retries a failed question without duplicating its user turn', async () => {
  api.ask.mockRejectedValueOnce(new Error('SYNTHETIC_PROVIDER_ERROR')).mockResolvedValueOnce(response);
  const user = userEvent.setup();
  render(<PrivateChatPanel sessionId="A5000001" snapshot={snapshot} connectionState="connected" />);
  await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'Why shade?');
  await user.click(screen.getByRole('button', { name: 'Ask' }));
  await user.click(await screen.findByRole('button', { name: 'Try again' }));
  expect(await screen.findByText(response.answer)).toBeInTheDocument();
  expect(screen.getAllByText('Why shade?')).toHaveLength(1);
  expect(screen.queryByText('SYNTHETIC_PROVIDER_ERROR')).not.toBeInTheDocument();
 });
 it('aborts pending work and clears conversation state on a room change', async () => {
  api.ask.mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  const view = render(<PrivateChatPanel sessionId="A5000001" snapshot={snapshot} connectionState="connected" />);
  await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'Private old room question');
  await user.click(screen.getByRole('button', { name: 'Ask' }));
  const signal = api.ask.mock.calls[0]![2] as AbortSignal;
  view.rerender(<PrivateChatPanel sessionId="B5000001" snapshot={{ ...snapshot, session: { ...snapshot.session, id: 'B5000001' } }} connectionState="connected" />);
  await waitFor(() => expect(signal.aborted).toBe(true));
  expect(screen.queryByText('Private old room question')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Your question' })).toHaveValue('');
 });
 it('keeps Ask unavailable before any released speech exists', () => {
  render(<PrivateChatPanel sessionId="A5000001" snapshot={{ ...snapshot, captions: [] }} connectionState="connected" />);
  expect(screen.getByRole('textbox', { name: 'Your question' })).toBeDisabled();
 });
});
