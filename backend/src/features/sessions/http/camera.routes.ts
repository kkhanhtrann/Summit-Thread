import { Router } from 'express';
import { z } from 'zod';
import { roomCodeSchema } from '../contracts/session.contract';
import type { CameraService } from '../application/cameraService';

// Expose camera lifecycle actions without owning device capture or media transport
export function createCameraRouter(service: Pick<CameraService, 'startLiveCapture' | 'stopLiveCapture'>): Router {
  const router = Router();
  const startSchema = z.object({ analysisWindowMinutes: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(10)]) }).strict();
  router.post('/:sessionId/recording/live/start', async (req, res, next) => {
    try {
      const id = roomCodeSchema.parse(req.params.sessionId);
      const input = startSchema.parse(req.body);
      res.status(201).json({ recording: await service.startLiveCapture(id, input.analysisWindowMinutes) });
    } catch (error) { next(error); }
  });
  router.post('/:sessionId/recording/live/stop', async (req, res, next) => {
    try { res.json({ recording: await service.stopLiveCapture(roomCodeSchema.parse(req.params.sessionId)) }); }
    catch (error) { next(error); }
  });
  return router;
}
