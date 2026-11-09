import request from 'supertest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../../../app';
import { SessionNotFoundError } from '../contracts/session.contract';

// Keep deterministic endpoint fixtures separate from runtime room content
function fixture() {
  const sessions = {
    createSession: vi
      .fn()
      .mockResolvedValue({
        session: { id: 'AB12CD34' },
        captions: [],
        threads: [],
        visualMoments: []
      }),
    getSnapshot: vi.fn(),
    subscribe: vi.fn(() => vi.fn())
  };
  const recordings = {
    upload: vi.fn().mockResolvedValue({ status: 'ready' }),
    updatePlayback: vi.fn().mockResolvedValue({ status: 'ready' }),
    getMediaFile: vi.fn()
  };
  return {
    sessions,
    recordings,
    app: createApp(undefined, { sessions, recordings })
  };
}
describe('room HTTP contracts', () => {
  it('creates rooms from validated titles and normalizes room lookup codes', async () => {
    const f = fixture();
    expect(
      (
        await request(f.app)
          .post('/api/sessions')
          .send({ title: ' Synthetic fixture ' })
      ).status
    ).toBe(201);
    expect(f.sessions.createSession).toHaveBeenCalledWith({
      title: 'Synthetic fixture'
    });
    expect(
      (await request(f.app).post('/api/sessions').send({ title: ' ' })).status
    ).toBe(400);
    f.sessions.getSnapshot.mockRejectedValue(new SessionNotFoundError());
    expect((await request(f.app).get('/api/sessions/ab12cd34')).status).toBe(
      404
    );
    expect(f.sessions.getSnapshot).toHaveBeenCalledWith('AB12CD34');
    expect((await request(f.app).get('/api/sessions/invalid')).status).toBe(
      400
    );
  });
  it('rejects upload limits and invalid intervals before invoking application code', async () => {
    const f = fixture();
    expect(
      (
        await request(f.app)
          .post('/api/sessions/AB12CD34/recording')
          .set('Content-Type', 'audio/wav')
          .set('Content-Length', String(300 * 1024 * 1024 + 1))
      ).status
    ).toBe(413);
    expect(
      (
        await request(f.app)
          .post('/api/sessions/AB12CD34/recording')
          .set('Content-Type', 'audio/wav')
          .set('X-Thread-Update-Minutes', '2')
          .send(Buffer.from('fixture'))
      ).status
    ).toBe(400);
    expect(f.recordings.upload).not.toHaveBeenCalled();
    expect(
      (
        await request(f.app)
          .post('/api/sessions/AB12CD34/recording/playback')
          .send({ positionMs: -1, isPlaying: true })
      ).status
    ).toBe(400);
    expect(
      (
        await request(f.app)
          .post('/api/sessions/AB12CD34/recording/playback')
          .send({ positionMs: 1200, isPlaying: false })
      ).status
    ).toBe(200);
  });
  it('supports full, bounded, suffix and invalid ranges plus HEAD', async () => {
    const f = fixture();
    const directory = await mkdtemp(join(tmpdir(), 'st02-range-'));
    const path = join(directory, 'synthetic');
    await writeFile(path, '0123456789');
    f.recordings.getMediaFile.mockResolvedValue({
      path,
      size: 10,
      mimeType: 'audio/mpeg'
    });
    try {
      const full = await request(f.app).get(
        '/api/sessions/AB12CD34/recording/media'
      );
      expect(full.status).toBe(200);
      expect(full.headers['content-length']).toBe('10');
      const range = await request(f.app)
        .get('/api/sessions/AB12CD34/recording/media')
        .set('Range', 'bytes=2-4');
      expect(range.status).toBe(206);
      expect(range.headers['content-range']).toBe('bytes 2-4/10');
      expect(range.body.toString()).toBe('234');
      const suffix = await request(f.app)
        .get('/api/sessions/AB12CD34/recording/media')
        .set('Range', 'bytes=-2');
      expect(suffix.status).toBe(206);
      expect(suffix.body.toString()).toBe('89');
      const head = await request(f.app).head(
        '/api/sessions/AB12CD34/recording/media'
      );
      expect(head.status).toBe(200);
      expect(head.text).toBeUndefined();
      for (const value of [
        'bytes=10-',
        'bytes=4-2',
        'bytes=0-1,3-4',
        'bytes=-0'
      ])
        expect(
          (
            await request(f.app)
              .get('/api/sessions/AB12CD34/recording/media')
              .set('Range', value)
          ).status
        ).toBe(416);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('redacts filesystem and provider diagnostics in public failures', async () => {
    const f = fixture();
    f.sessions.getSnapshot.mockRejectedValue(
      new Error('/private/SYNTHETIC_PROVIDER_SECRET')
    );
    const response = await request(f.app).get('/api/sessions/AB12CD34');
    expect(response.status).toBe(503);
    expect(response.text).not.toContain('SYNTHETIC_PROVIDER_SECRET');
  });
});
