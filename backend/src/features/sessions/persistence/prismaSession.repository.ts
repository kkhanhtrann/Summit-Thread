import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import { SessionNotFoundError } from '../contracts/session.contract';
import type { SessionSnapshot } from '../contracts/session.contract';
import type { SessionRepositoryPort } from '../application/session.service';
import type { TopicAnalysisResult } from '../../../platform/ai/topicAnalysis';
import { loadSnapshot, lockRoom } from './prismaRoomRepository';

// Persist topic analysis with repeat-safe revision and index updates
export class PrismaSessionRepository implements SessionRepositoryPort {
  constructor(private readonly database: PrismaClient) {}

  // Freeze the currently released caption count without extending an active attempt
  async requestTopicAnalysis(sessionId?: string): Promise<void> {
    const sessions = await this.database.conferenceSession.findMany({
      where: { ...(sessionId ? { id: sessionId } : {}), releasedCount: { gt: 0 } },
      select: { id: true, releasedCount: true }
    });
    for (const session of sessions) {
      await this.database.conferenceSession.updateMany({
        where: { id: session.id, topicAnalysisRequestedThroughSequence: { lt: session.releasedCount } },
        data: { topicAnalysisRequestedThroughSequence: session.releasedCount }
      });
    }
  }

  // Schedule requested intervals, paused tails, and the explicit initial-topic policy
  async getPendingTopicSessionIds(initialLiveBatchSize: number, force = false, sessionId?: string): Promise<string[]> {
    if (force) await this.requestTopicAnalysis(sessionId);
    const sessions = await this.database.conferenceSession.findMany({
      where: {
        ...(sessionId ? { id: sessionId } : {}),
        releasedCount: { gt: 0 }
      },
      select: {
        id: true, isLive: true, releasedCount: true, topicAnalysisCursor: true,
        topicAnalysisRequestedThroughSequence: true, topicAnalysisAttemptThroughSequence: true,
        topicAnalysisRetryAt: true
      },
      orderBy: { updatedAt: 'asc' }
    });

    const pending: string[] = [];
    for (const session of sessions) {
      let requestedThrough = session.topicAnalysisRequestedThroughSequence;
      const initialTopicDue = session.topicAnalysisCursor === 0 && requestedThrough === 0
        && session.releasedCount >= initialLiveBatchSize;
      if ((!session.isLive || initialTopicDue) && session.releasedCount > requestedThrough) {
        requestedThrough = session.releasedCount;
        await this.database.conferenceSession.updateMany({
          where: { id: session.id, topicAnalysisRequestedThroughSequence: { lt: requestedThrough } },
          data: { topicAnalysisRequestedThroughSequence: requestedThrough }
        });
      }
      const throughSequence = session.topicAnalysisAttemptThroughSequence ?? requestedThrough;
      if (throughSequence > session.topicAnalysisCursor
        && (!session.topicAnalysisRetryAt || session.topicAnalysisRetryAt.getTime() <= Date.now())) pending.push(session.id);
    }
    return pending;
  }

