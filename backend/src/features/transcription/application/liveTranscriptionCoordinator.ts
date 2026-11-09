import { randomUUID } from 'node:crypto';
import { metrics } from '@opentelemetry/api';

// Count fixed operational outcomes without attaching speech or room content
const outcomes = metrics
  .getMeter('summit-thread-backend')
  .createCounter('transcription.outcomes');

// Describe an interim or finalized recognition result
export interface LiveSpeechUpdate {
  type: 'interim' | 'final';
  text: string;
}

// Describe connection and recognition status sent to the presenter
export type LiveTranscriptionEvent =
  | { type: 'ready' }
  | { type: 'interim'; text: string }
  | { type: 'finalized' }
  | { type: 'connection'; state: 'reconnecting' | 'ready' }
  | { type: 'error'; message: string; retryable?: boolean };

// Define the active provider stream used by one presenter room
export interface LiveSpeechSession {
  sendAudio(audio: Buffer): void;
  finish(): Promise<void>;
  close(): Promise<void>;
}

// Keep the Google Live API behind an injectable application boundary
export interface LiveSpeechProvider {
  connect(
    onTranscript: (update: LiveSpeechUpdate) => void,
    onError: () => void,
    onConnectionState?: (state: 'reconnecting' | 'ready') => void
  ): Promise<LiveSpeechSession>;
}

// Persist final speech without immediately grouping it into a topic
export interface LiveTranscriptionPublisher {
  releaseFinalCaption(
    sessionId: string,
    text: string,
    timestampMs: number,
    options: { deferTopicAnalysis: true; captionId: string }
  ): Promise<unknown>;
}

// Keep one provider stream, source clock, and ordered write queue per room
interface ActiveCapture {
  sessionId: string;
  // Keep caption source times monotonic when playback seeks or provider callbacks arrive late
  positionMs: number;
  lastTimestampMs: number;
  providerSession?: LiveSpeechSession;
  emit: (event: LiveTranscriptionEvent) => void;
  writes: Promise<void>;
  lastFinalText?: string;
  lastFinalAt?: number;
  stopping?: Promise<void>;
  failed?: boolean;
  pendingWrites: number;
}

// Stream source audio to Gemini Live and persist only finalized captions
export class LiveTranscriptionCoordinator {
  private readonly active = new Map<string, ActiveCapture>();

  constructor(
    private readonly dependencies: {
      provider: LiveSpeechProvider;
      publisher: LiveTranscriptionPublisher;
      now?: () => number;
    }
  ) {}

  // Start real-time transcription for one room and its current media position
  async start(
    sessionId: string,
    initialPositionMs: number,
    emit: (event: LiveTranscriptionEvent) => void
  ): Promise<{
    sendAudio(audio: Buffer): void;
    setPosition(positionMs: number): void;
    flush(): Promise<void>;
    stop(): Promise<void>;
  }> {
    if (this.active.has(sessionId))
      throw new Error('Transcription is already connected for this room');
    if (!Number.isSafeInteger(initialPositionMs) || initialPositionMs < 0)
      throw new RangeError('Transcript source position is invalid');

    const capture: ActiveCapture = {
      sessionId,
      positionMs: initialPositionMs,
      lastTimestampMs: initialPositionMs,
      emit,
      writes: Promise.resolve(),
      pendingWrites: 0
    };
    this.active.set(sessionId, capture);
    try {
      capture.providerSession = await this.dependencies.provider.connect(
        (update) => this.handleTranscript(capture, update),
        () => {
          outcomes.add(1, { state: 'provider_failed' });
          capture.failed = true;
          emit({
            type: 'error',
            message:
              'The transcript lost its connection. Pause and resume to try again.'
          });
        },
        (state) => emit({ type: 'connection', state })
      );
    } catch {
      outcomes.add(1, { state: 'connect_failed' });
      if (this.active.get(sessionId) === capture) this.active.delete(sessionId);
      throw new Error('Live transcription could not start');
    }

    outcomes.add(1, { state: 'connected' });
    return {
      sendAudio: (audio) => {
        if (
          this.active.get(sessionId) !== capture ||
          capture.stopping ||
          capture.failed ||
          !capture.providerSession
        )
          return;
        capture.providerSession.sendAudio(audio);
      },
      setPosition: (positionMs) => {
        if (
          !Number.isSafeInteger(positionMs) ||
          positionMs < 0 ||
          this.active.get(sessionId) !== capture
        )
          return;
        // Do not move already-streaming recognition backward on a source seek
        capture.positionMs = Math.max(capture.positionMs, positionMs);
      },
      flush: () => capture.writes,
      stop: () => this.stop(capture)
    };
  }

  // Keep tentative recognition visible to the host without writing it to the room
  private handleTranscript(
    capture: ActiveCapture,
    update: LiveSpeechUpdate
  ): void {
    if (this.active.get(capture.sessionId) !== capture || capture.failed)
      return;
    const text = update.text.trim().replace(/\s+/g, ' ');
    if (!text) return;
    if (update.type === 'interim') {
      capture.emit({ type: 'interim', text: text.slice(0, 2000) });
      return;
    }

    if (text.length > 20_000) {
      capture.failed = true;
      capture.emit({
        type: 'error',
        message:
          'The transcript returned an oversized line. Pause and resume to retry.'
      });
      return;
    }
    const now = this.dependencies.now?.() ?? Date.now();
    // Drop duplicate finals that can repeat when the provider resumes a stream
    if (
      capture.lastFinalText === text &&
      capture.lastFinalAt !== undefined &&
      now - capture.lastFinalAt < 1_500
    )
      return;
    capture.lastFinalText = text;
    capture.lastFinalAt = now;
    const timestampMs = Math.max(capture.lastTimestampMs, capture.positionMs);
    capture.lastTimestampMs = timestampMs;
    if (capture.failed || capture.pendingWrites >= 100) {
      capture.emit({
        type: 'error',
        message: 'Transcript saving is behind. Pause and resume to reconnect.'
      });
      return;
    }
    capture.pendingWrites += 1;
    const captionId = randomUUID();
    capture.writes = capture.writes
      .then(async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await this.dependencies.publisher.releaseFinalCaption(
              capture.sessionId,
              text,
              timestampMs,
              { deferTopicAnalysis: true, captionId }
            );
            outcomes.add(1, { state: 'finalized' });
            capture.emit({ type: 'finalized' });
            return;
          } catch {
            if (attempt === 2) throw new Error('Caption persistence failed');
            await new Promise((resolve) =>
              setTimeout(resolve, 100 * 2 ** attempt)
            );
          }
        }
      })
      .catch(() => {
        outcomes.add(1, { state: 'write_failed' });
        capture.failed = true;
        capture.emit({
          type: 'error',
          message:
            'A transcript line could not be saved after retrying. Pause and resume to reconnect.'
        });
      })
      .finally(() => {
        capture.pendingWrites -= 1;
      });
  }

  // Finish the provider stream and release its room slot exactly once
  private stop(capture: ActiveCapture): Promise<void> {
    if (capture.stopping) return capture.stopping;
    capture.stopping = (async () => {
      try {
        try {
          await capture.providerSession?.finish();
        } finally {
          await capture.writes;
        }
      } finally {
        await capture.providerSession?.close().catch(() => undefined);
        if (this.active.get(capture.sessionId) === capture)
          this.active.delete(capture.sessionId);
      }
    })();
    return capture.stopping;
  }
}
