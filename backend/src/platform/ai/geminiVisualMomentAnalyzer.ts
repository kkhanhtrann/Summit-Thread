import { z } from 'zod';

// Limit each isolated window to one useful still
const MAX_WINDOW_MOMENTS = 1;
// Bound provider file-processing polls before the attempt fails
const FILE_POLL_INTERVAL_MS = 1_000;
const MAX_FILE_POLL_ATTEMPTS = 60;
// Bound each provider HTTP call so a stalled request becomes a retryable timeout
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

// Name fixed provider failure categories that never include raw provider text
export type VisualProviderFailureCategory =
  | 'not_configured'
  | 'provider_rejected'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'invalid_output';

// Signal a failed visual provider attempt with only a content-free category
export class VisualProviderError extends Error {
  constructor(readonly category: VisualProviderFailureCategory) {
    super(`Visual analysis failed (${category})`);
    this.name = 'VisualProviderError';
  }
}

// Describe one window-relative suggestion returned to the application service
export interface VisualWindowSuggestion {
  offsetMs: number;
  title: string;
  description: string;
}

interface UploadedFile {
  name?: string;
  uri?: string;
  state?: string;
}

// Expose only the SDK calls this adapter uses so tests can supply deterministic fixtures
export interface GeminiVisualClient {
  files: {
    upload(parameters: { file: string; config: { mimeType: string } }): Promise<UploadedFile>;
    get(parameters: { name: string }): Promise<UploadedFile>;
    delete(parameters: { name: string }): Promise<unknown>;
  };
  models: {
    generateContent(parameters: { model: string; contents: unknown; config: Record<string, unknown> }): Promise<{ text?: string | undefined }>;
  };
}

// Allow focused tests to replace the SDK client and polling delay
export interface GeminiVisualAnalyzerDependencies {
  createClient(apiKey: string, requestTimeoutMs: number): Promise<GeminiVisualClient>;
  sleep(milliseconds: number): Promise<void>;
}

// Validate the bounded structured response before any value reaches the application
const responseSchema = z.object({
  moments: z.array(z.object({
    offsetMs: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(280)
  }).strict()).max(MAX_WINDOW_MOMENTS)
}).strict();

// Constrain Gemini output to the same bounded shape
const responseJsonSchema = {
  type: 'object',
  properties: {
    moments: {
      type: 'array',
      maxItems: MAX_WINDOW_MOMENTS,
      items: {
        type: 'object',
        properties: {
          offsetMs: { type: 'integer' },
          title: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['offsetMs', 'title', 'description'],
        additionalProperties: false
      }
    }
  },
  required: ['moments'],
  additionalProperties: false
};

// Ask for visible evidence only, with offsets relative to this isolated clip
const visualPrompt = (durationMs: number) => [
  `This is an isolated ${durationMs} millisecond excerpt of a conference recording.`,
  'Return a JSON object with a moments array containing zero or one item.',
  'Choose a frame only when a slide, diagram, demonstration, or other visible content adds useful context.',
  'Skip routine speaker shots and frames that add no new visible information.',
  `offsetMs is the integer millisecond offset from the start of this excerpt, at least 0 and less than ${durationMs}.`,
  'title is a short plain-language label of 2 to 6 words for what is on screen.',
  'description is one sentence under 25 words that serves as alternative text: describe what is visibly shown.',
  'Describe only visible content. Do not transcribe, quote, or infer speech. Do not invent visual details.',
  'Return an empty moments array when no frame is useful.'
].join(' ');

// Adapt the installed Google GenAI SDK to the small client surface used here
async function createDefaultClient(apiKey: string, requestTimeoutMs: number): Promise<GeminiVisualClient> {
  const { GoogleGenAI } = await import('@google/genai');
  const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: requestTimeoutMs } });
  return {
    files: {
      upload: async (parameters) => await client.files.upload(parameters),
      get: async (parameters) => await client.files.get(parameters),
      delete: async (parameters) => await client.files.delete(parameters)
    },
    models: {
      generateContent: async (parameters) => await client.models.generateContent(
        parameters as Parameters<typeof client.models.generateContent>[0]
      )
    }
  };
}

