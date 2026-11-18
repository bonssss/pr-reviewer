import fs from 'fs';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../db/prisma.js';

export class GitHubService {
  private static cachedPrivateKey: string | null = null;

  /**
   * Resolve GitHub App Private Key from ENV variable or local file path
   */
  public static getPrivateKey(): string {
    if (this.cachedPrivateKey) {
      return this.cachedPrivateKey;
    }

    if (env.GITHUB_PRIVATE_KEY && env.GITHUB_PRIVATE_KEY.trim().length > 0) {
      // Decode if base64 encoded or direct PEM
      if (env.GITHUB_PRIVATE_KEY.includes('-----BEGIN RSA PRIVATE KEY-----') ||
          env.GITHUB_PRIVATE_KEY.includes('-----BEGIN PRIVATE KEY-----')) {
        this.cachedPrivateKey = env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
      } else {
        try {
          const decoded = Buffer.from(env.GITHUB_PRIVATE_KEY, 'base64').toString('utf8');
          this.cachedPrivateKey = decoded.replace(/\\n/g, '\n');
        } catch {
          this.cachedPrivateKey = env.GITHUB_PRIVATE_KEY;
        }
      }
      return this.cachedPrivateKey;
    }

    if (env.GITHUB_PRIVATE_KEY_PATH && fs.existsSync(env.GITHUB_PRIVATE_KEY_PATH)) {
      this.cachedPrivateKey = fs.readFileSync(env.GITHUB_PRIVATE_KEY_PATH, 'utf8');
      return this.cachedPrivateKey;
    }

    // Fallback stub key for mock/test environments
    logger.warn('No GitHub App private key configured. Using development dummy key.');
    return 'DUMMY_KEY';
  }

  /**
   * Authenticate Octokit as the GitHub App
   */
  public static getAppOctokit(): Octokit {
    const privateKey = this.getPrivateKey();
    const appId = env.GITHUB_APP_ID || '123456';

    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: Number(appId),
        privateKey,
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
      log: {
        debug: (msg: string) => logger.debug(msg),
        info: (msg: string) => logger.info(msg),
        warn: (msg: string) => logger.warn(msg),
        error: (msg: string) => logger.error(msg),
      },
    });
  }

  /**
   * Authenticate Octokit for a specific GitHub App Installation
   */
  public static getInstallationOctokit(installationId: number | bigint): Octokit {
    const privateKey = this.getPrivateKey();
    const appId = env.GITHUB_APP_ID || '123456';

    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: Number(appId),
        privateKey,
        installationId: Number(installationId),
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    });
  }

  /**
   * Fetch all repositories accessible by an installation and sync them to DB
   */
  public static async syncInstallationRepositories(installationId: number | bigint) {
    try {
      const octokit = this.getInstallationOctokit(installationId);
      const { data } = await octokit.apps.listReposAccessibleToInstallation({
        per_page: 100,
      });

      // Find or create installation in database
      const installation = await prisma.installation.upsert({
        where: { installationId: BigInt(installationId) },
        update: {},
        create: {
          installationId: BigInt(installationId),
          accountName: data.repositories[0]?.owner.login || 'Unknown',
          accountType: data.repositories[0]?.owner.type === 'Organization' ? 'ORGANIZATION' : 'USER',
        },
      });

      const syncedRepos = [];

      for (const repo of data.repositories) {
        const upsertedRepo = await prisma.repository.upsert({
          where: { githubRepoId: BigInt(repo.id) },
          update: {
            name: repo.name,
            fullName: repo.full_name,
            owner: repo.owner.login,
            isPrivate: repo.private,
            defaultBranch: repo.default_branch,
            installationId: installation.id,
            webhookActive: true,
          },
          create: {
            githubRepoId: BigInt(repo.id),
            name: repo.name,
            fullName: repo.full_name,
            owner: repo.owner.login,
            isPrivate: repo.private,
            defaultBranch: repo.default_branch,
            installationId: installation.id,
            webhookActive: true,
          },
        });
        syncedRepos.push(upsertedRepo);
      }

      logger.info(
        { installationId: installationId.toString(), count: syncedRepos.length },
        'Successfully synced installation repositories'
      );

      return { installation, repositories: syncedRepos };
    } catch (error) {
      logger.error({ error, installationId: installationId.toString() }, 'Failed to sync installation repositories');
      throw error;
    }
  }

  /**
   * Fetch Pull Request details including head and base SHA
   */
  public static async getPullRequestDetails(
    owner: string,
    repo: string,
    pullNumber: number,
    installationId: number | bigint
  ) {
    const octokit = this.getInstallationOctokit(installationId);
    const { data } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });
    return data;
  }

  /**
   * Fetch the list of changed files and their diff hunks in a PR
   */
  public static async getPullRequestFiles(
    owner: string,
    repo: string,
    pullNumber: number,
    installationId: number | bigint
  ) {
    const octokit = this.getInstallationOctokit(installationId);
    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: env.MAX_DIFF_FILES,
    });
    return data;
  }

  /**
   * Fetch the raw PR unified diff text
   */
  public static async getPullRequestDiff(
    owner: string,
    repo: string,
    pullNumber: number,
    installationId: number | bigint
  ): Promise<string> {
    const octokit = this.getInstallationOctokit(installationId);
    const response = await octokit.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      headers: {
        accept: 'application/vnd.github.v3.diff',
      },
    });
    return response.data as unknown as string;
  }
}
