import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VisualMoment, VisualReviewRecording } from './contracts';
import { VisualMomentGallery } from './VisualMomentGallery';

// Synthetic released still linked to speech and a topic occurrence
const linked: VisualMoment = {
  id: 'moment-0001', timestampMs: 490_000, topicTitle: 'Synthetic architecture slide', description: 'A synthetic diagram of three connected services.',
  imageUrl: '/api/sessions/ROOMAAAA/visual-moments/moment-0001/image', captionId: 'caption-42', occurrenceId: 'occurrence-3', threadId: 'thread-1'
};
// Synthetic released still with no validated speech or topic context
const unlinked: VisualMoment = { ...linked, id: 'moment-0002', timestampMs: 700_000, topicTitle: 'Synthetic chart', captionId: null, occurrenceId: null, threadId: null };

const recording: VisualReviewRecording = {
  sourceType: 'upload', status: 'ready', preparationStage: null, mediaKind: 'video', mimeType: 'video/mp4', durationMs: 900_000,
  playbackPositionMs: 720_000, isPlaying: true, analysisWindowMinutes: 5, visualReviewSkippedWindowCount: 1, analysisThroughMs: 600_000,
  analysisState: 'ready', mediaUrl: '/media', playbackUpdatedAt: '2026-01-01T00:00:00.000Z'
};

// Render the gallery with spy callbacks standing in for the reader host
function renderGallery(moments: VisualMoment[] = [linked, unlinked], review: VisualReviewRecording | null = recording) {
  const onOpenSpokenMoment = vi.fn();
  const onOpenTopic = vi.fn();
  render(<VisualMomentGallery moments={moments} recording={review} onOpenSpokenMoment={onOpenSpokenMoment} onOpenTopic={onOpenTopic} />);
  return { onOpenSpokenMoment, onOpenTopic };
}

// Unmount between tests because the shared setup does not enable automatic cleanup
afterEach(cleanup);

describe('VisualMomentGallery', () => {
  it('renders each still with its source timestamp and accessible description', () => {
    renderGallery();
    expect(screen.getByRole('heading', { name: 'On screen' })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'A synthetic diagram of three connected services.' })).toHaveLength(2);
    expect(screen.getByText('8:10')).toHaveAttribute('datetime', 'PT490S');
    expect(screen.getByRole('button', { name: 'View still at 8:10: Synthetic architecture slide' })).toBeInTheDocument();
  });

  it('links only to validated speech and topic context through host callbacks', async () => {
    const { onOpenSpokenMoment, onOpenTopic } = renderGallery();
    await userEvent.click(screen.getAllByRole('button', { name: 'Read what was said' })[0]!);
    await userEvent.click(screen.getAllByRole('button', { name: 'Open related topic' })[0]!);
    expect(onOpenSpokenMoment).toHaveBeenCalledWith('caption-42');
    expect(onOpenTopic).toHaveBeenCalledWith('thread-1', 'occurrence-3');
    expect(screen.getAllByRole('button', { name: 'Read what was said' })).toHaveLength(1);
    expect(screen.getByText('Spoken context isn’t available for this still yet')).toBeInTheDocument();
  });

  it('opens a still in a dialog, closes on Escape, and returns focus to its control', async () => {
    renderGallery();
    const trigger = screen.getByRole('button', { name: 'View still at 8:10: Synthetic architecture slide' });
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Synthetic architecture slide' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('shows an image-unavailable state while keeping the description readable', () => {
    renderGallery([linked]);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByText('Image unavailable. A synthetic diagram of three connected services.')).toBeInTheDocument();
  });

  it('shows the pending review state before any still is released', () => {
    renderGallery([], { ...recording, visualReviewSkippedWindowCount: 0, analysisState: 'analyzing' });
    expect(screen.getByRole('status')).toHaveTextContent('Looking for key slides');
  });

  it('reports skipped intervals honestly', () => {
    renderGallery([linked]);
    expect(screen.getByText('1 interval of video couldn’t be checked, so some stills may be missing')).toBeInTheDocument();
  });

  it('explains audio-only recordings', () => {
    renderGallery([], { ...recording, mediaKind: 'audio' });
    expect(screen.getByRole('status')).toHaveTextContent('Audio only');
  });
});
