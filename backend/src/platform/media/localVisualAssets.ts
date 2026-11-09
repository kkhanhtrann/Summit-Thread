import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { z } from 'zod';

import { VisualClipTooLargeError, visualFailureCategories } from '../../features/sessions/contracts/visualMoment.contract';
import type { AnalysisWindow } from '../../features/sessions/application/visualWindows';
import type { StoredVisualWindow, VisualAssetPort } from '../../features/sessions/application/visualMomentService';

const execFileAsync = promisify(execFile);

// Cap one completed live clip accepted for analysis
export const MAX_LIVE_CLIP_BYTES = 200 * 1024 * 1024;
// Bound each FFmpeg or FFprobe invocation
const MEDIA_TOOL_TIMEOUT_MS = 10 * 60 * 1_000;

// Run one local media tool with arguments only, never through a shell
export type MediaToolRunner = (command: 'ffmpeg' | 'ffprobe', args: string[]) => Promise<{ stdout: string }>;

// Run FFmpeg tools with bounded time and output
const runMediaTool: MediaToolRunner = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, { windowsHide: true, timeout: MEDIA_TOOL_TIMEOUT_MS, maxBuffer: 4_000_000 });
  return { stdout };
};

// Validate cached window files before the service trusts them
const storedWindowSchema = z.object({
  sessionId: z.string(),
  index: z.number().int().min(0).max(9_999),
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  sourceKey: z.string().min(1).max(200),
  status: z.enum(['pending', 'reviewed', 'skipped']),
  attempts: z.number().int().nonnegative(),
  lastErrorCategory: z.enum(visualFailureCategories).nullable(),
  candidate: z.object({
    id: z.string().regex(/^moment-\d{4}$/),
    timestampMs: z.number().int().nonnegative(),
    topicTitle: z.string().min(1).max(120),
    description: z.string().min(1).max(280)
  }).strict().nullable()
}).strict();

// Store visual analysis inputs, caches, and stills in ignored room-scoped local folders
// Layout: <root>/<room>/source.media is the agreed uploaded source; visual/ holds clips, windows, and stills
export class LocalVisualAssetStore implements VisualAssetPort {
  constructor(
    private readonly storageRoot = resolve(process.cwd(), '../.data/recordings'),
    private readonly runTool: MediaToolRunner = runMediaTool
  ) {}

  // Return the private uploaded source path written by the media workflow
  sourcePath(sessionId: string): string {
    return join(this.roomDirectory(sessionId), 'source.media');
  }

  // Fingerprint the current upload so a replaced source invalidates cached windows
  async sourceKey(sessionId: string): Promise<string> {
    const metadata = await stat(this.sourcePath(sessionId));
    return `upload:${metadata.size}:${Math.trunc(metadata.mtimeMs)}`;
  }

