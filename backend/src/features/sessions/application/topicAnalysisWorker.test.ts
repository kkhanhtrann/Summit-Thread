import { describe, expect, it, vi } from 'vitest';

import type { TopicAnalysisInput, TopicAnalysisResult, TopicAnalysisSegment } from '../../../platform/ai/topicAnalysis';
import type { SessionRepositoryPort } from './session.service';
import { TopicAnalysisWorker } from './topicAnalysisWorker';

// Supply a small finalized batch and no prior topics to the worker
const input: TopicAnalysisInput = {
  captions: [
    { id: 'caption-001', sequence: 0, timestampMs: 1_000, text: 'Trees create shade along the street.' },
    { id: 'caption-002', sequence: 1, timestampMs: 2_000, text: 'That lowers direct sun on the sidewalk.' },
    { id: 'caption-003', sequence: 2, timestampMs: 3_000, text: 'People feel cooler on shaded routes.' }
  ],
  existingThreads: [],
  currentThreadId: null,
  currentOccurrenceSummary: null,
  currentOccurrenceEvidenceCaptions: []
};

// Return one grounded new-topic decision for the worker to persist
const segment: TopicAnalysisSegment = {
  startCaptionId: 'caption-001',
  decision: 'new',
  title: 'Street shade',
  summary: 'Trees reduce direct sun and make sidewalk routes feel cooler.',
  occurrenceSummary: 'The first segment links tree shade with lower direct sun and cooler sidewalks.',
  summaryEvidenceCaptionIds: ['caption-001', 'caption-002', 'caption-003'],
  occurrenceEvidenceCaptionIds: ['caption-001', 'caption-002', 'caption-003'],
  suggestedQuestions: [
    'How does shade change a walking route?',
    'What can make a sidewalk feel cooler?'
  ]
};

// Return the complete requested interval as one grounded topic segment
const result: TopicAnalysisResult = { segments: [segment] };

// Return a persisted topic snapshot after one successful analysis
const snapshot = {
  session: {
    id: 'AB12CD34',
    title: 'Opening keynote',
    eventName: 'Conference session',
    speakerName: 'Presenter',
    contentLabel: 'Live session',
    revision: 4,
    releasedCount: 3,
    isLive: true,
    topicAnalysisSkippedCaptionCount: 0
  },
  captions: input.captions,
  threads: [{
    id: 'AB12CD34-thread-001',
    title: segment.title,
    summary: segment.summary,
    occurrences: [{
      id: 'AB12CD34-occurrence-001',
      summary: segment.occurrenceSummary,
      startedAtMs: 1_000,
      endedAtMs: null,
      evidenceCaptionIds: segment.occurrenceEvidenceCaptionIds,
      captions: input.captions
    }]
  }],
  activeOccurrenceId: 'AB12CD34-occurrence-001',
  suggestedQuestions: segment.suggestedQuestions
};

