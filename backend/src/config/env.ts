import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const DEV_JWT_SECRET = 'development_jwt_secret_key_1234567890';

const booleanFromString = z
  .string()
  .transform((val) => val.trim().toLowerCase() === 'true')
  .default('false');

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    /** Public URL of the backend; used to build the OAuth callback URL. */
    BACKEND_URL: z.string().url().default('http://localhost:3000'),
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),
    /** Optional explicit OAuth callback override (must match the GitHub App config). */
    GITHUB_CALLBACK_URL: z.string().url().optional(),
    /** Comma-separated list of additional allowed CORS origins. */
    EXTRA_CORS_ORIGINS: z.string().optional().default(''),

    // Secrets. Optional in dev/test, enforced in production by `refineProduction`.
    JWT_SECRET: z.string().default(DEV_JWT_SECRET),
    TOKEN_ENCRYPTION_KEY: z.string().optional().default(''),

    // GitHub App Settings
    GITHUB_APP_ID: z.string().optional().default(''),
    GITHUB_CLIENT_ID: z.string().optional().default(''),
    GITHUB_CLIENT_SECRET: z.string().optional().default(''),
    GITHUB_WEBHOOK_SECRET: z.string().optional().default(''),
    GITHUB_PRIVATE_KEY: z.string().optional().default(''),
    GITHUB_PRIVATE_KEY_PATH: z.string().optional().default(''),
    GITHUB_API_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

    // OpenAI Settings
    OPENAI_API_KEY: z.string().optional().default(''),
    // Optional OpenAI-compatible endpoint (Gemini, Groq, OpenRouter, Ollama…).
    // Leave empty to use https://api.openai.com/v1.
    OPENAI_BASE_URL: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().url().optional()
    ),
    OPENAI_MODEL: z.string().default('gpt-4o-mini'),
    OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
    OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
    MAX_TOKENS_PER_REVIEW: z.coerce.number().int().positive().default(4096),

    // Review Engine Flags
    ENABLE_AUTO_REVIEW: booleanFromString.default('true'),
    AUTO_APPROVE_PR: booleanFromString.default('false'),
    MAX_DIFF_FILES: z.coerce.number().int().positive().default(50),
    MAX_DIFF_CHARACTERS: z.coerce.number().int().positive().default(100000),

    // Background worker
    WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    WORKER_RETRY_BASE_MS: z.coerce.number().int().positive().default(2000),
    WORKER_STALE_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(25000),

    // Rate limiting (set RATE_LIMIT_MAX=0 to disable, e.g. in tests)
    RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(300),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(30),
    RERUN_RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(10),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') {
      return;
    }

    const requireNonEmpty = (key: keyof typeof value, minLength = 1) => {
      const current = value[key];
      if (typeof current !== 'string' || current.trim().length < minLength) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${String(key)} must be set to at least ${minLength} characters in production`,
        });
      }
    };

    requireNonEmpty('JWT_SECRET', 32);
    requireNonEmpty('TOKEN_ENCRYPTION_KEY', 32);
    requireNonEmpty('GITHUB_APP_ID');
    requireNonEmpty('GITHUB_CLIENT_ID');
    requireNonEmpty('GITHUB_CLIENT_SECRET');
    requireNonEmpty('GITHUB_WEBHOOK_SECRET', 16);
    requireNonEmpty('OPENAI_API_KEY');

    if (!value.GITHUB_PRIVATE_KEY && !value.GITHUB_PRIVATE_KEY_PATH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GITHUB_PRIVATE_KEY'],
        message: 'GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH must be set in production',
      });
    }

    if (value.JWT_SECRET === DEV_JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'The development JWT secret cannot be used in production',
      });
    }

    if (value.FRONTEND_URL.startsWith('http://')) {
      // Plain http is only tolerated for local single-host deployments; any
      // real domain must be served over TLS (Secure session cookies).
      let hostname = '';
      try {
        hostname = new URL(value.FRONTEND_URL).hostname;
      } catch {
        hostname = '';
      }

      const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
      if (!isLocal) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FRONTEND_URL'],
          message: 'FRONTEND_URL must use https:// in production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema> & { TOKEN_ENCRYPTION_KEY: string };

/**
 * Parses and validates an environment object. Exported separately from the
 * module-level `env` constant so it can be unit tested and reused by tooling.
 */
export function parseEnv(raw: NodeJS.ProcessEnv | Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const formatted = result.error.format();
    // eslint-disable-next-line no-console
    console.error('❌ Invalid environment variables:', JSON.stringify(formatted, null, 2));
    throw new Error('Invalid environment configuration');
  }

  return {
    ...result.data,
    // In dev/test fall back to the JWT secret so local setup stays zero-config.
    TOKEN_ENCRYPTION_KEY: result.data.TOKEN_ENCRYPTION_KEY || result.data.JWT_SECRET,
  };
}

export const env = parseEnv(process.env);

export function getAllowedOrigins(): string[] {
  const origins = new Set<string>([env.FRONTEND_URL, env.BACKEND_URL]);

  for (const extra of env.EXTRA_CORS_ORIGINS.split(',')) {
    const trimmed = extra.trim();
    if (trimmed) origins.add(trimmed);
  }

  if (env.NODE_ENV !== 'production') {
    origins.add('http://localhost:3000');
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:3000');
    origins.add('http://127.0.0.1:5173');
  }

  return [...origins];
}

export function getOAuthCallbackUrl(): string {
  return env.GITHUB_CALLBACK_URL ?? `${env.BACKEND_URL}/api/auth/github/callback`;
}

/** True when the GitHub App is fully configured (safe to call the GitHub API). */
export function hasGithubAppCredentials(): boolean {
  return Boolean(env.GITHUB_APP_ID && (env.GITHUB_PRIVATE_KEY || env.GITHUB_PRIVATE_KEY_PATH));
}
