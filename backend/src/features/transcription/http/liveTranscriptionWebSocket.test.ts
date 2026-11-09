import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { LiveTranscriptionCoordinator } from '../application/liveTranscriptionCoordinator';
import { attachLiveTranscriptionWebSocket } from './liveTranscriptionWebSocket';
const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0)) await close();
});
async function fixture(positionMs = 1250) {
  const capture = {
    sendAudio: vi.fn(),
    setPosition: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined)
  };
  const start = vi.fn().mockResolvedValue(capture);
  const refreshTopics = vi.fn();
  const getRecordingClock = vi.fn().mockResolvedValue({
    positionMs,
    durationMs: 180000,
    analysisWindowMinutes: 1
  });
  const server = createServer();
  const gateway = attachLiveTranscriptionWebSocket(
    server,
    { start } as unknown as LiveTranscriptionCoordinator,
    {
      allowedOrigins: new Set(['http://127.0.0.1:5185']),
      getRecordingClock,
      refreshTopics
    }
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  resources.push(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `ws://127.0.0.1:${address.port}/api/live/AB12CD34/transcription`;
  const open = async () => {
    const socket = new WebSocket(url, { origin: 'http://127.0.0.1:5185' });
    const messages: string[] = [];
    socket.on('message', (data) => messages.push(data.toString()));
    await new Promise<void>((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    await vi.waitFor(() =>
      expect(
        messages.some(
          (value) => value.includes('ready') || value.includes('error')
        )
      ).toBe(true)
    );
    return { socket, messages };
  };
  return { capture, start, getRecordingClock, refreshTopics, url, open, server };
}
async function rejection(url: string, origin: string) {
  return new Promise<number | undefined>((resolve) => {
    const socket = new WebSocket(url, { origin });
    socket.on('error', () => undefined);
    socket.on('unexpected-response', (_req, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode);
    });
  });
}
describe('source transcription gateway', () => {
  it('releases the room after a malformed WebSocket handshake', async () => {
    const f = await fixture();
    const url = new URL(f.url);
    const status = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(Number(url.port), url.hostname, () => {
        socket.write(
          `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: http://127.0.0.1:5185\r\nSec-WebSocket-Key: invalid\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      let response = '';
      socket.on('data', (data) => {
        response += data.toString();
      });
      socket.on('end', () => resolve(response.split('\r\n')[0]!));
      socket.on('error', reject);
    });
    expect(status).toContain('400');
    const { socket } = await f.open();
    expect(f.start).toHaveBeenCalledOnce();
    socket.close();
  });
  it('releases a disconnected pending handshake without clearing a replacement reservation', async () => {
    const f = await fixture();
    let release!: (clock: {
      positionMs: number;
      durationMs: number;
      analysisWindowMinutes: number;
    }) => void;
    f.getRecordingClock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const disconnected = new Promise<void>((resolve) => {
      f.server.once('upgrade', (_req, socket) => socket.once('close', resolve));
    });
    const abandoned = new WebSocket(f.url, { origin: 'http://127.0.0.1:5185' });
    abandoned.on('error', () => undefined);
    await vi.waitFor(() => expect(f.getRecordingClock).toHaveBeenCalledOnce());
    abandoned.terminate();
    try {
      await disconnected;
      const { socket } = await f.open();
      release({
        positionMs: 1250,
        durationMs: 180000,
        analysisWindowMinutes: 1
      });
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
      expect(await rejection(f.url, 'http://127.0.0.1:5185')).toBe(409);
      socket.close();
    } finally {
      release({
        positionMs: 1250,
        durationMs: 180000,
        analysisWindowMinutes: 1
      });
    }
  });
  it('validates origins and room existence before provider allocation', async () => {
    const f = await fixture();
    expect(await rejection(f.url, 'https://untrusted.example')).toBe(403);
    f.getRecordingClock.mockResolvedValueOnce(null);
    expect(await rejection(f.url, 'http://127.0.0.1:5185')).toBe(404);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('forwards PCM and source positions, then flushes before forcing topic refresh', async () => {
    const f = await fixture();
    const { socket, messages } = await f.open();
    socket.send(JSON.stringify({ type: 'position', positionMs: 2500 }));
    socket.send(Buffer.alloc(3200));
    await vi.waitFor(() =>
      expect(f.capture.setPosition).toHaveBeenCalledWith(2500)
    );
    expect(f.capture.sendAudio).toHaveBeenCalledWith(Buffer.alloc(3200));
    socket.send(JSON.stringify({ type: 'stop' }));
    await vi.waitFor(() => expect(messages).toContain('{"type":"stopped"}'));
    expect(f.capture.stop.mock.invocationCallOrder[0]).toBeLessThan(
      f.refreshTopics.mock.invocationCallOrder[0]!
    );
  });
  it('waits for relevant caption writes at interval boundaries', async () => {
    const f = await fixture(59000);
    const { socket } = await f.open();
    let release!: () => void;
    f.capture.flush.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    socket.send(JSON.stringify({ type: 'position', positionMs: 60000 }));
    await vi.waitFor(() => expect(f.capture.flush).toHaveBeenCalledOnce());
    expect(f.refreshTopics).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(f.refreshTopics).toHaveBeenCalledOnce());
    socket.close();
  });
  it.each([
    Buffer.alloc(1),
    Buffer.alloc(6402),
    '{"type":"position","positionMs":999999}',
    '{"type":"position","positionMs":0,"extra":true}'
  ])('rejects malformed or out-of-source updates', async (value) => {
    const f = await fixture();
    const { socket, messages } = await f.open();
    socket.send(value);
    await vi.waitFor(() =>
      expect(messages.some((value) => value.includes('error'))).toBe(true)
    );
    expect(f.capture.sendAudio).not.toHaveBeenCalled();
  });
  it('hides provider failures and prevents a second active capture', async () => {
    const f = await fixture();
    const { socket } = await f.open();
    expect(await rejection(f.url, 'http://127.0.0.1:5185')).toBe(409);
    socket.close();
    await vi.waitFor(() => expect(f.capture.stop).toHaveBeenCalled());
    f.start.mockRejectedValueOnce(new Error('SYNTHETIC_PROVIDER_SECRET'));
    const failed = await f.open();
    expect(failed.messages.join('')).not.toContain('SYNTHETIC_PROVIDER_SECRET');
    expect(failed.messages.join('')).toContain('could not connect');
  });
});
it('accepts an initial browser clock slightly behind the projected server anchor, then rejects backward updates', async () => {
  const f = await fixture();
  const { socket, messages } = await f.open();
  socket.send(JSON.stringify({ type: 'position', positionMs: 1200 }));
  await vi.waitFor(() =>
    expect(f.capture.setPosition).toHaveBeenCalledWith(1200)
  );
  socket.send(JSON.stringify({ type: 'position', positionMs: 1100 }));
  await vi.waitFor(() =>
    expect(messages.some((value) => value.includes('error'))).toBe(true)
  );
});
