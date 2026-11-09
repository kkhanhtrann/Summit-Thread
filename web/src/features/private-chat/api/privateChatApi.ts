import type { components } from '../../../lib/api/generated';
import { requestJson } from '../../../lib/api/http';

// Describe the backend-owned private question request
export type PrivateChatRequest = components['schemas']['PrivateChatRequest'];
// Describe the grounded answer and timestamp citations returned by the API
export type PrivateChatResponse = components['schemas']['PrivateChatResponse'];

// Send one question to the selected room's backend chat feature
export function askPrivateQuestion(sessionId: string, request: PrivateChatRequest, signal?: AbortSignal): Promise<PrivateChatResponse> {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
}

// Describe released room context without private conversation state
export type PrivateAskContext = components['schemas']['PrivateAskContext'];

// Read the room's released passages and available suggestions
export function getPrivateAskContext(sessionId: string, signal?: AbortSignal): Promise<PrivateAskContext> {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/ask-context`, { signal, cache: 'no-store' });
}
