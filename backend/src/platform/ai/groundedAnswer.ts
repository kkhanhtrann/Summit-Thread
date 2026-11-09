// Describe one released passage supplied as answer evidence
export interface GroundedSource {
  id: string;
  timestampMs: number;
  text: string;
}

// Describe the question, bounded history, and retrieved evidence sent to Gemini
export interface GroundedAnswerInput {
  question: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  sources: GroundedSource[];
}

// Describe model output before citations are checked by the feature
export interface GroundedAnswerOutput {
  answer: string;
  citationIds: string[];
}

// Define a provider-independent grounded answer operation
export type AnswerGenerator = (input: GroundedAnswerInput) => Promise<GroundedAnswerOutput>;
