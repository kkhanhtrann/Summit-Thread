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

describe('presenter material indexing', () => {
  // Synthetic test fixture: a labeled passage, not real presenter material
  const passage = { id: 'material-1:0', materialId: 'material-1', materialTitle: 'Fixture notes', pageNumber: null, text: 'Fixture passage' };

  it('indexes ready passages, removes deleted materials, and clears a room from both indexes', async () => {
    const jobs: CaptionIndexJob[] = [
      { id: 'a', operation: 'index_material_passage', sessionId: 'A5000002', caption: null, topic: null, passage },
      { id: 'b', operation: 'delete_material', sessionId: 'A5000002', caption: null, topic: null, materialId: 'material-1' },
      { id: 'c', operation: 'delete_session', sessionId: 'A5000002', caption: null, topic: null }
    ];
    const calls: string[] = [];
    const worker = new SessionIndexingWorker(
      { getNextIndexJob: async () => jobs[0] ?? null, finishIndexJob: async () => { jobs.shift(); } },
      { deleteSession: async () => { calls.push('captions:deleteSession'); } } as unknown as CaptionSearchIndex,
      1_500,
      {
        indexPassage: async (_room: string, value: { id: string }) => { calls.push(`materials:index:${value.id}`); },
        deleteMaterial: async (_room: string, id: string) => { calls.push(`materials:delete:${id}`); },
        deleteSession: async () => { calls.push('materials:deleteSession'); },
        findPassages: async () => []
      }
    );

    await worker.drain();

    expect(jobs).toHaveLength(0);
    expect(calls).toEqual([
      'materials:index:material-1:0',
      'materials:delete:material-1',
      'captions:deleteSession',
      'materials:deleteSession'
    ]);
  });

  it('acknowledges a passage job whose material is no longer ready without indexing it', async () => {
    const jobs: CaptionIndexJob[] = [{ id: 'a', operation: 'index_material_passage', sessionId: 'A5000003', caption: null, topic: null, passage: null }];
    let indexed = false;
    const worker = new SessionIndexingWorker(
      { getNextIndexJob: async () => jobs[0] ?? null, finishIndexJob: async () => { jobs.shift(); } },
      {} as CaptionSearchIndex,
      1_500,
      { indexPassage: async () => { indexed = true; }, deleteMaterial: async () => {}, deleteSession: async () => {}, findPassages: async () => [] }
    );

    await worker.drain();

    expect(jobs).toHaveLength(0);
    expect(indexed).toBe(false);
  });
});

describe('material jobs without a material index', () => {
  it('leaves the job pending instead of acknowledging it', async () => {
    const jobs: CaptionIndexJob[] = [{ id: 'a', operation: 'index_material_passage', sessionId: 'A5000004', caption: null, topic: null, passage: { id: 'm:0', materialId: 'm', materialTitle: 'Fixture', pageNumber: null, text: 'Fixture passage' } }];
    const worker = new SessionIndexingWorker(
      { getNextIndexJob: async () => jobs[0] ?? null, finishIndexJob: async () => { jobs.shift(); } },
      {} as CaptionSearchIndex
    );

    await worker.drain();

    expect(jobs).toHaveLength(1);
  });
});
