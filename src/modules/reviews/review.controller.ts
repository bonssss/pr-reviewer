import { Response } from 'express';
import { ReviewService } from './review.service.js';
import { AuthenticatedRequest } from '../auth/auth.types.js';
import { logger } from '../../config/logger.js';

export class ReviewController {
  /**
   * GET /api/reviews/session/:sessionId
   * View complete review report and inline comments
   */
  public static async getSession(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { sessionId } = req.params;
      const session = await ReviewService.getReviewSessionById(sessionId);

      if (!session) {
        res.status(404).json({ error: 'Review session not found' });
        return;
      }

      res.status(200).json({ session });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch review session');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  /**
   * GET /api/reviews/pr/:prId/history
   * View historical review timeline for a PR
   */
  public static async getHistory(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { prId } = req.params;
      const history = await ReviewService.getPrReviewHistory(prId);

      res.status(200).json({ history });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch PR review history');
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  /**
   * POST /api/reviews/pr/:prId/rerun
   * Trigger a manual re-review
   */
  public static async rerunReview(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { prId } = req.params;
      const session = await ReviewService.requestReReview(prId);

      res.status(202).json({
        message: 'Re-review requested and enqueued successfully',
        reviewSession: session,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to request re-review');
      res.status(500).json({
        error: 'Failed to request re-review',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/reviews/session/:sessionId/publish
   * Manually trigger publishing review comments to GitHub
   */
  public static async publishReview(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { sessionId } = req.params;
      const result = await ReviewService.publishReview(sessionId);

      res.status(200).json({
        message: 'Review published to GitHub successfully',
        result,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to publish review');
      res.status(500).json({
        error: 'Failed to publish review to GitHub',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
