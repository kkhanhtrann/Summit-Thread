import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionReaderPage } from './SessionReaderPage';
import type { SessionSnapshot } from '../sessions/public';

beforeEach(() => { window.history.replaceState({}, '', '/'); });

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
  expect(player.muted).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Turn sound on' }));
  expect(player.muted).toBe(false);
  rerender(
    <SessionReaderPage
      snapshot={{
        ...snapshot,
        session: { ...snapshot.session, revision: 1 },
        recording: { ...snapshot.recording!, playbackPositionMs: 2000 }
      }}
    />
  );
  expect(player.muted).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Mute sound' }));
  expect(player.muted).toBe(true);
  cleanup();
});

// Synthetic test fixture: labeled captions, not participant content
const caption = (sequence: number, threadId: string, occurrenceId: string) => ({
  id: `AB12CD34-fixture-${sequence}`,
  sequence,
  timestampMs: sequence * 23_000,
  text: `Fixture line ${sequence}: synthetic statement about city heat.`,
  threadId,
  occurrenceId
});
const earlier = caption(0, 'thread-1', 'visit-0');
const first = caption(1, 'thread-2', 'visit-1');
const latest = caption(2, 'thread-2', 'visit-2');
// Describe an earlier topic and a current topic that returned once
const previousTopic = {
  id: 'thread-1',
  title: 'Heat across neighborhoods',
  summary: 'Fixture summary: neighborhood design shapes heat exposure.',
  occurrences: [{ id: 'visit-0', summary: 'Fixture note: where heat lands', startedAtMs: 0, endedAtMs: 22_000, evidenceCaptionIds: [earlier.id], captions: [earlier] }]
};
const currentTopic = {
  id: 'thread-2',
  title: 'Cooling neighborhoods',
  summary: 'Fixture summary: city design can reduce heat exposure.',
  occurrences: [
    { id: 'visit-1', summary: 'Fixture note: heat is felt differently', startedAtMs: 23_000, endedAtMs: 45_000, evidenceCaptionIds: [first.id], captions: [first] },
    { id: 'visit-2', summary: 'Fixture note: the heat island effect', startedAtMs: 46_000, endedAtMs: null, evidenceCaptionIds: [latest.id], captions: [latest] }
  ]
};
// Build a topic snapshot while allowing one-off overrides
function topicSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    ...snapshot,
    session: { ...snapshot.session, revision: 4, releasedCount: 3 },
    captions: [earlier, first, latest],
    threads: [previousTopic, currentTopic],
    activeOccurrenceId: 'visit-2',
    recording: { ...snapshot.recording!, isPlaying: false, playbackPositionMs: 50_000 },
    ...overrides
  };
}

