import { VisualMomentGallery } from '../visual-moments/public';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  formatThreadUpdateCountdown,
  useSourceClock,
  type SessionRecording,
  type SessionSnapshot
} from '../sessions/public';
import { PrivateChatPanel } from '../private-chat/public';
import { TopicThreadDialog } from './TopicThreadDialog';

type ReaderTab = 'topics' | 'transcript' | 'ask';

// Order the reader tabs for arrow-key navigation
const READER_TABS: ReaderTab[] = ['topics', 'transcript', 'ask'];

// Format talk offsets as readable source timestamps
function formatTimestamp(timestampMs: number): string {
  const totalSeconds = Math.floor(timestampMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = String(Math.floor(totalSeconds / 60) % 60).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

// Keep attendee media aligned with persisted presenter controls and recover autoplay
function RecordingPlayer({ recording }: { recording: SessionRecording }) {
  const player = useRef<HTMLMediaElement | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');
  const current = useRef(recording);
  current.current = recording;
  const synchronize = () => {
    const media = player.current;
    const state = current.current;
    if (!media || media.readyState < 1) return;
    const elapsed = state.isPlaying
      ? Math.max(0, Date.now() - Date.parse(state.playbackUpdatedAt))
      : 0;
    const seconds =
      Math.min(state.durationMs ?? 0, state.playbackPositionMs + elapsed) /
      1000;
    if (Math.abs(media.currentTime - seconds) > (state.isPlaying ? 1.5 : 0.15))
      media.currentTime = seconds;
    if (!state.isPlaying || seconds >= (state.durationMs ?? 0) / 1000) {
      media.pause();
      return;
    }
    if (media.paused && !blocked)
      void media.play().then(
        () => setBlocked(false),
        () => setBlocked(true)
      );
  };
  useEffect(() => {
    synchronize();
    const timer = setInterval(synchronize, 1000);
    return () => clearInterval(timer);
  }, [recording, blocked]);
  const props = {
    src: recording.mediaUrl,
    muted,
    preload: 'metadata',
    onLoadedMetadata: synchronize,
    onCanPlay: synchronize,
    onError: () =>
      setError(
        'The recording could not load. Retry the media connection or use a browser that supports this format.'
      )
  };
  return (
    <section aria-labelledby="playback-title">
      <h2 id="playback-title">Recording playback</h2>
      <p className="muted" role="status">
        {recording.isPlaying
          ? 'Following presenter playback'
          : 'The presenter has paused playback'}
      </p>
      {recording.mediaKind === 'video' ? (
        <video
          ref={player as React.RefObject<HTMLVideoElement>}
          playsInline
          aria-label="Shared talk video"
          {...props}
        />
      ) : (
        <audio
          ref={player as React.RefObject<HTMLAudioElement>}
          aria-label="Shared talk audio"
          {...props}
        />
      )}
      <button
        className="secondary"
        onClick={() => {
          synchronize();
          void player.current?.play().then(
            () => setBlocked(false),
            () => setBlocked(true)
          );
        }}
        disabled={!recording.isPlaying}
      >
        {blocked ? 'Enable playback' : 'Play sound'}
      </button>
      <button className="secondary" onClick={() => setMuted((value) => !value)}>
        {muted ? 'Unmute sound' : 'Mute sound'}
      </button>
      {blocked && (
        <p role="status">
          Your browser needs a click to play the recording with sound.
        </p>
      )}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button
            className="secondary"
            onClick={() => {
              setError('');
              player.current?.load();
            }}
          >
            Retry media
          </button>
        </>
      )}
    </section>
  );
}

