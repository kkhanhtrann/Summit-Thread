import type { components } from '../../../lib/api/generated';
import {
  openJsonEventStream,
  requestJson,
  uploadBinary
} from '../../../lib/api/http';

// Reuse types generated from the backend-owned OpenAPI contract
// Describe the request for a new presenter room
export type CreateSessionRequest =
  components['schemas']['CreateSessionRequest'];
// Describe the persisted state returned for one conference room
export type SessionSnapshot = components['schemas']['SessionSnapshot'];
// Describe room events delivered to connected web clients
export type SessionEvent = components['schemas']['SessionEvent'];
// Describe the public status and current position of one room recording
export type SessionRecording = components['schemas']['SessionRecording'];
// Describe one released visual landmark from a prepared talk
export type VisualMoment = components['schemas']['VisualMoment'];

// Accept the selected audio or video file and report transfer progress
export function uploadRecording(
  sessionId: string,
  media: Blob,
  analysisWindowMinutes: number,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal
): Promise<{ recording: SessionRecording }> {
  return uploadBinary(
    `/api/sessions/${encodeURIComponent(sessionId)}/recording`,
    media,
    onProgress,
    {
      'X-Thread-Update-Minutes': String(analysisWindowMinutes)
    },
    signal
  );
}

// Keep the shared room clock aligned with presenter playback controls
export function updateRecordingPlayback(
  sessionId: string,
  positionMs: number,
  isPlaying: boolean
): Promise<{ recording: SessionRecording }> {
  return requestJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/recording/playback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positionMs, isPlaying })
    }
  );
}
// Create an empty room and receive its attendee code
export function createSession(title: string): Promise<SessionSnapshot> {
  return requestJson('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title } satisfies CreateSessionRequest)
  });
}

// Fetch the current state for one room code
export function fetchSession(
  sessionId: string,
  signal?: AbortSignal
): Promise<SessionSnapshot> {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    signal
  });
}

// Subscribe to fresh room snapshots and subsequent revisioned updates
export function subscribeSession(
  sessionId: string,
  onEvent: (event: SessionEvent) => void,
  onConnectionChange: (connected: boolean) => void
): () => void {
  return openJsonEventStream(
    `/api/sessions/${encodeURIComponent(sessionId)}/events`,
    [
      'snapshot',
      'caption_released',
      'live_status_changed',
      'topic_updated',
      'recording_updated',
      'visual_moment_released'
    ],
    onEvent,
    onConnectionChange
  );
}

// Start a camera room with an independent thread update interval
export function startLiveCapture(sessionId: string, analysisWindowMinutes: number): Promise<{ recording: SessionRecording }> {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/recording/live/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysisWindowMinutes })
  });
}

// Upload one camera copy while its WebRTC attendee stream keeps running
export function uploadLiveWindow(
  sessionId: string,
  index: number,
  media: Blob
): Promise<{ recording: SessionRecording }> {
  return uploadBinary(
    `/api/sessions/${encodeURIComponent(sessionId)}/recording/live/windows/${index}`,
    media,
    () => undefined,
    { 'X-Live-Window-Index': String(index) }
  );
}

// End the live camera room after its final analysis window is sent
export function stopLiveCapture(sessionId: string): Promise<{ recording: SessionRecording }> {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/recording/live/stop`, { method: 'POST' });
}
