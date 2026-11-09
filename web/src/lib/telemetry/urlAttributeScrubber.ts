import type { UrlAttributeRecord } from '@dash0/sdk-web';

// Redact sensitive URL components before browser URLs reach Dash0
export function scrubUrlAttributes(attributes: UrlAttributeRecord): UrlAttributeRecord {
  const fullUrl = attributes['url.full'];
  if (typeof fullUrl !== 'string') return attributes;

  let url: URL;
  try {
    url = new URL(fullUrl, 'http://localhost');
  } catch {
    return attributes;
  }

  url.username = '';
  url.password = '';
  url.hash = '';
  for (const name of [...new Set(url.searchParams.keys())]) url.searchParams.set(name, 'REDACTED');

  const scrubbed: UrlAttributeRecord = { ...attributes, 'url.full': url.toString() };
  if (url.search) scrubbed['url.query'] = url.search.slice(1);
  else delete (scrubbed as Record<string, unknown>)['url.query'];
  return scrubbed;
}
