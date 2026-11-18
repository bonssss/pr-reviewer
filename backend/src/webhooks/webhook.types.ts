import { Request } from 'express';
import { z } from 'zod';

export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

/** Accepts numeric ids from JSON and coerces them to Prisma-friendly BigInt. */
const bigIntId = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    try {
      const parsed = BigInt(value);
      if (parsed <= 0n) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Identifier must be positive' });
        return z.NEVER;
      }
      return parsed;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Identifier must be an integer' });
      return z.NEVER;
    }
  });

export const githubPullRequestPayloadSchema = z
  .object({
    action: z.string().min(1).max(64),
    number: z.number().int().positive(),
    pull_request: z
      .object({
        id: bigIntId,
        number: z.number().int().positive(),
        title: z.string().max(2000),
        state: z.string().max(32),
        merged: z.boolean().optional().default(false),
        html_url: z.string().url().max(2000),
        diff_url: z.string().url().max(2000).nullable().optional(),
        user: z.object({ login: z.string().min(1).max(255), id: z.number().int() }).passthrough(),
        base: z.object({ ref: z.string().min(1).max(255), sha: z.string().min(1).max(255) }),
        head: z.object({ ref: z.string().min(1).max(255), sha: z.string().min(1).max(255) }),
      })
      .passthrough(),
    repository: z
      .object({
        id: bigIntId,
        name: z.string().min(1).max(255),
        full_name: z.string().min(1).max(512),
        owner: z
          .object({
            login: z.string().min(1).max(255),
            id: z.number().int(),
            type: z.string().max(64),
          })
          .passthrough(),
        private: z.boolean().optional().default(false),
        default_branch: z.string().min(1).max(255).optional().default('main'),
      })
      .passthrough(),
    installation: z
      .object({
        id: z.number().int().positive(),
        node_id: z.string().max(255).optional(),
      })
      .passthrough()
      .optional(),
    sender: z
      .object({ login: z.string().min(1).max(255), id: z.number().int() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const githubInstallationPayloadSchema = z
  .object({
    action: z.string().min(1).max(64),
    installation: z
      .object({
        id: z.number().int().positive(),
        account: z
          .object({
            login: z.string().min(1).max(255),
            id: z.number().int().optional(),
            type: z.string().max(64).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    repositories: z
      .array(
        z
          .object({
            id: z.union([z.number(), z.string()]),
            name: z.string(),
            full_name: z.string(),
            private: z.boolean().optional().default(false),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

export type GitHubPullRequestPayload = z.infer<typeof githubPullRequestPayloadSchema>;
export type GitHubInstallationPayload = z.infer<typeof githubInstallationPayloadSchema>;
