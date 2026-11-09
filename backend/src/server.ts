import { Client } from '@elastic/elasticsearch';
import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { logger } from './platform/logging/logger';
import { shutdownTelemetry } from './platform/telemetry/instrumentation';

// Wire infrastructure with bounded readiness probes
const search = new Client({ node: env.ELASTICSEARCH_URL, requestTimeout: 2000, maxRetries: 0 });
const app = createApp(async () => {
  await Promise.all([prisma.$queryRaw`SELECT 1`, search.ping()]);
});
const server = app.listen(env.API_PORT, env.API_HOST, () => logger.info({ event: 'server_started', host: env.API_HOST, port: env.API_PORT }));
let stopping = false;
// Stop HTTP traffic before flushing infrastructure and telemetry
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await Promise.all([prisma.$disconnect(), search.close()]);
    await shutdownTelemetry();
  });
  server.closeIdleConnections();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
