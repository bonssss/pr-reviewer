import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './db/prisma.js';

async function bootstrap() {
  try {
    // 1. Establish database connection
    await connectDatabase();

    // 2. Initialize express app
    const app = createApp();

    // 3. Start HTTP server
    const server = app.listen(env.PORT, () => {
      logger.info(
        `🚀 AI GitHub PR Reviewer API listening on http://localhost:${env.PORT} [${env.NODE_ENV}]`
      );
    });

    // 4. Graceful shutdown handler
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    for (const signal of signals) {
      process.on(signal, async () => {
        logger.info(`Received ${signal}. Gracefully shutting down...`);
        server.close(async () => {
          logger.info('HTTP server closed.');
          await disconnectDatabase();
          process.exit(0);
        });

        // Force shutdown after timeout
        setTimeout(() => {
          logger.error('Forceful shutdown after timeout.');
          process.exit(1);
        }, 10000);
      });
    }
  } catch (error) {
    logger.fatal({ error }, 'Failed to start application');
    process.exit(1);
  }
}

void bootstrap();
