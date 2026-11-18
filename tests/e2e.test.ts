import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, connectDatabase, disconnectDatabase } from '../src/db/prisma.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { WebhookVerifier } from '../src/webhooks/webhook.verifier.js';
import { env } from '../src/config/env.js';
import { ReviewService } from '../src/modules/reviews/review.service.js';
import { DiffParser } from '../src/utils/diff.parser.js';
import { AIService } from '../src/modules/ai/ai.service.js';
import { ReviewPublisherService } from '../src/modules/reviews/review-publisher.service.js';

describe('Phase 7: End-to-End Pull Request Review Lifecycle Test', () => {
  const app = createApp();
  const testSecret = env.GITHUB_WEBHOOK_SECRET || 'development_webhook_secret_key';

  const mockGithubRepoId = BigInt(99119911);
  const mockGithubPrId = BigInt(88228822);
  const mockInstallationId = BigInt(77337733);
  let testUserToken: string;
  let repoDbId: string;
  let prDbId: string;
  let reviewSessionId: string;

  beforeAll(async () => {
    await connectDatabase();

    // 1. Create developer user
    const user = await prisma.user.upsert({
      where: { githubId: 'e2e_lead_developer' },
      update: {},
      create: {
        githubId: 'e2e_lead_developer',
        username: 'leaddev',
        email: 'lead@example.com',
      },
    });

    testUserToken = AuthService.signToken({
      userId: user.id,
      githubId: user.githubId,
      username: user.username,
    });
  });

  afterAll(async () => {
    // Teardown E2E test entities
    if (prDbId) {
      await prisma.reviewComment.deleteMany({ where: { reviewSession: { prId: prDbId } } });
      await prisma.reviewSession.deleteMany({ where: { prId: prDbId } });
      await prisma.pullRequest.deleteMany({ where: { id: prDbId } });
    }
    if (repoDbId) {
      await prisma.repository.deleteMany({ where: { id: repoDbId } });
    }
    await prisma.installation.deleteMany({ where: { installationId: mockInstallationId } });
    await prisma.user.deleteMany({ where: { githubId: 'e2e_lead_developer' } });
    await disconnectDatabase();
  });

  it('Step 1: GitHub App connects repository via installation setup', async () => {
    const installation = await prisma.installation.upsert({
      where: { installationId: mockInstallationId },
      update: {},
      create: {
        installationId: mockInstallationId,
        accountName: 'e2e-org',
        accountType: 'ORGANIZATION',
      },
    });

    const repo = await prisma.repository.upsert({
      where: { fullName: 'e2e-org/e2e-pr-reviewer' },
      update: {},
      create: {
        githubRepoId: mockGithubRepoId,
        name: 'e2e-pr-reviewer',
        fullName: 'e2e-org/e2e-pr-reviewer',
        owner: 'e2e-org',
        installationId: installation.id,
        autoReviewEnabled: true,
      },
    });

    repoDbId = repo.id;
    expect(repo.id).toBeDefined();
    expect(repo.fullName).toBe('e2e-org/e2e-pr-reviewer');
  });

  it('Step 2: Developer configures custom review rules for the repository', async () => {
    const customPrompt = 'Enforce OWASP Top 10 standards and avoid console.log statements.';

    const res = await request(app)
      .patch(`/api/repositories/${repoDbId}`)
      .set('Authorization', `Bearer ${testUserToken}`)
      .send({
        customPrompt,
        autoReviewEnabled: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.repository.customPrompt).toBe(customPrompt);
    expect(res.body.repository.autoReviewEnabled).toBe(true);
  });

  it('Step 3: GitHub webhook fires pull_request.opened event with signed HMAC', async () => {
    const prPayload = {
      action: 'opened',
      number: 88,
      pull_request: {
        id: Number(mockGithubPrId),
        number: 88,
        title: 'feat: add database backup routine',
        state: 'open',
        html_url: 'https://github.com/e2e-org/e2e-pr-reviewer/pull/88',
        diff_url: 'https://github.com/e2e-org/e2e-pr-reviewer/pull/88.diff',
        user: { login: 'contributor', id: 500 },
        base: { ref: 'main', sha: 'base_sha_e2e_001' },
        head: { ref: 'feat/backup', sha: 'head_sha_e2e_002' },
      },
      repository: {
        id: Number(mockGithubRepoId),
        name: 'e2e-pr-reviewer',
        full_name: 'e2e-org/e2e-pr-reviewer',
        owner: { login: 'e2e-org', id: 100, type: 'Organization' },
        private: false,
        default_branch: 'main',
      },
      installation: { id: Number(mockInstallationId), node_id: 'inst_node_e2e' },
      sender: { login: 'contributor', id: 500 },
    };

    const payloadString = JSON.stringify(prPayload);
    const signature = WebhookVerifier.computeSignature(payloadString, testSecret);

    const res = await request(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .set('X-GitHub-Event', 'pull_request')
      .send(payloadString);

    expect(res.status).toBe(202);
    expect(res.body.message).toContain('Pull request review enqueued');
    expect(res.body.reviewSessionId).toBeDefined();

    reviewSessionId = res.body.reviewSessionId;

    // Verify DB entities
    const dbPr = await prisma.pullRequest.findUnique({
      where: { githubPrId: mockGithubPrId },
    });
    expect(dbPr).toBeDefined();
    prDbId = dbPr!.id;
  });

  it('Step 4: AI Engine processes code changes, validates schema, and writes findings', async () => {
    const mockDiffFiles = [
      {
        filename: 'src/backup/engine.ts',
        status: 'added',
        additions: 12,
        deletions: 0,
        changes: 12,
        patch: '@@ -0,0 +1,12 @@\n+export function runBackup() {\n+  const password = "prod_database_secret_pass";\n+  console.log("running backup");\n+}\n',
      },
      {
        filename: 'package-lock.json',
        status: 'modified',
        additions: 200,
        deletions: 20,
        changes: 220,
        patch: '@@ -1,5 +1,5 @@\n',
      },
    ];

    const diffSummary = DiffParser.parseGitHubFiles(mockDiffFiles);
    expect(diffSummary.reviewableFiles).toBe(1); // Lockfile was excluded

    const result = await AIService.reviewPullRequest({
      reviewSessionId,
      prTitle: 'feat: add database backup routine',
      prNumber: 88,
      author: 'contributor',
      baseBranch: 'main',
      headBranch: 'feat/backup',
      diffSummary,
      customPrompt: 'Avoid hardcoded credentials.',
    });

    expect(result.reviewSessionId).toBe(reviewSessionId);
    expect(result.recommendation).toBe('REQUEST_CHANGES');
    expect(result.criticalIssues).toBeGreaterThanOrEqual(1);
    expect(result.riskScore).toBeGreaterThanOrEqual(80);

    // Verify ReviewComment entities created in database
    const comments = await prisma.reviewComment.findMany({
      where: { reviewSessionId },
    });
    expect(comments.length).toBe(result.totalIssues);
    const criticalComment = comments.find((c) => c.severity === 'CRITICAL');
    expect(criticalComment).toBeDefined();
    expect(criticalComment?.filePath).toBe('src/backup/engine.ts');
  });

  it('Step 5: Review publisher formats summary and marks published comments', async () => {
    const publishResult = await ReviewPublisherService.publishReviewToGitHub(reviewSessionId);

    expect(publishResult.published).toBe(true);
    expect(publishResult.publishedCommentsCount).toBeGreaterThanOrEqual(1);

    const comments = await prisma.reviewComment.findMany({
      where: { reviewSessionId },
    });
    expect(comments.every((c) => c.publishedToGithub)).toBe(true);
  });

  it('Step 6: Dashboard APIs report updated metrics and review session details', async () => {
    // 1. Dashboard Overview Stats
    const statsRes = await request(app).get('/api/dashboard/stats');
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.stats.totalReviews).toBeGreaterThanOrEqual(1);
    expect(statsRes.body.stats.criticalIssues).toBeGreaterThanOrEqual(1);

    // 2. Single Review Session Report
    const sessionRes = await request(app).get(`/api/reviews/session/${reviewSessionId}`);
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.body.session.id).toBe(reviewSessionId);
    expect(sessionRes.body.session.recommendation).toBe('REQUEST_CHANGES');
    expect(sessionRes.body.session.comments.length).toBeGreaterThanOrEqual(1);

    // 3. Static Web Dashboard Delivery
    const htmlRes = await request(app).get('/dashboard');
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.text).toContain('AI Pull Request Reviewer - Dashboard');
  });

  it('Step 7: Developer requests manual re-review, initiating new session', async () => {
    const rerunRes = await request(app)
      .post(`/api/reviews/pr/${prDbId}/rerun`)
      .set('Authorization', `Bearer ${testUserToken}`);

    expect(rerunRes.status).toBe(202);
    expect(rerunRes.body.message).toContain('Re-review requested');
    expect(rerunRes.body.reviewSession.status).toBe('PENDING');

    // Verify historical audit trail
    const history = await ReviewService.getPrReviewHistory(prDbId);
    expect(history.length).toBeGreaterThanOrEqual(2);
  });
});
