import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, connectDatabase, disconnectDatabase } from '../src/db/prisma.js';
import { WebhookVerifier } from '../src/webhooks/webhook.verifier.js';
import { DiffParser } from '../src/utils/diff.parser.js';
import { env } from '../src/config/env.js';

describe('Phase 3: GitHub Webhooks & Diff Processing Integration Tests', () => {
  const app = createApp();
  const testSecret = env.GITHUB_WEBHOOK_SECRET || 'development_webhook_secret_key';

  beforeAll(async () => {
    await connectDatabase();

    // Remove leftovers from an interrupted previous run so assertions are stable.
    await prisma.reviewComment.deleteMany({
      where: { reviewSession: { pullRequest: { githubPrId: BigInt(777123) } } },
    });
    await prisma.reviewSession.deleteMany({
      where: { pullRequest: { githubPrId: BigInt(777123) } },
    });
    await prisma.pullRequest.deleteMany({ where: { githubPrId: BigInt(777123) } });
    await prisma.repository.deleteMany({ where: { githubRepoId: BigInt(999888) } });
    await prisma.repository.deleteMany({ where: { githubRepoId: BigInt(666555) } });
  });

  afterAll(async () => {
    // Clean up test database records created during webhook tests
    await prisma.reviewSession.deleteMany({
      where: { pullRequest: { githubPrId: BigInt(777123) } },
    });
    await prisma.pullRequest.deleteMany({ where: { githubPrId: BigInt(777123) } });
    await prisma.repository.deleteMany({ where: { githubRepoId: BigInt(999888) } });
    await prisma.repository.deleteMany({ where: { githubRepoId: BigInt(666555) } });
    await disconnectDatabase();
  });

  describe('Webhook Signature Verification', () => {
    it('should compute and verify valid HMAC-SHA256 signature', () => {
      const payload = JSON.stringify({ hello: 'world' });
      const signature = WebhookVerifier.computeSignature(payload, testSecret);

      const isValid = WebhookVerifier.verifySignature(payload, signature, testSecret);
      expect(isValid).toBe(true);
    });

    it('should reject mismatched payload or invalid secret', () => {
      const payload = JSON.stringify({ hello: 'world' });
      const signature = WebhookVerifier.computeSignature(payload, testSecret);

      const invalidPayloadCheck = WebhookVerifier.verifySignature(
        JSON.stringify({ hello: 'tampered' }),
        signature,
        testSecret
      );
      expect(invalidPayloadCheck).toBe(false);

      const invalidSecretCheck = WebhookVerifier.verifySignature(
        payload,
        signature,
        'wrong_secret'
      );
      expect(invalidSecretCheck).toBe(false);
    });

    it('should reject missing or empty signature', () => {
      const isValid = WebhookVerifier.verifySignature('{}', undefined, testSecret);
      expect(isValid).toBe(false);
    });
  });

  describe('Diff Parser Utility', () => {
    it('should identify generated lockfiles and binary files to ignore', () => {
      expect(DiffParser.shouldIgnoreFile('package-lock.json').ignore).toBe(true);
      expect(DiffParser.shouldIgnoreFile('pnpm-lock.yaml').ignore).toBe(true);
      expect(DiffParser.shouldIgnoreFile('yarn.lock').ignore).toBe(true);
      expect(DiffParser.shouldIgnoreFile('dist/bundle.min.js').ignore).toBe(true);
      expect(DiffParser.shouldIgnoreFile('assets/logo.svg').ignore).toBe(true);
      expect(DiffParser.shouldIgnoreFile('src/auth.ts').ignore).toBe(false);
      expect(DiffParser.shouldIgnoreFile('client/components/Button.tsx').ignore).toBe(false);
    });

    it('should parse changed files list and generate metrics', () => {
      const mockFiles = [
        {
          filename: 'src/server.ts',
          status: 'modified',
          additions: 15,
          deletions: 3,
          changes: 18,
          patch: '@@ -1,3 +1,15 @@\n+import express from "express";\n',
        },
        {
          filename: 'package-lock.json',
          status: 'modified',
          additions: 250,
          deletions: 50,
          changes: 300,
          patch: '@@ -1,5 +1,5 @@\n',
        },
        {
          filename: 'docs/arch.png',
          status: 'added',
          additions: 0,
          deletions: 0,
          changes: 0,
        },
      ];

      const summary = DiffParser.parseGitHubFiles(mockFiles);

      expect(summary.totalFiles).toBe(3);
      expect(summary.reviewableFiles).toBe(1); // Only src/server.ts is reviewable
      expect(summary.totalAdditions).toBe(265);
      expect(summary.totalDeletions).toBe(53);
      expect(summary.files[0]?.isIgnored).toBe(false);
      expect(summary.files[1]?.isIgnored).toBe(true);
      expect(summary.files[2]?.isIgnored).toBe(true);
    });

    it('should accurately extract hunk new line numbers', () => {
      const patch = `@@ -10,3 +20,4 @@
 context line
+added line 1
+added line 2
 context end`;

      const lines = DiffParser.extractHunkLines(patch);
      expect(lines.length).toBe(2);
      expect(lines[0]?.newNumber).toBe(21);
      expect(lines[0]?.content).toBe('added line 1');
      expect(lines[1]?.newNumber).toBe(22);
      expect(lines[1]?.content).toBe('added line 2');
    });
  });

  describe('GitHub Webhook Endpoint Handling', () => {
    it('POST /api/webhooks/github should reject requests with missing signature (401)', async () => {
      const res = await request(app)
        .post('/api/webhooks/github')
        .send({ zen: 'Mind your words.' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('POST /api/webhooks/github should reject requests with invalid signature (401)', async () => {
      const payload = JSON.stringify({ zen: 'Mind your words.' });
      const res = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', 'sha256=invalid_hex_string_1234567890abcdef')
        .set('X-GitHub-Event', 'ping')
        .send(payload);

      expect(res.status).toBe(401);
    });

    it('POST /api/webhooks/github should accept ping events with valid signature (200)', async () => {
      const payload = JSON.stringify({ zen: 'Mind your words.' });
      const signature = WebhookVerifier.computeSignature(payload, testSecret);

      const res = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .set('X-GitHub-Event', 'ping')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Pong!');
    });

    it('POST /api/webhooks/github should handle pull_request.opened event (202 Accepted)', async () => {
      const prPayload = {
        action: 'opened',
        number: 42,
        pull_request: {
          id: 777123,
          number: 42,
          title: 'feat: add user authentication',
          state: 'open',
          html_url: 'https://github.com/acme/backend/pull/42',
          diff_url: 'https://github.com/acme/backend/pull/42.diff',
          user: {
            login: 'octocat',
            id: 1,
          },
          base: {
            ref: 'main',
            sha: 'base_sha_001',
          },
          head: {
            ref: 'feature/auth',
            sha: 'head_sha_002',
          },
        },
        repository: {
          id: 999888,
          name: 'backend',
          full_name: 'acme/backend',
          owner: {
            login: 'acme',
            id: 2,
            type: 'Organization',
          },
          private: false,
          default_branch: 'main',
        },
        installation: {
          id: 554433,
          node_id: 'node_554433',
        },
        sender: {
          login: 'octocat',
          id: 1,
        },
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
      expect(res.body.prNumber).toBe(42);
      expect(res.body.commitSha).toBe('head_sha_002');
      expect(res.body.reviewSessionId).toBeDefined();

      // Verify PR was created in DB
      const dbPr = await prisma.pullRequest.findUnique({
        where: { githubPrId: BigInt(777123) },
        include: { reviewSessions: true },
      });

      expect(dbPr).toBeDefined();
      expect(dbPr?.number).toBe(42);
      expect(dbPr?.title).toBe('feat: add user authentication');
      expect(dbPr?.reviewSessions.length).toBeGreaterThan(0);
      expect(dbPr?.reviewSessions[0]?.commitSha).toBe('head_sha_002');
    });

    it('POST /api/webhooks/github should skip review when autoReviewEnabled is disabled', async () => {
      // Create repository with autoReviewEnabled = false
      const repo = await prisma.repository.upsert({
        where: { githubRepoId: BigInt(666555) },
        update: { autoReviewEnabled: false },
        create: {
          githubRepoId: BigInt(666555),
          name: 'manual-only-repo',
          fullName: 'acme/manual-only-repo',
          owner: 'acme',
          autoReviewEnabled: false,
        },
      });

      const prPayload = {
        action: 'opened',
        number: 1,
        pull_request: {
          id: 666111,
          number: 1,
          title: 'test: skip review',
          state: 'open',
          html_url: 'https://github.com/acme/manual-only-repo/pull/1',
          diff_url: 'https://github.com/acme/manual-only-repo/pull/1.diff',
          user: { login: 'tester', id: 9 },
          base: { ref: 'main', sha: 'b1' },
          head: { ref: 'patch-1', sha: 'h1' },
        },
        repository: {
          id: 666555,
          name: 'manual-only-repo',
          full_name: 'acme/manual-only-repo',
          owner: { login: 'acme', id: 2, type: 'Organization' },
          private: false,
          default_branch: 'main',
        },
        sender: { login: 'tester', id: 9 },
      };

      const payloadString = JSON.stringify(prPayload);
      const signature = WebhookVerifier.computeSignature(payloadString, testSecret);

      const res = await request(app)
        .post('/api/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .set('X-GitHub-Event', 'pull_request')
        .send(payloadString);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Auto review is disabled');

      // Clean up
      await prisma.repository.delete({ where: { id: repo.id } });
    });
  });
});
