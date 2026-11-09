import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from './app';

// Synthetic test fixture: a presenter-visible material without text
const material = { id: 'm-1', kind: 'text', title: 'Fixture notes', status: 'ready', pageCount: null, passageCount: 1, createdAt: '2026-11-09T00:00:00.000Z' };

describe('presenter material composition', () => {
  it('accepts long pasted notes on the material route only', async () => {
    const materials = { list: vi.fn(), addText: vi.fn(async () => material), addPdf: vi.fn(), remove: vi.fn() };
    const app = createApp(undefined, undefined, undefined, { materials: materials as never });
    const notes = 'Fixture note. '.repeat(3_500);

    const accepted = await request(app).post('/api/sessions/AB12CD34/materials').send({ title: 'Fixture notes', text: notes });
    expect(accepted.status).toBe(201);
    expect(materials.addText).toHaveBeenCalledWith('AB12CD34', { title: 'Fixture notes', text: notes });

    // Keep the small default body limit everywhere else; the shared handler rejects the
    // oversized body before routing, where an unmounted chat route would otherwise return 404
    const rejected = await request(app).post('/api/sessions/AB12CD34/chat').send({ question: notes });
    expect(rejected.status).toBe(503);
  });
});
