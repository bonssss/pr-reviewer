import { Response } from 'express';
import { isPrismaError } from '../utils/errors.js';
import { RequestWithRawBody, githubInstallationPayloadSchema, githubPullRequestPayloadSchema } from './webhook.types.js';
import { WebhookVerifier } from './webhook.verifier.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { ReviewWorker } from '../workers/review.worker.js';
import { GitHubService } from '../modules/github/github.service.js';

const SUPPORTED_PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'closed']);

/** A webhook outcome, buffered so the delivery ledger is finalised first. */
interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export class WebhookHandler {
  /**
   * Main GitHub webhook endpoint handler.
   *
   * Flow: verify HMAC -> record delivery (idempotency) -> validate payload ->
   * persist state -> enqueue review -> respond. Every failure path returns a
   * concrete HTTP status; nothing is left as a floating promise.
   */
  public static async handleWebhook(req: RequestWithRawBody, res: Response): Promise<void> {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const event = (req.headers['x-github-event'] as string | undefined) ?? 'unknown';
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    // 1. Verify cryptographic HMAC signature before touching anything else.
    if (!WebhookVerifier.verifySignature(req.rawBody, signature)) {
      logger.warn({ deliveryId, event }, 'Webhook rejected: invalid HMAC signature');
      res.status(401).json({ error: 'Unauthorized', message: 'Invalid webhook signature' });
      return;
    }

    logger.info({ event, deliveryId }, 'Received GitHub webhook event');

    // 2. Idempotency ledger. GitHub retries deliveries (e.g. after a timeout)
    //    and a retried delivery must never trigger a second review.
    const delivery = await this.beginDelivery(deliveryId, event);
    if (delivery.duplicate) {
      res.status(200).json({ message: 'Duplicate delivery ignored', deliveryId });
      return;
    }

    try {
      // Handlers return their response instead of writing it directly so the
      // idempotency ledger is always finalised before the HTTP response is
      // flushed. Otherwise a fast client could observe `RECEIVED` while the
      // handler is still completing.
      const result = await this.dispatch(event, req.body);
      await this.completeDelivery(deliveryId, 'PROCESSED');
      res.status(result.status).json(result.body);
    } catch (error) {
      await this.completeDelivery(
        deliveryId,
        'FAILED',
        error instanceof Error ? error.message : 'Unknown webhook error'
      );
      throw error;
    }
  }

  private static async beginDelivery(
    deliveryId: string | undefined,
    event: string
  ): Promise<{ duplicate: boolean }> {
    if (!deliveryId) {
      // GitHub always sends X-GitHub-Delivery. Manual/test calls may not.
      logger.debug({ event }, 'Webhook received without X-GitHub-Delivery header');
      return { duplicate: false };
    }

    try {
      await prisma.webhookDelivery.create({ data: { deliveryId, event, status: 'RECEIVED' } });
      return { duplicate: false };
    } catch (error) {
      if (isPrismaError(error) && error.code === 'P2002') {
        const existing = await prisma.webhookDelivery.findUnique({ where: { deliveryId } });

        // A failed delivery may be legitimately retried by GitHub.
        if (existing?.status === 'FAILED') {
          await prisma.webhookDelivery.update({
            where: { deliveryId },
            data: { status: 'RECEIVED', error: null },
          });
          return { duplicate: false };
        }

        return { duplicate: true };
      }
      throw error;
    }
  }

  private static async completeDelivery(
    deliveryId: string | undefined,
    status: 'PROCESSED' | 'FAILED',
    error?: string
  ): Promise<void> {
    if (!deliveryId) return;

    try {
      await prisma.webhookDelivery.update({
        where: { deliveryId },
        data: { status, error: error?.slice(0, 2000) ?? null, processedAt: new Date() },
      });
    } catch (updateError) {
      logger.warn({ updateError, deliveryId }, 'Failed to update webhook delivery status');
    }
  }

  private static async dispatch(event: string, rawBody: unknown): Promise<WebhookResult> {
    switch (event) {
      case 'ping':
        return { status: 200, body: { message: 'Pong! Webhook verified and active.' } };

      case 'installation':
      case 'installation_repositories':
        return this.handleInstallationEvent(rawBody);

      case 'pull_request':
        return this.handlePullRequestEvent(rawBody);

      default:
        return { status: 200, body: { message: `Event '${event}' acknowledged` } };
    }
  }

  private static async handleInstallationEvent(rawBody: unknown): Promise<WebhookResult> {
    const parsed = githubInstallationPayloadSchema.safeParse(rawBody);

    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, 'Invalid installation webhook payload');
      return { status: 400, body: { error: 'BAD_REQUEST', message: 'Malformed installation payload' } };
    }

    const payload = parsed.data;
    const installationId = BigInt(payload.installation.id);

    switch (payload.action) {
      case 'created':
      case 'new_permissions_accepted':
      case 'unsuspend': {
        await prisma.installation.upsert({
          where: { installationId },
          update: {
            isSuspended: false,
            ...(payload.installation.account?.login
              ? { accountName: payload.installation.account.login }
              : {}),
          },
          create: {
            installationId,
            accountName: payload.installation.account?.login ?? 'Unknown',
            accountType:
              payload.installation.account?.type === 'Organization' ? 'ORGANIZATION' : 'USER',
          },
        });

        if (payload.action === 'created') {
          GitHubService.syncInstallationRepositories(installationId).catch((error) => {
            logger.error({ error, installationId: installationId.toString() }, 'Background installation repo sync failed');
          });
        }
        break;
      }

      case 'suspend': {
        await prisma.installation.updateMany({
          where: { installationId },
          data: { isSuspended: true },
        });
        break;
      }

      case 'deleted': {
        // Keep audit history but cut off all review processing for the installation.
        await prisma.installation.updateMany({
          where: { installationId },
          data: { isSuspended: true },
        });
        await prisma.repository.updateMany({
          where: { installation: { installationId } },
          data: { webhookActive: false, autoReviewEnabled: false },
        });
        break;
      }

      default:
        break;
    }

    return { status: 200, body: { message: 'Installation event processed' } };
  }

  private static async handlePullRequestEvent(rawBody: unknown): Promise<WebhookResult> {
    const parsed = githubPullRequestPayloadSchema.safeParse(rawBody);

    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, 'Invalid pull_request webhook payload');
      return { status: 400, body: { error: 'BAD_REQUEST', message: 'Malformed pull_request payload' } };
    }

    const payload = parsed.data;
    const { action, pull_request: pr, repository: repo, installation } = payload;

    if (!SUPPORTED_PR_ACTIONS.has(action)) {
      return { status: 200, body: { message: `Ignored unhandled pull_request action: ${action}` } };
    }

    logger.info({ action, prNumber: pr.number, repo: repo.full_name }, 'Processing pull_request webhook');

    // 1. Upsert installation + repository tenant records.
    let dbInstallationId: string | undefined;

    if (installation?.id) {
      const installationRow = await prisma.installation.upsert({
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
      dbInstallationId = installationRow.id;

      if (installationRow.isSuspended) {
        return { status: 200, body: { message: 'Installation is suspended. Skipping review.' } };
      }
    }

    const dbRepo = await prisma.repository.upsert({
      where: { fullName: repo.full_name },
      update: {
        githubRepoId: BigInt(repo.id),
        name: repo.name,
        owner: repo.owner.login,
        isPrivate: repo.private,
        defaultBranch: repo.default_branch,
        ...(dbInstallationId ? { installationId: dbInstallationId } : {}),
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
        ...(dbInstallationId ? { installationId: dbInstallationId } : {}),
      },
    });

    // 2. Persist PR state for every supported action (including `closed`).
    const pullRequestState: 'OPEN' | 'CLOSED' | 'MERGED' =
      pr.state === 'open' ? 'OPEN' : pr.merged ? 'MERGED' : 'CLOSED';

    const dbPr = await prisma.pullRequest.upsert({
      where: { githubPrId: BigInt(pr.id) },
      update: {
        repoId: dbRepo.id,
        number: pr.number,
        title: pr.title,
        state: pullRequestState,
        baseBranch: pr.base.ref,
        headBranch: pr.head.ref,
        headSha: pr.head.sha,
        author: pr.user.login,
        htmlUrl: pr.html_url,
        diffUrl: pr.diff_url ?? null,
      },
      create: {
        githubPrId: BigInt(pr.id),
        number: pr.number,
        title: pr.title,
        state: pullRequestState,
        baseBranch: pr.base.ref,
        headBranch: pr.head.ref,
        headSha: pr.head.sha,
        author: pr.user.login,
        htmlUrl: pr.html_url,
        diffUrl: pr.diff_url ?? null,
        repoId: dbRepo.id,
      },
    });

    if (action === 'closed') {
      return { status: 200, body: { message: 'Pull request closed; review not required.' } };
    }

    // 3. Respect repository-level automation switches.
    if (!env.ENABLE_AUTO_REVIEW || !dbRepo.autoReviewEnabled || !dbRepo.webhookActive) {
      logger.info({ repo: repo.full_name, pr: pr.number }, 'Auto review disabled for this repository');
      return { status: 200, body: { message: 'Auto review is disabled for this repository.' } };
    }

    // 4. Without an installation we cannot authenticate against GitHub.
    if (!installation?.id) {
      logger.warn({ repo: repo.full_name, pr: pr.number }, 'PR webhook missing installation context');
      return {
        status: 200,
        body: { message: 'No GitHub App installation attached. Skipping review.' },
      };
    }

    // 5. Deduplicate: never run two reviews for the same commit.
    const inFlight = await prisma.reviewSession.findFirst({
      where: { prId: dbPr.id, commitSha: pr.head.sha, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      select: { id: true },
    });

    if (inFlight) {
      logger.info(
        { reviewSessionId: inFlight.id, prNumber: pr.number, commitSha: pr.head.sha },
        'Review already in flight for this commit; not enqueuing a duplicate'
      );
      return {
        status: 202,
        body: {
          message: 'Review already queued for this commit',
          reviewSessionId: inFlight.id,
          prNumber: pr.number,
          commitSha: pr.head.sha,
        },
      };
    }

    if (action !== 'reopened') {
      const alreadyReviewed = await prisma.reviewSession.findFirst({
        where: { prId: dbPr.id, commitSha: pr.head.sha, status: 'COMPLETED' },
        select: { id: true },
      });

      if (alreadyReviewed) {
        logger.info(
          { reviewSessionId: alreadyReviewed.id, prNumber: pr.number },
          'Commit already reviewed; skipping duplicate review'
        );
        return {
          status: 200,
          body: {
            message: 'Commit already reviewed',
            reviewSessionId: alreadyReviewed.id,
            prNumber: pr.number,
            commitSha: pr.head.sha,
          },
        };
      }
    }

    // 6. Create the session and enqueue background processing.
    const reviewSession = await prisma.reviewSession.create({
      data: { prId: dbPr.id, commitSha: pr.head.sha, status: 'PENDING' },
    });

    ReviewWorker.getInstance().enqueue({
      reviewSessionId: reviewSession.id,
      repoFullName: repo.full_name,
      pullNumber: pr.number,
      commitSha: pr.head.sha,
      installationId: BigInt(installation.id),
    });

    return {
      status: 202,
      body: {
        message: 'Pull request review enqueued for background processing',
        reviewSessionId: reviewSession.id,
        prNumber: pr.number,
        commitSha: pr.head.sha,
      },
    };
  }
}
