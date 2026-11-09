import { useEffect, useRef, useState } from 'react';

import { connectLiveTranscription, type LiveCapture, type LiveSpeechEvent } from '../transcription/public';
import { connectLiveMedia, sendLiveSignal, stopLiveCapture, uploadLiveWindow, updateRecordingPlayback, type LivePeerSignal, type SessionRecording } from '../sessions/public';

interface PeerConnectionEntry {
  peer: RTCPeerConnection;
  signalQueue: Promise<void>;
  pendingCandidates: RTCIceCandidateInit[];
}

// Describe the active camera and analysis cadence for the host room
export interface LiveCameraPublisherProps {
  sessionId: string;
  stream: MediaStream;
  recording: SessionRecording;
  onEnded(): void;
}

// Send the camera feed to attendees while separate windows update the thread
export function LiveCameraPublisher({ sessionId, stream, recording, onEnded }: LiveCameraPublisherProps) {
  const preview = useRef<HTMLVideoElement>(null);
  const peers = useRef(new Map<string, PeerConnectionEntry>());
  const signaling = useRef<WebSocket | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const transcription = useRef<LiveCapture | null>(null);
  const uploadQueue = useRef(Promise.resolve());
  const segmentIndex = useRef(0);
  const segmentStartedAt = useRef(0);
  const liveStartedAt = useRef(0);
  const stopRequested = useRef(false);
  const heartbeat = useRef<Promise<unknown>>(Promise.resolve());
  const finalSegmentStopped = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  // Ignore delayed provider setup and callbacks after this camera capture ends
  const transcriptionGeneration = useRef(0);
  const [socketConnected, setSocketConnected] = useState(false);
  const [attendeeCount, setAttendeeCount] = useState(0);
  const [secondsLive, setSecondsLive] = useState(0);
  const [isEnding, setIsEnding] = useState(false);
  const [error, setError] = useState('');
  const [transcriptionStatus, setTranscriptionStatus] = useState<'connecting' | 'ready' | 'failed'>('connecting');
  const [transcriptionError, setTranscriptionError] = useState('');

  useEffect(() => {
    mounted.current = true;
    stopRequested.current = false;
    segmentIndex.current = 0;
    const captureGeneration = ++transcriptionGeneration.current;
    liveStartedAt.current = Date.now();
    segmentStartedAt.current = performance.now();
    if (preview.current) preview.current.srcObject = stream;

    // Share the same camera audio with the transcript while the room video stays live
    void connectLiveTranscription(sessionId, stream, (event: LiveSpeechEvent) => {
      if (!mounted.current || captureGeneration !== transcriptionGeneration.current) return;
      if (event.type === 'ready' || (event.type === 'connection' && event.state === 'ready')) {
        setTranscriptionStatus('ready');
        setTranscriptionError('');
      }
      if (event.type === 'connection' && event.state === 'reconnecting') setTranscriptionStatus('connecting');
      if (event.type === 'error') {
        setTranscriptionStatus('failed');
        setTranscriptionError(event.message);
      }
    }).then((capture) => {
      if (!mounted.current || captureGeneration !== transcriptionGeneration.current) {
        void capture.stop();
        return;
      }
      transcription.current = capture;
    }).catch((captureError: unknown) => {
      if (!mounted.current || captureGeneration !== transcriptionGeneration.current) return;
      setTranscriptionStatus('failed');
      setTranscriptionError(captureError instanceof Error ? captureError.message : 'The transcript couldn’t connect. Check your microphone and try again.');
    });

    // Keep the camera stream in the room while each analysis copy uploads separately
    // Retry a source window in order without holding live captions or video
    async function uploadWindowUntilDelivered(index: number, media: Blob): Promise<void> {
      let delayMs = 500;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await uploadLiveWindow(sessionId, index, media);
          return;
        } catch {
          await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
          delayMs = Math.min(delayMs * 2, 15_000);
        }
      }
      throw new Error('Visual upload unavailable');
    }

    function startSegment(): void {
      if (stopRequested.current) return;
      const supportedType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find((type) => MediaRecorder.isTypeSupported(type));
      const active = new MediaRecorder(stream, supportedType ? { mimeType: supportedType } : undefined);
      const parts: Blob[] = [];
      active.ondataavailable = (event) => {
        if (event.data.size > 0) parts.push(event.data);
      };
      active.onstop = () => {
        const media = new Blob(parts, { type: active.mimeType || 'video/webm' });
        if (media.size > 0) {
          const index = segmentIndex.current;
          segmentIndex.current += 1;
          uploadQueue.current = uploadQueue.current
            .catch(() => undefined)
            .then(() => uploadWindowUntilDelivered(index, media))
            .catch(() => { if (mounted.current) setError('Visual updates could not be uploaded. The camera and transcript continue.'); });
        }
        if (stopRequested.current) {
          finalSegmentStopped.current?.();
          finalSegmentStopped.current = null;
          return;
        }
        segmentStartedAt.current = performance.now();
        startSegment();
      };
      recorder.current = active;
      active.start(1_000);
    }

    const onSocketEvent = (event: Parameters<Parameters<typeof connectLiveMedia>[2]>[0]) => {
      if (event.type === 'peer_joined') {
        void connectPeer(event.peerId);
        return;
      }
      if (event.type === 'peer_left') {
        peers.current.get(event.peerId)?.peer.close();
        peers.current.delete(event.peerId);
        setAttendeeCount(peers.current.size);
        return;
      }
      if (event.type === 'signal' && event.peerId) {
        void receivePeerSignal(event.peerId, event.signal);
      }
    };

    // Create a direct media path for each attendee without relaying video through the API
    async function connectPeer(peerId: string): Promise<void> {
      if (peers.current.has(peerId)) return;
      const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      const entry: PeerConnectionEntry = { peer, signalQueue: Promise.resolve(), pendingCandidates: [] };
      peers.current.set(peerId, entry);
      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      peer.onicecandidate = (event) => {
        if (event.candidate && signaling.current) {
          sendLiveSignal(signaling.current, {
            type: 'ice',
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment
          }, peerId);
        }
      };
      peer.onconnectionstatechange = () => setAttendeeCount(
        [...peers.current.values()].filter((connection) => connection.peer.connectionState === 'connected').length
      );
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (offer.sdp && signaling.current) sendLiveSignal(signaling.current, { type: 'offer', sdp: offer.sdp }, peerId);
    }

    // Apply peer answers and candidates in the order they arrive
    async function receivePeerSignal(peerId: string, signal: LivePeerSignal): Promise<void> {
      let entry = peers.current.get(peerId);
      if (!entry && signal.type === 'offer') {
        await connectPeer(peerId);
        entry = peers.current.get(peerId);
      }
      if (!entry) return;
      entry.signalQueue = entry.signalQueue.then(async () => {
        if (signal.type === 'answer') {
          await entry!.peer.setRemoteDescription(signal);
          for (const candidate of entry!.pendingCandidates.splice(0)) await entry!.peer.addIceCandidate(candidate);
        } else if (signal.type === 'ice') {
          if (entry!.peer.remoteDescription) await entry!.peer.addIceCandidate(signal);
          else entry!.pendingCandidates.push(signal);
        }
      }).catch(() => {
        if (mounted.current) setError('An attendee’s video connection needs to reconnect.');
      });
    }

    const connection = connectLiveMedia(sessionId, 'host', onSocketEvent, (connected) => {
      setSocketConnected(connected);
      if (!connected && mounted.current) setError('Reconnecting to the room…');
    });
    signaling.current = connection.socket;
    startSegment();
    let sendingClock = false;
    const clock = window.setInterval(() => {
      if (!sendingClock && !stopRequested.current) {
        sendingClock = true;
        heartbeat.current = updateRecordingPlayback(sessionId, Date.now() - liveStartedAt.current, true)
          .catch(() => { if (mounted.current) setError('The room clock could not update. Check your connection.'); })
          .finally(() => { sendingClock = false; });
      }
      setSecondsLive(Math.floor((Date.now() - liveStartedAt.current) / 1_000));
      transcription.current?.setPosition(Date.now() - liveStartedAt.current);
      const intervalMs = recording.analysisWindowMinutes * 60_000;
      if (!stopRequested.current && performance.now() - segmentStartedAt.current >= intervalMs
        && recorder.current?.state === 'recording') recorder.current.stop();
    }, 500);

    return () => {
      mounted.current = false;
      transcriptionGeneration.current += 1;
      window.clearInterval(clock);
      void transcription.current?.stop();
      transcription.current = null;
      stopRequested.current = true;
      const active = recorder.current;
      if (active?.state === 'recording') {
        active.onstop = null;
        active.stop();
      }
      for (const entry of peers.current.values()) entry.peer.close();
      peers.current.clear();
      connection.close();
      signaling.current = null;
      for (const track of stream.getTracks()) track.stop();
    };
  }, [recording.analysisWindowMinutes, sessionId, stream]);

  // Stop live speech and video without waiting for the separate visual queue
  async function endLiveSession(): Promise<void> {
    if (isEnding) return;
    setIsEnding(true);
    setError('');
    stopRequested.current = true;
    await transcription.current?.stop();
    transcription.current = null;
    await new Promise<void>((resolve) => {
      // Queue the final camera window before stopping the room
      const active = recorder.current;
      if (!active || active.state !== 'recording') {
        resolve();
        return;
      }
      finalSegmentStopped.current = resolve;
      active.stop();
    });
    try {
      await heartbeat.current;
      await stopLiveCapture(sessionId);
      onEnded();
    } catch {
      setError('The session didn’t end. Try again.');
      setIsEnding(false);
    }
  }

  const intervalSeconds = recording.analysisWindowMinutes * 60;
  const nextUpdateSeconds = Math.max(0, intervalSeconds - (secondsLive % intervalSeconds));
  const minutesUntilUpdate = String(Math.floor(nextUpdateSeconds / 60)).padStart(2, '0');
  const secondsUntilUpdate = String(nextUpdateSeconds % 60).padStart(2, '0');

  return (
    <section className="presenter-media-stage live-camera-stage" aria-labelledby="live-camera-title">
      <div className="presenter-media-heading">
        <div>
          <p className="eyebrow">Your room</p>
          <h2 id="live-camera-title">Live now</h2>
        </div>
        <p className="presenter-media-clock" role="status">
          {socketConnected ? `${attendeeCount} ${attendeeCount === 1 ? 'attendee' : 'attendees'} connected` : 'Connecting your room'}
        </p>
      </div>
      <video ref={preview} className="presenter-media-element presenter-camera-preview" autoPlay muted playsInline aria-label="Your live camera view" />
      <div className="live-camera-status" aria-live="polite">
        <span>{recording.analysisState === 'analyzing'
          ? 'Updating topic threads'
          : `Next topic update in ${minutesUntilUpdate}:${secondsUntilUpdate}`}</span>
        <span>{transcriptionStatus === 'ready' ? 'Transcript is live' : transcriptionStatus === 'connecting' ? 'Starting transcript' : secondsLive > 0 ? `Live for ${Math.floor(secondsLive / 60)}:${String(secondsLive % 60).padStart(2, '0')}` : 'Camera is live'}</span>
      </div>
      {error && <p className="inline-error" role="status">{error}</p>}
      {transcriptionError && <p className="inline-error" role="alert">{transcriptionError}</p>}
      <p className="recording-source-copy">Attendees see your camera live. The transcript updates as you speak; topic threads and selected frames update every {recording.analysisWindowMinutes} {recording.analysisWindowMinutes === 1 ? 'minute' : 'minutes'}.</p>
      <div className="presenter-playback-actions">
        <button className="button button-dark" type="button" disabled={isEnding} onClick={() => void endLiveSession()}>
          {isEnding ? 'Ending session…' : 'End session'}
        </button>
      </div>
    </section>
  );
}
