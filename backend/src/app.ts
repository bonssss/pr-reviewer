import express, { Express, NextFunction, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { ZodError } from 'zod';
import { env, getAllowedOrigins } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma } from './db/prisma.js';
import { authRouter } from './modules/auth/index.js';
import { repositoryRouter } from './modules/repositories/index.js';
import { reviewRouter } from './modules/reviews/index.js';
import { dashboardRouter } from './modules/dashboard/index.js';
import { webhookRouter } from './webhooks/index.js';
import { apiRateLimiter } from './config/rate-limit.js';
import { AppError, mapPrismaError } from './utils/errors.js';

const STATIC_ASSET_RE = /\.(?:js|mjs|css|svg|png|jpe?g|gif|ico|webp|woff2?|ttf|eot|map|webmanifest)$/i;

function resolveFrontendDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'frontend', 'dist'),
    path.resolve(process.cwd(), '../frontend/dist'),
    path.resolve(process.cwd(), 'frontend'),
    path.resolve(process.cwd(), '../frontend'),
  ];

  return (
    candidates.find(
      (dir) => fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'app.js'))
    ) ??
    candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ??
    null
  );
}

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  // Strict security headers. The dashboard has no inline scripts or inline
  // event handlers, so `script-src 'self'` is safe. Inline *style attributes*
  // are still used for progress bars, hence 'unsafe-inline' for styles only.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: [
            "'self'",
            'data:',
            'https://avatars.githubusercontent.com',
            'https://*.githubusercontent.com',
          ],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    })
  );

  const allowedOrigins = new Set(getAllowedOrigins());

  app.use(
    cors({
      origin(origin, callback) {
        // Non-browser clients (curl, GitHub webhooks) send no Origin header.
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Hub-Signature-256',
        'X-GitHub-Event',
        'X-GitHub-Delivery',
      ],
      maxAge: 600,
    })
  );

  app.use(cookieParser());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug({ method: req.method, url: req.url }, 'Incoming HTTP request');
    next();
  });

  // Health check before body parsing: it must stay cheap and never leak internals.
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.status(200).json({
        status: 'healthy',
        database: 'connected',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ error }, 'Health check failed');
      res.status(503).json({ status: 'unhealthy', database: 'disconnected' });
    }
  });

  // Webhooks must receive the raw bytes for HMAC verification, so they are
  // mounted BEFORE the global JSON parser. The router parses JSON itself.
  app.use('/api/webhooks', webhookRouter);
  app.use('/webhooks', webhookRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // Dashboard source files are public, everything else in the repo is not.
  const frontendDir = resolveFrontendDir();
  if (frontendDir) {
    const staticHandler = express.static(frontendDir, {
      index: false,
      dotfiles: 'deny',
      maxAge: env.NODE_ENV === 'production' ? '1h' : 0,
    });

    app.use((req: Request, res: Response, next: NextFunction) => {
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC_ASSET_RE.test(req.path)) {
        staticHandler(req, res, next);
        return;
      }
      next();
    });
  }

  app.get('/', (req: Request, res: Response) => {
    const accept = req.headers.accept ?? '';
    const indexPath = frontendDir ? path.join(frontendDir, 'index.html') : null;
    const wantsHtml = accept.includes('text/html');

    if (wantsHtml && indexPath && fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
      return;
    }

    res.json({
      name: 'AI-Powered GitHub Pull Request Reviewer API',
      status: 'online',
      version: '1.0.0',
      dashboard: '/dashboard',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/dashboard', (_req: Request, res: Response) => {
    const indexPath = frontendDir ? path.join(frontendDir, 'index.html') : null;
    if (indexPath && fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.redirect(env.FRONTEND_URL);
    }
  });

  app.use('/api', apiRateLimiter);

  app.use('/api/auth', authRouter);
  app.use('/api/repositories', repositoryRouter);
  app.use('/api/reviews', reviewRouter);
  app.use('/api/dashboard', dashboardRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      code: 'NOT_FOUND',
      message: 'The requested resource does not exist.',
    });
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const appError = err instanceof AppError ? err : mapPrismaError(err);

    if (appError) {
      res.status(appError.statusCode).json({
        error: appError.message,
        code: appError.code,
        ...(appError.details !== undefined ? { details: appError.details } : {}),
      });
      return;
    }

    if (err instanceof ZodError) {
      res.status(400).json({
        error: 'Validation failed',
        code: 'BAD_REQUEST',
        details: err.flatten(),
      });
      return;
    }

    const expressError = err as { type?: string; message?: string; status?: number };

    if (expressError?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON request body', code: 'BAD_REQUEST' });
      return;
    }

    if (expressError?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' });
      return;
    }

    logger.error({ err }, 'Unhandled application error');

    res.status(500).json({
      error:
        env.NODE_ENV === 'production'
          ? 'An unexpected error occurred'
          : expressError?.message ?? 'Internal Server Error',
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  return app;
}
