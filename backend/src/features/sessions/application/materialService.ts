import { randomUUID } from 'node:crypto';

import { metrics } from '@opentelemetry/api';

import {
  MATERIAL_LIMITS,
  MaterialTooLargeError,
  MaterialUnreadableError,
  createTextMaterialSchema,
  materialTitleSchema,
  type CreateTextMaterialRequest,
  type ExtractedPassage,
  type MaterialPassageView,
  type MaterialView
} from '../contracts/material.contract';
import { splitIntoPassages } from './materialPassages';

// Define material persistence owned by the sessions feature
export interface MaterialRepository {
  beginMaterial(sessionId: string, material: { id: string; kind: MaterialView['kind']; title: string }): Promise<MaterialView>;
  completeMaterial(sessionId: string, materialId: string, result: { pageCount: number | null; passages: ExtractedPassage[] }): Promise<MaterialView>;
  failMaterial(sessionId: string, materialId: string): Promise<void>;
  listMaterials(sessionId: string): Promise<MaterialView[]>;
  deleteMaterial(sessionId: string, materialId: string): Promise<void>;
  failInterruptedMaterials(): Promise<void>;
  getReadyPassages(sessionId: string): Promise<MaterialPassageView[]>;
}

// Describe page text read from an uploaded PDF
export type PdfTextExtractor = (bytes: Uint8Array) => Promise<{
  pageCount: number;
  pages: ExtractedPassage[];
}>;

// Describe the material operations exposed to HTTP
export interface MaterialRouteService {
  list(sessionId: string): Promise<MaterialView[]>;
  addText(sessionId: string, input: CreateTextMaterialRequest): Promise<MaterialView>;
  addPdf(sessionId: string, title: string, bytes: Uint8Array): Promise<MaterialView>;
  remove(sessionId: string, materialId: string): Promise<void>;
}

// Group material intake measurements using counts and fixed labels only
const materialMeter = metrics.getMeter('summit-thread.materials');
// Count intake outcomes by material kind and result
const intakeCount = materialMeter.createCounter('materials.intake', { unit: '{material}' });
// Record how many passages each ready material produced
const passageCount = materialMeter.createHistogram('materials.passage_count', { unit: '{passage}' });

// Accept presenter notes and PDFs, store bounded passages, and queue their indexing
export class MaterialService implements MaterialRouteService {
  constructor(private readonly dependencies: {
    repository: MaterialRepository;
    extractPdf: PdfTextExtractor;
    indexer: { wake(): void };
  }) {}

  // Mark materials interrupted by a restart as failed so presenters can retry
  initialize(): Promise<void> {
    return this.dependencies.repository.failInterruptedMaterials();
  }

  // List one room's materials without their text
  list(sessionId: string): Promise<MaterialView[]> {
    return this.dependencies.repository.listMaterials(sessionId);
  }

  // Store pasted notes as one or more passages without page numbers
  async addText(sessionId: string, input: CreateTextMaterialRequest): Promise<MaterialView> {
    const { title, text } = createTextMaterialSchema.parse(input);
    return this.store(sessionId, 'text', title, async () => ({
      pageCount: null,
      passages: splitIntoPassages([{ pageNumber: null, text }])
    }));
  }

  // Extract a PDF page by page; image-only documents become empty rather than failing
  async addPdf(sessionId: string, title: string, bytes: Uint8Array): Promise<MaterialView> {
    const parsedTitle = materialTitleSchema.parse(title);
    if (bytes.byteLength > MATERIAL_LIMITS.pdfMaxBytes) throw new MaterialTooLargeError();
    return this.store(sessionId, 'pdf', parsedTitle, async () => {
      const extracted = await this.dependencies.extractPdf(bytes);
      return { pageCount: extracted.pageCount, passages: splitIntoPassages(extracted.pages) };
    });
  }

  // Remove a material, its passages, and queue removal of its search documents
  async remove(sessionId: string, materialId: string): Promise<void> {
    await this.dependencies.repository.deleteMaterial(sessionId, materialId);
    this.dependencies.indexer.wake();
  }

  // Record a processing row first so interrupted or failed intake stays visible
  private async store(
    sessionId: string,
    kind: MaterialView['kind'],
    title: string,
    read: () => Promise<{ pageCount: number | null; passages: ExtractedPassage[] }>
  ): Promise<MaterialView> {
    const { repository } = this.dependencies;
    const material = await repository.beginMaterial(sessionId, { id: randomUUID(), kind, title });
    try {
      const result = await read();
      const completed = await repository.completeMaterial(sessionId, material.id, result);
      intakeCount.add(1, { kind, result: completed.status });
      passageCount.record(completed.passageCount, { kind });
      this.dependencies.indexer.wake();
      return completed;
    } catch (error) {
      await repository.failMaterial(sessionId, material.id).catch(() => undefined);
      intakeCount.add(1, {
        kind,
        result: error instanceof MaterialTooLargeError ? 'too_large' : error instanceof MaterialUnreadableError ? 'unreadable' : 'failed'
      });
      throw error;
    }
  }
}
