import { useEffect, useState } from 'react';
import { JoinSessionPage, useSessionFeed } from '../features/sessions/public';
import { PresenterPage } from '../features/presenter/public';
import { PrivateChatPage } from '../features/private-chat/public';
import { SessionReaderPage } from '../features/session-reader/public';

// Follow browser history and remount all private room state when the route changes
export function App() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const changed = () => setPath(window.location.pathname);
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);
  const navigate = (next: string) => {
    history.pushState({}, '', next);
    setPath(next);
  };
  if (path === '/ask') {
    const code = new URL(window.location.href).searchParams.get('session')?.trim().toUpperCase();
    return code && /^[A-F0-9]{8}$/.test(code) ? <PrivateChatPage key={code} sessionId={code} /> : <main><h1>Choose a room</h1><p>Use your room’s private Ask link or enter its code.</p><form action="/ask"><label htmlFor="ask-room">Room code</label><input name="session" id="ask-room" required pattern="[A-Fa-f0-9]{8}" minLength={8} maxLength={8} /><button>Open private Ask</button></form><a href="/">Join a room</a></main>;
  }
  const route = /^\/(rooms|presenter)\/([^/]+)\/?$/.exec(path);
  const code = route?.[2]?.trim().toUpperCase();
  if (path === '/presenter' || route?.[1] === 'presenter') return <PresenterPage key={code ?? 'create'} initialSessionId={code} />;
  if (route?.[1] === 'rooms') return <Room key={`rooms:${code}`} code={code!} presenter={false} />;
  return (
    <>
      <header className="masthead">
        <a href="/">Summit Thread</a>
        <nav aria-label="Main">
          <a href="/">Join a room</a>
          <a href="/presenter">Present a talk</a>
        </nav>
      </header>
      {route ? (
        <Room
          key={`${route[1]}:${code}`}
          code={code!}
          presenter={route[1] === 'presenter'}
        />
      ) : (
        <JoinSessionPage navigate={navigate} />
      )}
      <footer>Local conference rooms · Recording playback</footer>
    </>
  );
}
function Room({ code }: { code: string; presenter: boolean }) {
  const { snapshot, connectionState, error, retry } = useSessionFeed(code);
  if (!snapshot)
    return (
      <main>
        <h1>{error ? 'Room unavailable' : 'Opening your room…'}</h1>
        <p role={error ? 'alert' : 'status'}>
          {error ??
            (connectionState === 'reconnecting'
              ? 'The API is still connecting. Retrying shortly…'
              : 'Loading the latest room state.')}
        </p>
        <button onClick={retry}>Retry connection</button>{' '}
        <a href="/">Enter another code</a>
      </main>
    );
  return <SessionReaderPage key={code} snapshot={snapshot} connectionState={connectionState} error={error} retry={retry} />;
}
