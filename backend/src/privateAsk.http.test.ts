import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { SearchUnavailableError } from './features/sessions/public';
const service = { ask: vi.fn(async () => ({ answer: 'No evidence yet', citations: [] })) };
const context = async () => ({ session: { id: 'A5000001', title: 'Synthetic test' }, captions: [], suggestedQuestions: [] });
describe('private Ask HTTP boundary', () => {
 it('accepts a validated private question', async () => {
   const r = await request(createApp(undefined, undefined, { service, context })).post('/api/sessions/A5000001/chat').send({ question: 'Why?', history: [] });
   expect(r.status).toBe(200); expect(r.body.citations).toEqual([]);
 });
 it('rejects invalid questions and prevents caching private answers', async () => {
   const app = createApp(undefined, undefined, { service, context });
   expect((await request(app).post('/api/sessions/A5000001/chat').send({ question: '' })).status).toBe(400);
   const r = await request(app).post('/api/sessions/A5000001/chat').send({ question: 'Why?' });
   expect(r.headers['cache-control']).toBe('no-store');
 });
 it('returns released context without private conversations', async () => {
   const r = await request(createApp(undefined, undefined, { service, context })).get('/api/sessions/A5000001/ask-context');
   expect(r.status).toBe(200); expect(r.body).toEqual(await context());
 });
 it('suppresses dependency details', async () => {
   const r = await request(createApp(undefined, undefined, { service: { ask: async () => { throw new SearchUnavailableError(); } }, context })).post('/api/sessions/A5000001/chat').send({ question: 'Why?' });
   expect(r.status).toBe(503); expect(r.body.error).toBe('Search is temporarily unavailable');
 });
});
