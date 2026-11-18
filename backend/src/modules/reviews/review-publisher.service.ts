import { ReviewComment } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { GitHubService } from '../github/github.service.js';
import { DiffParser } from '../../utils/diff.parser.js';

export interface InlineCommentPayload {
  path: string;
  line: number;
  side: 'RIGHT' | 'LEFT';
  body: string;
}

export interface PublishResult {
  published: boolean;
  publishedCommentsCount: number;
  githubReviewId?: number;
  /** True when no real GitHub App credentials were available (dev/test). */
  simulated?: boolean;
  /** Explanation when `published` is false. */
  reason?: string;
}

export class ReviewPublisherService {
  /**
   * Format overall PR summary in clean Markdown.
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
   * Format an inline comment with severity badge and code suggestion.
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
      // Guard against a suggestion that tries to close the code fence and
      // inject markdown outside of it.
      const safeSuggestion = comment.suggestion.trim().replace(/```/g, "'''");
      body += `\n\n\`\`\`suggestion\n${safeSuggestion}\n\`\`\``;
    }

    return body;
  }

  /**
   * Publish review comments and summary to a GitHub Pull Request.
   *
   * Idempotent: a session that was already published is not published twice.
   * Comments whose line is not part of the diff (or that already exist on the
   * PR) are skipped, which avoids GitHub's 422 "line must be part of the diff".
   */
  public static async publishReviewToGitHub(reviewSessionId: string): Promise<PublishResult> {
    const session = await prisma.reviewSession.findUnique({
      where: { id: reviewSessionId },
      include: {
        comments: { orderBy: { createdAt: 'asc' } },
        pullRequest: {
          include: {
            repository: {
              include: { installation: true },
            },
          },
        },
      },
    });

    if (!session) {
      throw new Error(`ReviewSession ${reviewSessionId} not found`);
    }

    if (session.status !== 'COMPLETED') {
      return {
        published: false,
        publishedCommentsCount: 0,
        reason: `Review session is ${session.status}, not COMPLETED`,
      };
    }

    if (session.publishedAt) {
      return {
        published: true,
        publishedCommentsCount: session.comments.filter((comment) => comment.publishedToGithub).length,
        githubReviewId: session.githubReviewId ? Number(session.githubReviewId) : undefined,
        simulated: session.githubReviewId === null,
        reason: 'Review was already published',
      };
    }

    const pr = session.pullRequest;
    const repo = pr.repository;
    const installationId = repo.installation?.installationId;

    if (!installationId) {
      logger.warn(
        { reviewSessionId, repoFullName: repo.fullName },
        'No GitHub App installation found for repository; skipping GitHub publishing'
      );
      return {
        published: false,
        publishedCommentsCount: 0,
        reason: 'Repository has no GitHub App installation',
      };
    }

    const [owner, repoName] = repo.fullName.split('/');
    if (!owner || !repoName) {
      throw new Error(`Invalid repository full name: ${repo.fullName}`);
    }

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

    const simulated = Boolean(process.env.VITEST) || !GitHubService.isConfigured();

    if (simulated) {
      const commentIds = session.comments.map((comment) => comment.id);

      if (commentIds.length > 0) {
        await prisma.reviewComment.updateMany({
          where: { id: { in: commentIds } },
          data: { publishedToGithub: true },
        });
      }

      await prisma.reviewSession.update({
        where: { id: reviewSessionId },
        data: { publishedAt: new Date(), githubReviewId: null },
      });

      logger.info(
        { reviewSessionId, publishedCommentsCount: commentIds.length },
        'Simulated GitHub review publish (no GitHub App credentials in this environment)'
      );

      return {
        published: true,
        publishedCommentsCount: commentIds.length,
        simulated: true,
      };
    }

    // Validate inline positions against the actual diff (live mode only).
    let validRightLines: Set<string> | null = null;
    let filesInDiff: Set<string> | null = null;

    try {
      const files = await GitHubService.getPullRequestFiles(
        owner,
        repoName,
        pr.number,
        installationId
      );
      validRightLines = DiffParser.buildValidRightLines(files);
      filesInDiff = new Set(files.map((file) => file.filename));
    } catch (error) {
      logger.warn(
        { error, reviewSessionId },
        'Could not fetch PR diff for comment line validation; falling back to GitHub validation'
      );
    }

    let existingComments: Array<{ path: string; line?: number | null; body: string }> = [];
    try {
      existingComments = await GitHubService.listReviewComments(
        owner,
        repoName,
        pr.number,
        installationId
      );
    } catch (error) {
      logger.warn({ error, reviewSessionId }, 'Could not fetch existing PR review comments');
    }

    const inlineComments: InlineCommentPayload[] = [];
    const publishedCommentIds: string[] = [];
    const skippedReasons: string[] = [];

    for (const comment of session.comments) {
      if (filesInDiff && !filesInDiff.has(comment.filePath)) {
        skippedReasons.push(`${comment.filePath}: file is not part of the diff`);
        continue;
      }

      if (
        validRightLines &&
        comment.side === 'RIGHT' &&
        !validRightLines.has(`${comment.filePath}:${comment.lineNumber}`)
      ) {
        skippedReasons.push(`${comment.filePath}:${comment.lineNumber}: not an added line`);
        continue;
      }

      const isDuplicate = existingComments.some(
        (existing) =>
          existing.path === comment.filePath &&
          existing.line === comment.lineNumber &&
          existing.body.includes(comment.title)
      );

      if (isDuplicate) {
        skippedReasons.push(`${comment.filePath}:${comment.lineNumber}: already commented`);
        continue;
      }

      inlineComments.push({
        path: comment.filePath,
        line: comment.lineNumber,
        side: comment.side === 'LEFT' ? 'LEFT' : 'RIGHT',
        body: this.formatInlineCommentMarkdown(comment),
      });
      publishedCommentIds.push(comment.id);
    }

    if (skippedReasons.length > 0) {
      logger.info({ reviewSessionId, skipped: skippedReasons }, 'Skipped GitHub inline comments');
    }

    let event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = 'COMMENT';
    if (session.recommendation === 'APPROVE' && env.AUTO_APPROVE_PR) {
      event = 'APPROVE';
    } else if (session.recommendation === 'REQUEST_CHANGES') {
      event = 'REQUEST_CHANGES';
    }

    let githubReviewId: number | undefined;

    try {
      const review = await GitHubService.createReview(owner, repoName, pr.number, installationId, {
        commitId: session.commitSha,
        event,
        body: summaryMarkdown,
        comments: inlineComments,
      });
      githubReviewId = review.id;
    } catch (error) {
      const status = (error as { status?: number }).status;

      // 422 usually means every inline comment was rejected (stale diff while
      // the review was running). Degrade to a single summary comment instead of
      // losing the whole review.
      if (status === 422 || inlineComments.length > 0) {
        logger.warn(
          { error, reviewSessionId },
          'Inline review rejected by GitHub; falling back to a summary issue comment'
        );
        await GitHubService.createIssueComment(
          owner,
          repoName,
          pr.number,
          installationId,
          this.buildFallbackBody(summaryMarkdown, session.comments)
        );
        githubReviewId = undefined;
      } else {
        logger.error({ error, reviewSessionId }, 'Failed to publish review to GitHub API');
        throw error;
      }
    }

    if (publishedCommentIds.length > 0) {
      await prisma.reviewComment.updateMany({
        where: { id: { in: publishedCommentIds } },
        data: { publishedToGithub: true },
      });
    }

    await prisma.reviewSession.update({
      where: { id: reviewSessionId },
      data: {
        publishedAt: new Date(),
        ...(githubReviewId ? { githubReviewId: BigInt(githubReviewId) } : {}),
      },
    });

    logger.info(
      { reviewSessionId, githubReviewId, publishedCommentsCount: publishedCommentIds.length },
      'Published review to GitHub'
    );

    return {
      published: true,
      publishedCommentsCount: publishedCommentIds.length,
      githubReviewId,
      simulated: false,
    };
  }

  /** Summary + inline findings, used when GitHub rejects inline comments. */
  private static buildFallbackBody(summaryMarkdown: string, comments: ReviewComment[]): string {
    if (comments.length === 0) {
      return summaryMarkdown;
    }

    const sections = comments
      .map(
        (comment) =>
          `### ${comment.severity} — ${comment.title}\n` +
          `\`${comment.filePath}:${comment.lineNumber}\`\n\n${comment.message}` +
          (comment.suggestion ? `\n\n\`\`\`\n${comment.suggestion}\n\`\`\`` : '')
      )
      .join('\n\n---\n\n');

    return `${summaryMarkdown}\n\n---\n\n## 🧷 Inline Findings\n\n${sections}`;
  }
}
