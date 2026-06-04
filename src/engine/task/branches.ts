import type { LlmDocsConfig } from '../types.js';

export function protectedBaseBranches(config?: LlmDocsConfig): Set<string> {
  return new Set(
    [config?.taskBundles.defaultBaseBranch, config?.worktrees?.mainBranch, 'main', 'master'].filter(
      (branch): branch is string => !!branch,
    ),
  );
}

export function shouldAutoLinkBranch(
  branch: string | null | undefined,
  config?: LlmDocsConfig,
): branch is string {
  return !!branch && !protectedBaseBranches(config).has(branch);
}
