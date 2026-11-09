import { describe, expect, it } from 'vitest';

import { privateChatRequestSchema } from './privateChat.contract';

describe('privateChatRequestSchema', () => {
  it('trims long conversation history to the content length sent back to Gemini', () => {
    const parsed = privateChatRequestSchema.safeParse({
      question: 'What came next?',
      history: [{ role: 'assistant', content: 'a'.repeat(1_200) }]
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.history[0]?.content).toHaveLength(1_000);
  });

  it('rejects oversized history entries before normalization', () => {
    const parsed = privateChatRequestSchema.safeParse({
      question: 'What came next?',
      history: [{ role: 'assistant', content: 'a'.repeat(4_001) }]
    });

    expect(parsed.success).toBe(false);
  });
});
