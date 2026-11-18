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
   * Determine if a file should be ignored during AI code review
   */
  public static shouldIgnoreFile(filePath: string): { ignore: boolean; reason?: string } {
    const fileName = filePath.split('/').pop() || filePath;

    if (this.IGNORED_FILENAMES.includes(fileName)) {
      return { ignore: true, reason: 'Generated package lock file' };
    }

    for (const ext of this.IGNORED_EXTENSIONS) {
      if (filePath.endsWith(ext)) {
        return { ignore: true, reason: `Ignored file type (${ext})` };
      }
    }

    return { ignore: false };
  }

  /**
   * Parse GitHub pulls.listFiles response into structured diff objects
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

      const isIgnored = ignoreCheck.ignore || isDeleted || !file.patch;
      const ignoreReason = ignoreCheck.reason || (isDeleted ? 'Deleted file' : !file.patch ? 'No text diff' : undefined);

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
   * Extract line number map from a patch hunk
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

      if (line.startsWith('+')) {
        result.push({ newNumber: currentNewLine, content: line.substring(1) });
        currentNewLine++;
      } else if (line.startsWith('-')) {
        // Deletions do not increment new line counter
        continue;
      } else {
        // Context line
        currentNewLine++;
      }
    }

    return result;
  }
}
