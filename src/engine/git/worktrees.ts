import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { LlmDocsConfig } from '../types.js';
import { getCurrentBranch, getHeadCommit } from './facts.js';

export interface GitWorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export async function getGitCommonDir(projectRoot: string): Promise<string | null> {
  try {
    const raw = (await simpleGit(projectRoot).raw(['rev-parse', '--git-common-dir'])).trim();
    return await fs.realpath(path.resolve(projectRoot, raw));
  } catch {
    return null;
  }
}

export async function isGitWorktree(projectRoot: string): Promise<boolean> {
  try {
    await simpleGit(projectRoot).raw(['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

function parseBranchRef(value: string): string | null {
  const prefix = 'refs/heads/';
  return value.startsWith(prefix) ? value.slice(prefix.length) : value || null;
}

export function parseGitWorktreeListPorcelain(output: string): GitWorktreeInfo[] {
  const result: GitWorktreeInfo[] = [];
  let current: GitWorktreeInfo | null = null;

  for (const line of output.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (current) {
        result.push(current);
        current = null;
      }
      continue;
    }

    const [key, ...rest] = trimmed.split(' ');
    const value = rest.join(' ');

    if (key === 'worktree') {
      if (current) {
        result.push(current);
      }
      current = {
        path: value,
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (key === 'HEAD') {
      current.head = value || null;
    } else if (key === 'branch') {
      current.branch = parseBranchRef(value);
    } else if (key === 'bare') {
      current.bare = true;
    } else if (key === 'detached') {
      current.detached = true;
    } else if (key === 'locked') {
      current.locked = true;
    } else if (key === 'prunable') {
      current.prunable = true;
    }
  }

  if (current) {
    result.push(current);
  }

  return result;
}

export async function listGitWorktrees(projectRoot: string): Promise<GitWorktreeInfo[]> {
  try {
    const output = await simpleGit(projectRoot).raw(['worktree', 'list', '--porcelain']);
    return parseGitWorktreeListPorcelain(output).map((entry) => ({
      ...entry,
      path: path.resolve(entry.path),
    }));
  } catch {
    return [];
  }
}

export async function getGitRootInfo(projectRoot: string): Promise<{
  branch: string | null;
  head: string | null;
  commonDir: string | null;
}> {
  return {
    branch: await getCurrentBranch(projectRoot),
    head: await getHeadCommit(projectRoot),
    commonDir: await getGitCommonDir(projectRoot),
  };
}

export function getConfiguredMainBranch(config: LlmDocsConfig): string {
  return config.worktrees?.mainBranch ?? config.taskBundles.defaultBaseBranch;
}
