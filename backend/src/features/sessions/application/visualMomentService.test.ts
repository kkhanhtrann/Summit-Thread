import { describe, expect, it } from 'vitest';

import type { PreparedVisualMoment, SessionEvent } from '../contracts/session.contract';
import { LiveWindowOrderError, VisualImageUnavailableError, VisualMomentNotFoundError } from '../contracts/visualMoment.contract';
import {
  VisualMomentService,
  type SpokenContext,
  type StoredVisualWindow,
  type VisualAnalysisState,
  type VisualAssetPort,
  type VisualMomentRepositoryPort,
  type VisualMomentTelemetryPort,
  type VisualSourceMutation,
  type VisualSourceRecord
} from './visualMomentService';
import type { AnalysisWindow, WindowRelativeMoment } from './visualWindows';

const ROOM = 'ROOMAAAA';
const OTHER_ROOM = 'ROOMBBBB';

// Keep durable cursor semantics in memory, including compare-and-set release and window commits
class MemoryRepository implements VisualMomentRepositoryPort {
  revision = 0;
  readonly sources = new Map<string, VisualSourceRecord>();
  readonly contexts = new Map<number, SpokenContext>();
  failNextComplete = false;
  onSetState?: (state: VisualAnalysisState) => void;

  add(sessionId: string, overrides: Partial<VisualSourceRecord> = {}): void {
    this.sources.set(sessionId, {
      sessionId,
      sourceType: 'upload',
      status: 'ready',
      preparationStage: null,
      mediaKind: 'video',
      mimeType: 'video/mp4',
      durationMs: 90_000,
      playbackPositionMs: 0,
      isPlaying: false,
      analysisWindowMinutes: 1,
      analysisWindowCount: 0,
      analysisThroughMs: 0,
      analysisState: 'waiting',
      visualReviewSkippedWindowCount: 0,
      releasedVisualMomentCount: 0,
      releasedMoments: [],
      ...overrides
    });
  }

  // Simulate the playback owner committing a shared-clock update
  setPlayback(sessionId: string, positionMs: number, isPlaying: boolean): void {
    const source = this.require(sessionId);
    this.sources.set(sessionId, { ...source, playbackPositionMs: positionMs, isPlaying });
  }

  async getSource(sessionId: string): Promise<VisualSourceRecord | null> {
    const source = this.sources.get(sessionId);
    return source ? structuredClone(source) : null;
  }

  async setAnalysisState(sessionId: string, state: VisualAnalysisState): Promise<VisualSourceMutation> {
    this.sources.set(sessionId, { ...this.require(sessionId), analysisState: state });
    this.onSetState?.(state);
    return this.mutation(sessionId);
  }

  async completeWindow(sessionId: string, window: { index: number; startMs: number; throughMs: number; skipped: boolean }): Promise<VisualSourceMutation> {
    if (this.failNextComplete) {
      this.failNextComplete = false;
      throw new Error('synthetic database outage');
    }
    const source = this.require(sessionId);
    if (source.analysisWindowCount > window.index) return { source: structuredClone(source), revision: this.revision };
    if (source.analysisWindowCount !== window.index || source.analysisThroughMs !== window.startMs) throw new Error('order');
    const reachedEnd = source.sourceType === 'camera' ? !source.isPlaying : window.throughMs >= (source.durationMs ?? 0);
    this.sources.set(sessionId, {
      ...source,
      analysisWindowCount: window.index + 1,
      analysisThroughMs: window.throughMs,
      analysisState: reachedEnd ? 'complete' : 'ready',
      visualReviewSkippedWindowCount: source.visualReviewSkippedWindowCount === null ? null : source.visualReviewSkippedWindowCount + Number(window.skipped)
    });
    return this.mutation(sessionId);
  }

