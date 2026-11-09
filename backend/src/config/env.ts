import 'dotenv/config';
import { z } from 'zod';

// Validate server settings while keeping provider credentials optional for local startup
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgresql://summit_thread:summit_thread_local_only@127.0.0.1:5435/summit_thread?schema=public'),
  ELASTICSEARCH_URL: z.string().url().default('http://127.0.0.1:9203'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3110),
  API_HOST: z.string().trim().min(1).default('127.0.0.1'),
  WEB_ORIGINS: z.string().default('http://127.0.0.1:5185,http://localhost:5185'),
  DASH0_OTLP_ENDPOINT: z.string().url().default('https://ingress.us-west-2.aws.dash0.com'),
  DASH0_DATASET: z.string().trim().min(1).default('summit-thread'),
  DASH0_BACKEND_TOKEN: z.string().optional(),
  GEMINI_API_KEY: z.string().trim().optional(),
  GEMINI_TEXT_MODEL: z.string().trim().min(1).default('gemini-3.8-flash'),
  GEMINI_TRANSCRIPTION_MODEL: z.string().trim().min(1).default('gemini-3.5-transcribe'),
  GEMINI_LIVE_TRANSCRIPTION_MODEL: z.string().trim().min(1).default('gemini-3.5-transcribe-live'),
  // Select the multimodal model that reviews isolated elapsed video windows
  GEMINI_VISUAL_MODEL: z.string().trim().min(1).default('gemini-3.8-flash')
});

// Parse the environment once before composing runtime services
export const env = envSchema.parse(process.env);
