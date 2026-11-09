import { useEffect, useState } from 'react';
import { getReadiness } from '../features/system/public';
// Show the actual foundation readiness returned by the backend
export function App() {
  const [status, setStatus] = useState('Checking local services…');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setStatus('Checking local services…');
    void getReadiness().then(() => { if (active) setStatus('Local services are ready'); }).catch(() => { if (active) setStatus('Local services are unavailable. Start the API, database, and search, then retry.'); });
    return () => { active = false; };
  }, [attempt]);
  return <main><p className="eyebrow">SUMMIT THREAD</p><h1>A foundation for following the conversation.</h1><p>Local development foundation</p><p role="status">{status}</p><button onClick={() => setAttempt(attempt + 1)}>Check again</button></main>;
}
