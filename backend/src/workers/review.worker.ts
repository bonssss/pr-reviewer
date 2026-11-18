import { EventEmitter } from 'events';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { GitHubService } from '../modules/github/github.service.js';
import { DiffParser, ParsedDiffSummary } from '../utils/diff.parser.js';
import { AIService } from '../modules/ai/ai.service.js';
import { ReviewPublisherService } from '../modules/reviews/review-publisher.service.js';

export interface ReviewJob {
  reviewSessionId: string;
  repoFullName: string;
  pullNumber: number;
  commitSha: string;
  installationId: number | bigint;
}

/**
 * In-process review queue.
 *
 * Jobs are processed one at a time. Every step is idempotent and guarded by
 * status transitions in PostgreSQL, so a duplicated enqueue (webhook retry,
 * double click, stale recovery) can never run the same review twice.
 */
export class ReviewWorker extends EventEmitter {
  private static instance: ReviewWorker | undefined;

  private readonly queue: ReviewJob[] = [];
  private readonly queuedIds = new Set<string>();
  private isProcessing = false;
  private isStopping = false;
  private activeJob: Promise<void> | null = null;

  private constructor() {
    super();
  }

  public static getInstance(): ReviewWorker {
    if (!ReviewWorker.instance) {
      ReviewWorker.instance = new ReviewWorker();
    }
    return ReviewWorker.instance;
  }

