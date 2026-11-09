import { useEffect, useRef, useState } from 'react';

import { LoadingIndicator } from '../../shared/ui/LoadingIndicator';
import { startLiveCapture, uploadRecording, type SessionRecording } from '../sessions/public';

// Keep browser uploads within the backend's bounded media size
const MAX_RECORDING_BYTES = 300 * 1024 * 1024;

// Map common source extensions when a browser does not provide a media type
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  aac: 'audio/aac',
  aiff: 'audio/aiff',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'video/webm'
};

// Describe recording and camera actions for one host room
export interface RecordingSourcePanelProps {
  sessionId: string;
  recording: SessionRecording | null;
  onRecordingAccepted(recording: SessionRecording): void;
  onLiveCameraStarted(recording: SessionRecording, stream: MediaStream): void;
}

// Let the host upload playback or open a camera room with a separate analysis cadence
export function RecordingSourcePanel({ sessionId, recording, onRecordingAccepted, onLiveCameraStarted }: RecordingSourcePanelProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const uploadAbort = useRef<AbortController | null>(null);
  // Cancel upload work and reject late capture permission after leaving this room
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; uploadAbort.current?.abort(); };
  }, []);
  const [analysisWindowMinutes, setAnalysisWindowMinutes] = useState(5);
  const [isUploading, setIsUploading] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState('');

  // Upload one source and show transfer progress without exposing its contents
  async function sendRecording(media: Blob): Promise<void> {
    if (media.size === 0 || media.size > MAX_RECORDING_BYTES) {
      setError('Choose a recording under 300 MB.');
      return;
    }
    if (!media.type.startsWith('audio/') && !media.type.startsWith('video/')) {
      setError('Choose an audio or video recording.');
      return;
    }
    setError('');
    setIsUploading(true);
    setUploadProgress(0);
    try {
      const controller = new AbortController();
      uploadAbort.current = controller;
      const result = await uploadRecording(sessionId, media, analysisWindowMinutes, ratio => { if (active.current) setUploadProgress(ratio); }, controller.signal);
      if (active.current) onRecordingAccepted(result.recording);
    } catch (uploadError) {
      if (active.current) setError(uploadError instanceof Error ? uploadError.message : 'The upload didn’t finish. Check your connection and try again.');
    } finally {
      if (active.current) setIsUploading(false);
    }
  }

  // Keep the recording's supported content type when the browser leaves it blank
  async function chooseFile(file: File | undefined): Promise<void> {
    if (!file) return;
    const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
    const mimeType = file.type || MIME_TYPES_BY_EXTENSION[extension] || '';
    await sendRecording(mimeType ? new Blob([file], { type: mimeType }) : file);
  }

  // Start the live camera room after browser permission succeeds
  async function goLive(): Promise<void> {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Live camera is unavailable in this browser. Choose a recording instead.');
      return;
    }
    setIsStartingCamera(true);
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const result = await startLiveCapture(sessionId, analysisWindowMinutes);
      // Let the room owner accept capture after SSE replaces this source panel
      onLiveCameraStarted(result.recording, stream);
      stream = undefined;
    } catch (cameraError) {
      const browserError = cameraError instanceof DOMException ? cameraError.name : '';
      setError(browserError === 'NotAllowedError'
        ? 'Camera or microphone access was blocked. Allow access in your browser settings, then try again.'
        : browserError === 'NotFoundError'
          ? 'No camera or microphone was found. Connect one or choose a recording.'
          : 'Camera access couldn’t start. Check your browser permissions and try again.');
    } finally {
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (active.current) setIsStartingCamera(false);
    }
  }

  if (recording?.status === 'preparing') {
    return (
      <section className="recording-preparation" aria-busy="true" aria-labelledby="recording-preparation-title">
        <h2 id="recording-preparation-title">Preparing your recording</h2>
        <p>Attendees can join while the upload finishes.</p>
        <LoadingIndicator label="Uploading recording…" />
      </section>
    );
  }

  return (
    <section className="recording-source" aria-labelledby="recording-source-title">
      <h2 id="recording-source-title">Choose how to share the talk</h2>
      <p className="recording-source-copy">Play a recording for attendees or start your camera. Topic threads update at the interval you choose.</p>

      <div className="recording-frequency">
        <label htmlFor="recording-update-frequency">Update topic threads</label>
        <select
          id="recording-update-frequency"
          value={analysisWindowMinutes}
          disabled={isUploading || isStartingCamera || Boolean(recording)}
          onChange={(event) => setAnalysisWindowMinutes(Number(event.currentTarget.value))}
        >
          <option value={1}>Every minute</option>
          <option value={3}>Every 3 minutes</option>
          <option value={5}>Every 5 minutes</option>
          <option value={10}>Every 10 minutes</option>
        </select>
      </div>

      {error && <p className="inline-error" role="alert">{error}</p>}

      <div className="recording-source-actions">
        <input
          ref={fileInput}
          className="sr-only"
          type="file"
          accept="audio/aac,audio/aiff,audio/flac,audio/mp4,audio/mpeg,audio/ogg,audio/opus,audio/wav,audio/webm,audio/x-wav,video/mp4,video/mpeg,video/quicktime,video/webm"
          aria-label="Choose an audio or video recording"
          disabled={isUploading || isStartingCamera}
          onChange={(event) => { void chooseFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }}
        />
        <button className="button button-accent" type="button" disabled={isUploading || isStartingCamera} onClick={() => fileInput.current?.click()}>
          {isUploading ? <LoadingIndicator label="Uploading…" compact /> : 'Choose a recording'}
        </button>
        <button className="button button-outline" type="button" disabled={isUploading || isStartingCamera} onClick={() => void goLive()}>
          {isStartingCamera ? <LoadingIndicator label="Connecting camera…" compact /> : 'Go live with camera'}
        </button>
      </div>

      {isUploading && (
        <div className="recording-upload-progress" aria-live="polite">
          <label htmlFor="recording-upload">Uploading your recording</label>
          <progress id="recording-upload" max={1} value={uploadProgress} />
          <span>{Math.round(uploadProgress * 100)}%</span>
        </div>
      )}
    </section>
  );
}