  async releaseMoment(sessionId: string, moment: PreparedVisualMoment, expected: number): Promise<{ moment: PreparedVisualMoment; revision: number } | null> {
    const source = this.require(sessionId);
    if (source.releasedVisualMomentCount !== expected || source.releasedMoments.some((existing) => existing.id === moment.id)) return null;
    this.sources.set(sessionId, { ...source, releasedVisualMomentCount: expected + 1, releasedMoments: [...source.releasedMoments, moment] });
    this.revision += 1;
    return { moment, revision: this.revision };
  }

  async findSpokenContexts(_sessionId: string, timestamps: readonly number[]): Promise<Map<number, SpokenContext>> {
    return new Map(timestamps.flatMap((timestamp) => {
      const context = this.contexts.get(timestamp);
      return context ? [[timestamp, context] as const] : [];
    }));
  }

  private mutation(sessionId: string): VisualSourceMutation {
    this.revision += 1;
    return { source: structuredClone(this.require(sessionId)), revision: this.revision };
  }

  private require(sessionId: string): VisualSourceRecord {
    const source = this.sources.get(sessionId);
    if (!source) throw new Error('missing source');
    return source;
  }
}

// Record clip, frame, and cache operations without touching FFmpeg or disk
class MemoryAssets implements VisualAssetPort {
  readonly windows = new Map<string, StoredVisualWindow>();
  readonly clips: Array<{ sessionId: string; window: AnalysisWindow }> = [];
  readonly removedClips: string[] = [];
  readonly frames: Array<{ sessionId: string; momentId: string; mediaPath: string; offsetMs: number }> = [];
  readonly liveClips: string[] = [];
  key = 'upload:1000:1';
  clipFailures = 0;
  frameFailures = 0;

  async sourceKey(): Promise<string> { return this.key; }
  sourcePath(sessionId: string): string { return `/rooms/${sessionId}/source.media`; }

  async createClip(sessionId: string, window: AnalysisWindow): Promise<{ path: string; mimeType: string }> {
    if (this.clipFailures > 0) {
      this.clipFailures -= 1;
      throw new Error('synthetic ffmpeg failure');
    }
    this.clips.push({ sessionId, window });
    return { path: `/rooms/${sessionId}/visual/clips/window-${window.index}.mp4`, mimeType: 'video/mp4' };
  }

  async saveLiveClip(sessionId: string, index: number, _mimeType: string, chunks: AsyncIterable<Uint8Array>): Promise<{ path: string; mimeType: string }> {
    for await (const _chunk of chunks) { /* drain */ }
    const path = `/rooms/${sessionId}/visual/clips/live-${index}.webm`;
    this.liveClips.push(path);
    return { path, mimeType: 'video/webm' };
  }

  async probeDurationMs(): Promise<number> { return 60_000; }
  async removeClip(_sessionId: string, path: string): Promise<void> { this.removedClips.push(path); }
  async readWindow(sessionId: string, index: number): Promise<StoredVisualWindow | null> {
    const window = this.windows.get(`${sessionId}:${index}`);
    return window ? structuredClone(window) : null;
  }
  async listWindows(sessionId: string): Promise<StoredVisualWindow[]> {
    return [...this.windows.values()].filter((window) => window.sessionId === sessionId).map((window) => structuredClone(window));
  }
  async writeWindow(sessionId: string, window: StoredVisualWindow): Promise<void> {
    this.windows.set(`${sessionId}:${window.index}`, structuredClone(window));
  }
  async extractFrame(sessionId: string, momentId: string, mediaPath: string, offsetMs: number): Promise<void> {
    if (this.frameFailures > 0) {
      this.frameFailures -= 1;
      throw new Error('synthetic frame failure');
    }
    this.frames.push({ sessionId, momentId, mediaPath, offsetMs });
  }
  async getImageFile(sessionId: string, momentId: string): Promise<{ path: string; size: number }> {
    if (!this.frames.some((frame) => frame.sessionId === sessionId && frame.momentId === momentId)) throw new Error('missing');
    return { path: `/rooms/${sessionId}/visual/stills/${momentId}.jpg`, size: 10 };
  }
}

