import type { SessionEvent } from '../contracts/session.contract';
// Define the room-scoped committed update channel
export interface SessionEventPort {
  publish(sessionId: string, event: SessionEvent): void;
  subscribe(
    sessionId: string,
    listener: (event: SessionEvent) => void
  ): () => void;
}

// Deliver in-process session updates and release listeners on unsubscribe
export class SessionEventHub implements SessionEventPort {
  private readonly listeners = new Map<
    string,
    Set<(event: SessionEvent) => void>
  >();

  publish(sessionId: string, event: SessionEvent): void {
    const listeners = this.listeners.get(sessionId);
    for (const listener of listeners ?? []) {
      try {
        listener(event);
      } catch {
        listeners?.delete(listener);
      }
    }
    if (!listeners?.size) this.listeners.delete(sessionId);
  }

  subscribe(
    sessionId: string,
    listener: (event: SessionEvent) => void
  ): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);

    return () => {
      // Drop empty room sets so disconnected readers do not accumulate
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }
}