// Use the real SDK and timer outside tests
const defaultDependencies: GeminiVisualAnalyzerDependencies = {
  createClient: createDefaultClient,
  sleep: async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds))
};

// Reduce SDK errors to a fixed category using status codes and error names only
function categorize(error: unknown): VisualProviderFailureCategory {
  if (error instanceof VisualProviderError) return error.category;
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'invalid_output';
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  const status = typeof record.status === 'number' ? record.status : typeof record.code === 'number' ? record.code : undefined;
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504 || record.name === 'AbortError' || record.name === 'TimeoutError') return 'provider_timeout';
  if (status !== undefined && status >= 400 && status < 500) return 'provider_rejected';
  return 'provider_unavailable';
}

// Wait until the uploaded clip is readable or the bounded poll expires
async function waitForActiveFile(client: GeminiVisualClient, uploaded: UploadedFile, sleep: (milliseconds: number) => Promise<void>): Promise<{ uri: string }> {
  if (!uploaded.name) throw new VisualProviderError('provider_unavailable');
  let current = uploaded;
  for (let attempt = 0; attempt <= MAX_FILE_POLL_ATTEMPTS; attempt += 1) {
    if (current.state === 'ACTIVE') {
      const uri = current.uri ?? uploaded.uri;
      if (!uri) throw new VisualProviderError('provider_unavailable');
      return { uri };
    }
    if (current.state === 'FAILED') throw new VisualProviderError('provider_rejected');
    if (attempt === MAX_FILE_POLL_ATTEMPTS) break;
    await sleep(FILE_POLL_INTERVAL_MS);
    current = await client.files.get({ name: uploaded.name });
  }
  throw new VisualProviderError('provider_timeout');
}

// Inspect one isolated video clip and return at most one validated window-relative suggestion
// Always deletes the provider-side upload, even when validation or generation fails
export function createGeminiVisualMomentAnalyzer(
  options: { apiKey?: string | undefined; model: string; requestTimeoutMs?: number },
  dependencies: GeminiVisualAnalyzerDependencies = defaultDependencies
) {
  return {
    async analyzeWindow(input: { clipPath: string; mimeType: string; durationMs: number }): Promise<{ moments: VisualWindowSuggestion[] }> {
      // Audio-only input has no frames to review
      if (!input.mimeType.startsWith('video/')) return { moments: [] };
      const apiKey = options.apiKey?.trim();
      if (!apiKey || !options.model.trim()) throw new VisualProviderError('not_configured');
      if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) throw new VisualProviderError('invalid_output');

      let client: GeminiVisualClient | undefined;
      let uploadedName: string | undefined;
      try {
        client = await dependencies.createClient(apiKey, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
        const uploaded = await client.files.upload({ file: input.clipPath, config: { mimeType: input.mimeType } });
        uploadedName = uploaded.name;
        const active = await waitForActiveFile(client, uploaded, dependencies.sleep);
        const response = await client.models.generateContent({
          model: options.model,
          contents: [{
            role: 'user',
            parts: [
              { fileData: { fileUri: active.uri, mimeType: input.mimeType } },
              { text: visualPrompt(input.durationMs) }
            ]
          }],
          config: {
            responseMimeType: 'application/json',
            responseJsonSchema,
            temperature: 0,
            maxOutputTokens: 400
          }
        });
        if (typeof response.text !== 'string' || response.text.length === 0) throw new VisualProviderError('invalid_output');
        const parsed = responseSchema.parse(JSON.parse(response.text));
        return { moments: parsed.moments };
      } catch (error) {
        // Keep only the fixed category; provider messages may echo conference content
        throw new VisualProviderError(categorize(error));
      } finally {
        if (client && uploadedName) {
          const cleanupClient = client;
          const name = uploadedName;
          await cleanupClient.files.delete({ name }).catch(() => undefined);
        }
      }
    }
  };
}
