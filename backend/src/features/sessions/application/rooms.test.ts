import { describe, expect, it, vi } from 'vitest';
import { RoomService } from './roomService';
import {
  createSessionSchema,
  roomCodeSchema
} from '../contracts/session.contract';

describe('room boundaries', () => {
  it('normalizes codes and rejects invalid titles and codes', () => {
    expect(roomCodeSchema.parse(' ab12cd34 ')).toBe('AB12CD34');
    for (const title of ['', '  ', 'a'.repeat(101)])
      expect(createSessionSchema.safeParse({ title }).success).toBe(false);
    for (const code of ['../room', 'ABCDEFGH', 'ABC', 'AB12CD345'])
      expect(roomCodeSchema.safeParse(code).success).toBe(false);
  });
  it('creates a fresh eight-character room with no supplied content', async () => {
    const createSession = vi.fn(async (input) => input);
    const service = new RoomService({
      repository: { createSession } as never,
      events: { publish: vi.fn(), subscribe: vi.fn() }
    });
    await service.createSession({ title: ' Synthetic fixture talk ' });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^[A-F0-9]{8}$/),
        title: 'Synthetic fixture talk'
      })
    );
  });
  it('does not publish until a caption transaction commits and uses a stable retry ID', async () => {
    let commit!: (value: unknown) => void;
    const releaseCaption = vi.fn(
      () =>
        new Promise((resolve) => {
          commit = resolve;
        })
    );
    const publish = vi.fn();
    const service = new RoomService({
      repository: { releaseCaption } as never,
      events: { publish, subscribe: vi.fn() }
    });
    const pending = service.releaseFinalCaption(
      'AB12CD34',
      'Synthetic final',
      1200,
      { captionId: 'stable-id', deferTopicAnalysis: true }
    );
    await vi.waitFor(() => expect(releaseCaption).toHaveBeenCalled());
    expect(publish).not.toHaveBeenCalled();
    const caption = {
      id: 'stable-id',
      sequence: 0,
      text: 'Synthetic final',
      timestampMs: 1200
    };
    commit({ caption, revision: 1 });
    await pending;
    expect(publish).toHaveBeenCalledWith('AB12CD34', {
      type: 'caption_released',
      revision: 1,
      caption
    });
  });
});
