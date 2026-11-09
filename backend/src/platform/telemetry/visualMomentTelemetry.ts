import { metrics } from '@opentelemetry/api';

import type { VisualMomentTelemetryPort } from '../../features/sessions/application/visualMomentService';
import { logger } from '../logging/logger';

// Record visual review with counts, durations, states, and fixed categories only
// Never receives pixels, descriptions, prompts, provider payloads, or storage paths
export function createVisualMomentTelemetry(): VisualMomentTelemetryPort {
  const meter = metrics.getMeter('summit-thread-backend');
  const windows = meter.createCounter('visual.windows.reviewed');
  const windowDuration = meter.createHistogram('visual.window.duration', { unit: 'ms' });
  const failures = meter.createCounter('visual.attempts.failed');
  const releases = meter.createCounter('visual.moments.released');
  const images = meter.createCounter('visual.images.requested');

  return {
    windowReviewed: ({ sourceType, state, attempts, momentCount, durationMs }) => {
      windows.add(1, { sourceType, state });
      windowDuration.record(durationMs, { sourceType, state });
      logger.info({ event: 'visual_window_reviewed', sourceType, state, attempt: attempts, count: momentCount, durationMs });
    },
    attemptFailed: ({ sourceType, errorCategory, attempt }) => {
      failures.add(1, { sourceType, errorType: errorCategory });
      logger.warn({ event: 'visual_attempt_failed', sourceType, errorType: errorCategory, attempt });
    },
    momentReleased: (sourceType) => {
      releases.add(1, { sourceType });
    },
    imageRequested: (state) => {
      images.add(1, { state });
    }
  };
}
