import { Request } from 'express';
import { Installation, PullRequest, Repository, ReviewSession } from '@prisma/client';

export interface JwtUserPayload {
  userId: string;
  githubId: string;
  username: string;
}

/**
 * Request enriched by the auth + authorization middlewares.
 * `repository`, `pullRequest` and `reviewSession` are populated only after the
 * corresponding access middleware has verified tenant ownership.
 */
export interface AuthenticatedRequest extends Request {
  user?: JwtUserPayload;
  repository?: Repository & { installation?: Installation | null };
  pullRequest?: PullRequest & { repository: Repository & { installation: Installation | null } };
  reviewSession?: ReviewSession & {
    pullRequest: PullRequest & { repository: Repository & { installation: Installation | null } };
  };
}

export const SESSION_COOKIE_NAME = 'token';
export const OAUTH_STATE_COOKIE_NAME = 'oauth_state';
export const SESSION_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;