// Follow shared media beside topic history and released words without moving the reader
export function SessionReaderPage({ snapshot }: { snapshot: SessionSnapshot }) {
  const reader = useRef<HTMLOListElement | null>(null);
  const [following, setFollowing] = useState(true);
  const [activeTab, setActiveTab] = useState<ReaderTab>('topics');
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState<string | null>(null);
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [openOccurrenceId, setOpenOccurrenceId] = useState<string | null>(null);
  const recording = snapshot.recording;
  const sourcePositionMs = useSourceClock(recording);
  const occurrenceEntries = snapshot.threads.flatMap((thread) =>
    thread.occurrences.map((occurrence) => ({ thread, occurrence }))
  );
  // Fall back to the newest visit while a snapshot has not identified the active one
  const activeEntry =
    occurrenceEntries.find(({ occurrence }) => occurrence.id === snapshot.activeOccurrenceId) ??
    occurrenceEntries.at(-1) ??
    null;
  // Keep inspected moments by stable ID so topic revisions never move the reader
  const selectedEntry = selectedOccurrenceId
    ? occurrenceEntries.find(({ occurrence }) => occurrence.id === selectedOccurrenceId) ?? null
    : null;
  const isReadingEarlier = Boolean(
    activeEntry && selectedEntry && selectedEntry.occurrence.id !== activeEntry.occurrence.id
  );
  const isReadingEarlierTopic = Boolean(
    isReadingEarlier && selectedEntry && selectedEntry.thread.id !== activeEntry?.thread.id
  );
  // Show threads in talk order so attendees see the conversation build over time
  const topicThreads = snapshot.threads
    .filter((thread) => thread.occurrences.length > 0)
    .sort((left, right) => (left.occurrences[0]?.startedAtMs ?? 0) - (right.occurrences[0]?.startedAtMs ?? 0));
  const openThread = openThreadId ? snapshot.threads.find((thread) => thread.id === openThreadId) ?? null : null;
  const skippedCount = snapshot.topicAnalysisSkippedCaptionCount;
  const hasStarted = Boolean(recording && (recording.playbackPositionMs > 0 || snapshot.session.isLive));

  // Follow new captions only while the visible reader stays at the newest line
  // Re-run on tab changes because a hidden panel has no layout to scroll
  useEffect(() => {
    if (activeTab === 'transcript' && following && !selectedCaptionId && reader.current)
      reader.current.scrollTop = reader.current.scrollHeight;
  }, [activeTab, snapshot.captions, following, selectedCaptionId]);

  // Reveal only an explicitly opened passage so arriving captions never move the reader
  useEffect(() => {
    if (activeTab !== 'transcript' || !selectedCaptionId) return;
    const caption = document.getElementById(`caption-${selectedCaptionId}`);
    caption?.focus({ preventScroll: true });
    caption?.scrollIntoView?.({ block: 'center' });
  }, [activeTab, selectedCaptionId]);

  // Clear inspected topics and passages, then follow the newest caption again
  const returnToNow = () => {
    setSelectedOccurrenceId(null);
    setSelectedCaptionId(null);
    setFollowing(true);
    if (reader.current) reader.current.scrollTop = reader.current.scrollHeight;
  };

  // Let keyboard users move between topic and transcript tabs
  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = READER_TABS.indexOf(activeTab);
    const next =
      event.key === 'Home' ? 0
        : event.key === 'End' ? READER_TABS.length - 1
          : event.key === 'ArrowLeft' ? (index + READER_TABS.length - 1) % READER_TABS.length
            : (index + 1) % READER_TABS.length;
    const tab = READER_TABS[next] ?? 'topics';
    setActiveTab(tab);
    document.getElementById(`${tab}-tab`)?.focus();
  }

  // Open one released evidence passage in the transcript without seeking shared media
  function openTranscriptCaption(_threadId: string, occurrenceId: string, captionId: string): void {
    setSelectedOccurrenceId(occurrenceId);
    setSelectedCaptionId(captionId);
    setFollowing(false);
    setActiveTab('transcript');
  }

  return (
    <div className="reader-shell">
      <p className="muted">Room {snapshot.session.id} · Attendee view</p>
      <div className="room-columns reader-columns">
        <div>
          {recording?.status === 'ready' ? (
            <RecordingPlayer recording={recording} />
          ) : (
            <section>
              <h2>Recording playback</h2>
              <p className="empty">
                {recording?.status === 'preparing'
                  ? 'The presenter is uploading and validating the recording.'
                  : 'Waiting for the presenter to prepare a recording.'}
              </p>
            </section>
          )}
          <VisualMomentGallery moments={snapshot.visualMoments} recording={recording} onOpenSpokenMoment={id => { setSelectedCaptionId(id); setFollowing(false); setActiveTab('transcript'); }} onOpenTopic={(threadId, occurrenceId) => { setOpenThreadId(threadId); setOpenOccurrenceId(occurrenceId); }} />
          {activeEntry && activeTab !== 'topics' && (
            <section className="current-topic" aria-labelledby="current-topic-title">
              <p className="topic-eyebrow">Current topic</p>
              <h2 id="current-topic-title">{activeEntry.thread.title}</h2>
              <p>{activeEntry.thread.summary}</p>
              <button className="secondary" onClick={() => setOpenThreadId(activeEntry.thread.id)}>
                View topic details
              </button>
            </section>
          )}
        </div>

        <section aria-label="Talk reading tools">
          <div className="reader-tabs" role="tablist" aria-label="Talk content" onKeyDown={handleTabKeyDown}>
            <button
              id="topics-tab"
              role="tab"
              aria-selected={activeTab === 'topics'}
              aria-controls="topics-panel"
              tabIndex={activeTab === 'topics' ? 0 : -1}
              onClick={() => setActiveTab('topics')}
            >Topics</button>
            <button
              id="transcript-tab"
              role="tab"
              aria-selected={activeTab === 'transcript'}
              aria-controls="transcript-panel"
              tabIndex={activeTab === 'transcript' ? 0 : -1}
              onClick={() => setActiveTab('transcript')}
            >Transcript</button>
            <button
              id="ask-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === 'ask'}
              aria-controls="ask-panel"
              tabIndex={activeTab === 'ask' ? 0 : -1}
              onClick={() => setActiveTab('ask')}
            >Ask</button>
          </div>

          <div id="topics-panel" role="tabpanel" aria-labelledby="topics-tab" hidden={activeTab !== 'topics'}>
            <div className="reading-position">
              <span>
                {topicThreads.length === 0 ? 'Waiting for the first topic'
                  : isReadingEarlier ? (isReadingEarlierTopic ? 'Viewing an earlier topic' : 'Viewing an earlier moment')
                    : recording?.isPlaying ? 'Following the live topic' : 'Current topic'}
              </span>
              {recording?.isPlaying && (
                <span className="topic-countdown" aria-live="off">
                  Next topic update in {formatThreadUpdateCountdown(sourcePositionMs, recording.analysisWindowMinutes)}
                </span>
              )}
              {isReadingEarlier && <button className="secondary" onClick={returnToNow}>Return to now</button>}
            </div>

            {skippedCount > 0 && (
              <p className="topic-note" role="note">
                {skippedCount} {skippedCount === 1 ? 'transcript line isn’t' : 'transcript lines aren’t'} grouped into a topic yet. You can still read {skippedCount === 1 ? 'it' : 'them'} in the transcript.
              </p>
            )}

            {topicThreads.length > 0 ? (
              <ol className="topic-milestones" aria-label="Topic threads in chronological order">
                {topicThreads.map((thread) => {
                  const first = thread.occurrences[0]!;
                  const latest = thread.occurrences.at(-1)!;
                  const isCurrent = thread.id === activeEntry?.thread.id;
                  const sourceCount = new Set(thread.occurrences.flatMap((occurrence) => occurrence.evidenceCaptionIds)).size;
                  return (
                    <li key={thread.id} className={isCurrent ? 'is-current' : undefined}>
                      <button
                        className="topic-milestone"
                        aria-current={isCurrent ? 'true' : undefined}
                        aria-haspopup="dialog"
                        aria-label={`Open ${thread.title} at ${formatTimestamp(first.startedAtMs)}`}
                        onClick={() => {
                          setOpenThreadId(thread.id);
                          setOpenOccurrenceId(latest.id);
                        }}
                      >
                        <span className="topic-milestone-meta">
                          <time>{formatTimestamp(first.startedAtMs)}</time>
                          {isCurrent && <span>Current topic</span>}
                        </span>
                        <span className="topic-milestone-title">{thread.title}</span>
                        <span className="topic-milestone-summary">{thread.summary}</span>
                        <span className="topic-milestone-meta">
                          <span>Came up {thread.occurrences.length} {thread.occurrences.length === 1 ? 'time' : 'times'}</span>
                          {thread.occurrences.length > 1 && <span>Last came up {formatTimestamp(latest.startedAtMs)}</span>}
                          <span>{sourceCount} transcript {sourceCount === 1 ? 'passage' : 'passages'}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className={`topic-waiting${recording?.isPlaying ? ' is-listening' : ''}`}>
                <span className="topic-waiting-pulse" aria-hidden="true" />
                <div>
                  <h2>{recording?.isPlaying || snapshot.session.isLive ? 'Listening now' : hasStarted ? 'Talk paused' : 'Waiting for the talk to start'}</h2>
                  <p>Topics will take shape as the talk unfolds.</p>
                  <button className="secondary" onClick={() => setActiveTab('transcript')}>Read transcript</button>
                </div>
              </div>
            )}
          </div>

          <div id="transcript-panel" role="tabpanel" aria-labelledby="transcript-tab" hidden={activeTab !== 'transcript'}>
            <div className="caption-heading">
              <h2 id="words-title">The speaker’s words</h2>
              {(!following || selectedCaptionId) && (
                <button className="secondary" onClick={returnToNow}>Return to now</button>
              )}
            </div>
            {snapshot.captions.length ? (
              <ol
                ref={reader}
                className="captions reading-pane"
                tabIndex={0}
                aria-label="Released captions"
                onScroll={() => {
                  const element = reader.current;
                  if (element)
                    setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 48);
                }}
              >
                {snapshot.captions.map((caption) => (
                  <li
                    key={caption.id}
                    id={`caption-${caption.id}`}
                    tabIndex={caption.id === selectedCaptionId ? -1 : undefined}
                    aria-current={caption.id === selectedCaptionId ? 'location' : undefined}
                  >
                    <time>{formatTimestamp(caption.timestampMs)}</time>
                    <p>{caption.text}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty">
                No finalized speech yet. Words appear as the recording plays with
                transcription connected.
              </p>
            )}
            <p className="muted">Only saved, finalized speech appears here.</p>
          </div>
      <section id="ask-panel" className="session-tab-panel ask-panel reader-private-ask" role="tabpanel" aria-labelledby="ask-tab" hidden={activeTab !== 'ask'}>
        <header className="ask-panel-heading"><h2>Ask about the talk</h2></header>
        <PrivateChatPanel sessionId={snapshot.session.id} snapshot={snapshot} connectionState="connected" onOpenCitation={id => {
          // Reveal Ask evidence through the reader's local navigation without seeking media
          setSelectedOccurrenceId(snapshot.captions.find(caption => caption.id === id)?.occurrenceId ?? null);
          setSelectedCaptionId(id);
          setFollowing(false);
          setActiveTab('transcript');
        }} />
      </section>
        </section>
      </div>
      <TopicThreadDialog
        thread={openThread}
        initialOccurrenceId={openOccurrenceId}
        captions={snapshot.captions}
        sessionTitle={snapshot.session.title}
        isCurrent={openThread?.id === activeEntry?.thread.id}
        onClose={() => {
          setOpenThreadId(null);
          setOpenOccurrenceId(null);
        }}
        onOpenCaption={openTranscriptCaption}
      />
    </div>
  );
}
