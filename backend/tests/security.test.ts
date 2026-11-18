import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { prisma, connectDatabase, disconnectDatabase } from '../src/db/prisma.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { WebhookVerifier } from '../src/webhooks/webhook.verifier.js';
import { DiffParser } from '../src/utils/diff.parser.js';
import { ReviewPublisherService } from '../src/modules/reviews/review-publisher.service.js';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../src/utils/crypto.js';
import { parseEnv } from '../src/config/env.js';
import { createRateLimiter, requireTrustedOrigin } from '../src/config/rate-limit.js';
import { assertUuid, isUuid, parsePagination } from '../src/utils/errors.js';
import { env } from '../src/config/env.js';

const GH_INSTALL_A = BigInt(918273645);
const GH_REPO_A = BigInt(918273001);
const GH_REPO_B = BigInt(918273002);
const GH_PR_A = BigInt(918273101);

const DELIVERY_PING = 'security-test-delivery-ping';
const DELIVERY_PING_RETRY = 'security-test-delivery-ping-retry';
const DELIVERY_CLOSED = 'security-test-delivery-closed';
const DELIVERY_INSTALL_DELETED = 'security-test-delivery-installation-deleted';
const DELIVERY_FAILED_RETRY = 'security-test-delivery-failed-retry';

const GH_INSTALL_WEBHOOK = BigInt(918273700);
const GH_REPO_WEBHOOK = BigInt(918273010);
const GH_PR_WEBHOOK = BigInt(918273102);

const webhookSecret = env.GITHUB_WEBHOOK_SECRET || 'development_webhook_secret_key';

function sign(payload: string): string {
  return WebhookVerifier.computeSignature(payload, webhookSecret);
}

function sendWebhook(
  event: string,
  body: unknown,
  options: { deliveryId?: string; raw?: boolean } = {}
) {
  const payload = options.raw ? String(body) : JSON.stringify(body);
  const req = request(createApp())
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sign(payload))
    .set('X-GitHub-Event', event);

  if (options.deliveryId) req.set('X-GitHub-Delivery', options.deliveryId);

  return req.send(payload);
}

function pullRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    number: 7,
    pull_request: {
      id: Number(GH_PR_WEBHOOK),
      number: 7,
      title: 'security: harden uploads',
      state: 'open',
      merged: false,
      html_url: 'https://github.com/sec-org/sec-webhook-repo/pull/7',
      diff_url: 'https://github.com/sec-org/sec-webhook-repo/pull/7.diff',
      user: { login: 'mallory', id: 2 },
      base: { ref: 'main', sha: 'base-sha' },
      head: { ref: 'feature/security', sha: 'head-sha' },
    },
    repository: {
      id: Number(GH_REPO_WEBHOOK),
      name: 'sec-webhook-repo',
      full_name: 'sec-org/sec-webhook-repo',
      owner: { login: 'sec-org', id: 3, type: 'Organization' },
      private: false,
      default_branch: 'main',
    },
    installation: { id: Number(GH_INSTALL_WEBHOOK) },
    ...overrides,
  };
}

