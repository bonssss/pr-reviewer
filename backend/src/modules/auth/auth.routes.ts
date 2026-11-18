import { Router } from 'express';
import { AuthController } from './auth.controller.js';
import { authenticateToken } from './auth.middleware.js';
import { authRateLimiter, requireTrustedOrigin } from '../../config/rate-limit.js';
import { getAllowedOrigins } from '../../config/env.js';

export const authRouter = Router();

authRouter.get('/github', authRateLimiter, AuthController.githubLogin);
authRouter.get('/github/callback', authRateLimiter, AuthController.githubCallback);
authRouter.post('/github/callback', authRateLimiter, AuthController.githubCallback);
authRouter.get('/me', authenticateToken, AuthController.getCurrentUser);
authRouter.post('/logout', requireTrustedOrigin(getAllowedOrigins()), AuthController.logout);
