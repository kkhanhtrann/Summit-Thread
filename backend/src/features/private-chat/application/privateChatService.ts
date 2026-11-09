import type { AnswerGenerator, GroundedSource } from '../../../platform/ai/groundedAnswer';
import { metrics } from '@opentelemetry/api';
import { AiUnavailableError } from '../../../platform/ai/aiUnavailableError';
import type { PrivateChatCitation, PrivateChatRequest, PrivateChatResponse } from '../contracts/privateChat.contract';

// Describe the persisted caption fields used to ground an answer
interface ReleasedCaption {
  id: string;
  timestampMs: number;
  text: string;
}

// Describe a ready presenter material passage used as supporting context
interface MaterialPassage {
  id: string;
  materialTitle: string;
  pageNumber: number | null;
  text: string;
}

// Define persistence and model ports required for private answers
export interface PrivateChatDependencies {
  sessions: {
    getReleasedCaptions(sessionId: string): Promise<ReleasedCaption[]>;
    searchReleasedCaptions(sessionId: string, query: string, allowedCaptionIds: string[]): Promise<ReleasedCaption[]>;
  };
  // Retrieve presenter material when material intake is composed
  materials?: {
    getReadyPassages(sessionId: string): Promise<MaterialPassage[]>;
    searchPassages(sessionId: string, query: string, allowedPassageIds: string[]): Promise<MaterialPassage[]>;
  };
  generateAnswer?: AnswerGenerator;
}

// Return a clear abstention when released evidence is missing
const NO_GROUNDED_ANSWER = 'The talk hasn’t covered this yet, so I can’t answer from the transcript.';
// Bound the spoken context supplied to the model
const MAX_SOURCES = 5;
// Bound presenter material separately so it cannot crowd out spoken evidence
const MAX_MATERIAL_SOURCES = 3;
// Group private-chat measurements without question, answer, or passage content
const chatMeter = metrics.getMeter('summit-thread.private-chat');
// Count only evidence passages returned after the released-ID check
const retrievalSourceCount = chatMeter.createHistogram('private_chat.retrieval.source_count', { unit: '{source}' });
// Count presenter material passages returned after the ready-ID check
const retrievalMaterialCount = chatMeter.createHistogram('private_chat.retrieval.material_count', { unit: '{source}' });
// Measure total answer latency with a bounded outcome label
const answerDuration = chatMeter.createHistogram('private_chat.answer.duration', { unit: 'ms' });
// Count citations after they are checked against retrieved captions
const answerCitationCount = chatMeter.createHistogram('private_chat.answer.citation_count', { unit: '{citation}' });
// Count failures using fixed provider-state labels only
const answerFailures = chatMeter.createCounter('private_chat.answer.failures', { unit: '{failure}' });

// Describe one retrieved source and the citation it becomes if the model cites it
interface RetrievedSource {
  grounded: GroundedSource;
  citation: PrivateChatCitation;
}

// Build the spoken source and caption citation for one released caption
function captionSource(caption: ReleasedCaption): RetrievedSource {
  return {
    grounded: { id: caption.id, kind: 'spoken', timestampMs: caption.timestampMs, text: caption.text.slice(0, 4000) },
    citation: { kind: 'caption', captionId: caption.id, timestampMs: caption.timestampMs, text: caption.text }
  };
}

// Build the material source and material citation for one ready passage
function materialSource(passage: MaterialPassage): RetrievedSource {
  const label = passage.pageNumber === null ? passage.materialTitle : `${passage.materialTitle}, page ${passage.pageNumber}`;
  return {
    grounded: { id: passage.id, kind: 'material', label, text: passage.text.slice(0, 4000) },
    citation: { kind: 'material', passageId: passage.id, materialTitle: passage.materialTitle, page: passage.pageNumber, text: passage.text }
  };
}

// Retrieve released evidence and validate every returned citation
export class PrivateChatService {
  constructor(private readonly dependencies: PrivateChatDependencies) {}

