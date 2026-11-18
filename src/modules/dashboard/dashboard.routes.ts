import { Router } from 'express';
import { DashboardController } from './dashboard.controller.js';
import { optionalAuthenticateToken } from '../auth/auth.middleware.js';

export const dashboardRouter = Router();

dashboardRouter.get('/stats', optionalAuthenticateToken, DashboardController.getStats);
dashboardRouter.get('/prs', optionalAuthenticateToken, DashboardController.getPullRequests);
