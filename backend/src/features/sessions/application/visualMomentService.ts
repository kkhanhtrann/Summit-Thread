import type {
  PreparedVisualMoment,
  SessionEvent,
  SessionRecordingView,
  VisualMomentView
} from '../contracts/session.contract';
import {
  LiveWindowOrderError,
  VisualImageUnavailableError,
  VisualMomentNotFoundError,
  VisualSourceNotReadyError,
  visualFailureCategories,
  type VisualFailureCategory
} from '../contracts/visualMoment.contract';
import { toRecordingView } from './recordingView';
import {
  isSameElapsedWindow,
  nextElapsedWindow,
  selectWindowMoment,
  type AnalysisWindow,
  type WindowRelativeMoment
} from './visualWindows';

// Bound provider and extraction attempts for one window before it is recorded as skipped
const DEFAULT_MAX_ATTEMPTS = 3;
// Space attempts so transient provider failures can clear without stalling playback
const DEFAULT_RETRY_DELAY_MS = 5_000;

// Name the visual-review states shared through the recording view
export type VisualAnalysisState = SessionRecordingView['analysisState'];

// Hold the recording fields visual analysis reads; playback and media fields stay owned by the media workflow
export interface VisualSourceRecord {
  sessionId: string;
  sourceType: 'upload' | 'camera';
  status: 'preparing' | 'ready' | 'failed';
  preparationStage: 'uploading' | null;
  mediaKind: 'audio' | 'video';
  mimeType: string;
  durationMs: number | null;
  playbackPositionMs: number;
  // Carry the playback owner's clock timestamp through recording events unchanged
  playbackUpdatedAt: string;
  isPlaying: boolean;
  analysisWindowMinutes: number;
  // Count committed windows; the next window index equals this cursor
  analysisWindowCount: number;
  // Mark the completed-through source time for committed windows
  analysisThroughMs: number;
  analysisState: VisualAnalysisState;
  // Preserve unknown legacy history as null instead of reporting zero skips
  visualReviewSkippedWindowCount: number | null;
  // Guard concurrent releases with the persisted release cursor
  releasedVisualMomentCount: number;
  // Contain released moments only; pending candidates stay in ignored local storage
  releasedMoments: PreparedVisualMoment[];
}

// Return updated source state with the shared room revision from one mutation
export interface VisualSourceMutation {
  source: VisualSourceRecord;
  revision: number;
}

// Link a still to the released caption spoken at or just before it
export interface SpokenContext {
  captionId: string;
  occurrenceId: string | null;
  threadId: string | null;
}

// Keep durable visual cursors and released metadata behind the sessions persistence boundary
export interface VisualMomentRepositoryPort {
  getSource(sessionId: string): Promise<VisualSourceRecord | null>;
  setAnalysisState(sessionId: string, state: VisualAnalysisState): Promise<VisualSourceMutation>;
  // Commit one window in index order; repeating an already committed index is a no-op
  completeWindow(sessionId: string, window: { index: number; startMs: number; throughMs: number; skipped: boolean }): Promise<VisualSourceMutation>;
  // Append one released moment only while the release cursor still matches and the ID is new
  releaseMoment(sessionId: string, moment: PreparedVisualMoment, expectedReleasedCount: number): Promise<{ moment: PreparedVisualMoment; revision: number } | null>;
  findSpokenContexts(sessionId: string, timestampsMs: readonly number[]): Promise<Map<number, SpokenContext>>;
}

// Cache one window's review result and retry bookkeeping in ignored room-scoped storage
export interface StoredVisualWindow {
  sessionId: string;
  index: number;
  startMs: number;
  durationMs: number;
  // Tie cached work to the analyzed source so a replaced upload cannot reuse stale results
  sourceKey: string;
  status: 'pending' | 'reviewed' | 'skipped';
  attempts: number;
  lastErrorCategory: VisualFailureCategory | null;
  // Hold an unreleased candidate in source time after its original frame is stored
  candidate: PreparedVisualMoment | null;
}

