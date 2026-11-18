import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma } from './db/prisma.js';
import { authRouter } from './modules/auth/index.js';
import { repositoryRouter } from './modules/repositories/index.js';
import { webhookRouter, RequestWithRawBody } from './webhooks/index.js';

export function createApp(): Express {
  const app = express();

  // Security middlewares
  app.use(helmet());
  app.use(
    cors({
      origin: [env.FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5173'],
      credentials: true,
    })
  );

  // Cookie parsing for session tokens
  app.use(cookieParser());

  // Parse JSON payloads preserving raw body buffer for HMAC webhook validation
  app.use(
    express.json({
      limit: '10mb',
      verify: (req: Request, _res: Response, buf: Buffer) => {
        (req as RequestWithRawBody).rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Basic request logging
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug({ method: req.method, url: req.url }, 'Incoming HTTP Request');
    next();
  });

  // Base and Health Check Endpoints
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'AI-Powered GitHub Pull Request Reviewer API',
      status: 'online',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      // Check database connection
      await prisma.$queryRaw`SELECT 1`;

      res.status(200).json({
        status: 'healthy',
        database: 'connected',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ error }, 'Health check failed');
      res.status(503).json({
        status: 'unhealthy',
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // API Routers
  app.use('/api/auth', authRouter);
  app.use('/api/repositories', repositoryRouter);
  app.use('/api/webhooks', webhookRouter);
  app.use('/webhooks', webhookRouter); // Alias for GitHub Webhook URL flexibility

  // 404 Handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      message: 'The requested resource does not exist.',
    });
  });

  // Global Error Handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'Unhandled application error');
    res.status(500).json({
      error: 'Internal Server Error',
      message: env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    });
  });

  return app;
}