  // Load every caption in the fixed requested interval and its prior grounded evidence
  async getTopicAnalysisContext(sessionId: string) {
    const session = await this.database.conferenceSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        topicAnalysisCursor: true,
        topicAnalysisFailureCount: true,
        topicAnalysisRetryAt: true,
        releasedCount: true,
        topicAnalysisRequestedThroughSequence: true,
        topicAnalysisAttemptThroughSequence: true,
        currentTopicThreadId: true,
        currentOccurrenceId: true
      }
    });
    if (!session) throw new SessionNotFoundError();
    const throughSequence = session.topicAnalysisAttemptThroughSequence
      ?? Math.min(session.topicAnalysisRequestedThroughSequence, session.releasedCount);
    if (throughSequence <= session.topicAnalysisCursor || throughSequence > session.releasedCount) return null;
    if (session.topicAnalysisAttemptThroughSequence === null) {
      const claimed = await this.database.conferenceSession.updateMany({
        where: { id: sessionId, topicAnalysisCursor: session.topicAnalysisCursor, topicAnalysisAttemptThroughSequence: null },
        data: { topicAnalysisAttemptThroughSequence: throughSequence }
      });
      if (claimed.count !== 1) return null;
    }

    const [captions, recentThreads, currentThread, currentOccurrence] = await Promise.all([
      this.database.captionSegment.findMany({
        where: { sessionId, sequence: { gte: session.topicAnalysisCursor, lt: throughSequence } },
        orderBy: { sequence: 'asc' },
        select: { id: true, sequence: true, timestampMs: true, text: true }
      }),
      this.database.topicThread.findMany({
        where: { sessionId },
        orderBy: { updatedAt: 'desc' },
        take: 63,
        select: { id: true, title: true, summary: true, evidenceCaptionIds: true }
      }),
      session.currentTopicThreadId
        ? this.database.topicThread.findFirst({
          where: { id: session.currentTopicThreadId, sessionId },
          select: { id: true, title: true, summary: true, evidenceCaptionIds: true }
        })
        : Promise.resolve(null),
      session.currentOccurrenceId
        ? this.database.topicOccurrence.findFirst({
          where: { id: session.currentOccurrenceId, sessionId },
          select: { summary: true, evidenceCaptionIds: true }
        })
        : Promise.resolve(null)
    ]);
    // Retain the current topic even when it falls outside the recent-topic window
    const existingThreads = currentThread
      ? [currentThread, ...recentThreads.filter((thread) => thread.id !== currentThread.id).slice(0, 63)]
      : recentThreads;
    const evidenceIds = [...new Set([
      ...existingThreads.flatMap((thread) => thread.evidenceCaptionIds),
      ...(currentOccurrence?.evidenceCaptionIds ?? [])
    ])];
    const evidenceCaptions = evidenceIds.length ? await this.database.captionSegment.findMany({
      where: { sessionId, id: { in: evidenceIds }, sequence: { lt: session.topicAnalysisCursor } },
      orderBy: { sequence: 'asc' },
      select: { id: true, sequence: true, timestampMs: true, text: true }
    }) : [];
    const currentOccurrenceEvidenceCaptions = evidenceCaptions.filter((caption) => currentOccurrence?.evidenceCaptionIds.includes(caption.id));

    return {
      cursor: session.topicAnalysisCursor,
      failureCount: session.topicAnalysisFailureCount,
      retryAt: session.topicAnalysisRetryAt,
      input: {
        captions,
        existingThreads: existingThreads.map((thread) => {
          const priorEvidence = evidenceCaptions.filter((caption) => thread.evidenceCaptionIds.includes(caption.id));
          return { id: thread.id, title: thread.title, summary: priorEvidence.length ? thread.summary : '', evidenceCaptions: priorEvidence };
        }),
        currentThreadId: session.currentTopicThreadId,
        currentOccurrenceSummary: currentOccurrenceEvidenceCaptions.length ? currentOccurrence?.summary ?? null : null,
        currentOccurrenceEvidenceCaptions
      }
    };
  }

  // Persist an account-wide quota cooldown without consuming caption failure budgets
  async deferTopicAnalysis(retryAfterMs: number): Promise<void> {
    const retryAt = new Date(Date.now() + retryAfterMs);
    await this.database.conferenceSession.updateMany({
      where: { OR: [{ topicAnalysisRetryAt: null }, { topicAnalysisRetryAt: { lt: retryAt } }] },
      data: { topicAnalysisRetryAt: retryAt }
    });
  }

  // Count one failed attempt against the durable topic cursor
  async recordTopicAnalysisFailure(
    sessionId: string,
    cursor: number,
    throughSequence: number,
    retryAfterMs: number
  ): Promise<number | null> {
    return this.database.$transaction(async (transaction) => {
      // Charge the failure only while the same analyzed range remains current
      const updated = await transaction.conferenceSession.updateMany({
        where: {
          id: sessionId, topicAnalysisCursor: cursor, topicAnalysisAttemptThroughSequence: throughSequence,
          releasedCount: { gte: throughSequence }
        },
        data: {
          topicAnalysisFailureCount: { increment: 1 },
          topicAnalysisRetryAt: new Date(Date.now() + retryAfterMs)
        }
      });
      if (updated.count !== 1) return null;

      const session = await transaction.conferenceSession.findUnique({
        where: { id: sessionId },
        select: { topicAnalysisFailureCount: true }
      });
      if (!session) throw new SessionNotFoundError();
      return session.topicAnalysisFailureCount;
    });
  }

  // Keep unreliably grouped captions readable and move later topic batches forward
  async skipTopicAnalysisBatch(sessionId: string, cursor: number, throughSequence: number): Promise<SessionSnapshot | null> {
    return this.database.$transaction(async (transaction) => {
      // Serialize with caption release and playback writers before changing the room revision
      await lockRoom(transaction, sessionId);
      const session = await transaction.conferenceSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new SessionNotFoundError();
      if (session.topicAnalysisCursor !== cursor || session.topicAnalysisAttemptThroughSequence !== throughSequence
        || throughSequence <= cursor || session.releasedCount < throughSequence) return null;

      // Keep the cursor from skipping over a missing caption sequence
      const batchSize = await transaction.captionSegment.count({
        where: { sessionId, sequence: { gte: cursor, lt: throughSequence } }
      });
      if (batchSize !== throughSequence - cursor) return null;

      const advanced = await transaction.conferenceSession.updateMany({
        where: {
          id: sessionId, topicAnalysisCursor: cursor, topicAnalysisAttemptThroughSequence: throughSequence,
          releasedCount: { gte: throughSequence }
        },
        data: {
          topicAnalysisCursor: throughSequence,
          topicAnalysisAttemptThroughSequence: null,
          topicAnalysisFailureCount: 0,
          topicAnalysisRetryAt: null,
          topicAnalysisSkippedCaptionCount: { increment: batchSize },
          revision: { increment: 1 }
        }
      });
      if (advanced.count !== 1) return null;

      return loadSnapshot(transaction, sessionId);
    });
  }

  // Commit complete interval coverage and all transition boundaries atomically
  async applyTopicAnalysis(
    sessionId: string,
    cursor: number,
    throughSequence: number,
    result: TopicAnalysisResult
  ): Promise<SessionSnapshot | null> {
    return this.database.$transaction(async (transaction) => {
      // Serialize with caption release and playback writers before changing the room revision
      await lockRoom(transaction, sessionId);
      const session = await transaction.conferenceSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new SessionNotFoundError();
      if (session.topicAnalysisCursor !== cursor || throughSequence <= cursor
        || session.releasedCount < throughSequence
        || session.topicAnalysisAttemptThroughSequence !== throughSequence) return null;
      const batch = await transaction.captionSegment.findMany({
        where: { sessionId, sequence: { gte: cursor, lt: throughSequence } }, orderBy: { sequence: 'asc' }
      });
      if (batch.length !== throughSequence - cursor) return null;
      const indices = new Map(batch.map((caption, index) => [caption.id, index]));
      const starts = result.segments.map(segment => indices.get(segment.startCaptionId));
      if (!starts.length || starts[0] !== 0 || starts.some((start, i) => start === undefined
        || (i > 0 && start <= starts[i - 1]!))) throw new Error('Topic plan must cover the interval in order');
      const known = await transaction.topicThread.findMany({ where: { sessionId }, select: { id: true, evidenceCaptionIds: true } });
      const evidence = new Map(known.map(thread => [thread.id, new Set(thread.evidenceCaptionIds)]));
      const currentOccurrence = session.currentOccurrenceId ? await transaction.topicOccurrence.findFirst({
        where: { id: session.currentOccurrenceId, sessionId }, select: { evidenceCaptionIds: true }
      }) : null;
      let activeRef = session.currentTopicThreadId;
      let occurrenceEvidence = new Set(currentOccurrence?.evidenceCaptionIds ?? []);
      // Validate the entire plan before any mutation so a bad later segment commits nothing
      for (let i = 0; i < result.segments.length; i += 1) {
        const segment = result.segments[i]!;
        const ids = new Set(batch.slice(starts[i]!, starts[i + 1] ?? batch.length).map(caption => caption.id));
        const selected = segment.decision === 'new' ? segment.startCaptionId : segment.threadId ?? '';
        if (segment.decision === 'new') {
          if (segment.threadId || evidence.has(selected)) throw new Error('Invalid new topic reference');
          evidence.set(selected, new Set());
        } else if (!evidence.has(selected)
          || (segment.decision === 'continue' && (selected !== activeRef || (!currentOccurrence && i === 0)))
          || (segment.decision === 'return' && selected === activeRef)) throw new Error('Invalid topic transition');
        const summaryAllowed = new Set([...evidence.get(selected)!, ...ids]);
        const occurrenceAllowed = new Set([...ids, ...(segment.decision === 'continue' ? occurrenceEvidence : [])]);
        if (!segment.summaryEvidenceCaptionIds.length || !segment.occurrenceEvidenceCaptionIds.length
          || segment.summaryEvidenceCaptionIds.some(id => !summaryAllowed.has(id))
          || segment.occurrenceEvidenceCaptionIds.some(id => !occurrenceAllowed.has(id))
          || !segment.occurrenceEvidenceCaptionIds.some(id => ids.has(id))) throw new Error('Invalid topic evidence');
        evidence.set(selected, summaryAllowed);
        occurrenceEvidence = occurrenceAllowed;
        activeRef = selected;
      }
      const citedIds = [...new Set(result.segments.flatMap(segment => [...segment.summaryEvidenceCaptionIds, ...segment.occurrenceEvidenceCaptionIds]))];
      const citedCount = await transaction.captionSegment.count({ where: { sessionId, id: { in: citedIds }, sequence: { lt: throughSequence } } });
      if (citedCount !== citedIds.length) throw new Error('Topic evidence must be released in this room');

      const localThreads = new Map<string, string>();
      let activeThreadId = session.currentTopicThreadId;
      let activeOccurrenceId = session.currentOccurrenceId;
      let suggestions = session.suggestedQuestions;
      const latest = await transaction.topicOccurrence.aggregate({ where: { sessionId }, _max: { ordinal: true } });
      let ordinal = latest._max.ordinal ?? -1;
      for (let i = 0; i < result.segments.length; i += 1) {
        const segment = result.segments[i]!;
        const captions = batch.slice(starts[i]!, starts[i + 1] ?? batch.length);
        const first = captions[0]!;
        const endSequence = captions.at(-1)!.sequence + 1;
        let threadId: string;
        if (segment.decision === 'new') {
          threadId = `${sessionId}-thread-${randomUUID()}`;
          localThreads.set(segment.startCaptionId, threadId);
          await transaction.topicThread.create({ data: {
            id: threadId, sessionId, title: segment.title, summary: segment.summary,
            evidenceCaptionIds: segment.summaryEvidenceCaptionIds
          } });
        } else {
          threadId = localThreads.get(segment.threadId!) ?? segment.threadId!;
          await transaction.topicThread.update({ where: { id: threadId }, data: {
            summary: segment.summary, evidenceCaptionIds: segment.summaryEvidenceCaptionIds
          } });
        }
        if (segment.decision !== 'continue') {
          if (activeOccurrenceId) {
            const last = await transaction.captionSegment.findFirst({
              where: { sessionId, topicOccurrenceId: activeOccurrenceId }, orderBy: { sequence: 'desc' },
              select: { sequence: true, timestampMs: true }
            });
            await transaction.topicOccurrence.updateMany({ where: { id: activeOccurrenceId, sessionId, endedSequence: null }, data: {
              endedSequence: last?.sequence ?? first.sequence - 1,
              endedAtMs: last?.timestampMs ?? first.timestampMs
            } });
          }
          activeOccurrenceId = `${sessionId}-occurrence-${randomUUID()}`;
          ordinal += 1;
          await transaction.topicOccurrence.create({ data: {
            id: activeOccurrenceId, sessionId, threadId, ordinal,
            summary: segment.occurrenceSummary, evidenceCaptionIds: segment.occurrenceEvidenceCaptionIds,
            startedSequence: first.sequence, startedAtMs: first.timestampMs
          } });
          suggestions = segment.suggestedQuestions;
        } else {
          if (!activeOccurrenceId) throw new Error('Topic continuation requires an active occurrence');
          await transaction.topicOccurrence.update({ where: { id: activeOccurrenceId }, data: {
            summary: segment.occurrenceSummary, evidenceCaptionIds: segment.occurrenceEvidenceCaptionIds
          } });
        }
        await transaction.captionSegment.updateMany({ where: { sessionId, sequence: { gte: first.sequence, lt: endSequence } },
          data: { topicOccurrenceId: activeOccurrenceId } });
        activeThreadId = threadId;
      }
      await transaction.searchIndexJob.createMany({ data: batch.map(caption => ({
        id: topicIndexJobIdFor(caption.id, throughSequence), operation: 'index_caption' as const, sessionId, captionId: caption.id
      })), skipDuplicates: true });
      const advanced = await transaction.conferenceSession.updateMany({
        where: { id: sessionId, topicAnalysisCursor: cursor, topicAnalysisAttemptThroughSequence: throughSequence,
          releasedCount: { gte: throughSequence } },
        data: { topicAnalysisCursor: throughSequence, topicAnalysisAttemptThroughSequence: null,
          topicAnalysisFailureCount: 0, topicAnalysisRetryAt: null, currentTopicThreadId: activeThreadId,
          currentOccurrenceId: activeOccurrenceId, suggestedQuestions: suggestions, revision: { increment: 1 } }
      });
      if (advanced.count !== 1) throw new TopicAnalysisCursorConflict();
      return loadSnapshot(transaction, sessionId);
    }).catch((error: unknown) => {
      if (error instanceof TopicAnalysisCursorConflict) return null;
      throw error;
    });
  }

}

// Create unique retry work whenever topic metadata changes
export function topicIndexJobIdFor(captionId: string, throughSequence: number): string {
  return `${captionId}:topic:${throughSequence}`;
}

// Abort a topic commit when its persisted cursor moved during analysis
class TopicAnalysisCursorConflict extends Error {}
