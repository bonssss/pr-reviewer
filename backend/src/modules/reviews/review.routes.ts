import { Router } from 'express';
import { ReviewController } from './review.controller.js';
import {
  authenticateToken,
  requirePullRequestAccess,
  requireReviewSessionAccess,
} from '../auth/auth.middleware.js';
import { rerunRateLimiter } from '../../config/rate-limit.js';
import { asyncHandler } from '../../utils/errors.js';

export const reviewRouter = Router();

reviewRouter.use(authenticateToken);

reviewRouter.get(
  '/session/:sessionId',
  requireReviewSessionAccess,
  asyncHandler(async (req, res) => ReviewController.getSession(req, res))
);

reviewRouter.get(
  '/pr/:prId/history',
  requirePullRequestAccess,
  asyncHandler(async (req, res) => ReviewController.getHistory(req, res))
);

reviewRouter.post(
  '/pr/:prId/rerun',
  rerunRateLimiter,
  requirePullRequestAccess,
  asyncHandler(async (req, res) => ReviewController.rerunReview(req, res))
);

reviewRouter.post(
  '/session/:sessionId/publish',
  requireReviewSessionAccess,
  asyncHandler(async (req, res) => ReviewController.publishReview(req, res))
);
