import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app';

describe('camera HTTP contracts', () => {
  it('starts and ends a camera source with validated cadence and safe errors', async () => {
    const camera = { startLiveCapture: vi.fn().mockResolvedValue({ sourceType: 'camera' }), stopLiveCapture: vi.fn().mockResolvedValue({ isPlaying: false }) };
    const app = createApp(undefined, undefined, undefined, { camera });
    expect((await request(app).post('/api/sessions/AB12CD34/recording/live/start').send({ analysisWindowMinutes: 1 })).status).toBe(201);
    expect(camera.startLiveCapture).toHaveBeenCalledWith('AB12CD34', 1);
    expect((await request(app).post('/api/sessions/AB12CD34/recording/live/start').send({ analysisWindowMinutes: 2 })).status).toBe(400);
    expect((await request(app).post('/api/sessions/AB12CD34/recording/live/stop')).status).toBe(200);
    camera.startLiveCapture.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_MARKER'));
    const failed = await request(app).post('/api/sessions/AB12CD34/recording/live/start').send({ analysisWindowMinutes: 1 });
    expect(failed.status).toBe(503);
    expect(failed.text).not.toContain('SYNTHETIC_PRIVATE_MARKER');
  });
});
