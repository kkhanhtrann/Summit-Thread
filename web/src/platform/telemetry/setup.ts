import { init } from '@dash0/sdk-web';

import { scrubUrlAttributes } from '../../lib/telemetry/urlAttributeScrubber';

// Start browser telemetry without enabling session recording
export function setupBrowserTelemetry(): void {
  const authToken = import.meta.env.VITE_DASH0_BROWSER_TOKEN;
  if (!authToken) return;

  init({
    serviceName: 'summit-thread-web',
    endpoint: {
      url: import.meta.env.VITE_DASH0_OTLP_ENDPOINT || 'https://ingress.us-west-2.aws.dash0.com',
      authToken,
      dataset: import.meta.env.VITE_DASH0_DATASET || 'summit-thread'
    },
    enabledInstrumentations: ['@dash0/navigation', '@dash0/web-vitals', '@dash0/error', '@dash0/fetch', '@dash0/xhr'],
    urlAttributeScrubber: scrubUrlAttributes
  });
}
