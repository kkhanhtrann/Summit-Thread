import type { Client } from '@elastic/elasticsearch';
import { describe, expect, it, vi } from 'vitest';

import { ElasticsearchMaterialIndex } from './elasticsearchMaterialIndex';

// Synthetic test fixture: a labeled presenter passage, not real material
const passage = {
  id: 'material-1:0',
  materialId: 'material-1',
  materialTitle: 'Fixture slides',
  pageNumber: 4,
  text: 'Fixture passage: reflective roofs lower surface temperatures.'
};

describe('ElasticsearchMaterialIndex', () => {
  it('searches only the room and the passage IDs reloaded from PostgreSQL', async () => {
    const search = vi.fn().mockResolvedValue({ hits: { hits: [{ _source: { ...passage, passageId: passage.id, sessionId: 'AB12CD34' } }] } });
    const client = { indices: { exists: vi.fn().mockResolvedValue(true) }, search } as unknown as Client;

    const hits = await new ElasticsearchMaterialIndex(client).findPassages('AB12CD34', 'roof temperature', [passage.id], 3);

    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      index: 'summit-thread-materials-v1',
      size: 3,
      query: {
        bool: {
          filter: [
            { term: { sessionId: 'AB12CD34' } },
            { terms: { passageId: [passage.id] } }
          ],
          must: [{
            multi_match: {
              query: 'roof temperature',
              fields: ['text^2', 'materialTitle'],
              type: 'best_fields',
              operator: 'or',
              minimum_should_match: '1'
            }
          }]
        }
      }
    }));
    expect(hits).toEqual([passage]);
  });

  it('skips the search when no passage is ready', async () => {
    const search = vi.fn();
    const client = { indices: { exists: vi.fn().mockResolvedValue(true) }, search } as unknown as Client;

    await expect(new ElasticsearchMaterialIndex(client).findPassages('AB12CD34', 'roofs', [])).resolves.toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('indexes a passage under its stable ID so retries replace the same document', async () => {
    const index = vi.fn().mockResolvedValue(undefined);
    const client = { indices: { exists: vi.fn().mockResolvedValue(true) }, index } as unknown as Client;

    await new ElasticsearchMaterialIndex(client).indexPassage('AB12CD34', passage);

    expect(index).toHaveBeenCalledWith(expect.objectContaining({
      index: 'summit-thread-materials-v1',
      id: passage.id,
      document: expect.objectContaining({ passageId: passage.id, sessionId: 'AB12CD34', materialId: 'material-1', pageNumber: 4 })
    }));
  });

  it('removes every document of one material within its room', async () => {
    const deleteByQuery = vi.fn().mockResolvedValue(undefined);
    const client = { indices: { exists: vi.fn().mockResolvedValue(true) }, deleteByQuery } as unknown as Client;

    await new ElasticsearchMaterialIndex(client).deleteMaterial('AB12CD34', 'material-1');

    expect(deleteByQuery).toHaveBeenCalledWith(expect.objectContaining({
      index: 'summit-thread-materials-v1',
      query: { bool: { filter: [{ term: { sessionId: 'AB12CD34' } }, { term: { materialId: 'material-1' } }] } }
    }));
  });
});
