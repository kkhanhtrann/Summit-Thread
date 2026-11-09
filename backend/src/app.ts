import { createCameraRouter } from './features/sessions/http/camera.routes';
import type { CameraService } from './features/sessions/application/cameraService';
import express from 'express';
import helmet from 'helmet';
import { metrics, trace } from '@opentelemetry/api';
import { ZodError } from 'zod';
import {
  createSessionRouter,
  type SessionRouteService
} from './features/sessions/http/session.routes';
import {
  createPreparedRecordingRouter,
  type PreparedRecordingRouteService
} from './features/sessions/http/preparedRecording.routes';
import {
  createMaterialRouter,
  type MaterialRouteService,
  createVisualMomentRouter,
  RecordingConflictError,
  RecordingNotReadyError,
  RecordingTooLargeError,
  RecordingUnsupportedTypeError,
  SessionNotFoundError,
  type VisualMomentService
} from './features/sessions/public';
import { createPrivateChatRouter, type PrivateChatRouteService } from './features/private-chat/public';
import type { ReleasedRoomContent } from './features/sessions/public';
import { SearchUnavailableError } from './features/sessions/public';
import { AiUnavailableError } from './platform/ai/aiUnavailableError';
import { logger } from './platform/logging/logger';

// Define optional feature services while keeping isolated health checks available
export interface ProductServices {
  sessions: SessionRouteService;
  recordings: PreparedRecordingRouteService;
}
// Describe private Ask ports without coupling them to media workflows
export interface PrivateAskHttpDependencies {
  service: PrivateChatRouteService;
  context(sessionId: string): Promise<ReleasedRoomContent>;
}
// Describe optional features composed by the server once their dependencies exist
export interface AppFeatures {
  camera?: Pick<CameraService, 'startLiveCapture' | 'stopLiveCapture'>;
  visualMoments?: Pick<VisualMomentService, 'getReleasedImage' | 'submitLiveWindow'>;
  materials?: MaterialRouteService;
}
// Compose validated product routes and operational health endpoints
export function createApp(
  checkDependencies?: () => Promise<void>,
  services?: ProductServices,
  privateAsk?: PrivateAskHttpDependencies,
  features: AppFeatures = {}
) {
  const app = express();
  app.use(helmet());
  app.disable('x-powered-by');
  // Allow pasted presenter notes a larger body while every other JSON route stays small
  const smallJson = express.json({ limit: '32kb', type: 'application/json' });
  const materialJson = express.json({ limit: '256kb', type: 'application/json' });
  app.use((req, res, next) => (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/materials\/?$/.test(req.path) ? materialJson : smallJson)(req, res, next));
  app.use((req, res, next) => {
    const started = performance.now();
    res.on('finish', () => {
      const route = req.route?.path ?? 'unmatched';
      logger.info({
        event: 'http_request',
        method: req.method,
        route,
        statusCode: res.statusCode,
        durationMs: Math.round(performance.now() - started)
      });
      metrics
        .getMeter('summit-thread-backend')
        .createCounter('foundation.http.requests')
        .add(1, { route, statusCode: res.statusCode });
    });
    next();
  });
  app.get('/api/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/health/ready', async (_req, res) => {
    await trace
      .getTracer('summit-thread-backend')
      .startActiveSpan('foundation.readiness', async (span) => {
        try {
          if (!checkDependencies)
            throw new Error('Dependencies not configured');
          await checkDependencies();
          res.json({ status: 'ready' });
        } catch {
          res.status(503).json({ status: 'unavailable' });
        } finally {
          span.end();
        }
      });
  });
  if (features.camera) app.use('/api/sessions', createCameraRouter(features.camera));
  // Mount material routes before shared routes; they answer their own errors
  if (features.materials) app.use('/api/sessions', createMaterialRouter(features.materials));
  // Mount visual routes first; they answer their own errors without the shared handler
  if (features.visualMoments) app.use('/api/sessions', createVisualMomentRouter(features.visualMoments));
  if (services) {
    app.use('/api/sessions', createSessionRouter(services.sessions));
    app.use(
      '/api/sessions',
      createPreparedRecordingRouter(services.recordings)
    );
  }
  if (privateAsk) {
    app.use(['/api/sessions/:sessionId/chat', '/api/sessions/:sessionId/ask-context'], (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    app.use('/api/sessions', createPrivateChatRouter(privateAsk.service));
    app.get('/api/sessions/:sessionId/ask-context', async (req, res, next) => {
      if (!/^[A-F0-9]{8}$/.test(req.params.sessionId)) { res.status(400).json({ error: 'Room code is invalid' }); return; }
      try { res.json(await privateAsk.context(req.params.sessionId)); } catch (error) { next(error); }
    });
  }
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status =
        error instanceof SessionNotFoundError
          ? 404
          : error instanceof RecordingConflictError ||
              error instanceof RecordingNotReadyError
            ? 409
            : error instanceof RecordingTooLargeError
              ? 413
              : error instanceof RecordingUnsupportedTypeError
                ? 415
                : error instanceof ZodError ||
                    error instanceof RangeError ||
                    error instanceof SyntaxError
                  ? 400
                  : 503;
      const messages: Record<number, string> = {
        400: 'Check the room, source file, or playback values and try again',
        404: 'Room not found. Check the invitation code',
        409: 'The source is not ready or can no longer be replaced. Retry or create a fresh room',
        413: 'Choose a recording no larger than 300 MiB',
        415: 'Choose a supported audio or video format',
        503: 'The service is temporarily unavailable. Try again'
      };
      logger.info({ event: 'room_request_failed', statusCode: status });
      const message = error instanceof AiUnavailableError ? 'Private Ask is temporarily unavailable'
        : error instanceof SearchUnavailableError ? 'Search is temporarily unavailable'
        : messages[status];
      res.status(status).json({ error: message });
    }
  );
  return app;
}