describe('TopicAnalysisWorker', () => {
  it('retains a failed interval scheduling request and retries it on the next drain', async () => {
    const repository = {
      requestTopicAnalysis: vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(undefined),
      getPendingTopicSessionIds: vi.fn().mockResolvedValue(['AB12CD34']),
      getTopicAnalysisContext: vi.fn().mockResolvedValue({ cursor: 0, failureCount: 0, retryAt: null, input }),
      applyTopicAnalysis: vi.fn().mockResolvedValue(snapshot),
      recordTopicAnalysisFailure: vi.fn()
    } as unknown as SessionRepositoryPort;
    const analyzer = vi.fn().mockResolvedValue(result);
    const worker = new TopicAnalysisWorker(repository, analyzer, { publish: vi.fn(), subscribe: vi.fn() });

    await expect(worker.wake(true, 'AB12CD34')).resolves.toBeUndefined();
    expect(repository.requestTopicAnalysis).toHaveBeenCalledOnce();
    expect(analyzer).not.toHaveBeenCalled();
    await worker.wake();

    expect(repository.requestTopicAnalysis).toHaveBeenCalledTimes(2);
    expect(repository.requestTopicAnalysis).toHaveBeenLastCalledWith('AB12CD34');
    expect(analyzer).toHaveBeenCalledOnce();
    expect(repository.recordTopicAnalysisFailure).not.toHaveBeenCalled();
    worker.stop();
  });

  it('freezes a queued interval before later captions arrive while another request runs', async () => {
    const captions = Array.from({ length: 45 }, (_, sequence) => ({
      id: `caption-${sequence}`, sequence, timestampMs: sequence * 1_000, text: `Released statement ${sequence}`
    }));
    let releasedCount = 37;
    let requestedThrough = 0;
    let cursor = 0;
    let completeFirst: () => void = () => undefined;
    const firstRequest = new Promise<void>((resolve) => { completeFirst = resolve; });
    const repository = {
      requestTopicAnalysis: vi.fn(async () => { requestedThrough = releasedCount; }),
      getPendingTopicSessionIds: vi.fn(async () => cursor < requestedThrough ? ['AB12CD34'] : []),
      getTopicAnalysisContext: vi.fn(async () => ({
        cursor, failureCount: 0, retryAt: null,
        input: { ...input, captions: captions.slice(cursor, requestedThrough) }
      })),
      applyTopicAnalysis: vi.fn(async (_id: string, _cursor: number, through: number) => {
        cursor = through;
        return snapshot;
      })
    } as unknown as SessionRepositoryPort;
    const analyzer = vi.fn()
      .mockImplementationOnce(async () => { await firstRequest; return result; })
      .mockResolvedValue(result);
    const worker = new TopicAnalysisWorker(repository, analyzer, { publish: vi.fn(), subscribe: vi.fn() });
    const firstWake = worker.wake(true, 'AB12CD34');
    await vi.waitFor(() => expect(analyzer).toHaveBeenCalledOnce());
    releasedCount = 40;
    await worker.wake(true, 'AB12CD34');
    releasedCount = 45;
    completeFirst();
    await firstWake;
    await vi.waitFor(() => expect(repository.applyTopicAnalysis).toHaveBeenCalledTimes(2));

    expect(analyzer.mock.calls[0]?.[0].captions).toEqual(captions.slice(0, 37));
    expect(analyzer.mock.calls[1]?.[0].captions).toEqual(captions.slice(37, 40));
    expect(cursor).toBe(40);
    worker.stop();
  });

  it('sends every pending released caption at an interval regardless of caption count', async () => {
    const captions = Array.from({ length: 37 }, (_, sequence) => ({
      id: `caption-${sequence}`, sequence, timestampMs: sequence * 1_000, text: `Released statement ${sequence}`
    }));
    const repository = {
      requestTopicAnalysis: vi.fn().mockResolvedValue(undefined),
      getPendingTopicSessionIds: vi.fn().mockResolvedValue(['AB12CD34']),
      getTopicAnalysisContext: vi.fn(async (_id: string, limit?: number) => ({
        cursor: 0, failureCount: 0, retryAt: null,
        input: { ...input, captions: limit === undefined ? captions : captions.slice(0, limit) }
      })),
      applyTopicAnalysis: vi.fn().mockResolvedValue(snapshot)
    } as unknown as SessionRepositoryPort;
    const analyzer = vi.fn().mockResolvedValue(result);
    const worker = new TopicAnalysisWorker(repository, analyzer, { publish: vi.fn(), subscribe: vi.fn() });

    await worker.wake(true, 'AB12CD34');

    expect(analyzer.mock.calls[0]?.[0].captions).toEqual(captions);
    expect(repository.applyTopicAnalysis).toHaveBeenCalledWith('AB12CD34', 0, 37, result);
    worker.stop();
  });

  it('defers all rooms on quota exhaustion without charging failures or skipping captions', async () => {
    const repository = {
      requestTopicAnalysis: vi.fn().mockResolvedValue(undefined),
      getPendingTopicSessionIds: vi.fn().mockResolvedValue(['AB12CD34', 'CD34EF56']),
      getTopicAnalysisContext: vi.fn().mockResolvedValue({ cursor: 0, failureCount: 4, retryAt: null, input }),
      deferTopicAnalysis: vi.fn().mockResolvedValue(undefined),
      recordTopicAnalysisFailure: vi.fn(),
      skipTopicAnalysisBatch: vi.fn()
    } as unknown as SessionRepositoryPort;
    const analyzer = vi.fn().mockRejectedValue({ lastError: { statusCode: 429 } });
    const worker = new TopicAnalysisWorker(repository, analyzer, { publish: vi.fn(), subscribe: vi.fn() });

    await worker.wake(true);
    await worker.wake(true);

    expect(analyzer).toHaveBeenCalledOnce();
    expect(repository.deferTopicAnalysis).toHaveBeenCalledWith(86_400_000);
    expect(repository.recordTopicAnalysisFailure).not.toHaveBeenCalled();
    expect(repository.skipTopicAnalysisBatch).not.toHaveBeenCalled();
    worker.stop();
  });

  it('analyzes even a short transcript batch when the selected update interval elapses', async () => {
    const oneCaptionInput: TopicAnalysisInput = {
      ...input,
      captions: [input.captions[0]!],
      existingThreads: [{
        id: 'AB12CD34-thread-001',
        title: 'Street shade',
        summary: 'Trees shade the route and lower direct sun.',
        evidenceCaptions: [input.captions[0]!]
      }],
      currentThreadId: 'AB12CD34-thread-001',
      currentOccurrenceSummary: 'Trees shade the current sidewalk segment.'
    };
    const repository = {
      requestTopicAnalysis: vi.fn().mockResolvedValue(undefined),
      getPendingTopicSessionIds: vi.fn().mockResolvedValue(['AB12CD34']),
      getTopicAnalysisContext: vi.fn().mockResolvedValue({ cursor: 0, failureCount: 0, retryAt: null, input: oneCaptionInput }),
      applyTopicAnalysis: vi.fn().mockResolvedValue(snapshot)
    } as unknown as SessionRepositoryPort;
    const analyzer = vi.fn().mockResolvedValue(result);
    const worker = new TopicAnalysisWorker(repository, analyzer, { publish: vi.fn(), subscribe: vi.fn() });

    await worker.wake(true, 'AB12CD34');

    expect(repository.requestTopicAnalysis).toHaveBeenCalledWith('AB12CD34');
    expect(repository.getPendingTopicSessionIds).toHaveBeenCalledWith(3, false, 'AB12CD34');
    expect(analyzer).toHaveBeenCalledWith(oneCaptionInput);
    worker.stop();
  });

  it('persists one released batch and publishes the refreshed topic snapshot', async () => {
    const repository = {
      getPendingTopicSessionIds: vi.fn().mockResolvedValue(['AB12CD34']),
      getTopicAnalysisContext: vi.fn().mockResolvedValue({ cursor: 0, failureCount: 0, retryAt: null, input }),
      applyTopicAnalysis: vi.fn().mockResolvedValue(snapshot)
    } as unknown as SessionRepositoryPort;
    const analyzer = vi.fn().mockResolvedValue(result);
    const events = { publish: vi.fn(), subscribe: vi.fn() };
    const worker = new TopicAnalysisWorker(repository, analyzer, events);

    await worker.wake();

    expect(repository.getPendingTopicSessionIds).toHaveBeenCalledWith(3);
    expect(repository.getTopicAnalysisContext).toHaveBeenCalledWith('AB12CD34');
    expect(analyzer).toHaveBeenCalledWith(input);
    expect(repository.applyTopicAnalysis).toHaveBeenCalledWith('AB12CD34', 0, 3, result);
    expect(events.publish).toHaveBeenCalledWith('AB12CD34', {
      type: 'topic_updated',
      revision: 4,
      snapshot
    });
    worker.stop();
  });

  it('records a failed batch once without immediately calling the model again', async () => {
    const repository = {
      getPendingTopicSessionIds: vi.fn().mockResolvedValue(['AB12CD34']),
      getTopicAnalysisContext: vi.fn().mockResolvedValue({ cursor: 0, failureCount: 0, retryAt: null, input }),
      applyTopicAnalysis: vi.fn(),
      recordTopicAnalysisFailure: vi.fn().mockResolvedValue(1),
      skipTopicAnalysisBatch: vi.fn()
    } as unknown as SessionRepositoryPort;
    const events = { publish: vi.fn(), subscribe: vi.fn() };
    const worker = new TopicAnalysisWorker(repository, vi.fn().mockRejectedValue(new Error('provider failure')), events);

    await worker.wake();

    expect(repository.recordTopicAnalysisFailure).toHaveBeenCalledWith('AB12CD34', 0, 3, 2_000);
    expect(repository.skipTopicAnalysisBatch).not.toHaveBeenCalled();
    expect(repository.getTopicAnalysisContext).toHaveBeenCalledOnce();
    expect(repository.applyTopicAnalysis).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
    worker.stop();
  });

  it('resumes persisted batch recovery without spending another model request', async () => {
    const repository = {
      getPendingTopicSessionIds: vi.fn().mockResolvedValue(['AB12CD34']),
      getTopicAnalysisContext: vi.fn().mockResolvedValue({ cursor: 0, failureCount: 5, retryAt: null, input }),
      recordTopicAnalysisFailure: vi.fn(),
      skipTopicAnalysisBatch: vi.fn().mockResolvedValue({
        ...snapshot,
        session: { ...snapshot.session, revision: 5 },
        topicAnalysisSkippedCaptionCount: 3
      })
    } as unknown as SessionRepositoryPort;
    const events = { publish: vi.fn(), subscribe: vi.fn() };
    const analyzer = vi.fn();
    const worker = new TopicAnalysisWorker(repository, analyzer, events);

    await worker.wake();

    expect(analyzer).not.toHaveBeenCalled();
    expect(repository.recordTopicAnalysisFailure).not.toHaveBeenCalled();
    expect(repository.skipTopicAnalysisBatch).toHaveBeenCalledWith('AB12CD34', 0, 3);
    expect(events.publish).toHaveBeenCalledOnce();
    worker.stop();
  });

  it('waits for the persisted retry time before another model request', async () => {
    const repository = {
      getPendingTopicSessionIds: vi.fn().mockResolvedValue(['AB12CD34']),
      getTopicAnalysisContext: vi.fn().mockResolvedValue({
        cursor: 0,
        failureCount: 1,
        retryAt: new Date(Date.now() + 30_000),
        input
      }),
      recordTopicAnalysisFailure: vi.fn(),
      skipTopicAnalysisBatch: vi.fn()
    } as unknown as SessionRepositoryPort;
    const analyzer = vi.fn();
    const worker = new TopicAnalysisWorker(repository, analyzer, { publish: vi.fn(), subscribe: vi.fn() });

    await worker.wake();

    expect(analyzer).not.toHaveBeenCalled();
    expect(repository.recordTopicAnalysisFailure).not.toHaveBeenCalled();
    expect(repository.skipTopicAnalysisBatch).not.toHaveBeenCalled();
    worker.stop();
  });

  it('moves a repeatedly rejected batch past the topic cursor without hiding its captions', async () => {
    const nextInput: TopicAnalysisInput = {
      ...input,
      captions: [{ id: 'caption-004', sequence: 3, timestampMs: 4_000, text: 'A different subject begins.' }]
    };
    const nextResult: TopicAnalysisResult = {
      segments: [{
        ...segment,
        startCaptionId: 'caption-004',
        summaryEvidenceCaptionIds: ['caption-004'],
        occurrenceEvidenceCaptionIds: ['caption-004']
      }]
    };
    const repository = {
      getPendingTopicSessionIds: vi.fn().mockResolvedValue(['AB12CD34']),
      getTopicAnalysisContext: vi.fn()
        .mockResolvedValueOnce({ cursor: 0, failureCount: 0, retryAt: null, input })
        .mockResolvedValueOnce({ cursor: 0, failureCount: 1, retryAt: new Date(0), input })
        .mockResolvedValueOnce({ cursor: 0, failureCount: 2, retryAt: new Date(0), input })
        .mockResolvedValueOnce({ cursor: 0, failureCount: 3, retryAt: new Date(0), input })
        .mockResolvedValueOnce({ cursor: 0, failureCount: 4, retryAt: new Date(0), input })
        .mockResolvedValueOnce({ cursor: 3, failureCount: 0, retryAt: null, input: nextInput }),
      applyTopicAnalysis: vi.fn().mockResolvedValue({
        ...snapshot,
        session: { ...snapshot.session, revision: 6 },
        topicAnalysisSkippedCaptionCount: 3
      }),
      recordTopicAnalysisFailure: vi.fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(5),
      skipTopicAnalysisBatch: vi.fn().mockResolvedValue({
        ...snapshot,
        session: { ...snapshot.session, revision: 5 },
        topicAnalysisSkippedCaptionCount: 3
      })
    } as unknown as SessionRepositoryPort;
    const events = { publish: vi.fn(), subscribe: vi.fn() };
    const analyzer = vi.fn()
      .mockRejectedValueOnce(new Error('invalid model output'))
      .mockRejectedValueOnce(new Error('invalid model output'))
      .mockRejectedValueOnce(new Error('invalid model output'))
      .mockRejectedValueOnce(new Error('invalid model output'))
      .mockRejectedValueOnce(new Error('invalid model output'))
      .mockResolvedValueOnce(nextResult);
    const worker = new TopicAnalysisWorker(repository, analyzer, events);

    await worker.wake();
    await worker.wake();
    await worker.wake();
    await worker.wake();
    await worker.wake();
    await worker.wake();

    expect(analyzer).toHaveBeenCalledTimes(6);
    expect(repository.recordTopicAnalysisFailure).toHaveBeenCalledTimes(5);
    expect(repository.skipTopicAnalysisBatch).toHaveBeenCalledWith('AB12CD34', 0, 3);
    expect(repository.applyTopicAnalysis).toHaveBeenCalledWith('AB12CD34', 3, 4, nextResult);
    expect(events.publish).toHaveBeenNthCalledWith(1, 'AB12CD34', {
      type: 'topic_updated',
      revision: 5,
      snapshot: expect.objectContaining({
        captions: input.captions,
        topicAnalysisSkippedCaptionCount: 3
      })
    });
    expect(events.publish).toHaveBeenNthCalledWith(2, 'AB12CD34', {
      type: 'topic_updated',
      revision: 6,
      snapshot: expect.objectContaining({
        session: expect.objectContaining({ revision: 6 }),
        topicAnalysisSkippedCaptionCount: 3
      })
    });
    worker.stop();
  });
});

