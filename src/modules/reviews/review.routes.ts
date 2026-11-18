import { Router } from 'express';
import { ReviewController } from './review.controller.js';
import { optionalAuthenticateToken, authenticateToken } from '../auth/auth.middleware.js';

export const reviewRouter = Router();

// Read review session & history (publicly readable or authenticated)
reviewRouter.get('/session/:sessionId', optionalAuthenticateToken, ReviewController.getSession);
reviewRouter.get('/pr/:prId/history', optionalAuthenticateToken, ReviewController.getHistory);

// Re-run and publish require authenticated permissions
reviewRouter.post('/pr/:prId/rerun', authenticateToken, ReviewController.rerunReview);
reviewRouter.post('/session/:sessionId/publish', authenticateToken, ReviewController.publishReview);
