import type { GitFacts, LlmDocsConfig, TaskMeta } from '../types.js';
import {
  getAheadBehind,
  getBaseBranch,
  getChangedFilesSince,
  getCurrentBranch,
  getHeadCommit,
  getStagedFiles,
  getUntrackedFiles,
} from './facts.js';
import { safeMergeBase } from './refs.js';

export async function buildGitFacts(
  root: string,
  options: {
    config: LlmDocsConfig;
    taskMeta?: TaskMeta;
    fromRef?: string | null;
    baseBranch?: string;
  },
): Promise<GitFacts> {
  const branch = await getCurrentBranch(root);
  const head = await getHeadCommit(root);
  const baseBranch = options.baseBranch ?? getBaseBranch(root, options.config, options.taskMeta);
  const mergeBase =
    branch && branch !== baseBranch ? await safeMergeBase(root, branch, baseBranch) : head;
  const changedFiles = await getChangedFilesSince(
    root,
    options.fromRef ??
      options.taskMeta?.branch.last_actualized_commit ??
      options.taskMeta?.branch.last_verified_commit ??
      mergeBase,
  );
  const stagedFiles = await getStagedFiles(root);
  const untrackedFiles = await getUntrackedFiles(root);
  const aheadBehind = await getAheadBehind(root, baseBranch);

  return {
    branch,
    baseBranch,
    head,
    mergeBase,
    changedFiles,
    stagedFiles,
    untrackedFiles,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
  };
}
