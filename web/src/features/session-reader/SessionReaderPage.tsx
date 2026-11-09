import { VisualMomentGallery } from '../visual-moments/public';
import { LiveCameraViewer } from './LiveCameraViewer';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { LoadingIndicator } from '../../shared/ui/LoadingIndicator';
import { PrivateChatPanel } from '../private-chat/public';
import { formatThreadUpdateCountdown, useSourceClock, useSessionFeed, type SessionSnapshot } from '../sessions/public';
import '../../shared/styles/conference-experience.css';
import { TopicThreadDialog } from './TopicThreadDialog';
import { visualMomentsForOccurrence } from './visualMoments';

// Identify the room opened from an attendee invite
interface SessionReaderPageProps {
  snapshot: SessionSnapshot;
  connectionState?: SessionConnectionState;
  error?: string | null;
  retry?: () => void;
}

type SessionRecording = NonNullable<ReturnType<typeof useSessionFeed>['snapshot']>['recording'];
type SessionConnectionState = ReturnType<typeof useSessionFeed>['connectionState'];
type SessionReaderTab = 'topics' | 'transcript' | 'ask';

// Describe attendee-visible session state without treating a normal pause as an ending
function describeSessionState(
  recording: SessionRecording | undefined,
  isLive: boolean,
  hasReleasedCaptions: boolean,
  connectionState: SessionConnectionState
): string {
  if (connectionState === 'reconnecting') return 'Reconnecting…';
  if (connectionState === 'unavailable') return 'Can’t connect to session updates';
  if (recording?.isPlaying) return recording.sourceType === 'camera' ? 'Live now' : 'Playing now';
  if (recording?.sourceType === 'camera') return hasReleasedCaptions ? 'The session has ended' : 'Waiting for the presenter to reconnect';
  if (recording?.status === 'ready') {
    if (recording.durationMs !== null && recording.playbackPositionMs >= recording.durationMs) return 'The talk has ended';
    return recording.playbackPositionMs > 0 ? 'Playback is paused' : 'Waiting for the presenter to start';
  }
  if (recording?.status === 'preparing') return 'The presenter is getting the talk ready';
  if (recording?.status === 'failed') return 'The presenter is preparing another recording';
  if (isLive) return 'Live now';
  return hasReleasedCaptions ? 'The session has ended' : 'The presenter is getting ready';
}

// Explain whether useful frames have been selected from the video
function describeVisualMomentState(recording: SessionRecording | undefined, releasedCount: number): string | null {
  if (!recording) return null;
  if (recording.mediaKind === 'audio') return 'Audio only · no frames';
  if (recording.status === 'preparing') return 'Video is processing';
  if (recording.status === 'failed') return 'Video unavailable';
  const selectedFrames = `${releasedCount} ${releasedCount === 1 ? 'frame' : 'frames'} selected`;
  const skippedWindowCount = recording.visualReviewSkippedWindowCount ?? 0;
  if (recording.analysisState === 'failed') return 'Couldn’t review the video';
  if (recording.analysisState === 'analyzing') {
    return releasedCount > 0 ? `${selectedFrames} · Checking more of the video` : 'Checking the video for useful frames';
  }
  if (recording.analysisState === 'complete') {
    if (releasedCount > 0) return skippedWindowCount > 0
      ? `${selectedFrames} · Some video couldn’t be checked`
      : selectedFrames;
    if (recording.visualReviewSkippedWindowCount === null || recording.visualReviewSkippedWindowCount === undefined) {
      return 'Video check complete';
    }
    return skippedWindowCount > 0
      ? 'No frames selected · Some video couldn’t be checked'
      : 'No useful frames selected';
  }
  if (releasedCount > 0) return skippedWindowCount > 0
    ? `${selectedFrames} · Some video couldn’t be checked`
    : selectedFrames;
  if (recording.analysisThroughMs > 0) return skippedWindowCount > 0
    ? 'No frames selected · Some video couldn’t be checked'
    : 'No useful frames selected yet';
  if (recording.analysisState === 'waiting') return 'Waiting for the first video update';
  return 'Video check starts soon';
}

