import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, connectDatabase, disconnectDatabase } from '../src/db/prisma.js';
import { AIPromptBuilder } from '../src/modules/ai/ai.prompt.js';
import { AIService } from '../src/modules/ai/ai.service.js';
import {
  StructuredReviewOutputSchema,
  ReviewIssueSchema,
} from '../src/modules/ai/ai.types.js';
import { DiffParser } from '../src/utils/diff.parser.js';

describe('Phase 4: AI Code Review Engine Integration Tests', () => {
  let testRepoId: string;
  let testPrId: string;
  let testSessionId: string;

  beforeAll(async () => {
    await connectDatabase();

    // Set up test repository and PR in database
    const repo = await prisma.repository.upsert({
      where: { githubRepoId: BigInt(333222) },
      update: {},
      create: {
        githubRepoId: BigInt(333222),
        name: 'ai-test-repo',
        fullName: 'acme/ai-test-repo',
        owner: 'acme',
        defaultBranch: 'main',
        customPrompt: 'Enforce TypeScript strictNullChecks and clean architecture.',
      },
    });
    testRepoId = repo.id;

    const pr = await prisma.pullRequest.upsert({
      where: { githubPrId: BigInt(444333) },
      update: {},
      create: {
        githubPrId: BigInt(444333),
        number: 101,
        title: 'feat: payment processing module',
        state: 'OPEN',
        baseBranch: 'main',
        headBranch: 'feat/payments',
        headSha: 'commit_sha_xyz_101',
        author: 'janedev',
        htmlUrl: 'https://github.com/acme/ai-test-repo/pull/101',
        repoId: repo.id,
      },
    });
    testPrId = pr.id;

    const session = await prisma.reviewSession.create({
      data: {
        prId: pr.id,
        commitSha: 'commit_sha_xyz_101',
        status: 'PENDING',
      },
    });
    testSessionId = session.id;
  });

  afterAll(async () => {
    await prisma.reviewComment.deleteMany({ where: { reviewSessionId: testSessionId } });
    await prisma.reviewSession.deleteMany({ where: { id: testSessionId } });
    await prisma.pullRequest.deleteMany({ where: { id: testPrId } });
    await prisma.repository.deleteMany({ where: { id: testRepoId } });
    await disconnectDatabase();
  });

  describe('Schema Validation for AI Review Outputs', () => {
    it('should validate conformant AI review output', () => {
      const validPayload = {
        summary: 'This pull request introduces the payment handler. Found 1 critical security issue.',
        riskScore: 85,
        recommendation: 'REQUEST_CHANGES',
        issues: [
          {
            filePath: 'src/payments/stripe.ts',
            lineNumber: 24,
            side: 'RIGHT',
            severity: 'CRITICAL',
            category: 'SECURITY',
            title: 'Hardcoded Secret Key',
            message: 'Stripe secret key is committed directly into source code.',
            suggestion: 'const apiKey = process.env.STRIPE_SECRET_KEY;',
            diffHunk: '+const apiKey = "sk_live_123456789";',
          },
        ],
      };

      const result = StructuredReviewOutputSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    it('should reject invalid severities and missing required fields', () => {
      const invalidPayload = {
        summary: 'Short', // Too short (< 10 chars)
        riskScore: 150, // Out of bounds (> 100)
        recommendation: 'UNKNOWN_VERDICT',
        issues: [
          {
            filePath: '',
            lineNumber: -5,
            severity: 'FATAL', // Invalid enum
            category: 'UNKNOWN',
          },
        ],
      };

      const result = StructuredReviewOutputSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
    });

    it('should validate individual review issue schema', () => {
      const issue = {
        filePath: 'src/index.ts',
        lineNumber: 10,
        side: 'RIGHT',
        severity: 'MEDIUM',
        category: 'PERFORMANCE',
        title: 'N+1 Query in Loop',
        message: 'Database query executed inside map() call without batching.',
        suggestion: 'await prisma.user.findMany({ where: { id: { in: ids } } })',
      };

      const parsed = ReviewIssueSchema.safeParse(issue);
      expect(parsed.success).toBe(true);
    });
  });

  describe('Prompt Builder Guidelines & Injections', () => {
    it('should include core guidelines in system prompt', () => {
      const systemPrompt = AIPromptBuilder.getSystemPrompt();
      expect(systemPrompt).toContain('FOCUS ON ACTUAL CHANGES');
      expect(systemPrompt).toContain('NO SPECULATIVE BUGS');
      expect(systemPrompt).toContain('UNTRUSTED INPUT');
      expect(systemPrompt).toContain('ACTIONABLE FIXES');
    });

    it('should append custom repository prompt when provided', () => {
      const customRules = 'Strictly prohibit using any any types.';
      const systemPrompt = AIPromptBuilder.getSystemPrompt(customRules);
      expect(systemPrompt).toContain('ADDITIONAL REPOSITORY-SPECIFIC GUIDELINES');
      expect(systemPrompt).toContain(customRules);
    });

    it('should build formatted user prompt with diff blocks', () => {
      const diffSummary = DiffParser.parseGitHubFiles([
        {
          filename: 'src/auth.ts',
          status: 'modified',
          additions: 10,
          deletions: 2,
          changes: 12,
          patch: '@@ -1,5 +1,10 @@\n+export function login() {}\n',
        },
      ]);

      const prompt = AIPromptBuilder.buildUserPrompt({
        prTitle: 'feat: add auth',
        prNumber: 42,
        author: 'octocat',
        baseBranch: 'main',
        headBranch: 'feat/auth',
        files: diffSummary.files,
      });

      expect(prompt).toContain('#42 feat: add auth');
      expect(prompt).toContain('Author: octocat');
      expect(prompt).toContain('src/auth.ts');
      expect(prompt).toContain('+export function login() {}');
    });
  });

  describe('AI Code Review Execution & Persistence', () => {
    it('should detect security vulnerabilities and recommend REQUEST_CHANGES', () => {
      const mockFiles = [
        {
          filename: 'src/services/api.ts',
          status: 'modified',
          additions: 5,
          deletions: 1,
          changes: 6,
          patch: '@@ -10,3 +10,5 @@\n const config = {};\n+const password = "admin_super_secret_password";\n+eval(userInput);\n',
        },
      ];

      const diffSummary = DiffParser.parseGitHubFiles(mockFiles);
      const review = AIService.generateHeuristicReview(diffSummary, 'Insecure PR');

      expect(review.issues.length).toBeGreaterThanOrEqual(2);
      expect(review.riskScore).toBeGreaterThanOrEqual(80);
      expect(review.recommendation).toBe('REQUEST_CHANGES');

      const passIssue = review.issues.find((i) => i.title.includes('Credential'));
      expect(passIssue).toBeDefined();
      expect(passIssue?.severity).toBe('CRITICAL');

      const evalIssue = review.issues.find((i) => i.title.includes('eval'));
      expect(evalIssue).toBeDefined();
      expect(evalIssue?.severity).toBe('CRITICAL');
    });

    it('should recommend APPROVE on clean and safe code changes', () => {
      const mockFiles = [
        {
          filename: 'src/math.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: '@@ -5,2 +5,4 @@\n-export const add = (a, b) => a + b;\n+export function add(a: number, b: number): number {\n+  return a + b;\n+}\n',
        },
      ];

      const diffSummary = DiffParser.parseGitHubFiles(mockFiles);
      const review = AIService.generateHeuristicReview(diffSummary, 'Clean PR');

      expect(review.issues.length).toBe(0);
      expect(review.recommendation).toBe('APPROVE');
      expect(review.riskScore).toBeLessThanOrEqual(20);
    });

    it('should execute reviewPullRequest, update database session and persist review comments', async () => {
      const mockFiles = [
        {
          filename: 'src/payments/gateway.ts',
          status: 'modified',
          additions: 10,
          deletions: 2,
          changes: 12,
          patch: '@@ -15,4 +15,6 @@\n+const api_key = "secret_payment_token_123";\n+console.log(api_key);\n',
        },
      ];

      const diffSummary = DiffParser.parseGitHubFiles(mockFiles);

      const result = await AIService.reviewPullRequest({
        reviewSessionId: testSessionId,
        prTitle: 'feat: payment processing module',
        prNumber: 101,
        author: 'janedev',
        baseBranch: 'main',
        headBranch: 'feat/payments',
        diffSummary,
        customPrompt: 'Verify PCI DSS compliance.',
      });

      expect(result.reviewSessionId).toBe(testSessionId);
      expect(result.totalIssues).toBeGreaterThan(0);
      expect(result.recommendation).toBe('REQUEST_CHANGES');
      expect(result.criticalIssues).toBeGreaterThanOrEqual(1);

      // Verify PostgreSQL ReviewSession update
      const session = await prisma.reviewSession.findUnique({
        where: { id: testSessionId },
        include: { comments: true },
      });

      expect(session).toBeDefined();
      expect(session?.status).toBe('COMPLETED');
      expect(session?.riskScore).toBeGreaterThanOrEqual(80);
      expect(session?.recommendation).toBe('REQUEST_CHANGES');
      expect(session?.comments.length).toBe(result.totalIssues);

      // Verify ReviewComment table contents
      const firstComment = session?.comments[0];
      expect(firstComment).toBeDefined();
      expect(firstComment?.filePath).toBe('src/payments/gateway.ts');
      expect(firstComment?.lineNumber).toBeGreaterThanOrEqual(15);
      expect(firstComment?.suggestion).toBeDefined();
    });
  });
});
