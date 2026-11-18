import { PrismaClient } from '@prisma/client';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

// BigInt serialization polyfill for Express JSON responses.
// Scoped narrowly to avoid surprising behaviour elsewhere.
const bigIntPrototype = BigInt.prototype as unknown as { toJSON?: () => string };
if (typeof bigIntPrototype.toJSON !== 'function') {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function toJSON(this: bigint) {
      return this.toString();
    },
    configurable: true,
    writable: true,
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      env.NODE_ENV === 'development'
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'stdout', level: 'error' },
            { emit: 'stdout', level: 'warn' },
          ]
        : ['error'],
  });

if (env.NODE_ENV === 'development') {
  // @ts-expect-error Prisma event typing
  prisma.$on('query', (e: { query: string; duration: number }) => {
    logger.debug({ query: e.query, duration: `${e.duration}ms` }, 'Prisma Query');
  });
}

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function connectDatabase(retries = 5): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await prisma.$connect();
      logger.info('Connected to PostgreSQL database via Prisma');
      return;
    } catch (error) {
      lastError = error;
      logger.warn({ attempt, retries }, 'Database connection attempt failed');
      if (attempt < retries) {
        await sleep(Math.min(1000 * attempt, 5000));
      }
    }
  }

  logger.error({ error: lastError }, '❌ Failed to connect to PostgreSQL database');
  throw lastError;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Disconnected from PostgreSQL database');
}
