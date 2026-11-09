import { z } from 'zod';

// Bound presenter-provided context before it reaches extraction, storage, or search
export const MATERIAL_LIMITS = {
  titleMaxLength: 100,
  textMaxLength: 50_000,
  pdfMaxBytes: 25 * 1024 * 1024,
  pdfMaxPages: 300,
  passageMaxLength: 1_200
} as const;

// Validate a pasted-notes material before it is stored
export const createTextMaterialSchema = z
  .object({
    title: z.string().trim().min(1).max(MATERIAL_LIMITS.titleMaxLength),
    text: z.string().trim().min(1).max(MATERIAL_LIMITS.textMaxLength)
  })
  .strict();

// Validate the display title sent with a PDF upload
export const materialTitleSchema = z.string().trim().min(1).max(MATERIAL_LIMITS.titleMaxLength);

// Describe the request for adding pasted notes
export type CreateTextMaterialRequest = z.infer<typeof createTextMaterialSchema>;

// Describe the presenter-visible state of one material without its text
export interface MaterialView {
  id: string;
  kind: 'text' | 'pdf';
  title: string;
  status: 'processing' | 'ready' | 'empty' | 'failed';
  pageCount: number | null;
  passageCount: number;
  createdAt: string;
}

// Describe one extracted passage before it is stored with a stable ID
export interface ExtractedPassage {
  pageNumber: number | null;
  text: string;
}

// Describe one stored, ready passage used by retrieval and topic background
export interface MaterialPassageView {
  id: string;
  materialId: string;
  materialTitle: string;
  pageNumber: number | null;
  text: string;
}

// Signal that a material exceeds the supported size or page count
export class MaterialTooLargeError extends Error {
  constructor() {
    super('The material is too large');
    this.name = 'MaterialTooLargeError';
  }
}

// Signal that an upload is not a readable PDF
export class MaterialUnreadableError extends Error {
  constructor() {
    super('The material could not be read');
    this.name = 'MaterialUnreadableError';
  }
}

// Signal that the requested material does not belong to the room
export class MaterialNotFoundError extends Error {
  constructor() {
    super('Material not found');
    this.name = 'MaterialNotFoundError';
  }
}
