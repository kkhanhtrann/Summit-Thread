import { Router, type Response } from 'express';
import { z } from 'zod';

import {
  LiveWindowOrderError,
  VisualClipTooLargeError,
  VisualImageUnavailableError,
  VisualMomentNotFoundError,
  VisualSourceNotReadyError
} from '../contracts/visualMoment.contract';
import type { VisualMomentService } from '../application/visualMomentService';

// Validate room codes and stable moment IDs before they reach storage lookups
const sessionIdSchema = z.string().regex(/^[A-Za-z0-9]{8}$/).transform((value) => value.toUpperCase());
const momentIdSchema = z.string().regex(/^moment-\d{4}$/);
const liveWindowIndexSchema = z.coerce.number().int().min(0).max(9_999);
// Accept only browser-recorded live clip formats
const liveClipTypes = new Set(['video/webm', 'video/mp4', 'video/quicktime']);
// Mirror the local clip byte limit so oversized uploads fail before streaming
const MAX_LIVE_CLIP_BYTES = 200 * 1024 * 1024;

// Define the service operations exposed through the visual-moment HTTP boundary
export type VisualMomentRoutesPort = Pick<VisualMomentService, 'getReleasedImage' | 'submitLiveWindow'>;

// Map known errors to safe status codes and fixed messages without paths or provider text
function sendSafeError(response: Response, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof VisualMomentNotFoundError) response.status(404).json({ error: 'Visual moment not found' });
  else if (error instanceof VisualImageUnavailableError) response.status(404).json({ error: 'Image unavailable' });
  else if (error instanceof VisualSourceNotReadyError) response.status(409).json({ error: 'The room source is not ready for visual review' });
  else if (error instanceof LiveWindowOrderError) response.status(409).json({ error: 'Live clips must be submitted in capture order' });
  else if (error instanceof VisualClipTooLargeError) response.status(413).json({ error: 'The live clip is too large' });
  else if (error instanceof RangeError) response.status(400).json({ error: 'The live clip request is invalid' });
  else response.status(500).json({ error: 'Visual review is temporarily unavailable' });
}

// Serve released stills and accept completed live clips; handlers validate and delegate only
export function createVisualMomentRouter(service: VisualMomentRoutesPort): Router {
  const router = Router();

  router.get('/:sessionId/visual-moments/:momentId/image', async (request, response) => {
    const sessionId = sessionIdSchema.safeParse(request.params.sessionId);
    const momentId = momentIdSchema.safeParse(request.params.momentId);
    if (!sessionId.success || !momentId.success) {
      response.status(404).json({ error: 'Visual moment not found' });
      return;
    }
    try {
      const image = await service.getReleasedImage(sessionId.data, momentId.data);
      // Released stills never change, but stay private to the browser cache
      response.sendFile(image.path, {
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
        // Allow the ignored .data storage root; the path is built from validated IDs, never from the request
        dotfiles: 'allow'
      }, (error) => {
        if (error) sendSafeError(response, new VisualImageUnavailableError());
      });
    } catch (error) {
      sendSafeError(response, error);
    }
  });

  router.post('/:sessionId/recording/live/windows/:index', async (request, response) => {
    const sessionId = sessionIdSchema.safeParse(request.params.sessionId);
    const index = liveWindowIndexSchema.safeParse(request.params.index);
    const mimeType = (request.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
    if (!sessionId.success || !index.success || !liveClipTypes.has(mimeType)) {
      response.status(400).json({ error: 'The live clip request is invalid' });
      return;
    }
    if (Number(request.headers['content-length'] ?? 0) > MAX_LIVE_CLIP_BYTES) {
      response.status(413).json({ error: 'The live clip is too large' });
      return;
    }
    try {
      const recording = await service.submitLiveWindow(sessionId.data, index.data, mimeType, request);
      response.status(202).json({ recording });
    } catch (error) {
      sendSafeError(response, error);
    }
  });

  return router;
}
