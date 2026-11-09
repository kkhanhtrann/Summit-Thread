import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

import type { PreparedVisualMoment } from '../contracts/session.contract';
import { VisualSourceNotReadyError } from '../contracts/visualMoment.contract';
import type {
  SpokenContext,
  VisualAnalysisState,
  VisualMomentRepositoryPort,
  VisualSourceMutation,
  VisualSourceRecord
} from '../application/visualMomentService';
import { MAX_VISUAL_DESCRIPTION_LENGTH, MAX_VISUAL_TITLE_LENGTH } from '../application/visualWindows';

// Link a still only to speech released shortly before it so distant captions are not presented as context
const SPOKEN_CONTEXT_LOOKBACK_MS = 60_000;

// Select only the recording columns visual review reads or owns
const sourceSelect = {
  sessionId: true,
  sourceType: true,
  status: true,
  preparationStage: true,
  mediaKind: true,
  mimeType: true,
  durationMs: true,
  playbackPositionMs: true,
  playbackUpdatedAt: true,
  isPlaying: true,
  analysisWindowMinutes: true,
  analysisWindowCount: true,
  analysisThroughMs: true,
  analysisState: true,
  visualReviewSkippedWindowCount: true,
  releasedVisualMomentCount: true,
  visualMoments: true
} satisfies Prisma.PreparedRecordingSelect;

type SourceRow = Prisma.PreparedRecordingGetPayload<{ select: typeof sourceSelect }>;

// Validate stored released metadata and drop malformed entries instead of exposing them
const releasedMomentSchema = z.object({
  id: z.string().regex(/^moment-\d{4}$/),
  timestampMs: z.number().int().nonnegative(),
  topicTitle: z.string().min(1).max(MAX_VISUAL_TITLE_LENGTH),
  description: z.string().min(1).max(MAX_VISUAL_DESCRIPTION_LENGTH)
}).strict();

// Read released moments from durable JSON
function readReleasedMoments(value: Prisma.JsonValue): PreparedVisualMoment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = releasedMomentSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

// Write released moments as plain JSON objects in source-time order
function toReleasedJson(moments: PreparedVisualMoment[]): Prisma.InputJsonArray {
  return [...moments]
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .map((moment): Prisma.InputJsonObject => ({
      id: moment.id,
      timestampMs: moment.timestampMs,
      topicTitle: moment.topicTitle,
      description: moment.description
    }));
}

// Map a recording row without exposing database JSON or storage details
function mapSource(row: SourceRow): VisualSourceRecord {
  return {
    sessionId: row.sessionId,
    sourceType: row.sourceType,
    status: row.status,
    preparationStage: row.preparationStage,
    mediaKind: row.mediaKind,
    mimeType: row.mimeType,
    durationMs: row.durationMs,
    playbackPositionMs: row.playbackPositionMs,
    playbackUpdatedAt: row.playbackUpdatedAt.toISOString(),
    isPlaying: row.isPlaying,
    analysisWindowMinutes: row.analysisWindowMinutes,
    analysisWindowCount: row.analysisWindowCount,
    analysisThroughMs: row.analysisThroughMs,
    analysisState: row.analysisState,
    visualReviewSkippedWindowCount: row.visualReviewSkippedWindowCount,
    releasedVisualMomentCount: row.releasedVisualMomentCount,
    releasedMoments: readReleasedMoments(row.visualMoments)
  };
}

// Persist visual cursors and released metadata with the shared room revision
export class PrismaVisualMomentRepository implements VisualMomentRepositoryPort {
  constructor(private readonly database: PrismaClient) {}

  // Read the room's source clock, cursors, and released moments
  async getSource(sessionId: string): Promise<VisualSourceRecord | null> {
    const row = await this.database.preparedRecording.findUnique({ where: { sessionId }, select: sourceSelect });
    return row ? mapSource(row) : null;
  }

  // Store the visible review state and advance the room revision
  async setAnalysisState(sessionId: string, state: VisualAnalysisState): Promise<VisualSourceMutation> {
    return await this.database.$transaction(async (transaction) => {
      const exists = await transaction.preparedRecording.findUnique({ where: { sessionId }, select: { sessionId: true } });
      if (!exists) throw new VisualSourceNotReadyError();
      const row = await transaction.preparedRecording.update({ where: { sessionId }, data: { analysisState: state }, select: sourceSelect });
      const session = await transaction.conferenceSession.update({ where: { id: sessionId }, data: { revision: { increment: 1 } }, select: { revision: true } });
      return { source: mapSource(row), revision: session.revision };
    });
  }

