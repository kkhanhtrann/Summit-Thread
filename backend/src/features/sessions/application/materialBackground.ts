import type { TopicAnalysisCaption, TopicBackgroundPassage } from '../../../platform/ai/topicAnalysis';
import type { MaterialPassageView } from '../contracts/material.contract';
import type { TopicBackgroundProvider } from './topicAnalysisWorker';

// Bound the background supplied with one topic interval
const MAX_BACKGROUND_PASSAGES = 5;
// Cap total background text so material never outweighs the interval's speech
const MAX_BACKGROUND_CHARACTERS = 4_000;
// Limit the search query built from interval captions
const MAX_QUERY_CHARACTERS = 1_000;

// Find ready presenter passages relevant to an interval, reloading allowed IDs from PostgreSQL
export function createMaterialBackgroundProvider(ports: {
  getReadyPassages(sessionId: string): Promise<MaterialPassageView[]>;
  searchPassages(sessionId: string, query: string, allowedPassageIds: string[], size: number): Promise<MaterialPassageView[]>;
}): TopicBackgroundProvider {
  return async (sessionId: string, captions: TopicAnalysisCaption[]): Promise<TopicBackgroundPassage[]> => {
    const ready = await ports.getReadyPassages(sessionId);
    if (!ready.length || !captions.length) return [];
    const readyById = new Map(ready.map((passage) => [passage.id, passage]));
    const query = captions.map((caption) => caption.text).join(' ').slice(0, MAX_QUERY_CHARACTERS);
    const hits = await ports.searchPassages(sessionId, query, [...readyById.keys()], MAX_BACKGROUND_PASSAGES);
    const background: TopicBackgroundPassage[] = [];
    let characters = 0;
    for (const hit of hits) {
      const passage = readyById.get(hit.id);
      if (!passage || background.some((item) => item.id === passage.id)) continue;
      if (characters + passage.text.length > MAX_BACKGROUND_CHARACTERS) break;
      characters += passage.text.length;
      background.push({ id: passage.id, title: passage.materialTitle.slice(0, 100), text: passage.text });
      if (background.length === MAX_BACKGROUND_PASSAGES) break;
    }
    return background;
  };
}
