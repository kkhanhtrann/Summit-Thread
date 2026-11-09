import { Client } from '@elastic/elasticsearch';
import { trace } from '@opentelemetry/api';

import { env } from '../../../config/env';
import type { CaptionView } from '../../sessions/public';
import type { CaptionSearchIndex } from '../contracts/captionSearch';

// Add the fields needed to filter documents to one released room caption
interface IndexedCaption extends CaptionView {
  captionId: string;
  sessionId: string;
  topicTitle?: string;
  topicSummary?: string;
}

// Version the caption mapping so schema changes can use a new index
const INDEX_NAME = 'summit-thread-captions-v1';

// Search caption text while requiring the backend's released-ID allowlist
export class ElasticsearchCaptionIndex implements CaptionSearchIndex {
  private readonly client: Client;
  private indexReady: Promise<void> | undefined;

  constructor(client = new Client({ node: env.ELASTICSEARCH_URL, maxRetries: 1, requestTimeout: 5_000 })) {
    this.client = client;
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async findReleasedCaptions(sessionId: string, query: string, allowedCaptionIds: string[]): Promise<CaptionView[]> {
    if (!allowedCaptionIds.length) return [];

    // Restrict Elastic results to IDs reloaded from PostgreSQL before retrieval
    return trace.getTracer('summit-thread.search').startActiveSpan('captions.search', async (span) => {
      span.setAttribute('session.id', sessionId);
      // Record query length without exposing attendee search terms
      span.setAttribute('search.query.length', query.length);
      span.setAttribute('search.allowed_caption_count', allowedCaptionIds.length);
      try {
        await this.ensureIndex();
        const result = await this.client.search<IndexedCaption>({
          index: INDEX_NAME,
          size: 20,
          query: {
            bool: {
              filter: [
                { term: { sessionId } },
                { terms: { captionId: allowedCaptionIds } }
              ],
              must: [{
                multi_match: {
                  query,
                  fields: ['text^2', 'topicTitle', 'topicSummary'],
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
            id: source.captionId,
            sequence: source.sequence,
            timestampMs: source.timestampMs,
            text: source.text
          }] : [];
        });
      } catch (error) {
        // Send only a fixed error label because provider errors can contain query details
        span.recordException(new Error('caption search failed'));
        span.setStatus({ code: 2 });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async indexCaption(sessionId: string, caption: CaptionView, topic?: { title: string; summary: string }): Promise<void> {
    await trace.getTracer('summit-thread.search').startActiveSpan('captions.index', async (span) => {
      span.setAttribute('session.id', sessionId);
      span.setAttribute('caption.sequence', caption.sequence);
      try {
        await this.ensureIndex();
        // Reuse the caption ID so indexing retries replace the same document
        await this.client.index({
          index: INDEX_NAME,
          id: caption.id,
          document: {
            ...caption,
            captionId: caption.id,
            sessionId,
            ...(topic ? { topicTitle: topic.title, topicSummary: topic.summary } : {})
          },
          refresh: 'wait_for'
        });
      } catch (error) {
        // Keep transcript-bearing index errors out of span events
        span.recordException(new Error('caption index write failed'));
        span.setStatus({ code: 2 });
        throw error;
      } finally {
        span.end();
      }
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
          captionId: { type: 'keyword' },
          sessionId: { type: 'keyword' },
          sequence: { type: 'integer' },
          timestampMs: { type: 'integer' },
          text: { type: 'text' },
          topicTitle: { type: 'text' },
          topicSummary: { type: 'text' }
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
