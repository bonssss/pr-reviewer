import { Response } from 'express';
import { RequestWithRawBody, GitHubPullRequestPayload, GitHubInstallationPayload } from './webhook.types.js';
import { WebhookVerifier } from './webhook.verifier.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { ReviewWorker } from '../workers/review.worker.js';
import { GitHubService } from '../modules/github/github.service.js';

export class WebhookHandler {
  /**
   * Main GitHub Webhook Endpoint Handler
   */
  public static async handleWebhook(req: RequestWithRawBody, res: Response): Promise<void> {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const event = req.headers['x-github-event'] as string | undefined;
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    logger.info({ event, deliveryId }, 'Received GitHub webhook event');

    // 1. Verify cryptographic HMAC signature
    const isValid = WebhookVerifier.verifySignature(req.rawBody, signature);
    if (!isValid) {
      logger.warn({ deliveryId }, 'Webhook rejected: invalid HMAC signature');
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid webhook signature' });
      return;
    }

    // 2. Handle 'ping' event
    if (event === 'ping') {
      res.status(200).json({ message: 'Pong! Webhook verified and active.' });
      return;
    }

    // 3. Handle 'installation' & 'installation_repositories' events
    if (event === 'installation' || event === 'installation_repositories') {
      const payload = req.body as GitHubInstallationPayload;
      const installationId = payload.installation?.id;

      if (installationId && payload.action !== 'deleted') {
        // Asynchronously sync repositories
        GitHubService.syncInstallationRepositories(installationId).catch((err) => {
          logger.error({ err, installationId }, 'Background installation repo sync failed');
        });
      }

      res.status(200).json({ message: 'Installation event processed' });
      return;
    }

    // 4. Handle 'pull_request' events
    if (event === 'pull_request') {
      await WebhookHandler.handlePullRequestEvent(req.body as GitHubPullRequestPayload, res);
      return;
    }

    // 5. Default acknowledge for other events
    res.status(200).json({ message: `Event '${event}' acknowledged` });
  }

  /**
   * Process Pull Request events: opened, synchronize, reopened
   */
  private static async handlePullRequestEvent(
    payload: GitHubPullRequestPayload,
    res: Response
  ): Promise<void> {
    const { action, pull_request: pr, repository: repo, installation } = payload;

    logger.info(
      { action, prNumber: pr.number, repo: repo.full_name },
      'Processing pull_request webhook action'
    );

    // Only process actionable code events
    const supportedActions = ['opened', 'synchronize', 'reopened'];
    if (!supportedActions.includes(action)) {
      res.status(200).json({
        message: `Ignored unhandled pull_request action: ${action}`,
      });
      return;
    }

    // 0. Upsert Installation in database if present
    let dbInstallationId: string | undefined;
    if (installation?.id) {
      const dbInstallation = await prisma.installation.upsert({
        where: { installationId: BigInt(installation.id) },
        update: {
          accountName: repo.owner.login,
          accountType: repo.owner.type === 'Organization' ? 'ORGANIZATION' : 'USER',
        },
        create: {
          installationId: BigInt(installation.id),
          accountName: repo.owner.login,
          accountType: repo.owner.type === 'Organization' ? 'ORGANIZATION' : 'USER',
        },
      });
      dbInstallationId = dbInstallation.id;
    }

    // 1. Upsert Repository in database
    const dbRepo = await prisma.repository.upsert({
      where: { fullName: repo.full_name },
      update: {
        githubRepoId: BigInt(repo.id),
        name: repo.name,
        owner: repo.owner.login,
        isPrivate: repo.private,
        defaultBranch: repo.default_branch,
        ...(dbInstallationId && { installationId: dbInstallationId }),
      },
      create: {
        githubRepoId: BigInt(repo.id),
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner.login,
        isPrivate: repo.private,
        defaultBranch: repo.default_branch,
        webhookActive: true,
        autoReviewEnabled: true,
        ...(dbInstallationId && { installationId: dbInstallationId }),
      },
    });

    // 2. Check if Auto Review is enabled on this repo
    if (!dbRepo.autoReviewEnabled) {
      logger.info(
        { repo: repo.full_name, pr: pr.number },
        'Auto review is disabled for this repository. Skipping review.'
      );
      res.status(200).json({
        message: 'Auto review is disabled for this repository.',
      });
      return;
    }

    // 3. Upsert PullRequest in database
    const dbPr = await prisma.pullRequest.upsert({
      where: { githubPrId: BigInt(pr.id) },
      update: {
        title: pr.title,
        state: pr.state === 'open' ? 'OPEN' : 'CLOSED',
        baseBranch: pr.base.ref,
        headBranch: pr.head.ref,
        headSha: pr.head.sha,
        author: pr.user.login,
        htmlUrl: pr.html_url,
        diffUrl: pr.diff_url,
      },
      create: {
        githubPrId: BigInt(pr.id),
        number: pr.number,
        title: pr.title,
        state: pr.state === 'open' ? 'OPEN' : 'CLOSED',
        baseBranch: pr.base.ref,
        headBranch: pr.head.ref,
        headSha: pr.head.sha,
        author: pr.user.login,
        htmlUrl: pr.html_url,
        diffUrl: pr.diff_url,
        repoId: dbRepo.id,
      },
    });

    // 4. Create new ReviewSession in PENDING state
    const reviewSession = await prisma.reviewSession.create({
      data: {
        prId: dbPr.id,
        commitSha: pr.head.sha,
        status: 'PENDING',
      },
    });

    // 5. Enqueue background review processing
    const installationId = installation?.id || 0;
    ReviewWorker.getInstance().enqueue({
      reviewSessionId: reviewSession.id,
      repoFullName: repo.full_name,
      pullNumber: pr.number,
      commitSha: pr.head.sha,
      installationId,
    });

    // 6. Return immediate 202 Accepted response to avoid GitHub webhook timeout
    res.status(202).json({
      message: 'Pull request review enqueued for background processing',
      reviewSessionId: reviewSession.id,
      prNumber: pr.number,
      commitSha: pr.head.sha,
    });
  }
}
