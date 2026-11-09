import type { SessionSnapshot } from '../contracts/session.contract';
import type { TopicAnalysisInput, TopicAnalysisResult } from '../../../platform/ai/topicAnalysis';

// Share the room-scoped committed update channel with topic analysis
export type { SessionEventPort } from './sessionEventHub';

// Define topic persistence operations owned by the sessions feature
export interface SessionRepositoryPort {
  requestTopicAnalysis(sessionId?: string): Promise<void>;
  getPendingTopicSessionIds(initialLiveBatchSize: number, force?: boolean, sessionId?: string): Promise<string[]>;
  getTopicAnalysisContext(sessionId: string): Promise<TopicAnalysisContext | null>;
  recordTopicAnalysisFailure(sessionId: string, cursor: number, throughSequence: number, retryAfterMs: number): Promise<number | null>;
  deferTopicAnalysis(retryAfterMs: number): Promise<void>;
  skipTopicAnalysisBatch(sessionId: string, cursor: number, throughSequence: number): Promise<SessionSnapshot | null>;
  applyTopicAnalysis(sessionId: string, cursor: number, throughSequence: number, result: TopicAnalysisResult): Promise<SessionSnapshot | null>;
}

// Pair the durable cursor with the exact released caption batch to analyze
export interface TopicAnalysisContext {
  cursor: number;
  // Keep backoff state attached to the current topic cursor batch
  failureCount: number;
  retryAt: Date | null;
  input: TopicAnalysisInput;
}

// Define the wake-up signal for retryable topic analysis
export interface TopicAnalysisNotifier {
  wake(force?: boolean, sessionId?: string): void;
}
