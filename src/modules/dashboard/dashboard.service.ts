import { prisma } from '../../db/prisma.js';

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
   * Aggregate KPI stats for the dashboard overview
   */
  public static async getOverviewStats(): Promise<DashboardOverviewStats> {
    const [
      totalRepositories,
      totalPullRequests,
      totalReviews,
      completedSessions,
      recentSessions,
    ] = await Promise.all([
      prisma.repository.count(),
      prisma.pullRequest.count(),
      prisma.reviewSession.count(),
      prisma.reviewSession.findMany({
        where: { status: 'COMPLETED' },
        select: {
          riskScore: true,
          recommendation: true,
          totalIssues: true,
          criticalIssues: true,
          highIssues: true,
          mediumIssues: true,
          lowIssues: true,
        },
      }),
      prisma.reviewSession.findMany({
        take: 8,
        orderBy: { createdAt: 'desc' },
        include: {
          pullRequest: {
            include: {
              repository: {
                select: {
                  fullName: true,
                },
              },
            },
          },
        },
      }),
    ]);

    let sumRisk = 0;
    let criticalCount = 0;
    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;
    let totalIssuesCount = 0;
    const recommendations = { approve: 0, requestChanges: 0, comment: 0 };

    for (const session of completedSessions) {
      if (session.riskScore !== null) {
        sumRisk += session.riskScore;
      }
      criticalCount += session.criticalIssues;
      highCount += session.highIssues;
      mediumCount += session.mediumIssues;
      lowCount += session.lowIssues;
      totalIssuesCount += session.totalIssues;

      if (session.recommendation === 'APPROVE') recommendations.approve++;
      else if (session.recommendation === 'REQUEST_CHANGES') recommendations.requestChanges++;
      else if (session.recommendation === 'COMMENT') recommendations.comment++;
    }

    const averageRiskScore =
      completedSessions.length > 0 ? Math.round(sumRisk / completedSessions.length) : 0;

    const formattedRecent = recentSessions.map((s) => ({
      id: s.id,
      prId: s.prId,
      prNumber: s.pullRequest.number,
      prTitle: s.pullRequest.title,
      repoFullName: s.pullRequest.repository.fullName,
      status: s.status,
      recommendation: s.recommendation,
      riskScore: s.riskScore,
      totalIssues: s.totalIssues,
      criticalIssues: s.criticalIssues,
      createdAt: s.createdAt,
    }));

    return {
      totalRepositories,
      totalPullRequests,
      totalReviews,
      totalIssues: totalIssuesCount,
      criticalIssues: criticalCount,
      highIssues: highCount,
      mediumIssues: mediumCount,
      lowIssues: lowCount,
      averageRiskScore,
      recommendations,
      recentReviews: formattedRecent,
    };
  }

  /**
   * List Pull Requests for dashboard explorer with latest review metrics
   */
  public static async listPullRequests(filters?: {
    repoId?: string;
    search?: string;
  }) {
    const where: Record<string, unknown> = {};

    if (filters?.repoId) {
      where.repoId = filters.repoId;
    }

    if (filters?.search) {
      where.OR = [
        { title: { contains: filters.search, mode: 'insensitive' } },
        { author: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    return prisma.pullRequest.findMany({
      where,
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
    });
  }
}
