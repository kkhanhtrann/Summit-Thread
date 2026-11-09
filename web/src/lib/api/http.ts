// Send typed API requests and surface safe backend error messages
export async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');

  const response = await fetch(input, {
    ...init,
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
    headers
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  if (!response.ok) {
    const error = new Error(
      payload?.error ?? 'The request could not be completed'
    ) as Error & { statusCode: number };
    error.statusCode = response.status;
    throw error;
  }
  return payload as T;
}

// Upload one media blob with shared request headers and byte progress
export function uploadBinary<T>(
  url: string,
  media: Blob,
  onProgress: (ratio: number) => void,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', url);
    request.timeout = 120_000;
    const cancel = () => request.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    request.onloadend = () => signal?.removeEventListener('abort', cancel);
    request.ontimeout = () =>
      reject(
        new Error('The upload timed out. Check the connection and retry.')
      );
    if (signal?.aborted) {
      reject(new Error('The upload was cancelled.'));
      return;
    }
    request.setRequestHeader('Accept', 'application/json');
    request.setRequestHeader('Content-Type', media.type);
    for (const [name, value] of Object.entries(extraHeaders))
      request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onerror = () =>
      reject(
        new Error(
          'The recording could not be uploaded. Check the connection and try again.'
        )
      );
    request.onabort = () =>
      reject(new Error('The recording upload was cancelled.'));
    request.onload = () => {
      let payload: { error?: string } | null = null;
      try {
        payload = JSON.parse(request.responseText) as { error?: string };
      } catch {
        payload = null;
      }
      if (request.status < 200 || request.status >= 300) {
        reject(
          new Error(
            payload?.error ?? 'The recording could not be uploaded. Try again.'
          )
        );
        return;
      }
      onProgress(1);
      resolve(payload as T);
    };
    request.send(media);
  });
}

// Reconnect to revisioned events and close the stream when its room view unmounts
export function openJsonEventStream<T extends { type: string }>(
  url: string,
  eventNames: readonly T['type'][],
  onEvent: (event: T) => void,
  onConnectionChange: (connected: boolean) => void
): () => void {
  const stream = new EventSource(url);
  stream.onopen = () => onConnectionChange(true);
  stream.onerror = () => onConnectionChange(false);

  for (const eventName of eventNames) {
    stream.addEventListener(eventName, (event) => {
      try {
        onEvent(JSON.parse((event as MessageEvent<string>).data) as T);
      } catch {
        onConnectionChange(false);
      }
    });
  }

  return () => stream.close();
}
