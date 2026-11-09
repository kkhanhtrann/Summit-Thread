import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionReaderPage } from './SessionReaderPage';
import type { SessionSnapshot } from '../sessions/public';
vi.mock('../private-chat/public', () => ({
  PrivateChatPanel: ({ onOpenCitation }: { onOpenCitation: (id: string) => void }) => <button onClick={() => onOpenCitation('released')}>Open Ask citation</button>
}));
afterEach(cleanup);
it('reveals an Ask citation in Transcript without seeking the shared recording', () => {
  const snapshot: SessionSnapshot = {
    session: { id: 'AB12CD34', title: 'Synthetic Ask integration', eventName: 'Test', speakerName: 'Test', contentLabel: 'Synthetic', revision: 1, releasedCount: 1, isLive: false },
    captions: [{ id: 'released', sequence: 0, timestampMs: 23000, text: 'Synthetic released passage' }],
    threads: [], activeOccurrenceId: null, suggestedQuestions: [], topicAnalysisSkippedCaptionCount: 0, visualMoments: [],
    recording: { sourceType: 'upload', status: 'ready', preparationStage: null, mediaKind: 'video', mimeType: 'video/mp4', durationMs: 60000, playbackPositionMs: 40000, playbackUpdatedAt: new Date().toISOString(), isPlaying: false, analysisWindowMinutes: 5, visualReviewSkippedWindowCount: null, analysisThroughMs: 0, analysisState: 'waiting', mediaUrl: '/synthetic-media' }
  };
  render(<SessionReaderPage snapshot={snapshot} />);
  const video = screen.getByLabelText('Shared talk video') as HTMLVideoElement;
  video.currentTime = 40;
  expect(screen.queryByRole('button', { name: 'Open Ask citation' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Ask' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open Ask citation' }));
  expect(screen.getByRole('tab', { name: /^Transcript/ })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('Synthetic released passage').closest('li')).toHaveFocus();
  expect(video.currentTime).toBe(40);
});
