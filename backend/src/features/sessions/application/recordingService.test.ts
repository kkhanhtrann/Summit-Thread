import { describe, expect, it, vi } from 'vitest';
import { RecordingService } from './recordingService';

// Use labeled synthetic sources and injectable storage to check upload failure boundaries
function fixture() {
  const mutation = { recording: { status: 'preparing' }, revision: 1 };
  const repository = {
    beginUpload: vi.fn().mockResolvedValue(mutation),
    finishUpload: vi.fn().mockResolvedValue({ ...mutation, revision: 2 }),
    updatePlayback: vi.fn(),
    getRecording: vi.fn(),
    pauseDisconnected: vi.fn()
  };
  const assets = {
    saveUpload: vi.fn().mockResolvedValue(undefined),
    getMediaFile: vi
      .fn()
      .mockResolvedValue({ path: '/synthetic/source', size: 4 }),
    remove: vi.fn().mockResolvedValue(undefined)
  };
  const readDuration = vi.fn().mockResolvedValue(4000);
  const events = { publish: vi.fn(), subscribe: vi.fn() };
  return {
    repository,
    assets,
    readDuration,
    events,
    service: new RecordingService({ repository, assets, readDuration, events })
  };
}
async function* source() {
  yield Buffer.from('synthetic');
}
describe('recording preparation', () => {
  it('becomes playable after validation without invoking any analysis provider', async () => {
    const f = fixture();
    await f.service.upload(' ab12cd34 ', 'video/mp4;codecs=avc1', source());
    expect(f.repository.beginUpload).toHaveBeenCalledWith(
      'AB12CD34',
      'video/mp4',
      'video',
      5
    );
    expect(f.repository.finishUpload).toHaveBeenCalledWith('AB12CD34', 4000);
    expect(f.assets.remove).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity, 86_400_001])(
    'removes source bytes when duration %s is invalid',
    async (duration) => {
      const f = fixture();
      f.readDuration.mockResolvedValue(duration);
      await expect(
        f.service.upload('AB12CD34', 'audio/wav', source())
      ).rejects.toThrow();
      expect(f.assets.remove).toHaveBeenCalledWith('AB12CD34');
      expect(f.repository.finishUpload).toHaveBeenCalledWith('AB12CD34', null);
    }
  );
  it('cleans failed validation without returning storage or tool diagnostics', async () => {
    const f = fixture();
    f.readDuration.mockRejectedValue(new Error('/private/SYNTHETIC_PRIVATE'));
    await expect(
      f.service.upload('AB12CD34', 'video/mp4', source())
    ).rejects.toThrow();
    expect(f.assets.remove).toHaveBeenCalled();
    expect(f.events.publish.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ type: 'recording_updated' })
    );
  });
  it('rejects unknown formats and intervals before reserving or writing source bytes', async () => {
    const f = fixture();
    await expect(
      f.service.upload('AB12CD34', 'text/html', source())
    ).rejects.toThrow();
    await expect(
      f.service.upload('AB12CD34', 'audio/wav', source(), 2)
    ).rejects.toThrow();
    expect(f.repository.beginUpload).not.toHaveBeenCalled();
    expect(f.assets.saveUpload).not.toHaveBeenCalled();
  });
});
