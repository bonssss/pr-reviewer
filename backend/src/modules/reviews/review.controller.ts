import { Response } from 'express';
import { ReviewService } from './review.service.js';
import { AuthenticatedRequest } from '../auth/auth.types.js';
import { logger } from '../../config/logger.js';
import { parsePagination } from '../../utils/errors.js';

export class ReviewController {
  /** GET /api/reviews/session/:sessionId */
  public static async getSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const session = await ReviewService.getReviewSessionById(req.user!.userId, req.params.sessionId);

      if (!session) {
        res.status(404).json({ error: 'Review session not found', code: 'NOT_FOUND' });
        return;
      }

      res.status(200).json({ session });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch review session');
      throw error;
    }
  }

  /** GET /api/reviews/pr/:prId/history */
  public static async getHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const pagination = parsePagination(req.query, { limit: 50, maxLimit: 200 });
      const history = await ReviewService.getPrReviewHistory(
        req.user!.userId,
        req.params.prId,
        pagination
      );

      res.status(200).json({ history, limit: pagination.limit, offset: pagination.offset });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch PR review history');
      throw error;
    }
  }

  /** POST /api/reviews/pr/:prId/rerun */
  public static async rerunReview(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const session = await ReviewService.requestReReview(req.user!.userId, req.params.prId);

      res.status(202).json({
        message: 'Re-review requested and enqueued successfully',
        reviewSession: session,
      });
    } catch (error) {
      logger.warn({ error }, 'Failed to request re-review');
      throw error;
    }
  }

  /** POST /api/reviews/session/:sessionId/publish */
  public static async publishReview(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const force = req.body?.force === true || req.query.force === 'true';
      const result = await ReviewService.publishReview(
        req.user!.userId,
        req.params.sessionId,
        { force }
      );

      res.status(200).json({
        message: result.published
          ? 'Review published to GitHub successfully'
          : 'Review was not published again to avoid duplicating an existing review for this commit',
        result,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to publish review');
      throw error;
    }
  }
}
