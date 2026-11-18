import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, connectDatabase, disconnectDatabase } from '../src/db/prisma.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { GitHubService } from '../src/modules/github/github.service.js';

describe('Phase 2: Authentication & Repository Management Integration Tests', () => {
  const app = createApp();
  let testUserId: string;
  let testUserToken: string;
  let testRepoId: string;

  beforeAll(async () => {
    await connectDatabase();

    // Create a mock test user in database
    const user = await prisma.user.upsert({
      where: { githubId: 'test_gh_user_999' },
      update: {},
      create: {
        githubId: 'test_gh_user_999',
        username: 'testdeveloper',
        name: 'Test Developer',
        email: 'dev@example.com',
        avatarUrl: 'https://avatars.githubusercontent.com/u/999',
      },
    });

    testUserId = user.id;
    testUserToken = AuthService.signToken({
      userId: user.id,
      githubId: user.githubId,
      username: user.username,
    });

    // Create a mock test repository
    const repo = await prisma.repository.upsert({
      where: { fullName: 'testdeveloper/sample-project' },
      update: {},
      create: {
        githubRepoId: BigInt(888999),
        name: 'sample-project',
        fullName: 'testdeveloper/sample-project',
        owner: 'testdeveloper',
        isPrivate: false,
        defaultBranch: 'main',
        webhookActive: true,
        autoReviewEnabled: true,
        customPrompt: 'Focus on TypeScript strict types and test coverage.',
        ownerUserId: user.id,
      },
    });

    testRepoId = repo.id;
  });

  afterAll(async () => {
    // Clean up test data
    await prisma.repository.deleteMany({ where: { githubRepoId: BigInt(888999) } });
    await prisma.user.deleteMany({ where: { githubId: 'test_gh_user_999' } });
    await disconnectDatabase();
  });

  describe('Auth Service & Endpoints', () => {
    it('should generate valid GitHub OAuth login URL with expected params', () => {
      const url = AuthService.generateGithubAuthUrl('state_test_xyz');
      expect(url).toContain('https://github.com/login/oauth/authorize');
      expect(url).toContain('scope=read%3Auser+user%3Aemail+repo');
      expect(url).toContain('state=state_test_xyz');
    });

    it('should sign and verify JWT tokens accurately', () => {
      const payload = {
        userId: 'uuid-1234',
        githubId: '54321',
        username: 'octocat',
      };
      const token = AuthService.signToken(payload);
      expect(token).toBeDefined();

      const decoded = AuthService.verifyToken(token);
      expect(decoded.userId).toBe('uuid-1234');
      expect(decoded.githubId).toBe('54321');
      expect(decoded.username).toBe('octocat');
    });

    it('GET /api/auth/me should reject unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('GET /api/auth/me should return user details when Bearer token is provided', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${testUserToken}`);

      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.id).toBe(testUserId);
      expect(res.body.user.username).toBe('testdeveloper');
      expect(res.body.user.email).toBe('dev@example.com');
    });

    it('GET /api/auth/me should return user details when token cookie is provided', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`token=${testUserToken}`]);

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(testUserId);
    });

    it('POST /api/auth/logout should clear session cookie', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Logged out successfully');
    });
  });

  describe('Repository Management Endpoints', () => {
    it('GET /api/repositories should reject unauthenticated requests with 401', async () => {
      const res = await request(app).get('/api/repositories');
      expect(res.status).toBe(401);
    });

    it('GET /api/repositories should return repository list', async () => {
      const res = await request(app)
        .get('/api/repositories')
        .set('Authorization', `Bearer ${testUserToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.repositories)).toBe(true);

      const found = res.body.repositories.find(
        (r: { id: string }) => r.id === testRepoId
      );
      expect(found).toBeDefined();
      expect(found.fullName).toBe('testdeveloper/sample-project');
    });

    it('GET /api/repositories/:id should return single repository details', async () => {
      const res = await request(app)
        .get(`/api/repositories/${testRepoId}`)
        .set('Authorization', `Bearer ${testUserToken}`);
      expect(res.status).toBe(200);
      expect(res.body.repository).toBeDefined();
      expect(res.body.repository.id).toBe(testRepoId);
      expect(res.body.repository.name).toBe('sample-project');
      expect(res.body.repository.autoReviewEnabled).toBe(true);
    });

    it('PATCH /api/repositories/:id should reject unauthenticated modification', async () => {
      const res = await request(app)
        .patch(`/api/repositories/${testRepoId}`)
        .send({ autoReviewEnabled: false });

      expect(res.status).toBe(401);
    });

    it('PATCH /api/repositories/:id should update autoReviewEnabled and customPrompt when authenticated', async () => {
      const updatedPrompt = 'Strictly enforce OWASP Top 10 security standards.';

      const res = await request(app)
        .patch(`/api/repositories/${testRepoId}`)
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          autoReviewEnabled: false,
          customPrompt: updatedPrompt,
        });

      expect(res.status).toBe(200);
      expect(res.body.repository.autoReviewEnabled).toBe(false);
      expect(res.body.repository.customPrompt).toBe(updatedPrompt);

      // Verify in DB
      const dbRepo = await prisma.repository.findUnique({ where: { id: testRepoId } });
      expect(dbRepo?.autoReviewEnabled).toBe(false);
      expect(dbRepo?.customPrompt).toBe(updatedPrompt);
    });

    it('GET /api/repositories/:id with unknown ID should return 404', async () => {
      const res = await request(app)
        .get('/api/repositories/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${testUserToken}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Repository not found');
    });

    it('GET /api/repositories/:id with a malformed ID should return 400', async () => {
      const res = await request(app)
        .get('/api/repositories/not-a-uuid')
        .set('Authorization', `Bearer ${testUserToken}`);
      expect(res.status).toBe(400);
    });
  });

  describe('GitHub App Service', () => {
    it('should initialize App Octokit client with configured credentials', () => {
      const appOctokit = GitHubService.getAppOctokit();
      expect(appOctokit).toBeDefined();
      expect(appOctokit.apps).toBeDefined();
      expect(appOctokit.pulls).toBeDefined();
    });

    it('should initialize Installation Octokit client', () => {
      const installationOctokit = GitHubService.getInstallationOctokit(12345678);
      expect(installationOctokit).toBeDefined();
      expect(installationOctokit.pulls).toBeDefined();
      expect(installationOctokit.repos).toBeDefined();
    });
  });
});
