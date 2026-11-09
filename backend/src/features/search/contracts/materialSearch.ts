import type { MaterialPassageView } from '../../sessions/public';

// Define Elasticsearch operations over stored, ready presenter material passages
export interface MaterialSearchIndex {
  findPassages(sessionId: string, query: string, allowedPassageIds: string[], size?: number): Promise<MaterialPassageView[]>;
  indexPassage(sessionId: string, passage: MaterialPassageView): Promise<void>;
  deleteMaterial(sessionId: string, materialId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}