  /** Returns false when the job is already queued or currently running. */
  public enqueue(job: ReviewJob): boolean {
    if (this.isStopping) {
      logger.warn({ reviewSessionId: job.reviewSessionId }, 'Worker is shutting down; job not queued');
      return false;
    }

    if (this.queuedIds.has(job.reviewSessionId)) {
      logger.debug(
        { reviewSessionId: job.reviewSessionId },
        'Review job already queued; ignoring duplicate enqueue'
      );
      return false;
    }

    this.queuedIds.add(job.reviewSessionId);
    this.queue.push(job);
    logger.info(
      { reviewSessionId: job.reviewSessionId, repo: job.repoFullName, pr: job.pullNumber },
      'Enqueued PR review job'
    );

    void this.drain();
    return true;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  /** Resets jobs stuck IN_PROGRESS after a crash/restart so they can be retried. */
  public async recoverStaleSessions(): Promise<number> {
    const cutoff = new Date(Date.now() - env.WORKER_STALE_MS);

    const staleSessions = await prisma.reviewSession.findMany({
      where: {
        status: 'IN_PROGRESS',
        updatedAt: { lt: cutoff },
        attempts: { lt: env.WORKER_MAX_ATTEMPTS },
      },
      include: {
        pullRequest: {
          include: {
            repository: {
              include: { installation: true },
            },
          },
        },
      },
      take: 100,
    });

    if (staleSessions.length === 0) {
      return 0;
    }

    let recovered = 0;

    for (const session of staleSessions) {
      const repository = session.pullRequest.repository;
      const installation = repository.installation;

      if (!installation) {
        await prisma.reviewSession.updateMany({
          where: { id: session.id, status: 'IN_PROGRESS' },
          data: {
            status: 'FAILED',
            errorMessage: 'Review interrupted and the repository has no GitHub App installation',
          },
        });
        continue;
      }

      await prisma.reviewSession.updateMany({
        where: { id: session.id, status: 'IN_PROGRESS' },
        data: { status: 'PENDING', errorMessage: 'Recovered after an interrupted worker' },
      });

      this.enqueue({
        reviewSessionId: session.id,
        repoFullName: repository.fullName,
        pullNumber: session.pullRequest.number,
        commitSha: session.commitSha,
        installationId: installation.installationId,
      });
      recovered += 1;
    }

    if (recovered > 0) {
      logger.info({ recovered }, 'Recovered stale review sessions');
    }

    return recovered;
  }

  /**
   * Stops accepting jobs and waits (bounded) for the in-flight job to finish.
   */
  public async shutdown(timeoutMs = env.WORKER_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    this.isStopping = true;
    this.queue.length = 0;
    this.queuedIds.clear();

    if (!this.activeJob) {
      return;
    }

    await Promise.race([
      this.activeJob.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  private async drain(): Promise<void> {
    if (this.isProcessing || this.isStopping) {
      return;
    }

    const job = this.queue.shift();
    if (!job) {
      return;
    }

    this.isProcessing = true;
    this.activeJob = this.processJob(job);

    try {
      await this.activeJob;
    } finally {
      this.queuedIds.delete(job.reviewSessionId);
      this.isProcessing = false;
      this.activeJob = null;

      if (this.queue.length > 0 && !this.isStopping) {
        void this.drain();
      }
    }
  }

  private async processJob(job: ReviewJob): Promise<void> {
    const startTime = Date.now();

    try {
      const session = await prisma.reviewSession.findUnique({
        where: { id: job.reviewSessionId },
        select: { status: true, attempts: true },
      });

      if (!session) {
        logger.warn({ reviewSessionId: job.reviewSessionId }, 'Review session no longer exists; skipping job');
        return;
      }

      if (session.status === 'COMPLETED') {
        logger.info({ reviewSessionId: job.reviewSessionId }, 'Review session already completed; skipping job');
        return;
      }

      if (session.attempts >= env.WORKER_MAX_ATTEMPTS) {
        logger.error(
          { reviewSessionId: job.reviewSessionId, attempts: session.attempts },
          'Review session exhausted its retry budget'
        );
        await prisma.reviewSession.updateMany({
          where: { id: job.reviewSessionId, status: { not: 'COMPLETED' } },
          data: {
            status: 'FAILED',
            errorMessage: 'Review failed after the maximum number of attempts',
          },
        });
        return;
      }

      // Claim the job. The conditional update makes concurrent workers safe:
      // only one of them can move the session into IN_PROGRESS.
      const claimed = await prisma.reviewSession.updateMany({
        where: {
          id: job.reviewSessionId,
          status: { in: ['PENDING', 'FAILED', 'IN_PROGRESS'] },
        },
        data: { status: 'IN_PROGRESS', attempts: { increment: 1 }, errorMessage: null },
      });

      if (claimed.count === 0) {
        logger.info({ reviewSessionId: job.reviewSessionId }, 'Review session already claimed; skipping job');
        return;
      }

      // The test suite must stay hermetic: never call GitHub or OpenAI from it.
      // Webhook/re-rerun tests assert that a session was created, not that it
      // was processed, so fail the session without touching the network.
      if (process.env.VITEST) {
        await prisma.reviewSession.updateMany({
          where: { id: job.reviewSessionId, status: 'IN_PROGRESS' },
          data: {
            status: 'FAILED',
            errorMessage: 'Review processing is disabled in the test environment',
            executionTimeMs: Date.now() - startTime,
          },
        });
        logger.debug({ reviewSessionId: job.reviewSessionId }, 'Skipping review processing (test env)');
        return;
      }

      const [owner, repo] = job.repoFullName.split('/');
      if (!owner || !repo) {
        throw new Error(`Invalid repoFullName: ${job.repoFullName}`);
      }

      const files = await GitHubService.getPullRequestFiles(
        owner,
        repo,
        job.pullNumber,
        job.installationId
      );

      const diffSummary: ParsedDiffSummary = DiffParser.parseGitHubFiles(files);

      const dbPr = await prisma.pullRequest.findFirst({
        where: {
          number: job.pullNumber,
          repository: { fullName: job.repoFullName },
        },
        include: { repository: true },
      });

      const reviewResult = await AIService.reviewPullRequest({
        reviewSessionId: job.reviewSessionId,
        prTitle: dbPr?.title || `PR #${job.pullNumber}`,
        prNumber: job.pullNumber,
        author: dbPr?.author || 'Unknown',
        baseBranch: dbPr?.baseBranch || 'main',
        headBranch: dbPr?.headBranch || 'patch',
        diffSummary,
        customPrompt: dbPr?.repository.customPrompt,
      });

      logger.info(
        {
          reviewSessionId: job.reviewSessionId,
          totalIssues: reviewResult.totalIssues,
          recommendation: reviewResult.recommendation,
          durationMs: Date.now() - startTime,
        },
        'Background AI review completed successfully'
      );

      try {
        await ReviewPublisherService.publishReviewToGitHub(job.reviewSessionId);
      } catch (publishError) {
        // Publishing is best effort: the review itself is already persisted.
        logger.warn(
          { publishError, reviewSessionId: job.reviewSessionId },
          'Failed to publish review to GitHub'
        );
      }

      this.emit('job:completed', { job, reviewResult });
    } catch (error) {
      await this.handleFailure(job, error, startTime);
    }
  }

  private async handleFailure(job: ReviewJob, error: unknown, startTime: number): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unknown background review error';
    logger.error({ error, job }, 'PR review processing failed');

    const session = await prisma.reviewSession
      .findUnique({ where: { id: job.reviewSessionId }, select: { attempts: true } })
      .catch(() => null);

    const attempts = session?.attempts ?? env.WORKER_MAX_ATTEMPTS;
    const retryable = this.isRetryable(error) && attempts < env.WORKER_MAX_ATTEMPTS;

    if (retryable) {
      const delay = env.WORKER_RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0);

      await prisma.reviewSession
        .updateMany({
          where: { id: job.reviewSessionId, status: { not: 'COMPLETED' } },
          data: { status: 'PENDING', errorMessage: message.slice(0, 2000) },
        })
        .catch((updateError) => {
          logger.debug({ updateError }, 'Failed to schedule review retry');
        });

      logger.warn(
        { reviewSessionId: job.reviewSessionId, attempts, delay },
        'Scheduling review retry'
      );

      const timer = setTimeout(() => this.enqueue(job), delay);
      timer.unref();
      return;
    }

    await prisma.reviewSession
      .updateMany({
        where: { id: job.reviewSessionId, status: { not: 'COMPLETED' } },
        data: {
          status: 'FAILED',
          errorMessage: message.slice(0, 2000),
          executionTimeMs: Date.now() - startTime,
        },
      })
      .catch((updateError) => {
        logger.debug({ updateError }, 'Failed to record failed review status');
      });

    this.emit('job:failed', { job, error });
  }

  /** Configuration/auth errors will never succeed on retry. */
  private isRetryable(error: unknown): boolean {
    if (!(error instanceof Error)) return true;

    if (!GitHubService.isConfigured()) return false;

    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403 || status === 404 || status === 422) {
      return false;
    }

    if (/no github app installation|invalid repoFullName|not configured/i.test(error.message)) {
      return false;
    }

    return true;
  }
}
