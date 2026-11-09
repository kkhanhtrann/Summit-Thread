import type { Server } from 'node:http';
import { Client } from '@elastic/elasticsearch';
import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { logger } from './platform/logging/logger';
import { shutdownTelemetry } from './platform/telemetry/instrumentation';
import { SessionEventHub } from './features/sessions/application/sessionEventHub';
import { RoomService, RecordingService } from './features/sessions/public';
import { PrismaRoomRepository } from './features/sessions/persistence/prismaRoomRepository';
import {
  LocalRecordingAssetStore,
  readRecordingDuration
} from './platform/media/localRecordingAssets';
import {
  LiveTranscriptionCoordinator,
  attachLiveTranscriptionWebSocket
} from './features/transcription/public';
import { createGeminiLiveTranscriptionProvider } from './platform/ai/geminiLiveTranscriptionProvider';

// Compose backend infrastructure without requiring AI credentials for media playback
const search = new Client({
  node: env.ELASTICSEARCH_URL,
  requestTimeout: 2000,
  maxRetries: 0
});
const repository = new PrismaRoomRepository(prisma);
const events = new SessionEventHub();
const sessions = new RoomService({ repository, events });
const recordings = new RecordingService({
  repository,
  events,
  assets: new LocalRecordingAssetStore(),
  readDuration: readRecordingDuration
});
const transcription = new LiveTranscriptionCoordinator({
  provider: createGeminiLiveTranscriptionProvider({
    apiKey: env.GEMINI_API_KEY ?? '',
    model: env.GEMINI_LIVE_TRANSCRIPTION_MODEL
  }),
  publisher: sessions
});
let server: Server | undefined;
let gateway: { close(): Promise<void> } | undefined;
let stopping = false;
let playbackWatchdog: ReturnType<typeof setInterval> | undefined;
let checkingPlayback = false;
// Stop capture and commit pending finalizations before closing persistence
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(playbackWatchdog);
  await gateway?.close();
  server?.close();
  server?.closeAllConnections();
  await Promise.allSettled([prisma.$disconnect(), search.close()]);
  await shutdownTelemetry();
}
// Pause unfinished playback before advertising product routes after restart
async function start() {
  await prisma.$connect();
  await sessions.initialize();
  const app = createApp(
    async () => {
      await Promise.all([prisma.$queryRaw`SELECT 1`, search.ping()]);
    },
    { sessions, recordings }
  );
  server = app.listen(env.API_PORT, env.API_HOST, () =>
    logger.info({
      event: 'server_started',
      host: env.API_HOST,
      port: env.API_PORT
    })
  );
  gateway = attachLiveTranscriptionWebSocket(server, transcription, {
    allowedOrigins: new Set(
      env.WEB_ORIGINS.split(',').map((origin) => new URL(origin.trim()).origin)
    ),
    getRecordingClock: async (id) => {
      const recording = await repository.getRecording(id);
      return recording?.status === 'ready' &&
        recording.isPlaying &&
        recording.durationMs !== null
        ? {
            positionMs: Math.min(
              recording.durationMs,
              recording.playbackPositionMs +
                Math.max(
                  0,
                  Date.now() - Date.parse(recording.playbackUpdatedAt)
                )
            ),
            durationMs: recording.durationMs,
            analysisWindowMinutes: recording.analysisWindowMinutes
          }
        : null;
    },
    // Leave topic processing to ST-03 while preserving its flushed-caption handoff
    refreshTopics: () => undefined
  });
  playbackWatchdog = setInterval(() => {
    if (checkingPlayback) return;
    checkingPlayback = true;
    void recordings
      .pauseDisconnected()
      .catch(() => logger.info({ event: 'playback_expiry_failed' }))
      .finally(() => {
        checkingPlayback = false;
      });
  }, 5000);
  server.on('error', () => {
    logger.error({ event: 'server_listen_failed' });
    process.exitCode = 1;
    void stop();
  });
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
void start().catch(() => {
  logger.error({ event: 'server_start_failed' });
  process.exitCode = 1;
  void stop();
});
