import { Router } from 'express';
import { DashboardController } from './dashboard.controller.js';
import { authenticateToken } from '../auth/auth.middleware.js';
import { asyncHandler } from '../../utils/errors.js';

export const dashboardRouter = Router();

dashboardRouter.use(authenticateToken);

dashboardRouter.get(
  '/stats',
  asyncHandler(async (req, res) => DashboardController.getStats(req, res))
);
dashboardRouter.get(
  '/prs',
  asyncHandler(async (req, res) => DashboardController.getPullRequests(req, res))
);
