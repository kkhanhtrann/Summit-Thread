import type { PrismaClient, TalkMaterial } from '@prisma/client';

import {
  MaterialNotFoundError,
  type ExtractedPassage,
  type MaterialPassageView,
  type MaterialView
} from '../contracts/material.contract';
import { SessionNotFoundError } from '../contracts/session.contract';
import type { MaterialRepository } from '../application/materialService';
import { lockRoom } from './prismaRoomRepository';

// Map a stored material to its presenter-visible state without text
function materialView(material: TalkMaterial): MaterialView {
  return {
    id: material.id,
    kind: material.kind,
    title: material.title,
    status: material.status,
    pageCount: material.pageCount,
    passageCount: material.passageCount,
    createdAt: material.createdAt.toISOString()
  };
}

// Store presenter materials and their passages with repeat-safe indexing work
export class PrismaMaterialRepository implements MaterialRepository {
  constructor(private readonly database: PrismaClient) {}

  // Create a processing row under the room lock so the room must exist
  async beginMaterial(sessionId: string, material: { id: string; kind: MaterialView['kind']; title: string }): Promise<MaterialView> {
    return this.database.$transaction(async (tx) => {
      await lockRoom(tx, sessionId);
      return materialView(await tx.talkMaterial.create({ data: { ...material, sessionId } }));
    });
  }

  // Commit every passage, its index job, and the final status atomically
  // Use ready when text exists and empty when extraction found none
  async completeMaterial(
    sessionId: string,
    materialId: string,
    result: { pageCount: number | null; passages: ExtractedPassage[] }
  ): Promise<MaterialView> {
    return this.database.$transaction(async (tx) => {
      await lockRoom(tx, sessionId);
      const current = await tx.talkMaterial.findFirst({ where: { id: materialId, sessionId, status: 'processing' } });
      if (!current) throw new MaterialNotFoundError();
      const passages = result.passages.map((passage, ordinal) => ({
        id: `${materialId}:${ordinal}`,
        sessionId,
        materialId,
        ordinal,
        pageNumber: passage.pageNumber,
        text: passage.text
      }));
      if (passages.length) {
        await tx.materialPassage.createMany({ data: passages });
        await tx.searchIndexJob.createMany({
          data: passages.map((passage) => ({
            id: `material:${passage.id}`,
            operation: 'index_material_passage' as const,
            sessionId,
            passageId: passage.id
          })),
          skipDuplicates: true
        });
      }
      return materialView(await tx.talkMaterial.update({
        where: { id: materialId },
        data: {
          status: passages.length ? 'ready' : 'empty',
          pageCount: result.pageCount,
          passageCount: passages.length
        }
      }));
    });
  }

  // Leave a failed row visible until the presenter removes it
  async failMaterial(sessionId: string, materialId: string): Promise<void> {
    await this.database.talkMaterial.updateMany({
      where: { id: materialId, sessionId, status: 'processing' },
      data: { status: 'failed' }
    });
  }

  // List a room's materials, newest first, after checking the room exists
  async listMaterials(sessionId: string): Promise<MaterialView[]> {
    const room = await this.database.conferenceSession.findUnique({ where: { id: sessionId }, select: { id: true } });
    if (!room) throw new SessionNotFoundError();
    const materials = await this.database.talkMaterial.findMany({ where: { sessionId }, orderBy: { createdAt: 'desc' } });
    return materials.map(materialView);
  }

  // Delete passages through the cascade and queue removal of their search documents
  async deleteMaterial(sessionId: string, materialId: string): Promise<void> {
    await this.database.$transaction(async (tx) => {
      await lockRoom(tx, sessionId);
      const deleted = await tx.talkMaterial.deleteMany({ where: { id: materialId, sessionId } });
      if (deleted.count !== 1) throw new MaterialNotFoundError();
      await tx.searchIndexJob.upsert({
        where: { id: `delete-material:${materialId}` },
        create: { id: `delete-material:${materialId}`, operation: 'delete_material', sessionId, materialId },
        update: {}
      });
    });
  }

  // Mark materials left processing by a restart as failed
  async failInterruptedMaterials(): Promise<void> {
    await this.database.talkMaterial.updateMany({ where: { status: 'processing' }, data: { status: 'failed' } });
  }

  // Read every passage of the room's ready materials for retrieval allowlists
  async getReadyPassages(sessionId: string): Promise<MaterialPassageView[]> {
    const passages = await this.database.materialPassage.findMany({
      where: { sessionId, material: { status: 'ready', sessionId } },
      orderBy: [{ materialId: 'asc' }, { ordinal: 'asc' }],
      include: { material: { select: { title: true } } }
    });
    return passages.map((passage) => ({
      id: passage.id,
      materialId: passage.materialId,
      materialTitle: passage.material.title,
      pageNumber: passage.pageNumber,
      text: passage.text
    }));
  }
}
