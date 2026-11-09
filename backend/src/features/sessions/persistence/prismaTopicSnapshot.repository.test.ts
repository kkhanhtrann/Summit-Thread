import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../../config/env';
import type { TopicAnalysisSegment } from '../../../platform/ai/topicAnalysis';
import { PrismaRoomRepository } from './prismaRoomRepository';
import { PrismaSessionRepository } from './prismaSession.repository';

// Isolate integration fixtures from existing development rooms and participant content
const schema = `st03_fixture_${randomUUID().replaceAll('-', '')}`;
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
const fixtureUrl = new URL(env.DATABASE_URL);
fixtureUrl.searchParams.set('options', `-c search_path=${schema},public`);
const prisma = new PrismaClient({
  adapter: new PrismaPg(
    { connectionString: fixtureUrl.toString(), max: 5 },
    { schema }
  ),
  log: []
});
const rooms = new PrismaRoomRepository(prisma);
const topics = new PrismaSessionRepository(prisma);
beforeAll(async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      resolve('node_modules/prisma/build/index.js'),
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema',
      'prisma/schema.prisma',
      '--script'
    ],
    { timeout: 25000, maxBuffer: 1_000_000 }
  );
  const connection = await pool.connect();
  try {
    await connection.query(`CREATE SCHEMA "${schema}"`);
    await connection.query(`SET search_path TO "${schema}"`);
    await connection.query(stdout.replaceAll('"public"', `"${schema}"`));
  } finally {
    await connection.query('SET search_path TO public');
    connection.release();
  }
}, 30000);
afterAll(async () => {
  await prisma.$disconnect();
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});
// Release labeled synthetic captions through the same path as live transcription
async function playingRoom(id: string, lines: number) {
  await rooms.createSession({ id, title: 'Synthetic topic fixture' });
  await rooms.beginUpload(id, 'audio/wav', 'audio', 1);
  await rooms.finishUpload(id, 60_000);
  await rooms.updatePlayback(id, 0, true);
  for (let sequence = 0; sequence < lines; sequence += 1) {
    await rooms.releaseCaption(
      id,
      `${id}-fixture-${sequence}`,
      `Fixture line ${sequence}`,
      (sequence + 1) * 1_000
    );
  }
}
// Build one grounded segment starting at a synthetic caption
function segment(
  id: string,
  start: number,
  extra: Partial<TopicAnalysisSegment> = {}
): TopicAnalysisSegment {
  return {
    startCaptionId: `${id}-fixture-${start}`,
    decision: 'new',
    title: `Fixture topic ${start}`,
    summary: 'A fixture summary grounded in the synthetic released lines.',
    occurrenceSummary: 'A fixture visit note.',
    summaryEvidenceCaptionIds: [`${id}-fixture-${start}`],
    occurrenceEvidenceCaptionIds: [`${id}-fixture-${start}`],
    suggestedQuestions: ['What does the fixture line describe?'],
    ...extra
  };
}

describe('PostgreSQL topic snapshots', () => {
  it('publishes committed A to B to A visits with exact caption associations', async () => {
    const id = 'B0000001';
    await playingRoom(id, 6);
    await topics.requestTopicAnalysis(id);
    const context = await topics.getTopicAnalysisContext(id);
    expect(context?.input.captions).toHaveLength(6);

    const snapshot = await topics.applyTopicAnalysis(id, 0, 6, {
      segments: [
        segment(id, 0),
        segment(id, 2),
        segment(id, 4, {
          decision: 'return',
          threadId: `${id}-fixture-0`,
          summaryEvidenceCaptionIds: [`${id}-fixture-1`, `${id}-fixture-4`]
        })
      ]
    });

    expect(snapshot?.threads.map((thread) => thread.occurrences.length)).toEqual([2, 1]);
    const [first, second] = snapshot!.threads;
    expect(first!.occurrences.map((visit) => visit.startedAtMs)).toEqual([1_000, 5_000]);
    expect(second!.occurrences[0]!.captions.map((caption) => caption.sequence)).toEqual([2, 3]);
    expect(snapshot!.captions.map((caption) => caption.threadId)).toEqual([
      first!.id, first!.id, second!.id, second!.id, first!.id, first!.id
    ]);
    expect(snapshot!.activeOccurrenceId).toBe(first!.occurrences[1]!.id);
    // Converge reconnecting readers on the same committed associations
    expect(await rooms.getSnapshot(id)).toEqual(snapshot);
  });

  it('keeps skipped speech readable and reports its count', async () => {
    const id = 'B0000002';
    await playingRoom(id, 3);
    await topics.requestTopicAnalysis(id);
    await topics.getTopicAnalysisContext(id);

    const snapshot = await topics.skipTopicAnalysisBatch(id, 0, 3);

    expect(snapshot?.topicAnalysisSkippedCaptionCount).toBe(3);
    expect(snapshot?.captions).toHaveLength(3);
    expect(snapshot?.threads).toEqual([]);
  });
});
