import OpenAI from 'openai';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../db/prisma.js';
import { ParsedDiffSummary } from '../../utils/diff.parser.js';
import { AIPromptBuilder } from './ai.prompt.js';
import {
  StructuredReviewOutputSchema,
  StructuredReviewOutput,
  ReviewIssue,
  ReviewExecutionResult,
} from './ai.types.js';

export class AIService {
  private static openaiClient: OpenAI | null = null;

  /**
   * Lazy-initialize OpenAI client
   */
  public static getOpenAIClient(): OpenAI | null {
    if (this.openaiClient) {
      return this.openaiClient;
    }

    if (
      !env.OPENAI_API_KEY ||
      env.OPENAI_API_KEY.trim() === '' ||
      env.OPENAI_API_KEY === 'mock_openai_api_key'
    ) {
      return null;
    }

    this.openaiClient = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      timeout: env.OPENAI_TIMEOUT_MS,
      maxRetries: env.OPENAI_MAX_RETRIES,
    });

    return this.openaiClient;
  }

  /**
   * Execute AI Review on Pull Request diff and persist findings
   */
  public static async reviewPullRequest(params: {
    reviewSessionId: string;
    prTitle: string;
    prNumber: number;
    author: string;
    baseBranch: string;
    headBranch: string;
    diffSummary: ParsedDiffSummary;
    customPrompt?: string | null;
  }): Promise<ReviewExecutionResult> {
    const startTime = Date.now();
    const {
      reviewSessionId,
      prTitle,
      prNumber,
      author,
      baseBranch,
      headBranch,
      diffSummary,
      customPrompt,
    } = params;

    logger.info({ reviewSessionId, prNumber }, 'Starting AI review generation');

    const systemPrompt = AIPromptBuilder.getSystemPrompt(customPrompt);
    const userPrompt = AIPromptBuilder.buildUserPrompt({
      prTitle,
      prNumber,
      author,
      baseBranch,
      headBranch,
      files: diffSummary.files,
      maxDiffCharacters: env.MAX_DIFF_CHARACTERS,
    });

    let rawOutput: StructuredReviewOutput;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    const model = env.OPENAI_MODEL;

    const client = this.getOpenAIClient();

    if (!client) {
      // Mock / Offline Heuristic Review Generator (for dev and tests without live OpenAI billings)
      logger.warn('OpenAI API key not configured or set to mock. Using automated heuristic engine.');
      rawOutput = this.generateHeuristicReview(diffSummary, prTitle);
      promptTokens = 250;
      completionTokens = 150;
      totalTokens = 400;
    } else {
      try {
        // Reasoning models reject `max_tokens`; older chat models reject
        // `max_completion_tokens`. Pick the parameter the configured model expects.
        const usesCompletionTokens = /^(o\d|gpt-5)/i.test(model);
        const tokenLimit = usesCompletionTokens
          ? { max_completion_tokens: env.MAX_TOKENS_PER_REVIEW }
          : { max_tokens: env.MAX_TOKENS_PER_REVIEW };

        const response = await client.chat.completions.create({
          model,
          temperature: 0.2,
          ...tokenLimit,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        });

        const choice = response.choices[0];
        const content = choice?.message?.content;

        if (!content) {
          throw new Error('OpenAI returned empty completion content');
        }

        promptTokens = response.usage?.prompt_tokens || 0;
        completionTokens = response.usage?.completion_tokens || 0;
        totalTokens = response.usage?.total_tokens || 0;

        const parsedJson = JSON.parse(content);
        const validated = StructuredReviewOutputSchema.safeParse(parsedJson);

        if (!validated.success) {
          logger.error({ errors: validated.error.format() }, 'OpenAI response failed schema validation');
          throw new Error('AI output failed schema validation');
        }

        rawOutput = validated.data;
      } catch (error) {
        logger.error({ error }, 'Failed to call OpenAI Chat Completion API');
        throw error;
      }
    }

    // Post-process and sanitize review findings
    const reviewablePaths = new Set(diffSummary.files.map((f) => f.filePath));
    const validIssues = rawOutput.issues.filter((issue) => {
      // Ensure file actually exists in the PR diff
      return reviewablePaths.has(issue.filePath);
    });

    const criticalIssues = validIssues.filter((i) => i.severity === 'CRITICAL').length;
    const highIssues = validIssues.filter((i) => i.severity === 'HIGH').length;
    const mediumIssues = validIssues.filter((i) => i.severity === 'MEDIUM').length;
    const lowIssues = validIssues.filter((i) => i.severity === 'LOW').length;
    const totalIssues = validIssues.length;

    // Safety rule: If any critical or high issues exist, recommendation must be REQUEST_CHANGES
    let recommendation = rawOutput.recommendation;
    if (criticalIssues > 0 || highIssues > 0) {
      recommendation = 'REQUEST_CHANGES';
    } else if (totalIssues === 0 && recommendation === 'REQUEST_CHANGES') {
      recommendation = 'APPROVE';
    }

    const executionTimeMs = Date.now() - startTime;

    // Persist Review Session findings and individual comments in PostgreSQL
    await prisma.$transaction(async (tx) => {
      // 1. Update Review Session
      await tx.reviewSession.update({
        where: { id: reviewSessionId },
        data: {
          status: 'COMPLETED',
          summary: rawOutput.summary,
          riskScore: rawOutput.riskScore,
          recommendation,
          totalIssues,
          criticalIssues,
          highIssues,
          mediumIssues,
          lowIssues,
          aiModel: model,
          promptTokens,
          completionTokens,
          totalTokens,
          executionTimeMs,
          rawAiResponse: rawOutput as unknown as object,
        },
      });

      // 2. Clear old comments if this session was retried
      await tx.reviewComment.deleteMany({
        where: { reviewSessionId },
      });

      // 3. Create Review Comments
      if (validIssues.length > 0) {
        await tx.reviewComment.createMany({
          data: validIssues.map((issue) => ({
            reviewSessionId,
            filePath: issue.filePath,
            lineNumber: issue.lineNumber,
            side: issue.side,
            severity: issue.severity,
            category: issue.category,
            title: issue.title,
            message: issue.message,
            suggestion: issue.suggestion,
            diffHunk: issue.diffHunk,
          })),
        });
      }
    });

    logger.info(
      {
        reviewSessionId,
        totalIssues,
        criticalIssues,
        highIssues,
        riskScore: rawOutput.riskScore,
        recommendation,
        durationMs: executionTimeMs,
      },
      'AI PR review completed and saved successfully'
    );

    return {
      reviewSessionId,
      summary: rawOutput.summary,
      riskScore: rawOutput.riskScore,
      recommendation,
      totalIssues,
      criticalIssues,
      highIssues,
      mediumIssues,
      lowIssues,
      aiModel: model,
      promptTokens,
      completionTokens,
      totalTokens,
      executionTimeMs,
      issues: validIssues,
    };
  }

  /**
   * Deterministic Heuristic Engine used for dev environments and test verification
   */
  public static generateHeuristicReview(
    diffSummary: ParsedDiffSummary,
    prTitle: string
  ): StructuredReviewOutput {
    const issues: ReviewIssue[] = [];
    let riskScore = 15;

    for (const file of diffSummary.files) {
      if (file.isIgnored || !file.patch) continue;

      const lines = file.patch.split('\n');
      let currentLine = 1;

      for (const line of lines) {
        const header = line.match(/^@@\s+-[0-9]+(?:,[0-9]+)?\s+\+([0-9]+)/);
        if (header && header[1]) {
          currentLine = parseInt(header[1], 10);
          continue;
        }

        if (line.startsWith('+')) {
          const code = line.substring(1);

          // Rule 1: Flag hardcoded secrets or passwords
          if (/password\s*=\s*['"][^'"]+['"]/i.test(code) || /api_key\s*=\s*['"][^'"]+['"]/i.test(code)) {
            issues.push({
              filePath: file.filePath,
              lineNumber: currentLine,
              side: 'RIGHT' as const,
              severity: 'CRITICAL' as const,
              category: 'SECURITY' as const,
              title: 'Hardcoded Credential Detected',
              message: 'Detected potential hardcoded password or API key in source code. Credentials must be read from environment variables.',
              suggestion: 'const apiKey = process.env.API_KEY;',
              diffHunk: line,
            });
            riskScore = Math.max(riskScore, 85);
          }

          // Rule 2: Flag dangerous eval() usage
          if (/\beval\s*\(/.test(code)) {
            issues.push({
              filePath: file.filePath,
              lineNumber: currentLine,
              side: 'RIGHT' as const,
              severity: 'CRITICAL' as const,
              category: 'SECURITY' as const,
              title: 'Dangerous eval() Invocation',
              message: 'Using eval() opens the application to arbitrary code execution (RCE) vulnerabilities.',
              suggestion: '// Use JSON.parse or safe parser instead of eval',
              diffHunk: line,
            });
            riskScore = Math.max(riskScore, 90);
          }

          // Rule 3: Flag console.log in production code
          if (/console\.log\(/.test(code) && !file.filePath.includes('test')) {
            issues.push({
              filePath: file.filePath,
              lineNumber: currentLine,
              side: 'RIGHT' as const,
              severity: 'LOW' as const,
              category: 'BEST_PRACTICE' as const,
              title: 'Console Log Statement',
              message: 'Leftover console.log statements clutter application logs. Prefer using a structured logger.',
              suggestion: 'logger.debug(...)',
              diffHunk: line,
            });
          }

          currentLine++;
        } else if (!line.startsWith('-')) {
          currentLine++;
        }
      }
    }

    const hasCritical = issues.some((i) => i.severity === 'CRITICAL' || i.severity === 'HIGH');
    const recommendation = hasCritical
      ? 'REQUEST_CHANGES'
      : issues.length > 0
        ? 'COMMENT'
        : 'APPROVE';

    return {
      summary: `Analyzed ${diffSummary.reviewableFiles} reviewable files for PR "${prTitle}". Identified ${issues.length} potential issues.`,
      riskScore,
      recommendation,
      issues,
    };
  }
}