  // Commit one window with a compare-and-set on its index and start offset
  // A repeated index returns current state, so retries never double-count a window
  async completeWindow(
    sessionId: string,
    window: { index: number; startMs: number; throughMs: number; skipped: boolean }
  ): Promise<VisualSourceMutation> {
    return await this.database.$transaction(async (transaction) => {
      const current = await transaction.preparedRecording.findUnique({ where: { sessionId }, select: sourceSelect });
      if (!current || current.status !== 'ready') throw new VisualSourceNotReadyError();
      if (current.analysisWindowCount > window.index) {
        const session = await transaction.conferenceSession.findUniqueOrThrow({ where: { id: sessionId }, select: { revision: true } });
        return { source: mapSource(current), revision: session.revision };
      }
      if (current.analysisWindowCount !== window.index || current.analysisThroughMs !== window.startMs || window.throughMs <= window.startMs) {
        throw new Error('Visual window order is invalid');
      }

      const reachedEnd = current.sourceType === 'camera'
        ? !current.isPlaying
        : current.durationMs !== null && window.throughMs >= current.durationMs;
      const updated = await transaction.preparedRecording.updateMany({
        where: { sessionId, analysisWindowCount: window.index, analysisThroughMs: window.startMs },
        data: {
          analysisWindowCount: window.index + 1,
          analysisThroughMs: window.throughMs,
          analysisState: reachedEnd ? 'complete' : 'ready',
          // Keep unknown legacy history null instead of reporting a false count
          ...(current.visualReviewSkippedWindowCount !== null && window.skipped
            ? { visualReviewSkippedWindowCount: { increment: 1 } }
            : {})
        }
      });
      if (updated.count !== 1) throw new Error('Visual window was committed concurrently');
      const row = await transaction.preparedRecording.findUniqueOrThrow({ where: { sessionId }, select: sourceSelect });
      const session = await transaction.conferenceSession.update({ where: { id: sessionId }, data: { revision: { increment: 1 } }, select: { revision: true } });
      return { source: mapSource(row), revision: session.revision };
    });
  }

  // Append one released moment only when the release cursor still matches and the ID is new
  async releaseMoment(
    sessionId: string,
    moment: PreparedVisualMoment,
    expectedReleasedCount: number
  ): Promise<{ moment: PreparedVisualMoment; revision: number } | null> {
    return await this.database.$transaction(async (transaction) => {
      const current = await transaction.preparedRecording.findUnique({ where: { sessionId }, select: sourceSelect });
      if (!current || current.status !== 'ready' || current.releasedVisualMomentCount !== expectedReleasedCount) return null;
      const released = readReleasedMoments(current.visualMoments);
      if (released.some((existing) => existing.id === moment.id)) return null;

      const updated = await transaction.preparedRecording.updateMany({
        where: { sessionId, releasedVisualMomentCount: expectedReleasedCount },
        data: { visualMoments: toReleasedJson([...released, moment]), releasedVisualMomentCount: expectedReleasedCount + 1 }
      });
      if (updated.count !== 1) return null;
      const session = await transaction.conferenceSession.update({ where: { id: sessionId }, data: { revision: { increment: 1 } }, select: { revision: true } });
      return { moment, revision: session.revision };
    });
  }

  // Find the latest released caption at or shortly before each still, plus its validated occurrence
  async findSpokenContexts(sessionId: string, timestampsMs: readonly number[]): Promise<Map<number, SpokenContext>> {
    const contexts = new Map<number, SpokenContext>();
    for (const timestampMs of new Set(timestampsMs)) {
      const caption = await this.database.captionSegment.findFirst({
        where: { sessionId, timestampMs: { lte: timestampMs, gte: timestampMs - SPOKEN_CONTEXT_LOOKBACK_MS } },
        orderBy: [{ timestampMs: 'desc' }, { sequence: 'desc' }],
        select: { id: true, topicOccurrenceId: true, topicOccurrence: { select: { threadId: true } } }
      });
      if (!caption) continue;
      contexts.set(timestampMs, {
        captionId: caption.id,
        occurrenceId: caption.topicOccurrenceId,
        threadId: caption.topicOccurrence?.threadId ?? null
      });
    }
    return contexts;
  }
}
