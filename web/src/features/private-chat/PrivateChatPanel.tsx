import './private-chat.css';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { LoadingIndicator } from '../../shared/ui/LoadingIndicator';
import type { PrivateAskContext } from './api/privateChatApi';
import { askPrivateQuestion, type PrivateChatResponse } from './api/privateChatApi';

// Describe the room-scoped Ask panel and citation-navigation callback
export interface PrivateChatPanelProps {
  sessionId: string;
  snapshot: PrivateAskContext;
  connectionState: 'loading' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable';
  initialQuestion?: { id: number; question: string; contextCaptionId: string } | null;
  onOpenCitation?: (captionId: string) => void;
}

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  citations?: PrivateChatResponse['citations'];
}

// Format cited offsets like attendee transcript timestamps
export function formatTimestamp(timestampMs: number): string {
  const totalSeconds = Math.floor(timestampMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Return a cited caption to its exact attendee transcript position
function currentTranscriptUrl(sessionId: string, captionId: string): string {
  return `/rooms/${encodeURIComponent(sessionId)}?caption=${encodeURIComponent(captionId)}`;
}

// Answer private questions from the transcript and link to supporting passages
export function PrivateChatPanel(props: PrivateChatPanelProps) {
  return <PrivateConversation key={props.sessionId} {...props} />;
}

// Scope every draft, pending request and conversation to one room mount
function PrivateConversation({ sessionId, snapshot, connectionState, initialQuestion, onOpenCitation }: PrivateChatPanelProps) {
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);
  const citationDialog = useRef<HTMLDialogElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [chatError, setChatError] = useState('');
  const [contextCaptionId, setContextCaptionId] = useState<string | null>(null);
  const [selectedCitation, setSelectedCitation] = useState<NonNullable<ChatMessage['citations']>[number] | null>(null);
  const [failedRequest, setFailedRequest] = useState<{ question: string; history: Array<{ role: 'user' | 'assistant'; content: string }>; contextCaptionId: string | null } | null>(null);
  const hasReleasedSpeech = snapshot.captions.length > 0;

  useEffect(() => {
    const dialog = citationDialog.current;
    if (selectedCitation && dialog && !dialog.open) dialog.showModal();
  }, [selectedCitation]);

  useEffect(() => {
    if (initialQuestion) {
      setDraft(initialQuestion.question);
      setContextCaptionId(initialQuestion.contextCaptionId);
    }
  }, [initialQuestion]);

  // Keep question text in component state and retry failures without duplicating the user turn
  async function sendQuestion(question: string, priorHistory: Array<{ role: 'user' | 'assistant'; content: string }>, addUserMessage: boolean, sourceCaptionId: string | null) {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion || activeRequest.current || !hasReleasedSpeech) return;

    const controller = new AbortController();
    activeRequest.current = controller;
    setChatError('');
    setFailedRequest(null);
    setDraft('');
    setContextCaptionId(null);
    if (addUserMessage) {
      setMessages((current) => [...current, { id: Date.now(), role: 'user', content: normalizedQuestion }]);
    }
    setPending(true);

    try {
      const response = await askPrivateQuestion(sessionId, {
        question: normalizedQuestion,
        history: priorHistory.slice(-6),
        contextCaptionId: sourceCaptionId ?? undefined
      }, controller.signal);
      if (controller.signal.aborted) return;
      setMessages((current) => [...current, {
        id: Date.now() + 1,
        role: 'assistant',
        content: response.answer,
        citations: response.citations
      }]);
    } catch {
      if (controller.signal.aborted) return;
      setChatError('We couldn’t get an answer just now. Your question is still in the conversation.');
      setFailedRequest({ question: normalizedQuestion, history: priorHistory, contextCaptionId: sourceCaptionId });
    } finally {
      activeRequest.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question) return;
    const history = messages.map(({ role, content }) => ({ role, content }));
    void sendQuestion(question, history, true, contextCaptionId);
  }

  function retryQuestion() {
    if (!failedRequest) return;
    void sendQuestion(failedRequest.question, failedRequest.history, false, failedRequest.contextCaptionId);
  }

  return (
    <div className="private-chat-panel">
      <p className="chat-privacy-note private-chat-panel-note">
        Your questions are private and aren’t saved or shared. Answers link to the transcript passages they use.
      </p>
      <section className={`chat-thread${messages.length > 0 ? ' has-messages' : ''}`} aria-label="Private conversation" aria-live="polite">
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <p>{hasReleasedSpeech ? 'Ask a question or choose one below.' : 'You can ask once the first transcript lines appear.'}</p>
            {snapshot.suggestedQuestions.length > 0 && (
              <>
                <p className="suggestion-heading">Suggested questions</p>
                <ul className="chat-suggestions">
                  {snapshot.suggestedQuestions.map((question) => (
                    <li key={question}>
                      <button type="button" onClick={() => { setDraft(question); setContextCaptionId(null); }}>{question}</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : messages.map((message) => (
          <article key={message.id} className={`chat-message chat-message-${message.role}`}>
            <p className="chat-message-label">{message.role === 'user' ? 'You' : 'Answer'}</p>
            <p className="chat-message-content">{message.content}</p>
            {message.citations && message.citations.length > 0 && (
              <div className="chat-citations-wrap">
                <p className="chat-citations-heading">Transcript passages <span>{message.citations.length}</span></p>
                <ul className="chat-citations" aria-label="Transcript passages supporting this answer">
                  {message.citations.map((citation, index) => (
                    <li key={citation.captionId}>
                      <button
                        type="button"
                        aria-haspopup="dialog"
                        aria-label={`View transcript at ${formatTimestamp(citation.timestampMs)}`}
                        onClick={() => setSelectedCitation(citation)}
                      >
                        <span className="chat-citation-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                        <time>{formatTimestamp(citation.timestampMs)}</time>
                        <span className="chat-citation-text">{citation.text}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        ))}
        {pending && <LoadingIndicator label="Checking the transcript…" />}
        {chatError && (
          <div className="chat-error" role="alert">
            <span>{chatError}</span>
            <button className="text-action" type="button" onClick={retryQuestion} disabled={pending}>Try again</button>
          </div>
        )}
      </section>

      <form className="chat-form" onSubmit={submit}>
        <label htmlFor="private-chat-question">Your question</label>
        <textarea
          id="private-chat-question"
          rows={3}
          maxLength={500}
          placeholder={hasReleasedSpeech ? 'Ask about a topic or moment in the talk…' : 'Available when the transcript begins…'}
          value={draft}
          disabled={!hasReleasedSpeech || pending}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="chat-form-footer">
          {connectionState !== 'connected' && (
            <span role="status">
              {connectionState === 'reconnecting' ? 'Reconnecting to the talk…'
                  : connectionState === 'unavailable' ? 'Can’t connect to talk updates'
                  : 'Connecting to the talk…'}
            </span>
          )}
          <button className="button button-accent" type="submit" disabled={!hasReleasedSpeech || pending || draft.trim().length < 2}>
            {pending ? <LoadingIndicator label="Writing an answer…" compact /> : 'Ask'}
          </button>
        </div>
      </form>

      <dialog
        className="source-citation-dialog"
        ref={citationDialog}
        aria-labelledby="source-citation-title"
        aria-describedby="source-citation-quote"
        onCancel={(event) => {
          event.preventDefault();
          citationDialog.current?.close();
        }}
        onClose={() => setSelectedCitation(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) citationDialog.current?.close();
        }}
      >
        {selectedCitation && (
          <div className="source-citation-shell">
            <header className="source-citation-header">
              <div>
                <h2 id="source-citation-title">{formatTimestamp(selectedCitation.timestampMs)}</h2>
                <p className="source-citation-kind">From the transcript</p>
              </div>
              <button className="source-citation-close" type="button" onClick={() => citationDialog.current?.close()} aria-label="Close source details"><span aria-hidden="true">×</span></button>
            </header>
            <div className="source-citation-body">
              <blockquote id="source-citation-quote">{selectedCitation.text}</blockquote>
            </div>
            <footer className="source-citation-footer">
              <p>Source passage</p>
              <a
                className="text-action"
                href={currentTranscriptUrl(sessionId, selectedCitation.captionId)}
                onClick={onOpenCitation ? (event) => {
                  event.preventDefault();
                  citationDialog.current?.close();
                  onOpenCitation(selectedCitation.captionId);
                } : undefined}
              >
                View in transcript
              </a>
            </footer>
          </div>
        )}
      </dialog>
    </div>
  );
}
