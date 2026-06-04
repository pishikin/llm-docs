import { simpleGit } from 'simple-git';
import { normalizeRelativePath } from '../../utils/fs.js';
import type { LlmDocsConfigV2, TaskMeta } from '../types.js';

export async function getCurrentBranch(root: string): Promise<string | null> {
  try {
    const git = simpleGit(root);
    const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    return branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}

export async function getHeadCommit(root: string): Promise<string | null> {
  try {
    const git = simpleGit(root);
    return (await git.revparse(['HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

export function getBaseBranch(_root: string, config: LlmDocsConfigV2, taskMeta?: TaskMeta): string {
  return taskMeta?.branch.base || config.taskBundles.defaultBaseBranch;
}

async function getNameOnlyLines(root: string, args: string[]): Promise<string[]> {
  try {
    const git = simpleGit(root);
    const output = await git.raw(args);
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => normalizeRelativePath(line));
  } catch {
    return [];
  }
}

export async function getChangedFilesSince(root: string, ref: string | null): Promise<string[]> {
  if (!ref) {
    return [];
  }

  return getNameOnlyLines(root, ['diff', '--name-only', `${ref}..HEAD`]);
}

export async function getStagedFiles(root: string): Promise<string[]> {
  return getNameOnlyLines(root, ['diff', '--cached', '--name-only']);
}

export async function getUntrackedFiles(root: string): Promise<string[]> {
  try {
    const git = simpleGit(root);
    const status = await git.status();
    return status.not_added.map((file) => normalizeRelativePath(file));
  } catch {
    return [];
  }
}

export async function getAheadBehind(
  root: string,
  baseBranch: string,
): Promise<{ ahead: number; behind: number }> {
  try {
    const git = simpleGit(root);
    const output = (await git.raw(['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`]))
      .trim()
      .split(/\s+/);
    const behind = Number.parseInt(output[0] ?? '0', 10) || 0;
    const ahead = Number.parseInt(output[1] ?? '0', 10) || 0;
    return { ahead, behind };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}
