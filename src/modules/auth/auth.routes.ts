import { Router } from 'express';
import { AuthController } from './auth.controller.js';
import { authenticateToken } from './auth.middleware.js';

export const authRouter = Router();

authRouter.get('/github', AuthController.githubLogin);
authRouter.all('/github/callback', AuthController.githubCallback);
authRouter.get('/me', authenticateToken, AuthController.getCurrentUser);
authRouter.post('/logout', AuthController.logout);
