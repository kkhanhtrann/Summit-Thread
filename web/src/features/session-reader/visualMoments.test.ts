import { expect, it } from 'vitest';
import { visualMomentsForOccurrence } from './visualMoments';
import type { SessionSnapshot } from '../sessions/public';
it('assigns a source-time boundary still to exactly one topic visit', () => {
 const first = { id: 'first', summary: 'Synthetic', startedAtMs: 0, endedAtMs: 10000, evidenceCaptionIds: [], captions: [] };
 const second = { ...first, id: 'second', startedAtMs: 10000, endedAtMs: null };
 const moments: SessionSnapshot['visualMoments'] = [{ id: 'moment-0000', timestampMs: 10000, topicTitle: 'Synthetic', description: 'Synthetic still', imageUrl: '/synthetic', captionId: null, occurrenceId: null, threadId: null }];
 expect(visualMomentsForOccurrence(first,moments,[first,second])).toEqual([]);
 expect(visualMomentsForOccurrence(second,moments,[first,second])).toEqual(moments);
});
