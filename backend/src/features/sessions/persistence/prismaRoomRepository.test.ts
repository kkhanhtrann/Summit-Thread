import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../../config/env';
import { PrismaRoomRepository } from './prismaRoomRepository';

// Isolate integration fixtures from existing development rooms and participant content
const schema = `st02_fixture_${randomUUID().replaceAll('-', '')}`;
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
const repository = new PrismaRoomRepository(prisma);
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
async function room(id: string) {
  await repository.createSession({
    id,
    title: 'Synthetic transaction fixture'
  });
  await repository.beginUpload(id, 'audio/wav', 'audio', 5);
  await repository.finishUpload(id, 10000);
  await repository.updatePlayback(id, 2500, true);
}
describe('PostgreSQL caption release', () => {
  it('starts with an empty snapshot and serializes simultaneous final writes and retry IDs', async () => {
    const initial = await repository.createSession({
      id: 'A0000001',
      title: 'Synthetic empty room'
    });
    expect(initial.captions).toEqual([]);
    expect(initial.threads).toEqual([]);
    expect(initial.recording).toBeNull();
    await room('A0000002');
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repository.releaseCaption(
          'A0000002',
          `synthetic-${index}`,
          `Synthetic caption ${index}`,
          2000
        )
      )
    );
    const snapshot = await repository.getSnapshot('A0000002');
    expect(snapshot.captions.map((c) => c.sequence)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7
    ]);
    expect(snapshot.session.releasedCount).toBe(8);
    expect(snapshot.session.revision).toBe(11);
    await expect(
      repository.releaseCaption(
        'A0000002',
        'synthetic-0',
        'Synthetic retry',
        2000
      )
    ).resolves.toMatchObject({
      caption: { id: 'synthetic-0', text: 'Synthetic caption 0' },
      revision: 11
    });
    expect(
      await prisma.searchIndexJob.count({ where: { sessionId: 'A0000002' } })
    ).toBe(8);
  }, 15000);
  it('rolls back caption, cursor and revision if indexing-job insertion fails', async () => {
    await room('A0000003');
    await pool.query(
      `ALTER TABLE "${schema}"."SearchIndexJob" ADD CONSTRAINT synthetic_reject_job CHECK ("sessionId" <> 'A0000003')`
    );
    try {
      await expect(
        repository.releaseCaption(
          'A0000003',
          'synthetic-rollback',
          'Synthetic rollback',
          2000
        )
      ).rejects.toThrow();
      const snapshot = await repository.getSnapshot('A0000003');
      expect(snapshot.captions).toEqual([]);
      expect(snapshot.session.releasedCount).toBe(0);
      expect(snapshot.session.revision).toBe(3);
    } finally {
      await pool.query(
        `ALTER TABLE "${schema}"."SearchIndexJob" DROP CONSTRAINT synthetic_reject_job`
      );
    }
  });
  it('keeps paused, future and cross-room captions outside released snapshots', async () => {
    await room('A0000004');
    await room('A0000005');
    await repository.releaseCaption(
      'A0000004',
      'synthetic-visible',
      'Synthetic visible',
      2000
    );
    await prisma.captionSegment.create({
      data: {
        id: 'synthetic-future',
        sessionId: 'A0000004',
        sequence: 99,
        timestampMs: 9000,
        text: 'Synthetic unreleased'
      }
    });
    expect(
      (await repository.getSnapshot('A0000004')).captions.map((c) => c.id)
    ).toEqual(['synthetic-visible']);
    expect((await repository.getSnapshot('A0000005')).captions).toEqual([]);
    await repository.updatePlayback('A0000004', 3000, false);
    await expect(
      repository.releaseCaption(
        'A0000004',
        'synthetic-paused',
        'Synthetic paused',
        3000
      )
    ).resolves.toBeNull();
  });
  it('pauses unfinished activity on restart while retaining speech and source cursor', async () => {
    await room('A0000006');
    await repository.releaseCaption(
      'A0000006',
      'synthetic-retained',
      'Synthetic retained',
      2000
    );
    await repository.createSession({
      id: 'A0000007',
      title: 'Synthetic interrupted upload'
    });
    await repository.beginUpload('A0000007', 'audio/wav', 'audio', 3);
    await repository.pauseActiveSessions();
    const snapshot = await repository.getSnapshot('A0000006');
    expect(snapshot.session.isLive).toBe(false);
    expect(snapshot.recording?.isPlaying).toBe(false);
    expect(snapshot.recording?.playbackPositionMs).toBe(2500);
    expect(snapshot.captions).toHaveLength(1);
    expect((await repository.getSnapshot('A0000007')).recording?.status).toBe(
      'failed'
    );
  });
  it('pauses only disconnected source clocks while retaining their persisted position', async () => {
    await room('A0000008');
    await room('A0000009');
    await prisma.preparedRecording.update({
      where: { sessionId: 'A0000008' },
      data: { playbackUpdatedAt: new Date(Date.now() - 30000) }
    });
    const paused = await repository.pauseDisconnected(
      new Date(Date.now() - 15000)
    );
    expect(paused.map((row) => row.sessionId)).toContain('A0000008');
    expect(paused.map((row) => row.sessionId)).not.toContain('A0000009');
    expect((await repository.getSnapshot('A0000008')).recording).toMatchObject({
      isPlaying: false,
      playbackPositionMs: 2500
    });
    expect(
      (await repository.getSnapshot('A0000009')).recording?.isPlaying
    ).toBe(true);
  });
});
it('retains the final utterance while the source reaches its end and drains', async () => {
  await room('A0000010');
  await repository.updatePlayback('A0000010', 10000, true);
  await expect(
    repository.releaseCaption(
      'A0000010',
      'synthetic-ending',
      'Synthetic final utterance',
      10000
    )
  ).resolves.toMatchObject({ caption: { id: 'synthetic-ending' } });
  await repository.updatePlayback('A0000010', 10000, false);
  expect((await repository.getSnapshot('A0000010')).captions).toHaveLength(1);
});
