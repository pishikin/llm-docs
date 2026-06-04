import { buildGitFacts } from '../git/status.js';
import type {
  LlmDocsConfigV2,
  RebaselineApplyInput,
  RebaselineReport,
  TaskMeta,
  WorkspacePaths,
} from '../types.js';
import { archiveTask } from './archive.js';
import { protectedBaseBranches } from './branches.js';
import { markDocsHistorical, readTaskMeta, updateTaskMeta } from './meta.js';
import { syncRegistryFromMeta } from './registry.js';

function suggestPhase(
  currentBranch: string | null,
  targetBranch: string,
  current: TaskMeta,
): TaskMeta['phase'] {
  if (currentBranch === targetBranch) {
    return 'merged';
  }

  return current.phase;
}

export async function prepareRebaseline(
  projectRoot: string,
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  taskId: string,
  options: { targetBranch?: string } = {},
): Promise<RebaselineReport> {
  const meta = await readTaskMeta(paths, taskId);
  const gitFacts = await buildGitFacts(projectRoot, { config, taskMeta: meta });
  const targetBranch = options.targetBranch ?? config.taskBundles.defaultBaseBranch;
  const suggestedPhase = suggestPhase(gitFacts.branch, targetBranch, meta);
  const historicalDocs = meta.docs.additional
    .filter((doc) => doc.status === 'active' && doc.phase !== suggestedPhase)
    .map((doc) => doc.path);

  return {
    taskId,
    bundlePath: meta.bundle.path,
    currentBranch: gitFacts.branch,
    head: gitFacts.head,
    previousPhase: meta.phase,
    suggestedPhase,
    historicalDocs,
    truthTransition: {
      previousTruthPaths: meta.truth.source_of_truth_paths,
      suggestedTruthPaths: meta.truth.source_of_truth_paths,
      note:
        suggestedPhase === 'merged'
          ? 'Main branch is now the active baseline. Branch-only rollout notes should be treated as historical context.'
          : 'Current branch remains the active baseline.',
    },
    suggestions: {
      updateContext: true,
      appendChangelog: true,
      archiveTask: false,
    },
  };
}

export async function applyRebaselineState(
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  taskId: string,
  input: RebaselineApplyInput,
): Promise<TaskMeta> {
  if (input.historicalDocs.length > 0) {
    await markDocsHistorical(paths, taskId, input.historicalDocs);
  }

  const meta = await updateTaskMeta(paths, taskId, (current) => ({
    ...current,
    phase: input.phase,
    status: input.status,
    branch: {
      ...current.branch,
      current: input.currentBranch,
      last_verified_commit: input.lastVerifiedCommit,
    },
    truth: {
      ...current.truth,
      source_of_truth_paths: input.sourceOfTruthPaths,
      current_truth_note:
        input.currentBranch === current.branch.base
          ? 'Main branch is now the active baseline.'
          : current.truth.current_truth_note,
    },
  }));

  await syncRegistryFromMeta(paths, meta, {
    skipBranches: [...protectedBaseBranches(config)],
  });

  if (input.archiveTask) {
    return archiveTask(paths, taskId, 'Archived during rebaseline.');
  }

  return meta;
}
