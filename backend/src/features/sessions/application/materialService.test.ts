import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { MATERIAL_LIMITS, MaterialTooLargeError, MaterialUnreadableError, type MaterialView } from '../contracts/material.contract';
import { MaterialService, type MaterialRepository } from './materialService';

// Build an in-memory repository that records completed passages
function setup(extractPdf = vi.fn()) {
  const completed: Array<{ materialId: string; pageCount: number | null; passages: Array<{ pageNumber: number | null; text: string }> }> = [];
  const failed: string[] = [];
  const view = (id: string, patch: Partial<MaterialView> = {}): MaterialView => ({
    id, kind: 'text', title: 'Fixture', status: 'processing', pageCount: null, passageCount: 0, createdAt: '2026-11-09T00:00:00.000Z', ...patch
  });
  const begun = new Map<string, MaterialView>();
  const repository: MaterialRepository = {
    beginMaterial: vi.fn(async (_room, material) => {
      const value = view(material.id, { kind: material.kind, title: material.title });
      begun.set(material.id, value);
      return value;
    }),
    completeMaterial: vi.fn(async (_room, materialId, result) => {
      completed.push({ materialId, ...result });
      return { ...begun.get(materialId)!, status: (result.passages.length ? 'ready' : 'empty') as MaterialView['status'], pageCount: result.pageCount, passageCount: result.passages.length };
    }),
    failMaterial: vi.fn(async (_room, materialId) => { failed.push(materialId); }),
    listMaterials: vi.fn(async () => []),
    deleteMaterial: vi.fn(async () => undefined),
    failInterruptedMaterials: vi.fn(async () => undefined),
    getReadyPassages: vi.fn(async () => [])
  };
  const indexer = { wake: vi.fn() };
  return { service: new MaterialService({ repository, extractPdf, indexer }), repository, indexer, completed, failed };
}

describe('MaterialService', () => {
  it('stores pasted notes as page-less passages and wakes indexing', async () => {
    const { service, completed, indexer } = setup();

    const material = await service.addText('AB12CD34', { title: ' Fixture notes ', text: 'Fixture note about cool roofs.' });

    expect(material).toMatchObject({ title: 'Fixture notes', status: 'ready', passageCount: 1 });
    expect(completed[0]).toMatchObject({ pageCount: null, passages: [{ pageNumber: null, text: 'Fixture note about cool roofs.' }] });
    expect(indexer.wake).toHaveBeenCalledOnce();
  });

  it('rejects empty or oversized notes before storing anything', async () => {
    const { service, repository } = setup();

    await expect(service.addText('AB12CD34', { title: 'Fixture', text: '   ' })).rejects.toBeInstanceOf(ZodError);
    await expect(service.addText('AB12CD34', { title: 'Fixture', text: 'x'.repeat(MATERIAL_LIMITS.textMaxLength + 1) })).rejects.toBeInstanceOf(ZodError);
    expect(repository.beginMaterial).not.toHaveBeenCalled();
  });

  it('extracts PDF pages into passages that keep their page numbers', async () => {
    const extractPdf = vi.fn(async () => ({ pageCount: 2, pages: [{ pageNumber: 1, text: 'Fixture slide one.' }, { pageNumber: 2, text: '' }] }));
    const { service, completed } = setup(extractPdf);

    const material = await service.addPdf('AB12CD34', 'Fixture slides', new Uint8Array([1]));

    expect(material).toMatchObject({ kind: 'pdf', status: 'ready', pageCount: 2 });
    expect(completed[0]!.passages).toEqual([{ pageNumber: 1, text: 'Fixture slide one.' }]);
  });

  it('reports an image-only PDF as empty instead of failing', async () => {
    const { service } = setup(vi.fn(async () => ({ pageCount: 1, pages: [{ pageNumber: 1, text: '' }] })));
    await expect(service.addPdf('AB12CD34', 'Fixture scan', new Uint8Array([1]))).resolves.toMatchObject({ status: 'empty' });
  });

  it('rejects an oversized PDF before creating a material', async () => {
    const { service, repository } = setup();
    await expect(service.addPdf('AB12CD34', 'Fixture', new Uint8Array(MATERIAL_LIMITS.pdfMaxBytes + 1))).rejects.toBeInstanceOf(MaterialTooLargeError);
    expect(repository.beginMaterial).not.toHaveBeenCalled();
  });

  it('marks unreadable or over-page-limit PDFs failed and keeps the error type', async () => {
    const unreadable = setup(vi.fn(async () => { throw new MaterialUnreadableError(); }));
    await expect(unreadable.service.addPdf('AB12CD34', 'Fixture', new Uint8Array([1]))).rejects.toBeInstanceOf(MaterialUnreadableError);
    expect(unreadable.failed).toHaveLength(1);

    const tooManyPages = setup(vi.fn(async () => { throw new MaterialTooLargeError(); }));
    await expect(tooManyPages.service.addPdf('AB12CD34', 'Fixture', new Uint8Array([1]))).rejects.toBeInstanceOf(MaterialTooLargeError);
    expect(tooManyPages.failed).toHaveLength(1);
    expect(tooManyPages.indexer.wake).not.toHaveBeenCalled();
  });

  it('removes a material and wakes indexing so its search documents are deleted', async () => {
    const { service, repository, indexer } = setup();
    await service.remove('AB12CD34', 'material-1');
    expect(repository.deleteMaterial).toHaveBeenCalledWith('AB12CD34', 'material-1');
    expect(indexer.wake).toHaveBeenCalledOnce();
  });
});
