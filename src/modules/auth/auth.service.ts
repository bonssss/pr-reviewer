import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../db/prisma.js';
import { JwtUserPayload } from './auth.types.js';

export class AuthService {
  /**
   * Generate GitHub OAuth authorize URL for developer sign-in
   */
  public static generateGithubAuthUrl(state?: string): string {
    const params = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: `${env.FRONTEND_URL}/auth/callback`,
      scope: 'read:user user:email repo',
      state: state || 'pr_reviewer_state',
    });

    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchange GitHub OAuth temporary code for access token and upsert user
   */
  public static async handleGithubOAuthCallback(code: string) {
    try {
      // 1. Exchange code for access token
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        }),
      });

      const tokenData = (await tokenResponse.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (!tokenData.access_token) {
        throw new Error(tokenData.error_description || 'Failed to exchange GitHub OAuth code');
      }

      const accessToken = tokenData.access_token;

      // 2. Fetch authenticated user profile from GitHub
      const userResponse = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'AI-PR-Reviewer',
          Accept: 'application/vnd.github.v3+json',
        },
      });

      const githubProfile = (await userResponse.json()) as {
        id: number;
        login: string;
        name?: string;
        email?: string;
        avatar_url?: string;
      };

      // 3. Fallback email fetching if primary email is private
      let userEmail = githubProfile.email;
      if (!userEmail) {
        try {
          const emailResponse = await fetch('https://api.github.com/user/emails', {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'User-Agent': 'AI-PR-Reviewer',
            },
          });
          const emails = (await emailResponse.json()) as Array<{
            email: string;
            primary: boolean;
            verified: boolean;
          }>;
          const primaryEmail = emails.find((e) => e.primary && e.verified);
          if (primaryEmail) {
            userEmail = primaryEmail.email;
          }
        } catch (e) {
          logger.warn({ err: e }, 'Could not fetch secondary GitHub emails');
        }
      }

      // 4. Upsert user in database
      const user = await prisma.user.upsert({
        where: { githubId: String(githubProfile.id) },
        update: {
          username: githubProfile.login,
          name: githubProfile.name || githubProfile.login,
          email: userEmail,
          avatarUrl: githubProfile.avatar_url,
          accessToken,
        },
        create: {
          githubId: String(githubProfile.id),
          username: githubProfile.login,
          name: githubProfile.name || githubProfile.login,
          email: userEmail,
          avatarUrl: githubProfile.avatar_url,
          accessToken,
        },
      });

      // 5. Generate application JWT session token
      const token = this.signToken({
        userId: user.id,
        githubId: user.githubId,
        username: user.username,
      });

      return { user, token };
    } catch (error) {
      logger.error({ error }, 'GitHub OAuth callback exchange failed');
      throw error;
    }
  }

  /**
   * Sign a JWT payload
   */
  public static signToken(payload: JwtUserPayload): string {
    return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '7d' });
  }

  /**
   * Verify and decode a JWT payload
   */
  public static verifyToken(token: string): JwtUserPayload {
    return jwt.verify(token, env.JWT_SECRET) as JwtUserPayload;
  }

  /**
   * Get user profile by User ID
   */
  public static async getUserById(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        githubId: true,
        username: true,
        name: true,
        email: true,
        avatarUrl: true,
        createdAt: true,
        repositories: {
          select: {
            id: true,
            name: true,
            fullName: true,
            autoReviewEnabled: true,
          },
        },
      },
    });
  }
}
