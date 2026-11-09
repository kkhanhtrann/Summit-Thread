import { trace } from '@opentelemetry/api';

import type { CaptionSearchIndex } from '../../search/public';
import { logger } from '../../../platform/logging/logger';
import type { IndexQueueRepository } from '../contracts/releasedContent';

// Drain durable search jobs serially and retry failures on the next interval
export class SessionIndexingWorker {
  private active: Promise<void> | undefined;
  private interval: NodeJS.Timeout | undefined;

  constructor(
    private readonly repository: IndexQueueRepository,
    private readonly search: CaptionSearchIndex,
    private readonly retryMs = 1_500
  ) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.drain(), this.retryMs);
    this.interval.unref?.();
    void this.drain();
  }

  wake(): void {
    void this.drain();
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    await this.active;
  }

  // Share the in-flight drain between timer, release wakeups and shutdown
  drain(): Promise<void> {
    this.active ??= this.run().finally(() => { this.active = undefined; });
    return this.active;
  }

  private async run(): Promise<void> {

    try {
      while (true) {
        const job = await this.repository.getNextIndexJob();
        if (!job) return;

        try {
          await trace.getTracer('summit-thread.search').startActiveSpan('caption.index_job', async (span) => {
            span.setAttribute('session.id', job.sessionId);
            span.setAttribute('index.operation', job.operation);
            try {
              if (job.operation === 'delete_session') {
                await this.search.deleteSession(job.sessionId);
              } else if (job.caption) {
                await this.search.indexCaption(job.sessionId, job.caption, job.topic ?? undefined);
              }
              await this.repository.finishIndexJob(job.id);
            } catch (error) {
              // Avoid recording index errors that may include released speech
              span.recordException(new Error('caption index job failed'));
              span.setStatus({ code: 2 });
              throw error;
            } finally {
              span.end();
            }
          });
        } catch (error) {
          // Leave the durable job pending so the next interval can retry it
          logger.warn({
            event: 'caption_index_pending',
            sessionId: job.sessionId,
            operation: job.operation,
            errorType: 'index_dependency_failed'
          });
          return;
        }
      }
    } catch (error) {
      logger.error({
        event: 'caption_index_worker_failed',
        errorType: 'index_dependency_failed'
      });
    }
  }
}
