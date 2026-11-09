import {
  Prisma,
  type PrismaClient,
  type PreparedRecording
} from '@prisma/client';
import {
  RecordingConflictError,
  RecordingNotReadyError,
  SessionNotFoundError,
  type SessionSnapshot,
  type SessionRecordingView
} from '../contracts/session.contract';
import type { RoomRepository } from '../application/roomService';
import type { RecordingRepository } from '../application/recordingService';

// Map persisted source state without leaking paths or pending analysis
function recordingView(record: PreparedRecording): SessionRecordingView {
  return {
    sourceType: record.sourceType,
    status: record.status,
    preparationStage: record.preparationStage,
    mediaKind: record.mediaKind,
    mimeType: record.mimeType,
    durationMs: record.durationMs,
    playbackPositionMs: record.playbackPositionMs,
    playbackUpdatedAt: record.playbackUpdatedAt.toISOString(),
    isPlaying: record.isPlaying,
    analysisWindowMinutes: record.analysisWindowMinutes,
    visualReviewSkippedWindowCount: record.visualReviewSkippedWindowCount,
    analysisThroughMs: record.analysisThroughMs,
    analysisState: record.analysisState,
    mediaUrl: `/api/sessions/${record.sessionId}/recording/media`
  };
}
// Serialize room mutations with a database row lock, including future feature writers
async function lockRoom(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "ConferenceSession" WHERE id = ${id} FOR UPDATE`;
  if (!rows.length) throw new SessionNotFoundError();
}
// Store released speech, revision cursors and indexing jobs in PostgreSQL
export class PrismaRoomRepository
  implements RoomRepository, RecordingRepository
{
  constructor(private readonly prisma: PrismaClient) {}
  // Insert only presenter metadata for an empty room
  async createSession(input: { id: string; title: string }) {
    await this.prisma.conferenceSession.create({
      data: {
        ...input,
        eventName: 'Conference session',
        speakerName: 'Presenter',
        contentLabel: 'Recording playback'
      }
    });
    return this.getSnapshot(input.id);
  }
  // Read one consistent released snapshot rather than mixing concurrent revisions
  getSnapshot(id: string): Promise<SessionSnapshot> {
    return this.prisma.$transaction(
      async (tx) => {
        const session = await tx.conferenceSession.findUnique({
          where: { id },
          include: { recording: true }
        });
        if (!session) throw new SessionNotFoundError();
        const captions = await tx.captionSegment.findMany({
          where: { sessionId: id, sequence: { lt: session.releasedCount } },
          orderBy: { sequence: 'asc' }
        });
        return {
          session: {
            id,
            title: session.title,
            eventName: session.eventName,
            speakerName: session.speakerName,
            contentLabel: session.contentLabel,
            revision: session.revision,
            releasedCount: session.releasedCount,
            isLive: session.isLive
          },
          captions: captions.map(({ id, sequence, timestampMs, text }) => ({
            id,
            sequence,
            timestampMs,
            text
          })),
          threads: [],
          activeOccurrenceId: null,
          suggestedQuestions: [],
          topicAnalysisSkippedCaptionCount: 0,
          recording: session.recording
            ? recordingView(session.recording)
            : null,
          visualMoments: []
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  }
  // Pause unfinished sources and fail interrupted uploads while preserving released records
  async pauseActiveSessions() {
    await this.prisma.$transaction(async (tx) => {
      const unfinished = await tx.conferenceSession.findMany({
        where: {
          OR: [
            { isLive: true },
            { recording: { isPlaying: true } },
            { recording: { status: 'preparing' } }
          ]
        },
        select: { id: true }
      });
      for (const { id } of unfinished) {
        await tx.conferenceSession.update({
          where: { id },
          data: { isLive: false, revision: { increment: 1 } }
        });
        await tx.preparedRecording.updateMany({
          where: { sessionId: id },
          data: { isPlaying: false, playbackUpdatedAt: new Date() }
        });
        await tx.preparedRecording.updateMany({
          where: { sessionId: id, status: 'preparing' },
          data: { status: 'failed', preparationStage: null }
        });
      }
    });
  }
  // Commit the final caption, release cursor, revision and index job atomically
  releaseCaption(
    id: string,
    captionId: string,
    text: string,
    timestampMs: number
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockRoom(tx, id);
      const existing = await tx.captionSegment.findUnique({
        where: { id: captionId }
      });
      const room = await tx.conferenceSession.findUniqueOrThrow({
        where: { id },
        include: { recording: true }
      });
      if (existing) {
        if (existing.sessionId !== id)
          throw new RangeError('Caption belongs to another room');
        return {
          caption: {
            id: existing.id,
            sequence: existing.sequence,
            timestampMs: existing.timestampMs,
            text: existing.text
          },
          revision: room.revision
        };
      }
      if (
        !room.isLive ||
        room.recording?.status !== 'ready' ||
        !room.recording.isPlaying
      )
        return null;
      if (
        !Number.isSafeInteger(timestampMs) ||
        timestampMs < 0 ||
        timestampMs > (room.recording.durationMs ?? 0) ||
        !text.trim() ||
        text.length > 20_000
      )
        throw new RangeError('Invalid final caption');
      const row = await tx.captionSegment.create({
        data: {
          id: captionId,
          sessionId: id,
          sequence: room.releasedCount,
          timestampMs,
          text
        }
      });
      const updated = await tx.conferenceSession.update({
        where: { id },
        data: { releasedCount: { increment: 1 }, revision: { increment: 1 } }
      });
      // Let ST-05 consume this durable port without requiring Elasticsearch for release
      await tx.searchIndexJob.create({
        data: {
          id: `caption:${captionId}`,
          sessionId: id,
          captionId,
          operation: 'index_caption'
        }
      });
      return {
        caption: {
          id: row.id,
          sequence: row.sequence,
          timestampMs: row.timestampMs,
          text: row.text
        },
        revision: updated.revision
      };
    });
  }
  // Reserve the upload before consuming bytes and reject concurrent source replacement
  beginUpload(
    id: string,
    mimeType: string,
    mediaKind: 'audio' | 'video',
    minutes: number
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockRoom(tx, id);
      const room = await tx.conferenceSession.findUniqueOrThrow({
        where: { id },
        include: { recording: true }
      });
      if (
        room.releasedCount ||
        room.isLive ||
        room.recording?.status === 'preparing'
      )
        throw new RecordingConflictError();
      const data = {
        mimeType,
        mediaKind,
        analysisWindowMinutes: minutes,
        status: 'preparing' as const,
        preparationStage: 'uploading' as const,
        durationMs: null,
        playbackPositionMs: 0,
        playbackUpdatedAt: new Date(),
        isPlaying: false
      };
      const recording = await tx.preparedRecording.upsert({
        where: { sessionId: id },
        create: { sessionId: id, ...data },
        update: data
      });
      const roomUpdate = await tx.conferenceSession.update({
        where: { id },
        data: { revision: { increment: 1 } }
      });
      return {
        recording: recordingView(recording),
        revision: roomUpdate.revision
      };
    });
  }
  // Publish readiness only after source validation has completed
  finishUpload(id: string, durationMs: number | null) {
    return this.prisma.$transaction(async (tx) => {
      await lockRoom(tx, id);
      const recording = await tx.preparedRecording.update({
        where: { sessionId: id },
        data: {
          durationMs,
          status: durationMs === null ? 'failed' : 'ready',
          preparationStage: null
        }
      });
      const room = await tx.conferenceSession.update({
        where: { id },
        data: { revision: { increment: 1 } }
      });
      return { recording: recordingView(recording), revision: room.revision };
    });
  }
  // Commit playback and the shared live flag under the same room revision
  updatePlayback(id: string, positionMs: number, isPlaying: boolean) {
    return this.prisma.$transaction(async (tx) => {
      await lockRoom(tx, id);
      const current = await tx.preparedRecording.findUnique({
        where: { sessionId: id }
      });
      if (current?.status !== 'ready') throw new RecordingNotReadyError();
      if (positionMs > (current.durationMs ?? 0))
        throw new RangeError('Invalid source position');
      // Keep release open at source end until the presenter acknowledges finalization
      const playing = isPlaying;
      const recording = await tx.preparedRecording.update({
        where: { sessionId: id },
        data: {
          playbackPositionMs: positionMs,
          isPlaying: playing,
          playbackUpdatedAt: new Date()
        }
      });
      const room = await tx.conferenceSession.update({
        where: { id },
        data: { isLive: playing, revision: { increment: 1 } }
      });
      return { recording: recordingView(recording), revision: room.revision };
    });
  }
  // Expire disconnected presenter clocks only if no newer heartbeat has committed
  async pauseDisconnected(before: Date) {
    const stale = await this.prisma.preparedRecording.findMany({
      where: { isPlaying: true, playbackUpdatedAt: { lt: before } },
      select: { sessionId: true }
    });
    const mutations = [];
    for (const { sessionId } of stale) {
      const mutation = await this.prisma.$transaction(async (tx) => {
        await lockRoom(tx, sessionId);
        const current = await tx.preparedRecording.findUniqueOrThrow({
          where: { sessionId }
        });
        if (!current.isPlaying || current.playbackUpdatedAt >= before)
          return null;
        const recording = await tx.preparedRecording.update({
          where: { sessionId },
          data: { isPlaying: false }
        });
        const room = await tx.conferenceSession.update({
          where: { id: sessionId },
          data: { isLive: false, revision: { increment: 1 } }
        });
        return {
          sessionId,
          recording: recordingView(recording),
          revision: room.revision
        };
      });
      if (mutation) mutations.push(mutation);
    }
    return mutations;
  }
  // Return source metadata only after checking room existence
  async getRecording(id: string) {
    const room = await this.prisma.conferenceSession.findUnique({
      where: { id },
      include: { recording: true }
    });
    if (!room) throw new SessionNotFoundError();
    return room.recording ? recordingView(room.recording) : null;
  }
}
