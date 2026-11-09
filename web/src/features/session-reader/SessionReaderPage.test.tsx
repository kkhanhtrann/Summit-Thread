import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SessionReaderPage } from './SessionReaderPage';
import type { SessionSnapshot } from '../sessions/public';
const snapshot: SessionSnapshot = {
  session: {
    id: 'AB12CD34',
    title: 'Synthetic accessibility fixture',
    eventName: 'Conference session',
    speakerName: 'Presenter',
    contentLabel: 'Recording playback',
    revision: 0,
    releasedCount: 0,
    isLive: true
  },
  captions: [],
  threads: [],
  activeOccurrenceId: null,
  suggestedQuestions: [],
  topicAnalysisSkippedCaptionCount: 0,
  recording: {
    sourceType: 'upload',
    status: 'ready',
    preparationStage: null,
    mediaKind: 'video',
    mimeType: 'video/mp4',
    durationMs: 60000,
    playbackPositionMs: 0,
    playbackUpdatedAt: new Date().toISOString(),
    isPlaying: true,
    analysisWindowMinutes: 5,
    visualReviewSkippedWindowCount: null,
    analysisThroughMs: 0,
    analysisState: 'waiting',
    mediaUrl: '/synthetic-media'
  },
  visualMoments: []
};
it('lets an attendee mute locally and retains mute on room updates', () => {
  const { rerender } = render(<SessionReaderPage snapshot={snapshot} />);
  const player = screen.getByLabelText('Shared talk video') as HTMLVideoElement;
  expect(player.muted).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Mute sound' }));
  expect(player.muted).toBe(true);
  rerender(
    <SessionReaderPage
      snapshot={{
        ...snapshot,
        session: { ...snapshot.session, revision: 1 },
        recording: { ...snapshot.recording!, playbackPositionMs: 2000 }
      }}
    />
  );
  expect(player.muted).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Unmute sound' }));
  expect(player.muted).toBe(false);
});
