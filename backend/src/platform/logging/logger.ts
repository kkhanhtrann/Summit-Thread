import { logs, SeverityNumber } from '@opentelemetry/api';
import { Writable } from 'node:stream';
import pino from 'pino';

// Allow only operational values into telemetry and exclude request content
const safeAttributeNames = [
  'service',
  'event',
  'method',
  'route',
  'statusCode',
  'durationMs',
  'errorType',
  'host',
  'port'
] as const;

// Export one allowlisted Pino record to OpenTelemetry
const otelLogger = logs.getLogger('summit-thread-backend');
// Copy only allowlisted fields into the OpenTelemetry log record
const otelLogStream = new Writable({
  write(chunk, _encoding, callback) {
    try {
      const record = JSON.parse(chunk.toString()) as Record<string, unknown>;
      const attributes: Record<string, string | number | boolean> = {};

      for (const name of safeAttributeNames) {
        const value = record[name];
        if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
          attributes[name] = value;
        }
      }

      const level = typeof record.level === 'number' ? record.level : 30;
      otelLogger.emit({
        body: typeof record.event === 'string' ? record.event : 'backend_log',
        severityNumber: level >= 60 ? SeverityNumber.FATAL
          : level >= 50 ? SeverityNumber.ERROR
            : level >= 40 ? SeverityNumber.WARN
              : level >= 30 ? SeverityNumber.INFO
                : level >= 20 ? SeverityNumber.DEBUG
                  : SeverityNumber.TRACE,
        severityText: level >= 60 ? 'FATAL'
          : level >= 50 ? 'ERROR'
            : level >= 40 ? 'WARN'
              : level >= 30 ? 'INFO'
                : level >= 20 ? 'DEBUG'
                  : 'TRACE',
        attributes
      });
    } catch {
      // Drop malformed telemetry records while allowing local logging to continue
      callback();
      return;
    }

    callback();
  }
});

// Send structured logs locally and once through the privacy-filtered bridge
const streams = pino.multistream([
  { stream: process.stdout },
  { stream: otelLogStream }
]);

// Redact sensitive fields before writing structured logs
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'summit-thread-backend' },
  redact: {
    paths: [
      'req.headers.authorization',
      'headers.authorization',
      'authorization',
      'Authorization',
      'token',
      'authToken',
      'apiKey',
      'api_key',
      'GEMINI_API_KEY',
      'DASH0_BACKEND_TOKEN',
      'DATABASE_URL',
      'question',
      'privateQuestion',
      'transcript',
      'caption',
      'captionText',
      'body',
      'audio'
    ],
    censor: '[redacted]'
  }
}, streams);
