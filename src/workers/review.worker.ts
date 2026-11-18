import { EventEmitter } from 'events';
import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';
import { GitHubService } from '../modules/github/github.service.js';
import { DiffParser, ParsedDiffSummary } from '../utils/diff.parser.js';

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

  /**
   * Enqueue a review job for asynchronous background processing
   */
  public enqueue(job: ReviewJob): void {
    this.queue.push(job);
    logger.info(
      { reviewSessionId: job.reviewSessionId, repo: job.repoFullName, pr: job.pullNumber },
      'Enqueued PR review job'
    );
    this.emit('job:enqueued', job);
  }

  /**
   * Process jobs sequentially from the queue
   */
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
      logger.info({ job }, 'Starting background PR diff fetching and processing');

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

      const executionTimeMs = Date.now() - startTime;

      // 5. Update session with parsed diff preparation (ready for Phase 4 AI analysis)
      await prisma.reviewSession.update({
        where: { id: job.reviewSessionId },
        data: {
          executionTimeMs,
          rawAiResponse: {
            diffSummary: {
              totalFiles: diffSummary.totalFiles,
              reviewableFiles: diffSummary.reviewableFiles,
              totalAdditions: diffSummary.totalAdditions,
              totalDeletions: diffSummary.totalDeletions,
              files: diffSummary.files.map((f) => ({
                filePath: f.filePath,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                isIgnored: f.isIgnored,
                ignoreReason: f.ignoreReason,
              })),
            },
          },
        },
      });

      logger.info(
        {
          reviewSessionId: job.reviewSessionId,
          totalFiles: diffSummary.totalFiles,
          reviewableFiles: diffSummary.reviewableFiles,
          durationMs: executionTimeMs,
        },
        'Finished fetching and structuring PR diff'
      );

      this.emit('job:completed', { job, diffSummary });
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
      // Continue next job in queue if any
      if (this.queue.length > 0) {
        setImmediate(() => {
          void this.processNextJob();
        });
      }
    }
  }

  /**
   * Helper method for inspection in tests or health checks
   */
  public getQueueLength(): number {
    return this.queue.length;
  }
}
