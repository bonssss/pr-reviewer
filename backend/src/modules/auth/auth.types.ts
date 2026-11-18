import { Request } from 'express';

export interface JwtUserPayload {
  userId: string;
  githubId: string;
  username: string;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtUserPayload;
}
