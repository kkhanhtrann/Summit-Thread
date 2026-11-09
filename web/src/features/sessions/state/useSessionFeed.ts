import { useCallback, useEffect, useState } from 'react';
import type { SessionEvent, SessionSnapshot } from '../api/sessionsApi';
import { fetchSession, subscribeSession } from '../api/sessionsApi';
import { applySessionEvent, requiresSessionRefresh } from './sessionFeedState';

type ConnectionState =
  | 'loading'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unavailable';
// Retry temporary server, network and bounded request timeout failures
function retryable(error: unknown) {
  if (error instanceof TypeError || error instanceof DOMException) return true;
  return (
    error instanceof Error &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    (error.statusCode >= 500 ||
      error.statusCode === 408 ||
      error.statusCode === 429)
  );
}
// Reconcile buffered revisioned events against authoritative snapshots for one room
export function useSessionFeed(sessionId: string | undefined) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let latest: SessionSnapshot | null = null;
    let unsubscribe: (() => void) | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    let streamConnected = false;
    let target = 0;
    let retries = 0;
    const buffered = new Map<number, SessionEvent>();
    setSnapshot(null);
    setError(null);
    setConnectionState('loading');
    if (!sessionId || !/^[A-F0-9]{8}$/.test(sessionId)) {
      setError('Enter an eight-character room code.');
      setConnectionState('unavailable');
      return () => {
        active = false;
      };
    }
    const commit = (value: SessionSnapshot) => {
      latest = value;
      setSnapshot(value);
    };
    const reconcile = () => {
      if (!latest) return;
      for (const [revision, event] of [...buffered].sort(([a], [b]) => a - b)) {
        if (revision <= latest.session.revision) {
          buffered.delete(revision);
          continue;
        }
        if (revision !== latest.session.revision + 1) break;
        const next = applySessionEvent(latest, event);
        if (next) commit(next);
        buffered.delete(revision);
      }
    };
    const refresh = (minimum: number) => {
      target = Math.max(target, minimum);
      if (refreshing || !active) return;
      refreshing = true;
      let failed = false;
      void fetchSession(sessionId, controller.signal)
        .then((fresh) => {
          if (!active) return;
          if (!latest || fresh.session.revision >= latest.session.revision)
            commit(fresh);
          reconcile();
          setConnectionState(streamConnected ? 'connected' : 'reconnecting');
        })
        .catch(() => {
          failed = true;
          if (active) setConnectionState('reconnecting');
        })
        .finally(() => {
          refreshing = false;
          if (!active) return;
          if (failed || !latest || latest.session.revision < target)
            refreshTimer = setTimeout(() => refresh(target), 1000);
        });
    };
    const receive = (event: SessionEvent) => {
      if (!active) return;
      if (event.type === 'snapshot') {
        const next = applySessionEvent(latest, event);
        if (next) commit(next);
        reconcile();
        return;
      }
      if (refreshing || requiresSessionRefresh(latest, event)) {
        buffered.set(event.revision, event);
        // Bound transient recovery memory and rely on Postgres after overflow
        if (buffered.size > 1000) buffered.clear();
        refresh(Math.max(latest?.session.revision ?? 0, event.revision));
        return;
      }
      const next = applySessionEvent(latest, event);
      if (next) commit(next);
    };
    const load = () => {
      void fetchSession(sessionId, controller.signal)
        .then((initial) => {
          if (!active) return;
          commit(initial);
          setError(null);
          setConnectionState('connecting');
          unsubscribe = subscribeSession(sessionId, receive, (connected) => {
            if (!active) return;
            streamConnected = connected;
            setConnectionState(connected ? 'connected' : 'reconnecting');
            if (connected) refresh(latest?.session.revision ?? 0);
          });
        })
        .catch((failure) => {
          if (!active) return;
          if (retryable(failure) && retries < 5) {
            setConnectionState('reconnecting');
            retryTimer = setTimeout(
              load,
              Math.min(1000 * 2 ** retries++, 8000)
            );
          } else {
            setError(
              'The room could not be opened. Check the code and connection, then retry.'
            );
            setConnectionState('unavailable');
          }
        });
    };
    load();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(retryTimer);
      clearTimeout(refreshTimer);
      unsubscribe?.();
      buffered.clear();
    };
  }, [sessionId, attempt]);
  return {
    snapshot: snapshot?.session.id === sessionId ? snapshot : null,
    connectionState,
    error,
    retry
  };
}
