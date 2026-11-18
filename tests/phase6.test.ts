import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, connectDatabase, disconnectDatabase } from '../src/db/prisma.js';

describe('Phase 6: Web Dashboard Integration Tests', () => {
  const app = createApp();
  let testRepoId: string;
  let testPrId: string;
  let testSessionId: string;

  beforeAll(async () => {
    await connectDatabase();

    // Create seed repository, PR, and completed review session
    const repo = await prisma.repository.upsert({
      where: { githubRepoId: BigInt(771122) },
      update: {},
      create: {
        githubRepoId: BigInt(771122),
        name: 'dashboard-test-repo',
        fullName: 'bonssss/dashboard-test-repo',
        owner: 'bonssss',
        isPrivate: false,
        autoReviewEnabled: true,
      },
    });
    testRepoId = repo.id;

    const pr = await prisma.pullRequest.upsert({
      where: { githubPrId: BigInt(882233) },
      update: {},
      create: {
        githubPrId: BigInt(882233),
        number: 12,
        title: 'fix: patch SQL injection vulnerability in search',
        state: 'OPEN',
        baseBranch: 'main',
        headBranch: 'fix/sqli',
        headSha: 'head_sha_dashboard_12',
        author: 'bonssss',
        htmlUrl: 'https://github.com/bonssss/dashboard-test-repo/pull/12',
        repoId: repo.id,
      },
    });
    testPrId = pr.id;

    const session = await prisma.reviewSession.create({
      data: {
        prId: pr.id,
        commitSha: 'head_sha_dashboard_12',
        status: 'COMPLETED',
        summary: 'Security vulnerability resolved. LGTM.',
        riskScore: 20,
        recommendation: 'APPROVE',
        totalIssues: 1,
        criticalIssues: 0,
        highIssues: 0,
        mediumIssues: 0,
        lowIssues: 1,
        aiModel: 'gpt-4o-mini',
      },
    });
    testSessionId = session.id;
  });

  afterAll(async () => {
    await prisma.reviewSession.deleteMany({ where: { id: testSessionId } });
    await prisma.pullRequest.deleteMany({ where: { id: testPrId } });
    await prisma.repository.deleteMany({ where: { id: testRepoId } });
    await disconnectDatabase();
  });

  describe('Dashboard REST APIs', () => {
    it('GET /api/dashboard/stats should return aggregated KPI metrics', async () => {
      const res = await request(app).get('/api/dashboard/stats');

      expect(res.status).toBe(200);
      expect(res.body.stats).toBeDefined();

      const stats = res.body.stats;
      expect(stats.totalRepositories).toBeGreaterThanOrEqual(1);
      expect(stats.totalPullRequests).toBeGreaterThanOrEqual(1);
      expect(stats.totalReviews).toBeGreaterThanOrEqual(1);
      expect(stats.averageRiskScore).toBeDefined();
      expect(stats.recommendations).toBeDefined();
      expect(Array.isArray(stats.recentReviews)).toBe(true);

      const foundReview = stats.recentReviews.find((r: { id: string }) => r.id === testSessionId);
      expect(foundReview).toBeDefined();
      expect(foundReview.repoFullName).toBe('bonssss/dashboard-test-repo');
      expect(foundReview.recommendation).toBe('APPROVE');
    });

    it('GET /api/dashboard/prs should return pull requests with latest review sessions', async () => {
      const res = await request(app).get('/api/dashboard/prs');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.pullRequests)).toBe(true);

      const foundPr = res.body.pullRequests.find((p: { id: string }) => p.id === testPrId);
      expect(foundPr).toBeDefined();
      expect(foundPr.title).toContain('patch SQL injection');
      expect(foundPr.repository.fullName).toBe('bonssss/dashboard-test-repo');
      expect(foundPr.reviewSessions[0]?.recommendation).toBe('APPROVE');
    });

    it('GET /api/dashboard/prs with search query should filter pull requests', async () => {
      const res = await request(app).get('/api/dashboard/prs?search=injection');

      expect(res.status).toBe(200);
      expect(res.body.pullRequests.length).toBeGreaterThanOrEqual(1);
      expect(res.body.pullRequests[0].title).toContain('SQL injection');
    });
  });

  describe('Static Dashboard UI Serving', () => {
    it('GET /dashboard should serve the modern dashboard HTML page', async () => {
      const res = await request(app).get('/dashboard');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('AI Pull Request Reviewer - Dashboard');
      expect(res.text).toContain('view-overview');
      expect(res.text).toContain('view-repositories');
      expect(res.text).toContain('view-pull-requests');
    });

    it('GET / with Accept: text/html should return the dashboard HTML', async () => {
      const res = await request(app)
        .get('/')
        .set('Accept', 'text/html');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('AI PR Reviewer');
    });

    it('GET / with Accept: application/json should return JSON API metadata', async () => {
      const res = await request(app)
        .get('/')
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body.name).toBe('AI-Powered GitHub Pull Request Reviewer API');
      expect(res.body.dashboard).toBe('/dashboard');
    });
  });
});