// Deterministic analyzer fixture: synthetic test data keyed by clip duration, never live content
class FixtureAnalyzer {
  readonly calls: Array<{ clipPath: string; durationMs: number }> = [];
  active = 0;
  maxActive = 0;
  respond: (input: { clipPath: string; durationMs: number }) => Promise<{ moments: WindowRelativeMoment[] }> = async () => ({ moments: [] });

  async analyzeWindow(input: { clipPath: string; mimeType: string; durationMs: number }): Promise<{ moments: WindowRelativeMoment[] }> {
    this.calls.push({ clipPath: input.clipPath, durationMs: input.durationMs });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.respond(input);
    } finally {
      this.active -= 1;
    }
  }
}

// Capture telemetry calls to prove they carry no conference content
class RecordingTelemetry implements VisualMomentTelemetryPort {
  readonly records: unknown[] = [];
  windowReviewed(outcome: unknown) { this.records.push(outcome); }
  attemptFailed(failure: unknown) { this.records.push(failure); }
  momentReleased(sourceType: unknown) { this.records.push(sourceType); }
  imageRequested(state: unknown) { this.records.push(state); }
}

// Build a service with in-memory ports and instant retry delays
function setup(overrides: Partial<VisualSourceRecord> = {}) {
  const repository = new MemoryRepository();
  repository.add(ROOM, overrides);
  const assets = new MemoryAssets();
  const analyzer = new FixtureAnalyzer();
  const events: Array<{ sessionId: string; event: SessionEvent }> = [];
  const telemetry = new RecordingTelemetry();
  const service = new VisualMomentService({
    repository,
    assets,
    analyzer,
    telemetry,
    events: { publish: (sessionId, event) => events.push({ sessionId, event }) },
    sleep: async () => undefined,
    maxAttempts: 3
  });
  // Commit one playback update and wait for any work it triggered
  const tick = async (positionMs: number, isPlaying = true, sessionId = ROOM) => {
    repository.setPlayback(sessionId, positionMs, isPlaying);
    await service.handlePlaybackProgress(sessionId);
    await service.waitForIdle();
  };
  const released = () => events.flatMap(({ event }) => event.type === 'visual_moment_released' ? [event.moment] : []);
  return { repository, assets, analyzer, events, telemetry, service, tick, released };
}

// Synthetic suggestion used by the fixture analyzer
const slide = (offsetMs: number): { moments: WindowRelativeMoment[] } => ({
  moments: [{ offsetMs, title: 'Synthetic slide', description: 'SYNTHETIC_DESCRIPTION_MARKER chart on screen.' }]
});