// Keep local media, clips, caches, and stills replaceable in focused behavior tests
export interface VisualAssetPort {
  sourceKey(sessionId: string): Promise<string>;
  sourcePath(sessionId: string): string;
  // Extract only the requested elapsed interval for provider input
  createClip(sessionId: string, window: AnalysisWindow): Promise<{ path: string; mimeType: string }>;
  saveLiveClip(sessionId: string, index: number, mimeType: string, chunks: AsyncIterable<Uint8Array>): Promise<{ path: string; mimeType: string }>;
  probeDurationMs(path: string): Promise<number>;
  removeClip(sessionId: string, path: string): Promise<void>;
  readWindow(sessionId: string, index: number): Promise<StoredVisualWindow | null>;
  listWindows(sessionId: string): Promise<StoredVisualWindow[]>;
  writeWindow(sessionId: string, window: StoredVisualWindow): Promise<void>;
  // Store original frame pixels decoded at the offset inside the given media file
  extractFrame(sessionId: string, momentId: string, mediaPath: string, offsetMs: number): Promise<void>;
  getImageFile(sessionId: string, momentId: string): Promise<{ path: string; size: number }>;
}

// Inspect one isolated clip and return at most one window-relative suggestion
export interface VisualAnalyzerPort {
  analyzeWindow(input: { clipPath: string; mimeType: string; durationMs: number }): Promise<{ moments: WindowRelativeMoment[] }>;
}

// Publish revisioned room events through the media workflow's event hub
export interface VisualEventPort {
  publish(sessionId: string, event: SessionEvent): void;
}

// Record content-free counts, durations, states, and fixed failure categories
export interface VisualMomentTelemetryPort {
  windowReviewed(outcome: { sourceType: 'upload' | 'camera'; state: 'reviewed' | 'skipped'; attempts: number; momentCount: number; durationMs: number }): void;
  attemptFailed(failure: { sourceType: 'upload' | 'camera'; errorCategory: VisualFailureCategory; attempt: number }): void;
  momentReleased(sourceType: 'upload' | 'camera'): void;
  imageRequested(state: 'served' | 'not_found' | 'unavailable'): void;
}

// Keep telemetry optional for focused tests
const silentTelemetry: VisualMomentTelemetryPort = {
  windowReviewed: () => undefined,
  attemptFailed: () => undefined,
  momentReleased: () => undefined,
  imageRequested: () => undefined
};

// Describe where frames are decoded for a window: the full upload or the completed live clip
type FrameSource =
  | { kind: 'upload' }
  | { kind: 'camera'; clip: { path: string; mimeType: string } };

// Tag a failed pipeline step with a fixed category unless the error already carries one
class VisualStepError extends Error {
  constructor(readonly category: VisualFailureCategory) {
    super(`Visual step failed (${category})`);
    this.name = 'VisualStepError';
  }
}

// Read a known category from provider or step errors without retaining raw messages
function failureCategory(error: unknown, fallback: VisualFailureCategory): VisualFailureCategory {
  const category = typeof error === 'object' && error !== null && 'category' in error ? error.category : undefined;
  return visualFailureCategories.includes(category as VisualFailureCategory) ? category as VisualFailureCategory : fallback;
}

// Run one step and replace an uncategorized failure with the step's fixed category
async function step<T>(category: VisualFailureCategory, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new VisualStepError(failureCategory(error, category));
  }
}

// Analyze elapsed video windows and release original stills as the shared clock reaches them
export class VisualMomentService {
  // Keep at most one uploaded-source analysis run per room
  private readonly activeRuns = new Map<string, Promise<void>>();
  // Re-check the clock after a run when a playback update arrived during it
  private readonly rerunRequested = new Set<string>();
  // Serialize release passes per room so the release cursor advances in order
  private readonly releaseQueues = new Map<string, Promise<void>>();
  // Process completed live clips in capture order per room
  private readonly liveQueues = new Map<string, Promise<unknown>>();
  private readonly telemetry: VisualMomentTelemetryPort;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;

