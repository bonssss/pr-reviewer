import { z } from 'zod';

export const IssueSeveritySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;

export const IssueCategorySchema = z.enum([
  'BUG',
  'SECURITY',
  'PERFORMANCE',
  'CODE_STYLE',
  'TEST_COVERAGE',
  'BEST_PRACTICE',
]);
export type IssueCategory = z.infer<typeof IssueCategorySchema>;

export const ReviewRecommendationSchema = z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);
export type ReviewRecommendation = z.infer<typeof ReviewRecommendationSchema>;

export const ReviewIssueSchema = z.object({
  filePath: z.string().min(1, 'File path is required'),
  lineNumber: z.number().int().positive('Line number must be a positive integer'),
  side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
  severity: IssueSeveritySchema,
  category: IssueCategorySchema,
  title: z.string().min(3).max(150),
  message: z.string().min(10),
  suggestion: z.string().optional().nullable(),
  diffHunk: z.string().optional().nullable(),
});
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

export const StructuredReviewOutputSchema = z.object({
  summary: z.string().min(10),
  riskScore: z.number().int().min(0).max(100),
  recommendation: ReviewRecommendationSchema,
  issues: z.array(ReviewIssueSchema).default([]),
});
export type StructuredReviewOutput = z.infer<typeof StructuredReviewOutputSchema>;

export interface ReviewExecutionResult {
  reviewSessionId: string;
  summary: string;
  riskScore: number;
  recommendation: ReviewRecommendation;
  totalIssues: number;
  criticalIssues: number;
  highIssues: number;
  mediumIssues: number;
  lowIssues: number;
  aiModel: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  executionTimeMs: number;
  issues: ReviewIssue[];
}
