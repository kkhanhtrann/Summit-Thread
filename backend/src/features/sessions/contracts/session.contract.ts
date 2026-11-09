import { z } from 'zod';

// Validate the short title shown to attendees when they join a room
export const createSessionSchema = z
  .object({
    title: z.string().trim().min(1).max(100)
  })
  .strict();

// Normalize shared room codes before lookup or local storage access
export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-F0-9]{8}$/);

// Bound session search input before passing it to Elasticsearch
export const searchQuerySchema = z.string().trim().min(2).max(200);

// Describe the information required to create a room
export type CreateSessionRequest = z.infer<typeof createSessionSchema>;

// Describe one finalized caption shared with room attendees
export interface CaptionView {
  id: string;
  sequence: number;
  timestampMs: number;
  text: string;
  threadId?: string;
  occurrenceId?: string;
}

// Group caption moments by their stable topic and each return to it
export interface TopicThreadView {
  id: string;
  title: string;
  summary: string;
  occurrences: TopicOccurrenceView[];
}

// Describe one continuous stretch of a recurring topic
export interface TopicOccurrenceView {
  id: string;
  summary: string;
  startedAtMs: number;
  endedAtMs: number | null;
  evidenceCaptionIds: string[];
  captions: CaptionView[];
}

// Describe a selected visual landmark before it is released to attendees
export interface PreparedVisualMoment {
  id: string;
  timestampMs: number;
  topicTitle: string;
  description: string;
}

// Describe a released landmark with its attendee-safe image route
export interface VisualMomentView extends PreparedVisualMoment {
  imageUrl: string;
}

// Track the visible preparation and playback state for a room recording
export interface SessionRecordingView {
  sourceType: 'upload' | 'camera';
  status: 'preparing' | 'ready' | 'failed';
  preparationStage: 'uploading' | null;
  mediaKind: 'audio' | 'video';
  mimeType: string;
  durationMs: number | null;
  playbackPositionMs: number;
  isPlaying: boolean;
  analysisWindowMinutes: number;
  // Keep older sessions from reporting unknown review history as zero skips
  visualReviewSkippedWindowCount: number | null;
  analysisThroughMs: number;
  analysisState: 'waiting' | 'analyzing' | 'ready' | 'failed' | 'complete';
  mediaUrl: string;
  playbackUpdatedAt: string;
}

// Describe the current room state returned by session APIs
export interface SessionView {
  id: string;
  title: string;
  eventName: string;
  speakerName: string;
  contentLabel: string;
  revision: number;
  releasedCount: number;
  isLive: boolean;
}

// Pair room state with only captions already released to attendees
export interface SessionSnapshot {
  session: SessionView;
  captions: CaptionView[];
  threads: TopicThreadView[];
  activeOccurrenceId: string | null;
  suggestedQuestions: string[];
  // Count released captions skipped after repeated topic-analysis failures
  topicAnalysisSkippedCaptionCount: number;
  recording: SessionRecordingView | null;
  visualMoments: VisualMomentView[];
}

// Define updates sent to connected attendee and presenter views
export type SessionEvent =
  | { type: 'caption_released'; revision: number; caption: CaptionView }
  | { type: 'live_status_changed'; revision: number; isLive: boolean }
  | { type: 'topic_updated'; revision: number; snapshot: SessionSnapshot }
  | {
      type: 'recording_updated';
      revision: number;
      recording: SessionRecordingView;
    }
  | {
      type: 'visual_moment_released';
      revision: number;
      moment: VisualMomentView;
    };

// Signal that the requested room does not exist
export class SessionNotFoundError extends Error {
  constructor() {
    super('Session not found');
    this.name = 'SessionNotFoundError';
  }
}

// Signal that the search service could not answer a session query
export class SearchUnavailableError extends Error {
  constructor() {
    super('Search is temporarily unavailable');
    this.name = 'SearchUnavailableError';
  }
}

// Signal that the room has no prepared recording to play
export class RecordingNotReadyError extends Error {
  constructor() {
    super('The room recording is not ready');
    this.name = 'RecordingNotReadyError';
  }
}

// Signal that released room content prevents replacing the recording
export class RecordingConflictError extends Error {
  constructor() {
    super('The room recording can no longer be replaced');
    this.name = 'RecordingConflictError';
  }
}

// Signal that an uploaded recording exceeds the supported size
export class RecordingTooLargeError extends Error {
  constructor() {
    super('The recording is too large');
    this.name = 'RecordingTooLargeError';
  }
}

// Signal that an uploaded recording uses an unsupported audio or video format
export class RecordingUnsupportedTypeError extends Error {
  constructor() {
    super('The recording format is not supported');
    this.name = 'RecordingUnsupportedTypeError';
  }
}
