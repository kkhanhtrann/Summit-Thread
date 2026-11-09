import type { UrlAttributeRecord } from '@dash0/sdk-web';

// Redact attendee search terms before browser URLs reach Dash0
export function scrubUrlAttributes(attributes: UrlAttributeRecord): UrlAttributeRecord {
  const fullUrl = attributes['url.full'];
  if (typeof fullUrl !== 'string') return attributes;

  let url: URL;
  try {
    url = new URL(fullUrl, 'http://localhost');
  } catch {
    return attributes;
  }
  if (!url.pathname.endsWith('/captions/search') || !url.searchParams.has('q')) return attributes;

  url.searchParams.set('q', 'REDACTED');

  return {
    ...attributes,
    'url.full': url.toString(),
    'url.query': url.search.slice(1)
  };
}
