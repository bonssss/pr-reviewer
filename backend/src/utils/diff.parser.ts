export interface ParsedFileDiff {
  filePath: string;
  previousFilePath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
  isIgnored: boolean;
  ignoreReason?: string;
}

export interface ParsedDiffSummary {
  totalFiles: number;
  reviewableFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  files: ParsedFileDiff[];
}

export class DiffParser {
  private static readonly IGNORED_EXTENSIONS = [
    '.lock',
    '.svg',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.ico',
    '.pdf',
    '.zip',
    '.tar',
    '.gz',
    '.map',
    '.min.js',
    '.min.css',
  ];

  private static readonly IGNORED_FILENAMES = [
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'Cargo.lock',
    'composer.lock',
    'poetry.lock',
    'Gemfile.lock',
  ];

  /**
   * Files that are very likely to contain credentials. They are excluded from
   * the diff *before* it is sent to the AI provider so secrets never leave the
   * server, and they are never echoed back in review comments.
   */
  private static readonly SECRET_FILE_PATTERNS: RegExp[] = [
    /(^|\/)\.env(\..+)?$/i,
    /(^|\/)\.npmrc$/i,
    /(^|\/)\.netrc$/i,
    /(^|\/)\.pypirc$/i,
    /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
    /\.(pem|key|p12|pfx|keystore|jks)$/i,
    /(^|\/)secrets?\.(json|ya?ml|toml|ini|env)$/i,
    /(^|\/)credentials?(\.|$)/i,
    /(^|\/)service[-_]?account.*\.json$/i,
    /(^|\/)terraform\.tfstate(\.backup)?$/i,
    /(^|\/)kubeconfig$/i,
  ];

  private static readonly SECRET_CONTENT_PATTERNS: RegExp[] = [
    /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    /\bsk-[A-Za-z0-9_-]{32,}\b/,
  ];

  /** Determine if a file should be ignored during AI code review. */
  public static shouldIgnoreFile(filePath: string): { ignore: boolean; reason?: string } {
    const fileName = filePath.split('/').pop() || filePath;

    if (this.IGNORED_FILENAMES.includes(fileName)) {
      return { ignore: true, reason: 'Generated package lock file' };
    }

    for (const pattern of this.SECRET_FILE_PATTERNS) {
      if (pattern.test(filePath)) {
        return { ignore: true, reason: 'Potential secret or credential file' };
      }
    }

    for (const ext of this.IGNORED_EXTENSIONS) {
      if (filePath.endsWith(ext)) {
        return { ignore: true, reason: `Ignored file type (${ext})` };
      }
    }

    return { ignore: false };
  }

  /** True when a patch appears to contain a credential that must not be sent to an LLM. */
  public static patchContainsSecret(patch: string | undefined): boolean {
    if (!patch) return false;
    return this.SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(patch));
  }

  /**
   * Parse GitHub pulls.listFiles response into structured diff objects.
   */
  public static parseGitHubFiles(
    files: Array<{
      filename: string;
      previous_filename?: string;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
      patch?: string;
    }>
  ): ParsedDiffSummary {
    let totalAdditions = 0;
    let totalDeletions = 0;
    let reviewableCount = 0;

    const parsedFiles: ParsedFileDiff[] = files.map((file) => {
      totalAdditions += file.additions;
      totalDeletions += file.deletions;

      const ignoreCheck = this.shouldIgnoreFile(file.filename);
      const isDeleted = file.status === 'removed' || file.status === 'deleted';
      const hasSecret = this.patchContainsSecret(file.patch);

      const isIgnored = ignoreCheck.ignore || isDeleted || !file.patch || hasSecret;
      const ignoreReason =
        ignoreCheck.reason ||
        (isDeleted
          ? 'Deleted file'
          : !file.patch
            ? 'No text diff'
            : hasSecret
              ? 'Diff contains potential credentials'
              : undefined);

      if (!isIgnored) {
        reviewableCount++;
      }

      return {
        filePath: file.filename,
        previousFilePath: file.previous_filename,
        status: (file.status === 'removed' ? 'deleted' : file.status) as ParsedFileDiff['status'],
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch || '',
        isIgnored,
        ignoreReason,
      };
    });

    return {
      totalFiles: files.length,
      reviewableFiles: reviewableCount,
      totalAdditions,
      totalDeletions,
      files: parsedFiles,
    };
  }

  /**
   * Extract line number map from a patch hunk (added lines only).
   */
  public static extractHunkLines(patch: string): Array<{ newNumber: number; content: string }> {
    const lines = patch.split('\n');
    const result: Array<{ newNumber: number; content: string }> = [];
    let currentNewLine = 0;

    for (const line of lines) {
      // Look for hunk header @@ -start,len +start,len @@
      const hunkHeader = line.match(/^@@\s+-[0-9]+(?:,[0-9]+)?\s+\+([0-9]+)(?:,[0-9]+)?\s+@@/);
      if (hunkHeader && hunkHeader[1]) {
        currentNewLine = parseInt(hunkHeader[1], 10);
        continue;
      }

      // "\ No newline at end of file" is metadata, not a diff line.
      if (line.startsWith('\\')) {
        continue;
      }

      if (line.startsWith('+')) {
        result.push({ newNumber: currentNewLine, content: line.substring(1) });
        currentNewLine++;
      } else if (line.startsWith('-')) {
        // Deletions do not increment the new-file line counter.
        continue;
      } else {
        // Context line
        currentNewLine++;
      }
    }

    return result;
  }

  /**
   * Builds the set of `path:line` positions that GitHub will accept as inline
   * review comments (added lines on the RIGHT side).
   */
  public static buildValidRightLines(
    files: Array<{ filename: string; patch?: string; status?: string }>
  ): Set<string> {
    const valid = new Set<string>();

    for (const file of files) {
      if (!file.patch) continue;
      for (const line of this.extractHunkLines(file.patch)) {
        valid.add(`${file.filename}:${line.newNumber}`);
      }
    }

    return valid;
  }
}
