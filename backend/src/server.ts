import { CameraService, attachLiveMediaWebSocket } from './features/sessions/public';
import { VisualMomentService, PrismaVisualMomentRepository } from './features/sessions/public';
import { LocalVisualAssetStore } from './platform/media/localVisualAssets';
import { createGeminiVisualMomentAnalyzer } from './platform/ai/geminiVisualMomentAnalyzer';
import { createVisualMomentTelemetry } from './platform/telemetry/visualMomentTelemetry';
import type { Server } from 'node:http';
import { ElasticsearchCaptionIndex, ElasticsearchMaterialIndex } from './features/search/public';
import { ReleasedContentRepository, SessionIndexingWorker, SearchUnavailableError } from './features/sessions/public';
import { MaterialService, PrismaMaterialRepository, createMaterialBackgroundProvider } from './features/sessions/public';
import { extractPdfText } from './platform/media/pdfText';
import { PrivateChatService } from './features/private-chat/public';
import { createGeminiAnswerGenerator } from './platform/ai/geminiAnswerGenerator';
import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { logger } from './platform/logging/logger';
import { shutdownTelemetry } from './platform/telemetry/instrumentation';
import { SessionEventHub } from './features/sessions/application/sessionEventHub';
import { RoomService, RecordingService } from './features/sessions/public';
import { PrismaRoomRepository } from './features/sessions/persistence/prismaRoomRepository';
import { PrismaSessionRepository } from './features/sessions/persistence/prismaSession.repository';
import { TopicAnalysisWorker } from './features/sessions/application/topicAnalysisWorker';
import { createGeminiTopicAnalyzer } from './platform/ai/geminiTopicAnalyzer';
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
const search = new ElasticsearchCaptionIndex();
// Index presenter material separately from released captions
const materialSearch = new ElasticsearchMaterialIndex();
const content = new ReleasedContentRepository(prisma);
const indexing = new SessionIndexingWorker(content, search, 1_500, materialSearch);
const materialRepository = new PrismaMaterialRepository(prisma);
// Store presenter notes and PDFs as passages and queue their indexing
const materials = new MaterialService({ repository: materialRepository, extractPdf: extractPdfText, indexer: indexing });
const privateChat = new PrivateChatService({
  sessions: {
    getReleasedCaptions: async id => (await content.getReleasedContent(id)).captions,
    searchReleasedCaptions: async (id, query, allowedCaptionIds) => {
      try { return await search.findReleasedCaptions(id, query, allowedCaptionIds); }
      catch { throw new SearchUnavailableError(); }
    }
  },
  materials: {
    getReadyPassageIds: id => materialRepository.getReadyPassageIds(id),
    getReadyPassagesByIds: (id, ids) => materialRepository.getReadyPassagesByIds(id, ids),
    searchPassages: (id, query, allowedPassageIds) => materialSearch.findPassages(id, query, allowedPassageIds, 5)
  },
  generateAnswer: env.GEMINI_API_KEY ? createGeminiAnswerGenerator() : undefined
});
const repository = new PrismaRoomRepository(prisma);
const events = new SessionEventHub();
const sessions = new RoomService({ repository, events });
// Group released speech into topics only when a backend AI credential is available
const topicWorker = env.GEMINI_API_KEY?.trim()
  ? new TopicAnalysisWorker(
      new PrismaSessionRepository(prisma),
      createGeminiTopicAnalyzer(),
      events,
      2_000,
      // Supply relevant presenter material as vocabulary, never as topic evidence
      createMaterialBackgroundProvider({
        getReadyPassageIds: id => materialRepository.getReadyPassageIds(id),
        getReadyPassagesByIds: (id, ids) => materialRepository.getReadyPassagesByIds(id, ids),
        searchPassages: (id, query, allowedPassageIds, size) => materialSearch.findPassages(id, query, allowedPassageIds, size)
      })
    )
  : { start: () => undefined, wake: async () => undefined, stop: () => undefined };
const visualMoments = new VisualMomentService({
  repository: new PrismaVisualMomentRepository(prisma), assets: new LocalVisualAssetStore(),
  analyzer: createGeminiVisualMomentAnalyzer({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_VISUAL_MODEL }),
  events, telemetry: createVisualMomentTelemetry()
});
const recordings = new RecordingService({
  repository,
  events,
  assets: new LocalRecordingAssetStore(),
  onPlaybackCommitted: id => { if (stopping) return; void visualMoments.handlePlaybackProgress(id).catch(() => logger.warn({ event: 'visual_progress_failed' })); },
  readDuration: readRecordingDuration
});
const camera = new CameraService(repository, events);
const transcription = new LiveTranscriptionCoordinator({
  provider: createGeminiLiveTranscriptionProvider({
    apiKey: env.GEMINI_API_KEY ?? '',
    model: env.GEMINI_LIVE_TRANSCRIPTION_MODEL
  }),
  publisher: sessions
});
let server: Server | undefined;
let gateway: { close(): Promise<void> } | undefined;
let mediaGateway: { close(): Promise<void> } | undefined;
let stopping = false;
let playbackWatchdog: ReturnType<typeof setInterval> | undefined;
let checkingPlayback = false;
// Stop capture and commit pending finalizations before closing persistence
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(playbackWatchdog);
  topicWorker.stop();
  await mediaGateway?.close();
  await gateway?.close();
  await indexing.stop();
  server?.close();
  server?.closeAllConnections();
  await visualMoments.waitForIdle();
  await Promise.allSettled([prisma.$disconnect(), search.close(), materialSearch.close()]);
  await shutdownTelemetry();
}
// Pause unfinished playback before advertising product routes after restart
async function start() {
  await prisma.$connect();
  await sessions.initialize();
  // Fail material intake interrupted by the previous process so presenters can retry
  await materials.initialize();
  // Resume released search work and pending topic intervals after restart
  topicWorker.start();
  indexing.start();
  const app = createApp(
    async () => {
      await Promise.all([prisma.$queryRaw`SELECT 1`, search.ping()]);
    },
    { sessions, recordings },
    { service: privateChat, context: id => content.getReleasedContent(id) },
    { visualMoments, camera, materials }
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
        (recording.durationMs !== null || recording.sourceType === 'camera')
        ? {
            positionMs: Math.min(
              recording.durationMs ?? 86_400_000,
              recording.playbackPositionMs +
                Math.max(
                  0,
                  Date.now() - Date.parse(recording.playbackUpdatedAt)
                )
            ),
            durationMs: recording.durationMs ?? 86_400_000,
            analysisWindowMinutes: recording.analysisWindowMinutes
          }
        : null;
    },
    // Freeze the requested topic range only after flushed caption writes settle
    refreshTopics: (id) => void topicWorker.wake(true, id)
  });
  mediaGateway = attachLiveMediaWebSocket(server, {
    allowedOrigins: new Set(env.WEB_ORIGINS.split(',').map(origin => new URL(origin.trim()).origin)),
    sessionExists: async id => {
      const source = await repository.getRecording(id);
      return source?.sourceType === 'camera' && source.status === 'ready' && source.isPlaying;
    },
    onHostDisconnected: async id => { if (!stopping) await camera.stopLiveCapture(id); }
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
