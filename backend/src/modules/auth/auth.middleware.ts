import { NextFunction, Response } from 'express';
import { AuthService } from './auth.service.js';
import { AuthenticatedRequest, SESSION_COOKIE_NAME } from './auth.types.js';
import { logger } from '../../config/logger.js';
import { assertUuid, badRequest, notFound, unauthorized } from '../../utils/errors.js';
import {
  findAccessiblePullRequest,
  findAccessibleRepository,
  findAccessibleReviewSession,
} from './access.js';
import { prisma } from '../../db/prisma.js';

function extractToken(req: AuthenticatedRequest): string | null {
  const authHeader = req.headers.authorization;
  const tokenFromHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const tokenFromCookie = (req.cookies?.[SESSION_COOKIE_NAME] as string | undefined) ?? null;

  return tokenFromHeader || tokenFromCookie;
}

/** Hard authentication: 401 when no valid session is present. */
export function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
      message: 'Authentication token missing. Please sign in.',
    });
    return;
  }

  try {
    req.user = AuthService.verifyToken(token);
    next();
  } catch (error) {
    logger.debug({ error }, 'Invalid or expired auth token');
    res.status(401).json({
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired authentication token.',
    });
  }
}

/** Soft authentication: attaches the user when possible, never blocks. */
export function optionalAuthenticateToken(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  const token = extractToken(req);

  if (token) {
    try {
      req.user = AuthService.verifyToken(token);
    } catch {
      // Ignored: optional auth must never fail the request.
    }
  }

  next();
}

function requireUserId(req: AuthenticatedRequest): string {
  if (!req.user?.userId) {
    throw unauthorized();
  }
  return req.user.userId;
}

/**
 * Ensures `:id` refers to a repository the caller can access.
 * Returns 404 for both "missing" and "not yours" to avoid leaking existence.
 */
export async function requireRepositoryAccess(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const repositoryId = assertUuid(req.params.id, 'repository id');
    const repository = await findAccessibleRepository(requireUserId(req), repositoryId);

    if (!repository) {
      next(notFound('Repository not found'));
      return;
    }

    req.repository = repository;
    next();
  } catch (error) {
    next(error);
  }
}

/** Ensures `:prId` belongs to a repository the caller can access. */
export async function requirePullRequestAccess(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const prId = assertUuid(req.params.prId, 'pull request id');
    const pullRequest = await findAccessiblePullRequest(requireUserId(req), prId);

    if (!pullRequest) {
      next(notFound('Pull request not found'));
      return;
    }

    req.pullRequest = pullRequest;
    next();
  } catch (error) {
    next(error);
  }
}

/** Ensures `:sessionId` belongs to a repository the caller can access. */
export async function requireReviewSessionAccess(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const sessionId = assertUuid(req.params.sessionId, 'review session id');
    const session = await findAccessibleReviewSession(requireUserId(req), sessionId);

    if (!session) {
      next(notFound('Review session not found'));
      return;
    }

    req.reviewSession = session;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Ensures `:installationId` (GitHub installation id, numeric) is linked to the
 * caller. Prevents one tenant from syncing another tenant's installation.
 */
export async function requireInstallationAccess(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = requireUserId(req);
    const raw = req.params.installationId;

    if (!raw || !/^\d{1,20}$/.test(raw)) {
      throw badRequest('Invalid installation id');
    }

    const link = await prisma.userInstallation.findFirst({
      where: {
        userId,
        installation: { installationId: BigInt(raw), isSuspended: false },
      },
      select: { id: true },
    });

    if (!link) {
      next(notFound('Installation not found'));
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}
