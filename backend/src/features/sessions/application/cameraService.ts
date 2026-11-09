import { RecordingNotReadyError, roomCodeSchema } from '../contracts/session.contract';
import type { RecordingMutation, RecordingRepository } from './recordingService';
import { THREAD_INTERVALS } from './recordingService';
import type { SessionEventPort } from './sessionEventHub';

// Start and stop camera capture while keeping media and analysis on separate paths
export class CameraService {
  constructor(private readonly repository: Pick<RecordingRepository, 'getRecording' | 'updatePlayback'> & {
    beginLiveCapture(id: string, minutes: number): Promise<RecordingMutation>;
  }, private readonly events: SessionEventPort) {}

  // Reserve one fresh camera room after the browser obtains capture permission
  async startLiveCapture(id: string, minutes: number) {
    id = roomCodeSchema.parse(id);
    if (!(THREAD_INTERVALS as readonly number[]).includes(minutes)) throw new RangeError('Invalid thread interval');
    const mutation = await this.repository.beginLiveCapture(id, minutes);
    this.events.publish(id, { type: 'recording_updated', ...mutation });
    return mutation.recording;
  }

  // Freeze the live clock after pending speech has been flushed by the presenter
  async stopLiveCapture(id: string) {
    id = roomCodeSchema.parse(id);
    const current = await this.repository.getRecording(id);
    if (current?.sourceType !== 'camera') throw new RecordingNotReadyError();
    if (!current.isPlaying) return current;
    const positionMs = Math.min(86_400_000, current.playbackPositionMs + Math.max(0, Date.now() - Date.parse(current.playbackUpdatedAt)));
    const mutation = await this.repository.updatePlayback(id, positionMs, false);
    this.events.publish(id, { type: 'recording_updated', ...mutation });
    return mutation.recording;
  }
}
