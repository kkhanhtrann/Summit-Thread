import { describe, expect, it } from 'vitest';

import { createGeminiVisualMomentAnalyzer, VisualProviderError, type GeminiVisualClient } from './geminiVisualMomentAnalyzer';

// Build a deterministic SDK fixture; responses are synthetic test data
function fixtureClient(generate: () => Promise<{ text?: string }>, states: string[] = ['ACTIVE']) {
  const deleted: string[] = [];
  const uploads: string[] = [];
  const requests: Array<{ model: string; config: Record<string, unknown> }> = [];
  let poll = 0;
  const client: GeminiVisualClient = {
    files: {
      upload: async ({ file }) => {
        uploads.push(file);
        return { name: 'files/synthetic', uri: 'https://provider.invalid/files/synthetic', state: states[0] };
      },
      get: async () => ({ name: 'files/synthetic', uri: 'https://provider.invalid/files/synthetic', state: states[Math.min(++poll, states.length - 1)] }),
      delete: async ({ name }) => { deleted.push(name); }
    },
    models: {
      generateContent: async (parameters) => {
        requests.push({ model: parameters.model, config: parameters.config });
        return await generate();
      }
    }
  };
  return { client, deleted, uploads, requests };
}

// Create the analyzer with the fixture client and instant polling
function analyzerWith(fixture: ReturnType<typeof fixtureClient>, apiKey = 'synthetic-key') {
  return createGeminiVisualMomentAnalyzer(
    { apiKey, model: 'synthetic-visual-model' },
    { createClient: async () => fixture.client, sleep: async () => undefined }
  );
}

const input = { clipPath: '/rooms/ROOMAAAA/visual/clips/window-0000.mp4', mimeType: 'video/mp4', durationMs: 60_000 };

describe('Gemini visual moment analyzer', () => {
  it('uploads only the clip, validates one structured suggestion, and deletes the provider upload', async () => {
    const fixture = fixtureClient(async () => ({ text: JSON.stringify({ moments: [{ offsetMs: 1_000, title: 'Slide', description: 'A synthetic chart.' }] }) }), ['PROCESSING', 'ACTIVE']);
    await expect(analyzerWith(fixture).analyzeWindow(input)).resolves.toEqual({ moments: [{ offsetMs: 1_000, title: 'Slide', description: 'A synthetic chart.' }] });
    expect(fixture.uploads).toEqual([input.clipPath]);
    expect(fixture.requests[0]).toMatchObject({ model: 'synthetic-visual-model', config: { responseMimeType: 'application/json' } });
    expect(fixture.deleted).toEqual(['files/synthetic']);
  });

  it('leaves room for reasoning before the structured answer', async () => {
    const fixture = fixtureClient(async () => {
      // Simulate a provider spending its first 400 tokens on reasoning
      const budget = fixture.requests[0]?.config.maxOutputTokens;
      return { text: typeof budget === 'number' && budget > 400 ? '{"moments":[]}' : '{"moments":[' };
    });
    await expect(analyzerWith(fixture).analyzeWindow(input)).resolves.toEqual({ moments: [] });
    expect(fixture.deleted).toEqual(['files/synthetic']);
  });

  it('accepts an empty result for a window with no useful frame', async () => {
    const fixture = fixtureClient(async () => ({ text: '{"moments":[]}' }));
    await expect(analyzerWith(fixture).analyzeWindow(input)).resolves.toEqual({ moments: [] });
  });

  it('rejects more than one suggestion or malformed output as invalid and still cleans up', async () => {
    const two = { offsetMs: 1, title: 'A', description: 'B' };
    const many = fixtureClient(async () => ({ text: JSON.stringify({ moments: [two, two] }) }));
    await expect(analyzerWith(many).analyzeWindow(input)).rejects.toMatchObject({ category: 'invalid_output' });
    expect(many.deleted).toEqual(['files/synthetic']);
    const garbled = fixtureClient(async () => ({ text: 'not json' }));
    await expect(analyzerWith(garbled).analyzeWindow(input)).rejects.toMatchObject({ category: 'invalid_output' });
  });

  it('maps provider failures to fixed categories without echoing provider text', async () => {
    const limited = fixtureClient(async () => { throw Object.assign(new Error('SYNTHETIC_PRIVATE_MARKER quota'), { status: 429 }); });
    const error = await analyzerWith(limited).analyzeWindow(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VisualProviderError);
    expect(error).toMatchObject({ category: 'rate_limited' });
    expect(String((error as Error).message)).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    const rejected = fixtureClient(async () => { throw Object.assign(new Error('bad'), { status: 400 }); });
    await expect(analyzerWith(rejected).analyzeWindow(input)).rejects.toMatchObject({ category: 'provider_rejected' });
    const failedFile = fixtureClient(async () => ({ text: '{}' }), ['FAILED']);
    await expect(analyzerWith(failedFile).analyzeWindow(input)).rejects.toMatchObject({ category: 'provider_rejected' });
  });

  it('requires a backend key and skips audio input without contacting the provider', async () => {
    const fixture = fixtureClient(async () => ({ text: '{"moments":[]}' }));
    await expect(analyzerWith(fixture, '').analyzeWindow(input)).rejects.toMatchObject({ category: 'not_configured' });
    await expect(analyzerWith(fixture).analyzeWindow({ ...input, mimeType: 'audio/mp4' })).resolves.toEqual({ moments: [] });
    expect(fixture.uploads).toEqual([]);
  });
});
