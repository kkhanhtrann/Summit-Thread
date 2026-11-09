import { expect, it } from 'vitest';
import { safeUrlAttributes } from './urlAttributes';
it('removes all query values, credentials and fragments from URL span attributes', () => {
  const attributes = safeUrlAttributes(
    'https://user:SYNTHETIC_PRIVATE@example.com/route?key=SYNTHETIC_PRIVATE&other=SYNTHETIC_PRIVATE#SYNTHETIC_PRIVATE'
  );
  expect(JSON.stringify(attributes)).not.toContain('SYNTHETIC_PRIVATE');
  expect(attributes['url.full']).toBe('https://example.com/route');
  expect(attributes['http.target']).toBe('/route');
  expect(safeUrlAttributes('http://[')['url.full']).toBe('REDACTED');
});