describe('topic reading', () => {
  beforeAll(() => {
    // Provide the modal dialog methods jsdom may not implement
    HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.removeAttribute('open'); };
  });
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lists the newest topic first and marks the current one', () => {
    render(<SessionReaderPage snapshot={topicSnapshot()} />);

    const milestones = within(screen.getByRole('list', { name: 'Topic threads, latest first' })).getAllByRole('button');
    expect(milestones.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Open Cooling neighborhoods at 00:23',
      'Open Heat across neighborhoods at 00:00'
    ]);
    expect(milestones[0]).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText('Came up 2 times')).toBeInTheDocument();
  });

  it('moves a returning topic above a more recently introduced topic without mutating history', () => {
    const middleTopic = { ...previousTopic, id: 'thread-3', title: 'Synthetic middle topic', occurrences: [{ ...previousTopic.occurrences[0]!, id: 'visit-3', startedAtMs: 30_000 }] };
    const original = topicSnapshot({ threads: [previousTopic, currentTopic, middleTopic] });
    render(<SessionReaderPage snapshot={original} />);
    const milestones = within(screen.getByRole('list', { name: 'Topic threads, latest first' })).getAllByRole('button');
    expect(milestones.map(button => button.getAttribute('aria-label'))).toEqual([
      'Open Cooling neighborhoods at 00:23',
      'Open Synthetic middle topic at 00:30',
      'Open Heat across neighborhoods at 00:00'
    ]);
    expect(original.threads.map(thread => thread.id)).toEqual(['thread-1', 'thread-2', 'thread-3']);
  });

  it('labels the playing topic as being discussed now while paused replays keep a current-topic label', () => {
    const paused = topicSnapshot();
    const { rerender } = render(<SessionReaderPage snapshot={paused} />);
    const current = screen.getByRole('button', { name: 'Open Cooling neighborhoods at 00:23' });
    expect(within(current).getByText('Current topic')).toBeInTheDocument();
    rerender(<SessionReaderPage snapshot={{ ...paused, recording: { ...paused.recording!, isPlaying: true } }} />);
    expect(within(current).getByText('Talking about now')).toBeInTheDocument();
  });

  it('announces real topic changes without announcing playback-only updates', () => {
    vi.useFakeTimers();
    const initial = topicSnapshot();
    const { rerender } = render(<SessionReaderPage snapshot={initial} />);
    const notice = document.querySelector('.topic-update-notice');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveAttribute('role', 'status');
    expect(screen.queryByText('Topic updated')).not.toBeInTheDocument();
    rerender(<SessionReaderPage snapshot={{ ...initial, recording: { ...initial.recording!, playbackPositionMs: 51000 } }} />);
    expect(screen.queryByText('Topic updated')).not.toBeInTheDocument();
    const updated = { ...initial, threads: [previousTopic, { ...currentTopic, summary: 'Synthetic updated explanation' }] };
    rerender(<SessionReaderPage snapshot={updated} />);
    expect(screen.getByText('Topic updated')).toBe(notice);
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByText('Topic updated')).not.toBeInTheDocument();
  });

  it('counts down to the next topic boundary from the shared source clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
    const playing = { ...snapshot.recording!, isPlaying: true, playbackPositionMs: 48_000, analysisWindowMinutes: 1 as const, playbackUpdatedAt: new Date().toISOString() };
    render(<SessionReaderPage snapshot={topicSnapshot({ recording: playing })} />);
    expect(screen.getByText('Next topic update in 00:12')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByText('Next topic update in 00:09')).toBeInTheDocument();
  });

  it('hides the countdown while playback is paused', () => {
    render(<SessionReaderPage snapshot={topicSnapshot()} />);
    expect(screen.queryByText(/Next topic update in/)).not.toBeInTheDocument();
  });

  it('opens topic details with each visit and its evidence without seeking shared media', async () => {
    const user = userEvent.setup();
    render(<SessionReaderPage snapshot={topicSnapshot()} />);

    await user.click(screen.getByRole('button', { name: 'Open Cooling neighborhoods at 00:23' }));
    const dialog = screen.getByRole('dialog', { name: 'Cooling neighborhoods' });
    expect(within(dialog).getByText('Topic begins')).toBeInTheDocument();
    expect(within(dialog).getByText('Topic returns')).toBeInTheDocument();
    expect(within(dialog).getByText(latest.text)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /heat is felt differently/ }));
    expect(within(dialog).getByText(first.text)).toBeInTheDocument();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('restores focus to the opening milestone when the dialog closes', async () => {
    const user = userEvent.setup();
    render(<SessionReaderPage snapshot={topicSnapshot()} />);
    const milestone = screen.getByRole('button', { name: 'Open Heat across neighborhoods at 00:00' });

    await user.click(milestone);
    await user.click(screen.getByRole('button', { name: 'Close topic details' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(milestone).toHaveFocus();
  });

  it('opens an evidence passage in the transcript and returns to now', async () => {
    const user = userEvent.setup();
    render(<SessionReaderPage snapshot={topicSnapshot()} />);

    await user.click(screen.getByRole('button', { name: 'Open Heat across neighborhoods at 00:00' }));
    await user.click(screen.getByRole('button', { name: 'View in transcript' }));

    expect(screen.getByRole('tab', { name: /^Transcript/ })).toHaveAttribute('aria-selected', 'true');
    expect(document.getElementById(`caption-${earlier.id}`)).toHaveAttribute('aria-current', 'location');

    await user.click(screen.getByRole('button', { name: /Return to now|Back to current topic/ }));
    expect(document.getElementById(`caption-${earlier.id}`)).not.toHaveAttribute('aria-current');
  });

  it('keeps an inspected earlier topic in place when a topic revision arrives', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SessionReaderPage snapshot={topicSnapshot()} />);
    await user.click(screen.getByRole('button', { name: 'Open Heat across neighborhoods at 00:00' }));
    await user.click(screen.getByRole('button', { name: 'View in transcript' }));
    await user.click(screen.getByRole('tab', { name: 'Topics' }));
    expect(screen.getByText('Viewing an earlier topic')).toBeInTheDocument();

    const newest = { id: 'visit-3', summary: 'Fixture note: tree shade', startedAtMs: 72_000, endedAtMs: null, evidenceCaptionIds: [], captions: [] };
    rerender(<SessionReaderPage snapshot={topicSnapshot({
      session: { ...snapshot.session, revision: 5, releasedCount: 3 },
      threads: [previousTopic, { ...currentTopic, occurrences: [...currentTopic.occurrences, newest] }],
      activeOccurrenceId: 'visit-3'
    })} />);

    expect(screen.getByText('Viewing an earlier topic')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Return to now|Back to current topic/ }));
    expect(screen.getByText('Current topic', { selector: '.reading-position span' })).toBeInTheDocument();
  });

  it('shows an animated waiting state before the first topic appears', () => {
    render(<SessionReaderPage snapshot={snapshot} />);

    expect(screen.getByText('Waiting for the first topic')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Listening now' })).toBeInTheDocument();
    expect(document.querySelector('.topic-empty-visual')).toBeInTheDocument();
  });

  it('tells attendees when some speech remains outside topic threads', async () => {
    const unthreaded = { ...first, threadId: undefined, occurrenceId: undefined };
    render(<SessionReaderPage snapshot={topicSnapshot({ captions: [unthreaded], threads: [], activeOccurrenceId: null, topicAnalysisSkippedCaptionCount: 1 })} />);

    expect(screen.getByRole('note')).toHaveTextContent('1 transcript line isn’t grouped into a topic yet');
    await userEvent.setup().click(screen.getByRole('tab', { name: /^Transcript/ }));
    expect(screen.getByRole('tabpanel', { name: /^Transcript/ })).toHaveTextContent(unthreaded.text);
  });

  it('moves between Topics and Transcript with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<SessionReaderPage snapshot={topicSnapshot()} />);

    screen.getByRole('tab', { name: 'Topics' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /^Transcript/ })).toHaveFocus();
    expect(screen.getByRole('tab', { name: /^Transcript/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Topics' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the transcript at the newest caption while following', async () => {
    // Give jsdom a measurable caption list so the follow scroll is observable
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
    const scrolled = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(scrolled);
    render(<SessionReaderPage snapshot={topicSnapshot()} />);
    expect(scrolled).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole('tab', { name: /^Transcript/ }));

    expect(scrolled).toHaveBeenLastCalledWith(900);
  });

  it('keeps raw transcript keyword search off the reading surface', () => {
    render(<SessionReaderPage snapshot={topicSnapshot()} />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });
});

it('resynchronizes buffered media to elapsed presenter time instead of the stale snapshot', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(20000);
  render(<SessionReaderPage snapshot={{ ...snapshot, recording: { ...snapshot.recording!, playbackPositionMs: 1000, playbackUpdatedAt: new Date(2000).toISOString() } }} />);
  const player = screen.getByLabelText('Shared talk video') as HTMLVideoElement;
  fireEvent.canPlay(player);
  expect(player.currentTime).toBe(19);
  now.mockRestore();
  cleanup();
});

it('shows released stills before any topic has been produced', () => {
  render(<SessionReaderPage snapshot={{ ...snapshot, visualMoments: [{ id: 'moment-0000', timestampMs: 1000, topicTitle: 'Synthetic chart', description: 'Synthetic chart description', imageUrl: '/synthetic-frame.jpg', captionId: null, occurrenceId: null, threadId: null }] }} />);
  expect(screen.getByAltText('Synthetic chart description')).toBeInTheDocument();
  cleanup();
});
