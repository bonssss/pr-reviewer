import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-hub-signature-256"]',
      'password',
      'token',
      'accessToken',
      'privateKey',
      'GITHUB_PRIVATE_KEY',
      'OPENAI_API_KEY',
      '*.token',
      '*.accessToken',
    ],
    censor: '[redacted]',
  },
  transport:
    env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});
