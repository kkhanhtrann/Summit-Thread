import { expect, it, vi } from 'vitest';
import { SessionEventHub } from './sessionEventHub';
it('isolates room subscribers and failed connections without interrupting committed publication', () => {
  const hub = new SessionEventHub();
  const receive = vi.fn();
  const other = vi.fn();
  hub.subscribe('AB12CD34', () => {
    throw new Error('Synthetic closed connection');
  });
  const unsubscribe = hub.subscribe('AB12CD34', receive);
  hub.subscribe('DEADBEEF', other);
  const event = {
    type: 'live_status_changed',
    revision: 1,
    isLive: true
  } as const;
  expect(() => hub.publish('AB12CD34', event)).not.toThrow();
  expect(receive).toHaveBeenCalledWith(event);
  expect(other).not.toHaveBeenCalled();
  unsubscribe();
  hub.publish('AB12CD34', event);
  expect(receive).toHaveBeenCalledOnce();
});
