import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { ReviewWorker } from '../../workers/review.worker.js';
import { ReviewPublisherService } from './review-publisher.service.js';
import {
  buildRepositoryAccessWhere,
  buildReviewSessionAccessWhere,
} from '../auth/access.js';
import { conflict, notFound } from '../../utils/errors.js';
import { env } from '../../config/env.js';

const IN_FLIGHT_STATUSES = ['PENDING', 'IN_PROGRESS'] as const;

export class ReviewService {
  /** Get a single review session with comments, scoped to the caller's tenant. */
  public static async getReviewSessionById(userId: string, sessionId: string) {
    return prisma.reviewSession.findFirst({
      where: { AND: [{ id: sessionId }, await buildReviewSessionAccessWhere(userId)] },
      include: {
        comments: {
          orderBy: [{ severity: 'asc' }, { filePath: 'asc' }],
        },
        pullRequest: {
          include: {
            repository: {
              select: {
                id: true,
                name: true,
                fullName: true,
                owner: true,
                defaultBranch: true,
              },
            },
          },
        },
      },
    });
  }

  /** Historical review sessions for a Pull Request (tenant scoped, paginated). */
  public static async getPrReviewHistory(
    userId: string,
    prId: string,
    pagination: { limit: number; offset: number } = { limit: 50, offset: 0 }
  ) {
    return prisma.reviewSession.findMany({
      where: {
        AND: [{ prId }, { pullRequest: { repository: await buildRepositoryAccessWhere(userId) } }],
      },
      orderBy: { createdAt: 'desc' },
      take: pagination.limit,
      skip: pagination.offset,
      include: {
        _count: {
          select: { comments: true },
        },
      },
    });
  }

  /**
   * Request a fresh re-review for a Pull Request.
   *
   * Mirrors the webhook dedupe rules: refuse to create a second session while
   * one is already queued/running for the same commit. Manual re-reviews of an
   * already-completed commit are allowed.
   */
  public static async requestReReview(userId: string, prId: string) {
    const pr = await prisma.pullRequest.findFirst({
      where: { AND: [{ id: prId }, { repository: await buildRepositoryAccessWhere(userId) }] },
      include: {
        repository: {
          include: { installation: true },
        },
      },
    });

    if (!pr) {
      throw notFound('Pull request not found');
    }

    const installation = pr.repository.installation;

    if (!installation || installation.isSuspended) {
      throw conflict('Repository has no active GitHub App installation');
    }

    if (!env.ENABLE_AUTO_REVIEW) {
      throw conflict('Automated reviews are disabled on this server');
    }

    const inFlight = await prisma.reviewSession.findFirst({
      where: {
        prId: pr.id,
        commitSha: pr.headSha,
        status: { in: [...IN_FLIGHT_STATUSES] },
      },
      select: { id: true },
    });

    if (inFlight) {
      throw conflict('A review for this commit is already in progress', {
        reviewSessionId: inFlight.id,
      });
    }

    const newSession = await prisma.reviewSession.create({
      data: {
        prId: pr.id,
        commitSha: pr.headSha,
        status: 'PENDING',
      },
    });

    ReviewWorker.getInstance().enqueue({
      reviewSessionId: newSession.id,
      repoFullName: pr.repository.fullName,
      pullNumber: pr.number,
      commitSha: pr.headSha,
      installationId: installation.installationId,
    });

    logger.info(
      { prId, newSessionId: newSession.id, repo: pr.repository.fullName },
      'Successfully enqueued manual re-review request'
    );

    return newSession;
  }

  /** Manually publish a completed review to GitHub. */
  public static async publishReview(
    userId: string,
    sessionId: string,
    options: { force?: boolean } = {}
  ) {
    const session = await prisma.reviewSession.findFirst({
      where: { AND: [{ id: sessionId }, await buildReviewSessionAccessWhere(userId)] },
      select: { id: true, status: true },
    });

    if (!session) {
      throw notFound('Review session not found');
    }

    if (session.status !== 'COMPLETED') {
      throw conflict('Only completed reviews can be published to GitHub');
    }

    return ReviewPublisherService.publishReviewToGitHub(sessionId, { force: options.force });
  }
}
