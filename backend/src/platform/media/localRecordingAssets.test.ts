import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import ffprobe from '@ffprobe-installer/ffprobe';
import {
  LocalRecordingAssetStore,
  readRecordingDuration
} from './localRecordingAssets';

// Use synthetic bytes to verify storage limits without participant media
async function* bytes(...chunks: Uint8Array[]) {
  yield* chunks;
}
describe('private upload storage', () => {
  it('keeps storage importable when the optional validator package is missing', async () => {
    vi.doMock('@ffprobe-installer/ffprobe', () => {
      throw Object.assign(new Error('SYNTHETIC_MISSING_BINARY_PACKAGE'), {
        code: 'MODULE_NOT_FOUND'
      });
    });
    vi.resetModules();
    try {
      const adapter = await import('./localRecordingAssets.js');
      expect(adapter.LocalRecordingAssetStore).toBeTypeOf('function');
      await expect(
        adapter.readRecordingDuration('synthetic.wav', 'audio')
      ).rejects.toMatchObject({
        name: 'Error',
        message: 'Recording validation is unavailable'
      });
    } finally {
      vi.doUnmock('@ffprobe-installer/ffprobe');
      vi.resetModules();
    }
  });
  it('reports an unavailable validator separately from an invalid recording', async () => {
    const originalPath = ffprobe.path;
    ffprobe.path = join(tmpdir(), 'st02-missing-validator', 'ffprobe');
    try {
      await expect(
        readRecordingDuration('synthetic.wav', 'audio')
      ).rejects.toMatchObject({
        name: 'Error',
        message: 'Recording validation is unavailable'
      });
    } finally {
      ffprobe.path = originalPath;
    }
  });
  it('validates source audio without requiring a system ffprobe on PATH', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'st02-probe-'));
    const path = join(directory, 'synthetic.wav');
    // Encode one second of synthetic mono PCM without another media tool
    const wav = Buffer.alloc(44 + 32000);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(32000, 40);
    await writeFile(path, wav);
    vi.stubEnv('PATH', directory);
    try {
      await expect(readRecordingDuration(path, 'audio')).resolves.toBe(1000);
      await expect(readRecordingDuration(path, 'video')).rejects.toThrow(
        RangeError
      );
      await writeFile(path, 'SYNTHETIC_PRIVATE_MEDIA');
      await expect(readRecordingDuration(path, 'audio')).rejects.toThrow(
        'The recording could not be validated. Choose a valid file with audio.'
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
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
