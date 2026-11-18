import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, connectDatabase, disconnectDatabase } from '../src/db/prisma.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { ReviewPublisherService } from '../src/modules/reviews/review-publisher.service.js';

describe('Phase 5: Review Automation & GitHub Publishing Integration Tests', () => {
  const app = createApp();
  let testUserToken: string;
  let testRepoId: string;
  let testPrId: string;
  let testSessionId: string;

  beforeAll(async () => {
    await connectDatabase();

    // Create test user and token
    const user = await prisma.user.upsert({
      where: { githubId: 'gh_user_phase5' },
      update: {},
      create: {
        githubId: 'gh_user_phase5',
        username: 'phase5reviewer',
        email: 'reviewer@example.com',
      },
    });

    testUserToken = AuthService.signToken({
      userId: user.id,
      githubId: user.githubId,
      username: user.username,
    });

    // Create test installation and repo
    const installation = await prisma.installation.upsert({
      where: { installationId: BigInt(998877) },
      update: {},
      create: {
        installationId: BigInt(998877),
        accountName: 'bonssss',
        accountType: 'USER',
      },
    });

    const repo = await prisma.repository.upsert({
      where: { fullName: 'bonssss/test-repo-phase5' },
      update: {},
      create: {
        githubRepoId: BigInt(99887711),
        name: 'test-repo-phase5',
        fullName: 'bonssss/test-repo-phase5',
        owner: 'bonssss',
        installationId: installation.id,
      },
    });
    testRepoId = repo.id;

    // Grant the user tenant access to this installation.
    await prisma.userInstallation.upsert({
      where: {
        userId_installationId: { userId: user.id, installationId: installation.id },
      },
      update: {},
      create: { userId: user.id, installationId: installation.id },
    });

    const pr = await prisma.pullRequest.upsert({
      where: { githubPrId: BigInt(555444) },
      update: {},
      create: {
        githubPrId: BigInt(555444),
        number: 1,
        title: 'feat: add secure token verification',
        state: 'OPEN',
        baseBranch: 'main',
        headBranch: 'feat/tokens',
        headSha: 'head_sha_9999',
        author: 'bonssss',
        htmlUrl: 'https://github.com/bonssss/pr-reviewer/pull/1',
        repoId: repo.id,
      },
    });
    testPrId = pr.id;

    // Create review session with comments
    const session = await prisma.reviewSession.create({
      data: {
        prId: pr.id,
        commitSha: 'head_sha_9999',
        status: 'COMPLETED',
        summary: 'Identified an unprotected secret and missing input validation.',
        riskScore: 78,
        recommendation: 'REQUEST_CHANGES',
        totalIssues: 2,
        criticalIssues: 1,
        highIssues: 1,
        mediumIssues: 0,
        lowIssues: 0,
        aiModel: 'gpt-4o-mini',
        comments: {
          create: [
            {
              filePath: 'src/config/jwt.ts',
              lineNumber: 14,
              side: 'RIGHT',
              severity: 'CRITICAL',
              category: 'SECURITY',
              title: 'Hardcoded JWT Secret',
              message: 'Default fallback secret key is checked into version control.',
              suggestion: 'const secret = process.env.JWT_SECRET;',
            },
            {
              filePath: 'src/routes/auth.ts',
              lineNumber: 45,
              side: 'RIGHT',
              severity: 'HIGH',
              category: 'BUG',
              title: 'Unchecked Null Dereference',
              message: 'req.user is dereferenced without verifying authentication status.',
              suggestion: 'if (!req.user) return res.status(401).json({ error: "Unauthorized" });',
            },
          ],
        },
      },
    });
    testSessionId = session.id;
  });

  afterAll(async () => {
    await prisma.reviewComment.deleteMany({ where: { reviewSession: { prId: testPrId } } });
    await prisma.reviewSession.deleteMany({ where: { prId: testPrId } });
    await prisma.pullRequest.deleteMany({ where: { id: testPrId } });
    await prisma.repository.deleteMany({ where: { id: testRepoId } });
    await prisma.installation.deleteMany({ where: { installationId: BigInt(998877) } });
    await prisma.user.deleteMany({ where: { githubId: 'gh_user_phase5' } });
    await disconnectDatabase();
  });

  describe('Markdown Review Formatting', () => {
    it('should format PR summary with badges, tables, and risk scores', () => {
      const summaryMarkdown = ReviewPublisherService.formatReviewSummaryMarkdown({
        summary: 'All checks passed cleanly.',
        riskScore: 10,
        recommendation: 'APPROVE',
        criticalIssues: 0,
        highIssues: 0,
        mediumIssues: 0,
        lowIssues: 1,
        totalIssues: 1,
        aiModel: 'gpt-4o-mini',
      });

      expect(summaryMarkdown).toContain('## 🤖 AI Pull Request Review');
      expect(summaryMarkdown).toContain('🟢 **APPROVE**');
      expect(summaryMarkdown).toContain('**10/100** (🟢 Low Risk)');
      expect(summaryMarkdown).toContain('All checks passed cleanly.');
      expect(summaryMarkdown).toContain('| **Critical Issues** | 🚨 **0** |');
    });

    it('should format inline comment with severity icon, category, and code suggestion', () => {
      const commentMarkdown = ReviewPublisherService.formatInlineCommentMarkdown({
        title: 'SQL Injection Vulnerability',
        severity: 'CRITICAL',
        category: 'SECURITY',
        message: 'Direct string concatenation in SQL query.',
        suggestion: 'SELECT * FROM users WHERE id = $1',
      });

      expect(commentMarkdown).toContain('### 🚨 [CRITICAL] SQL Injection Vulnerability (`SECURITY`)');
      expect(commentMarkdown).toContain('Direct string concatenation in SQL query.');
      expect(commentMarkdown).toContain('```suggestion');
      expect(commentMarkdown).toContain('SELECT * FROM users WHERE id = $1');
      expect(commentMarkdown).toContain('```');
    });
  });

  describe('GitHub Publishing & Duplicate Prevention', () => {
    it('should publish review session to GitHub and update published flags', async () => {
      const result = await ReviewPublisherService.publishReviewToGitHub(testSessionId);

      expect(result.published).toBe(true);
      expect(result.publishedCommentsCount).toBe(2);

      // Verify DB comment status
      const comments = await prisma.reviewComment.findMany({
        where: { reviewSessionId: testSessionId },
      });
      expect(comments.length).toBe(2);
      expect(comments.every((c) => c.publishedToGithub)).toBe(true);
    });
  });

  describe('Review REST API Endpoints', () => {
    it('GET /api/reviews/session/:sessionId should return review report with comments', async () => {
      const res = await request(app)
        .get(`/api/reviews/session/${testSessionId}`)
        .set('Authorization', `Bearer ${testUserToken}`);

      expect(res.status).toBe(200);
      expect(res.body.session).toBeDefined();
      expect(res.body.session.id).toBe(testSessionId);
      expect(res.body.session.riskScore).toBe(78);
      expect(res.body.session.recommendation).toBe('REQUEST_CHANGES');
      expect(res.body.session.comments.length).toBe(2);
    });

    it('GET /api/reviews/session/:sessionId with unknown ID should return 404', async () => {
      const res = await request(app)
        .get('/api/reviews/session/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${testUserToken}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Review session not found');
    });

    it('GET /api/reviews/session/:sessionId with malformed ID should return 400', async () => {
      const res = await request(app)
        .get('/api/reviews/session/non-existent-uuid-0000')
        .set('Authorization', `Bearer ${testUserToken}`);
      expect(res.status).toBe(400);
    });

    it('GET /api/reviews/pr/:prId/history should return historical sessions', async () => {
      const res = await request(app)
        .get(`/api/reviews/pr/${testPrId}/history`)
        .set('Authorization', `Bearer ${testUserToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.history)).toBe(true);
      expect(res.body.history.length).toBeGreaterThanOrEqual(1);
      expect(res.body.history[0]?.id).toBe(testSessionId);
    });

    it('POST /api/reviews/pr/:prId/rerun should reject unauthenticated request', async () => {
      const res = await request(app).post(`/api/reviews/pr/${testPrId}/rerun`);
      expect(res.status).toBe(401);
    });

    it('POST /api/reviews/pr/:prId/rerun should enqueue new review session when authenticated', async () => {
      const res = await request(app)
        .post(`/api/reviews/pr/${testPrId}/rerun`)
        .set('Authorization', `Bearer ${testUserToken}`);

      expect(res.status).toBe(202);
      expect(res.body.message).toContain('Re-review requested');
      expect(res.body.reviewSession).toBeDefined();
      expect(res.body.reviewSession.status).toBe('PENDING');

      // Check that historical sessions now have at least 2 sessions
      const historyRes = await request(app)
        .get(`/api/reviews/pr/${testPrId}/history`)
        .set('Authorization', `Bearer ${testUserToken}`);
      expect(historyRes.body.history.length).toBeGreaterThanOrEqual(2);
    });

    it('POST /api/reviews/session/:sessionId/publish should publish review when authenticated', async () => {
      const res = await request(app)
        .post(`/api/reviews/session/${testSessionId}/publish`)
        .set('Authorization', `Bearer ${testUserToken}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('published to GitHub');
      expect(res.body.result.published).toBe(true);
    });
  });
});
