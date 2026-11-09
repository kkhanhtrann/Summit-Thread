import type { AnswerGenerator } from '../../../platform/ai/groundedAnswer';
import { metrics } from '@opentelemetry/api';
import { AiUnavailableError } from '../../../platform/ai/aiUnavailableError';
import type { PrivateChatRequest, PrivateChatResponse } from '../contracts/privateChat.contract';

// Describe the persisted caption fields used to ground an answer
interface ReleasedCaption {
  id: string;
  timestampMs: number;
  text: string;
}

// Define persistence and model ports required for private answers
export interface PrivateChatDependencies {
  sessions: {
    getReleasedCaptions(sessionId: string): Promise<ReleasedCaption[]>;
    searchReleasedCaptions(sessionId: string, query: string): Promise<ReleasedCaption[]>;
  };
  generateAnswer?: AnswerGenerator;
}

// Return a clear abstention when released evidence is missing
const NO_GROUNDED_ANSWER = 'The talk hasn’t covered this yet, so I can’t answer from the transcript.';
// Bound the context supplied to the model
const MAX_SOURCES = 5;
// Group private-chat measurements without question, answer, or passage content
const chatMeter = metrics.getMeter('summit-thread.private-chat');
// Count only evidence passages returned after the released-ID check
const retrievalSourceCount = chatMeter.createHistogram('private_chat.retrieval.source_count', { unit: '{source}' });
// Measure total answer latency with a bounded outcome label
const answerDuration = chatMeter.createHistogram('private_chat.answer.duration', { unit: 'ms' });
// Count citations after they are checked against retrieved captions
const answerCitationCount = chatMeter.createHistogram('private_chat.answer.citation_count', { unit: '{citation}' });
// Count failures using fixed provider-state labels only
const answerFailures = chatMeter.createCounter('private_chat.answer.failures', { unit: '{failure}' });

// Retrieve released evidence and validate every returned citation
export class PrivateChatService {
  constructor(private readonly dependencies: PrivateChatDependencies) {}

  // Answer from released captions and reject citations outside retrieved evidence
  async ask(sessionId: string, request: PrivateChatRequest): Promise<PrivateChatResponse> {
    const startedAt = performance.now();
    const releasedCaptions = await this.dependencies.sessions.getReleasedCaptions(sessionId);

    // Intersect search results with the current persisted released-caption set
    const releasedById = new Map(releasedCaptions.map((caption) => [caption.id, caption]));
    const sources = new Map<string, ReleasedCaption>();
    const contextualSource = request.contextCaptionId
      ? releasedCaptions.find((caption) => caption.id === request.contextCaptionId)
      : undefined;
    if (contextualSource) sources.set(contextualSource.id, contextualSource);
    const queries = this.retrievalQueries(request);

    for (const query of queries) {
      let hits: ReleasedCaption[];
      try { hits = await this.dependencies.sessions.searchReleasedCaptions(sessionId, query); }
      catch (error) {
        answerFailures.add(1, { reason: 'search_unavailable' });
        answerDuration.record(performance.now() - startedAt, { result: 'failed' });
        throw error;
      }
      for (const hit of hits) {
        const committed = releasedById.get(hit.id);
        if (committed && !sources.has(hit.id)) sources.set(hit.id, committed);
        if (sources.size === MAX_SOURCES) break;
      }
      if (sources.size === MAX_SOURCES) break;
    }

    retrievalSourceCount.record(sources.size);
    if (sources.size === 0) {
      answerDuration.record(performance.now() - startedAt, { result: 'abstained' });
      answerCitationCount.record(0);
      return { answer: NO_GROUNDED_ANSWER, citations: [] };
    }
    if (!this.dependencies.generateAnswer) {
      // Never return an ungrounded answer when answer generation is unavailable
      answerFailures.add(1, { reason: 'provider_unavailable' });
      throw new AiUnavailableError();
    }

    let generated;
    try {
      generated = await this.dependencies.generateAnswer({
        question: request.question,
        // Keep the model context to the six most recent chat messages
        history: request.history.slice(-6),
        sources: [...sources.values()].map(({ id, timestampMs, text }) => ({ id, timestampMs, text: text.slice(0, 4000) }))
      });
    } catch {
      // Suppress provider errors that may include private question or passage text
      answerFailures.add(1, { reason: 'provider_error' });
      answerDuration.record(performance.now() - startedAt, { result: 'failed' });
      throw new AiUnavailableError();
    }

    const citationIds = [...new Set(generated.citationIds)];
    const validOutput = citationIds.length > 0 && citationIds.every((id) => sources.has(id));
    const citations = citationIds
      .flatMap((captionId) => {
        const caption = sources.get(captionId);
        return caption ? [{ captionId, timestampMs: caption.timestampMs, text: caption.text }] : [];
      });

    // Fall back to a directly quoted released passage if the model returns no valid citations
    if (!validOutput) {
      const closestSource = sources.values().next().value;
      if (!closestSource) {
        answerCitationCount.record(0);
        answerDuration.record(performance.now() - startedAt, { result: 'abstained' });
        return { answer: NO_GROUNDED_ANSWER, citations: [] };
      }

      answerCitationCount.record(1);
      answerDuration.record(performance.now() - startedAt, { result: 'citation_fallback' });
      const excerpt = closestSource.text.slice(0, 280).trimEnd();
      const ellipsis = closestSource.text.length > excerpt.length ? '…' : '';
      return {
        answer: `I couldn’t verify an answer from the transcript. This passage may help: “${excerpt}${ellipsis}”`,
        citations: [{
          captionId: closestSource.id,
          timestampMs: closestSource.timestampMs,
          text: closestSource.text
        }]
      };
    }

    answerCitationCount.record(citations.length);
    answerDuration.record(performance.now() - startedAt, { result: 'answered' });
    return { answer: generated.answer.trim(), citations };
  }

  // Include the current question and recent user turns as retrieval context
  private retrievalQueries(request: PrivateChatRequest): string[] {
    // Search the current question plus the latest three distinct prior questions
    const previousQuestions = request.history
      .filter((message) => message.role === 'user')
      .slice(-3)
      .reverse()
      .map((message) => message.content);
    return [...new Set([request.question, ...previousQuestions].map((query) => query.trim()).filter((query) => query.length >= 2))];
  }
}
