import { useEffect, useRef, useState } from 'react';

import { connectLiveMedia, sendLiveSignal, type LiveMediaEvent, type LivePeerSignal } from '../sessions/public';

// Render the host's WebRTC camera stream inside the attendee room
export interface LiveCameraViewerProps {
  sessionId: string;
}

// Show the room camera as it arrives without waiting for thread analysis
export function LiveCameraViewer({ sessionId }: LiveCameraViewerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const signaling = useRef<WebSocket | null>(null);
  const peer = useRef<RTCPeerConnection | null>(null);
  // Preserve host offer and ICE candidate arrival order during negotiation
  const signalQueue = useRef(Promise.resolve());
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const active = useRef(true);
  const [hostLive, setHostLive] = useState(false);
  const [hasPicture, setHasPicture] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);

  useEffect(() => {
    active.current = true;
    let connection: ReturnType<typeof connectLiveMedia> | undefined;
    let reconnectTimer: number | undefined;
    let shouldReconnect = true;

    // Clear the attendee video and peer when the host disconnects
    function closePeer(clearPendingCandidates = true): void {
      peer.current?.close();
      peer.current = null;
      if (clearPendingCandidates) pendingCandidates.current = [];
      setHasPicture(false);
      if (video.current) video.current.srcObject = null;
    }

    // Apply one host offer and return this attendee's camera receiver
    async function handleSignal(signal: LivePeerSignal): Promise<void> {
      if (signal.type === 'ice') {
        if (!peer.current?.remoteDescription) pendingCandidates.current.push(signal);
        else await peer.current.addIceCandidate(signal);
        return;
      }
      if (signal.type !== 'offer') return;
      // Keep candidates received before this replacement offer
      closePeer(false);
      const nextPeer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      peer.current = nextPeer;
      nextPeer.ontrack = (event) => {
        const media = event.streams[0];
        if (!media || !video.current) return;
        video.current.srcObject = media;
        setHasPicture(true);
        void video.current.play().catch(() => undefined);
      };
      nextPeer.onicecandidate = (event) => {
        if (event.candidate && signaling.current) sendLiveSignal(signaling.current, {
          type: 'ice',
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment
        });
      };
      await nextPeer.setRemoteDescription(signal);
      for (const candidate of pendingCandidates.current.splice(0)) await nextPeer.addIceCandidate(candidate);
      const answer = await nextPeer.createAnswer();
      await nextPeer.setLocalDescription(answer);
      if (answer.sdp && signaling.current) sendLiveSignal(signaling.current, { type: 'answer', sdp: answer.sdp });
    }

    // Keep one attendee peer and reconnect signaling after a brief network drop
    function openSignaling(): void {
      if (!shouldReconnect || !active.current) return;
      connection = connectLiveMedia(sessionId, 'attendee', (event: LiveMediaEvent) => {
        if (event.type === 'host_status') {
          setHostLive(event.live);
          if (!event.live) closePeer();
        }
        if (event.type === 'signal') {
          signalQueue.current = signalQueue.current.then(() => handleSignal(event.signal)).catch(() => {
            if (active.current) closePeer();
          });
        }
      }, (connected) => {
        if (!connected && shouldReconnect && active.current) {
          setHostLive(false);
          closePeer();
          reconnectTimer = window.setTimeout(openSignaling, 1_500);
        }
      });
      signaling.current = connection.socket;
    }

    openSignaling();
    return () => {
      active.current = false;
      shouldReconnect = false;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      closePeer();
      connection?.close();
      signaling.current = null;
    };
  }, [sessionId]);

  return (
    <div className="stream-player-wrap live-camera-viewer">
      <video
        ref={video}
        className="attendee-media"
        autoPlay
        playsInline
        muted={!soundEnabled}
        aria-label="Live camera stream"
      />
      {!hasPicture && (
        <div className="live-camera-placeholder" role="status">
          {hostLive ? 'Connecting to the presenter’s camera…' : 'The presenter hasn’t started the camera yet.'}
        </div>
      )}
      <div className="stream-controls">
        <span>{hasPicture ? 'Live camera' : hostLive ? 'Connecting to the camera' : 'Waiting for the presenter'}</span>
        <div className="stream-control-actions">
          <button className="text-action" type="button" onClick={() => setSoundEnabled((enabled) => !enabled)}>
            {soundEnabled ? 'Mute sound' : 'Turn sound on'}
          </button>
        </div>
      </div>
    </div>
  );
}
