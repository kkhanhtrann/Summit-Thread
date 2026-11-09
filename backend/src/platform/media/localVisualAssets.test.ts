import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { VisualClipTooLargeError } from '../../features/sessions/contracts/visualMoment.contract';
import { LocalVisualAssetStore, MAX_LIVE_CLIP_BYTES, type MediaToolRunner } from './localVisualAssets';

const ROOM = 'ROOMAAAA';
const directories: string[] = [];

// Create an isolated storage root for one test
async function storageRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'summit-visual-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// Record media-tool calls and write placeholder output in place of FFmpeg
function recordingRunner(options: { fail?: boolean } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: MediaToolRunner = async (command, args) => {
    calls.push({ command, args });
    const output = args.at(-1)!;
    if (command === 'ffmpeg') {
      await writeFile(output, options.fail ? '' : 'synthetic-output');
      if (options.fail) throw new Error('synthetic ffmpeg failure');
    }
    return { stdout: '61.25\n' };
  };
  return { calls, runner };
}

// Find whether FFmpeg is installed for the real frame-provenance check
function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('LocalVisualAssetStore', () => {
  it('extracts only the requested elapsed interval from the uploaded source', async () => {
    const root = await storageRoot();
    const { calls, runner } = recordingRunner();
    const store = new LocalVisualAssetStore(root, runner);
    const clip = await store.createClip(ROOM, { index: 1, startMs: 300_000, durationMs: 300_000 });
    const args = calls[0]!.args;
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '300.000']);
    expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual(['-t', '300.000']);
    expect(args[args.indexOf('-i') + 1]).toBe(store.sourcePath(ROOM));
    expect(clip).toEqual({ path: join(root, ROOM, 'visual', 'clips', 'window-0001.mp4'), mimeType: 'video/mp4' });
    await store.removeClip(ROOM, clip.path);
    await expect(readdir(join(root, ROOM, 'visual', 'clips'))).resolves.toEqual([]);
  });

  it('removes partial frame output when extraction fails', async () => {
    const root = await storageRoot();
    const { runner } = recordingRunner({ fail: true });
    const store = new LocalVisualAssetStore(root, runner);
    await expect(store.extractFrame(ROOM, 'moment-0000', store.sourcePath(ROOM), 1_000)).rejects.toThrow();
    await expect(readdir(join(root, ROOM, 'visual', 'stills'))).resolves.toEqual([]);
    await expect(store.getImageFile(ROOM, 'moment-0000')).rejects.toThrow();
  });

  it('decodes frames only from media inside the room and rejects unsafe identifiers', async () => {
    const root = await storageRoot();
    const store = new LocalVisualAssetStore(root, recordingRunner().runner);
    await expect(store.extractFrame(ROOM, 'moment-0000', join(root, 'ROOMBBBB', 'source'), 0)).rejects.toThrow('outside room storage');
    await expect(store.removeClip(ROOM, join(root, ROOM, 'source'))).rejects.toThrow('outside room storage');
    expect(() => store.sourcePath('../escape')).toThrow('Session ID is invalid');
    await expect(store.getImageFile(ROOM, '../../source')).rejects.toThrow('Visual moment ID is invalid');
  });

  it('round-trips validated window caches and ignores malformed files', async () => {
    const root = await storageRoot();
    const store = new LocalVisualAssetStore(root, recordingRunner().runner);
    const window = {
      sessionId: ROOM, index: 2, startMs: 120_000, durationMs: 60_000, sourceKey: 'upload:1:1',
      status: 'reviewed' as const, attempts: 1, lastErrorCategory: null,
      candidate: { id: 'moment-0002', timestampMs: 130_000, topicTitle: 'Synthetic', description: 'Synthetic chart.' }
    };
    await store.writeWindow(ROOM, window);
    await writeFile(join(root, ROOM, 'visual', 'windows', 'window-0003.json'), '{"broken":');
    await expect(store.readWindow(ROOM, 2)).resolves.toEqual(window);
    await expect(store.listWindows(ROOM)).resolves.toEqual([window]);
    await expect(store.writeWindow(ROOM, { ...window, sessionId: 'ROOMBBBB' })).rejects.toThrow();
  });

  it('bounds live clip size and removes partial uploads', async () => {
    const root = await storageRoot();
    const store = new LocalVisualAssetStore(root, recordingRunner().runner);
    async function* oversized() {
      yield new Uint8Array(MAX_LIVE_CLIP_BYTES);
      yield new Uint8Array(1);
    }
    await expect(store.saveLiveClip(ROOM, 0, 'video/webm', oversized())).rejects.toBeInstanceOf(VisualClipTooLargeError);
    await expect(readdir(join(root, ROOM, 'visual', 'clips'))).resolves.toEqual([]);
    async function* small() { yield new Uint8Array([1, 2]); }
    const saved = await store.saveLiveClip(ROOM, 0, 'video/webm;codecs=vp9', small());
    expect(saved.mimeType).toBe('video/webm');
    await expect(store.probeDurationMs(saved.path)).resolves.toBe(61_250);
  });

  it.skipIf(!hasFfmpeg())('extracts the actual source frame at the requested timestamp', async () => {
    const root = await storageRoot();
    const store = new LocalVisualAssetStore(root);
    await mkdir(join(root, ROOM), { recursive: true });
    // Synthetic fixture: two seconds of solid red followed by two seconds of solid blue
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2:r=10', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=2:r=10',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mp4', store.sourcePath(ROOM)]);
    await store.extractFrame(ROOM, 'moment-0000', store.sourcePath(ROOM), 3_000);
    const image = await store.getImageFile(ROOM, 'moment-0000');
    const pixel = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', image.path, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    expect(pixel[2]!).toBeGreaterThan(pixel[0]!);
    expect((await readFile(image.path)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });
});
