import { Installation, PullRequest, Repository, ReviewSession } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';

/**
 * Tenant boundary helpers.
 *
 * A signed-in developer may access:
 *  - repositories explicitly linked to their user account (`ownerUserId`), and
 *  - every repository belonging to a GitHub App installation they installed /
 *    were granted access to (tracked in `UserInstallation` at login time).
 *
 * Everything else is invisible. Reads return 404 (not 403) so the API never
 * leaks the existence of other tenants' resources.
 */
export async function getAccessibleInstallationIds(userId: string): Promise<string[]> {
  const links = await prisma.userInstallation.findMany({
    where: { userId },
    select: { installationId: true },
  });

  return links.map((link) => link.installationId);
}

export async function buildRepositoryAccessWhere(
  userId: string
): Promise<Prisma.RepositoryWhereInput> {
  const installationIds = await getAccessibleInstallationIds(userId);

  const clauses: Prisma.RepositoryWhereInput[] = [{ ownerUserId: userId }];
  if (installationIds.length > 0) {
    clauses.push({ installationId: { in: installationIds } });
  }

  return { OR: clauses };
}

export async function buildPullRequestAccessWhere(
  userId: string
): Promise<Prisma.PullRequestWhereInput> {
  const repositoryWhere = await buildRepositoryAccessWhere(userId);
  return { repository: repositoryWhere };
}

export async function buildReviewSessionAccessWhere(
  userId: string
): Promise<Prisma.ReviewSessionWhereInput> {
  const repositoryWhere = await buildRepositoryAccessWhere(userId);
  return { pullRequest: { repository: repositoryWhere } };
}

export async function findAccessibleRepository(
  userId: string,
  repositoryId: string
): Promise<Repository | null> {
  return prisma.repository.findFirst({
    where: { AND: [{ id: repositoryId }, await buildRepositoryAccessWhere(userId)] },
  });
}

export async function findAccessiblePullRequest(
  userId: string,
  pullRequestId: string
): Promise<(PullRequest & { repository: Repository & { installation: Installation | null } }) | null> {
  return prisma.pullRequest.findFirst({
    where: { AND: [{ id: pullRequestId }, await buildPullRequestAccessWhere(userId)] },
    include: { repository: { include: { installation: true } } },
  });
}

export async function findAccessibleReviewSession(
  userId: string,
  sessionId: string
): Promise<
  | (ReviewSession & {
      pullRequest: PullRequest & {
        repository: Repository & { installation: Installation | null };
      };
    })
  | null
> {
  return prisma.reviewSession.findFirst({
    where: { AND: [{ id: sessionId }, await buildReviewSessionAccessWhere(userId)] },
    include: { pullRequest: { include: { repository: { include: { installation: true } } } } },
  });
}

/** Links every repository/webhook-created entity of an installation to the user. */
export async function linkUserToInstallation(
  userId: string,
  installationRowId: string
): Promise<void> {
  await prisma.userInstallation.upsert({
    where: { userId_installationId: { userId, installationId: installationRowId } },
    update: {},
    create: { userId, installationId: installationRowId },
  });
}
