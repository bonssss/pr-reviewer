import { NextFunction, Request, Response } from 'express';
import rateLimit, { Options } from 'express-rate-limit';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

/**
 * Shared limiter factory. A `max` of 0 disables limiting entirely, which is how
 * the test suite keeps request volume deterministic.
 */
export function createRateLimiter(options: Partial<Options> & { max: number; windowMs?: number }) {
  return rateLimit({
    ...options,
    windowMs: options.windowMs ?? env.RATE_LIMIT_WINDOW_MS,
    max: options.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => options.max === 0,
    handler: (_req: Request, res: Response) => {
      const error = new AppError(429, 'Too many requests. Please slow down.', 'RATE_LIMITED');
      res.status(error.statusCode).json({ error: error.message, code: error.code });
    },
  });
}

/** Global API limiter. */
export const apiRateLimiter = createRateLimiter({ max: env.RATE_LIMIT_MAX });

/** Stricter limiter for anonymous/authenticated auth handshakes. */
export const authRateLimiter = createRateLimiter({
  max: env.AUTH_RATE_LIMIT_MAX,
  windowMs: 60_000,
});

/** Protects expensive, billable operations (AI re-reviews). */
export const rerunRateLimiter = createRateLimiter({
  max: env.RERUN_RATE_LIMIT_MAX,
  windowMs: 60_000,
});

/**
 * CSRF protection for cookie-authenticated, state-changing requests.
 * Bearer-token clients are exempt because a browser cannot attach them
 * cross-site. Requests carrying a session cookie must come from an allowed
 * origin (or present no Origin header at all, e.g. same-origin form posts from
 * older browsers are still checked via Referer when available).
 */
export function requireTrustedOrigin(origins: string[]) {
  const allowed = new Set(origins);

  return (req: Request, res: Response, next: NextFunction): void => {
    const usesCookieAuth =
      !req.headers.authorization && Boolean((req as Request & { cookies?: Record<string, string> }).cookies?.token);

    if (!usesCookieAuth) {
      next();
      return;
    }

    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Cross-origin request rejected' });
      return;
    }

    if (!origin) {
      const referer = req.headers.referer;
      if (referer) {
        try {
          const refererOrigin = new URL(referer).origin;
          if (!allowed.has(refererOrigin)) {
            res.status(403).json({ error: 'FORBIDDEN', message: 'Cross-origin request rejected' });
            return;
          }
        } catch {
          res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid Referer header' });
          return;
        }
      }
    }

    next();
  };
}
