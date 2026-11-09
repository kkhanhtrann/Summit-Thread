import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../../app';
import { LiveWindowOrderError, VisualImageUnavailableError, VisualMomentNotFoundError } from '../contracts/visualMoment.contract';
import type { VisualMomentRoutesPort } from './visualMoments.routes';

let directory = '';
let imagePath = '';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'summit-visual-route-'));
  // Mirror the default storage layout, whose .data root must not block released stills
  const stills = join(directory, '.data', 'recordings', 'ROOMAAAA', 'visual', 'stills');
  await mkdir(stills, { recursive: true });
  imagePath = join(stills, 'moment-0000.jpg');
  // Synthetic JPEG header bytes, not recorded media
  await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

// Release one synthetic still in room ROOMAAAA only
function fakeService(): VisualMomentRoutesPort & { submissions: Array<{ sessionId: string; index: number; mimeType: string }> } {
  const submissions: Array<{ sessionId: string; index: number; mimeType: string }> = [];
  return {
    submissions,
    getReleasedImage: async (sessionId, momentId) => {
      if (sessionId === 'ROOMAAAA' && momentId === 'moment-0000') return { path: imagePath, size: 4 };
      if (sessionId === 'ROOMAAAA' && momentId === 'moment-0009') throw new VisualImageUnavailableError();
      throw new VisualMomentNotFoundError();
    },
    submitLiveWindow: async (sessionId, index, mimeType, chunks) => {
      for await (const _chunk of chunks) { /* drain */ }
      if (index > 0) throw new LiveWindowOrderError();
      submissions.push({ sessionId, index, mimeType });
      return { analysisState: 'ready' } as never;
    }
  };
}

describe('visual moment routes', () => {
  it('serves released still bytes for the owning room without exposing storage paths', async () => {
    const response = await request(createApp(undefined, undefined, { visualMoments: fakeService() })).get('/api/sessions/roomaaaa/visual-moments/moment-0000/image');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['cache-control']).toBe('private, max-age=86400');
    expect(response.body).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it('rejects unknown, unreleased, wrong-room, and malformed moment IDs with the same safe response', async () => {
    const app = createApp(undefined, undefined, { visualMoments: fakeService() });
    for (const path of [
      '/api/sessions/ROOMBBBB/visual-moments/moment-0000/image',
      '/api/sessions/ROOMAAAA/visual-moments/moment-0001/image',
      '/api/sessions/ROOMAAAA/visual-moments/..%2Fsource/image',
      '/api/sessions/bad/visual-moments/moment-0000/image'
    ]) {
      const response = await request(app).get(path);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Visual moment not found' });
      expect(response.text).not.toContain(directory);
    }
    const unavailable = await request(app).get('/api/sessions/ROOMAAAA/visual-moments/moment-0009/image');
    expect(unavailable.status).toBe(404);
    expect(unavailable.body).toEqual({ error: 'Image unavailable' });
  });

  it('accepts completed live clips in order and rejects unsupported or out-of-order submissions', async () => {
    const service = fakeService();
    const app = createApp(undefined, undefined, { visualMoments: service });
    const accepted = await request(app).post('/api/sessions/ROOMAAAA/recording/live/windows/0').set('Content-Type', 'video/webm;codecs=vp9').send(Buffer.from([1, 2, 3]));
    expect(accepted.status).toBe(202);
    expect(service.submissions).toEqual([{ sessionId: 'ROOMAAAA', index: 0, mimeType: 'video/webm' }]);
    const ahead = await request(app).post('/api/sessions/ROOMAAAA/recording/live/windows/2').set('Content-Type', 'video/webm').send(Buffer.from([1]));
    expect(ahead.status).toBe(409);
    const audio = await request(app).post('/api/sessions/ROOMAAAA/recording/live/windows/0').set('Content-Type', 'audio/webm').send(Buffer.from([1]));
    expect(audio.status).toBe(400);
  });

  it('documents moment ID patterns in OpenAPI that accept real IDs', () => {
    const spec = readFileSync(resolve(__dirname, '../../../../openapi.json'), 'utf8');
    const patterns = [...spec.matchAll(/"pattern": ("\^moment-[^"]*")/g)].map((match) => JSON.parse(match[1]!) as string);
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(new RegExp(pattern).test('moment-0000')).toBe(true);
      expect(new RegExp(pattern).test('moment-dddd')).toBe(false);
    }
  });

  it('does not mount visual routes until the feature is composed', async () => {
    const response = await request(createApp()).get('/api/sessions/ROOMAAAA/visual-moments/moment-0000/image');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not found' });
  });
});
