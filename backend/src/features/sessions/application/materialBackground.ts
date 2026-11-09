import type { TopicAnalysisCaption, TopicBackgroundPassage } from '../../../platform/ai/topicAnalysis';
import type { MaterialPassageView } from '../contracts/material.contract';
import type { TopicBackgroundProvider } from './topicAnalysisWorker';

// Bound the background supplied with one topic interval
const MAX_BACKGROUND_PASSAGES = 5;
// Cap total background text so material never outweighs the interval's speech
const MAX_BACKGROUND_CHARACTERS = 4_000;
// Limit the search query built from interval captions
const MAX_QUERY_CHARACTERS = 1_000;

// Find ready presenter passages relevant to an interval, loading text only for the hits used
export function createMaterialBackgroundProvider(ports: {
  getReadyPassageIds(sessionId: string): Promise<string[]>;
  getReadyPassagesByIds(sessionId: string, ids: string[]): Promise<MaterialPassageView[]>;
  searchPassages(sessionId: string, query: string, allowedPassageIds: string[], size: number): Promise<Array<{ id: string }>>;
}): TopicBackgroundProvider {
  return async (sessionId: string, captions: TopicAnalysisCaption[]): Promise<TopicBackgroundPassage[]> => {
    const allowedPassageIds = await ports.getReadyPassageIds(sessionId);
    if (!allowedPassageIds.length || !captions.length) return [];
    const allowed = new Set(allowedPassageIds);
    const query = captions.map((caption) => caption.text).join(' ').slice(0, MAX_QUERY_CHARACTERS);
    const hits = await ports.searchPassages(sessionId, query, allowedPassageIds, MAX_BACKGROUND_PASSAGES);
    const wanted = [...new Set(hits.map((hit) => hit.id))].filter((id) => allowed.has(id)).slice(0, MAX_BACKGROUND_PASSAGES);
    if (!wanted.length) return [];
    // Use canonical PostgreSQL text in search-relevance order
    const committed = new Map((await ports.getReadyPassagesByIds(sessionId, wanted)).map((passage) => [passage.id, passage]));
    const background: TopicBackgroundPassage[] = [];
    let characters = 0;
    for (const id of wanted) {
      const passage = committed.get(id);
      if (!passage) continue;
      if (characters + passage.text.length > MAX_BACKGROUND_CHARACTERS) break;
      characters += passage.text.length;
      background.push({ id: passage.id, title: passage.materialTitle.slice(0, 100), text: passage.text });
    }
    return background;
  };
}
