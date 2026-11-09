import { randomUUID } from 'node:crypto';
import { Client } from '@elastic/elasticsearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { PrismaRoomRepository } from '../src/features/sessions/persistence/prismaRoomRepository';
import { env } from '../src/config/env';
import { ReleasedContentRepository } from '../src/features/sessions/persistence/releasedContent.repository';
import { ElasticsearchCaptionIndex } from '../src/features/search/public';
import { SessionIndexingWorker } from '../src/features/sessions/application/sessionIndexingWorker';
const enabled = process.env.RUN_SEARCH_INTEGRATION === '1';
const room = 'A5' + randomUUID().replaceAll('-', '').slice(0,6).toUpperCase();
const otherRoom = 'B5' + randomUUID().replaceAll('-', '').slice(0,6).toUpperCase();
const caption = `${room}-released`;
const future = `${room}-future`;
const foreign = `${otherRoom}-released`;
const repository = new ReleasedContentRepository(prisma);
const client = new Client({ node: env.ELASTICSEARCH_URL });
const search = new ElasticsearchCaptionIndex(client);

describe.skipIf(!enabled)('real PostgreSQL and Elasticsearch boundary', () => {
 beforeAll(async () => {
   await prisma.$transaction(async tx => {
     for (const id of [room, otherRoom]) await tx.conferenceSession.create({ data: { id, title: 'SYNTHETIC Ask integration fixture', eventName: 'Test', speakerName: 'Fixture', contentLabel: 'Synthetic test only', releasedCount: 1 } });
     await tx.captionSegment.createMany({ data: [
       { id: caption, sessionId: room, sequence: 0, timestampMs: 12000, text: 'SYNTHETIC shade cools the walking route.' },
       { id: future, sessionId: room, sequence: 1, timestampMs: 24000, text: 'SYNTHETIC FUTURE shade secret.' },
       { id: foreign, sessionId: otherRoom, sequence: 0, timestampMs: 5000, text: 'SYNTHETIC FOREIGN shade.' }
     ] });
     await tx.searchIndexJob.create({ data: { id: caption, sessionId: room, captionId: caption, operation: 'index_caption' } });
   });
 });
 afterAll(async () => {
   for (const id of [room,otherRoom]) { await search.deleteSession(id); await prisma.conferenceSession.deleteMany({ where: { id } }); }
   await search.close(); await prisma.$disconnect();
 });
 it('reads only released captions below the PostgreSQL cursor', async () => {
   const content = await repository.getReleasedContent(room);
   expect(content.captions.map(c => c.id)).toEqual([caption]);
   expect(content.session.id).toBe(room);
 });
 it('drains committed jobs and excludes foreign/future/stale-only indexed records', async () => {
   await new SessionIndexingWorker(repository,search).drain();
   for (const [id,sessionId] of [[future,room],[foreign,otherRoom],[`${room}-orphan`,room]]) await search.indexCaption(sessionId!, { id: id!, sequence: 1, timestampMs: 24000, text: 'shade' });
   const results = await search.findReleasedCaptions(room,'shade',[caption]);
   expect(results.map(c => c.id)).toEqual([caption]);
   expect(await prisma.searchIndexJob.count({ where: { sessionId: room } })).toBe(0);
 });
 it('rebuilds released search documents from committed records', async () => {
   await search.deleteSession(room);
   await repository.enqueueRebuild();
   expect(await prisma.searchIndexJob.count({ where: { sessionId: room } })).toBeGreaterThan(0);
   await new SessionIndexingWorker(repository,search).drain();
   const results = await search.findReleasedCaptions(room,'shade',[caption]);
   expect(results.map(c => c.id)).toEqual([caption]);
 });
 it('retrieves current topic context and replaces older indexed topic text', async () => {
   const threadId = `${room}-topic`;
   const occurrenceId = `${room}-visit`;
   await prisma.$transaction(async tx => {
     await tx.topicThread.create({ data: { id: threadId, sessionId: room, title: 'Canopy equity', summary: 'SYNTHETIC topic context' } });
     await tx.topicOccurrence.create({ data: { id: occurrenceId, sessionId: room, threadId, ordinal: 0, summary: 'SYNTHETIC visit', evidenceCaptionIds: [caption], startedSequence: 0, startedAtMs: 12000 } });
     await tx.captionSegment.update({ where: { id: caption }, data: { topicOccurrenceId: occurrenceId } });
     await tx.searchIndexJob.create({ data: { id: `topic:${caption}`, sessionId: room, captionId: caption, operation: 'index_caption' } });
   });
   await new SessionIndexingWorker(repository,search).drain();
   expect((await search.findReleasedCaptions(room,'canopy',[caption])).map(c => c.id)).toEqual([caption]);
   await prisma.$transaction(async tx => {
     await tx.topicThread.update({ where: { id: threadId }, data: { title: 'Transit cooling' } });
     await tx.searchIndexJob.create({ data: { id: `topic-refresh:${caption}`, sessionId: room, captionId: caption, operation: 'index_caption' } });
   });
   await new SessionIndexingWorker(repository,search).drain();
   expect(await search.findReleasedCaptions(room,'canopy',[caption])).toEqual([]);
   expect((await search.findReleasedCaptions(room,'transit',[caption])).map(c => c.id)).toEqual([caption]);
 });
 it('retains committed jobs across a real connection failure and a worker restart', async () => {
   await prisma.searchIndexJob.create({ data: { id: `outage:${caption}`, sessionId: room, captionId: caption, operation: 'index_caption' } });
   const offline = new ElasticsearchCaptionIndex(new Client({ node: 'http://127.0.0.1:1', maxRetries: 0, requestTimeout: 200 }));
   try {
     await new SessionIndexingWorker(repository,offline).drain();
     expect(await prisma.searchIndexJob.count({ where: { id: `outage:${caption}` } })).toBe(1);
     expect((await repository.getReleasedContent(room)).captions[0]?.id).toBe(caption);
   } finally { await offline.close(); }
   await new SessionIndexingWorker(new ReleasedContentRepository(prisma),search).drain();
   expect(await prisma.searchIndexJob.count({ where: { id: `outage:${caption}` } })).toBe(0);
   expect((await search.findReleasedCaptions(room,'shade',[caption]))[0]?.id).toBe(caption);
 });
 it('commits a new finalized caption and its index job in the same release transaction', async () => {
   await prisma.captionSegment.delete({ where: { id: future } });
   await prisma.conferenceSession.update({ where: { id: room }, data: { isLive: true } });
   await prisma.preparedRecording.create({ data: { sessionId: room, sourceType: 'upload', mediaKind: 'audio', mimeType: 'audio/wav', status: 'ready', durationMs: 60000, isPlaying: true } });
   const rooms = new PrismaRoomRepository(prisma);
   const id = `${room}-atomic`;
   await rooms.releaseCaption(room,id,'SYNTHETIC finalized speech.',30000);
   expect(await prisma.captionSegment.count({ where: { id } })).toBe(1);
   expect(await prisma.searchIndexJob.count({ where: { captionId: id, sessionId: room } })).toBe(1);
   expect((await repository.getReleasedContent(room)).captions.some(item => item.id === id)).toBe(true);
 });

});
