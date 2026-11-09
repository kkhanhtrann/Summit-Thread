import { LiveCameraPublisher } from './LiveCameraPublisher';
import { useEffect, useRef, useState } from 'react';
import { uploadRecording, startLiveCapture, type SessionRecording, type SessionSnapshot } from '../sessions/public';
import { PresenterMediaStage } from './PresenterMediaStage';

// Offer local presenter controls and a plain attendee invitation
export function PresenterPage({ snapshot }: { snapshot: SessionSnapshot }) {
  const code = snapshot.session.id;
  const invitation = `${window.location.origin}/rooms/${code}`;
  const [liveSource, setLiveSource] = useState<{ recording: SessionRecording; stream: MediaStream } | null>(null);
  const [startingCamera, setStartingCamera] = useState(false);
  const [copyState, setCopyState] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [minutes, setMinutes] = useState(5);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const active = useRef(true);
  const uploadController = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      uploadController.current?.abort();
    };
  }, []);
  async function upload() {
    if (!file) return;
    if (!file.size || file.size > 300 * 1024 * 1024) {
      setError('Choose a nonempty recording no larger than 300 MiB.');
      return;
    }
    const aborter = new AbortController();
    uploadController.current = aborter;
    setUploading(true);
    setProgress(0);
    setError('');
    try {
      await uploadRecording(
        code,
        file,
        minutes,
        (ratio) => {
          if (active.current) setProgress(ratio);
        },
        aborter.signal
      );
    } catch (failure) {
      if (active.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Upload failed. Choose the file and retry.'
        );
    } finally {
      if (active.current) setUploading(false);
    }
  }
  // Start the live camera room after browser permission succeeds
  async function goLive(): Promise<void> {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Live camera is unavailable in this browser. Choose a recording instead.');
      return;
    }
    setStartingCamera(true);
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const result = await startLiveCapture(code, minutes);
      if (!active.current) return;
      setLiveSource({ recording: result.recording, stream });
      stream = undefined;
    } catch (cameraError) {
      const browserError = cameraError instanceof DOMException ? cameraError.name : '';
      setError(browserError === 'NotAllowedError'
        ? 'Camera or microphone access was blocked. Allow access in your browser settings, then try again.'
        : browserError === 'NotFoundError'
          ? 'No camera or microphone was found. Connect one or choose a recording.'
          : 'Camera access couldn’t start. Check your browser permissions and try again.');
    } finally {
      for (const track of stream?.getTracks() ?? []) track.stop();
      setStartingCamera(false);
    }
  }

  const recording = snapshot.recording ?? liveSource?.recording;
  return (
    <>
      <section className="invitation" aria-labelledby="invite-title">
        <div>
          <h2 id="invite-title">Invite your attendees</h2>
          <p>
            Room code <strong className="room-code">{code}</strong>
          </p>
          <a href={invitation}>{invitation}</a>
        </div>
        <div>
          <button
            className="secondary"
            onClick={() => {
              void (
                navigator.clipboard
                  ? navigator.clipboard.writeText(invitation)
                  : Promise.reject()
              ).then(
                () => setCopyState('Invitation copied'),
                () => setCopyState('Copy the invitation link above.')
              );
            }}
          >
            Copy invitation
          </button>
          <p role="status">{copyState}</p>
        </div>
      </section>
      <div className="room-columns">
        <div>
          <h2>Recording playback</h2>
          <p className="muted">
            These are local demo controls. Anyone with the presenter link can
            use them.
          </p>
          {liveSource ? (
            <LiveCameraPublisher sessionId={code} stream={liveSource.stream} recording={recording!} onEnded={() => setLiveSource(null)} />
          ) : recording?.sourceType === 'camera' ? (
            <p role="status">This camera session has ended or disconnected. Create a fresh room to start another.</p>
          ) : recording?.status === 'ready' ? (
            <PresenterMediaStage
              key={`${code}:${recording.mediaUrl}`}
              sessionId={code}
              recording={recording}
            />
          ) : (
            <section aria-label="Upload recording">
              <label htmlFor="recording">Audio or video recording</label>
              <input
                id="recording"
                type="file"
                accept="audio/mpeg,audio/mp4,audio/wav,audio/x-wav,audio/webm,audio/ogg,audio/flac,video/mp4,video/webm,video/quicktime"
                disabled={uploading || startingCamera}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setError('');
                }}
              />
              <label htmlFor="interval">Thread update interval</label>
              <select
                id="interval"
                value={minutes}
                disabled={uploading || startingCamera}
                onChange={(event) => setMinutes(Number(event.target.value))}
              >
                {[1, 3, 5, 10].map((value) => (
                  <option key={value} value={value}>
                    {value} {value === 1 ? 'minute' : 'minutes'}
                  </option>
                ))}
              </select>
              <p className="muted">
                MP3, M4A, WAV, WebM, Ogg, FLAC, MP4 or MOV with audio. Up to 300
                MiB and 24 hours. Browser playback support varies.
              </p>
              <button
                disabled={
                  !file || uploading || startingCamera || recording?.status === 'preparing'
                }
                onClick={() => void upload()}
              >
                {uploading
                  ? progress < 1
                    ? `Uploading ${Math.round(progress * 100)}%`
                    : 'Validating recording…'
                  : 'Upload recording'}
              </button>
              {uploading && (
                <progress
                  aria-label="Recording upload"
                  value={progress}
                  max={1}
                />
              )}
              {recording?.status === 'failed' && (
                <p role="alert">
                  The source could not be prepared. Choose a valid file and
                  retry.
                </p>
              )}
              {error && <p role="alert">{error}</p>}
            </section>
          )}
          <section className="planned" aria-labelledby="planned-title">
            <h2 id="planned-title">More source options</h2>
            {!recording && <>
              <button disabled={uploading || startingCamera} onClick={() => void goLive()}>{startingCamera ? 'Connecting camera…' : 'Go live with camera'}</button>
              <p>Share your camera and microphone with attendees. Access is requested only when you start.</p>
            </>}
            <button disabled>Streaming platform intake — Planned</button>
            <p>
              Presenters will supply a supported stream to play and transcribe
              in the room. External streams are not connected yet.
            </p>
          </section>
        </div>
        <section aria-labelledby="presenter-caption-title">
          <h2 id="presenter-caption-title">Released words</h2>
          {snapshot.captions.length ? (
            <ol className="captions">
              {snapshot.captions.map((caption) => (
                <li key={caption.id}>
                  <time>{formatTime(caption.timestampMs)}</time>
                  <p>{caption.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty">
              Finalized speech will appear here as the recording plays with
              transcription connected.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
// Format the source position consistently in presenter and attendee captions
function formatTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
