// Describe safe provider status and quota timing without retaining response content
export interface ProviderFailure {
  statusCode?: number;
  retryAfterMs?: number;
}

// Unwrap SDK retry errors and retain only operational quota information
export function readProviderFailure(error: unknown): ProviderFailure {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') break;
    const value = current as Record<string, unknown>;
    if (typeof value.statusCode === 'number') {
      if (value.statusCode !== 429) return { statusCode: value.statusCode };
      let retryAfterMs = 86_400_000;
      try {
        if (typeof value.responseBody === 'string' && value.responseBody.length <= 65_536) {
          const body = JSON.parse(value.responseBody);
          const details = body?.error?.details;
          if (Array.isArray(details)) {
            for (const detail of details) {
              const match = typeof detail?.retryDelay === 'string' && /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay);
              if (match) retryAfterMs = Math.min(86_400_000, Math.max(60_000, Math.ceil(Number(match[1]) * 1_000)));
            }
          }
        }
      } catch {
        // Defer conservatively when provider quota details cannot be parsed
      }
      return { statusCode: 429, retryAfterMs };
    }
    current = value.lastError ?? value.cause;
  }
  return {};
}
