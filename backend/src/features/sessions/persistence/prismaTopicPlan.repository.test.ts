import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { TopicAnalysisResult, TopicAnalysisSegment } from '../../../platform/ai/topicAnalysis';
import { PrismaSessionRepository } from './prismaSession.repository';

// Exercise interval persistence with synthetic captions and inspect actual assignments
function setup() {
  const captions = Array.from({ length: 6 }, (_, sequence) => ({
    id: `caption-${sequence}`, sessionId: 'AB12CD34', sequence,
    timestampMs: (sequence + 1) * 1_000, text: `Synthetic test statement ${sequence}`
  }));
  const assignments = new Map<string, string>();
  const session = {
    id: 'AB12CD34', title: 'Synthetic test room', eventName: 'Test', speakerName: 'Fixture', contentLabel: 'Synthetic fixture',
    revision: 0, isLive: true, releasedCount: 6, topicAnalysisCursor: 0, topicAnalysisAttemptThroughSequence: 6,
    topicAnalysisRequestedThroughSequence: 6, currentTopicThreadId: null, currentOccurrenceId: null, suggestedQuestions: [],
    topicAnalysisSkippedCaptionCount: 0
  };
  const transaction = {
    $queryRaw: vi.fn(async () => [{ id: 'AB12CD34' }]),
    conferenceSession: {
      findUnique: vi.fn(async ({ include }: { include?: unknown }) => include
        ? { ...session, captions: [], topicThreads: [], recording: null } : session),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    captionSegment: {
      findMany: vi.fn(async () => captions),
      count: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => captions.filter(caption => where.id.in.includes(caption.id)).length),
      findFirst: vi.fn(async ({ where }: { where: { topicOccurrenceId: string } }) => captions.filter(caption => assignments.get(caption.id) === where.topicOccurrenceId).at(-1) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: { sequence: { gte: number; lt: number } }; data: { topicOccurrenceId: string } }) => {
        for (const caption of captions.filter(c => c.sequence >= where.sequence.gte && c.sequence < where.sequence.lt)) assignments.set(caption.id, data.topicOccurrenceId);
        return { count: where.sequence.lt - where.sequence.gte };
      })
    },
    topicThread: { findMany: vi.fn(async () => []), create: vi.fn(async () => undefined), update: vi.fn(async () => undefined) },
    topicOccurrence: {
      findFirst: vi.fn(async () => null), aggregate: vi.fn(async () => ({ _max: { ordinal: null } })),
      create: vi.fn(async () => undefined), updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(async () => undefined)
    },
    searchIndexJob: { createMany: vi.fn(async () => ({ count: 6 })) }
  };
  const database = { $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)) } as unknown as PrismaClient;
  return { repository: new PrismaSessionRepository(database), transaction, assignments };
}

// Build a complete A to B to A plan using request-local topic references
function plan(): TopicAnalysisResult {
  const make = (start: number): TopicAnalysisSegment => ({
    startCaptionId: `caption-${start}`, decision: 'new', title: `Topic ${start}`,
    summary: 'A concise summary grounded in the supplied synthetic evidence.',
    occurrenceSummary: 'A concise note about this synthetic visit.', summaryEvidenceCaptionIds: [`caption-${start}`],
    occurrenceEvidenceCaptionIds: [`caption-${start}`], suggestedQuestions: []
  });
  return { segments: [make(0), make(2), { ...make(4), decision: 'return', threadId: 'caption-0',
    summaryEvidenceCaptionIds: ['caption-1', 'caption-4'] }] };
}

describe('topic interval persistence', () => {
  it('assigns each range and starts landmarks at actual transition captions', async () => {
    const { repository, transaction, assignments } = setup();
    await repository.applyTopicAnalysis('AB12CD34', 0, 6, plan());
    const occurrences = transaction.topicOccurrence.create.mock.calls.map(call => (call as unknown as [{ data: { id: string; threadId: string; startedSequence: number; startedAtMs: number; evidenceCaptionIds: string[] } }])[0].data);
    expect(occurrences.map(o => [o.startedSequence, o.startedAtMs])).toEqual([[0, 1_000], [2, 3_000], [4, 5_000]]);
    expect(occurrences[0]!.threadId).toBe(occurrences[2]!.threadId);
    expect(occurrences[1]!.threadId).not.toBe(occurrences[0]!.threadId);
    expect([...assignments.values()]).toEqual([occurrences[0]!.id, occurrences[0]!.id, occurrences[1]!.id, occurrences[1]!.id, occurrences[2]!.id, occurrences[2]!.id]);
    expect(occurrences[2]!.evidenceCaptionIds).toEqual(['caption-4']);
    expect(transaction.topicThread.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ evidenceCaptionIds: ['caption-1', 'caption-4'] }) }));
    expect(transaction.conferenceSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ topicAnalysisCursor: 6, topicAnalysisAttemptThroughSequence: null }) }));
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
  });

  it('rejects invalid later evidence before mutating any topic or caption', async () => {
    const { repository, transaction } = setup();
    const invalid = plan();
    invalid.segments[2]!.occurrenceEvidenceCaptionIds = ['caption-0'];
    await expect(repository.applyTopicAnalysis('AB12CD34', 0, 6, invalid)).rejects.toThrow('Invalid topic evidence');
    expect(transaction.topicThread.create).not.toHaveBeenCalled();
    expect(transaction.captionSegment.updateMany).not.toHaveBeenCalled();
    expect(transaction.conferenceSession.updateMany).not.toHaveBeenCalled();
  });
});
