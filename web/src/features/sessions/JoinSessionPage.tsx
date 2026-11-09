import { useState, type FormEvent } from 'react';

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
      <div>
        <h1>Follow every word.</h1>
        <p className="lead">
          Watch the shared recording and read the speaker’s words at your own
          pace.
        </p>
      </div>
      <form onSubmit={join}>
        <h2>Join your talk</h2>
        <label htmlFor="room-code">Room code</label>
        <input
          id="room-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          maxLength={32}
          required
          autoComplete="off"
          spellCheck={false}
          aria-describedby={error ? 'join-error' : undefined}
        />
        <p className="muted">
          Use the eight-character code on your invitation.
        </p>
        {error && (
          <p role="alert" id="join-error">
            {error}
          </p>
        )}
        <button>Join room</button>
      </form>
    </main>
  );
}
