import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { GitHubService } from '../github/github.service.js';

export interface InlineCommentPayload {
  path: string;
  line: number;
  side: 'RIGHT' | 'LEFT';
  body: string;
}

export class ReviewPublisherService {
  /**
   * Format overall PR summary in clean Markdown
   */
  public static formatReviewSummaryMarkdown(params: {
    summary: string;
    riskScore: number;
    recommendation: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
    criticalIssues: number;
    highIssues: number;
    mediumIssues: number;
    lowIssues: number;
    totalIssues: number;
    aiModel?: string | null;
  }): string {
    const {
      summary,
      riskScore,
      recommendation,
      criticalIssues,
      highIssues,
      mediumIssues,
      lowIssues,
      totalIssues,
      aiModel,
    } = params;

    const recommendationBadge =
      recommendation === 'APPROVE'
        ? '🟢 **APPROVE** - Safe to merge with minor or no suggestions'
        : recommendation === 'REQUEST_CHANGES'
          ? '🔴 **CHANGES REQUESTED** - Critical or high-severity issues must be resolved'
          : '🟡 **COMMENT** - Review suggestions and improvements identified';

    let riskBadge = '🟢 Low Risk';
    if (riskScore >= 70) {
      riskBadge = '🔴 High Risk';
    } else if (riskScore >= 35) {
      riskBadge = '🟡 Medium Risk';
    }

    return `## 🤖 AI Pull Request Review

${recommendationBadge}

| Metric | Assessment |
| :--- | :--- |
| **Risk Score** | **${riskScore}/100** (${riskBadge}) |
| **Total Issues Found** | **${totalIssues}** |
| **Critical Issues** | 🚨 **${criticalIssues}** |
| **High Severity** | ⚠️ **${highIssues}** |
| **Medium Severity** | ⚡ **${mediumIssues}** |
| **Low / Suggestions** | ℹ️ **${lowIssues}** |

---

### 📝 Executive Summary
${summary}

---
*Reviewed by AI PR Reviewer (${aiModel || env.OPENAI_MODEL}). Developer can request re-review at any time.*`;
  }

  /**
   * Format an inline comment with severity badge and code suggestion
   */
  public static formatInlineCommentMarkdown(comment: {
    title: string;
    severity: string;
    category: string;
    message: string;
    suggestion?: string | null;
  }): string {
    const severityIcon =
      comment.severity === 'CRITICAL'
        ? '🚨'
        : comment.severity === 'HIGH'
          ? '⚠️'
          : comment.severity === 'MEDIUM'
            ? '⚡'
            : 'ℹ️';

    let body = `### ${severityIcon} [${comment.severity}] ${comment.title} (\`${comment.category}\`)

${comment.message}`;

    if (comment.suggestion && comment.suggestion.trim().length > 0) {
      body += `\n\n\`\`\`suggestion\n${comment.suggestion.trim()}\n\`\`\``;
    }

    return body;
  }

