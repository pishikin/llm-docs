import { simpleGit } from 'simple-git';

export async function safeMergeBase(
  root: string,
  refA: string,
  refB: string,
): Promise<string | null> {
  try {
    const git = simpleGit(root);
    const value = (await git.raw(['merge-base', refA, refB])).trim();
    return value || null;
  } catch {
    return null;
  }
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    const git = simpleGit(root);
    const output = (await git.raw(['branch', '--list', branch])).trim();
    return Boolean(output);
  } catch {
    return false;
  }
}
