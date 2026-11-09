import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createApp } from './app';
describe('foundation health', () => {
  it('reports liveness without checking dependencies', async () => {
    const response = await request(createApp()).get('/api/health/live');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
  it('reports readiness after dependency checks', async () => {
    const response = await request(createApp(async () => {})).get('/api/health/ready');
    expect(response.status).toBe(200);
  });
  it('returns a safe unavailable response when dependencies fail', async () => {
    const response = await request(createApp(async () => { throw new Error('SYNTHETIC_PRIVATE_MARKER'); })).get('/api/health/ready');
    expect(response.status).toBe(503);
    expect(response.text).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    expect(response.body).toEqual({ status: 'unavailable' });
  });
  it('does not advertise unfinished product routes', async () => {
    const response = await request(createApp()).post('/api/sessions');
    expect(response.status).toBe(404);
  });
});
