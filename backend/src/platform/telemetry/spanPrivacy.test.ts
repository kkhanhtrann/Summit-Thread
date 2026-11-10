import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { sanitizeSpanErrors } from './spanPrivacy';

describe('span error privacy', () => {
  it('removes raw exception payloads and status messages before export', () => {
    const span = {
      name: 'caption.index_job',
      events: [
        { name: 'exception', attributes: { 'exception.message': 'SYNTHETIC_PRIVATE_MARKER', 'exception.stacktrace': 'SYNTHETIC_PRIVATE_MARKER' } },
        { name: 'released', attributes: { count: 1 } }
      ],
      status: { code: 2, message: 'SYNTHETIC_PRIVATE_MARKER' }
    };
    const sanitized = sanitizeSpanErrors(span);
    expect(JSON.stringify(sanitized)).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    expect(sanitized.events).toEqual([{ name: 'released', attributes: { count: 1 } }]);
    expect(sanitized.status).toEqual({ code: 2 });
    expect(span.status.message).toBe('SYNTHETIC_PRIVATE_MARKER');
  });

  it('exports a real SDK span without losing methods, metadata, or privacy', async () => {
    let body = '';
    const collector = createServer(async (request, response) => {
      for await (const chunk of request) body += chunk.toString();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
    await new Promise<void>(resolve => collector.listen(0, '127.0.0.1', resolve));
    const address = collector.address();
    if (!address || typeof address === 'string') throw new Error('Missing test collector port');
    const exporter = new OTLPTraceExporter({ url: `http://127.0.0.1:${address.port}/v1/traces`, timeoutMillis: 1_000 });
    const spans: Parameters<OTLPTraceExporter['export']>[0] = [];
    const sdk = new NodeSDK({
      autoDetectResources: false,
      metricReaders: [],
      logRecordProcessors: [],
      spanProcessors: [{
        onStart() {},
        onEnd(span) { spans.push(span); },
        async forceFlush() {},
        async shutdown() {}
      }]
    });
    sdk.start();
    try {
      const span = trace.getTracer('synthetic-privacy-test').startSpan('synthetic.export');
      span.recordException(new Error('SYNTHETIC_PRIVATE_MARKER'));
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'SYNTHETIC_PRIVATE_MARKER' });
      span.addEvent('released', { count: 1 });
      span.end();
      expect(spans).toHaveLength(1);
      const original = spans[0]!;
      const sanitized = sanitizeSpanErrors(original);
      expect(sanitized.spanContext()).toEqual(original.spanContext());
      expect(sanitized.duration).toEqual(original.duration);
      expect(sanitized.ended).toBe(true);
      expect(sanitized.droppedEventsCount).toBe(original.droppedEventsCount);
      await new Promise<void>((resolve, reject) => {
        exporter.export([sanitized], result => result.code === 0 ? resolve() : reject(result.error));
      });
      const exported = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans[0];
      expect(exported.name).toBe('synthetic.export');
      expect(exported.traceId).toBe(original.spanContext().traceId);
      expect(exported.status).toEqual({ code: SpanStatusCode.ERROR });
      expect(exported.events.map((event: { name: string }) => event.name)).toEqual(['released']);
      expect(body).not.toContain('SYNTHETIC_PRIVATE_MARKER');
      expect(original.status.message).toBe('SYNTHETIC_PRIVATE_MARKER');
      expect(original.events.some(event => event.name === 'exception')).toBe(true);
    } finally {
      await exporter.shutdown();
      await sdk.shutdown();
      trace.disable();
      await new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve()));
    }
  });
});
