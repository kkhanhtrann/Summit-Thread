import { z } from 'zod';

// Bound history content before forwarding it to the provider
const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(4_000).transform((content) => content.slice(0, 1_000))
}).strict();

// Validate a private question and cap its in-memory conversation context
export const privateChatRequestSchema = z.object({
  question: z.string().trim().min(2).max(500),
  history: z.array(chatMessageSchema).max(8).default([]),
  contextCaptionId: z.string().trim().min(1).max(160).optional()
}).strict();

// Describe the validated question sent to the answer service
export interface PrivateChatRequest {
  question: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  contextCaptionId?: string;
}

// Identify a released caption returned as spoken answer evidence
export interface CaptionCitation {
  kind: 'caption';
  captionId: string;
  timestampMs: number;
  text: string;
}

// Identify a presenter material passage returned as supporting context
export interface MaterialCitation {
  kind: 'material';
  passageId: string;
  materialTitle: string;
  page: number | null;
  text: string;
}

// Keep spoken evidence and presenter material distinguishable in every answer
export type PrivateChatCitation = CaptionCitation | MaterialCitation;

// Return answer text with citations validated by the owning feature
export interface PrivateChatResponse {
  answer: string;
  citations: PrivateChatCitation[];
}