// Format talk offsets as readable timestamps
function formatTimestamp(timestampMs: number): string {
  const totalSeconds = Math.floor(timestampMs / 1_000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const minutePart = String(minutes % 60).padStart(2, '0');
  const secondPart = String(seconds).padStart(2, '0');
  return hours ? `${hours}:${minutePart}:${secondPart}` : `${minutePart}:${secondPart}`;
}

// Keep the attendee media close to the presenter's shared playback clock
// Project the committed source clock when media becomes ready after buffering
function currentPlaybackPosition(recording: NonNullable<SessionRecording>): number {
  const elapsed = recording.isPlaying ? Math.max(0, Date.now() - Date.parse(recording.playbackUpdatedAt)) : 0;
  const position = recording.playbackPositionMs + elapsed;
  return recording.durationMs === null ? position : Math.min(position, recording.durationMs);
}

function synchronizeAttendeeMedia(media: HTMLMediaElement, positionMs: number, isPlaying: boolean): void {
  const targetSeconds = Math.max(0, positionMs / 1_000);
  // Ignore small drift so clock updates do not make attendee playback jump
  if (Math.abs(media.currentTime - targetSeconds) > 1.35) media.currentTime = targetSeconds;
  if (isPlaying && media.paused) void Promise.resolve(media.play()).catch(() => undefined);
  if (!isPlaying && !media.paused) media.pause();
}

// Follow the live media, current topic, and released words from one room
export function SessionReaderPage({ snapshot, connectionState = 'connected', error, retry = () => undefined }: SessionReaderPageProps) {
  const sessionId = snapshot.session.id;
  const media = useRef<HTMLMediaElement>(null);
  const transcript = useRef<HTMLOListElement>(null);
  const topicOpener = useRef<HTMLElement | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState<string | null>(null);
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);
  const [askQuestionSeed, setAskQuestionSeed] = useState<{ id: number; question: string; contextCaptionId: string } | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [openOccurrenceId, setOpenOccurrenceId] = useState<string | null>(null);
  const [focusAskComposerAfterDialog, setFocusAskComposerAfterDialog] = useState(false);
  // Keep a cited URL from overriding an explicit return to the live topic
  const [dismissedCitation, setDismissedCitation] = useState(false);
  const [fontScale, setFontScale] = useState(1);
  const [activeTab, setActiveTab] = useState<SessionReaderTab>('topics');
  const [streamExpanded, setStreamExpanded] = useState(false);
  const [videoVisible, setVideoVisible] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [needsPlaybackTap, setNeedsPlaybackTap] = useState(false);
  const linkedCaptionId = new URLSearchParams(window.location.search).get('caption');
  const occurrenceEntries = snapshot?.threads.flatMap((thread) => thread.occurrences.map((occurrence) => ({ thread, occurrence }))) ?? [];
  const allTopicOccurrences = occurrenceEntries.map(({ occurrence }) => occurrence);
  const assignedMomentIds = new Set(allTopicOccurrences.flatMap(occurrence => visualMomentsForOccurrence(occurrence, snapshot.visualMoments, allTopicOccurrences).map(moment => moment.id)));
  const unassignedMoments = snapshot.visualMoments.filter(moment => !assignedMomentIds.has(moment.id));
  // Fall back to the newest occurrence while a snapshot has not identified the active one
  const activeEntry = occurrenceEntries.find(({ occurrence }) => occurrence.id === snapshot?.activeOccurrenceId)
    ?? occurrenceEntries.at(-1)
    ?? null;
  // Put the most recently discussed topic first while retaining each thread’s visit history
  const topicThreads = [...(snapshot?.threads ?? [])]
    .filter((thread) => thread.occurrences.length > 0)
    .sort((left, right) => (right.occurrences.at(-1)?.startedAtMs ?? 0) - (left.occurrences.at(-1)?.startedAtMs ?? 0));
  const [topicUpdated, setTopicUpdated] = useState(false);
  // Announce changed topic content without treating source-clock ticks as topic updates
  const topicContent = JSON.stringify(snapshot.threads.map(thread => [thread.id, thread.title, thread.summary,
    thread.occurrences.map(occurrence => [occurrence.id, occurrence.summary, occurrence.evidenceCaptionIds])]));
  const previousTopicContent = useRef(topicContent);
  useEffect(() => {
    if (previousTopicContent.current === topicContent) return;
    previousTopicContent.current = topicContent;
    setTopicUpdated(true);
    const timer = window.setTimeout(() => setTopicUpdated(false), 4000);
    return () => window.clearTimeout(timer);
  }, [topicContent]);
  useEffect(() => { if (!openThreadId) topicOpener.current?.focus(); }, [openThreadId]);
  const topicThreadDialog = openThreadId ? snapshot?.threads.find((thread) => thread.id === openThreadId) ?? null : null;
  // Resolve citation links to their topic occurrence before showing the live position
  const linkedEntry = linkedCaptionId && !dismissedCitation
    ? occurrenceEntries.find(({ occurrence }) => occurrence.evidenceCaptionIds.includes(linkedCaptionId)
      || occurrence.captions.some((caption) => caption.id === linkedCaptionId)) ?? null
    : null;
  const selectedEntry = (selectedOccurrenceId
    ? occurrenceEntries.find(({ occurrence }) => occurrence.id === selectedOccurrenceId)
    : null) ?? linkedEntry ?? activeEntry;
  const selectedThread = (selectedThreadId
    ? snapshot?.threads.find((thread) => thread.id === selectedThreadId)
    : null) ?? selectedEntry?.thread ?? activeEntry?.thread ?? null;
  const selectedOccurrence = selectedEntry?.occurrence ?? null;
  const recording = snapshot?.recording;
  const sourcePositionMs = useSourceClock(recording);
  const visualMomentState = describeVisualMomentState(recording, snapshot?.visualMoments.length ?? 0);
  const recordingHasStarted = Boolean(recording && (recording.playbackPositionMs > 0 || snapshot?.session.isLive));
  const recordingHasEnded = Boolean(recording?.status === 'ready'
    && recording.durationMs !== null
    && recording.playbackPositionMs >= recording.durationMs);
  const isReadingEarlier = Boolean(activeEntry && selectedOccurrence && activeEntry.occurrence.id !== selectedOccurrence.id);
  const isReadingEarlierTopic = Boolean(isReadingEarlier && selectedThread && activeEntry?.thread.id !== selectedThread.id);

  useEffect(() => {
    if (!linkedEntry || !linkedCaptionId || dismissedCitation || selectedOccurrenceId) return;
    setSelectedThreadId(linkedEntry.thread.id);
    setSelectedOccurrenceId(linkedEntry.occurrence.id);
    setSelectedCaptionId(linkedCaptionId);
    setActiveTab('transcript');
  }, [dismissedCitation, linkedCaptionId, linkedEntry?.thread.id, linkedEntry?.occurrence.id, selectedOccurrenceId]);

  useEffect(() => {
    if (activeTab !== 'transcript' || !selectedCaptionId) return;
    const caption = document.getElementById(`caption-${selectedCaptionId}`);
    if (!caption) return;
    caption.focus({ preventScroll: true });
    caption.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  }, [activeTab, selectedCaptionId]);

  // Follow the newest released caption only when no earlier passage is selected
  useEffect(() => {
    if (activeTab === 'transcript' && !selectedCaptionId && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [activeTab, snapshot.captions, selectedCaptionId]);

  // Focus the Ask composer after its native dialog has closed
  useEffect(() => {
    if (!focusAskComposerAfterDialog || activeTab !== 'ask' || openThreadId !== null) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById('private-chat-question')?.focus();
      setFocusAskComposerAfterDialog(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab, focusAskComposerAfterDialog, openThreadId]);

  useEffect(() => {
    if (!streamExpanded) return;
    function leaveExpandedStream(event: KeyboardEvent): void {
      if (event.key === 'Escape') setStreamExpanded(false);
    }
    window.addEventListener('keydown', leaveExpandedStream);
    return () => window.removeEventListener('keydown', leaveExpandedStream);
  }, [streamExpanded]);

  useEffect(() => {
    if (!media.current || !recording || recording.status !== 'ready') return;
    synchronizeAttendeeMedia(media.current, currentPlaybackPosition(recording), recording.isPlaying);
  }, [recording?.isPlaying, recording?.playbackPositionMs, recording?.status, recording?.mediaUrl, recording?.playbackUpdatedAt]);

  // Align the attendee after browser metadata unlocks the media timeline
  const syncAttendeePlayback = () => {
    if (!media.current || !recording || recording.status !== 'ready') return;
    synchronizeAttendeeMedia(media.current, currentPlaybackPosition(recording), recording.isPlaying);
  };

  const returnToNow = () => {
    setSelectedThreadId(null);
    setSelectedOccurrenceId(null);
    setSelectedCaptionId(null);
    setDismissedCitation(true);
  };

  // Let keyboard users move between topic, transcript, and ask tabs
  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const tabs: SessionReaderTab[] = ['topics', 'transcript', 'ask'];
    const activeIndex = tabs.indexOf(activeTab);
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
        : event.key === 'ArrowLeft' ? (activeIndex + tabs.length - 1) % tabs.length
          : (activeIndex + 1) % tabs.length;
    const nextTab = tabs[nextIndex] ?? 'topics';
    setActiveTab(nextTab);
    document.getElementById(`${nextTab}-tab`)?.focus();
  }

  // Keep topic and occurrence selection together while moving through its timeline
  const selectOccurrence = (threadId: string, occurrenceId: string) => {
    setSelectedThreadId(threadId);
    setSelectedOccurrenceId(occurrenceId);
    setSelectedCaptionId(null);
  };

  // Update the in-app route without reloading the connected room
  function navigateToRoom(path: string): void {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  // Open thread details over the timeline without moving the reading surface
  function openTopicThread(threadId: string, occurrenceId?: string): void {
    topicOpener.current = document.activeElement as HTMLElement;
    setOpenThreadId(threadId);
    setOpenOccurrenceId(occurrenceId ?? null);
  }

  // Switch to the private question panel
  function openAskTab(focusComposer = false): void {
    setActiveTab('ask');
    if (focusComposer) setFocusAskComposerAfterDialog(true);
  }

  // Open an exact released source in the in-room transcript
  function openTranscriptCaption(threadId: string, occurrenceId: string, captionId: string): void {
    selectOccurrence(threadId, occurrenceId);
    setSelectedCaptionId(captionId);
    setActiveTab('transcript');
    navigateToRoom(`/rooms/${encodeURIComponent(sessionId)}?caption=${encodeURIComponent(captionId)}`);
  }

  // Keep cited Ask answers inside the room while opening their exact caption
  function openAskCitation(captionId: string): void {
    const entry = occurrenceEntries.find(({ occurrence }) => occurrence.evidenceCaptionIds.includes(captionId)
      || occurrence.captions.some((caption) => caption.id === captionId));
    setDismissedCitation(true);
    if (entry) selectOccurrence(entry.thread.id, entry.occurrence.id);
    else {
      setSelectedThreadId(null);
      setSelectedOccurrenceId(null);
    }
    setSelectedCaptionId(captionId);
    setActiveTab('transcript');
    navigateToRoom(`/rooms/${encodeURIComponent(sessionId)}?caption=${encodeURIComponent(captionId)}`);
  }

  // Ask for a user gesture when the browser blocks synchronized autoplay
  async function followStream(): Promise<void> {
    if (!media.current) return;
    try {
      await media.current.play();
      setNeedsPlaybackTap(false);
    } catch {
      setNeedsPlaybackTap(true);
    }
  }

  return (
    <div className={`reader-design app-shell reader-shell${streamExpanded ? ' reader-stream-expanded' : ''}${videoVisible ? '' : ' reader-focus-mode'}`} style={{ '--reader-scale': fontScale } as CSSProperties}>
      <a className="skip-link" href="#session-stream">Skip to the talk</a>
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Summit Thread home">Summit Thread</a>
      </header>

      <main id="session-stream" className="reader-main">
        <header className="session-heading">
          <div>
            <h1>{snapshot?.session.title ?? (error ? 'Can’t open this room' : 'Joining the room')}</h1>
            <p className="session-type">Conference talk</p>
          </div>
          {snapshot && (
            <div className="session-actions">
              <p className="connection-copy" role="status">
                {describeSessionState(recording, snapshot.session.isLive, snapshot.captions.length > 0, connectionState)}
              </p>
              <div className="reader-view-controls" role="group" aria-label="Room view">
                <button
                  className="button button-outline"
                  type="button"
                  aria-pressed={!videoVisible}
                  onClick={() => setVideoVisible((visible) => !visible)}
                >{videoVisible ? 'Hide video' : 'Show video'}</button>
              </div>
            </div>
          )}
        </header>

        {error && (
          <div className="inline-error error-recovery" role="alert">
            <span>{error}</span>
            <button className="text-action" type="button" onClick={retry}>Try again</button>
          </div>
        )}

        {!snapshot ? error ? (
                <p className="empty-reading">Check the room code or ask the presenter for a fresh invite link.</p>
        ) : (
          <div className="reading-loading" aria-busy="true">
            <LoadingIndicator label={connectionState === 'reconnecting' ? 'Reconnecting to the room…' : 'Joining the room…'} />
          </div>
        ) : (
          <>
            <div className="session-content-nav">
                  <div className="session-tabs" role="tablist" aria-label="Talk content" onKeyDown={handleTabKeyDown}>
                    <button
                      id="topics-tab"
                      type="button"
                      role="tab"
                      aria-selected={activeTab === 'topics'}
                      aria-label="Topics"
                      aria-controls="topics-panel"
                      tabIndex={activeTab === 'topics' ? 0 : -1}
                      onClick={() => setActiveTab('topics')}
                    >Topics <span className="session-tab-count" aria-hidden="true">{snapshot.threads.length}</span></button>
                    <button
                      id="transcript-tab"
                      type="button"
                      role="tab"
                      aria-selected={activeTab === 'transcript'}
                      aria-controls="transcript-panel"
                      tabIndex={activeTab === 'transcript' ? 0 : -1}
                      onClick={() => setActiveTab('transcript')}
                    >Transcript <span className="session-tab-count">{snapshot.captions.length}</span></button>
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
                  <div className="text-size-controls" role="group" aria-label="Reading text size">
                    <button type="button" onClick={() => setFontScale((current) => Math.max(0.85, current - 0.1))} aria-label="Smaller text">A−</button>
                    <button type="button" onClick={() => setFontScale((current) => Math.min(1.5, current + 0.1))} aria-label="Larger text">A+</button>
                  </div>
            </div>

            <section className="live-room-layout" aria-label="Talk and topic thread">
              <div className="stream-column">
                <section id="attendee-stream" className={`attendee-stream ${recording?.mediaKind === 'audio' ? 'attendee-stream-audio' : ''}`} aria-labelledby="stream-title">
                  <div className="stream-heading">
                    <h2 id="stream-title">{recording?.sourceType === 'camera' && !recording.isPlaying ? 'Session ended' : recording?.isPlaying ? recording.sourceType === 'camera' ? 'Live session' : 'Talk playback' : recording?.status === 'ready' ? recordingHasEnded ? 'Talk ended' : recordingHasStarted ? 'Playback paused' : 'Ready to begin' : 'Talk'}</h2>
                    <div className="stream-heading-actions">
                      <span className={`stream-state ${recording?.sourceType === 'camera' && recording.isPlaying ? 'is-live' : ''}`} role="status">
                        {recording?.sourceType === 'camera' && !recording.isPlaying ? 'Ended' : recording?.isPlaying ? recording.sourceType === 'camera' ? 'Live' : 'Playing' : recording?.status === 'ready' ? recordingHasEnded ? 'Ended' : recordingHasStarted ? 'Paused' : 'Waiting' : snapshot.session.isLive ? 'Starting' : 'Waiting'}
                      </span>
                      <button
                        className="stream-expand-button"
                        type="button"
                        aria-controls="attendee-stream"
                        aria-expanded={streamExpanded}
                        onClick={() => setStreamExpanded((expanded) => !expanded)}
                      >{streamExpanded ? 'Exit expanded view' : 'Expand stream'}</button>
                    </div>
                  </div>
                  {recording?.sourceType === 'camera' && recording.isPlaying ? (
                    <LiveCameraViewer sessionId={sessionId} />
                  ) : recording?.sourceType === 'camera' ? (
                    <p className="stream-placeholder">This live session has ended. Ask the presenter for a new room to join another talk.</p>
                  ) : recording?.status === 'preparing' ? (
                    <div className="stream-placeholder" aria-busy="true">
                      <LoadingIndicator label="Preparing the recording…" />
                    </div>
                  ) : recording?.status === 'ready' ? (
                    <div className="stream-player-wrap">
                      {recording.mediaKind === 'video' ? (
                        <video
                          ref={(element) => { media.current = element; }}
                          className="attendee-media"
                          src={recording.mediaUrl}
                          muted={!soundEnabled}
                          playsInline
                          preload="metadata"
                          onLoadedMetadata={syncAttendeePlayback}
                          onCanPlay={syncAttendeePlayback}
                          onPlay={() => setNeedsPlaybackTap(false)}
                          onError={() => setNeedsPlaybackTap(true)}
                          aria-label="Shared talk video"
                        >
                          Your browser can’t play this video.
                        </video>
                      ) : (
                        <div className="audio-stream-art" aria-label="Shared talk audio">
                          <div className="audio-wave" aria-hidden="true">{Array.from({ length: 32 }, (_, index) => <span key={index} />)}</div>
                          <audio
                            ref={(element) => { media.current = element; }}
                            src={recording.mediaUrl}
                            muted={!soundEnabled}
                            preload="metadata"
                            onLoadedMetadata={syncAttendeePlayback}
                            onCanPlay={syncAttendeePlayback}
                            onPlay={() => setNeedsPlaybackTap(false)}
                            onError={() => setNeedsPlaybackTap(true)}
                            aria-label="Talk audio player"
                          />
                        </div>
                      )}
                      <div className="stream-controls">
                        <span>{recording.isPlaying ? 'Playing for attendees' : recordingHasEnded ? 'The talk has ended' : recordingHasStarted ? 'Waiting for the presenter to resume' : 'The presenter hasn’t started playback yet'}</span>
                        <div className="stream-control-actions">
                          {needsPlaybackTap && <button className="button button-outline" type="button" onClick={() => void followStream()}>Resume playback</button>}
                          <button className="text-action" type="button" onClick={() => {
                            setSoundEnabled((current) => {
                              if (media.current) media.current.muted = current;
                              return !current;
                            });
                          }}>{soundEnabled ? 'Mute sound' : 'Turn sound on'}</button>
                        </div>
                      </div>
                    </div>
                  ) : recording?.status === 'failed' ? (
                    <p className="stream-placeholder">The presenter is preparing another recording. It will appear here when it’s ready.</p>
                  ) : (
                    <p className="stream-placeholder">The presenter hasn’t started the talk yet.</p>
                  )}
                </section>

                {activeEntry && activeTab !== 'topics' && (
                  <section className="stream-current-thread" aria-labelledby="stream-current-thread-title">
                    <h3 id="stream-current-thread-title">{activeEntry.thread.title}</h3>
                    <p>{activeEntry.thread.summary}</p>
                    <button className="text-action" type="button" onClick={() => {
                      openTopicThread(activeEntry.thread.id);
                    }}>View topic thread</button>
                  </section>
                )}
              </div>

              <section className="thread-column" aria-label="Session reading tools">

                <section id="topics-panel" className="session-tab-panel" role="tabpanel" aria-labelledby="topics-tab" hidden={activeTab !== 'topics'}>
                  <div className="reading-position">
                    {topicThreads.length === 0 ? <span>Waiting for the first topic</span>
                      : isReadingEarlier ? <span>{isReadingEarlierTopic ? 'Viewing an earlier topic' : 'Viewing an earlier moment'}</span>
                        : recording?.isPlaying ? <span>Following the live topic</span>
                          : <span>Current topic</span>}
                    {recording?.isPlaying && (
                      <span className="thread-update-countdown" aria-live="off">
                        Next topic update in {formatThreadUpdateCountdown(sourcePositionMs, recording.analysisWindowMinutes)}
                      </span>
                    )}
                    {topicUpdated && <span className="topic-update-notice" role="status">Topic updated</span>}
                    {isReadingEarlier && <button className="text-action" type="button" onClick={returnToNow}>Back to current topic</button>}
                  </div>

                  {unassignedMoments.length > 0 && <VisualMomentGallery moments={unassignedMoments} recording={recording ?? null} onOpenSpokenMoment={openAskCitation} onOpenTopic={openTopicThread} />}
                  {snapshot.topicAnalysisSkippedCaptionCount > 0 && <p className="topic-note" role="note">{snapshot.topicAnalysisSkippedCaptionCount} {snapshot.topicAnalysisSkippedCaptionCount === 1 ? 'transcript line isn’t' : 'transcript lines aren’t'} grouped into a topic yet. You can still read them in the transcript.</p>}
                  {topicThreads.length > 0 ? (
                    <section className="topic-history topic-milestones" aria-labelledby="topic-history-title">
                      <div className="topic-history-heading">
                        <div>
                          <h2 id="topic-history-title">Topic milestones</h2>
                        </div>
                        <div className="topic-milestone-heading-meta">
                          <span>{topicThreads.length} {topicThreads.length === 1 ? 'thread' : 'threads'}</span>
                          {visualMomentState && <span className="topic-visual-status">{visualMomentState}</span>}
                        </div>
                      </div>
                      <ol className="topic-milestone-timeline" reversed aria-label="Topic threads, latest first">
                        {topicThreads.map((thread, index) => {
                          const firstOccurrence = thread.occurrences[0];
                          const latestOccurrence = thread.occurrences.at(-1);
                          if (!firstOccurrence || !latestOccurrence) return null;
                          const sourceCount = new Set(thread.occurrences.flatMap((occurrence) => occurrence.evidenceCaptionIds)).size;
                          const threadVisualOccurrences = thread.occurrences.flatMap((occurrence) => (
                            visualMomentsForOccurrence(occurrence, snapshot.visualMoments, allTopicOccurrences)
                              .map((moment) => ({ moment, occurrence }))
                          ));
                          const featuredVisualOccurrence = threadVisualOccurrences[0];
                          const featuredVisualMoment = featuredVisualOccurrence?.moment;
                          return (
                            <li className={`topic-milestone${thread.id === activeEntry?.thread.id ? ' is-current' : ''}`} key={thread.id}>
                              <span className="topic-milestone-marker" aria-hidden="true">{String(topicThreads.length - index).padStart(2, '0')}</span>
                              <button
                                className="topic-milestone-card"
                                type="button"
                                aria-current={thread.id === activeEntry?.thread.id ? 'true' : undefined}
                                aria-haspopup="dialog"
                                aria-label={`Open ${thread.title} at ${formatTimestamp(firstOccurrence.startedAtMs)}`}
                                onClick={() => openTopicThread(thread.id, featuredVisualOccurrence?.occurrence.id ?? latestOccurrence.id)}
                              >
                                <span className="topic-milestone-topline">
                                  <time>{formatTimestamp(firstOccurrence.startedAtMs)}</time>
                                  {thread.id === activeEntry?.thread.id && <span className="topic-history-status">{recording?.isPlaying ? 'Talking about now' : 'Current topic'}</span>}
                                  <span className="topic-milestone-open" aria-hidden="true">↗</span>
                                </span>
                                {featuredVisualMoment && (
                                  <span className="topic-milestone-visual">
                                    <span className="topic-milestone-visual-frame">
                                      <img src={featuredVisualMoment.imageUrl} alt="" loading="lazy" decoding="async" />
                                      <time>{formatTimestamp(featuredVisualMoment.timestampMs)}</time>
                                    </span>
                                    <span className="topic-milestone-visual-copy">
                                      <span className="topic-milestone-visual-label">On screen</span>
                                      <span className="topic-milestone-visual-title">{featuredVisualMoment.topicTitle}</span>
                                      <span className="topic-milestone-visual-description">{featuredVisualMoment.description}</span>
                                    </span>
                                  </span>
                                )}
                                <span className="topic-milestone-title">{thread.title}</span>
                                <span className="topic-milestone-summary">{thread.summary}</span>
                                <span className="topic-milestone-meta">
                                  <span>Came up {thread.occurrences.length} {thread.occurrences.length === 1 ? 'time' : 'times'}</span>
                                  {thread.occurrences.length > 1 && <span>Last came up {formatTimestamp(latestOccurrence.startedAtMs)}</span>}
                                  <span>{sourceCount} transcript {sourceCount === 1 ? 'passage' : 'passages'}</span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    </section>
                  ) : (
                      <section className={`topic-empty-state${recording?.isPlaying ? ' is-listening' : ''}`} aria-labelledby="topic-empty-title">
                        <div className="topic-empty-visual">
                          <svg viewBox="0 0 1200 240" aria-hidden="true" focusable="false">
                            <path className="topic-empty-route" d="M28 160 C190 160 188 68 360 68 S538 168 704 168 S878 78 1048 78 H1170" />
                            <g className="topic-empty-stops">
                              <circle cx="360" cy="68" r="7" />
                              <circle cx="704" cy="168" r="7" />
                              <circle cx="1048" cy="78" r="7" />
                              <circle cx="1170" cy="78" r="7" />
                            </g>
                            <g className="topic-empty-current" transform="translate(28 160)">
                              <circle className="topic-empty-pulse" r="22" />
                              <circle className="topic-empty-core" r="6" />
                            </g>
                          </svg>
                          <span className="topic-empty-visual-note">
                            <span className="topic-empty-signal" aria-hidden="true" />
                            <h2 id="topic-empty-title">{recording?.isPlaying ? 'Listening now' : recordingHasStarted ? 'Talk paused' : 'Waiting for the talk to start'}</h2>
                            <button className="text-action" type="button" onClick={() => setActiveTab('transcript')}>Read transcript</button>
                          </span>
                      </div>
                    </section>
                  )}
                </section>

                <section id="transcript-panel" className="session-tab-panel transcript-panel" role="tabpanel" aria-labelledby="transcript-tab" hidden={activeTab !== 'transcript'}>
                  <header className="transcript-panel-heading">
                    {selectedCaptionId && <button className="text-action" onClick={returnToNow}>Return to now</button>}
                    <div>
                      <h2>Transcript</h2>
                    </div>
                    <p className="transcript-status" role="status">
                      {recording?.isPlaying ? 'Waiting for the next transcript lines…' : snapshot.captions.length ? 'Transcript so far' : 'The transcript will appear here when the talk begins.'}
                    </p>
                  </header>
                  {snapshot.captions.length ? (
                    <ol ref={transcript} className="moment-lines live-transcript-lines" aria-label="Live transcript" aria-live="polite" aria-relevant="additions">
                      {snapshot.captions.map((caption) => (
                        <li id={`caption-${caption.id}`} className="moment-line" key={caption.id} tabIndex={caption.id === selectedCaptionId ? -1 : undefined} aria-current={caption.id === selectedCaptionId ? 'location' : undefined}>
                          <time dateTime={`PT${caption.timestampMs / 1_000}S`}>{formatTimestamp(caption.timestampMs)}</time>
                          <p>{caption.text}</p>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    recording?.isPlaying ? (
                      <div className="transcript-waiting" aria-busy="true"><LoadingIndicator label="Waiting for the first transcript lines…" /></div>
                    ) : (
                      <p className="empty-reading">Transcript lines will appear here as the talk plays.</p>
                    )
                  )}
                </section>

                <section id="ask-panel" className="session-tab-panel ask-panel" role="tabpanel" aria-labelledby="ask-tab" hidden={activeTab !== 'ask'}>
                  <header className="ask-panel-heading">
                    <h2>Ask about the talk</h2>
                  </header>
                  <PrivateChatPanel
                    sessionId={sessionId}
                    snapshot={snapshot}
                    connectionState={connectionState}
                    initialQuestion={askQuestionSeed}
                    onOpenCitation={openAskCitation}
                  />
                </section>
              </section>
            </section>
            <TopicThreadDialog
              thread={topicThreadDialog}
              initialOccurrenceId={openOccurrenceId}
              captions={snapshot.captions}
              visualMoments={snapshot.visualMoments}
              allOccurrences={allTopicOccurrences}
              sessionTitle={snapshot.session.title}
              isCurrent={topicThreadDialog?.id === activeEntry?.thread.id}
              canAsk={snapshot.captions.length > 0}
              onClose={() => {
                setOpenThreadId(null); topicOpener.current?.focus();
                setOpenOccurrenceId(null);
              }}
              onAsk={() => openAskTab(true)}
              onAskAboutMoment={(question, contextCaptionId) => {
                setAskQuestionSeed({ id: Date.now(), question, contextCaptionId });
                openAskTab(true);
              }}
              onOpenCaption={openTranscriptCaption}
            />
          </>
        )}
      </main>
      <footer className="site-footer"><a href="/">Join another room</a></footer>
    </div>
  );
}
