import { useEffect, useId, useRef, useState } from 'react';

import type { SessionSnapshot } from '../sessions/public';

type TopicThread = SessionSnapshot['threads'][number];
type TopicOccurrence = TopicThread['occurrences'][number];

// Describe the selected thread and the reader actions available from its details
interface TopicThreadDialogProps {
  thread: TopicThread | null;
  initialOccurrenceId: string | null;
  captions: SessionSnapshot['captions'];
  sessionTitle: string;
  isCurrent: boolean;
  onClose: () => void;
  onOpenCaption: (threadId: string, occurrenceId: string, captionId: string) => void;
}

// Format a talk offset as MM:SS or H:MM:SS
function formatTimestamp(timestampMs: number): string {
  const totalSeconds = Math.floor(timestampMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Keep the durable thread note readable as a lead and supporting context
function splitSummarySentences(summary: string): string[] {
  return Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(summary))
    .map(({ segment }) => segment.trim())
    .filter(Boolean);
}

// Show one topic and its cited visits in a modal dialog without seeking shared media
export function TopicThreadDialog({ thread, initialOccurrenceId, captions, sessionTitle, isCurrent, onClose, onOpenCaption }: TopicThreadDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Return focus to the control that opened the dialog after it closes
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const summaryId = useId();
  const [activeOccurrenceId, setActiveOccurrenceId] = useState<string | null>(null);
  const orderedOccurrences = thread
    ? [...thread.occurrences].sort((left, right) => left.startedAtMs - right.startedAtMs)
    : [];
  const summarySentences = thread ? splitSummarySentences(thread.summary) : [];
  const activeOccurrence = orderedOccurrences.find((occurrence) => occurrence.id === activeOccurrenceId)
    ?? orderedOccurrences.at(-1)
    ?? null;
  const captionById = new Map(captions.map((caption) => [caption.id, caption] as const));
  const evidenceCaptions = activeOccurrence?.evidenceCaptionIds
    .map((captionId) => captionById.get(captionId))
    .filter((caption): caption is NonNullable<typeof caption> => caption !== undefined)
    .sort((left, right) => left.timestampMs - right.timestampMs) ?? [];

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (thread && !element.open) {
      // Capture the opener before moving focus into the dialog
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      closeButton.current?.focus();
    }
    if (!thread && element.open) {
      element.close();
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
      returnFocus.current = null;
    }
  }, [thread?.id]);

  useEffect(() => {
    if (!thread) return;
    const initialOccurrence = orderedOccurrences.find((occurrence) => occurrence.id === initialOccurrenceId);
    setActiveOccurrenceId(initialOccurrence?.id ?? orderedOccurrences.at(-1)?.id ?? null);
  }, [initialOccurrenceId, thread?.id]);

  // Return one exact released source to the transcript
  function openTranscriptSource(occurrence: TopicOccurrence, captionId: string): void {
    // Let the transcript own focus instead of the milestone that opened the dialog
    returnFocus.current = null;
    onClose();
    onOpenCaption(thread!.id, occurrence.id, captionId);
  }

  return (
    <dialog
      className="topic-thread-dialog"
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={summaryId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {thread && (
        <div className="topic-thread-dialog-shell">
          <header className="topic-thread-dialog-header">
            <div className="topic-thread-dialog-topline">
              <span className="topic-thread-session">{sessionTitle}</span>
              <div className="topic-thread-dialog-actions">
                <button ref={closeButton} className="dialog-close-button" type="button" onClick={onClose} aria-label="Close topic details">Close <span aria-hidden="true">×</span></button>
              </div>
            </div>
            <h2 id={titleId}>{thread.title}</h2>
            <p className="topic-thread-state">{isCurrent ? 'Current topic' : 'Topic thread'}</p>
            <div className={`topic-thread-dialog-overview${summarySentences.length > 1 ? ' has-context' : ''}`} id={summaryId}>
              {summarySentences[0] && <p className="topic-thread-dialog-lead">{summarySentences[0]}</p>}
              {summarySentences.length > 1 && (
                <section className="topic-thread-dialog-context" aria-label="Supporting context">
                  <h3>Key points</h3>
                  <ul>
                    {summarySentences.slice(1).map((sentence, index) => <li key={`${index}-${sentence}`}>{sentence}</li>)}
                  </ul>
                </section>
              )}
            </div>
          </header>

          <div className="topic-thread-dialog-body">
            <section className="dialog-visit-column" aria-labelledby={`${titleId}-visits`}>
              <header className="dialog-section-heading">
                <h3 id={`${titleId}-visits`}>When this topic came up</h3>
                <span>{orderedOccurrences.length} {orderedOccurrences.length === 1 ? 'moment' : 'moments'}</span>
              </header>
              <ol className="dialog-visit-timeline">
                {orderedOccurrences.map((occurrence, index) => {
                  const sourceCount = occurrence.evidenceCaptionIds.filter((captionId) => captionById.has(captionId)).length;
                  const hasDistinctNote = occurrence.summary.trim() !== thread.summary.trim();
                  const note = hasDistinctNote
                    ? occurrence.summary
                    : index === 0 ? 'This is where the topic begins.' : 'The talk returns to this topic.';
                  return (
                    <li className={`dialog-visit${activeOccurrence?.id === occurrence.id ? ' is-selected' : ''}`} key={occurrence.id}>
                      <span className="dialog-visit-marker" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                      <button
                        className="dialog-visit-button"
                        type="button"
                        aria-pressed={activeOccurrence?.id === occurrence.id}
                        aria-current={activeOccurrence?.id === occurrence.id ? 'true' : undefined}
                        onClick={() => setActiveOccurrenceId(occurrence.id)}
                      >
                        <span className="dialog-visit-topline">
                          <time>{formatTimestamp(occurrence.startedAtMs)}</time>
                          <span>{index === 0 ? 'Topic begins' : 'Topic returns'}</span>
                        </span>
                        <span className="dialog-visit-note">{note}</span>
                        <span className="dialog-visit-source-count">{sourceCount} transcript {sourceCount === 1 ? 'passage' : 'passages'}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>

            <aside className="dialog-evidence-column" aria-labelledby={`${titleId}-evidence`}>
              {activeOccurrence ? (
                <>
                  <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                    Talk moment at {formatTimestamp(activeOccurrence.startedAtMs)} selected. {evidenceCaptions.length} transcript {evidenceCaptions.length === 1 ? 'passage' : 'passages'}.
                  </p>
                  <header className="dialog-section-heading dialog-evidence-heading">
                    <div>
                      <h3 id={`${titleId}-evidence`}>Transcript</h3>
                      <p className="dialog-source-stamp">At <time>{formatTimestamp(activeOccurrence.startedAtMs)}</time></p>
                    </div>
                    <span>{evidenceCaptions.length} {evidenceCaptions.length === 1 ? 'passage' : 'passages'}</span>
                  </header>
                  <p className="dialog-occurrence-note">{activeOccurrence.summary.trim() !== thread.summary.trim()
                    ? activeOccurrence.summary
                    : 'Transcript passages from this part of the talk appear below.'}</p>
                  {evidenceCaptions.length > 0 ? (
                    <ol className="dialog-source-list" aria-label="Transcript passages">
                      {evidenceCaptions.map((caption) => (
                        <li key={caption.id}>
                          <article className="dialog-source">
                            <time>{formatTimestamp(caption.timestampMs)}</time>
                            <blockquote>{caption.text}</blockquote>
                            <button className="text-action" type="button" onClick={() => openTranscriptSource(activeOccurrence, caption.id)}>
                              View in transcript
                            </button>
                          </article>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="dialog-source-empty">Transcript passages for this part of the talk aren’t available yet.</p>
                  )}
                </>
              ) : (
                <p className="dialog-source-empty">This topic hasn’t come up yet.</p>
              )}
            </aside>
          </div>
        </div>
      )}
    </dialog>
  );
}
