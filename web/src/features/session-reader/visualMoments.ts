import type { SessionSnapshot } from '../sessions/public';

type TopicOccurrence = SessionSnapshot['threads'][number]['occurrences'][number];
type VisualMoment = SessionSnapshot['visualMoments'][number];

// Keep each visual moment inside one chronological topic occurrence
export function visualMomentsForOccurrence(occurrence: TopicOccurrence, moments: VisualMoment[], occurrences: TopicOccurrence[]): VisualMoment[] {
  const orderedOccurrences = [...occurrences].sort((left, right) => left.startedAtMs - right.startedAtMs);
  const occurrenceIndex = orderedOccurrences.findIndex((candidate) => candidate.id === occurrence.id);
  const nextOccurrence = occurrenceIndex >= 0 ? orderedOccurrences[occurrenceIndex + 1] : undefined;
  return moments.filter((moment) => moment.timestampMs >= occurrence.startedAtMs
    && (occurrence.endedAtMs === null || moment.timestampMs <= occurrence.endedAtMs)
    && (!nextOccurrence || moment.timestampMs < nextOccurrence.startedAtMs));
}
