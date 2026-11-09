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
  createVisualMomentRouter,
  RecordingConflictError,
  RecordingNotReadyError,
  RecordingTooLargeError,
  RecordingUnsupportedTypeError,
  SessionNotFoundError,
  type VisualMomentService
} from './features/sessions/public';
import { logger } from './platform/logging/logger';

// Define optional feature services while keeping isolated health checks available
export interface ProductServices {
  sessions: SessionRouteService;
  recordings: PreparedRecordingRouteService;
}
// Describe optional features composed by the server once their dependencies exist
export interface AppFeatures {
  visualMoments?: Pick<VisualMomentService, 'getReleasedImage' | 'submitLiveWindow'>;
}
// Compose validated product routes and operational health endpoints
export function createApp(
  checkDependencies?: () => Promise<void>,
  services?: ProductServices,
  features: AppFeatures = {}
) {
  const app = express();
  app.use(helmet());
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb', type: 'application/json' }));
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
  // Mount visual routes first; they answer their own errors without the shared handler
  if (features.visualMoments) app.use('/api/sessions', createVisualMomentRouter(features.visualMoments));
  if (services) {
    app.use('/api/sessions', createSessionRouter(services.sessions));
    app.use(
      '/api/sessions',
      createPreparedRecordingRouter(services.recordings)
    );
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
      res.status(status).json({ error: messages[status] });
    }
  );
  return app;
}
