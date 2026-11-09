import { describe, expect, it, vi } from 'vitest';

import { createMaterialBackgroundProvider } from './materialBackground';

// Synthetic test fixtures: labeled captions and presenter passages
const captions = [
  { id: 'c-0', sequence: 0, timestampMs: 0, text: 'Fixture line about shaded streets.' },
  { id: 'c-1', sequence: 1, timestampMs: 1_000, text: 'Fixture line about cooler sidewalks.' }
];
const passage = (id: string, text = 'Fixture slide text.') => ({ id, materialId: 'm-1', materialTitle: 'Fixture slides', pageNumber: 1, text });

// Compose the provider over an in-memory room of ready passages
function provider(ready: ReturnType<typeof passage>[], hits: Array<{ id: string }>) {
  const ports = {
    getReadyPassageIds: vi.fn(async () => ready.map((item) => item.id)),
    getReadyPassagesByIds: vi.fn(async (_room: string, ids: string[]) => ready.filter((item) => ids.includes(item.id))),
    searchPassages: vi.fn(async () => hits)
  };
  return { lookup: createMaterialBackgroundProvider(ports), ports };
}

describe('createMaterialBackgroundProvider', () => {
  it('searches ready passages with the interval caption text and loads text only for hits', async () => {
    const { lookup, ports } = provider([passage('m-1:0'), passage('m-1:1')], [{ id: 'm-1:0' }]);

    await expect(lookup('AB12CD34', captions)).resolves.toEqual([{ id: 'm-1:0', title: 'Fixture slides', text: 'Fixture slide text.' }]);
    expect(ports.searchPassages).toHaveBeenCalledWith('AB12CD34', 'Fixture line about shaded streets. Fixture line about cooler sidewalks.', ['m-1:0', 'm-1:1'], 5);
    expect(ports.getReadyPassagesByIds).toHaveBeenCalledWith('AB12CD34', ['m-1:0']);
  });

  it('skips search when the room has no ready material', async () => {
    const { lookup, ports } = provider([], []);

    await expect(lookup('AB12CD34', captions)).resolves.toEqual([]);
    expect(ports.searchPassages).not.toHaveBeenCalled();
  });

  it('drops hits that are not ready passages and caps total background text', async () => {
    const long = (id: string) => passage(id, 'x'.repeat(1_200));
    const ready = [long('m-1:0'), long('m-1:1'), long('m-1:2'), long('m-1:3')];
    const { lookup, ports } = provider(ready, [{ id: 'foreign:0' }, ...ready]);

    const background = await lookup('AB12CD34', captions);

    expect(background.map((item) => item.id)).toEqual(['m-1:0', 'm-1:1', 'm-1:2']);
    expect(ports.getReadyPassagesByIds.mock.calls[0]![1]).not.toContain('foreign:0');
  });
});
