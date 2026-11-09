import { describe, expect, it } from 'vitest';

import { createGeminiProviders, GeminiConfigurationError } from './gemini';

describe('Gemini provider setup', () => {
  it('creates a server-side text client from an injected key', () => {
    const providers = createGeminiProviders({ apiKey: 'test-only-key' });

    expect(providers.textModel.modelId).toBe('gemini-3.8-flash');
    expect(providers.textModel).toBeDefined();
  });

  it('does not initialize provider clients without a configured key', () => {
    expect(() => createGeminiProviders({ apiKey: '' })).toThrow(GeminiConfigurationError);
  });
});
