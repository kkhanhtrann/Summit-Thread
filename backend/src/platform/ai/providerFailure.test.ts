import { describe, expect, it } from 'vitest';

import { readProviderFailure } from './providerFailure';

describe('readProviderFailure', () => {
  it('unwraps SDK retries and reads the provider quota reset without exposing response text', () => {
    const failure = readProviderFailure({ lastError: {
      statusCode: 429,
      responseBody: JSON.stringify({ error: { details: [{ retryDelay: '8299.5s' }] } })
    } });

    expect(failure).toEqual({ statusCode: 429, retryAfterMs: 8_299_500 });
  });

  it('uses a conservative daily cooldown when quota details are unavailable', () => {
    expect(readProviderFailure({ statusCode: 429 })).toEqual({ statusCode: 429, retryAfterMs: 86_400_000 });
  });

  it('does not classify ordinary validation failures as quota exhaustion', () => {
    expect(readProviderFailure(new Error('private text'))).toEqual({});
  });
});
