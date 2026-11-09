import { describe, expect, it, vi } from 'vitest';

import { createMaterialBackgroundProvider } from './materialBackground';

// Synthetic test fixtures: labeled captions and presenter passages
const captions = [
  { id: 'c-0', sequence: 0, timestampMs: 0, text: 'Fixture line about shaded streets.' },
  { id: 'c-1', sequence: 1, timestampMs: 1_000, text: 'Fixture line about cooler sidewalks.' }
];
const passage = (id: string, text = 'Fixture slide text.') => ({ id, materialId: 'm-1', materialTitle: 'Fixture slides', pageNumber: 1, text });

describe('createMaterialBackgroundProvider', () => {
  it('searches ready passages with the interval caption text', async () => {
    const searchPassages = vi.fn().mockResolvedValue([passage('m-1:0')]);
    const provider = createMaterialBackgroundProvider({ getReadyPassages: vi.fn().mockResolvedValue([passage('m-1:0'), passage('m-1:1')]), searchPassages });

    await expect(provider('AB12CD34', captions)).resolves.toEqual([{ id: 'm-1:0', title: 'Fixture slides', text: 'Fixture slide text.' }]);
    expect(searchPassages).toHaveBeenCalledWith('AB12CD34', 'Fixture line about shaded streets. Fixture line about cooler sidewalks.', ['m-1:0', 'm-1:1'], 5);
  });

  it('skips search when the room has no ready material', async () => {
    const searchPassages = vi.fn();
    const provider = createMaterialBackgroundProvider({ getReadyPassages: vi.fn().mockResolvedValue([]), searchPassages });

    await expect(provider('AB12CD34', captions)).resolves.toEqual([]);
    expect(searchPassages).not.toHaveBeenCalled();
  });

  it('drops hits that are not ready passages and caps total background text', async () => {
    const long = (id: string) => passage(id, 'x'.repeat(1_200));
    const ready = [long('m-1:0'), long('m-1:1'), long('m-1:2'), long('m-1:3')];
    const provider = createMaterialBackgroundProvider({
      getReadyPassages: vi.fn().mockResolvedValue(ready),
      searchPassages: vi.fn().mockResolvedValue([passage('foreign:0'), ...ready])
    });

    const background = await provider('AB12CD34', captions);

    expect(background.map((item) => item.id)).toEqual(['m-1:0', 'm-1:1', 'm-1:2']);
  });
});
