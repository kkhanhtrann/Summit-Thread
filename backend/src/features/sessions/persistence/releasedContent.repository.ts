import type { PrismaClient } from '@prisma/client';
import { SessionNotFoundError } from '../contracts/session.contract';
import type { ReleasedRoomContent, CaptionIndexJob } from '../contracts/releasedContent';

// Read canonical released room content and retryable search work
export class ReleasedContentRepository {
  constructor(private readonly database: PrismaClient) {}

  // Read the release cursor and captions from one consistent database snapshot
  async getReleasedContent(id: string): Promise<ReleasedRoomContent> {
    return this.database.$transaction(async tx => {
      const room = await tx.conferenceSession.findUnique({ where: { id }, select: { id: true, title: true, releasedCount: true, suggestedQuestions: true } });
      if (!room) throw new SessionNotFoundError();
      const captions = await tx.captionSegment.findMany({
        where: { sessionId: id, sequence: { lt: room.releasedCount } }, orderBy: { sequence: 'asc' },
        select: { id: true, sequence: true, timestampMs: true, text: true }
      });
      return { session: { id: room.id, title: room.title }, captions, suggestedQuestions: room.suggestedQuestions.slice(0, 5) };
    }, { isolationLevel: 'RepeatableRead' });
  }

  // Read current committed caption and topic data rather than storing text in jobs
  async getNextIndexJob(): Promise<CaptionIndexJob | null> {
    const job = await this.database.searchIndexJob.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: {
      session: { select: { releasedCount: true } },
      caption: { include: { topicOccurrence: { include: { thread: true } } } },
      passage: { include: { material: { select: { title: true, status: true, sessionId: true } } } }
    } });
    if (!job) return null;
    const released = job.caption && job.caption.sessionId === job.sessionId && job.caption.sequence < job.session.releasedCount ? job.caption : null;
    // Index only passages of ready materials that still belong to the job's room
    const passage = job.passage && job.passage.sessionId === job.sessionId
      && job.passage.material.sessionId === job.sessionId && job.passage.material.status === 'ready' ? job.passage : null;
    return {
      id: job.id, operation: job.operation, sessionId: job.sessionId,
      caption: released ? { id: released.id, sequence: released.sequence, timestampMs: released.timestampMs, text: released.text } : null,
      topic: released?.topicOccurrence && released.topicOccurrence.sessionId === job.sessionId && released.topicOccurrence.thread.sessionId === job.sessionId
        ? { title: released.topicOccurrence.thread.title, summary: released.topicOccurrence.thread.summary } : null,
      passage: passage ? {
        id: passage.id, materialId: passage.materialId, materialTitle: passage.material.title,
        pageNumber: passage.pageNumber, text: passage.text
      } : null,
      materialId: job.materialId
    };
  }

  // Acknowledge only after the index write succeeds or invalid work is safely skipped
  async finishIndexJob(id: string): Promise<void> {
    await this.database.searchIndexJob.deleteMany({ where: { id } });
  }

  // Requeue committed released captions in bounded batches without media processing
  async enqueueRebuild(): Promise<number> {
    let cursor = '';
    let count = 0;
    while (true) {
      const batch = await this.database.$queryRaw<Array<{ id: string; sessionId: string }>>`
        SELECT c.id, c."sessionId" FROM "CaptionSegment" c
        JOIN "ConferenceSession" s ON s.id = c."sessionId"
        WHERE c.sequence < s."releasedCount" AND c.id > ${cursor}
        ORDER BY c.id LIMIT 200`;
      if (!batch.length) return count + await this.enqueueMaterialRebuild();
      await this.database.searchIndexJob.createMany({ data: batch.map(c => ({ id: `rebuild:${c.id}`, sessionId: c.sessionId, captionId: c.id, operation: 'index_caption' as const })), skipDuplicates: true });
      cursor = batch[batch.length - 1]!.id;
      count += batch.length;
    }
  }

  // Requeue ready presenter material passages so search can be rebuilt from PostgreSQL
  private async enqueueMaterialRebuild(): Promise<number> {
    let cursor = '';
    let count = 0;
    while (true) {
      const batch = await this.database.materialPassage.findMany({
        where: { id: { gt: cursor }, material: { status: 'ready' } },
        orderBy: { id: 'asc' }, take: 200, select: { id: true, sessionId: true }
      });
      if (!batch.length) return count;
      await this.database.searchIndexJob.createMany({ data: batch.map(p => ({ id: `rebuild:${p.id}`, sessionId: p.sessionId, passageId: p.id, operation: 'index_material_passage' as const })), skipDuplicates: true });
      cursor = batch[batch.length - 1]!.id;
      count += batch.length;
    }
  }
}
