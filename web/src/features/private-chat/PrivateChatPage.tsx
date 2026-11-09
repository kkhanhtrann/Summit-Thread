import { useEffect, useRef, useState } from 'react';
import { PrivateChatPanel, formatTimestamp } from './PrivateChatPanel';
import { LoadingIndicator } from '../../shared/ui/LoadingIndicator';
import { getPrivateAskContext, type PrivateAskContext } from './api/privateChatApi';

// Load only released Ask context and clear it when the selected room changes
export function PrivateChatPage({ sessionId }: { sessionId: string }) {
  return <RoomPrivateChat key={sessionId} sessionId={sessionId} />;
}

// Keep context refreshes independent from private questions and shared playback
function RoomPrivateChat({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState<PrivateAskContext | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [captionId, setCaptionId] = useState<string | null>(null);
  const evidence = useRef<HTMLElement>(null);
  const caption = snapshot?.captions.find(item => item.id === captionId);
  const hasCaption = Boolean(caption);
  // Focus a newly opened passage once while background context refreshes stay quiet
  useEffect(() => { if (captionId && hasCaption) evidence.current?.focus(); }, [captionId, hasCaption]);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const data = await getPrivateAskContext(sessionId, controller.signal);
        if (!controller.signal.aborted) { setSnapshot(data); setError(''); }
      } catch {
        if (!controller.signal.aborted) setError('We couldn’t refresh this room. Check the room code or try again.');
      } finally { running = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [sessionId, attempt]);
  return (
    <div className="app-shell chat-shell">
      <a className="skip-link" href="#private-chat">Skip to private chat</a>
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Summit Thread home">Summit Thread</a>
      </header>
      <main className="chat-main" id="private-chat">
        <header className="chat-heading">
          <p className="eyebrow">Your private questions</p>
          <h1>Ask about the talk</h1>
          <p className="chat-intro">Ask privately about what’s been said so far.</p>
          {snapshot && <p className="chat-session-title">{snapshot.session.title}</p>}
        </header>
        {error && (
          <div role="alert" className="chat-error">
            <span>{error}</span>
            <button className="text-action" onClick={() => setAttempt(value => value + 1)}>Try again</button>
          </div>
        )}
        {!snapshot ? (
          <section className="chat-loading" aria-busy={!error}>
            {error ? <p className="empty-reading">We couldn’t connect to this room.</p> : <LoadingIndicator label="Loading the talk…" />}
            {!error && <div className="loading-lines" aria-hidden="true"><span /><span /><span /></div>}
          </section>
        ) : (
          <PrivateChatPanel sessionId={sessionId} snapshot={snapshot} connectionState={error ? 'reconnecting' : 'connected'} onOpenCitation={setCaptionId} />
        )}
        {caption && <section ref={evidence} tabIndex={-1} className="ask-evidence" aria-label="Released transcript passage"><h2>From the talk · {formatTimestamp(caption.timestampMs)}</h2><blockquote>{caption.text}</blockquote><button onClick={() => setCaptionId(null)}>Close passage</button></section>}
      </main>
      <footer className="site-footer"><a href={`/rooms/${encodeURIComponent(sessionId)}`}>Return to the talk</a></footer>
    </div>
  );
}
