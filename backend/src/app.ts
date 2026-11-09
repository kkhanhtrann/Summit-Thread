import express from 'express';
import helmet from 'helmet';
import { metrics, trace } from '@opentelemetry/api';
import { logger } from './platform/logging/logger';

// Compose health routes without exposing unfinished product handlers
export function createApp(checkDependencies?: () => Promise<void>) {
  const app = express();
  app.use(helmet());
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const started = performance.now();
    res.on('finish', () => {
      const route = req.route?.path ?? 'unmatched';
      logger.info({ event: 'http_request', method: req.method, route, statusCode: res.statusCode, durationMs: Math.round(performance.now() - started) });
      metrics.getMeter('summit-thread-backend').createCounter('foundation.http.requests').add(1, { route, statusCode: res.statusCode });
    });
    next();
  });
  app.get('/api/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/health/ready', async (_req, res) => {
    await trace.getTracer('summit-thread-backend').startActiveSpan('foundation.readiness', async (span) => {
      try {
        if (!checkDependencies) throw new Error('Dependencies not configured');
        await checkDependencies();
        res.json({ status: 'ready' });
      } catch {
        res.status(503).json({ status: 'unavailable' });
      } finally { span.end(); }
    });
  });
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}
