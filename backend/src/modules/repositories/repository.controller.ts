import { Response } from 'express';
import { z } from 'zod';
import { RepositoryService } from './repository.service.js';
import { AuthenticatedRequest } from '../auth/auth.types.js';
import { logger } from '../../config/logger.js';
import { parsePagination } from '../../utils/errors.js';

const updateRepoSchema = z.object({
  autoReviewEnabled: z.boolean().optional(),
  customPrompt: z.string().max(8000).nullable().optional(),
});

export class RepositoryController {
  /** GET /api/repositories */
  public static async getRepositories(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const search =
        typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : undefined;
      const autoReview =
        req.query.autoReviewEnabled !== undefined
          ? req.query.autoReviewEnabled === 'true'
          : undefined;

      const pagination = parsePagination(req.query, { limit: 50, maxLimit: 200 });

      const repositories = await RepositoryService.listRepositories(
        req.user!.userId,
        { search, autoReviewEnabled: autoReview },
        pagination
      );

      res.status(200).json({
        repositories,
        limit: pagination.limit,
        offset: pagination.offset,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch repositories');
      throw error;
    }
  }

  /** GET /api/repositories/:id */
  public static async getRepository(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const repository = await RepositoryService.getRepositoryById(
        req.user!.userId,
        req.params.id
      );
      res.status(200).json({ repository });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch repository details');
      throw error;
    }
  }

  /** PATCH /api/repositories/:id */
  public static async updateRepository(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parseResult = updateRepoSchema.safeParse(req.body);

      if (!parseResult.success) {
        res.status(400).json({
          error: 'Validation Error',
          code: 'BAD_REQUEST',
          details: parseResult.error.format(),
        });
        return;
      }

      const updated = await RepositoryService.updateRepository(
        req.user!.userId,
        req.params.id,
        parseResult.data
      );
      res.status(200).json({ repository: updated });
    } catch (error) {
      logger.error({ error }, 'Failed to update repository');
      throw error;
    }
  }

  /** POST /api/repositories/sync/:installationId */
  public static async syncRepositories(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const result = await RepositoryService.syncRepositoriesFromInstallation(
        req.params.installationId
      );

      res.status(200).json({
        message: 'Repositories synced successfully',
        count: result.repositories.length,
        repositories: result.repositories,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to sync repositories');
      throw error;
    }
  }
}
