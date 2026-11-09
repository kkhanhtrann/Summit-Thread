import type { CaptionView } from './session.contract';
import type { MaterialPassageView } from './material.contract';
// Describe committed room content consumed by retrieval and the Ask view
export interface ReleasedRoomContent {
  session: { id: string; title: string };
  captions: CaptionView[];
  suggestedQuestions: string[];
}
// Describe retryable work without unreleased media or private conversations
export interface CaptionIndexJob {
  id: string;
  operation: 'index_caption' | 'delete_session' | 'index_material_passage' | 'delete_material';
  sessionId: string;
  caption: CaptionView | null;
  topic: { title: string; summary: string } | null;
  // Read current ready passage text at run time rather than storing it in the job
  passage?: MaterialPassageView | null;
  // Keep the removed material ID so its search documents can be deleted
  materialId?: string | null;
}
// Expose durable queue operations independently of Prisma
export interface IndexQueueRepository {
  getNextIndexJob(): Promise<CaptionIndexJob | null>;
  finishIndexJob(id: string): Promise<void>;
}
