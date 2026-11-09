import { logs, SeverityNumber } from '@opentelemetry/api';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor
} from '@opentelemetry/sdk-logs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { logger } from './logger';

describe('Pino telemetry export', () => {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })]
  });

  beforeAll(() => {
    logs.setGlobalLoggerProvider(provider);
  });

  afterAll(async () => {
    await provider.shutdown();
    logs.disable();
  });

  it('exports operational fields while excluding private content', () => {
    logger.info({
      event: 'http_request',
      method: 'GET',
      route: '/api/health/ready',
      statusCode: 200,
      durationMs: 12,
      question: 'private question sentinel',
      transcript: 'private transcript sentinel',
      token: 'private token sentinel'
    });

    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const record = records[0];

    expect(record?.severityNumber).toBe(SeverityNumber.INFO);
    expect(record?.body).toBe('http_request');
    expect(record?.attributes).toMatchObject({
      service: 'summit-thread-backend',
      event: 'http_request',
      method: 'GET',
      route: '/api/health/ready',
      statusCode: 200,
      durationMs: 12
    });
    expect(record?.attributes).not.toHaveProperty('question');
    expect(record?.attributes).not.toHaveProperty('transcript');
    expect(record?.attributes).not.toHaveProperty('token');
  });
});
