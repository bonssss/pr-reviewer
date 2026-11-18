import { prisma } from '../../db/prisma.js';
import { buildRepositoryAccessWhere } from '../auth/access.js';

export interface DashboardOverviewStats {
  totalRepositories: number;
  totalPullRequests: number;
  totalReviews: number;
  totalIssues: number;
  criticalIssues: number;
  highIssues: number;
  mediumIssues: number;
  lowIssues: number;
  averageRiskScore: number;
  recommendations: {
    approve: number;
    requestChanges: number;
    comment: number;
  };
  recentReviews: Array<{
    id: string;
    prId: string;
    prNumber: number;
    prTitle: string;
    repoFullName: string;
    status: string;
    recommendation: string;
    riskScore: number | null;
    totalIssues: number;
    criticalIssues: number;
    createdAt: Date;
  }>;
}

export class DashboardService {
  /**
   * Aggregate KPI stats for the dashboard overview.
   * Every query is scoped to repositories the caller can access, and the
   * aggregation happens in PostgreSQL instead of loading every session.
   */
  public static async getOverviewStats(userId: string): Promise<DashboardOverviewStats> {
    const repositoryWhere = await buildRepositoryAccessWhere(userId);
    const sessionWhere = { pullRequest: { repository: repositoryWhere } };

    const [totalRepositories, totalPullRequests, totalReviews, totals, byRecommendation, recentSessions] =
      await Promise.all([
        prisma.repository.count({ where: repositoryWhere }),
        prisma.pullRequest.count({ where: { repository: repositoryWhere } }),
        prisma.reviewSession.count({ where: sessionWhere }),
        prisma.reviewSession.aggregate({
          where: { ...sessionWhere, status: 'COMPLETED' },
          _count: { _all: true },
          _avg: { riskScore: true },
          _sum: {
            totalIssues: true,
            criticalIssues: true,
            highIssues: true,
            mediumIssues: true,
            lowIssues: true,
          },
        }),
        prisma.reviewSession.groupBy({
          by: ['recommendation'],
          where: { ...sessionWhere, status: 'COMPLETED' },
          _count: { _all: true },
        }),
        prisma.reviewSession.findMany({
          where: sessionWhere,
          take: 8,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            prId: true,
            status: true,
            recommendation: true,
            riskScore: true,
            totalIssues: true,
            criticalIssues: true,
            createdAt: true,
            pullRequest: {
              select: {
                number: true,
                title: true,
                repository: { select: { fullName: true } },
              },
            },
          },
        }),
      ]);

    const recommendations = { approve: 0, requestChanges: 0, comment: 0 };
    for (const entry of byRecommendation) {
      const count = entry._count._all;
      if (entry.recommendation === 'APPROVE') recommendations.approve = count;
      else if (entry.recommendation === 'REQUEST_CHANGES') recommendations.requestChanges = count;
      else if (entry.recommendation === 'COMMENT') recommendations.comment = count;
    }

    const completedCount = totals._count._all;

    return {
      totalRepositories,
      totalPullRequests,
      totalReviews,
      totalIssues: totals._sum.totalIssues ?? 0,
      criticalIssues: totals._sum.criticalIssues ?? 0,
      highIssues: totals._sum.highIssues ?? 0,
      mediumIssues: totals._sum.mediumIssues ?? 0,
      lowIssues: totals._sum.lowIssues ?? 0,
      averageRiskScore:
        completedCount > 0 ? Math.round(totals._avg.riskScore ?? 0) : 0,
      recommendations,
      recentReviews: recentSessions.map((session) => ({
        id: session.id,
        prId: session.prId,
        prNumber: session.pullRequest.number,
        prTitle: session.pullRequest.title,
        repoFullName: session.pullRequest.repository.fullName,
        status: session.status,
        recommendation: session.recommendation,
        riskScore: session.riskScore,
        totalIssues: session.totalIssues,
        criticalIssues: session.criticalIssues,
        createdAt: session.createdAt,
      })),
    };
  }

  /** List Pull Requests for the dashboard explorer with latest review metrics. */
  public static async listPullRequests(
    userId: string,
    filters?: { repoId?: string; search?: string },
    pagination: { limit: number; offset: number } = { limit: 50, offset: 0 }
  ) {
    const repositoryWhere = await buildRepositoryAccessWhere(userId);

    const searchFilter = filters?.search
      ? {
          OR: [
            { title: { contains: filters.search, mode: 'insensitive' as const } },
            { author: { contains: filters.search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    return prisma.pullRequest.findMany({
      where: {
        AND: [
          { repository: repositoryWhere },
          ...(filters?.repoId ? [{ repoId: filters.repoId }] : []),
          searchFilter,
        ],
      },
      include: {
        repository: {
          select: {
            id: true,
            name: true,
            fullName: true,
            owner: true,
          },
        },
        reviewSessions: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            riskScore: true,
            recommendation: true,
            totalIssues: true,
            criticalIssues: true,
            highIssues: true,
            aiModel: true,
            createdAt: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: pagination.limit,
      skip: pagination.offset,
    });
  }
}
