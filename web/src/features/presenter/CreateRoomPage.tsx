import { useState, type FormEvent } from 'react';
import { createSession } from '../sessions/public';

// Create a presenter room from a validated talk title
export function CreateRoomPage({ navigate }: { navigate(path: string): void }) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function create(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!title.trim() || title.trim().length > 100) {
      setError('Enter a talk title of 1 to 100 characters.');
      return;
    }
    setPending(true);
    try {
      const snapshot = await createSession(title.trim());
      navigate(`/presenter/${snapshot.session.id}`);
    } catch {
      setError(
        'The room could not be created. Check the connection and try again.'
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="entry">
      <div>
        <h1>Give your talk a room.</h1>
        <p className="lead">
          Share a room, upload your recording, and let attendees follow the
          words as it plays.
        </p>
      </div>
      <form onSubmit={(event) => void create(event)}>
        <h2>Create a presenter room</h2>
        <label htmlFor="talk-title">Talk title</label>
        <input
          id="talk-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={100}
          required
          autoComplete="off"
          aria-describedby={error ? 'create-error' : undefined}
        />
        <p className="muted">
          Attendees will see this title on their room page.
        </p>
        {error && (
          <p role="alert" id="create-error">
            {error}
          </p>
        )}
        <button disabled={pending}>
          {pending ? 'Creating room…' : 'Create room'}
        </button>
      </form>
    </main>
  );
}
