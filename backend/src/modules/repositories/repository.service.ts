import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { GitHubService } from '../github/github.service.js';

export interface ListRepositoriesFilter {
  search?: string;
  autoReviewEnabled?: boolean;
}

export class RepositoryService {
  /**
   * List repositories with review counts and installation info
   */
  public static async listRepositories(
    _userId?: string,
    filters?: ListRepositoriesFilter
  ) {
    const where: Record<string, unknown> = {};

    if (filters?.autoReviewEnabled !== undefined) {
      where.autoReviewEnabled = filters.autoReviewEnabled;
    }

    if (filters?.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { fullName: { contains: filters.search, mode: 'insensitive' } },
        { owner: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const repositories = await prisma.repository.findMany({
      where,
      include: {
        installation: {
          select: {
            id: true,
            installationId: true,
            accountName: true,
            accountType: true,
          },
        },
        _count: {
          select: {
            pullRequests: true,
          },
        },
        pullRequests: {
          take: 3,
          orderBy: { updatedAt: 'desc' },
          include: {
            reviewSessions: {
              take: 1,
              orderBy: { createdAt: 'desc' },
              select: {
                id: true,
                status: true,
                riskScore: true,
                recommendation: true,
                createdAt: true,
              },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return repositories;
  }

  /**
   * Retrieve single repository by ID with full PR history
   */
  public static async getRepositoryById(id: string) {
    const repository = await prisma.repository.findUnique({
      where: { id },
      include: {
        installation: true,
        pullRequests: {
          orderBy: { number: 'desc' },
          include: {
            reviewSessions: {
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
        },
      },
    });

    return repository;
  }

  /**
   * Update repository settings (toggle auto-review, custom review guidelines)
   */
  public static async updateRepository(
    id: string,
    data: {
      autoReviewEnabled?: boolean;
      customPrompt?: string | null;
    }
  ) {
    const updated = await prisma.repository.update({
      where: { id },
      data: {
        ...(data.autoReviewEnabled !== undefined && { autoReviewEnabled: data.autoReviewEnabled }),
        ...(data.customPrompt !== undefined && { customPrompt: data.customPrompt }),
      },
    });

    logger.info({ repoId: id, changes: data }, 'Updated repository configuration');
    return updated;
  }

  /**
   * Trigger a manual sync of repositories from GitHub App Installation
   */
  public static async syncRepositoriesFromInstallation(installationId: string | number | bigint) {
    return GitHubService.syncInstallationRepositories(BigInt(installationId));
  }
}
