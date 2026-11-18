import { Request, Response } from 'express';
import crypto from 'crypto';
import { AuthService } from './auth.service.js';
import { AuthenticatedRequest, OAUTH_STATE_COOKIE_NAME, OAUTH_STATE_MAX_AGE_MS, SESSION_COOKIE_MAX_AGE_MS, SESSION_COOKIE_NAME } from './auth.types.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { badRequest } from '../../utils/errors.js';

const cookieBase = {
  httpOnly: true,
  // Secure cookies require TLS. Production enforces https:// for non-local
  // origins, while a local single-host deployment may legitimately use http.
  secure: env.FRONTEND_URL.startsWith('https://'),
  sameSite: 'lax' as const,
  path: '/',
};

export class AuthController {
  /**
   * True when the request comes from a top-level browser navigation, in which
   * case the OAuth callback should redirect back to the dashboard instead of
   * rendering raw JSON. API clients still receive JSON.
   */
  private static prefersHtml(req: Request): boolean {
    return req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
  }

  /** Browser-friendly failure: land on the dashboard with a readable reason. */
  private static failOAuth(req: Request, res: Response, reason: string, message: string): void {
    if (this.prefersHtml(req)) {
      res.redirect(302, `/dashboard?auth_error=${encodeURIComponent(reason)}`);
      return;
    }
    res.status(400).json({ error: 'Bad Request', code: 'BAD_REQUEST', message });
  }

  /**
   * GET /api/auth/github
   * Starts the OAuth dance with a random, single-use `state` value stored in an
   * httpOnly cookie (CSRF protection).
   */
  public static async githubLogin(_req: Request, res: Response): Promise<void> {
    const state = AuthService.createOAuthState();

    res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
      ...cookieBase,
      maxAge: OAUTH_STATE_MAX_AGE_MS,
    });

    res.redirect(AuthService.generateGithubAuthUrl(state));
  }

  /**
   * GET|POST /api/auth/github/callback
   * Validates `state`, exchanges the code, provisions tenant access and issues
   * an application session cookie.
   */
  public static async githubCallback(req: Request, res: Response): Promise<void> {
    // OAuth responses contain credentials; never let a proxy or browser cache them.
    res.set('Cache-Control', 'no-store');

    try {
      const code = (req.body?.code || req.query.code) as string | undefined;
      const state = (req.body?.state || req.query.state) as string | undefined;
      const expectedState = req.cookies?.[OAUTH_STATE_COOKIE_NAME] as string | undefined;

      res.clearCookie(OAUTH_STATE_COOKIE_NAME, cookieBase);

      if (!code) {
        logger.warn('OAuth callback rejected: missing code');
        AuthController.failOAuth(
          req,
          res,
          'missing_code',
          'Missing OAuth authorization code'
        );
        return;
      }

      if (!expectedState || !state || expectedState.length !== state.length) {
        logger.warn('OAuth callback rejected: missing or mismatched state');
        AuthController.failOAuth(
          req,
          res,
          'state',
          'Invalid OAuth state. Please restart the sign-in flow.'
        );
        return;
      }

      const stateMatches = crypto.timingSafeEqual(Buffer.from(expectedState), Buffer.from(state));
      if (!stateMatches) {
        logger.warn('OAuth callback rejected: state mismatch');
        AuthController.failOAuth(
          req,
          res,
          'state',
          'Invalid OAuth state. Please restart the sign-in flow.'
        );
        return;
      }

      const { user, token } = await AuthService.handleGithubOAuthCallback(code);

      res.cookie(SESSION_COOKIE_NAME, token, {
        ...cookieBase,
        maxAge: SESSION_COOKIE_MAX_AGE_MS,
      });

      // Browser flow: go straight back to the dashboard. Re-rendering the
      // callback URL invites refreshes that reuse a consumed single-use state.
      if (AuthController.prefersHtml(req)) {
        res.redirect(302, '/dashboard');
        return;
      }

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
      const message =
        error instanceof Error ? error.message : 'Unknown authentication error';
      const statusCode =
        typeof (error as { statusCode?: number }).statusCode === 'number'
          ? (error as { statusCode: number }).statusCode
          : 500;

      if (AuthController.prefersHtml(req)) {
        res.redirect(302, `/dashboard?auth_error=${encodeURIComponent('auth_failed')}`);
        return;
      }

      res.status(statusCode).json({
        error: statusCode === 401 ? 'Unauthorized' : 'Authentication Error',
        code: statusCode === 401 ? 'UNAUTHORIZED' : 'AUTHENTICATION_ERROR',
        // Never echo provider internals in production.
        message: env.NODE_ENV === 'production' && statusCode >= 500 ? 'Authentication failed' : message,
      });
    }
  }

  /** GET /api/auth/me */
  public static async getCurrentUser(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      if (!req.user?.userId) {
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Not authenticated' });
        return;
      }

      const user = await AuthService.getUserById(req.user.userId);

      if (!user) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
        return;
      }

      res.status(200).json({ user });
    } catch (error) {
      logger.error({ error }, 'Failed to get current user');
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Internal Server Error' });
    }
  }

  /** POST /api/auth/logout */
  public static async logout(_req: Request, res: Response): Promise<void> {
    res.clearCookie(SESSION_COOKIE_NAME, cookieBase);
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, cookieBase);
    res.status(200).json({ message: 'Logged out successfully' });
  }

  /** GET /api/auth/state — helper for pure-JS clients that need to embed state */
  public static async issueState(_req: Request, res: Response): Promise<void> {
    const state = AuthService.createOAuthState();
    res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
      ...cookieBase,
      maxAge: OAUTH_STATE_MAX_AGE_MS,
    });
    res.status(200).json({ state });
  }

  public static assertConfigured(): void {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      throw badRequest('GitHub OAuth is not configured on this server');
    }
  }
}
