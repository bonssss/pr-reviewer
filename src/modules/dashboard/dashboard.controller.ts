import { Request, Response } from 'express';
import { DashboardService } from './dashboard.service.js';
import { logger } from '../../config/logger.js';

export class DashboardController {
  /**
   * GET /api/dashboard/stats
   * Overview metrics for dashboard charts and KPI cards
   */
  public static async getStats(_req: Request, res: Response): Promise<void> {
    try {
      const stats = await DashboardService.getOverviewStats();
      res.status(200).json({ stats });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch dashboard overview stats');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  /**
   * GET /api/dashboard/prs
   * List pull requests with their latest AI review status
   */
  public static async getPullRequests(req: Request, res: Response): Promise<void> {
    try {
      const repoId = req.query.repoId as string | undefined;
      const search = req.query.search as string | undefined;

      const pullRequests = await DashboardService.listPullRequests({ repoId, search });
      res.status(200).json({ pullRequests });
    } catch (error) {
      logger.error({ error }, 'Failed to list pull requests for dashboard');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
}
