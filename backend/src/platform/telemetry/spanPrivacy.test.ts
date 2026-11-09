import { describe, expect, it } from 'vitest';

import { sanitizeSpanErrors } from './spanPrivacy';

describe('span error privacy', () => {
  it('removes raw exception payloads and status messages before export', () => {
    const span = {
      name: 'caption.index_job',
      events: [
        { name: 'exception', attributes: { 'exception.message': 'SYNTHETIC_PRIVATE_MARKER', 'exception.stacktrace': 'SYNTHETIC_PRIVATE_MARKER' } },
        { name: 'released', attributes: { count: 1 } }
      ],
      status: { code: 2, message: 'SYNTHETIC_PRIVATE_MARKER' }
    };
    const sanitized = sanitizeSpanErrors(span);
    expect(JSON.stringify(sanitized)).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    expect(sanitized.events).toEqual([{ name: 'released', attributes: { count: 1 } }]);
    expect(sanitized.status).toEqual({ code: 2 });
    expect(span.status.message).toBe('SYNTHETIC_PRIVATE_MARKER');
  });
});
