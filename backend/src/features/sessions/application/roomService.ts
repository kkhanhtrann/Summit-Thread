import { randomBytes } from 'node:crypto';
import {
  createSessionSchema,
  roomCodeSchema,
  type CaptionView,
  type CreateSessionRequest,
  type SessionSnapshot
} from '../contracts/session.contract';
import type { SessionEventPort } from './sessionEventHub';

// Define the durable room operations needed by playback and transcription
export interface RoomRepository {
  createSession(input: { id: string; title: string }): Promise<SessionSnapshot>;
  getSnapshot(id: string): Promise<SessionSnapshot>;
  pauseActiveSessions(): Promise<void>;
  releaseCaption(
    id: string,
    captionId: string,
    text: string,
    timestampMs: number
  ): Promise<{ caption: CaptionView; revision: number } | null>;
}

// Create empty rooms and publish only committed final speech
export class RoomService {
  constructor(
    private readonly dependencies: {
      repository: RoomRepository;
      events: SessionEventPort;
    }
  ) {}
  // Generate a shareable room code without preloading participant content
  createSession(input: CreateSessionRequest) {
    const { title } = createSessionSchema.parse(input);
    return this.dependencies.repository.createSession({
      id: randomBytes(4).toString('hex').toUpperCase(),
      title
    });
  }
  // Normalize room lookups at the application boundary
  getSnapshot(id: string) {
    return this.dependencies.repository.getSnapshot(roomCodeSchema.parse(id));
  }
  // Pause unfinished activity before accepting traffic after restart
  initialize() {
    return this.dependencies.repository.pauseActiveSessions();
  }
  // Scope event subscribers to the selected room
  subscribe(
    id: string,
    listener: Parameters<SessionEventPort['subscribe']>[1]
  ) {
    return this.dependencies.events.subscribe(
      roomCodeSchema.parse(id),
      listener
    );
  }
  // Reuse the caption ID across persistence retries and publish after commit
  async releaseFinalCaption(
    id: string,
    text: string,
    timestampMs: number,
    options: { captionId: string; deferTopicAnalysis: true }
  ) {
    const released = await this.dependencies.repository.releaseCaption(
      id,
      options.captionId,
      text,
      timestampMs
    );
    if (released)
      this.dependencies.events.publish(id, {
        type: 'caption_released',
        ...released
      });
    return released?.caption ?? null;
  }
}
