import { Router, type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';

import {
  MATERIAL_LIMITS,
  MaterialNotFoundError,
  MaterialTooLargeError,
  MaterialUnreadableError
} from '../contracts/material.contract';
import { SessionNotFoundError, roomCodeSchema } from '../contracts/session.contract';
import type { MaterialRouteService } from '../application/materialService';

// Map known material failures to safe presenter-facing responses
function respondWithError(error: unknown, response: Response, next: NextFunction): void {
  if (error instanceof ZodError) {
    response.status(400).json({ error: 'Add a title up to 100 characters and text up to 50,000 characters' });
  } else if (error instanceof MaterialTooLargeError) {
    response.status(413).json({ error: 'Choose a PDF up to 25 MiB and 300 pages' });
  } else if (error instanceof MaterialUnreadableError) {
    response.status(422).json({ error: 'The PDF could not be read. Export it again or paste its text instead' });
  } else if (error instanceof MaterialNotFoundError) {
    response.status(404).json({ error: 'Material not found' });
  } else if (error instanceof SessionNotFoundError) {
    response.status(404).json({ error: 'Room not found. Check the invitation code' });
  } else {
    next(error);
  }
}

// Run an async handler and answer material errors without the shared handler
function handle(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch((error: unknown) => respondWithError(error, response, next));
  };
}

// Collect a PDF body while enforcing the byte limit before buffering more data
function readPdfBody(request: Request): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MATERIAL_LIMITS.pdfMaxBytes) {
        request.pause();
        reject(new MaterialTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    request.on('error', () => reject(new MaterialUnreadableError()));
  });
}

// Compose presenter material intake, listing, and removal endpoints
export function createMaterialRouter(service: MaterialRouteService): Router {
  const router = Router();
  router.use('/:sessionId/materials', (_request, response, next) => {
    response.setHeader('Cache-Control', 'private, no-store');
    next();
  });
  router.param('sessionId', (request, response, next, code: string) => {
    const parsed = roomCodeSchema.safeParse(code);
    if (!parsed.success) {
      response.status(400).json({ error: 'Enter an eight-character room code' });
      return;
    }
    request.params.sessionId = parsed.data;
    next();
  });

  router.get('/:sessionId/materials', handle(async (request, response) => {
    response.json({ materials: await service.list(request.params.sessionId as string) });
  }));

  router.post('/:sessionId/materials', handle(async (request, response) => {
    response.status(201).json({ material: await service.addText(request.params.sessionId as string, request.body) });
  }));

  router.post('/:sessionId/materials/pdf', handle(async (request, response) => {
    if (!request.is('application/pdf')) {
      response.status(415).json({ error: 'Choose a PDF file' });
      return;
    }
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > MATERIAL_LIMITS.pdfMaxBytes) throw new MaterialTooLargeError();
    let title: string;
    try {
      // Accept non-ASCII file names that the browser percent-encodes in the header
      title = decodeURIComponent(String(request.headers['x-material-title'] ?? ''));
    } catch {
      title = '';
    }
    const bytes = await readPdfBody(request);
    response.status(201).json({ material: await service.addPdf(request.params.sessionId as string, title, bytes) });
  }));

  router.delete('/:sessionId/materials/:materialId', handle(async (request, response) => {
    await service.remove(request.params.sessionId as string, request.params.materialId as string);
    response.status(204).end();
  }));

  return router;
}
