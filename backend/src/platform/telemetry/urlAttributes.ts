// Scrub credentials, query values and fragments from HTTP and fetch span fields
export function safeUrlAttributes(input: string): Record<string, string> {
  try {
    const url = new URL(input, 'http://localhost');
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return {
      'url.full': url.toString(),
      'http.url': url.toString(),
      'http.target': url.pathname,
      'url.path': url.pathname,
      'url.query': 'REDACTED',
      'url.fragment': 'REDACTED'
    };
  } catch {
    return {
      'url.full': 'REDACTED',
      'http.url': 'REDACTED',
      'http.target': 'REDACTED',
      'url.path': 'REDACTED',
      'url.query': 'REDACTED',
      'url.fragment': 'REDACTED'
    };
  }
}
