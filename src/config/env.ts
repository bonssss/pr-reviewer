import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  JWT_SECRET: z.string().default('development_jwt_secret_key_1234567890'),

  // GitHub App Settings
  GITHUB_APP_ID: z.string().optional().default(''),
  GITHUB_CLIENT_ID: z.string().optional().default(''),
  GITHUB_CLIENT_SECRET: z.string().optional().default(''),
  GITHUB_WEBHOOK_SECRET: z.string().optional().default(''),
  GITHUB_PRIVATE_KEY: z.string().optional().default(''),
  GITHUB_PRIVATE_KEY_PATH: z.string().optional().default(''),

  // OpenAI Settings
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  MAX_TOKENS_PER_REVIEW: z.coerce.number().default(4096),

  // Review Engine Flags
  ENABLE_AUTO_REVIEW: z
    .string()
    .transform((val) => val === 'true')
    .default('true'),
  AUTO_APPROVE_PR: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
  MAX_DIFF_FILES: z.coerce.number().default(50),
  MAX_DIFF_CHARACTERS: z.coerce.number().default(100000),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', JSON.stringify(parsedEnv.error.format(), null, 2));
  throw new Error('Invalid environment configuration');
}

export const env = parsedEnv.data;