  // Extract exactly one elapsed interval from the uploaded source as provider input
  async createClip(sessionId: string, window: AnalysisWindow): Promise<{ path: string; mimeType: string }> {
    const directory = await this.ensureDirectory(sessionId, 'clips');
    const path = join(directory, `window-${pad(window.index)}.mp4`);
    const temporaryPath = `${path}.tmp`;
    try {
      await this.runTool('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', seconds(window.startMs),
        '-i', this.sourcePath(sessionId),
        '-t', seconds(window.durationMs),
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
        '-c:a', 'aac', '-b:a', '64k',
        '-movflags', '+faststart', '-f', 'mp4', temporaryPath
      ]);
      await rename(temporaryPath, path);
      return { path, mimeType: 'video/mp4' };
    } catch (error) {
      // Remove partial clip output so a retry starts clean
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  // Save one completed live clip with a byte limit, publishing it only when fully written
  async saveLiveClip(sessionId: string, index: number, mimeType: string, chunks: AsyncIterable<Uint8Array>): Promise<{ path: string; mimeType: string }> {
    const extension = liveClipExtension(mimeType);
    const directory = await this.ensureDirectory(sessionId, 'clips');
    const path = join(directory, `live-${pad(index)}.${extension}`);
    const temporaryPath = `${path}.tmp`;
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        callback(bytes > MAX_LIVE_CLIP_BYTES ? new VisualClipTooLargeError() : null, chunk);
      }
    });
    try {
      await pipeline(Readable.from(chunks), limit, createWriteStream(temporaryPath, { flags: 'w', mode: 0o600 }));
      if (bytes === 0) throw new Error('Live clip is empty');
      await rename(temporaryPath, path);
      return { path, mimeType: `video/${extension === 'mov' ? 'quicktime' : extension}` };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  // Read clip duration, falling back to the last video packet when the container omits it
  async probeDurationMs(path: string): Promise<number> {
    const { stdout } = await this.runTool('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path]);
    let durationMs = Math.round(Number(stdout.trim()) * 1_000);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
      // Browser-recorded WebM often lacks a container duration
      const packets = await this.runTool('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', path]);
      const latest = Math.max(...packets.stdout.split(/\r?\n/).map(Number).filter(Number.isFinite));
      durationMs = Math.round(latest * 1_000);
    }
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw new Error('Clip duration is unavailable');
    return durationMs;
  }

  // Remove one temporary clip after its attempt, refusing paths outside the room's clip folder
  async removeClip(sessionId: string, path: string): Promise<void> {
    this.assertInside(join(this.roomDirectory(sessionId), 'visual', 'clips'), path);
    await rm(path, { force: true });
  }

  // Read one validated cached window, treating missing or malformed files as absent
  async readWindow(sessionId: string, index: number): Promise<StoredVisualWindow | null> {
    try {
      const content = await readFile(this.windowPath(sessionId, index), 'utf8');
      const parsed = storedWindowSchema.safeParse(JSON.parse(content));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  // List validated cached windows in index order
  async listWindows(sessionId: string): Promise<StoredVisualWindow[]> {
    const directory = join(this.roomDirectory(sessionId), 'visual', 'windows');
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    const indexes = files.flatMap((file) => {
      const match = /^window-(\d{4})\.json$/.exec(file);
      return match ? [Number(match[1])] : [];
    });
    const windows = await Promise.all(indexes.map((index) => this.readWindow(sessionId, index)));
    return windows.filter((window): window is StoredVisualWindow => window !== null).sort((left, right) => left.index - right.index);
  }

  // Replace one cached window atomically so readers never see partial JSON
  async writeWindow(sessionId: string, window: StoredVisualWindow): Promise<void> {
    const validated = storedWindowSchema.parse(window);
    if (validated.sessionId !== sessionId) throw new Error('Cached window room is invalid');
    await this.ensureDirectory(sessionId, 'windows');
    const path = this.windowPath(sessionId, validated.index);
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(validated), { mode: 0o600 });
    await rename(temporaryPath, path);
  }

  // Decode one original frame at the requested offset and store it without scaling or generation
  async extractFrame(sessionId: string, momentId: string, mediaPath: string, offsetMs: number): Promise<void> {
    this.assertInside(this.roomDirectory(sessionId), mediaPath);
    if (!Number.isSafeInteger(offsetMs) || offsetMs < 0) throw new RangeError('Frame offset is invalid');
    await this.ensureDirectory(sessionId, 'stills');
    const path = this.imagePath(sessionId, momentId);
    const temporaryPath = `${path}.tmp`;
    try {
      await this.runTool('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', seconds(offsetMs),
        '-i', mediaPath,
        '-frames:v', '1', '-an', '-q:v', '2', '-f', 'image2', '-c:v', 'mjpeg', temporaryPath
      ]);
      const metadata = await stat(temporaryPath);
      if (metadata.size === 0) throw new Error('Extracted frame is empty');
      await rename(temporaryPath, path);
    } catch (error) {
      // Remove partial extraction output so no unverified image can be served
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  // Return one stored still for the released-image endpoint
  async getImageFile(sessionId: string, momentId: string): Promise<{ path: string; size: number }> {
    const path = this.imagePath(sessionId, momentId);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size === 0) throw new Error('Still is unavailable');
    return { path, size: metadata.size };
  }

  // Restrict storage paths to eight-character uppercase room codes
  private roomDirectory(sessionId: string): string {
    if (!/^[A-Z0-9]{8}$/.test(sessionId)) throw new Error('Session ID is invalid');
    return join(this.storageRoot, sessionId);
  }

  private imagePath(sessionId: string, momentId: string): string {
    if (!/^moment-\d{4}$/.test(momentId)) throw new Error('Visual moment ID is invalid');
    return join(this.roomDirectory(sessionId), 'visual', 'stills', `${momentId}.jpg`);
  }

  private windowPath(sessionId: string, index: number): string {
    return join(this.roomDirectory(sessionId), 'visual', 'windows', `window-${pad(index)}.json`);
  }

  private async ensureDirectory(sessionId: string, name: 'clips' | 'windows' | 'stills'): Promise<string> {
    const directory = join(this.roomDirectory(sessionId), 'visual', name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  // Reject paths that escape the expected directory on any platform
  private assertInside(directory: string, path: string): void {
    const offset = relative(directory, resolve(path));
    if (!offset || offset.startsWith('..') || isAbsolute(offset)) throw new Error('Media path is outside room storage');
  }
}

// Format a non-negative millisecond offset for FFmpeg
function seconds(milliseconds: number): string {
  return (milliseconds / 1_000).toFixed(3);
}

// Pad window indexes for stable file names
function pad(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 9_999) throw new RangeError('Visual window index is invalid');
  return String(index).padStart(4, '0');
}

// Accept only browser-recorded live clip formats
function liveClipExtension(mimeType: string): 'webm' | 'mp4' | 'mov' {
  const base = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (base === 'video/webm') return 'webm';
  if (base === 'video/mp4') return 'mp4';
  if (base === 'video/quicktime') return 'mov';
  throw new RangeError('Live clip format is not supported');
}