describe('VisualMomentService elapsed-window gating', () => {
  it('extracts no clip and calls no provider before the interval ends', async () => {
    const { tick, assets, analyzer } = setup();
    await tick(30_000);
    await tick(59_999);
    expect(assets.clips).toEqual([]);
    expect(analyzer.calls).toEqual([]);
  });

  it('permits exactly the completed interval at its end and never looks ahead on repeated ticks', async () => {
    const { tick, assets, analyzer, repository } = setup();
    await tick(60_000);
    await tick(60_000);
    await tick(61_000);
    expect(assets.clips.map(({ window }) => window)).toEqual([{ index: 0, startMs: 0, durationMs: 60_000 }]);
    expect(analyzer.calls).toHaveLength(1);
    expect(repository.sources.get(ROOM)?.analysisThroughMs).toBe(60_000);
  });

  it('analyzes the final shorter interval only at the source end on the ended update', async () => {
    const { tick, assets } = setup();
    await tick(60_000);
    await tick(89_999, false);
    expect(assets.clips).toHaveLength(1);
    await tick(90_000, false);
    expect(assets.clips.map(({ window }) => window)).toEqual([
      { index: 0, startMs: 0, durationMs: 60_000 },
      { index: 1, startMs: 60_000, durationMs: 30_000 }
    ]);
  });

  it('catches up in order but stays bounded by the latest playback cursor', async () => {
    const { tick, assets, analyzer, repository } = setup({ durationMs: 300_000 });
    await tick(185_000);
    expect(assets.clips.map(({ window }) => window.index)).toEqual([0, 1, 2]);
    expect(analyzer.maxActive).toBe(1);
    expect(repository.sources.get(ROOM)?.analysisThroughMs).toBe(180_000);
  });

  it('keeps one active analysis per room when ticks arrive during a review', async () => {
    const { repository, service, analyzer, assets } = setup({ durationMs: 300_000 });
    let release: () => void = () => undefined;
    analyzer.respond = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { moments: [] };
    };
    repository.setPlayback(ROOM, 60_000, true);
    await service.handlePlaybackProgress(ROOM);
    await new Promise((resolve) => setTimeout(resolve, 0));
    repository.setPlayback(ROOM, 120_000, true);
    await service.handlePlaybackProgress(ROOM);
    await service.handlePlaybackProgress(ROOM);
    expect(analyzer.calls).toHaveLength(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await service.waitForIdle();
    expect(analyzer.maxActive).toBe(1);
    expect(assets.clips.map(({ window }) => window.index)).toEqual([0, 1]);
  });

  it('defers without extracting a clip when the source clock moves back before extraction', async () => {
    const { tick, repository, assets, analyzer } = setup();
    repository.onSetState = (state) => {
      if (state === 'analyzing') repository.setPlayback(ROOM, 20_000, true);
    };
    await tick(60_000);
    expect(assets.clips).toEqual([]);
    expect(analyzer.calls).toEqual([]);
    expect(repository.sources.get(ROOM)).toMatchObject({ analysisWindowCount: 0, analysisState: 'waiting' });
  });

  it('skips video analysis entirely for audio-only uploads', async () => {
    const { tick, assets, analyzer, events } = setup({ mediaKind: 'audio', mimeType: 'audio/mpeg' });
    await tick(90_000, false);
    expect(assets.clips).toEqual([]);
    expect(analyzer.calls).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('VisualMomentService evidence and release', () => {
  it('aligns window offsets to source time and extracts the original source frame', async () => {
    const { tick, analyzer, assets, released } = setup({ durationMs: 600_000, analysisWindowMinutes: 5 });
    analyzer.respond = async ({ clipPath }) => clipPath.endsWith('window-1.mp4') ? slide(190_000) : { moments: [] };
    await tick(300_000);
    await tick(600_000, false);
    expect(assets.frames).toEqual([{ sessionId: ROOM, momentId: 'moment-0001', mediaPath: `/rooms/${ROOM}/source.media`, offsetMs: 490_000 }]);
    expect(released().map((moment) => [moment.id, moment.timestampMs])).toEqual([['moment-0001', 490_000]]);
    // Provider input is only ever the extracted clip, never the full source
    expect(analyzer.calls.every((call) => call.clipPath.includes('/visual/clips/'))).toBe(true);
  });

  it('records a zero-moment window as reviewed rather than skipped', async () => {
    const { tick, repository, released } = setup();
    await tick(60_000);
    expect(released()).toEqual([]);
    expect(repository.sources.get(ROOM)?.visualReviewSkippedWindowCount).toBe(0);
  });

  it('gates release on the shared clock and never duplicates or erases released history on seeks', async () => {
    const { repository, service, analyzer, released } = setup({ durationMs: 180_000 });
    analyzer.respond = async ({ clipPath }) => {
      if (!clipPath.endsWith('window-1.mp4')) return { moments: [] };
      // Presenter seeks back while the elapsed window is under review
      repository.setPlayback(ROOM, 65_000, true);
      return slide(10_000);
    };
    repository.setPlayback(ROOM, 120_000, true);
    await service.handlePlaybackProgress(ROOM);
    await service.waitForIdle();
    expect(released()).toEqual([]);
    expect(repository.sources.get(ROOM)?.releasedMoments).toEqual([]);

    repository.setPlayback(ROOM, 70_000, true);
    await service.handlePlaybackProgress(ROOM);
    await service.waitForIdle();
    repository.setPlayback(ROOM, 10_000, true);
    await service.handlePlaybackProgress(ROOM);
    repository.setPlayback(ROOM, 75_000, true);
    await service.handlePlaybackProgress(ROOM);
    await service.waitForIdle();
    expect(released().map((moment) => moment.id)).toEqual(['moment-0001']);
    expect(repository.sources.get(ROOM)?.releasedMoments.map((moment) => moment.id)).toEqual(['moment-0001']);
  });

  it('attaches spoken and topic context only from validated caption relationships', async () => {
    const { tick, analyzer, repository, service } = setup();
    analyzer.respond = async () => slide(5_000);
    repository.contexts.set(5_000, { captionId: 'caption-1', occurrenceId: null, threadId: 'thread-ignored' });
    await tick(60_000);
    const [view] = await service.listReleasedMoments(ROOM);
    expect(view).toMatchObject({
      captionId: 'caption-1',
      occurrenceId: null,
      threadId: null,
      imageUrl: `/api/sessions/${ROOM}/visual-moments/moment-0000/image`
    });
  });

  it('retries a provider rejection and keeps a single moment once it succeeds', async () => {
    const { tick, analyzer, repository, assets, released } = setup();
    let calls = 0;
    analyzer.respond = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('provider said private content'), { category: 'provider_rejected' });
      return slide(1_000);
    };
    await tick(60_000);
    expect(released()).toHaveLength(1);
    expect(repository.sources.get(ROOM)?.visualReviewSkippedWindowCount).toBe(0);
    expect(assets.windows.get(`${ROOM}:0`)).toMatchObject({ status: 'reviewed', attempts: 2 });
    expect(assets.removedClips).toHaveLength(2);
  });

  it('bounds retries and records an honest skip after repeated invalid timestamps', async () => {
    const { tick, analyzer, repository, assets, released, telemetry } = setup();
    analyzer.respond = async () => slide(60_000);
    await tick(60_000);
    expect(analyzer.calls).toHaveLength(3);
    expect(released()).toEqual([]);
    expect(repository.sources.get(ROOM)).toMatchObject({ analysisWindowCount: 1, visualReviewSkippedWindowCount: 1 });
    expect(assets.windows.get(`${ROOM}:0`)).toMatchObject({ status: 'skipped', lastErrorCategory: 'invalid_output' });
    expect(JSON.stringify(telemetry.records)).not.toContain('SYNTHETIC_DESCRIPTION_MARKER');
  });

  it('skips a window whose frames cannot be extracted and serves no image for it', async () => {
    const { tick, analyzer, assets, released, repository } = setup();
    analyzer.respond = async () => slide(1_000);
    assets.frameFailures = 3;
    await tick(60_000);
    expect(released()).toEqual([]);
    expect(repository.sources.get(ROOM)?.visualReviewSkippedWindowCount).toBe(1);
    expect(assets.windows.get(`${ROOM}:0`)?.lastErrorCategory).toBe('frame_extraction_failed');
  });

  it('retries clip extraction failures within the same bound', async () => {
    const { tick, assets, analyzer } = setup();
    assets.clipFailures = 1;
    await tick(60_000);
    expect(analyzer.calls).toHaveLength(1);
    expect(assets.windows.get(`${ROOM}:0`)).toMatchObject({ status: 'reviewed', attempts: 2 });
  });

  it('reuses cached review after a commit failure without another provider call or duplicate', async () => {
    const { tick, analyzer, repository, events, released } = setup();
    analyzer.respond = async () => slide(2_000);
    repository.failNextComplete = true;
    await tick(60_000);
    expect(repository.sources.get(ROOM)).toMatchObject({ analysisWindowCount: 0, analysisState: 'failed' });
    expect(events.some(({ event }) => event.type === 'recording_updated' && event.recording.analysisState === 'failed')).toBe(true);
    await tick(60_500);
    expect(analyzer.calls).toHaveLength(1);
    expect(released().map((moment) => moment.id)).toEqual(['moment-0000']);
  });

  it('ignores cached work from a replaced source', async () => {
    const { tick, analyzer, assets } = setup();
    await assets.writeWindow(ROOM, {
      sessionId: ROOM, index: 0, startMs: 0, durationMs: 60_000, sourceKey: 'upload:old:1',
      status: 'reviewed', attempts: 1, lastErrorCategory: null,
      candidate: { id: 'moment-0000', timestampMs: 1_000, topicTitle: 'Stale', description: 'Stale.' }
    });
    await tick(60_000);
    expect(analyzer.calls).toHaveLength(1);
  });
});

describe('VisualMomentService image access', () => {
  it('serves only released stills in the owning room', async () => {
    const { tick, analyzer, service, repository } = setup();
    repository.add(OTHER_ROOM);
    analyzer.respond = async () => slide(1_000);
    await tick(60_000);
    await expect(service.getReleasedImage(ROOM, 'moment-0000')).resolves.toMatchObject({ size: 10 });
    await expect(service.getReleasedImage(OTHER_ROOM, 'moment-0000')).rejects.toBeInstanceOf(VisualMomentNotFoundError);
    await expect(service.getReleasedImage(ROOM, 'moment-0001')).rejects.toBeInstanceOf(VisualMomentNotFoundError);
  });

  it('keeps cached but unreleased candidates unavailable', async () => {
    const { service, assets } = setup();
    await assets.writeWindow(ROOM, {
      sessionId: ROOM, index: 0, startMs: 0, durationMs: 60_000, sourceKey: assets.key,
      status: 'reviewed', attempts: 1, lastErrorCategory: null,
      candidate: { id: 'moment-0000', timestampMs: 1_000, topicTitle: 'Pending', description: 'Pending.' }
    });
    await expect(service.getReleasedImage(ROOM, 'moment-0000')).rejects.toBeInstanceOf(VisualMomentNotFoundError);
    await expect(service.listReleasedMoments(ROOM)).resolves.toEqual([]);
  });

  it('reports a released still with a missing file as unavailable', async () => {
    const { service, repository } = setup({
      releasedVisualMomentCount: 1,
      releasedMoments: [{ id: 'moment-0000', timestampMs: 1_000, topicTitle: 'Slide', description: 'A chart.' }]
    });
    expect(repository.sources.get(ROOM)?.releasedMoments).toHaveLength(1);
    await expect(service.getReleasedImage(ROOM, 'moment-0000')).rejects.toBeInstanceOf(VisualImageUnavailableError);
  });
});

describe('VisualMomentService live camera clips', () => {
  // Yield one synthetic chunk standing in for a completed captured clip
  async function* clip() { yield new Uint8Array([1, 2, 3]); }

  it('analyzes completed clips in order, decodes frames from the clip, and never duplicates retries', async () => {
    const { service, analyzer, assets, released } = setup({ sourceType: 'camera', durationMs: null, isPlaying: true, mimeType: 'video/webm' });
    analyzer.respond = async () => slide(15_000);
    await expect(service.submitLiveWindow(ROOM, 1, 'video/webm', clip())).rejects.toBeInstanceOf(LiveWindowOrderError);
    const view = await service.submitLiveWindow(ROOM, 0, 'video/webm', clip());
    expect(view).toMatchObject({ analysisThroughMs: 60_000, analysisState: 'ready' });
    await service.submitLiveWindow(ROOM, 0, 'video/webm', clip());
    await service.submitLiveWindow(ROOM, 1, 'video/webm', clip());
    expect(analyzer.calls).toHaveLength(2);
    expect(assets.frames[0]).toEqual({ sessionId: ROOM, momentId: 'moment-0000', mediaPath: `/rooms/${ROOM}/visual/clips/live-0.webm`, offsetMs: 15_000 });
    expect(released().map((moment) => [moment.id, moment.timestampMs])).toEqual([['moment-0000', 15_000], ['moment-0001', 75_000]]);
    expect(assets.removedClips).toEqual(assets.liveClips);
  });
});
