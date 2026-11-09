import { useEffect, useRef, useState, type MediaHTMLAttributes } from 'react';
import {
  updateRecordingPlayback,
  type SessionRecording
} from '../sessions/public';
import {
  connectLiveTranscription,
  type LiveCapture
} from '../transcription/public';

// Synchronize presenter source controls while keeping transcription independent of playback
export function PresenterMediaStage({
  sessionId,
  recording
}: {
  sessionId: string;
  recording: SessionRecording;
}) {
  const media = useRef<HTMLMediaElement | null>(null);
  const capture = useRef<LiveCapture | null>(null);
  const source = useRef<MediaStream | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const transcriptAttempted = useRef(false);
  const mounted = useRef(false);
  const playing = useRef(false);
  const seeking = useRef(false);
  const queue = useRef(Promise.resolve());
  const finalizing = useRef(Promise.resolve());
  const connecting = useRef(Promise.resolve());
  const lastSent = useRef(0);
  const [status, setStatus] = useState('Transcript disconnected');
  const [syncError, setSyncError] = useState('');
  const [mediaError, setMediaError] = useState('');
  const [transcriptError, setTranscriptError] = useState('');
  const [position, setPosition] = useState(recording.playbackPositionMs);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      playing.current = false;
      const positionMs = Math.floor(
        (media.current?.currentTime ?? position / 1000) * 1000
      );
      void stopTranscript()
        .then(() => updateRecordingPlayback(sessionId, positionMs, false))
        .catch(() => undefined);
    };
    // Scope source resources to the keyed room and recording
  }, [sessionId]);
  function stopTranscript() {
    generation.current += 1;
    transcriptAttempted.current = false;
    controller.current?.abort();
    controller.current = null;
    const current = capture.current;
    capture.current = null;
    const stream = source.current;
    source.current = null;
    const pending = connecting.current;
    finalizing.current = finalizing.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await Promise.all([current?.stop(), pending]);
        } finally {
          stream?.getTracks().forEach((track) => track.stop());
        }
      });
    return finalizing.current;
  }
  async function startTranscript(token: number) {
    if (
      transcriptAttempted.current ||
      capture.current ||
      controller.current ||
      !mounted.current ||
      token !== generation.current ||
      !playing.current
    )
      return;
    transcriptAttempted.current = true;
    const player = media.current as
      | (HTMLMediaElement & {
          captureStream?: () => MediaStream;
          mozCaptureStream?: () => MediaStream;
        })
      | null;
    const getStream = player?.captureStream ?? player?.mozCaptureStream;
    if (!player || !getStream) {
      setStatus('Transcript unavailable');
      setTranscriptError(
        'This browser cannot capture recording audio. Try a current desktop Chrome or Firefox browser. Playback can continue.'
      );
      return;
    }
    const aborter = new AbortController();
    controller.current = aborter;
    setStatus('Transcript connecting…');
    setTranscriptError('');
    let stream: MediaStream | undefined;
    try {
      const captured = getStream.call(player);
      // Retain only source audio; this workflow never asks for device permission
      captured.getVideoTracks?.().forEach((track) => track.stop());
      stream = new MediaStream(captured.getAudioTracks());
      source.current = stream;
      const started = await connectLiveTranscription(
        sessionId,
        stream,
        (event) => {
          if (!mounted.current || token !== generation.current) return;
          if (
            event.type === 'ready' ||
            (event.type === 'connection' && event.state === 'ready')
          )
            setStatus('Transcript connected');
          if (event.type === 'connection' && event.state === 'reconnecting')
            setStatus('Transcript reconnecting…');
          if (event.type === 'error') {
            setStatus('Transcript disconnected');
            setTranscriptError(event.message);
          }
        },
        {
          signal: aborter.signal,
          initialPositionMs: Math.floor(player.currentTime * 1000)
        }
      );
      if (!mounted.current || token !== generation.current) {
        await started.stop();
        return;
      }
      capture.current = started;
      started.setPosition(Math.floor(player.currentTime * 1000));
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      if (mounted.current && token === generation.current) {
        setStatus('Transcript disconnected');
        setTranscriptError(
          'The transcript could not connect. Check the backend configuration, then pause and resume to retry.'
        );
      }
    } finally {
      if (controller.current === aborter) controller.current = null;
    }
  }
  function synchronize(nextPlaying: boolean, force = false) {
    if (!media.current || (!force && Date.now() - lastSent.current < 900))
      return;
    lastSent.current = Date.now();
    // Commit the validated end so sub-millisecond browser rounding cannot strand the final window
    const sourcePosition = media.current.ended && recording.durationMs !== null ? recording.durationMs : Math.min(
      recording.durationMs ?? Infinity,
      Math.max(0, Math.floor(media.current.currentTime * 1000))
    );
    const token = generation.current;
    queue.current = queue.current
      .catch(() => undefined)
      .then(async () => {
        await finalizing.current;
        await updateRecordingPlayback(sessionId, sourcePosition, nextPlaying);
        if (mounted.current) setSyncError('');
        if (nextPlaying && token === generation.current)
          connecting.current = startTranscript(token);
      })
      .catch(() => {
        if (mounted.current)
          setSyncError(
            'Room playback could not sync. Check the connection, then pause and resume to retry.'
          );
      });
  }
  function pause() {
    playing.current = false;
    void stopTranscript();
    setStatus('Transcript disconnected');
    synchronize(false, true);
  }
  const events: MediaHTMLAttributes<HTMLMediaElement> = {
    onLoadedMetadata: () => {
      if (
        media.current &&
        Math.abs(
          media.current.currentTime - recording.playbackPositionMs / 1000
        ) > 0.05
      )
        media.current.currentTime = recording.playbackPositionMs / 1000;
    },
    onPlaying: () => {
      if (seeking.current) return;
      playing.current = true;
      synchronize(true, true);
    },
    onPause: pause,
    onEnded: pause,
    onWaiting: pause,
    onSeeking: () => {
      seeking.current = true;
      void stopTranscript();
      setStatus(
        playing.current ? 'Transcript reconnecting…' : 'Transcript disconnected'
      );
    },
    onSeeked: () => {
      seeking.current = false;
      playing.current = !media.current?.paused;
      synchronize(playing.current, true);
    },
    onTimeUpdate: () => {
      if (!media.current || seeking.current) return;
      const ms = Math.floor(media.current.currentTime * 1000);
      setPosition(ms);
      capture.current?.setPosition(ms);
      if (playing.current) synchronize(true);
    },
    onError: () => {
      pause();
      setMediaError(
        'The browser could not play this recording. Try a supported MP4 or MP3 file.'
      );
    }
  };
  return (
    <section aria-label="Presenter recording playback">
      <p>Use the player controls to start, pause or seek for everyone.</p>
      {recording.mediaKind === 'video' ? (
        <video
          ref={media as React.RefObject<HTMLVideoElement>}
          src={recording.mediaUrl}
          controls
          playsInline
          preload="metadata"
          aria-label="Talk video player"
          {...events}
        />
      ) : (
        <audio
          ref={media as React.RefObject<HTMLAudioElement>}
          src={recording.mediaUrl}
          controls
          preload="metadata"
          aria-label="Talk audio player"
          {...events}
        />
      )}
      <p>
        <span role="status">{status}</span> · Source{' '}
        {Math.floor(position / 60000)}:
        {String(Math.floor(position / 1000) % 60).padStart(2, '0')}
      </p>
      <p className="muted">
        Thread update interval: {recording.analysisWindowMinutes} minutes. Topic and visual review follow completed source intervals.
      </p>
      {transcriptError && <p role="alert">{transcriptError}</p>}
      {syncError && <p role="alert">{syncError}</p>}
      {mediaError && <p role="alert">{mediaError}</p>}
    </section>
  );
}