  constructor(private readonly dependencies: {
    repository: VisualMomentRepositoryPort;
    assets: VisualAssetPort;
    analyzer: VisualAnalyzerPort;
    events: VisualEventPort;
    telemetry?: VisualMomentTelemetryPort;
    sleep?: (milliseconds: number) => Promise<void>;
    maxAttempts?: number;
    retryDelayMs?: number;
    now?: () => number;
  }) {
    this.telemetry = dependencies.telemetry ?? silentTelemetry;
    this.sleep = dependencies.sleep ?? (async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxAttempts = dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelayMs = dependencies.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  // React to a committed shared-clock update from the playback owner
  // Releases reached stills first, then starts analysis only for intervals the audience has finished
  async handlePlaybackProgress(sessionId: string): Promise<void> {
    await this.releaseReachedMoments(sessionId);
    this.requestUploadedAnalysis(sessionId);
  }

  // Analyze one completed live-camera clip while attendee media continues on its own path
  submitLiveWindow(sessionId: string, index: number, mimeType: string, chunks: AsyncIterable<Uint8Array>): Promise<SessionRecordingView> {
    const previous = this.liveQueues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.applyLiveWindow(sessionId, index, mimeType, chunks));
    this.liveQueues.set(sessionId, current);
    return current.finally(() => {
      if (this.liveQueues.get(sessionId) === current) this.liveQueues.delete(sessionId);
    });
  }

  // Return released stills with their image routes and validated spoken/topic context for snapshots
  async listReleasedMoments(sessionId: string): Promise<VisualMomentView[]> {
    const source = await this.dependencies.repository.getSource(sessionId);
    if (!source || source.mediaKind !== 'video') return [];
    return await this.toViews(sessionId, [...source.releasedMoments].sort((left, right) => left.timestampMs - right.timestampMs));
  }

  // Return a still's private file only after its moment was released in this room
  async getReleasedImage(sessionId: string, momentId: string): Promise<{ path: string; size: number }> {
    const source = await this.dependencies.repository.getSource(sessionId);
    if (!source || source.mediaKind !== 'video' || !source.releasedMoments.some((moment) => moment.id === momentId)) {
      this.telemetry.imageRequested('not_found');
      throw new VisualMomentNotFoundError();
    }
    try {
      const image = await this.dependencies.assets.getImageFile(sessionId, momentId);
      this.telemetry.imageRequested('served');
      return image;
    } catch {
      this.telemetry.imageRequested('unavailable');
      throw new VisualImageUnavailableError();
    }
  }

  // Wait for in-flight analysis and release work during controlled shutdown
  async waitForIdle(): Promise<void> {
    while (this.activeRuns.size > 0 || this.releaseQueues.size > 0 || this.liveQueues.size > 0) {
      await Promise.allSettled([...this.activeRuns.values(), ...this.releaseQueues.values(), ...this.liveQueues.values()]);
    }
  }

  // Start the room's uploaded-source run unless one is already active
  private requestUploadedAnalysis(sessionId: string): void {
    if (this.activeRuns.has(sessionId)) {
      this.rerunRequested.add(sessionId);
      return;
    }
    const run = this.runUploadedWindows(sessionId)
      .catch(async () => {
        // Leave the cursor unchanged so a later playback update can retry this window
        await this.publishState(sessionId, 'failed').catch(() => undefined);
      })
      .finally(() => {
        this.activeRuns.delete(sessionId);
        if (this.rerunRequested.delete(sessionId)) this.requestUploadedAnalysis(sessionId);
      });
    this.activeRuns.set(sessionId, run);
  }

  // Review elapsed windows in index order, re-reading the clock before each one
  private async runUploadedWindows(sessionId: string): Promise<void> {
    for (;;) {
      const source = await this.dependencies.repository.getSource(sessionId);
      const window = source ? nextElapsedWindow(source) : null;
      if (!source || !window) return;
      const outcome = await this.reviewWindow(source, window, { kind: 'upload' });
      if (outcome === 'deferred') return;
      await this.releaseReachedMoments(sessionId);
    }
  }

  // Validate ordering for one live clip, review it, and release its still immediately
  private async applyLiveWindow(sessionId: string, index: number, mimeType: string, chunks: AsyncIterable<Uint8Array>): Promise<SessionRecordingView> {
    const source = await this.dependencies.repository.getSource(sessionId);
    if (!source || source.sourceType !== 'camera' || source.status !== 'ready' || source.mediaKind !== 'video') {
      throw new VisualSourceNotReadyError();
    }
    if (!Number.isSafeInteger(index) || index < 0 || index > source.analysisWindowCount) throw new LiveWindowOrderError();

    if (index === source.analysisWindowCount) {
      const clip = await this.dependencies.assets.saveLiveClip(sessionId, index, mimeType, chunks);
      try {
        const durationMs = await this.dependencies.assets.probeDurationMs(clip.path);
        await this.reviewWindow(source, { index, startMs: source.analysisThroughMs, durationMs }, { kind: 'camera', clip });
      } finally {
        await this.dependencies.assets.removeClip(sessionId, clip.path).catch(() => undefined);
      }
    }
    // Reuse committed work when the presenter client retries an earlier clip
    await this.releaseReachedMoments(sessionId);
    const latest = await this.dependencies.repository.getSource(sessionId);
    if (!latest) throw new VisualSourceNotReadyError();
    return toRecordingView(sessionId, latest);
  }

  // Review one window from cache or bounded attempts, then commit its cursor
  private async reviewWindow(source: VisualSourceRecord, window: AnalysisWindow, frameSource: FrameSource): Promise<'reviewed' | 'skipped' | 'deferred'> {
    const { sessionId } = source;
    const sourceKey = await this.sourceKeyFor(source);
    let stored = await this.dependencies.assets.readWindow(sessionId, window.index);
    if (stored && !matchesWindow(stored, sessionId, window, sourceKey)) stored = null;

    if (!stored || stored.status === 'pending') {
      const started = (this.dependencies.now ?? Date.now)();
      await this.publishState(sessionId, 'analyzing');
      stored = await this.attemptWindow(source, window, sourceKey, stored, frameSource);
      if (!stored) {
        // Return to waiting when the clock moved back before the interval could be processed
        await this.publishState(sessionId, 'waiting');
        return 'deferred';
      }
      this.telemetry.windowReviewed({
        sourceType: source.sourceType,
        state: stored.status === 'skipped' ? 'skipped' : 'reviewed',
        attempts: stored.attempts,
        momentCount: stored.candidate ? 1 : 0,
        durationMs: Math.max(0, (this.dependencies.now ?? Date.now)() - started)
      });
    }

    const committed = await this.dependencies.repository.completeWindow(sessionId, {
      index: window.index,
      startMs: window.startMs,
      throughMs: window.startMs + window.durationMs,
      skipped: stored.status === 'skipped'
    });
    this.publishRecording(sessionId, committed);
    return stored.status === 'skipped' ? 'skipped' : 'reviewed';
  }

  // Try clip extraction, provider review, validation, and frame storage a bounded number of times
  // Returns null without counting an attempt when the latest clock no longer permits the window
  private async attemptWindow(
    source: VisualSourceRecord,
    window: AnalysisWindow,
    sourceKey: string,
    previous: StoredVisualWindow | null,
    frameSource: FrameSource
  ): Promise<StoredVisualWindow | null> {
    const { sessionId } = source;
    const base = { sessionId, index: window.index, startMs: window.startMs, durationMs: window.durationMs, sourceKey };
    let attempts = previous?.attempts ?? 0;
    let lastErrorCategory = previous?.lastErrorCategory ?? null;

    while (attempts < this.maxAttempts) {
      if (frameSource.kind === 'upload') {
        // Re-check the shared clock before extracting any clip for this interval
        const latest = await this.dependencies.repository.getSource(sessionId);
        if (!latest || !isSameElapsedWindow(latest, window)) return null;
      }
      attempts += 1;
      let temporaryClipPath: string | undefined;
      try {
        const clip = frameSource.kind === 'upload'
          ? await step('clip_extraction_failed', () => this.dependencies.assets.createClip(sessionId, window))
          : frameSource.clip;
        if (frameSource.kind === 'upload') temporaryClipPath = clip.path;

        // Send only the isolated elapsed clip; the full source never leaves local storage
        const result = await step('provider_unavailable', () => this.dependencies.analyzer.analyzeWindow({
          clipPath: clip.path,
          mimeType: clip.mimeType,
          durationMs: window.durationMs
        }));
        const selected = selectWindowMoment(window, result.moments);
        if (selected) {
          // Decode uploads from the original source at source time and live clips at their clip offset
          const [mediaPath, offsetMs] = frameSource.kind === 'upload'
            ? [this.dependencies.assets.sourcePath(sessionId), selected.moment.timestampMs]
            : [frameSource.clip.path, selected.offsetMs];
          await step('frame_extraction_failed', () => this.dependencies.assets.extractFrame(sessionId, selected.moment.id, mediaPath, offsetMs));
        }
        const reviewed: StoredVisualWindow = { ...base, status: 'reviewed', attempts, lastErrorCategory: null, candidate: selected?.moment ?? null };
        await step('storage_failed', () => this.dependencies.assets.writeWindow(sessionId, reviewed));
        return reviewed;
      } catch (error) {
        lastErrorCategory = failureCategory(error, 'provider_unavailable');
        this.telemetry.attemptFailed({ sourceType: source.sourceType, errorCategory: lastErrorCategory, attempt: attempts });
        // Persist the attempt count so restarts cannot reset the retry bound
        await this.dependencies.assets.writeWindow(sessionId, { ...base, status: 'pending', attempts, lastErrorCategory, candidate: null }).catch(() => undefined);
        if (attempts < this.maxAttempts) await this.sleep(this.retryDelayMs * attempts);
      } finally {
        if (temporaryClipPath) await this.dependencies.assets.removeClip(sessionId, temporaryClipPath).catch(() => undefined);
      }
    }

    // Record the window as skipped so review can continue honestly past it
    const skipped: StoredVisualWindow = { ...base, status: 'skipped', attempts, lastErrorCategory, candidate: null };
    await this.dependencies.assets.writeWindow(sessionId, skipped);
    return skipped;
  }

  // Release committed candidates the shared clock has reached, in source-time order
  private releaseReachedMoments(sessionId: string): Promise<void> {
    const previous = this.releaseQueues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.releaseDue(sessionId));
    this.releaseQueues.set(sessionId, current);
    return current.finally(() => {
      if (this.releaseQueues.get(sessionId) === current) this.releaseQueues.delete(sessionId);
    });
  }

