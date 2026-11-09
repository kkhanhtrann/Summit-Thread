import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffprobe from '@ffprobe-installer/ffprobe';
import { RecordingTooLargeError } from '../../features/sessions/public';

// Limit recordings to 300 MiB even when the browser omits Content-Length
export const MAX_RECORDING_BYTES = 300 * 1024 * 1024;
// Keep room uploads private and outside tracked source files
export class LocalRecordingAssetStore {
  constructor(
    private readonly directory = resolve('.data/recordings'),
    private readonly maxBytes = MAX_RECORDING_BYTES
  ) {}
  // Stream bounded bytes into a temporary file and install only complete uploads
  async saveUpload(
    id: string,
    chunks: AsyncIterable<Uint8Array>
  ): Promise<void> {
    const directory = this.roomDirectory(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const partial = join(directory, 'source.part');
    // Remove a partial left by an interrupted process after reserving this room upload
    await rm(partial, { force: true });
    let size = 0;
    const maxBytes = this.maxBytes;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        callback(size > maxBytes ? new RecordingTooLargeError() : null, chunk);
      }
    });
    try {
      await pipeline(
        Readable.from(chunks),
        limit,
        createWriteStream(partial, { flags: 'wx', mode: 0o600 })
      );
      if (!size) throw new RangeError('Empty source');
      await rename(partial, join(directory, 'source'));
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }
  // Remove rejected source bytes before exposing failed preparation state
  async remove(id: string) {
    await rm(this.roomDirectory(id), { recursive: true, force: true });
  }
  // Return storage details only to backend media delivery
  async getMediaFile(id: string) {
    const path = join(this.roomDirectory(id), 'source');
    return { path, size: (await stat(path)).size };
  }
  private roomDirectory(id: string) {
    if (!/^[A-F0-9]{8}$/.test(id)) throw new RangeError('Invalid room code');
    return join(this.directory, id);
  }
}
// Require a finite duration and source audio without exposing ffprobe diagnostics
export async function readRecordingDuration(
  path: string,
  kind: 'audio' | 'video'
): Promise<number> {
  try {
    const { stdout } = await promisify(execFile)(
      ffprobe.path,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_type',
        '-of',
        'json',
        path
      ],
      { timeout: 30_000, maxBuffer: 1_000_000 }
    );
    const data = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string }[];
    };
    const types = data.streams?.map((stream) => stream.codec_type) ?? [];
    const duration = Math.round(Number(data.format?.duration) * 1000);
    if (
      !types.includes('audio') ||
      (kind === 'video' && !types.includes('video')) ||
      !Number.isSafeInteger(duration) ||
      duration <= 0 ||
      duration > 86_400_000
    )
      throw new Error();
    return duration;
  } catch (error) {
    // Keep backend tool failures out of the invalid-source HTTP response
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'EACCES')
    )
      throw new Error('Recording validation is unavailable');
    throw new RangeError(
      'The recording could not be validated. Choose a valid file with audio.'
    );
  }
}
