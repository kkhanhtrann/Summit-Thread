import type { components } from '../../lib/api/generated';

// Describe one released original still as delivered in room snapshots and events
export type VisualMoment = components['schemas']['VisualMomentView'];

// Describe the recording state that carries visual-review progress and diagnostics
export type VisualReviewRecording = components['schemas']['SessionRecordingView'];
