import type { CaptionView } from '../../sessions/public';

// Define Elasticsearch operations over persisted released captions
export interface CaptionSearchIndex {
  ping(): Promise<void>;
  findReleasedCaptions(sessionId: string, query: string, allowedCaptionIds: string[]): Promise<CaptionView[]>;
  indexCaption(sessionId: string, caption: CaptionView, topic?: { title: string; summary: string }): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}
