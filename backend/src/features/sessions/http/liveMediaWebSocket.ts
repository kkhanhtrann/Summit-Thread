import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

interface LiveMediaGatewayOptions {
  allowedOrigins: ReadonlySet<string>;
  sessionExists(sessionId: string): Promise<boolean>;
  onHostDisconnected(sessionId: string): Promise<void>;
}

type PeerSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment?: string | null };

interface RoomPeers {
  host?: WebSocket;
  attendees: Map<string, WebSocket>;
}

// Reject a signaling upgrade before it consumes a WebSocket connection
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

// Send room signaling only to connected browsers
function send(socket: WebSocket | undefined, payload: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

// Validate the browser origin before allowing room signaling
function isAllowedOrigin(request: IncomingMessage, origins: ReadonlySet<string>): boolean {
  return typeof request.headers.origin === 'string' && origins.has(request.headers.origin);
}

// Accept only bounded WebRTC descriptions and ICE candidates
function readSignal(value: unknown): PeerSignal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('type' in value)) return null;
  if ((value.type === 'offer' || value.type === 'answer')
    && 'sdp' in value && typeof value.sdp === 'string' && value.sdp.length <= 64_000) {
    return { type: value.type, sdp: value.sdp };
  }
  if (value.type === 'ice' && 'candidate' in value && typeof value.candidate === 'string'
    && value.candidate.length <= 4_096 && 'sdpMid' in value && (typeof value.sdpMid === 'string' || value.sdpMid === null)
    && 'sdpMLineIndex' in value && (typeof value.sdpMLineIndex === 'number' || value.sdpMLineIndex === null)) {
    return {
      type: 'ice',
      candidate: value.candidate,
      sdpMid: value.sdpMid,
      sdpMLineIndex: value.sdpMLineIndex,
      ...('usernameFragment' in value && (typeof value.usernameFragment === 'string' || value.usernameFragment === null)
        ? { usernameFragment: value.usernameFragment }
        : {})
    };
  }
  return null;
}

// Relay camera room signaling while media flows directly between browsers
export function attachLiveMediaWebSocket(server: Server, options: LiveMediaGatewayOptions): { close(): Promise<void> } {
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 96_000, perMessageDeflate: false });
  const rooms = new Map<string, RoomPeers>();
  const pathPattern = /^\/api\/live-media\/([A-F0-9]{8})$/;

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (!requestUrl.pathname.startsWith('/api/live-media/')) return;
    const match = requestUrl.pathname.match(pathPattern);
    const sessionId = match?.[1];
    const role = requestUrl.searchParams.get('role');
    if (!sessionId || (role !== 'host' && role !== 'attendee')) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!isAllowedOrigin(request, options.allowedOrigins)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    void options.sessionExists(sessionId).then((exists) => {
      if (!exists) {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (client) => {
        webSockets.emit('connection', client, request, sessionId, role);
      });
    }).catch(() => rejectUpgrade(socket, 503, 'Service Unavailable'));
  };

  server.on('upgrade', upgrade);
  webSockets.on('connection', (client: WebSocket, _request: IncomingMessage, sessionId: string, role: 'host' | 'attendee') => {
    const room = rooms.get(sessionId) ?? { attendees: new Map<string, WebSocket>() };
    rooms.set(sessionId, room);
    const peerId = randomUUID();

    if (role === 'host') {
      room.host?.close(1012, 'Host reconnected');
      room.host = client;
      for (const attendee of room.attendees.values()) send(attendee, { type: 'host_status', live: true });
      for (const attendeeId of room.attendees.keys()) send(client, { type: 'peer_joined', peerId: attendeeId });
      send(client, { type: 'ready' });
    } else {
      room.attendees.set(peerId, client);
      send(client, { type: 'host_status', live: Boolean(room.host) });
      send(room.host, { type: 'peer_joined', peerId });
      send(client, { type: 'ready', peerId });
    }

    client.on('message', (data, isBinary) => {
      const payloadSize = Array.isArray(data) ? data.reduce((total, chunk) => total + chunk.byteLength, 0) : data.byteLength;
      if (isBinary || payloadSize > 70_000) {
        client.close(1003, 'Invalid signaling message');
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        client.close(1003, 'Invalid signaling message');
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message) || !('type' in message)) return;
      if (message.type === 'signal' && 'signal' in message) {
        const signal = readSignal(message.signal);
        if (!signal) {
          client.close(1003, 'Invalid peer signal');
          return;
        }
        if (role === 'host' && 'peerId' in message && typeof message.peerId === 'string') {
          send(room.attendees.get(message.peerId), { type: 'signal', signal });
        } else if (role === 'attendee') {
          send(room.host, { type: 'signal', peerId, signal });
        }
        return;
      }
      if (role === 'host' && message.type === 'stop') client.close(1000, 'Host ended the room');
    });

    client.on('close', () => {
      // Ignore the replaced host socket's close event after a reconnect
      if (role === 'host' && room.host === client) {
        delete room.host;
        for (const attendee of room.attendees.values()) send(attendee, { type: 'host_status', live: false });
        void options.onHostDisconnected(sessionId).catch(() => undefined);
      } else if (role === 'attendee' && room.attendees.get(peerId) === client) {
        room.attendees.delete(peerId);
        send(room.host, { type: 'peer_left', peerId });
      }
      if (!room.host && room.attendees.size === 0) rooms.delete(sessionId);
    });
  });

  return {
    async close() {
      server.off('upgrade', upgrade);
      for (const room of rooms.values()) {
        room.host?.close(1001, 'Server shutting down');
        for (const attendee of room.attendees.values()) attendee.close(1001, 'Server shutting down');
      }
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    }
  };
}
