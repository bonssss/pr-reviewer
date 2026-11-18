import express, { NextFunction, Router } from 'express';
import { WebhookHandler } from './webhook.handler.js';
import { RequestWithRawBody } from './webhook.types.js';
import { asyncHandler } from '../utils/errors.js';
import { createRateLimiter } from '../config/rate-limit.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export const webhookRouter = Router();

/**
 * GitHub webhooks are authenticated by HMAC over the exact request bytes, so
 * this router owns its body parsing. The raw buffer is kept for verification
 * and a bounded JSON copy is exposed as `req.body`.
 */
webhookRouter.use(express.raw({ type: () => true, limit: '2mb' }));

webhookRouter.use((req: RequestWithRawBody, res, next: NextFunction) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  req.rawBody = raw;

  if (raw.length === 0) {
    req.body = {};
    next();
    return;
  }

  try {
    req.body = JSON.parse(raw.toString('utf8'));
    next();
  } catch (error) {
    logger.warn({ error }, 'Webhook payload is not valid JSON');
    res.status(400).json({ error: 'Bad Request', message: 'Malformed JSON payload' });
  }
});

/**
 * GitHub webhooks are authenticated by HMAC, not by session. A generous limiter
 * still protects the process from accidental floods while allowing bursts of
 * legitimate PR activity.
 */
const webhookRateLimiter = createRateLimiter({
  max: Math.max(env.RATE_LIMIT_MAX * 4, 300),
  windowMs: 60_000,
});

webhookRouter.post(
  '/github',
  webhookRateLimiter,
  asyncHandler(async (req, res) => {
    await WebhookHandler.handleWebhook(req as RequestWithRawBody, res);
  })
);
