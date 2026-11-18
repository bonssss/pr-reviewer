import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { ReviewWorker } from '../../workers/review.worker.js';
import { ReviewPublisherService } from './review-publisher.service.js';

export class ReviewService {
  /**
   * Get single review session with detailed comments
   */
  public static async getReviewSessionById(sessionId: string) {
    return prisma.reviewSession.findUnique({
      where: { id: sessionId },
      include: {
        comments: {
          orderBy: [{ severity: 'asc' }, { filePath: 'asc' }],
        },
        pullRequest: {
          include: {
            repository: true,
          },
        },
      },
    });
  }

  /**
   * Get historical review sessions for a Pull Request
   */
  public static async getPrReviewHistory(prId: string) {
    return prisma.reviewSession.findMany({
      where: { prId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: {
            comments: true,
          },
        },
      },
    });
  }

  /**
   * Request a fresh re-review for a Pull Request
   */
  public static async requestReReview(prId: string) {
    const pr = await prisma.pullRequest.findUnique({
      where: { id: prId },
      include: {
        repository: {
          include: {
            installation: true,
          },
        },
      },
    });

    if (!pr) {
      throw new Error(`PullRequest with ID ${prId} not found`);
    }

    const installationId = pr.repository.installation?.installationId || BigInt(0);

    // Create new ReviewSession in PENDING status
    const newSession = await prisma.reviewSession.create({
      data: {
        prId: pr.id,
        commitSha: pr.headSha,
        status: 'PENDING',
      },
    });

    // Enqueue review job
    ReviewWorker.getInstance().enqueue({
      reviewSessionId: newSession.id,
      repoFullName: pr.repository.fullName,
      pullNumber: pr.number,
      commitSha: pr.headSha,
      installationId,
    });

    logger.info(
      { prId, newSessionId: newSession.id, repo: pr.repository.fullName },
      'Successfully enqueued manual re-review request'
    );

    return newSession;
  }

  /**
   * Manually trigger publishing of review to GitHub
   */
  public static async publishReview(sessionId: string) {
    return ReviewPublisherService.publishReviewToGitHub(sessionId);
  }
}
