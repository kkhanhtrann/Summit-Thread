import { createGoogleGenerativeAI } from '@ai-sdk/google';

import { env } from '../../config/env';

// Describe backend-only Gemini model and credential overrides
export interface GeminiProviderConfiguration {
  apiKey?: string;
  textModel?: string;
}

// Signal that a Gemini provider cannot run without a server key
export class GeminiConfigurationError extends Error {
  constructor() {
    super('GEMINI_API_KEY is required before using a Gemini provider');
    this.name = 'GeminiConfigurationError';
  }
}

// Create the backend text-generation client from one Gemini key
export function createGeminiProviders(configuration: GeminiProviderConfiguration = {}) {
  const apiKey = (configuration.apiKey ?? env.GEMINI_API_KEY)?.trim();
  if (!apiKey) throw new GeminiConfigurationError();

  const textModel = configuration.textModel?.trim() || env.GEMINI_TEXT_MODEL;
  const google = createGoogleGenerativeAI({ apiKey });
  return { textModel: google(textModel) };
}
