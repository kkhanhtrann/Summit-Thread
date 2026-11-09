import { useEffect, useRef, useState } from 'react';
import type { SessionRecording, SessionSnapshot } from '../sessions/public';

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
// Let attendees read released words without moving their place in earlier speech
export function SessionReaderPage({ snapshot }: { snapshot: SessionSnapshot }) {
  const reader = useRef<HTMLOListElement | null>(null);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    if (following && reader.current)
      reader.current.scrollTop = reader.current.scrollHeight;
  }, [snapshot.captions, following]);
  return (
    <>
      <p className="muted">Room {snapshot.session.id} · Attendee view</p>
      <div className="room-columns reader-columns">
        <div>
          {snapshot.recording?.status === 'ready' ? (
            <RecordingPlayer recording={snapshot.recording} />
          ) : (
            <section>
              <h2>Recording playback</h2>
              <p className="empty">
                {snapshot.recording?.status === 'preparing'
                  ? 'The presenter is uploading and validating the recording.'
                  : 'Waiting for the presenter to prepare a recording.'}
              </p>
            </section>
          )}
        </div>
        <section aria-labelledby="words-title">
          <div className="caption-heading">
            <h2 id="words-title">The speaker’s words</h2>
            {!following && (
              <button className="secondary" onClick={() => setFollowing(true)}>
                Return to newest caption
              </button>
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
                  setFollowing(
                    element.scrollHeight -
                      element.scrollTop -
                      element.clientHeight <
                      48
                  );
              }}
            >
              {snapshot.captions.map((caption) => (
                <li key={caption.id}>
                  <time>
                    {Math.floor(caption.timestampMs / 60000)}:
                    {String(
                      Math.floor(caption.timestampMs / 1000) % 60
                    ).padStart(2, '0')}
                  </time>
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
        </section>
      </div>
    </>
  );
}
