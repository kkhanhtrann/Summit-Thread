import 'dotenv/config';

import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { env } from '../../config/env';

// Attach the ingest-only credential to backend telemetry exporters
const authorizationHeaders = env.DASH0_BACKEND_TOKEN
  ? {
      Authorization: `Bearer ${env.DASH0_BACKEND_TOKEN}`,
      'Dash0-Dataset': env.DASH0_DATASET
    }
  : undefined;

// Enable Dash0 export only when local backend credentials are configured
const sdk = authorizationHeaders
  ? new NodeSDK({
      resource: resourceFromAttributes({
        'service.name': 'summit-thread-backend',
        'deployment.environment.name': env.NODE_ENV
      }),
      traceExporter: new OTLPTraceExporter({
        url: `${env.DASH0_OTLP_ENDPOINT}/v1/traces`,
        headers: authorizationHeaders
      }),
      metricReaders: [new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${env.DASH0_OTLP_ENDPOINT}/v1/metrics`,
          headers: authorizationHeaders
        }),
        exportIntervalMillis: 15_000
      })],
      logRecordProcessors: [new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: `${env.DASH0_OTLP_ENDPOINT}/v1/logs`,
          headers: authorizationHeaders
        })
      })],
      instrumentations: [
        getNodeAutoInstrumentations({
          // Use the allowlisted logger bridge instead of automatic Pino export
          '@opentelemetry/instrumentation-pino': { enabled: false },
          '@opentelemetry/instrumentation-http': {
            requestHook: (span, request) => {
              const requestUrl = 'url' in request && typeof request.url === 'string' ? request.url : undefined;
              if (!requestUrl) return;

              // Remove search text from every HTTP span attribute
              const cleanUrl = new URL(requestUrl, 'http://localhost');
              const hasQuery = cleanUrl.search.length > 0;
              cleanUrl.search = '';
              span.setAttribute('url.full', cleanUrl.toString());
              span.setAttribute('http.url', cleanUrl.toString());
              span.setAttribute('http.target', cleanUrl.pathname);
              if (hasQuery) span.setAttribute('url.query', 'REDACTED');
            }
          }
        })
      ]
    })
  : undefined;

// Register instrumentations before the application entry point is imported
sdk?.start();

// Flush telemetry exporters during graceful shutdown
export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
}
