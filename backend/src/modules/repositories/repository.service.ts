import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { GitHubService } from '../github/github.service.js';
import { buildRepositoryAccessWhere } from '../auth/access.js';
import { notFound } from '../../utils/errors.js';

export interface ListRepositoriesFilter {
  search?: string;
  autoReviewEnabled?: boolean;
}

const REPOSITORY_SUMMARY_SELECT = {
  id: true,
  githubRepoId: true,
  name: true,
  fullName: true,
  owner: true,
  isPrivate: true,
  defaultBranch: true,
  webhookActive: true,
  autoReviewEnabled: true,
  customPrompt: true,
  createdAt: true,
  updatedAt: true,
  installation: {
    select: {
      id: true,
      installationId: true,
      accountName: true,
      accountType: true,
      isSuspended: true,
    },
  },
  _count: { select: { pullRequests: true } },
} as const;

export class RepositoryService {
  /** List repositories the caller is allowed to see, with review metrics. */
  public static async listRepositories(
    userId: string,
    filters?: ListRepositoriesFilter,
    pagination: { limit: number; offset: number } = { limit: 50, offset: 0 }
  ) {
    const access = await buildRepositoryAccessWhere(userId);

    const searchFilter = filters?.search
      ? {
          OR: [
            { name: { contains: filters.search, mode: 'insensitive' as const } },
            { fullName: { contains: filters.search, mode: 'insensitive' as const } },
            { owner: { contains: filters.search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    return prisma.repository.findMany({
      where: {
        AND: [
          access,
          searchFilter,
          ...(filters?.autoReviewEnabled !== undefined
            ? [{ autoReviewEnabled: filters.autoReviewEnabled }]
            : []),
        ],
      },
      select: {
        ...REPOSITORY_SUMMARY_SELECT,
        pullRequests: {
          take: 3,
          orderBy: { updatedAt: 'desc' },
          select: {
            id: true,
            number: true,
            title: true,
            state: true,
            author: true,
            updatedAt: true,
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
      take: pagination.limit,
      skip: pagination.offset,
    });
  }

  /** Single repository (tenant already verified by middleware). */
  public static async getRepositoryById(userId: string, id: string) {
    const repository = await prisma.repository.findFirst({
      where: { AND: [{ id }, await buildRepositoryAccessWhere(userId)] },
      include: {
        installation: true,
        pullRequests: {
          orderBy: { number: 'desc' },
          take: 100,
          include: {
            reviewSessions: {
              orderBy: { createdAt: 'desc' },
              take: 10,
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

    if (!repository) {
      throw notFound('Repository not found');
    }

    return repository;
  }

  /** Update repository settings after the caller's access has been verified. */
  public static async updateRepository(
    userId: string,
    id: string,
    data: {
      autoReviewEnabled?: boolean;
      customPrompt?: string | null;
    }
  ) {
    const repository = await prisma.repository.findFirst({
      where: { AND: [{ id }, await buildRepositoryAccessWhere(userId)] },
      select: { id: true },
    });

    if (!repository) {
      throw notFound('Repository not found');
    }

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
   * Manually sync repositories for an installation. The route middleware has
   * already verified the caller is linked to this installation.
   */
  public static async syncRepositoriesFromInstallation(installationId: string | number | bigint) {
    return GitHubService.syncInstallationRepositories(BigInt(installationId));
  }
}

export const uuidSchema = z.string().uuid();
