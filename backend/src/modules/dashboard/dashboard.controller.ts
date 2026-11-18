import { Response } from 'express';
import { DashboardService } from './dashboard.service.js';
import { AuthenticatedRequest } from '../auth/auth.types.js';
import { logger } from '../../config/logger.js';
import { parsePagination } from '../../utils/errors.js';

export class DashboardController {
  /** GET /api/dashboard/stats */
  public static async getStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const stats = await DashboardService.getOverviewStats(req.user!.userId);
      res.status(200).json({ stats });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch dashboard overview stats');
      throw error;
    }
  }

  /** GET /api/dashboard/prs */
  public static async getPullRequests(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const repoId = typeof req.query.repoId === 'string' ? req.query.repoId : undefined;
      const search =
        typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : undefined;
      const pagination = parsePagination(req.query, { limit: 50, maxLimit: 200 });

      const pullRequests = await DashboardService.listPullRequests(
        req.user!.userId,
        { repoId, search },
        pagination
      );

      res.status(200).json({
        pullRequests,
        limit: pagination.limit,
        offset: pagination.offset,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to list pull requests for dashboard');
      throw error;
    }
  }
}
