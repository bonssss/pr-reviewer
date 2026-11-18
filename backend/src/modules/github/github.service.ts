import fs from 'fs';
import path from 'path';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../db/prisma.js';

export interface GitHubFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface GitHubPullRequestComment {
  id: number;
  path: string;
  line?: number | null;
  body: string;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class GitHubService {
  private static cachedPrivateKey: string | null = null;

  /**
   * Resolves the GitHub App private key from an environment variable or a file.
   * Accepts raw PEM, `\n`-escaped PEM and base64-encoded PEM.
   *
   * In production a missing/invalid key is a fatal configuration error: we must
   * never silently fall back to a dummy key and start sending garbage to GitHub.
   */
  public static getPrivateKey(): string {
    if (this.cachedPrivateKey) {
      return this.cachedPrivateKey;
    }

    const fromEnv = this.normalizePrivateKey(env.GITHUB_PRIVATE_KEY);
    if (fromEnv) {
      this.cachedPrivateKey = fromEnv;
      return fromEnv;
    }

    if (env.GITHUB_PRIVATE_KEY_PATH) {
      for (const candidate of this.privateKeyPathCandidates(env.GITHUB_PRIVATE_KEY_PATH)) {
        if (!fs.existsSync(candidate)) continue;

        const contents = this.normalizePrivateKey(fs.readFileSync(candidate, 'utf8'));
        if (contents) {
          this.cachedPrivateKey = contents;
          return contents;
        }

        logger.warn({ path: candidate }, 'GitHub private key file does not contain a valid PEM key');
      }
    }

    if (env.NODE_ENV === 'production') {
      throw new Error(
        'GitHub App private key is not configured. Set GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH.'
      );
    }

    logger.warn('No GitHub App private key configured. GitHub API calls are disabled in this environment.');
    return 'DUMMY_KEY';
  }

  /** True only when real GitHub App credentials are available. */
  public static isConfigured(): boolean {
    // Tests must be hermetic: never call the live GitHub API from the suite.
    if (process.env.VITEST) {
      return false;
    }

    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_ID.trim()) {
      return false;
    }

    try {
      const key = this.getPrivateKey();
      return key !== 'DUMMY_KEY' && key.includes('-----BEGIN');
    } catch {
      return false;
    }
  }

  private static normalizePrivateKey(raw: string | undefined): string | null {
    if (!raw || raw.trim().length === 0) return null;

    let candidate = raw.trim();

    if (!candidate.includes('-----BEGIN')) {
      try {
        const decoded = Buffer.from(candidate, 'base64').toString('utf8').trim();
        if (decoded.includes('-----BEGIN')) {
          candidate = decoded;
        }
      } catch {
        return null;
      }
    }

    candidate = candidate.replace(/\\n/g, '\n');

    const isPem =
      candidate.includes('-----BEGIN RSA PRIVATE KEY-----') ||
      candidate.includes('-----BEGIN PRIVATE KEY-----');

    if (!isPem || !candidate.includes('-----END')) {
      return null;
    }

    return candidate.endsWith('\n') ? candidate : `${candidate}\n`;
  }

  private static privateKeyPathCandidates(configuredPath: string): string[] {
    const roots = [
      process.cwd(),
      path.resolve(process.cwd(), 'backend'),
      path.resolve(process.cwd(), '..'),
      path.resolve(__dirname, '../../../..'),
      path.resolve(__dirname, '../../..'),
    ];

    return [...new Set([path.resolve(configuredPath), ...roots.map((root) => path.resolve(root, configuredPath))])];
  }