  // Answer from released captions and presenter material, rejecting citations outside retrieved sources
  async ask(sessionId: string, request: PrivateChatRequest): Promise<PrivateChatResponse> {
    const startedAt = performance.now();
    const releasedCaptions = await this.dependencies.sessions.getReleasedCaptions(sessionId);

    // Intersect search results with the current persisted released-caption set
    const releasedById = new Map(releasedCaptions.map((caption) => [caption.id, caption]));
    const allowedCaptionIds = [...releasedById.keys()];
    const sources = new Map<string, RetrievedSource>();
    const contextualSource = request.contextCaptionId
      ? releasedCaptions.find((caption) => caption.id === request.contextCaptionId)
      : undefined;
    if (contextualSource) sources.set(contextualSource.id, captionSource(contextualSource));
    const queries = this.retrievalQueries(request);

    for (const query of queries) {
      let hits: ReleasedCaption[];
      try { hits = await this.dependencies.sessions.searchReleasedCaptions(sessionId, query, allowedCaptionIds); }
      catch (error) {
        answerFailures.add(1, { reason: 'search_unavailable' });
        answerDuration.record(performance.now() - startedAt, { result: 'failed' });
        throw error;
      }
      for (const hit of hits) {
        const committed = releasedById.get(hit.id);
        if (committed && !sources.has(hit.id)) sources.set(hit.id, captionSource(committed));
        if (sources.size === MAX_SOURCES) break;
      }
      if (sources.size === MAX_SOURCES) break;
    }

    const materialCount = await this.addMaterialSources(sessionId, queries, sources);
    retrievalSourceCount.record(sources.size - materialCount);
    retrievalMaterialCount.record(materialCount);
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
        sources: [...sources.values()].map((source) => source.grounded)
      });
    } catch {
      // Suppress provider errors that may include private question or passage text
      answerFailures.add(1, { reason: 'provider_error' });
      answerDuration.record(performance.now() - startedAt, { result: 'failed' });
      throw new AiUnavailableError();
    }

    const citationIds = [...new Set(generated.citationIds)];
    const validOutput = citationIds.length > 0 && citationIds.every((id) => sources.has(id));
    const citations = citationIds.flatMap((id) => {
      const source = sources.get(id);
      return source ? [source.citation] : [];
    });

    // Fall back to a directly quoted retrieved passage if the model returns no valid citations
    if (!validOutput) {
      const closestSource = sources.values().next().value;
      if (!closestSource) {
        answerCitationCount.record(0);
        answerDuration.record(performance.now() - startedAt, { result: 'abstained' });
        return { answer: NO_GROUNDED_ANSWER, citations: [] };
      }

      answerCitationCount.record(1);
      answerDuration.record(performance.now() - startedAt, { result: 'citation_fallback' });
      const text = closestSource.citation.text;
      const excerpt = text.slice(0, 280).trimEnd();
      const ellipsis = text.length > excerpt.length ? '…' : '';
      // Name the source kind so a material excerpt is never presented as speech
      const origin = closestSource.citation.kind === 'material' ? 'This passage from the presenter’s materials' : 'This passage';
      return {
        answer: `I couldn’t verify an answer from the transcript. ${origin} may help: “${excerpt}${ellipsis}”`,
        citations: [closestSource.citation]
      };
    }

    answerCitationCount.record(citations.length);
    answerDuration.record(performance.now() - startedAt, { result: 'answered' });
    return { answer: generated.answer.trim(), citations };
  }

  // Add ready material passages after spoken evidence; degrade to speech-only if material search fails
  private async addMaterialSources(sessionId: string, queries: string[], sources: Map<string, RetrievedSource>): Promise<number> {
    const materials = this.dependencies.materials;
    if (!materials) return 0;
    let added = 0;
    try {
      const ready = await materials.getReadyPassages(sessionId);
      if (!ready.length) return 0;
      // Intersect material search results with passages reloaded from PostgreSQL
      const readyById = new Map(ready.map((passage) => [passage.id, passage]));
      const allowedPassageIds = [...readyById.keys()];
      for (const query of queries) {
        const hits = await materials.searchPassages(sessionId, query, allowedPassageIds);
        for (const hit of hits) {
          const committed = readyById.get(hit.id);
          if (committed && !sources.has(hit.id)) {
            sources.set(hit.id, materialSource(committed));
            added += 1;
          }
          if (added === MAX_MATERIAL_SOURCES) return added;
        }
      }
    } catch {
      // Keep answering from speech when material retrieval is unavailable
      answerFailures.add(1, { reason: 'material_search_unavailable' });
    }
    return added;
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
