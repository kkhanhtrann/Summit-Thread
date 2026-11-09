import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { attachLiveMediaWebSocket } from './liveMediaWebSocket';
import { attachLiveTranscriptionWebSocket } from '../../transcription/public';

// Await one bounded signaling message without using camera hardware
function receive(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Signaling timed out')), 2000);
    socket.once('message', data => { clearTimeout(timer); resolve(JSON.parse(data.toString()) as Record<string, unknown>); });
  });
}

describe('camera signaling', () => {
  it('coexists with speech upgrades and relays signals only within the selected room', async () => {
    const server = createServer();
    const speech = attachLiveTranscriptionWebSocket(server, {} as never, { allowedOrigins: new Set(), getRecordingClock: async () => null, refreshTopics: () => undefined });
    const disconnected = vi.fn().mockResolvedValue(undefined);
    const gateway = attachLiveMediaWebSocket(server, { allowedOrigins: new Set(['http://localhost:5185']), sessionExists: async id => id === 'AB12CD34', onHostDisconnected: disconnected });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const url = `ws://127.0.0.1:${address.port}/api/live-media/AB12CD34`;
    const host = new WebSocket(`${url}?role=host`, { origin: 'http://localhost:5185' });
    const hostReady = receive(host);
    await expect(hostReady).resolves.toMatchObject({ type: 'ready' });
    const joined = receive(host);
    const attendee = new WebSocket(`${url}?role=attendee`, { origin: 'http://localhost:5185' });
    const presence = receive(attendee);
    await expect(presence).resolves.toMatchObject({ type: 'host_status', live: true });
    const peer = await joined;
    const offer = receive(attendee);
    host.send(JSON.stringify({ type: 'signal', peerId: peer.peerId, signal: { type: 'offer', sdp: 'synthetic-offer' } }));
    // The attendee's ready acknowledgement can precede its offer
    const first = await offer;
    const delivered = first.type === 'ready' ? await receive(attendee) : first;
    expect(delivered).toMatchObject({ type: 'signal', signal: { sdp: 'synthetic-offer' } });
    const answer = receive(host);
    attendee.send(JSON.stringify({ type: 'signal', signal: { type: 'answer', sdp: 'synthetic-answer' } }));
    await expect(answer).resolves.toMatchObject({ type: 'signal', peerId: peer.peerId, signal: { sdp: 'synthetic-answer' } });
    attendee.terminate(); host.terminate();
    await gateway.close(); await speech.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
});