  /**
   * Publish review comments and summary to GitHub Pull Request
   */
  public static async publishReviewToGitHub(reviewSessionId: string): Promise<{
    published: boolean;
    publishedCommentsCount: number;
    githubReviewId?: number;
  }> {
    const session = await prisma.reviewSession.findUnique({
      where: { id: reviewSessionId },
      include: {
        comments: true,
        pullRequest: {
          include: {
            repository: {
              include: {
                installation: true,
              },
            },
          },
        },
      },
    });

    if (!session) {
      throw new Error(`ReviewSession ${reviewSessionId} not found`);
    }

    const pr = session.pullRequest;
    const repo = pr.repository;
    const installationId = repo.installation?.installationId;

    if (!installationId) {
      logger.warn(
        { reviewSessionId, repoFullName: repo.fullName },
        'No GitHub App installation found for repository. Skipping GitHub publishing.'
      );
      return { published: false, publishedCommentsCount: 0 };
    }

    const [owner, repoName] = repo.fullName.split('/');
    if (!owner || !repoName) {
      throw new Error(`Invalid repository full name: ${repo.fullName}`);
    }

    // 1. Build summary body markdown
    const summaryMarkdown = this.formatReviewSummaryMarkdown({
      summary: session.summary || 'Review completed.',
      riskScore: session.riskScore || 0,
      recommendation: session.recommendation,
      criticalIssues: session.criticalIssues,
      highIssues: session.highIssues,
      mediumIssues: session.mediumIssues,
      lowIssues: session.lowIssues,
      totalIssues: session.totalIssues,
      aiModel: session.aiModel,
    });

    // 2. Fetch existing review comments on the PR to prevent duplicates
    let existingComments: Array<{ path: string; line?: number | null; body: string }> = [];
    try {
      const octokit = GitHubService.getInstallationOctokit(installationId);
      const { data } = await octokit.pulls.listReviewComments({
        owner,
        repo: repoName,
        pull_number: pr.number,
        per_page: 100,
      });
      existingComments = data;
    } catch (e) {
      logger.warn({ err: e }, 'Could not fetch existing PR review comments for duplicate check');
    }

    // 3. Prepare non-duplicate inline comments
    const inlineComments: InlineCommentPayload[] = [];
    const commentIdsToMark: string[] = [];

    for (const comment of session.comments) {
      const formattedBody = this.formatInlineCommentMarkdown(comment);

      // Duplicate check: same file, same line, and contains same issue title
      const isDuplicate = existingComments.some(
        (existing) =>
          existing.path === comment.filePath &&
          existing.line === comment.lineNumber &&
          existing.body.includes(comment.title)
      );

      if (!isDuplicate) {
        inlineComments.push({
          path: comment.filePath,
          line: comment.lineNumber,
          side: comment.side as 'RIGHT' | 'LEFT',
          body: formattedBody,
        });
        commentIdsToMark.push(comment.id);
      } else {
        logger.info(
          { filePath: comment.filePath, line: comment.lineNumber, title: comment.title },
          'Skipping duplicate review comment'
        );
      }
    }

    // 4. Determine GitHub review event action
    let event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = 'COMMENT';
    if (session.recommendation === 'APPROVE' && env.AUTO_APPROVE_PR) {
      event = 'APPROVE';
    } else if (session.recommendation === 'REQUEST_CHANGES') {
      event = 'REQUEST_CHANGES';
    }

    // 5. Publish review using Octokit
    let githubReviewId: number | undefined;

    // Check if real GitHub App credentials exist
    const privateKey = GitHubService.getPrivateKey();
    if (privateKey && privateKey !== 'DUMMY_KEY') {
      try {
        const octokit = GitHubService.getInstallationOctokit(installationId);
        const { data: reviewResponse } = await octokit.pulls.createReview({
          owner,
          repo: repoName,
          pull_number: pr.number,
          commit_id: session.commitSha,
          event,
          body: summaryMarkdown,
          comments: inlineComments.length > 0 ? inlineComments : undefined,
        });

        githubReviewId = reviewResponse.id;
        logger.info(
          { githubReviewId, reviewSessionId, prNumber: pr.number },
          'Successfully published review to GitHub'
        );
      } catch (error) {
        logger.error({ error, reviewSessionId }, 'Failed to publish review to GitHub API');
        throw error;
      }
    } else {
      logger.info('Simulated GitHub review publish in development/mock mode');
      githubReviewId = 123456789;
    }

    // 6. Mark published comments in database
    if (commentIdsToMark.length > 0) {
      await prisma.reviewComment.updateMany({
        where: { id: { in: commentIdsToMark } },
        data: {
          publishedToGithub: true,
          githubCommentId: githubReviewId ? BigInt(githubReviewId) : undefined,
        },
      });
    }

    return {
      published: true,
      publishedCommentsCount: inlineComments.length,
      githubReviewId,
    };
  }
}
