import { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { AuthenticatedRequest } from './auth.types.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';

export class AuthController {
  /**
   * GET /api/auth/github
   * Redirect user to GitHub OAuth login
   */
  public static async githubLogin(_req: Request, res: Response): Promise<void> {
    const authUrl = AuthService.generateGithubAuthUrl();
    res.redirect(authUrl);
  }

  /**
   * POST /api/auth/github/callback
   * Exchange code for JWT session
   */
  public static async githubCallback(req: Request, res: Response): Promise<void> {
    try {
      const code = (req.body.code || req.query.code) as string;

      if (!code) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Missing OAuth authorization code',
        });
        return;
      }

      const { user, token } = await AuthService.handleGithubOAuthCallback(code);

      // Set cookie for browser clients
      res.cookie('token', token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      res.status(200).json({
        message: 'Successfully authenticated with GitHub',
        token,
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to complete GitHub OAuth callback');
      res.status(500).json({
        error: 'Authentication Error',
        message: error instanceof Error ? error.message : 'Unknown authentication error',
      });
    }
  }

  /**
   * GET /api/auth/me
   * Return currently logged in user info
   */
  public static async getCurrentUser(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      if (!req.user?.userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const user = await AuthService.getUserById(req.user.userId);

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.status(200).json({ user });
    } catch (error) {
      logger.error({ error }, 'Failed to get current user');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  /**
   * POST /api/auth/logout
   * Clear session cookie
   */
  public static async logout(_req: Request, res: Response): Promise<void> {
    res.clearCookie('token');
    res.status(200).json({ message: 'Logged out successfully' });
  }
}
