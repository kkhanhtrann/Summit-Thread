// Describe one finalized caption supplied to topic analysis
export interface TopicAnalysisCaption {
  id: string;
  sequence: number;
  timestampMs: number;
  text: string;
}

// Supply a known thread and the released evidence supporting its summary
export interface TopicAnalysisThread {
  id: string;
  title: string;
  summary: string;
  evidenceCaptions: TopicAnalysisCaption[];
}

// Supply presenter material as background vocabulary, never as topic evidence
export interface TopicBackgroundPassage {
  id: string;
  title: string;
  text: string;
}

// Provide a complete requested interval and prior grounded context
export interface TopicAnalysisInput {
  captions: TopicAnalysisCaption[];
  existingThreads: TopicAnalysisThread[];
  currentThreadId: string | null;
  currentOccurrenceSummary: string | null;
  currentOccurrenceEvidenceCaptions: TopicAnalysisCaption[];
  // Leave empty when the room has no ready material or retrieval is unavailable
  backgroundPassages?: TopicBackgroundPassage[];
}

// Describe one contiguous topic segment beginning at a supplied caption
export interface TopicAnalysisSegment {
  startCaptionId: string;
  decision: 'new' | 'continue' | 'return';
  // Reference a durable thread or the start caption of an earlier new segment
  threadId?: string;
  title: string;
  summary: string;
  occurrenceSummary: string;
  summaryEvidenceCaptionIds: string[];
  occurrenceEvidenceCaptionIds: string[];
  suggestedQuestions: string[];
}

// Cover every caption in the requested interval with ordered topic segments
export interface TopicAnalysisResult {
  segments: TopicAnalysisSegment[];
}

// Define the structured topic analysis provider boundary
export type TopicAnalyzer = (input: TopicAnalysisInput) => Promise<TopicAnalysisResult>;
