import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalRecordingAssetStore } from './localRecordingAssets';

// Use synthetic bytes to verify storage limits without participant media
async function* bytes(...chunks: Uint8Array[]) {
  yield* chunks;
}
describe('private upload storage', () => {
  it('removes partial, empty and oversized uploads and allows a retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'st02-fixture-'));
    try {
      const store = new LocalRecordingAssetStore(directory, 8);
      await expect(store.saveUpload('AB12CD34', bytes())).rejects.toThrow();
      await expect(
        store.saveUpload('AB12CD34', bytes(Buffer.alloc(9)))
      ).rejects.toThrow();
      expect(await readdir(join(directory, 'AB12CD34'))).toEqual([]);
      await store.saveUpload('AB12CD34', bytes(Buffer.alloc(4)));
      expect((await store.getMediaFile('AB12CD34')).size).toBe(4);
      await expect(store.getMediaFile('../private')).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