  /** Authenticate Octokit as the GitHub App itself. */
  public static getAppOctokit(): Octokit {
    const privateKey = this.getPrivateKey();
    const appId = env.GITHUB_APP_ID || '123456';

    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: Number(appId),
        privateKey,
        clientId: env.GITHUB_CLIENT_ID || undefined,
        clientSecret: env.GITHUB_CLIENT_SECRET || undefined,
      },
      request: { timeout: env.GITHUB_API_TIMEOUT_MS },
      log: {
        debug: (msg: string) => logger.debug(msg),
        info: (msg: string) => logger.info(msg),
        warn: (msg: string) => logger.warn(msg),
        error: (msg: string) => logger.error(msg),
      },
    });
  }

  /** Authenticate Octokit for a specific GitHub App installation. */
  public static getInstallationOctokit(installationId: number | bigint): Octokit {
    const privateKey = this.getPrivateKey();
    const appId = env.GITHUB_APP_ID || '123456';

    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: Number(appId),
        privateKey,
        installationId: Number(installationId),
        clientId: env.GITHUB_CLIENT_ID || undefined,
        clientSecret: env.GITHUB_CLIENT_SECRET || undefined,
      },
      request: { timeout: env.GITHUB_API_TIMEOUT_MS },
    });
  }

  /** Retries transient GitHub failures with exponential backoff. */
  private static async withRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const status = (error as { status?: number }).status;
        const retryable = status === undefined || RETRYABLE_STATUS.has(status);

        if (!retryable || attempt === maxAttempts) {
          throw error;
        }

        const delay = 500 * 2 ** (attempt - 1);
        logger.warn({ label, attempt, status, delay }, 'Retrying GitHub API request');
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /** Fetch all repositories accessible by an installation and sync them to the DB. */
  public static async syncInstallationRepositories(installationId: number | bigint) {
    const octokit = this.getInstallationOctokit(installationId);
    const repositories: Array<{
      id: number;
      name: string;
      full_name: string;
      private: boolean;
      default_branch: string;
      owner: { login: string; type?: string };
    }> = [];

    let page = 1;
    const perPage = 100;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data } = await this.withRetry(
        () =>
          octokit.apps.listReposAccessibleToInstallation({
            per_page: perPage,
            page,
          }),
        'listReposAccessibleToInstallation'
      );

      repositories.push(...data.repositories);

      if (data.repositories.length < perPage || repositories.length >= 1000) {
        break;
      }
      page += 1;
    }

    const installation = await prisma.installation.upsert({
      where: { installationId: BigInt(installationId) },
      update: {},
      create: {
        installationId: BigInt(installationId),
        accountName: repositories[0]?.owner.login ?? 'Unknown',
        accountType: repositories[0]?.owner.type === 'Organization' ? 'ORGANIZATION' : 'USER',
      },
    });

    const syncedRepos = [];

    for (const repo of repositories) {
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
  }

  public static async getPullRequestDetails(
    owner: string,
    repo: string,
    pullNumber: number,
    installationId: number | bigint
  ) {
    const octokit = this.getInstallationOctokit(installationId);
    const { data } = await this.withRetry(
      () => octokit.pulls.get({ owner, repo, pull_number: pullNumber }),
      'pulls.get'
    );
    return data;
  }

  /**
   * Fetch changed files, paginated and capped by MAX_DIFF_FILES so a hostile or
   * enormous PR can never exhaust memory / OpenAI tokens.
   */
  public static async getPullRequestFiles(
    owner: string,
    repo: string,
    pullNumber: number,
    installationId: number | bigint
  ): Promise<GitHubFile[]> {
    const octokit = this.getInstallationOctokit(installationId);
    const files: GitHubFile[] = [];
    const perPage = Math.min(100, env.MAX_DIFF_FILES);

    let page = 1;
    while (files.length < env.MAX_DIFF_FILES) {
      const { data } = await this.withRetry(
        () =>
          octokit.pulls.listFiles({
            owner,
            repo,
            pull_number: pullNumber,
            per_page: perPage,
            page,
          }),
        'pulls.listFiles'
      );

      files.push(...(data as GitHubFile[]));

      if (data.length < perPage || page >= 30) {
        break;
      }
      page += 1;
    }

    return files.slice(0, env.MAX_DIFF_FILES);
  }

  /** Fetch the raw PR unified diff text. */
  public static async getPullRequestDiff(
    owner: string,
    repo: string,
    pullNumber: number,
    installationId: number | bigint
  ): Promise<string> {
    const octokit = this.getInstallationOctokit(installationId);
    const response = await this.withRetry(
      () =>
        octokit.pulls.get({
          owner,
          repo,
          pull_number: pullNumber,
          headers: { accept: 'application/vnd.github.v3.diff' },
        }),
      'pulls.get(diff)'
    );
    return response.data as unknown as string;
  }

  /** All existing inline review comments (paginated, capped at 500). */
  public static async listReviewComments(
    owner: string,
    repo: string,
    pullNumber: number,
    installationId: number | bigint
  ): Promise<GitHubPullRequestComment[]> {
    const octokit = this.getInstallationOctokit(installationId);
    const comments: GitHubPullRequestComment[] = [];
    const perPage = 100;

    let page = 1;
    while (comments.length < 500) {
      const { data } = await this.withRetry(
        () =>
          octokit.pulls.listReviewComments({
            owner,
            repo,
            pull_number: pullNumber,
            per_page: perPage,
            page,
          }),
        'pulls.listReviewComments'
      );

      comments.push(...(data as unknown as GitHubPullRequestComment[]));

      if (data.length < perPage) {
        break;
      }
      page += 1;
    }

    return comments;
  }

  public static async createReview(
    owner: string,
    repo: string,
    pullNumber: number,
    installationId: number | bigint,
    params: {
      commitId: string;
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      body: string;
      comments?: Array<{ path: string; line: number; side: 'RIGHT' | 'LEFT'; body: string }>;
    }
  ): Promise<{ id: number; htmlUrl?: string }> {
    const octokit = this.getInstallationOctokit(installationId);
    const { data } = await this.withRetry(
      () =>
        octokit.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          commit_id: params.commitId,
          event: params.event,
          body: params.body,
          ...(params.comments && params.comments.length > 0 ? { comments: params.comments } : {}),
        }),
      'pulls.createReview'
    );

    return { id: data.id, htmlUrl: data.html_url };
  }

  /** Fallback when inline review comments are rejected (e.g. 422 on stale lines). */
  public static async createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    installationId: number | bigint,
    body: string
  ): Promise<{ id: number; htmlUrl?: string }> {
    const octokit = this.getInstallationOctokit(installationId);
    const { data } = await this.withRetry(
      () =>
        octokit.issues.createComment({
          owner,
          repo,
          issue_number: issueNumber,
          body,
        }),
      'issues.createComment'
    );

    return { id: data.id, htmlUrl: data.html_url };
  }
}
