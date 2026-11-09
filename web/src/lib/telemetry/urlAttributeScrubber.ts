import type { UrlAttributeRecord } from '@dash0/sdk-web';

// Redact sensitive URL components before browser URLs reach Dash0
export function scrubUrlAttributes(attributes: UrlAttributeRecord): UrlAttributeRecord {
  const scrubbed: UrlAttributeRecord = { ...attributes };
  delete scrubbed['url.query'];
  delete scrubbed['url.fragment'];
  const fullUrl = attributes['url.full'];
  if (typeof fullUrl !== 'string') return scrubbed;

  let url: URL;
  try {
    url = new URL(fullUrl, 'http://localhost');
  } catch {
    return { ...scrubbed, 'url.full': 'REDACTED' };
  }

  url.username = '';
  url.password = '';
  url.hash = '';
  for (const name of [...new Set(url.searchParams.keys())]) url.searchParams.set(name, 'REDACTED');

  scrubbed['url.full'] = url.toString();
  if (url.search) scrubbed['url.query'] = url.search.slice(1);
  else delete (scrubbed as Record<string, unknown>)['url.query'];
  return scrubbed;
}
