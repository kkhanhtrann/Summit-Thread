// Signal an unknown, unreleased, or wrong-room visual moment without revealing which case applied
export class VisualMomentNotFoundError extends Error {
  constructor() {
    super('Visual moment not found');
    this.name = 'VisualMomentNotFoundError';
  }
}

// Signal that a released still exists in room state but its image file cannot be read
export class VisualImageUnavailableError extends Error {
  constructor() {
    super('The image for this visual moment is unavailable');
    this.name = 'VisualImageUnavailableError';
  }
}

// Signal that the room source cannot accept visual analysis input right now
export class VisualSourceNotReadyError extends Error {
  constructor() {
    super('The room source is not ready for visual review');
    this.name = 'VisualSourceNotReadyError';
  }
}

// Signal a live clip submitted ahead of the next expected window index
export class LiveWindowOrderError extends Error {
  constructor() {
    super('Live clips must be submitted in capture order');
    this.name = 'LiveWindowOrderError';
  }
}

// Signal a completed live clip larger than local analysis storage accepts
export class VisualClipTooLargeError extends Error {
  constructor() {
    super('The live clip is too large');
    this.name = 'VisualClipTooLargeError';
  }
}

// Name fixed, content-free failure categories shared by retries, telemetry, and diagnostics
export const visualFailureCategories = [
  'not_configured',
  'provider_rejected',
  'provider_timeout',
  'provider_unavailable',
  'rate_limited',
  'invalid_output',
  'clip_extraction_failed',
  'frame_extraction_failed',
  'storage_failed'
] as const;

// Describe one fixed visual-analysis failure category
export type VisualFailureCategory = typeof visualFailureCategories[number];