describe('Security & Hardening', () => {
  const app = createApp();

  let userAId: string;
  let userBId: string;
  let tokenA: string;
  let tokenB: string;
  let repoAId: string;
  let repoBId: string;
  let prAId: string;
  let sessionAId: string;

  beforeAll(async () => {
    await connectDatabase();

    // Remove leftovers from an interrupted run.
    await prisma.webhookDelivery.deleteMany({
      where: {
        deliveryId: {
          in: [
            DELIVERY_PING,
            DELIVERY_PING_RETRY,
            DELIVERY_CLOSED,
            DELIVERY_INSTALL_DELETED,
            DELIVERY_FAILED_RETRY,
          ],
        },
      },
    });

    const userA = await prisma.user.upsert({
      where: { githubId: 'security_user_a' },
      update: {},
      create: { githubId: 'security_user_a', username: 'security-a', email: 'a@example.com' },
    });
    const userB = await prisma.user.upsert({
      where: { githubId: 'security_user_b' },
      update: {},
      create: { githubId: 'security_user_b', username: 'security-b', email: 'b@example.com' },
    });

    userAId = userA.id;
    userBId = userB.id;

    tokenA = AuthService.signToken({
      userId: userA.id,
      githubId: userA.githubId,
      username: userA.username,
    });
    tokenB = AuthService.signToken({
      userId: userB.id,
      githubId: userB.githubId,
      username: userB.username,
    });

    const installationA = await prisma.installation.upsert({
      where: { installationId: GH_INSTALL_A },
      update: { isSuspended: false },
      create: {
        installationId: GH_INSTALL_A,
        accountName: 'security-a',
        accountType: 'USER',
      },
    });

    await prisma.userInstallation.upsert({
      where: {
        userId_installationId: { userId: userA.id, installationId: installationA.id },
      },
      update: {},
      create: { userId: userA.id, installationId: installationA.id },
    });

    const repoA = await prisma.repository.upsert({
      where: { githubRepoId: GH_REPO_A },
      update: { installationId: installationA.id, ownerUserId: null, autoReviewEnabled: true },
      create: {
        githubRepoId: GH_REPO_A,
        name: 'tenant-a-repo',
        fullName: 'security-a/tenant-a-repo',
        owner: 'security-a',
        installationId: installationA.id,
      },
    });

    const repoB = await prisma.repository.upsert({
      where: { githubRepoId: GH_REPO_B },
      update: { ownerUserId: userB.id },
      create: {
        githubRepoId: GH_REPO_B,
        name: 'tenant-b-repo',
        fullName: 'security-b/tenant-b-repo',
        owner: 'security-b',
        ownerUserId: userB.id,
      },
    });

    repoAId = repoA.id;
    repoBId = repoB.id;

    const prA = await prisma.pullRequest.upsert({
      where: { githubPrId: GH_PR_A },
      update: { repoId: repoA.id },
      create: {
        githubPrId: GH_PR_A,
        number: 11,
        title: 'feat: tenant isolated review',
        state: 'OPEN',
        baseBranch: 'main',
        headBranch: 'feature/x',
        headSha: 'security-commit-a',
        author: 'security-a',
        htmlUrl: 'https://github.com/security-a/tenant-a-repo/pull/11',
        repoId: repoA.id,
      },
    });
    prAId = prA.id;

    await prisma.reviewSession.deleteMany({ where: { prId: prA.id } });
    const session = await prisma.reviewSession.create({
      data: {
        prId: prA.id,
        commitSha: 'security-commit-a',
        status: 'COMPLETED',
        summary: 'Tenant A review',
        riskScore: 42,
        recommendation: 'COMMENT',
        totalIssues: 1,
        lowIssues: 1,
      },
    });
    sessionAId = session.id;
  });

  afterAll(async () => {
    await prisma.reviewComment.deleteMany({
      where: { reviewSession: { pullRequest: { githubPrId: { in: [GH_PR_A, GH_PR_WEBHOOK] } } } },
    });
    await prisma.reviewSession.deleteMany({
      where: { pullRequest: { githubPrId: { in: [GH_PR_A, GH_PR_WEBHOOK] } } },
    });
    await prisma.pullRequest.deleteMany({
      where: { githubPrId: { in: [GH_PR_A, GH_PR_WEBHOOK] } },
    });
    await prisma.repository.deleteMany({
      where: { githubRepoId: { in: [GH_REPO_A, GH_REPO_B, GH_REPO_WEBHOOK] } },
    });
    await prisma.userInstallation.deleteMany({
      where: { userId: { in: [userAId, userBId] } },
    });
    await prisma.installation.deleteMany({
      where: { installationId: { in: [GH_INSTALL_A, GH_INSTALL_WEBHOOK] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
    await prisma.webhookDelivery.deleteMany({
      where: {
        deliveryId: {
          in: [
            DELIVERY_PING,
            DELIVERY_PING_RETRY,
            DELIVERY_CLOSED,
            DELIVERY_INSTALL_DELETED,
            DELIVERY_FAILED_RETRY,
          ],
        },
      },
    });

    await disconnectDatabase();
  });

  // -------------------------------------------------------------------------
  // Authentication & authorization
  // -------------------------------------------------------------------------

  describe('Authentication and tenant isolation', () => {
    it('rejects unauthenticated access to every data endpoint', async () => {
      const paths: Array<[string, string]> = [
        ['get', '/api/repositories'],
        ['get', '/api/dashboard/stats'],
        ['get', '/api/dashboard/prs'],
        ['get', `/api/repositories/${repoAId}`],
        ['get', `/api/reviews/session/${sessionAId}`],
        ['get', `/api/reviews/pr/${prAId}/history`],
        ['post', `/api/reviews/pr/${prAId}/rerun`],
        ['post', `/api/reviews/session/${sessionAId}/publish`],
        ['post', `/api/repositories/sync/${GH_INSTALL_A}`],
      ];

      for (const [method, path] of paths) {
        const res = await (method === 'get' ? request(app).get(path) : request(app).post(path));
        expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
      }
    });

    it('rejects malformed and tampered bearer tokens', async () => {
      const malformed = await request(app)
        .get('/api/repositories')
        .set('Authorization', 'Bearer not-a-jwt');
      expect(malformed.status).toBe(401);

      const valid = AuthService.signToken({ userId: userAId, githubId: 'x', username: 'a' });
      const parts = valid.split('.');
      const payload = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'));
      payload.userId = userBId;
      parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');

      const tampered = await request(app)
        .get('/api/repositories')
        .set('Authorization', `Bearer ${parts.join('.')}`);
      expect(tampered.status).toBe(401);
    });

    it('redirects browser OAuth callbacks back to the dashboard', async () => {
      const browser = await request(app)
        .get('/api/auth/github/callback?code=abc&state=deadbeef')
        .set('Accept', 'text/html');

      expect(browser.status).toBe(302);
      expect(browser.headers.location).toBe('/dashboard?auth_error=state');
      expect(browser.headers['cache-control']).toContain('no-store');

      const missingCode = await request(app)
        .get('/api/auth/github/callback')
        .set('Accept', 'text/html');
      expect(missingCode.headers.location).toBe('/dashboard?auth_error=missing_code');

      const api = await request(app)
        .get('/api/auth/github/callback?code=abc&state=deadbeef')
        .set('Accept', 'application/json');
      expect(api.status).toBe(400);
      expect(api.body.code).toBe('BAD_REQUEST');
      expect(api.headers.location).toBeUndefined();
    });

    it('accepts the httpOnly session cookie as authentication', async () => {
      const res = await request(app).get('/api/repositories').set('Cookie', `token=${tokenA}`);
      expect(res.status).toBe(200);
    });

    it('only lists repositories owned by the caller or a linked installation', async () => {
      const resA = await request(app)
        .get('/api/repositories')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(resA.status).toBe(200);

      const idsA = (resA.body.repositories as Array<{ id: string }>).map((repo) => repo.id);
      expect(idsA).toContain(repoAId);
      expect(idsA).not.toContain(repoBId);

      const resB = await request(app)
        .get('/api/repositories')
        .set('Authorization', `Bearer ${tokenB}`);
      const idsB = (resB.body.repositories as Array<{ id: string }>).map((repo) => repo.id);
      expect(idsB).toContain(repoBId);
      expect(idsB).not.toContain(repoAId);
    });

    it("returns 404 (not 403) for another tenant's repository, pull request and session", async () => {
      const repo = await request(app)
        .get(`/api/repositories/${repoAId}`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(repo.status).toBe(404);

      const history = await request(app)
        .get(`/api/reviews/pr/${prAId}/history`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(history.status).toBe(404);

      const session = await request(app)
        .get(`/api/reviews/session/${sessionAId}`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(session.status).toBe(404);
    });

    it('prevents cross-tenant repository updates', async () => {
      const res = await request(app)
        .patch(`/api/repositories/${repoAId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ autoReviewEnabled: false, customPrompt: 'pwned' });

      expect(res.status).toBe(404);

      const repo = await prisma.repository.findUnique({ where: { id: repoAId } });
      expect(repo?.autoReviewEnabled).toBe(true);
      expect(repo?.customPrompt).not.toBe('pwned');
    });

    it('serves own-tenant data and returns 400 for malformed UUIDs', async () => {
      const session = await request(app)
        .get(`/api/reviews/session/${sessionAId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(session.status).toBe(200);
      expect(session.body.session.id).toBe(sessionAId);

      const repo = await request(app)
        .get('/api/repositories/not-a-uuid')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(repo.status).toBe(400);

      const history = await request(app)
        .get('/api/reviews/pr/not-a-uuid/history')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(history.status).toBe(400);

      const sync = await request(app)
        .post('/api/repositories/sync/not-a-number')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(sync.status).toBe(400);
    });

    it('rejects publishing a review that is not COMPLETED', async () => {
      const pending = await prisma.reviewSession.create({
        data: { prId: prAId, commitSha: 'security-pending', status: 'PENDING' },
      });

      try {
        const res = await request(app)
          .post(`/api/reviews/session/${pending.id}/publish`)
          .set('Authorization', `Bearer ${tokenA}`);
        expect(res.status).toBe(409);
      } finally {
        await prisma.reviewSession.deleteMany({ where: { id: pending.id } });
      }
    });
  });

  // -------------------------------------------------------------------------
  // JWT hardening
  // -------------------------------------------------------------------------

  describe('JWT hardening', () => {
    const payload = { userId: '00000000-0000-4000-8000-000000000001', githubId: '1', username: 'u' };

    it('round-trips a token it signed', () => {
      const token = AuthService.signToken(payload);
      expect(AuthService.verifyToken(token)).toMatchObject(payload);
    });

    it('rejects tokens signed with a different secret', () => {
      const token = jwt.sign(payload, 'attacker-secret', {
        algorithm: 'HS256',
        issuer: 'pr-reviewer',
        audience: 'pr-reviewer-dashboard',
      });
      expect(() => AuthService.verifyToken(token)).toThrow();
    });

    it('rejects alg:none tokens', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      expect(() => AuthService.verifyToken(`${header}.${body}.`)).toThrow();
    });

    it('rejects tokens with an unexpected algorithm, issuer or audience', () => {
      const wrongAlg = jwt.sign(payload, env.JWT_SECRET, {
        algorithm: 'HS384',
        issuer: 'pr-reviewer',
        audience: 'pr-reviewer-dashboard',
      });
      expect(() => AuthService.verifyToken(wrongAlg)).toThrow();

      const wrongIssuer = jwt.sign(payload, env.JWT_SECRET, {
        algorithm: 'HS256',
        issuer: 'someone-else',
        audience: 'pr-reviewer-dashboard',
      });
      expect(() => AuthService.verifyToken(wrongIssuer)).toThrow();

      const wrongAudience = jwt.sign(payload, env.JWT_SECRET, {
        algorithm: 'HS256',
        issuer: 'pr-reviewer',
        audience: 'another-app',
      });
      expect(() => AuthService.verifyToken(wrongAudience)).toThrow();
    });

    it('rejects expired tokens', () => {
      const expired = jwt.sign(payload, env.JWT_SECRET, {
        algorithm: 'HS256',
        issuer: 'pr-reviewer',
        audience: 'pr-reviewer-dashboard',
        expiresIn: -10,
      });
      expect(() => AuthService.verifyToken(expired)).toThrow();
    });

    it('rejects tokens without the required userId claim', () => {
      const token = jwt.sign({ githubId: '1', username: 'u' }, env.JWT_SECRET, {
        algorithm: 'HS256',
        issuer: 'pr-reviewer',
        audience: 'pr-reviewer-dashboard',
      });
      expect(() => AuthService.verifyToken(token)).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Encryption at rest
  // -------------------------------------------------------------------------

  describe('AES-256-GCM token encryption', () => {
    const plaintext = 'ghs_super_secret_oauth_token_value';

    it('encrypts, decrypts and never stores the plaintext', () => {
      const encrypted = encryptSecret(plaintext);

      expect(isEncryptedSecret(encrypted)).toBe(true);
      expect(encrypted).not.toContain(plaintext);
      expect(encrypted.split('.')).toHaveLength(4);
      expect(decryptSecret(encrypted)).toBe(plaintext);
    });

    it('produces a different ciphertext for every call (random IV)', () => {
      expect(encryptSecret(plaintext)).not.toBe(encryptSecret(plaintext));
    });

    it('rejects tampered ciphertext and tampered auth tags', () => {
      const encrypted = encryptSecret(plaintext);
      const parts = encrypted.split('.');

      const ciphertext = Buffer.from(parts[3] as string, 'base64url');
      ciphertext[0] = (ciphertext[0] as number) ^ 0xff;
      const tamperedCiphertext = [parts[0], parts[1], parts[2], ciphertext.toString('base64url')].join('.');
      expect(() => decryptSecret(tamperedCiphertext)).toThrow();

      const authTag = Buffer.from(parts[2] as string, 'base64url');
      authTag[0] = (authTag[0] as number) ^ 0xff;
      const tamperedTag = [parts[0], parts[1], authTag.toString('base64url'), parts[3]].join('.');
      expect(() => decryptSecret(tamperedTag)).toThrow();
    });

    it('rejects malformed encrypted values and passes legacy plaintext through', () => {
      expect(() => decryptSecret('v1.only-two-parts')).toThrow();
      expect(decryptSecret('legacy-plaintext-token')).toBe('legacy-plaintext-token');
      expect(isEncryptedSecret('legacy-plaintext-token')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Secret filtering in the diff pipeline
  // -------------------------------------------------------------------------

  describe('secret filtering before sending diffs to the AI provider', () => {
    it('ignores credential files and generated artefacts', () => {
      for (const file of [
        '.env',
        'backend/.env.production',
        '.npmrc',
        'id_rsa',
        'deploy/id_ed25519.pub',
        'certs/server.pem',
        'config/service-account.json',
        'terraform.tfstate',
        'kubeconfig',
        'secrets.yaml',
        'credentials',
        'package-lock.json',
        'dist/app.min.js',
        'assets/logo.svg',
      ]) {
        expect(DiffParser.shouldIgnoreFile(file).ignore, file).toBe(true);
      }

      for (const file of ['src/index.ts', 'README.md', 'frontend/app.js', 'tests/auth.test.ts']) {
        expect(DiffParser.shouldIgnoreFile(file).ignore, file).toBe(false);
      }
    });

    it('detects credentials embedded in a patch', () => {
      expect(
        DiffParser.patchContainsSecret('+-----BEGIN RSA PRIVATE KEY-----\n+abc\n')
      ).toBe(true);
      expect(DiffParser.patchContainsSecret('+const key = "AKIAIOSFODNN7EXAMPLE";')).toBe(true);
      expect(
        DiffParser.patchContainsSecret('+const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";')
      ).toBe(true);
      expect(DiffParser.patchContainsSecret('+const price = 42;')).toBe(false);
    });

    it('drops secret-bearing files from the reviewable diff', () => {
      const summary = DiffParser.parseGitHubFiles([
        {
          filename: 'src/app.ts',
          status: 'modified',
          additions: 2,
          deletions: 0,
          changes: 2,
          patch: '@@ -1,1 +1,3 @@\n+const ok = true;\n',
        },
        {
          filename: '.env',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -1,1 +1,2 @@\n+OPENAI_API_KEY=sk-live\n',
        },
        {
          filename: 'src/config.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -1,1 +1,2 @@\n+const key = "AKIAIOSFODNN7EXAMPLE";\n',
        },
      ]);

      expect(summary.reviewableFiles).toBe(1);
      expect(summary.files[1]?.isIgnored).toBe(true);
      expect(summary.files[2]?.isIgnored).toBe(true);
      expect(summary.files[2]?.ignoreReason).toContain('credentials');
    });

    it('maps only added lines to valid inline-comment positions', () => {
      const files = [
        {
          filename: 'src/a.ts',
          patch: [
            '@@ -1,3 +1,4 @@',
            ' context',
            '-removed',
            '+added one',
            '+added two',
            '\\ No newline at end of file',
          ].join('\n'),
        },
      ];

      const valid = DiffParser.buildValidRightLines(files);
      expect(valid.has('src/a.ts:2')).toBe(true);
      expect(valid.has('src/a.ts:3')).toBe(true);
      expect(valid.size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Webhook idempotency & state transitions
  // -------------------------------------------------------------------------

  describe('webhook signature, idempotency and lifecycle', () => {
    it('rejects invalid JSON even with a valid signature', async () => {
      const res = await sendWebhook('ping', '{"not": valid json', { raw: true });
      expect(res.status).toBe(400);
    });

    it('rejects malformed pull_request payloads with 400', async () => {
      const res = await sendWebhook('pull_request', { action: 'opened' });
      expect(res.status).toBe(400);
    });

    it('processes a delivery once and ignores retries of the same delivery id', async () => {
      const first = await sendWebhook('ping', { zen: 'Keep it simple.' }, {
        deliveryId: DELIVERY_PING,
      });
      expect(first.status).toBe(200);
      expect(first.body.message).toContain('Pong!');

      const second = await sendWebhook('ping', { zen: 'Keep it simple.' }, {
        deliveryId: DELIVERY_PING,
      });
      expect(second.status).toBe(200);
      expect(second.body.message).toContain('Duplicate delivery ignored');

      const ledger = await prisma.webhookDelivery.findUnique({
        where: { deliveryId: DELIVERY_PING },
      });
      expect(ledger?.status).toBe('PROCESSED');
    });

    it('retries a previously failed delivery instead of ignoring it', async () => {
      await prisma.webhookDelivery.create({
        data: {
          deliveryId: DELIVERY_FAILED_RETRY,
          event: 'ping',
          status: 'FAILED',
          error: 'previous attempt failed',
        },
      });

      const res = await sendWebhook('ping', { zen: 'Retry me.' }, {
        deliveryId: DELIVERY_FAILED_RETRY,
      });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('Pong!');

      const ledger = await prisma.webhookDelivery.findUnique({
        where: { deliveryId: DELIVERY_FAILED_RETRY },
      });
      expect(ledger?.status).toBe('PROCESSED');
      expect(ledger?.error).toBeNull();
    });

    it('marks a pull request CLOSED without enqueuing a review', async () => {
      const res = await sendWebhook(
        'pull_request',
        pullRequestPayload({
          action: 'closed',
          pull_request: {
            ...pullRequestPayload().pull_request,
            state: 'closed',
          },
        }),
        { deliveryId: DELIVERY_CLOSED }
      );

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('closed');

      const pr = await prisma.pullRequest.findUnique({ where: { githubPrId: GH_PR_WEBHOOK } });
      expect(pr?.state).toBe('CLOSED');
    });

    it('disables processing when an installation is deleted', async () => {
      const installation = await prisma.installation.upsert({
        where: { installationId: GH_INSTALL_WEBHOOK },
        update: { isSuspended: false },
        create: {
          installationId: GH_INSTALL_WEBHOOK,
          accountName: 'sec-org',
          accountType: 'ORGANIZATION',
        },
      });

      await prisma.repository.upsert({
        where: { githubRepoId: GH_REPO_WEBHOOK },
        update: {
          installationId: installation.id,
          webhookActive: true,
          autoReviewEnabled: true,
        },
        create: {
          githubRepoId: GH_REPO_WEBHOOK,
          name: 'sec-webhook-repo',
          fullName: 'sec-org/sec-webhook-repo',
          owner: 'sec-org',
          installationId: installation.id,
        },
      });

      const res = await sendWebhook(
        'installation',
        {
          action: 'deleted',
          installation: {
            id: Number(GH_INSTALL_WEBHOOK),
            account: { login: 'sec-org', type: 'Organization' },
          },
        },
        { deliveryId: DELIVERY_INSTALL_DELETED }
      );

      expect(res.status).toBe(200);

      const updatedInstallation = await prisma.installation.findUnique({
        where: { installationId: GH_INSTALL_WEBHOOK },
      });
      expect(updatedInstallation?.isSuspended).toBe(true);

      const updatedRepo = await prisma.repository.findUnique({
        where: { githubRepoId: GH_REPO_WEBHOOK },
      });
      expect(updatedRepo?.webhookActive).toBe(false);
      expect(updatedRepo?.autoReviewEnabled).toBe(false);
    });

    it('acknowledges unknown events without touching business state', async () => {
      const res = await sendWebhook('meta', { action: 'deleted' });
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('acknowledged');
    });
  });

  // -------------------------------------------------------------------------
  // Publisher markdown hardening
  // -------------------------------------------------------------------------

  describe('GitHub publishing markdown hardening', () => {
    it('cannot break out of a suggestion code fence', () => {
      const markdown = ReviewPublisherService.formatInlineCommentMarkdown({
        title: 'Command injection',
        severity: 'CRITICAL',
        category: 'SECURITY',
        message: 'User input reaches exec().',
        suggestion: 'safe()\n```\n@everyone [click](https://evil.example)\n```',
      });

      expect(markdown).toContain("'''");
      expect(markdown.match(/```/g)?.length).toBe(2);
    });

    it('returns a non-published result for a session that is not COMPLETED', async () => {
      const pending = await prisma.reviewSession.create({
        data: { prId: prAId, commitSha: 'security-publish-pending', status: 'PENDING' },
      });

      try {
        const result = await ReviewPublisherService.publishReviewToGitHub(pending.id);
        expect(result.published).toBe(false);
        expect(result.reason).toContain('not COMPLETED');
      } finally {
        await prisma.reviewSession.deleteMany({ where: { id: pending.id } });
      }
    });

    it('is idempotent: republishing a finished session does not publish again', async () => {
      const session = await prisma.reviewSession.create({
        data: {
          prId: prAId,
          commitSha: 'security-publish-idempotent',
          status: 'COMPLETED',
          summary: 'done',
          riskScore: 10,
          recommendation: 'APPROVE',
          publishedAt: new Date(),
        },
      });

      try {
        const result = await ReviewPublisherService.publishReviewToGitHub(session.id);
        expect(result.published).toBe(true);
        expect(result.reason).toContain('already published');
      } finally {
        await prisma.reviewSession.deleteMany({ where: { id: session.id } });
      }
    });

    it('publishes at most once per PR commit, even across re-review sessions', async () => {
      const commitSha = 'security-publish-commit-dedupe';
      const first = await prisma.reviewSession.create({
        data: {
          prId: prAId,
          commitSha,
          status: 'COMPLETED',
          summary: 'first run',
          riskScore: 15,
          recommendation: 'APPROVE',
        },
      });
      const second = await prisma.reviewSession.create({
        data: {
          prId: prAId,
          commitSha,
          status: 'COMPLETED',
          summary: 'second run, identical commit',
          riskScore: 15,
          recommendation: 'APPROVE',
        },
      });

      try {
        const firstResult = await ReviewPublisherService.publishReviewToGitHub(first.id);
        expect(firstResult.published).toBe(true);

        const duplicateResult = await ReviewPublisherService.publishReviewToGitHub(second.id);
        expect(duplicateResult.published).toBe(false);
        expect(duplicateResult.reason).toContain('already published on GitHub');

        // Explicit force still allows an intentional republish.
        const forcedResult = await ReviewPublisherService.publishReviewToGitHub(second.id, {
          force: true,
        });
        expect(forcedResult.published).toBe(true);
      } finally {
        await prisma.reviewSession.deleteMany({ where: { id: { in: [first.id, second.id] } } });
      }
    });

    it('stamps the reviewed commit into the summary footer', () => {
      const markdown = ReviewPublisherService.formatReviewSummaryMarkdown({
        summary: 'Looks good.',
        riskScore: 5,
        recommendation: 'APPROVE',
        criticalIssues: 0,
        highIssues: 0,
        mediumIssues: 0,
        lowIssues: 0,
        totalIssues: 0,
        aiModel: 'heuristic-engine',
        commitSha: '4798147abcdef0123456789',
      });

      expect(markdown).toContain('heuristic-engine');
      expect(markdown).toContain('commit `4798147`');
    });
  });

  // -------------------------------------------------------------------------
  // Configuration & utility hardening
  // -------------------------------------------------------------------------

  describe('configuration validation', () => {
    const productionEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@db:5432/pr_reviewer?schema=public',
      JWT_SECRET: 'j'.repeat(40),
      TOKEN_ENCRYPTION_KEY: 't'.repeat(40),
      GITHUB_APP_ID: '12345',
      GITHUB_CLIENT_ID: 'client-id',
      GITHUB_CLIENT_SECRET: 'client-secret',
      GITHUB_WEBHOOK_SECRET: 'w'.repeat(20),
      GITHUB_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
      OPENAI_API_KEY: 'sk-test',
      FRONTEND_URL: 'https://reviewer.example.com',
    };

    it('accepts a fully configured production environment', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const parsed = parseEnv(productionEnv);
      expect(parsed.NODE_ENV).toBe('production');
      expect(parsed.TOKEN_ENCRYPTION_KEY).toBe(productionEnv.TOKEN_ENCRYPTION_KEY);

      vi.restoreAllMocks();
    });

    it('refuses production with weak, missing or default secrets', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(() => parseEnv({ ...productionEnv, JWT_SECRET: 'short' })).toThrow();
      expect(() => parseEnv({ ...productionEnv, TOKEN_ENCRYPTION_KEY: '' })).toThrow();
      expect(() => parseEnv({ ...productionEnv, GITHUB_WEBHOOK_SECRET: 'tooshort' })).toThrow();
      expect(() => parseEnv({ ...productionEnv, GITHUB_APP_ID: '' })).toThrow();
      expect(() => parseEnv({ ...productionEnv, OPENAI_API_KEY: '' })).toThrow();
      expect(() =>
        parseEnv({ ...productionEnv, GITHUB_PRIVATE_KEY: '', GITHUB_PRIVATE_KEY_PATH: '' })
      ).toThrow();
      expect(() => parseEnv({ ...productionEnv, FRONTEND_URL: 'http://insecure.example' })).toThrow();
      expect(() => parseEnv({ ...productionEnv, JWT_SECRET: 'development_jwt_secret_key_1234567890' })).toThrow();

      vi.restoreAllMocks();
    });

    it('allows plain http only for localhost deployments', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const parsed = parseEnv({ ...productionEnv, FRONTEND_URL: 'http://localhost' });
      expect(parsed.FRONTEND_URL).toBe('http://localhost');

      vi.restoreAllMocks();
    });

    it('accepts an OpenAI-compatible base URL and ignores an empty one', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const gemini = parseEnv({
        ...productionEnv,
        OPENAI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        OPENAI_MODEL: 'gemini-2.5-flash',
      });
      expect(gemini.OPENAI_BASE_URL).toBe(
        'https://generativelanguage.googleapis.com/v1beta/openai/'
      );
      expect(gemini.OPENAI_MODEL).toBe('gemini-2.5-flash');

      const defaulted = parseEnv({ ...productionEnv, OPENAI_BASE_URL: '' });
      expect(defaulted.OPENAI_BASE_URL).toBeUndefined();

      expect(() =>
        parseEnv({ ...productionEnv, OPENAI_BASE_URL: 'not-a-url' })
      ).toThrow();

      vi.restoreAllMocks();
    });

    it('uses the JWT secret as encryption fallback outside production', () => {
      const parsed = parseEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://localhost/db',
      });
      expect(parsed.TOKEN_ENCRYPTION_KEY).toBe(parsed.JWT_SECRET);
    });
  });

  describe('request helpers', () => {
    it('validates UUIDs and caps pagination', () => {
      expect(isUuid('00000000-0000-4000-8000-000000000000')).toBe(true);
      expect(isUuid('not-a-uuid')).toBe(false);
      expect(() => assertUuid('not-a-uuid', 'repository id')).toThrow(/Invalid repository id/);

      expect(parsePagination({ limit: '9999', page: '2' }, { maxLimit: 200 })).toEqual({
        limit: 200,
        offset: 200,
        page: 2,
      });
      expect(parsePagination({ limit: '-5' })).toMatchObject({ limit: 1 });
      expect(parsePagination({})).toMatchObject({ limit: 50, offset: 0, page: 1 });
    });

    it('enforces rate limits and supports disabling them', async () => {
      const limited = express();
      limited.get(
        '/limited',
        createRateLimiter({ max: 2, windowMs: 60_000 }),
        (_req, res) => res.json({ ok: true })
      );

      expect((await request(limited).get('/limited')).status).toBe(200);
      expect((await request(limited).get('/limited')).status).toBe(200);
      const blocked = await request(limited).get('/limited');
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('RATE_LIMITED');

      const disabled = express();
      disabled.get(
        '/unlimited',
        createRateLimiter({ max: 0, windowMs: 60_000 }),
        (_req, res) => res.json({ ok: true })
      );
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await request(disabled).get('/unlimited')).status).toBe(200);
      }
    });

    it('blocks cross-origin cookie-authenticated state changes', async () => {
      const csrf = express();
      csrf.use(cookieParser());
      csrf.post(
        '/logout',
        requireTrustedOrigin(['https://app.example']),
        (_req, res) => res.json({ ok: true })
      );

      expect((await request(csrf).post('/logout')).status).toBe(200);
      expect(
        (await request(csrf).post('/logout').set('Cookie', 'token=abc')).status
      ).toBe(200);
      expect(
        (
          await request(csrf)
            .post('/logout')
            .set('Cookie', 'token=abc')
            .set('Origin', 'https://evil.example')
        ).status
      ).toBe(403);
      expect(
        (
          await request(csrf)
            .post('/logout')
            .set('Cookie', 'token=abc')
            .set('Origin', 'https://app.example')
        ).status
      ).toBe(200);
      expect(
        (
          await request(csrf)
            .post('/logout')
            .set('Cookie', 'token=abc')
            .set('Referer', 'https://evil.example/page')
        ).status
      ).toBe(403);
      expect(
        (
          await request(csrf)
            .post('/logout')
            .set('Cookie', 'token=abc')
            .set('Authorization', 'Bearer x')
            .set('Origin', 'https://evil.example')
        ).status
      ).toBe(200);
    });
  });

  describe('HTTP hardening', () => {
    it('sets a strict CSP and hides the server fingerprint', async () => {
      const res = await request(app).get('/');

      expect(res.status).toBe(200);
      expect(res.headers['x-powered-by']).toBeUndefined();

      const csp = res.headers['content-security-policy'] as string;
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    });

    it('only reflects allow-listed CORS origins', async () => {
      const allowed = await request(app).get('/health').set('Origin', env.FRONTEND_URL);
      expect(allowed.headers['access-control-allow-origin']).toBe(env.FRONTEND_URL);

      const denied = await request(app).get('/health').set('Origin', 'https://evil.example');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('returns the dashboard HTML to browsers and JSON to API clients', async () => {
      const html = await request(app).get('/').set('Accept', 'text/html');
      expect(html.status).toBe(200);
      expect(html.text).toContain('<!DOCTYPE html>');

      const json = await request(app).get('/').set('Accept', 'application/json');
      expect(json.status).toBe(200);
      expect(json.body.name).toContain('GitHub Pull Request Reviewer');
    });

    it('returns a consistent JSON shape for unknown routes and malformed JSON', async () => {
      const notFound = await request(app).get('/api/definitely-not-a-route');
      expect(notFound.status).toBe(404);
      expect(notFound.body).toMatchObject({ code: 'NOT_FOUND' });

      const malformed = await request(app)
        .post('/api/auth/logout')
        .set('Content-Type', 'application/json')
        .send('{"broken":');
      expect(malformed.status).toBe(400);
      expect(malformed.body.code).toBe('BAD_REQUEST');
    });

    it('health check never leaks internal error details', async () => {
      const res = await request(app).get('/health');
      expect([200, 503]).toContain(res.status);
      expect(res.body).not.toHaveProperty('error');
    });
  });
});
