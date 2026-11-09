import { trace } from '@opentelemetry/api';

import type { TopicAnalyzer } from '../../../platform/ai/topicAnalysis';
import { readProviderFailure } from '../../../platform/ai/providerFailure';
import { logger } from '../../../platform/logging/logger';
import type { SessionEventPort, SessionRepositoryPort, TopicAnalysisContext } from './session.service';

// Give attendees an initial topic after three finalized captions
const INITIAL_LIVE_TOPIC_BATCH_SIZE = 3;
// Stop charging for a batch that repeatedly fails validation or persistence
const MAX_TOPIC_ANALYSIS_FAILURES = 5;
// Space out repeated provider failures before a caption batch is left ungrouped
const TOPIC_ANALYSIS_RETRY_BASE_MS = 2_000;
// Cap the delay before another topic analysis attempt
const TOPIC_ANALYSIS_RETRY_MAX_MS = 32_000;

// Analyze released caption batches and persist stable topic occurrences
export class TopicAnalysisWorker {
  private running = false;
  // Stop all rooms from spending requests against the same exhausted quota
  private quotaRetryAt = 0;
  private interval: NodeJS.Timeout | undefined;
  // Retain interval-triggered refreshes received while another batch is running
  private forceAllPending = false;
  private readonly forcedSessions = new Set<string>();
  // Retry interval requests that could not persist their caption watermark
  private readonly pendingRequests = new Set<string | undefined>();

  constructor(
    private readonly repository: SessionRepositoryPort,
    private readonly analyzer: TopicAnalyzer,
    private readonly events: SessionEventPort,
    private readonly retryMs = 2_000
  ) {}

