import { Response } from 'express';
import { RepositoryService } from './repository.service.js';
import { AuthenticatedRequest } from '../auth/auth.types.js';
import { logger } from '../../config/logger.js';
import { z } from 'zod';

const updateRepoSchema = z.object({
  autoReviewEnabled: z.boolean().optional(),
  customPrompt: z.string().nullable().optional(),
});

export class RepositoryController {
  /**
   * GET /api/repositories
   * List connected repositories with review metrics
   */
  public static async getRepositories(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const search = req.query.search as string | undefined;
      const autoReview =
        req.query.autoReviewEnabled !== undefined
          ? req.query.autoReviewEnabled === 'true'
          : undefined;

      const repositories = await RepositoryService.listRepositories(req.user?.userId, {
        search,
        autoReviewEnabled: autoReview,
      });

      res.status(200).json({ repositories });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch repositories');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  /**
   * GET /api/repositories/:id
   * Get single repository details and PR review history
   */
  public static async getRepository(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { id } = req.params;
      const repository = await RepositoryService.getRepositoryById(id);

      if (!repository) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      res.status(200).json({ repository });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch repository details');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  /**
   * PATCH /api/repositories/:id
   * Update repository auto-review toggle or custom prompt
   */
  public static async updateRepository(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { id } = req.params;
      const parseResult = updateRepoSchema.safeParse(req.body);

      if (!parseResult.success) {
        res.status(400).json({
          error: 'Validation Error',
          details: parseResult.error.format(),
        });
        return;
      }

      const updated = await RepositoryService.updateRepository(id, parseResult.data);
      res.status(200).json({ repository: updated });
    } catch (error) {
      logger.error({ error }, 'Failed to update repository');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  /**
   * POST /api/repositories/sync/:installationId
   * Trigger GitHub App installation repository sync
   */
  public static async syncRepositories(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { installationId } = req.params;

      if (!installationId) {
        res.status(400).json({ error: 'Missing installationId parameter' });
        return;
      }

      const result = await RepositoryService.syncRepositoriesFromInstallation(installationId);
      res.status(200).json({
        message: 'Repositories synced successfully',
        count: result.repositories.length,
        repositories: result.repositories,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to sync repositories');
      res.status(500).json({
        error: 'Failed to sync repositories',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
