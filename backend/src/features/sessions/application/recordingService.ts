import {
  RecordingNotReadyError,
  RecordingUnsupportedTypeError,
  roomCodeSchema,
  type SessionRecordingView
} from '../contracts/session.contract';
import type { SessionEventPort } from './sessionEventHub';

// Restrict upload intake independently of future camera or platform sources
export const RECORDING_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/ogg',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/quicktime'
] as const;
// Bound selected thread intervals at both HTTP and application boundaries
export const THREAD_INTERVALS = [1, 3, 5, 10] as const;
// Describe a committed source-state mutation
export interface RecordingMutation {
  recording: SessionRecordingView;
  revision: number;
}
// Keep upload and playback persistence independent of file storage
export interface RecordingRepository {
  beginUpload(
    id: string,
    mimeType: string,
    mediaKind: 'audio' | 'video',
    minutes: number
  ): Promise<RecordingMutation>;
  finishUpload(
    id: string,
    durationMs: number | null
  ): Promise<RecordingMutation>;
  updatePlayback(
    id: string,
    positionMs: number,
    isPlaying: boolean
  ): Promise<RecordingMutation>;
  pauseDisconnected(
    before: Date
  ): Promise<Array<RecordingMutation & { sessionId: string }>>;
  getRecording(id: string): Promise<SessionRecordingView | null>;
}
// Describe the source asset boundary for subsequent intake implementations
export interface RecordingAssets {
  saveUpload(id: string, chunks: AsyncIterable<Uint8Array>): Promise<void>;
  remove(id: string): Promise<void>;
  getMediaFile(id: string): Promise<{ path: string; size: number }>;
}
// Validate uploaded sources and publish shared playback without waiting for analysis
export class RecordingService {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly dependencies: {
      repository: RecordingRepository;
      assets: RecordingAssets;
      events: SessionEventPort;
      readDuration(path: string, kind: 'audio' | 'video'): Promise<number>;
    }
  ) {}
  // Validate source bytes before making the recording playable
  async upload(
    id: string,
    inputType: string,
    chunks: AsyncIterable<Uint8Array>,
    minutes = 5
  ) {
    id = roomCodeSchema.parse(id);
    if (!(THREAD_INTERVALS as readonly number[]).includes(minutes))
      throw new RangeError('Invalid thread interval');
    const mimeType = inputType.split(';')[0]!.trim().toLowerCase();
    if (!(RECORDING_MIME_TYPES as readonly string[]).includes(mimeType))
      throw new RecordingUnsupportedTypeError();
    const kind = mimeType.startsWith('video/') ? 'video' : 'audio';
    this.publish(
      id,
      await this.dependencies.repository.beginUpload(
        id,
        mimeType,
        kind,
        minutes
      )
    );
    try {
      await this.dependencies.assets.saveUpload(id, chunks);
      const { path } = await this.dependencies.assets.getMediaFile(id);
      const duration = await this.dependencies.readDuration(path, kind);
      if (
        !Number.isSafeInteger(duration) ||
        duration <= 0 ||
        duration > 86_400_000
      )
        throw new RangeError('Invalid recording duration');
      return this.publish(
        id,
        await this.dependencies.repository.finishUpload(id, duration)
      );
    } catch (error) {
      await this.dependencies.assets.remove(id);
      this.publish(
        id,
        await this.dependencies.repository.finishUpload(id, null)
      );
      throw error;
    }
  }
  // Serialize source mutations so delayed writes cannot reorder playback
  updatePlayback(
    id: string,
    positionMs: number,
    isPlaying: boolean
  ): Promise<SessionRecordingView> {
    id = roomCodeSchema.parse(id);
    if (!Number.isSafeInteger(positionMs) || positionMs < 0)
      throw new RangeError('Invalid source position');
    const previous = this.queues.get(id) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(async () =>
        this.publish(
          id,
          await this.dependencies.repository.updatePlayback(
            id,
            positionMs,
            isPlaying
          )
        )
      );
    this.queues.set(id, pending);
    return pending.finally(() => {
      if (this.queues.get(id) === pending) this.queues.delete(id);
    });
  }
  // Serve only validated upload sources through the public media boundary
  async getMediaFile(id: string) {
    id = roomCodeSchema.parse(id);
    const recording = await this.dependencies.repository.getRecording(id);
    if (recording?.status !== 'ready') throw new RecordingNotReadyError();
    return {
      ...(await this.dependencies.assets.getMediaFile(id)),
      mimeType: recording.mimeType
    };
  }
  // Pause sources whose presenter has stopped reporting playback progress
  async pauseDisconnected() {
    const paused = await this.dependencies.repository.pauseDisconnected(
      new Date(Date.now() - 15_000)
    );
    for (const mutation of paused) this.publish(mutation.sessionId, mutation);
  }
  private publish(id: string, mutation: RecordingMutation) {
    this.dependencies.events.publish(id, {
      type: 'recording_updated',
      ...mutation
    });
    return mutation.recording;
  }
}