  // Retry pending batches and flush paused rooms after startup
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.drain(), this.retryMs);
    this.interval.unref?.();
    void this.drain();
  }

  // Wake analysis after new speech, a room pause, or the selected interval
  async wake(force = false, sessionId?: string): Promise<void> {
    if (force && !await this.requestInterval(sessionId)) return;
    return this.drain();
  }

  // Retain failed scheduling work without rejecting an ignored notifier promise
  private async requestInterval(sessionId?: string): Promise<boolean> {
    this.pendingRequests.delete(sessionId);
    try {
      // Freeze the released-caption boundary before another request can hold the worker
      await this.repository.requestTopicAnalysis(sessionId);
      if (sessionId) this.forcedSessions.add(sessionId);
      else this.forceAllPending = true;
      return true;
    } catch (error) {
      this.pendingRequests.add(sessionId);
      logger.warn({ event: 'topic_analysis_request_pending', sessionId, errorType: error instanceof Error ? error.name : 'UnknownError' });
      return false;
    }
  }

  // Stop the retry timer during API shutdown
  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  private async drain(): Promise<void> {
    // Serialize timer and caption-release wakeups into one durable cursor worker
    if (this.running || this.quotaRetryAt > Date.now()) return;
    this.running = true;

    try {
      for (const sessionId of [...this.pendingRequests]) await this.requestInterval(sessionId);
      const forceAll = this.forceAllPending;
      const forcedSessions = [...this.forcedSessions];
      this.forceAllPending = false;
      this.forcedSessions.clear();
      const sessionIds = forceAll
        ? await this.repository.getPendingTopicSessionIds(INITIAL_LIVE_TOPIC_BATCH_SIZE)
        : forcedSessions.length
          ? [...new Set((await Promise.all(forcedSessions.map((sessionId) =>
            this.repository.getPendingTopicSessionIds(INITIAL_LIVE_TOPIC_BATCH_SIZE, false, sessionId)
          ))).flat())]
          : await this.repository.getPendingTopicSessionIds(INITIAL_LIVE_TOPIC_BATCH_SIZE);
      for (const sessionId of sessionIds) {
        await this.analyzeSession(sessionId);
        if (this.quotaRetryAt > Date.now()) break;
      }
    } catch (error) {
      logger.error({
        event: 'topic_analysis_worker_failed',
        errorType: error instanceof Error ? error.name : 'UnknownError'
      });
    } finally {
      this.running = false;
      // Drain refreshes queued while the active batch held the worker slot
      if (this.forceAllPending || this.forcedSessions.size > 0) void this.drain();
    }
  }

  private async analyzeSession(sessionId: string): Promise<void> {
    let context: TopicAnalysisContext | null;
    try {
      context = await this.repository.getTopicAnalysisContext(sessionId);
    } catch (error) {
      logger.warn({
        event: 'topic_analysis_pending',
        sessionId,
        errorType: error instanceof Error ? error.name : 'UnknownError'
      });
      return;
    }
    if (!context?.input.captions.length) return;
    const throughSequence = context.input.captions.at(-1)!.sequence + 1;

    // Honor persisted provider backoff before another analysis attempt
    if (context.retryAt && context.retryAt.getTime() > Date.now()) return;
    if (context.failureCount >= MAX_TOPIC_ANALYSIS_FAILURES) {
      await this.skipFailedBatch(sessionId, context.cursor, throughSequence);
      return;
    }

    try {
      const snapshot = await trace.getTracer('summit-thread.topics').startActiveSpan('topic.analyze_batch', async (span) => {
        span.setAttribute('session.id', sessionId);
        span.setAttribute('topic.caption_count', context.input.captions.length);
        try {
          const result = await this.analyzer(context.input);
          span.setAttribute('topic.segment_count', result.segments.length);
          span.setAttribute('topic.suggestion_count', result.segments.reduce((count, segment) => count + segment.suggestedQuestions.length, 0));
          const applied = await this.repository.applyTopicAnalysis(sessionId, context.cursor, throughSequence, result);
          if (!applied) throw new Error('Topic analysis no longer matches the released captions');
          return applied;
        } catch (error) {
          // Avoid recording analysis errors that may include released speech
          span.recordException(new Error('topic analysis batch failed'));
          span.setStatus({ code: 2 });
          throw error;
        } finally {
          span.end();
        }
      });

      if (snapshot) {
        this.events.publish(sessionId, {
          type: 'topic_updated',
          revision: snapshot.session.revision,
          snapshot
        });
      }
    } catch (error) {
      const failure = readProviderFailure(error);
      if (failure.statusCode === 429) {
        const retryAfterMs = failure.retryAfterMs!;
        this.quotaRetryAt = Date.now() + retryAfterMs;
        await this.repository.deferTopicAnalysis(retryAfterMs);
        logger.warn({ event: 'topic_analysis_quota_exhausted', statusCode: 429, retryAfterMs });
        return;
      }
      const retryAfterMs = Math.min(
        TOPIC_ANALYSIS_RETRY_MAX_MS,
        TOPIC_ANALYSIS_RETRY_BASE_MS * 2 ** context.failureCount
      );
      await this.recordFailure(sessionId, context.cursor, throughSequence, retryAfterMs, error);
    }
  }

  // Persist failure counts so restarts cannot restart the same model retry loop
  private async recordFailure(
    sessionId: string,
    cursor: number,
    throughSequence: number,
    retryAfterMs: number,
    error: unknown
  ): Promise<void> {
    try {
      const failureCount = await this.repository.recordTopicAnalysisFailure(sessionId, cursor, throughSequence, retryAfterMs);
      if (failureCount === null) return;
      if (failureCount >= MAX_TOPIC_ANALYSIS_FAILURES) {
        await this.skipFailedBatch(sessionId, cursor, throughSequence);
        return;
      }
      logger.warn({
        event: 'topic_analysis_retry_scheduled',
        sessionId,
        failureCount,
        retryAfterMs,
        statusCode: readProviderFailure(error).statusCode,
        errorType: error instanceof Error ? error.name : 'UnknownError'
      });
    } catch (recoveryError) {
      logger.warn({
        event: 'topic_analysis_recovery_failed',
        sessionId,
        errorType: recoveryError instanceof Error ? recoveryError.name : 'UnknownError'
      });
    }
  }

  // Leave released speech visible while later batches continue forming topics
  private async skipFailedBatch(sessionId: string, cursor: number, throughSequence: number): Promise<void> {
    try {
      const snapshot = await this.repository.skipTopicAnalysisBatch(sessionId, cursor, throughSequence);
      if (!snapshot) return;
      this.events.publish(sessionId, {
        type: 'topic_updated',
        revision: snapshot.session.revision,
        snapshot
      });
      logger.warn({
        event: 'topic_analysis_batch_skipped',
        sessionId,
        captionCount: throughSequence - cursor
      });
    } catch (error) {
      // Keep the durable cursor pending so the lightweight recovery write can retry
      logger.warn({
        event: 'topic_analysis_skip_pending',
        sessionId,
        errorType: error instanceof Error ? error.name : 'UnknownError'
      });
    }
  }
}
