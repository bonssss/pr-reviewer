import { Response, NextFunction } from 'express';
import { AuthService } from './auth.service.js';
import { AuthenticatedRequest } from './auth.types.js';
import { logger } from '../../config/logger.js';

export function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  const tokenFromHeader = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : null;
  const tokenFromCookie = req.cookies?.token as string | undefined;

  const token = tokenFromHeader || tokenFromCookie;

  if (!token) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication token missing. Please sign in.',
    });
    return;
  }

  try {
    const decoded = AuthService.verifyToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    logger.debug({ error }, 'Invalid or expired auth token');
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired authentication token.',
    });
  }
}

export function optionalAuthenticateToken(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  const tokenFromHeader = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : null;
  const tokenFromCookie = req.cookies?.token as string | undefined;

  const token = tokenFromHeader || tokenFromCookie;

  if (token) {
    try {
      const decoded = AuthService.verifyToken(token);
      req.user = decoded;
    } catch {
      // Ignored for optional auth
    }
  }

  next();
}
