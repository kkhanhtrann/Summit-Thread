// Describe a bounded WebRTC offer, answer, or ICE message
export type LivePeerSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment?: string | null };

// Describe room presence and peer messages returned by the signaling relay
export type LiveMediaEvent =
  | { type: 'ready'; peerId?: string }
  | { type: 'host_status'; live: boolean }
  | { type: 'peer_joined' | 'peer_left'; peerId: string }
  | { type: 'signal'; peerId?: string; signal: LivePeerSignal };

// Keep the camera room's peer negotiation on the same origin as its invite link
function liveMediaUrl(sessionId: string, role: 'host' | 'attendee'): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/api/live-media/${encodeURIComponent(sessionId)}?role=${role}`;
}

// Connect one room participant to the backend's signaling relay
export function connectLiveMedia(
  sessionId: string,
  role: 'host' | 'attendee',
  onEvent: (event: LiveMediaEvent) => void,
  onConnectionChange: (connected: boolean) => void
): { socket: WebSocket; close(): void } {
  const socket = new WebSocket(liveMediaUrl(sessionId, role));
  socket.onopen = () => onConnectionChange(true);
  socket.onclose = () => onConnectionChange(false);
  socket.onerror = () => onConnectionChange(false);
  socket.onmessage = (message) => {
    try {
      onEvent(JSON.parse(String(message.data)) as LiveMediaEvent);
    } catch {
      onConnectionChange(false);
    }
  };

  return {
    socket,
    close() {
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    }
  };
}

// Send one bounded peer description only while the signaling socket is open
export function sendLiveSignal(socket: WebSocket, signal: LivePeerSignal, peerId?: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'signal', signal, ...(peerId ? { peerId } : {}) }));
}
