import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '@prisma/client';

import { PrismaSessionRepository } from './prismaSession.repository';

describe('requested topic intervals', () => {
  it('loads all 37 requested captions and keeps later arrivals outside retries', async () => {
    const captions = Array.from({ length: 50 }, (_, sequence) => ({
      id: `caption-${sequence}`, sequence, timestampMs: sequence * 1_000, text: `Released statement ${sequence}`
    }));
    const session = {
      id: 'AB12CD34', releasedCount: 45, topicAnalysisCursor: 3,
      topicAnalysisRequestedThroughSequence: 40, topicAnalysisAttemptThroughSequence: null as number | null,
      topicAnalysisFailureCount: 0, topicAnalysisRetryAt: null,
      currentTopicThreadId: null, currentOccurrenceId: null
    };
    const findMany = vi.fn(async ({ where }: { where: { sequence: { gte: number; lt: number } } }) =>
      captions.filter((caption) => caption.sequence >= where.sequence.gte && caption.sequence < where.sequence.lt));
    const updateMany = vi.fn(async ({ data }: { data: { topicAnalysisAttemptThroughSequence: number } }) => {
      session.topicAnalysisAttemptThroughSequence = data.topicAnalysisAttemptThroughSequence;
      return { count: 1 };
    });
    const database = {
      conferenceSession: { findUnique: vi.fn(async () => session), updateMany },
      captionSegment: { findMany }, topicThread: { findMany: vi.fn(async () => []) }
    } as unknown as PrismaClient;
    const repository = new PrismaSessionRepository(database);

    const first = await repository.getTopicAnalysisContext(session.id);
    expect(first?.input.captions).toEqual(captions.slice(3, 40));
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({ where: { sequence: { gte: 3, lt: 40 } } });
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty('take');
    session.releasedCount = 50;
    session.topicAnalysisRequestedThroughSequence = 50;

    const retry = await repository.getTopicAnalysisContext(session.id);
    expect(retry?.input.captions).toEqual(captions.slice(3, 40));
    expect(updateMany).toHaveBeenCalledOnce();
  });

  it('supplies actual prior released evidence for cumulative summaries', async () => {
    const prior = { id: 'caption-0', sequence: 0, timestampMs: 1_000, text: 'An earlier released claim' };
    const next = { id: 'caption-3', sequence: 3, timestampMs: 4_000, text: 'A newly released claim' };
    const thread = { id: 'thread-1', title: 'A known topic', summary: 'An earlier released claim', evidenceCaptionIds: [prior.id] };
    const database = {
      conferenceSession: {
        findUnique: vi.fn(async () => ({
          id: 'AB12CD34', releasedCount: 4, topicAnalysisCursor: 3,
          topicAnalysisRequestedThroughSequence: 4, topicAnalysisAttemptThroughSequence: 4,
          topicAnalysisFailureCount: 0, topicAnalysisRetryAt: null,
          currentTopicThreadId: thread.id, currentOccurrenceId: 'occurrence-1'
        }))
      },
      captionSegment: { findMany: vi.fn(async ({ where }: { where: { id?: unknown } }) => where.id ? [prior] : [next]) },
      topicThread: { findMany: vi.fn(async () => [thread]), findFirst: vi.fn(async () => thread) },
      topicOccurrence: { findFirst: vi.fn(async () => ({ summary: 'The earlier visit', evidenceCaptionIds: [prior.id] })) }
    } as unknown as PrismaClient;

    const context = await new PrismaSessionRepository(database).getTopicAnalysisContext('AB12CD34');
    expect(context?.input.existingThreads[0]?.evidenceCaptions).toEqual([prior]);
    expect(context?.input.currentOccurrenceEvidenceCaptions).toEqual([prior]);
    expect(database.captionSegment.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { sessionId: 'AB12CD34', id: { in: [prior.id] }, sequence: { lt: 3 } }
    }));
  });

  it('keeps a live retry pending until its backoff expires without requesting newer captions', async () => {
    const session = {
      id: 'AB12CD34', isLive: true, releasedCount: 50, topicAnalysisCursor: 3,
      topicAnalysisRequestedThroughSequence: 40, topicAnalysisAttemptThroughSequence: 40,
      topicAnalysisRetryAt: new Date(Date.now() + 60_000)
    };
    const updateMany = vi.fn();
    const database = { conferenceSession: { findMany: vi.fn(async () => [session]), updateMany } } as unknown as PrismaClient;
    const repository = new PrismaSessionRepository(database);
    await expect(repository.getPendingTopicSessionIds(3)).resolves.toEqual([]);
    session.topicAnalysisRetryAt = new Date(0);
    await expect(repository.getPendingTopicSessionIds(3)).resolves.toEqual([session.id]);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('requests a paused final remainder independently of the regular interval', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const database = { conferenceSession: {
      findMany: vi.fn(async () => [{
        id: 'AB12CD34', isLive: false, releasedCount: 52, topicAnalysisCursor: 40,
        topicAnalysisRequestedThroughSequence: 40, topicAnalysisAttemptThroughSequence: null,
        topicAnalysisRetryAt: null
      }]), updateMany
    } } as unknown as PrismaClient;
    await expect(new PrismaSessionRepository(database).getPendingTopicSessionIds(3)).resolves.toEqual(['AB12CD34']);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'AB12CD34', topicAnalysisRequestedThroughSequence: { lt: 52 } },
      data: { topicAnalysisRequestedThroughSequence: 52 }
    });
  });
});

