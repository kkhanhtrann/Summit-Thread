import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import '../../shared/styles/conference-experience.css';
import { LoadingIndicator } from '../../shared/ui/LoadingIndicator';
import { createSession, useSessionFeed, type SessionRecording } from '../sessions/public';
import { PresenterMediaStage } from './PresenterMediaStage';
import { LiveCameraPublisher } from './LiveCameraPublisher';
import { RecordingSourcePanel } from './RecordingSourcePanel';
import { BrandMark } from '../../shared/ui/BrandMark';
import { MaterialsPanel } from './MaterialsPanel';

// Describe the optional room code encoded in a presenter link
export interface PresenterPageProps {
  initialSessionId?: string;
}

// Create a room, prepare its source, and start the shared live session
export function PresenterPage({ initialSessionId }: PresenterPageProps) {
  const mounted = useRef(true);
  const currentRoom = useRef(initialSessionId);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [title, setTitle] = useState('');
  const [sessionId, setSessionId] = useState(initialSessionId);
  currentRoom.current = sessionId;
  const [createError, setCreateError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [acceptedRecording, setAcceptedRecording] = useState<SessionRecording | null>(null);
  const [liveCameraStream, setLiveCameraStream] = useState<MediaStream | null>(null);
  const { snapshot, connectionState, error, retry } = useSessionFeed(sessionId);
  const attendeePath = useMemo(() => sessionId ? `/rooms/${encodeURIComponent(sessionId)}` : '', [sessionId]);
  const attendeeUrl = useMemo(() => attendeePath ? `${window.location.origin}${attendeePath}` : '', [attendeePath]);
  const recording = snapshot?.recording ?? acceptedRecording;

  useEffect(() => {
    if (snapshot?.recording) setAcceptedRecording(snapshot.recording);
  }, [snapshot?.recording]);

  // Create a fresh live room and keep its link in the address bar
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setCreateError('');
    try {
      const created = await createSession(title.trim());
      setAcceptedRecording(null);
      setLiveCameraStream(null);
      setSessionId(created.session.id);
      window.history.replaceState({}, '', `/presenter/${encodeURIComponent(created.session.id)}`);
    } catch (requestError) {
      setCreateError(requestError instanceof Error ? requestError.message : 'The room could not be created. Try again.');
    }
  }

  // Copy the attendee invitation and announce the result without changing routes
  async function copyInvite(): Promise<void> {
    try {
      await navigator.clipboard.writeText(attendeeUrl);
      setCopyMessage('Link copied.');
    } catch {
      setCopyMessage('Couldn’t copy. Select the link above instead.');
    }
  }

  function createAnotherRoom(): void {
    setSessionId(undefined);
    setAcceptedRecording(null);
    setLiveCameraStream(null);
    setTitle('');
    setCreateError('');
    setCopyMessage('');
    window.history.replaceState({}, '', '/presenter');
  }

  return (
    <div className="reader-design app-shell presenter-shell">
      <a className="skip-link" href="#presenter-room">Skip to the session controls</a>
      <header className="site-header">
        <BrandMark />
      </header>

      <main id="presenter-room" className="presenter-main">
        {!sessionId ? (
          <section className="presenter-create" aria-labelledby="presenter-title">
            <h1 id="presenter-title">Start a room for your talk</h1>
            <form className="create-session-form" onSubmit={(event) => void submit(event)}>
              <label htmlFor="session-title">Talk title</label>
              <input
                id="session-title"
                autoComplete="off"
                maxLength={100}
                placeholder="Opening keynote"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
              />
              {createError && <p className="inline-error" role="alert">{createError}</p>}
              <button className="button button-accent" type="submit" disabled={!title.trim()}>
                Create room
              </button>
            </form>
          </section>
        ) : !snapshot ? (
          error ? (
            <section className="presenter-loading" aria-labelledby="room-unavailable-title">
            <h1 id="room-unavailable-title">Can’t open this room</h1>
              <p className="presenter-intro">{error}</p>
              <div className="presenter-room-links">
                <button className="button button-accent" type="button" onClick={retry}>Try again</button>
                <button className="text-action" type="button" onClick={createAnotherRoom}>Create another room</button>
              </div>
            </section>
          ) : (
            <section className="presenter-loading" aria-busy="true">
              <LoadingIndicator label={connectionState === 'reconnecting' ? 'Reconnecting to the room…' : 'Opening your room…'} />
            </section>
          )
        ) : (
          <>
            <header className="presenter-session-heading">
              <div>
                <h1>{snapshot.session.title}</h1>
              </div>
            </header>

            <section className="presenter-workspace" aria-label="Presenter workspace">
              <div className="presenter-stage-column">
                <section className="presenter-stream-workflow" aria-label="Session controls">
                  {recording?.sourceType === 'camera' && liveCameraStream ? (
                    <LiveCameraPublisher
                      sessionId={sessionId}
                      stream={liveCameraStream}
                      recording={recording}
                      onEnded={() => setLiveCameraStream(null)}
                    />
                  ) : recording?.sourceType === 'camera' ? (
                    <section className="recording-preparation" aria-labelledby="camera-ended-title">
                      <h2 id="camera-ended-title">{recording.isPlaying ? 'Camera disconnected' : 'This live session has ended'}</h2>
                      <p>{recording.isPlaying ? 'Create a new room to go live again.' : 'Attendees can still read the transcript and topic threads.'}</p>
                    </section>
                  ) : recording?.status === 'ready' ? (
                    <PresenterMediaStage sessionId={sessionId} recording={recording} />
                  ) : (
                    <RecordingSourcePanel
                      sessionId={sessionId}
                      recording={recording}
                      onRecordingAccepted={setAcceptedRecording}
                      onLiveCameraStarted={(liveRecording, stream) => {
                        // Reject late permission or API completion after the room owner leaves
                        if (!mounted.current || currentRoom.current !== sessionId) {
                          for (const track of stream.getTracks()) track.stop();
                          return;
                        }
                        setAcceptedRecording(liveRecording);
                        setLiveCameraStream(stream);
                      }}
                    />
                  )}
                </section>

                {/* Keep materials as their own step beside the talk controls so presenters add them before starting */}
                <MaterialsPanel sessionId={sessionId} />
              </div>

              <aside className="presenter-room-panel" aria-label="Room details and sharing">
                <section className="room-invite" aria-labelledby="room-invite-title">
                  <h2 id="room-invite-title">Invite your audience</h2>
                  <dl className="room-invite-details">
                    <div>
                      <dt>Room code</dt>
                      <dd className="room-code">{snapshot.session.id}</dd>
                    </div>
                    <div className="attendee-invite">
                      <dt>Link</dt>
                      <dd><a href={attendeePath}>{attendeeUrl}</a></dd>
                      <dd>
                        <button className="button button-outline" type="button" onClick={() => void copyInvite()}>Copy link</button>
                        <p className="copy-message" role="status">{copyMessage}</p>
                      </dd>
                    </div>
                  </dl>
                </section>

                {snapshot.threads.length > 0 && (
                  <section className="presenter-topic-preview" aria-labelledby="presenter-topic-title">
                    <h2 id="presenter-topic-title">Latest topic</h2>
                    <p className="presenter-topic-name">{snapshot.threads.at(-1)?.title}</p>
                    <p>{snapshot.captions.length} transcript {snapshot.captions.length === 1 ? 'line' : 'lines'}</p>
                  </section>
                )}

                <footer className="presenter-room-links">
                  <a className="button button-outline" href={attendeePath} target="_blank" rel="noreferrer">See the attendee view</a>
                  <button className="text-action" type="button" onClick={createAnotherRoom}>Create another room</button>
                </footer>
              </aside>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
