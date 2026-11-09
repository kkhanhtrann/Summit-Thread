import { describe, expect, it } from 'vitest';
import type { UrlAttributeRecord } from '@dash0/sdk-web';

import { scrubUrlAttributes } from './urlAttributeScrubber';

describe('scrubUrlAttributes', () => {
  it('removes arbitrary sensitive query, fragment, and URL credentials', () => {
    const scrubbed = scrubUrlAttributes({ 'url.full': 'https://user:SYNTHETIC_PRIVATE_MARKER@example.com/status?token=SYNTHETIC_PRIVATE_MARKER#SYNTHETIC_PRIVATE_MARKER', 'url.query': 'token=SYNTHETIC_PRIVATE_MARKER' });
    expect(JSON.stringify(scrubbed)).not.toContain('SYNTHETIC_PRIVATE_MARKER');
  });
  it('redacts session search text from URL telemetry', () => {
    const scrubbed = scrubUrlAttributes({
      'url.full': 'http://127.0.0.1:5175/api/sessions/AB12CD34/captions/search?q=tree%20cover',
      'url.path': '/api/sessions/AB12CD34/captions/search',
      'url.query': 'q=tree%20cover'
    });

    expect(new URL(scrubbed['url.full']).searchParams.get('q')).toBe('REDACTED');
    expect(scrubbed['url.query']).toBe('q=REDACTED');
  });

  it('preserves URLs without search queries', () => {
    const url = 'http://127.0.0.1:5175/api/sessions/AB12CD34';
    expect(scrubUrlAttributes({ 'url.full': url })['url.full']).toBe(url);
  });

  it('ignores missing or malformed URL attributes without throwing', () => {
    expect(scrubUrlAttributes({} as UrlAttributeRecord)).toEqual({});
    expect(scrubUrlAttributes({ 'url.full': 'http://[' } as UrlAttributeRecord))
      .toEqual({ 'url.full': 'http://[' });
  });
});