describe('PrismaSessionRepository', () => {
  it('retries a live room after its persisted backoff expires even after its first topic', async () => {
    const database = {
      conferenceSession: { findMany: vi.fn().mockResolvedValue([{
        id: 'AB12CD34', isLive: true, releasedCount: 40, topicAnalysisCursor: 3,
        topicAnalysisFailureCount: 1, topicAnalysisRetryAt: new Date(0),
        topicAnalysisRequestedThroughSequence: 40, topicAnalysisAttemptThroughSequence: 40
      }]) }
    } as unknown as PrismaClient;
    const repository = new PrismaSessionRepository(database);

    await expect(repository.getPendingTopicSessionIds(3)).resolves.toEqual(['AB12CD34']);
  });

  it('persists quota backoff without changing topic cursors or failure budgets', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const database = { conferenceSession: { updateMany } } as unknown as PrismaClient;
    const repository = new PrismaSessionRepository(database);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      await repository.deferTopicAnalysis(60_000);
      expect(updateMany).toHaveBeenCalledWith({
        where: { OR: [{ topicAnalysisRetryAt: null }, { topicAnalysisRetryAt: { lt: new Date(61_000) } }] },
        data: { topicAnalysisRetryAt: new Date(61_000) }
      });
    } finally {
      now.mockRestore();
    }
  });

  it('allows one early topic so attendees have context at the start', async () => {
    const database = {
      conferenceSession: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'AB12CD34',
          isLive: true,
          releasedCount: 3,
          topicAnalysisCursor: 0,
          topicAnalysisRequestedThroughSequence: 0,
          topicAnalysisAttemptThroughSequence: null,
          topicAnalysisRetryAt: null
        }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      }
    } as unknown as PrismaClient;
    const repository = new PrismaSessionRepository(database);

    await expect(repository.getPendingTopicSessionIds(3)).resolves.toEqual(['AB12CD34']);
  });

  it('waits for the selected topic interval before analyzing live captions', async () => {
    const session = {
      id: 'AB12CD34', isLive: true, releasedCount: 6, topicAnalysisCursor: 3,
      topicAnalysisRequestedThroughSequence: 3, topicAnalysisAttemptThroughSequence: null,
      topicAnalysisRetryAt: null
    };
    const database = {
      conferenceSession: {
        findMany: vi.fn(async () => [session]),
        updateMany: vi.fn(async ({ data }: { data: { topicAnalysisRequestedThroughSequence: number } }) => {
          session.topicAnalysisRequestedThroughSequence = data.topicAnalysisRequestedThroughSequence;
          return { count: 1 };
        })
      }
    } as unknown as PrismaClient;
    const repository = new PrismaSessionRepository(database);

    await expect(repository.getPendingTopicSessionIds(3)).resolves.toEqual([]);
    await expect(repository.getPendingTopicSessionIds(3, true, 'AB12CD34')).resolves.toEqual(['AB12CD34']);
  });
});
