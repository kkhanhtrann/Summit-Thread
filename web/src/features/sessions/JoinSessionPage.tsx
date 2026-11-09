import { useState, type FormEvent } from 'react';
import { SummitLogo } from '../../shared/ui/BrandMark';

// Normalize attendee invitations before selecting a room subscription
export function JoinSessionPage({
  navigate
}: {
  navigate(path: string): void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  function join(event: FormEvent) {
    event.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (!/^[A-F0-9]{8}$/.test(normalized)) {
      setError('Enter the eight-character code from your presenter.');
      return;
    }
    navigate(`/rooms/${normalized}`);
  }
  return (
    <main className="entry">
      <div className="entry-intro">
        <h1>Follow every word.</h1>
        <p className="lead">
          Watch the shared recording, read the speaker’s words as they land,
          and catch up on any topic you missed — at your own pace.
        </p>
        {/* Draw the logo's mountain line once on load; the page's one orchestrated moment */}
        <SummitLogo className="entry-art" />
      </div>
      <form className="entry-card" onSubmit={join}>
        <h2>Join your talk</h2>
        <label htmlFor="room-code">Room code</label>
        <input
          id="room-code"
          className="room-code-input"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          maxLength={32}
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="A1B2C3D4"
          aria-describedby={error ? 'join-hint join-error' : 'join-hint'}
        />
        <p className="muted" id="join-hint">
          Use the eight-character code on your invitation.
        </p>
        {error && (
          <p role="alert" id="join-error">
            {error}
          </p>
        )}
        <button className="button-sun">Join room</button>
        <p className="entry-alt">
          Giving the talk? <a href="/presenter">Create a room</a>
        </p>
      </form>
    </main>
  );
}
