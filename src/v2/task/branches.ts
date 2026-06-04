import type { LlmDocsConfigV2 } from '../types.js';

export function protectedBaseBranches(config?: LlmDocsConfigV2): Set<string> {
  return new Set(
    [config?.taskBundles.defaultBaseBranch, config?.worktrees?.mainBranch, 'main', 'master'].filter(
      (branch): branch is string => !!branch,
    ),
  );
}

export function shouldAutoLinkBranch(
  branch: string | null | undefined,
  config?: LlmDocsConfigV2,
): branch is string {
  return !!branch && !protectedBaseBranches(config).has(branch);
}
