import { describe, expect, it } from 'vitest';
import { SessionIndexingWorker } from './sessionIndexingWorker';
import type { CaptionView } from '../contracts/session.contract';
import type { CaptionIndexJob } from '../contracts/releasedContent';
import type { CaptionSearchIndex } from '../../search/public';

describe('durable indexing worker', () => {
  it('retains failed jobs and indexes them with stable IDs after recovery', async () => {
    const jobs: CaptionIndexJob[] = [{ id: 'job', operation: 'index_caption', sessionId: 'A5000001', caption: { id: 'stable', sequence: 0, text: 'SYNTHETIC_CAPTION', timestampMs: 1000 }, topic: null }];
    let available = false;
    const indexed: string[] = [];
    const worker = new SessionIndexingWorker({
      getNextIndexJob: async () => jobs[0] ?? null,
      finishIndexJob: async () => { jobs.shift(); }
    }, { indexCaption: async (_room: string, caption: CaptionView) => { if (!available) throw new Error('PRIVATE_PROVIDER_MARKER'); indexed.push(caption.id); } } as unknown as CaptionSearchIndex);
    await worker.drain();
    expect(jobs).toHaveLength(1);
    available = true;
    await worker.drain();
    expect(jobs).toHaveLength(0);
    expect(indexed).toEqual(['stable']);
  });
});

describe('index worker shutdown', () => {
  it('waits for the active index write before stopping', async () => {
    let release: () => void = () => {};
    const written = new Promise<void>(resolve => { release = resolve; });
    let pending = true;
    let started: () => void = () => {};
    const writing = new Promise<void>(resolve => { started = resolve; });
    const worker = new SessionIndexingWorker({
      getNextIndexJob: async () => pending ? { id: 'job', operation: 'index_caption', sessionId: 'A5000001', caption: { id: 'caption', text: 'Synthetic', timestampMs: 0, sequence: 0 }, topic: null } : null,
      finishIndexJob: async () => { pending = false; }
    }, { indexCaption: async () => { started(); await written; } } as unknown as CaptionSearchIndex);
    const drain = worker.drain(); await writing;
    let stopped = false;
    const stop = Promise.resolve(worker.stop()).then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release(); await drain; await stop;
    expect(pending).toBe(false);
  });
});
