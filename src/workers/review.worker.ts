import { EventEmitter } from 'events';
import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';
import { GitHubService } from '../modules/github/github.service.js';
import { DiffParser, ParsedDiffSummary } from '../utils/diff.parser.js';
import { AIService } from '../modules/ai/ai.service.js';

export interface ReviewJob {
  reviewSessionId: string;
  repoFullName: string;
  pullNumber: number;
  commitSha: string;
  installationId: number | bigint;
}

export class ReviewWorker extends EventEmitter {
  private static instance: ReviewWorker;
  private queue: ReviewJob[] = [];
  private isProcessing = false;

  private constructor() {
    super();
    this.on('job:enqueued', () => {
      void this.processNextJob();
    });
  }

  public static getInstance(): ReviewWorker {
    if (!ReviewWorker.instance) {
      ReviewWorker.instance = new ReviewWorker();
    }
    return ReviewWorker.instance;
  }

  public enqueue(job: ReviewJob): void {
    this.queue.push(job);
    logger.info(
      { reviewSessionId: job.reviewSessionId, repo: job.repoFullName, pr: job.pullNumber },
      'Enqueued PR review job'
    );
    this.emit('job:enqueued', job);
  }

  private async processNextJob(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const job = this.queue.shift();

    if (!job) {
      this.isProcessing = false;
      return;
    }

    const startTime = Date.now();

    try {
      logger.info({ job }, 'Starting background PR diff fetching and AI analysis');

      // 1. Mark session as IN_PROGRESS
      await prisma.reviewSession.update({
        where: { id: job.reviewSessionId },
        data: { status: 'IN_PROGRESS' },
      });

      // 2. Extract repository owner and name
      const [owner, repo] = job.repoFullName.split('/');
      if (!owner || !repo) {
        throw new Error(`Invalid repoFullName: ${job.repoFullName}`);
      }

      // 3. Fetch changed files from GitHub
      const files = await GitHubService.getPullRequestFiles(
        owner,
        repo,
        job.pullNumber,
        job.installationId
      );

      // 4. Parse and filter diff
      const diffSummary: ParsedDiffSummary = DiffParser.parseGitHubFiles(files);

      // 5. Look up PR metadata and custom repository guidelines from database
      const dbPr = await prisma.pullRequest.findFirst({
        where: {
          number: job.pullNumber,
          repository: { fullName: job.repoFullName },
        },
        include: {
          repository: true,
        },
      });

      // 6. Execute AI code review
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

      this.emit('job:completed', { job, reviewResult });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown background review error';
      logger.error({ error, job }, 'PR review processing failed');

      await prisma.reviewSession.update({
        where: { id: job.reviewSessionId },
        data: {
          status: 'FAILED',
          errorMessage,
          executionTimeMs: Date.now() - startTime,
        },
      });

      this.emit('job:failed', { job, error });
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
        setImmediate(() => {
          void this.processNextJob();
        });
      }
    }
  }

  public getQueueLength(): number {
    return this.queue.length;
  }
}
