import { Client } from '@elastic/elasticsearch';
import { trace } from '@opentelemetry/api';

import { env } from '../../../config/env';
import type { MaterialPassageView } from '../../sessions/public';
import type { MaterialSearchIndex } from '../contracts/materialSearch';

// Add the fields needed to filter documents to one room's ready passages
interface IndexedPassage extends Omit<MaterialPassageView, 'id'> {
  passageId: string;
  sessionId: string;
}

// Version the material mapping separately from caption documents
const INDEX_NAME = 'summit-thread-materials-v1';

// Search presenter material while requiring the backend's ready-passage allowlist
export class ElasticsearchMaterialIndex implements MaterialSearchIndex {
  private readonly client: Client;
  private indexReady: Promise<void> | undefined;

  constructor(client = new Client({ node: env.ELASTICSEARCH_URL, maxRetries: 1, requestTimeout: 5_000 })) {
    this.client = client;
  }

  async findPassages(sessionId: string, query: string, allowedPassageIds: string[], size = 5): Promise<MaterialPassageView[]> {
    if (!allowedPassageIds.length) return [];

    // Restrict Elastic results to passage IDs reloaded from PostgreSQL before retrieval
    return trace.getTracer('summit-thread.search').startActiveSpan('materials.search', async (span) => {
      span.setAttribute('session.id', sessionId);
      // Record query length without exposing attendee or caption text
      span.setAttribute('search.query.length', query.length);
      span.setAttribute('search.allowed_passage_count', allowedPassageIds.length);
      try {
        await this.ensureIndex();
        const result = await this.client.search<IndexedPassage>({
          index: INDEX_NAME,
          size,
          query: {
            bool: {
              filter: [
                { term: { sessionId } },
                { terms: { passageId: allowedPassageIds } }
              ],
              must: [{
                multi_match: {
                  query,
                  fields: ['text^2', 'materialTitle'],
                  type: 'best_fields',
                  operator: 'or',
                  minimum_should_match: '1'
                }
              }]
            }
          }
        });
        return result.hits.hits.flatMap((hit) => {
          const source = hit._source;
          return source ? [{
            id: source.passageId,
            materialId: source.materialId,
            materialTitle: source.materialTitle,
            pageNumber: source.pageNumber,
            text: source.text
          }] : [];
        });
      } catch (error) {
        // Send only a fixed error label because search errors can contain query details
        span.recordException(new Error('material search failed'));
        span.setStatus({ code: 2 });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async indexPassage(sessionId: string, passage: MaterialPassageView): Promise<void> {
    await trace.getTracer('summit-thread.search').startActiveSpan('materials.index', async (span) => {
      span.setAttribute('session.id', sessionId);
      try {
        await this.ensureIndex();
        // Reuse the passage ID so indexing retries replace the same document
        await this.client.index({
          index: INDEX_NAME,
          id: passage.id,
          document: {
            passageId: passage.id,
            sessionId,
            materialId: passage.materialId,
            materialTitle: passage.materialTitle,
            pageNumber: passage.pageNumber,
            text: passage.text
          } satisfies IndexedPassage,
          refresh: 'wait_for'
        });
      } catch (error) {
        // Keep material-bearing index errors out of span events
        span.recordException(new Error('material index write failed'));
        span.setStatus({ code: 2 });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async deleteMaterial(sessionId: string, materialId: string): Promise<void> {
    await this.ensureIndex();
    await this.client.deleteByQuery({
      index: INDEX_NAME,
      query: { bool: { filter: [{ term: { sessionId } }, { term: { materialId } }] } },
      refresh: true,
      conflicts: 'proceed'
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureIndex();
    await this.client.deleteByQuery({
      index: INDEX_NAME,
      query: { term: { sessionId } },
      refresh: true,
      conflicts: 'proceed'
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async ensureIndex(): Promise<void> {
    if (!this.indexReady) {
      this.indexReady = this.createIndexIfMissing().catch((error: unknown) => {
        // Clear failed initialization so the next request can retry
        this.indexReady = undefined;
        throw error;
      });
    }
    await this.indexReady;
  }

  private async createIndexIfMissing(): Promise<void> {
    const exists = await this.client.indices.exists({ index: INDEX_NAME });
    if (exists) return;
    try {
      await this.client.indices.create({
        index: INDEX_NAME,
        mappings: {
          properties: {
            passageId: { type: 'keyword' },
            sessionId: { type: 'keyword' },
            materialId: { type: 'keyword' },
            materialTitle: { type: 'text' },
            pageNumber: { type: 'integer' },
            text: { type: 'text' }
          }
        }
      });
    } catch (error) {
      // Accept only a concurrent creator of the same versioned index
      const type = (error as { meta?: { body?: { error?: { type?: string } } } })?.meta?.body?.error?.type;
      if (type !== 'resource_already_exists_exception') throw error;
    }
  }
}