describe('TopicAnalysisWorker presenter background', () => {
  // Synthetic test fixture: a labeled presenter passage used only as background
  const background = [{ id: 'material-1:0', title: 'Fixture slides', text: 'Fixture slide: shade lowers street temperature.' }];

  // Build a worker over one pending interval with a replaceable background provider
  function setup(provider: (sessionId: string, captions: unknown[]) => Promise<typeof background>) {
    const repository = {
      getPendingTopicSessionIds: vi.fn().mockResolvedValue(['AB12CD34']),
      getTopicAnalysisContext: vi.fn().mockResolvedValue({ cursor: 0, failureCount: 0, retryAt: null, input }),
      applyTopicAnalysis: vi.fn().mockResolvedValue(snapshot)
    } as unknown as SessionRepositoryPort;
    const analyzer = vi.fn().mockResolvedValue(result);
    const worker = new TopicAnalysisWorker(repository, analyzer, { publish: vi.fn(), subscribe: vi.fn() }, 2_000, provider);
    return { worker, analyzer, repository };
  }

  it('looks up background for the interval captions and passes it to the analyzer', async () => {
    const provider = vi.fn().mockResolvedValue(background);
    const { worker, analyzer, repository } = setup(provider);

    await worker.wake();

    expect(provider).toHaveBeenCalledWith('AB12CD34', input.captions);
    expect(analyzer).toHaveBeenCalledWith({ ...input, backgroundPassages: background });
    expect(repository.applyTopicAnalysis).toHaveBeenCalledWith('AB12CD34', 0, 3, result);
    worker.stop();
  });

  it('analyzes speech without background when the lookup fails', async () => {
    const { worker, analyzer, repository } = setup(vi.fn().mockRejectedValue(new Error('PRIVATE_SEARCH_MARKER')));

    await worker.wake();

    expect(analyzer).toHaveBeenCalledWith(input);
    expect(repository.applyTopicAnalysis).toHaveBeenCalledOnce();
    worker.stop();
  });
});