  // Advance the durable release cursor once per due moment and publish only after it commits
  // Backward seeks release nothing and never remove released history
  private async releaseDue(sessionId: string): Promise<void> {
    const source = await this.dependencies.repository.getSource(sessionId);
    if (!source || source.status !== 'ready' || source.mediaKind !== 'video') return;
    const sourceKey = await this.sourceKeyFor(source);
    const released = new Set(source.releasedMoments.map((moment) => moment.id));
    const due = (await this.dependencies.assets.listWindows(sessionId))
      .filter((window) => window.sessionId === sessionId
        && window.index < source.analysisWindowCount
        && window.status === 'reviewed'
        && window.sourceKey === sourceKey
        && window.candidate !== null
        && !released.has(window.candidate.id)
        // Completed live clips were already seen live; uploads wait for the playback position
        && (source.sourceType === 'camera' || window.candidate.timestampMs <= source.playbackPositionMs))
      .map((window) => window.candidate as PreparedVisualMoment)
      .sort((left, right) => left.timestampMs - right.timestampMs);

    let expectedReleasedCount = source.releasedVisualMomentCount;
    for (const moment of due) {
      const result = await this.dependencies.repository.releaseMoment(sessionId, moment, expectedReleasedCount);
      // Stop when another writer advanced the cursor; the next update reconciles
      if (!result) return;
      expectedReleasedCount += 1;
      this.telemetry.momentReleased(source.sourceType);
      const [view] = await this.toViews(sessionId, [result.moment]);
      if (view) this.dependencies.events.publish(sessionId, { type: 'visual_moment_released', revision: result.revision, moment: view });
    }
  }

