import type { Client } from '@elastic/elasticsearch';
import { describe, expect, it, vi } from 'vitest';

import { ElasticsearchCaptionIndex } from './elasticsearchCaptionIndex';

describe('ElasticsearchCaptionIndex', () => {
  it('keeps natural-language chat retrieval tolerant while filtering released caption IDs', async () => {
    const search = vi.fn().mockResolvedValue({ hits: { hits: [] } });
    const client = {
      indices: { exists: vi.fn().mockResolvedValue(true) },
      search
    } as unknown as Client;
    const index = new ElasticsearchCaptionIndex(client);

    await index.findReleasedCaptions('AB12CD34', 'What place did the speaker mention people were trying to reach?', ['released-caption']);

    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: {
        bool: {
          filter: [
            { term: { sessionId: 'AB12CD34' } },
            { terms: { captionId: ['released-caption'] } }
          ],
          must: [{
            multi_match: {
              query: 'What place did the speaker mention people were trying to reach?',
              fields: ['text^2', 'topicTitle', 'topicSummary'],
              type: 'best_fields',
              operator: 'or',
              minimum_should_match: '1'
            }
          }]
        }
      }
    }));
  });

  it('indexes topic context with a caption so private retrieval can find related moments', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const client = {
      indices: { exists: vi.fn().mockResolvedValue(true) },
      index: write
    } as unknown as Client;
    const index = new ElasticsearchCaptionIndex(client);

    await index.indexCaption('AB12CD34', {
      id: 'released-caption', sequence: 0, timestampMs: 1_000, text: 'The roof stays cool overnight.'
    }, { title: 'Cooling roofs', summary: 'Reflective roofs reduce city heat.' });

    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      index: 'summit-thread-captions-v1',
      id: 'released-caption',
      document: expect.objectContaining({
        topicTitle: 'Cooling roofs',
        topicSummary: 'Reflective roofs reduce city heat.'
      })
    }));
  });
});

it('accepts an index concurrently created by another runtime client', async () => {
  const client = {
    indices: { exists: vi.fn().mockResolvedValue(false), create: vi.fn().mockRejectedValue({ meta: { body: { error: { type: 'resource_already_exists_exception' } } } }) },
    search: vi.fn().mockResolvedValue({ hits: { hits: [] } })
  } as unknown as Client;
  await expect(new ElasticsearchCaptionIndex(client).findReleasedCaptions('A5000001', 'shade', ['released'])).resolves.toEqual([]);
});
