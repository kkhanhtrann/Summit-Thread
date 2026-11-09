import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { MATERIAL_LIMITS, MaterialNotFoundError, MaterialTooLargeError, MaterialUnreadableError } from '../contracts/material.contract';
import type { MaterialRouteService } from '../application/materialService';
import { createMaterialRouter } from './materials.routes';

// Synthetic test fixture: a presenter-visible material without text
const material = { id: 'm-1', kind: 'pdf' as const, title: 'Fixture slides', status: 'ready' as const, pageCount: 2, passageCount: 2, createdAt: '2026-11-09T00:00:00.000Z' };

// Mount the router with replaceable service responses
function app(overrides: Partial<MaterialRouteService> = {}) {
  const service: MaterialRouteService = {
    list: vi.fn(async () => [material]),
    addText: vi.fn(async () => ({ ...material, kind: 'text' as const })),
    addPdf: vi.fn(async () => material),
    remove: vi.fn(async () => undefined),
    ...overrides
  };
  const server = express();
  server.use(express.json());
  server.use('/api/sessions', createMaterialRouter(service));
  server.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(503).json({ error: 'unavailable' }); });
  return { server, service };
}

describe('material routes', () => {
  it('lists a normalized room code without caching', async () => {
    const { server, service } = app();
    const response = await request(server).get('/api/sessions/ab12cd34/materials');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual({ materials: [material] });
    expect(service.list).toHaveBeenCalledWith('AB12CD34');
  });

  it('rejects malformed room codes before calling the service', async () => {
    const { server, service } = app();
    expect((await request(server).get('/api/sessions/nope/materials')).status).toBe(400);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('adds pasted notes and maps validation errors to a safe message', async () => {
    const { server } = app();
    const created = await request(server).post('/api/sessions/AB12CD34/materials').send({ title: 'Fixture notes', text: 'Fixture text' });
    expect(created.status).toBe(201);

    const invalid = app({ addText: vi.fn(async () => { throw new ZodError([]); }) });
    const rejected = await request(invalid.server).post('/api/sessions/AB12CD34/materials').send({ title: '', text: '' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/title up to 100 characters/);
  });

  it('uploads a PDF with a percent-encoded title', async () => {
    const { server, service } = app();
    const response = await request(server)
      .post('/api/sessions/AB12CD34/materials/pdf')
      .set('Content-Type', 'application/pdf')
      .set('X-Material-Title', encodeURIComponent('Fixture slides – café'))
      .send(Buffer.from('%PDF-fixture'));
    expect(response.status).toBe(201);
    expect(service.addPdf).toHaveBeenCalledWith('AB12CD34', 'Fixture slides – café', expect.any(Uint8Array));
  });

  it('rejects non-PDF uploads and oversized declared bodies before reading them', async () => {
    const { server, service } = app();
    expect((await request(server).post('/api/sessions/AB12CD34/materials/pdf').set('Content-Type', 'text/plain').send('x')).status).toBe(415);
    const oversized = await request(server)
      .post('/api/sessions/AB12CD34/materials/pdf')
      .set('Content-Type', 'application/pdf')
      .set('Content-Length', String(MATERIAL_LIMITS.pdfMaxBytes + 1))
      .send(Buffer.from('%PDF'));
    expect(oversized.status).toBe(413);
    expect(service.addPdf).not.toHaveBeenCalled();
  });

  it('maps unreadable, oversized, and missing materials to clear statuses', async () => {
    const unreadable = app({ addPdf: vi.fn(async () => { throw new MaterialUnreadableError(); }) });
    expect((await request(unreadable.server).post('/api/sessions/AB12CD34/materials/pdf').set('Content-Type', 'application/pdf').send(Buffer.from('x'))).status).toBe(422);

    const tooLarge = app({ addPdf: vi.fn(async () => { throw new MaterialTooLargeError(); }) });
    expect((await request(tooLarge.server).post('/api/sessions/AB12CD34/materials/pdf').set('Content-Type', 'application/pdf').send(Buffer.from('x'))).status).toBe(413);

    const missing = app({ remove: vi.fn(async () => { throw new MaterialNotFoundError(); }) });
    expect((await request(missing.server).delete('/api/sessions/AB12CD34/materials/m-x')).status).toBe(404);
  });

  it('removes a material and passes other failures to the shared handler', async () => {
    const { server, service } = app();
    expect((await request(server).delete('/api/sessions/AB12CD34/materials/m-1')).status).toBe(204);
    expect(service.remove).toHaveBeenCalledWith('AB12CD34', 'm-1');

    const broken = app({ list: vi.fn(async () => { throw new Error('PRIVATE_MARKER'); }) });
    const response = await request(broken.server).get('/api/sessions/AB12CD34/materials');
    expect(response.status).toBe(503);
    expect(response.text).not.toContain('PRIVATE_MARKER');
  });
});