  // Attach image routes and validated speech/topic links to released moments
  private async toViews(sessionId: string, moments: PreparedVisualMoment[]): Promise<VisualMomentView[]> {
    if (moments.length === 0) return [];
    const contexts = await this.dependencies.repository.findSpokenContexts(sessionId, moments.map((moment) => moment.timestampMs));
    return moments.map((moment) => {
      const context = contexts.get(moment.timestampMs);
      return {
        id: moment.id,
        timestampMs: moment.timestampMs,
        topicTitle: moment.topicTitle,
        description: moment.description,
        imageUrl: `/api/sessions/${encodeURIComponent(sessionId)}/visual-moments/${encodeURIComponent(moment.id)}/image`,
        captionId: context?.captionId ?? null,
        occurrenceId: context?.occurrenceId ?? null,
        threadId: context?.occurrenceId ? context.threadId : null
      };
    });
  }

  // Identify the analyzed source so cached results from a replaced upload are ignored
  private async sourceKeyFor(source: VisualSourceRecord): Promise<string> {
    return source.sourceType === 'camera' ? 'camera' : await this.dependencies.assets.sourceKey(source.sessionId);
  }

  // Publish a state change only when it differs from the persisted state
  private async publishState(sessionId: string, state: VisualAnalysisState): Promise<void> {
    const current = await this.dependencies.repository.getSource(sessionId);
    if (!current || current.analysisState === state) return;
    this.publishRecording(sessionId, await this.dependencies.repository.setAnalysisState(sessionId, state));
  }

  private publishRecording(sessionId: string, mutation: VisualSourceMutation): void {
    this.dependencies.events.publish(sessionId, {
      type: 'recording_updated',
      revision: mutation.revision,
      recording: toRecordingView(sessionId, mutation.source)
    });
  }
}

// Accept a cached window only for the same room, interval, and source
function matchesWindow(stored: StoredVisualWindow, sessionId: string, window: AnalysisWindow, sourceKey: string): boolean {
  return stored.sessionId === sessionId
    && stored.index === window.index
    && stored.startMs === window.startMs
    && stored.durationMs === window.durationMs
    && stored.sourceKey === sourceKey;
}
