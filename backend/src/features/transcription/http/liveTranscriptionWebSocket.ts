import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { LiveTranscriptionCoordinator } from '../application/liveTranscriptionCoordinator';

// Validate control shapes separately from binary mono PCM frames
const controlSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('position'),
      positionMs: z.number().int().nonnegative()
    })
    .strict(),
  z.object({ type: z.literal('stop') }).strict()
]);
// Define the persisted source clock used to validate browser updates
export interface RecordingClock {
  positionMs: number;
  durationMs: number;
  analysisWindowMinutes: number;
}
// Define source validation and released-caption refresh hooks
export interface TranscriptionGatewayOptions {
  allowedOrigins: ReadonlySet<string>;
  getRecordingClock(id: string): Promise<RecordingClock | null>;
  refreshTopics(id: string): void;
}
// Reject untrusted upgrades before opening a provider connection
function reject(socket: Duplex, status: number) {
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
}
// Attach one validated capture per playing room and flush writes before refresh
export function attachLiveTranscriptionWebSocket(
  server: Server,
  coordinator: LiveTranscriptionCoordinator,
  options: TranscriptionGatewayOptions
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8192,
    perMessageDeflate: false
  });
  const reserved = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  const track = (promise: Promise<unknown>) => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => undefined);
  };
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const id = /^\/api\/live\/([A-F0-9]{8})\/transcription$/.exec(
      (req.url ?? '').split('?')[0]!
    )?.[1];
    if (!id) {
      reject(socket, 404);
      return;
    }
    if (
      !req.headers.origin ||
      !options.allowedOrigins.has(req.headers.origin)
    ) {
      reject(socket, 403);
      return;
    }
    if (closing || reserved.has(id)) {
      reject(socket, 409);
      return;
    }
    reserved.add(id);
    let connected = false;
    let released = false;
    // Release only this attempt's reservation, including aborted handshakes
    const release = () => {
      if (released) return;
      released = true;
      reserved.delete(id);
    };
    const abortPending = () => {
      if (connected) return;
      release();
      socket.destroy();
    };
    socket.once('close', abortPending);
    socket.once('end', abortPending);
    socket.once('error', abortPending);
    track(
      options
        .getRecordingClock(id)
        .then((clock) => {
          if (closing || socket.destroyed || !clock) {
            release();
            reject(socket, 404);
            return;
          }
          wss.handleUpgrade(req, socket, head, (client) => {
            connected = true;
            connect(client, id, clock, release);
          });
        })
        .catch(() => {
          release();
          reject(socket, 503);
        })
    );
  };
  function connect(
    client: WebSocket,
    id: string,
    clock: RecordingClock,
    release: () => void
  ) {
    let capture:
      | Awaited<ReturnType<LiveTranscriptionCoordinator['start']>>
      | undefined;
    let stopRequested = false;
    let stopping: Promise<void> | undefined;
    let lastPosition = clock.positionMs;
    let hasSourceAnchor = false;
    let boundary = Math.floor(
      lastPosition / (clock.analysisWindowMinutes * 60_000)
    );
    let controls = Promise.resolve();
    const send = (value: unknown) => {
      if (client.readyState === WebSocket.OPEN)
        client.send(JSON.stringify(value));
    };
    const stop = () => {
      stopRequested = true;
      if (!capture) return Promise.resolve();
      if (!stopping) {
        stopping = capture
          .stop()
          .then(() => {
            options.refreshTopics(id);
          })
          .finally(release);
        track(stopping);
      }
      return stopping;
    };
    const fail = () => {
      send({
        type: 'error',
        message:
          'The transcript connection stopped. Pause and resume the recording to retry.'
      });
      void stop()
        .finally(() => client.close(1008, 'Invalid transcript update'))
        .catch(() => undefined);
    };
    client.on('error', () => {
      void stop().catch(() => undefined);
    });
    client.on('close', () => {
      void stop().catch(() => undefined);
    });
    track(
      coordinator
        .start(id, clock.positionMs, (event) => {
          send(event);
          if (event.type === 'error' && !event.retryable) {
            stopRequested = true;
            if (capture)
              void stop()
                .finally(() => client.close(1011, 'Transcription interrupted'))
                .catch(() => undefined);
          }
        })
        .then(async (started) => {
          capture = started;
          if (
            stopRequested ||
            closing ||
            client.readyState !== WebSocket.OPEN
          ) {
            await stop();
            client.close();
            return;
          }
          send({ type: 'ready' });
        })
        .catch(() => {
          send({
            type: 'error',
            message:
              'The transcript could not connect. Check backend configuration, then pause and resume to retry.'
          });
          release();
          client.close(1011, 'Transcription unavailable');
        })
    );
    client.on('message', (data, binary) => {
      if (stopRequested || !capture) return;
      if (binary) {
        const audio = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        if (!audio.length || audio.length > 6400 || audio.length % 2) {
          fail();
          return;
        }
        try {
          capture.sendAudio(audio);
        } catch {
          fail();
        }
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        fail();
        return;
      }
      const parsed = controlSchema.safeParse(value);
      if (!parsed.success) {
        fail();
        return;
      }
      const message = parsed.data;
      if (message.type === 'stop') {
        stopRequested = true;
        track(
          controls
            .then(stop)
            .then(() => {
              send({ type: 'stopped' });
              client.close(1000, 'Stopped');
            })
            .catch(fail)
        );
        return;
      }
      // Preserve source-clock order across asynchronous persisted-state checks
      controls = controls
        .then(async () => {
          const current = await options.getRecordingClock(id);
          if (
            !current ||
            (hasSourceAnchor && message.positionMs < lastPosition) ||
            message.positionMs > current.durationMs ||
            Math.abs(message.positionMs - current.positionMs) > 5000
          ) {
            fail();
            return;
          }
          // Accept the first actual media clock despite setup delay in the projected server clock
          hasSourceAnchor = true;
          lastPosition = message.positionMs;
          capture?.setPosition(message.positionMs);
          const next = Math.floor(
            lastPosition / (clock.analysisWindowMinutes * 60_000)
          );
          if (next > boundary) {
            boundary = next;
            await capture?.flush();
            options.refreshTopics(id);
          }
        })
        .catch(fail);
    });
  }
  server.on('upgrade', upgrade);
  return {
    async close() {
      closing = true;
      server.off('upgrade', upgrade);
      for (const client of wss.clients) client.terminate();
      await Promise.allSettled([...pending]);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  };
}
