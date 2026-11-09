import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import type { VisualMoment, VisualReviewRecording } from './contracts';
import { describeVisualReview, formatSourceTime, sourceTimeDuration } from './state/visualMomentState';

// Describe what the reader host provides; the gallery never touches shared media playback
export interface VisualMomentGalleryProps {
  moments: VisualMoment[];
  recording: VisualReviewRecording | null;
  // Open the released caption in the host's reader without moving the shared media
  onOpenSpokenMoment(captionId: string): void;
  // Open the topic occurrence in the host's topic view without moving the shared media
  onOpenTopic(threadId: string, occurrenceId: string): void;
}

// Show an original still, or a clear unavailable state when its image cannot load
function StillImage({ moment, large = false }: { moment: VisualMoment; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <p className="visual-still-unavailable">Image unavailable. {moment.description}</p>;
  }
  return (
    <img
      className={large ? 'visual-still visual-still-large' : 'visual-still'}
      src={moment.imageUrl}
      alt={moment.description}
      loading={large ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

// Offer only the context links backed by validated speech or topic relationships
function ContextActions({ moment, onOpenSpokenMoment, onOpenTopic, onBeforeOpen }: Pick<VisualMomentGalleryProps, 'onOpenSpokenMoment' | 'onOpenTopic'> & { moment: VisualMoment; onBeforeOpen?: () => void }) {
  const { captionId, occurrenceId, threadId } = moment;
  if (!captionId && !(occurrenceId && threadId)) {
    return <p className="visual-moment-note">Spoken context isn’t available for this still yet</p>;
  }
  return (
    <div className="visual-moment-actions">
      {captionId && (
        <button type="button" className="text-action" onClick={() => { onBeforeOpen?.(); onOpenSpokenMoment(captionId); }}>
          Read what was said
        </button>
      )}
      {occurrenceId && threadId && (
        <button type="button" className="text-action" onClick={() => { onBeforeOpen?.(); onOpenTopic(threadId, occurrenceId); }}>
          Open related topic
        </button>
      )}
    </div>
  );
}

// Present one still in a modal view and return focus to the control that opened it
function VisualMomentDialog({ moment, onClose, ...actions }: Pick<VisualMomentGalleryProps, 'onOpenSpokenMoment' | 'onOpenTopic'> & { moment: VisualMoment; onClose(): void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Close on Escape and keep Tab focus inside the dialog
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div className="visual-dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="visual-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={handleKeyDown}>
        <div className="visual-dialog-heading">
          <h3 id={titleId}>{moment.topicTitle}</h3>
          <button ref={closeRef} type="button" className="text-action" onClick={onClose}>Close</button>
        </div>
        <StillImage moment={moment} large />
        <p className="visual-dialog-meta">
          On screen at <time dateTime={sourceTimeDuration(moment.timestampMs)}>{formatSourceTime(moment.timestampMs)}</time> in the recording
        </p>
        <p>{moment.description}</p>
        <ContextActions moment={moment} {...actions} onBeforeOpen={onClose} />
      </div>
    </div>
  );
}

// List released original stills with timestamps, descriptions, context links, and review status
// Opening a still or its context never seeks the shared media or scrolls the reader
export function VisualMomentGallery({ moments, recording, onOpenSpokenMoment, onOpenTopic }: VisualMomentGalleryProps) {
  const headingId = useId();
  const [openId, setOpenId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const review = describeVisualReview(recording, moments.length);
  const openMoment = moments.find((moment) => moment.id === openId) ?? null;

  // Restore focus to the opening control after the dialog closes
  const closeDialog = () => {
    setOpenId(null);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  if (!review && moments.length === 0) return null;

  return (
    <section className="visual-moments" aria-labelledby={headingId}>
      <h2 id={headingId}>On screen</h2>
      {review && <p className="visual-moments-status" role="status">{review.status}</p>}
      {review?.partial && <p className="visual-moments-partial">{review.partial}</p>}
      {moments.length > 0 && (
        <ol className="visual-moment-list">
          {moments.map((moment) => (
            <li key={moment.id} className="visual-moment">
              <figure>
                <StillImage moment={moment} />
                <figcaption>
                  <time dateTime={sourceTimeDuration(moment.timestampMs)}>{formatSourceTime(moment.timestampMs)}</time>
                  <span>{moment.topicTitle}</span>
                </figcaption>
              </figure>
              <button
                type="button"
                className="text-action"
                aria-label={`View still at ${formatSourceTime(moment.timestampMs)}: ${moment.topicTitle}`}
                onClick={(event) => {
                  triggerRef.current = event.currentTarget;
                  setOpenId(moment.id);
                }}
              >
                View still
              </button>
              <ContextActions moment={moment} onOpenSpokenMoment={onOpenSpokenMoment} onOpenTopic={onOpenTopic} />
            </li>
          ))}
        </ol>
      )}
      {openMoment && (
        <VisualMomentDialog moment={openMoment} onClose={closeDialog} onOpenSpokenMoment={onOpenSpokenMoment} onOpenTopic={onOpenTopic} />
      )}
    </section>
  );
}
