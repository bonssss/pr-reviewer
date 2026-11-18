import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env, getOAuthCallbackUrl } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../db/prisma.js';
import { AppError, unauthorized } from '../../utils/errors.js';
import { decryptSecret, encryptSecret } from '../../utils/crypto.js';
import { JwtUserPayload } from './auth.types.js';
import { linkUserToInstallation } from './access.js';

const JWT_ALGORITHM = 'HS256';
const JWT_ISSUER = 'pr-reviewer';
const JWT_AUDIENCE = 'pr-reviewer-dashboard';
const TOKEN_SCOPES = 'read:user user:email repo';

interface GitHubInstallationSummary {
  id: number;
  account?: {
    login?: string;
    type?: string;
  };
}

export class AuthService {
  /** Cryptographically random OAuth `state` value (CSRF protection). */
  public static createOAuthState(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Build the GitHub OAuth authorize URL. `redirect_uri` must exactly match the
   * callback configured on the GitHub App, otherwise GitHub refuses the flow.
   */
  public static generateGithubAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: getOAuthCallbackUrl(),
      scope: TOKEN_SCOPES,
      state,
      allow_signup: 'false',
    });

    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchange a GitHub OAuth code for an access token, upsert the user and
   * provision their tenant access.
   */
  public static async handleGithubOAuthCallback(code: string) {
    try {
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
          redirect_uri: getOAuthCallbackUrl(),
        }),
        signal: AbortSignal.timeout(env.GITHUB_API_TIMEOUT_MS),
      });

      const tokenData = (await tokenResponse.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (!tokenData.access_token) {
        throw unauthorized(
          tokenData.error_description || tokenData.error || 'Failed to exchange GitHub OAuth code'
        );
      }

      const accessToken = tokenData.access_token;

      const userResponse = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'AI-PR-Reviewer',
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(env.GITHUB_API_TIMEOUT_MS),
      });

      if (!userResponse.ok) {
        throw unauthorized('Failed to fetch GitHub user profile');
      }

      const githubProfile = (await userResponse.json()) as {
        id: number;
        login: string;
        name?: string;
        email?: string;
        avatar_url?: string;
      };

      let userEmail = githubProfile.email;
      if (!userEmail) {
        try {
          const emailResponse = await fetch('https://api.github.com/user/emails', {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'User-Agent': 'AI-PR-Reviewer',
              Accept: 'application/vnd.github+json',
            },
            signal: AbortSignal.timeout(env.GITHUB_API_TIMEOUT_MS),
          });
          const emails = (await emailResponse.json()) as Array<{
            email: string;
            primary: boolean;
            verified: boolean;
          }>;
          const primaryEmail = Array.isArray(emails)
            ? emails.find((entry) => entry.primary && entry.verified)
            : undefined;
          if (primaryEmail) {
            userEmail = primaryEmail.email;
          }
        } catch (error) {
          logger.warn({ error }, 'Could not fetch secondary GitHub emails');
        }
      }

      const encryptedToken = encryptSecret(accessToken);

      const user = await prisma.user.upsert({
        where: { githubId: String(githubProfile.id) },
        update: {
          username: githubProfile.login,
          name: githubProfile.name || githubProfile.login,
          email: userEmail,
          avatarUrl: githubProfile.avatar_url,
          accessToken: encryptedToken,
        },
        create: {
          githubId: String(githubProfile.id),
          username: githubProfile.login,
          name: githubProfile.name || githubProfile.login,
          email: userEmail,
          avatarUrl: githubProfile.avatar_url,
          accessToken: encryptedToken,
        },
      });

      const provisioning = await this.provisionUserAccess(user.id, githubProfile.login, accessToken);

      const token = this.signToken({
        userId: user.id,
        githubId: user.githubId,
        username: user.username,
      });

      logger.info(
        { userId: user.id, username: user.username, ...provisioning },
        'GitHub OAuth login completed'
      );

      return { user, token };
    } catch (error) {
      logger.error({ error }, 'GitHub OAuth callback exchange failed');
      throw error;
    }
  }

  /**
   * Determines which installations/repositories the freshly logged-in user can
   * access. Failures here must never block login; the user simply sees an empty
   * dashboard until the next login.
   */
  public static async provisionUserAccess(
    userId: string,
    username: string,
    accessToken: string
  ): Promise<{ linkedInstallations: number; claimedRepositories: number }> {
    let linkedInstallations = 0;
    let claimedRepositories = 0;

    const githubHeaders = {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'AI-PR-Reviewer',
      Accept: 'application/vnd.github+json',
    };

    try {
      const response = await fetch('https://api.github.com/user/installations?per_page=100', {
        headers: githubHeaders,
        signal: AbortSignal.timeout(env.GITHUB_API_TIMEOUT_MS),
      });

      if (response.ok) {
        const data = (await response.json()) as { installations?: GitHubInstallationSummary[] };

        for (const installation of data.installations ?? []) {
          const installationRow = await prisma.installation.upsert({
            where: { installationId: BigInt(installation.id) },
            update: {
              ...(installation.account?.login ? { accountName: installation.account.login } : {}),
            },
            create: {
              installationId: BigInt(installation.id),
              accountName: installation.account?.login ?? 'Unknown',
              accountType: installation.account?.type === 'Organization' ? 'ORGANIZATION' : 'USER',
            },
          });

          await linkUserToInstallation(userId, installationRow.id);
          linkedInstallations += 1;
        }
      } else {
        logger.debug(
          { status: response.status },
          'Could not list user installations (OAuth app without App installations?)'
        );
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to provision installations for user');
    }

    // Fallback for organisations the user belongs to (and their own account).
    try {
      const accountNames = new Set<string>([username]);

      const orgResponse = await fetch('https://api.github.com/user/orgs?per_page=100', {
        headers: githubHeaders,
        signal: AbortSignal.timeout(env.GITHUB_API_TIMEOUT_MS),
      });

      if (orgResponse.ok) {
        const orgs = (await orgResponse.json()) as Array<{ login?: string }>;
        for (const org of orgs) {
          if (org.login) accountNames.add(org.login);
        }
      }

      const matchingInstallations = await prisma.installation.findMany({
        where: { accountName: { in: [...accountNames] } },
        select: { id: true },
      });

      for (const installation of matchingInstallations) {
        await linkUserToInstallation(userId, installation.id);
        linkedInstallations += 1;
      }

      const claim = await prisma.repository.updateMany({
        where: { owner: username, ownerUserId: null },
        data: { ownerUserId: userId },
      });
      claimedRepositories = claim.count;
    } catch (error) {
      logger.warn({ error }, 'Failed to provision organisation access for user');
    }

    return { linkedInstallations, claimedRepositories };
  }

  public static signToken(payload: JwtUserPayload): string {
    return jwt.sign(payload, env.JWT_SECRET, {
      algorithm: JWT_ALGORITHM,
      expiresIn: '7d',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  }

  /**
   * Verifies signature *and* pins the algorithm/issuer/audience, blocking
   * `alg: none` and algorithm-confusion attacks.
   */
  public static verifyToken(token: string): JwtUserPayload {
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET, {
        algorithms: [JWT_ALGORITHM],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });

      if (typeof decoded === 'string' || !decoded || typeof decoded.userId !== 'string') {
        throw unauthorized('Malformed authentication token');
      }

      return {
        userId: decoded.userId,
        githubId: String(decoded.githubId ?? ''),
        username: String(decoded.username ?? ''),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unauthorized('Invalid or expired authentication token');
    }
  }

  /** Returns the user's stored (encrypted) GitHub token, decrypted. */
  public static async getUserAccessToken(userId: string): Promise<string | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { accessToken: true },
    });

    if (!user?.accessToken) return null;
    return decryptSecret(user.accessToken);
  }

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
