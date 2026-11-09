import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../../config/env';
import { MaterialNotFoundError } from '../contracts/material.contract';
import { SessionNotFoundError } from '../contracts/session.contract';
import { PrismaMaterialRepository } from './prismaMaterial.repository';
import { PrismaRoomRepository } from './prismaRoomRepository';
import { ReleasedContentRepository } from './releasedContent.repository';

// Isolate integration fixtures from existing development rooms and participant content
const schema = `st07_fixture_${randomUUID().replaceAll('-', '')}`;
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
const fixtureUrl = new URL(env.DATABASE_URL);
fixtureUrl.searchParams.set('options', `-c search_path=${schema},public`);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: fixtureUrl.toString(), max: 5 }, { schema }),
  log: []
});
const rooms = new PrismaRoomRepository(prisma);
const materials = new PrismaMaterialRepository(prisma);
const content = new ReleasedContentRepository(prisma);
beforeAll(async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [resolve('node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.prisma', '--script'],
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
// Synthetic test fixture: labeled passages, not real presenter material
const passages = [
  { pageNumber: 1, text: 'Fixture slide one: urban heat islands.' },
  { pageNumber: 2, text: 'Fixture slide two: reflective roofs.' }
];

describe('PostgreSQL presenter materials', () => {
  it('commits passages, their index jobs, and the ready status together', async () => {
    await rooms.createSession({ id: 'C0000001', title: 'Synthetic material fixture' });
    const begun = await materials.beginMaterial('C0000001', { id: 'm-ready', kind: 'pdf', title: 'Fixture slides' });
    expect(begun.status).toBe('processing');

    const done = await materials.completeMaterial('C0000001', 'm-ready', { pageCount: 3, passages });

    expect(done).toMatchObject({ status: 'ready', pageCount: 3, passageCount: 2 });
    expect(await materials.getReadyPassageIds('C0000001')).toEqual(['m-ready:0', 'm-ready:1']);
    expect(await materials.getReadyPassagesByIds('C0000001', ['m-ready:0', 'm-ready:1'])).toEqual([
      { id: 'm-ready:0', materialId: 'm-ready', materialTitle: 'Fixture slides', pageNumber: 1, text: passages[0]!.text },
      { id: 'm-ready:1', materialId: 'm-ready', materialTitle: 'Fixture slides', pageNumber: 2, text: passages[1]!.text }
    ]);
    const job = await content.getNextIndexJob();
    expect(job).toMatchObject({ operation: 'index_material_passage', sessionId: 'C0000001', passage: { id: 'm-ready:0', materialTitle: 'Fixture slides' } });
    // Reject a second completion so retries cannot duplicate passages
    await expect(materials.completeMaterial('C0000001', 'm-ready', { pageCount: 3, passages })).rejects.toBeInstanceOf(MaterialNotFoundError);
  });

  it('rolls back every passage and job when the commit fails part way', async () => {
    await rooms.createSession({ id: 'C0000002', title: 'Synthetic rollback fixture' });
    await materials.beginMaterial('C0000002', { id: 'm-rollback', kind: 'text', title: 'Fixture notes' });
    // Occupy the second passage ID so the batch insert fails after the transaction starts
    await prisma.talkMaterial.create({ data: { id: 'm-other', sessionId: 'C0000002', kind: 'text', title: 'Other', status: 'ready' } });
    await prisma.materialPassage.create({ data: { id: 'm-rollback:1', sessionId: 'C0000002', materialId: 'm-other', ordinal: 0, text: 'Fixture blocker' } });

    await expect(materials.completeMaterial('C0000002', 'm-rollback', { pageCount: null, passages })).rejects.toThrow();

    expect((await materials.listMaterials('C0000002')).find((m) => m.id === 'm-rollback')?.status).toBe('processing');
    expect(await prisma.materialPassage.count({ where: { materialId: 'm-rollback' } })).toBe(0);
    expect(await prisma.searchIndexJob.count({ where: { id: { startsWith: 'material:m-rollback' } } })).toBe(0);
  });

  it('marks a material without extractable text as empty and indexes nothing', async () => {
    await rooms.createSession({ id: 'C0000003', title: 'Synthetic empty fixture' });
    await materials.beginMaterial('C0000003', { id: 'm-empty', kind: 'pdf', title: 'Fixture scans' });

    const done = await materials.completeMaterial('C0000003', 'm-empty', { pageCount: 2, passages: [] });

    expect(done).toMatchObject({ status: 'empty', passageCount: 0, pageCount: 2 });
    expect(await materials.getReadyPassageIds('C0000003')).toEqual([]);
  });

  it('deletes passages and pending jobs, then queues removal of search documents', async () => {
    await rooms.createSession({ id: 'C0000004', title: 'Synthetic delete fixture' });
    await materials.beginMaterial('C0000004', { id: 'm-delete', kind: 'text', title: 'Fixture notes' });
    await materials.completeMaterial('C0000004', 'm-delete', { pageCount: null, passages });

    await materials.deleteMaterial('C0000004', 'm-delete');

    expect(await materials.listMaterials('C0000004')).toEqual([]);
    expect(await prisma.materialPassage.count({ where: { materialId: 'm-delete' } })).toBe(0);
    expect(await prisma.searchIndexJob.findMany({ where: { sessionId: 'C0000004' }, select: { operation: true, materialId: true } }))
      .toEqual([{ operation: 'delete_material', materialId: 'm-delete' }]);
    await expect(materials.deleteMaterial('C0000004', 'm-delete')).rejects.toBeInstanceOf(MaterialNotFoundError);
  });

  it('keeps each room limited to its own ready passages', async () => {
    await rooms.createSession({ id: 'C0000005', title: 'Synthetic room A' });
    await rooms.createSession({ id: 'C0000006', title: 'Synthetic room B' });
    await materials.beginMaterial('C0000005', { id: 'm-a', kind: 'text', title: 'Fixture A' });
    await materials.completeMaterial('C0000005', 'm-a', { pageCount: null, passages: [passages[0]!] });
    await materials.beginMaterial('C0000006', { id: 'm-b', kind: 'text', title: 'Fixture B' });
    await materials.completeMaterial('C0000006', 'm-b', { pageCount: null, passages: [passages[1]!] });

    expect(await materials.getReadyPassageIds('C0000005')).toEqual(['m-a:0']);
    // Ignore another room's passage IDs even when they are requested directly
    expect((await materials.getReadyPassagesByIds('C0000005', ['m-a:0', 'm-b:0'])).map((p) => p.id)).toEqual(['m-a:0']);
    await expect(materials.deleteMaterial('C0000005', 'm-b')).rejects.toBeInstanceOf(MaterialNotFoundError);
    await expect(materials.completeMaterial('C0000005', 'm-b', { pageCount: null, passages })).rejects.toBeInstanceOf(MaterialNotFoundError);
  });

  it('fails interrupted processing and rejects unknown rooms', async () => {
    await rooms.createSession({ id: 'C0000007', title: 'Synthetic restart fixture' });
    await materials.beginMaterial('C0000007', { id: 'm-interrupted', kind: 'pdf', title: 'Fixture upload' });

    await materials.failInterruptedMaterials();

    expect((await materials.listMaterials('C0000007'))[0]?.status).toBe('failed');
    await expect(materials.listMaterials('FFFFFFFF')).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(materials.beginMaterial('FFFFFFFF', { id: 'm-x', kind: 'text', title: 'X' })).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});
