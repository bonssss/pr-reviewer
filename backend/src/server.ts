import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './db/prisma.js';
import { ReviewWorker } from './workers/review.worker.js';

const worker = ReviewWorker.getInstance();
let shuttingDown = false;

async function shutdown(signal: string, server: import('http').Server): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Gracefully shutting down');

  const forceExit = setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, env.WORKER_SHUTDOWN_TIMEOUT_MS + 10_000);
  forceExit.unref();

  try {
    await worker.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
}

async function bootstrap(): Promise<void> {
  try {
    await connectDatabase();

    // Pick up reviews that were interrupted by a crash/restart.
    await worker.recoverStaleSessions().catch((error) => {
      logger.warn({ error }, 'Could not recover stale review sessions');
    });

    const app = createApp();
    const server = app.listen(env.PORT, () => {
      logger.info(
        { port: env.PORT, env: env.NODE_ENV },
        'AI GitHub PR Reviewer API is listening'
      );
    });

    server.requestTimeout = 60_000;
    server.headersTimeout = 65_000;

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        void shutdown(signal, server);
      });
    }

    process.on('unhandledRejection', (reason) => {
      // Never let a stray promise kill the process; log with enough context to fix it.
      logger.error({ reason }, 'Unhandled promise rejection');
    });

    process.on('uncaughtException', (error) => {
      logger.fatal({ error }, 'Uncaught exception');
      void shutdown('uncaughtException', server);
    });
  } catch (error) {
    logger.fatal({ error }, 'Failed to start application');
    process.exit(1);
  }
}

void bootstrap();
