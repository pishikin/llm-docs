import { buildGitFacts } from '../git/status.js';
import type {
  ActualizationApplyInput,
  ActualizationReport,
  AdditionalDocRecord,
  GitFacts,
  LlmDocsConfigV2,
  TaskMeta,
  WorkspacePaths,
} from '../types.js';
import { protectedBaseBranches } from './branches.js';
import { readTaskMeta, updateTaskMeta } from './meta.js';
import { syncRegistryFromMeta } from './registry.js';
import { findRelatedTasks } from './related.js';

export function computeStalenessReasons(
  taskMeta: TaskMeta,
  gitFacts: GitFacts,
  config: LlmDocsConfigV2,
): string[] {
  const reasons = new Set<string>();

  if (gitFacts.head && gitFacts.head !== taskMeta.branch.last_actualized_commit) {
    reasons.add('HEAD differs from last_actualized_commit');
  }

  for (const changedPath of gitFacts.changedFiles) {
    if (taskMeta.truth.source_of_truth_paths.includes(changedPath)) {
      reasons.add(`tracked source_of_truth path changed: ${changedPath}`);
    }
  }

  if (gitFacts.branch && gitFacts.branch !== taskMeta.branch.current) {
    reasons.add(`current branch differs from stored branch: ${gitFacts.branch}`);
  }

  if (
    !config.taskBundles.markStaleOnPostCommit &&
    (gitFacts.stagedFiles.length > 0 || gitFacts.untrackedFiles.length > 0)
  ) {
    reasons.add('workspace has local changes since last task check');
  }

  if (
    gitFacts.changedFiles.some((file) =>
      taskMeta.docs.additional.some((doc) => doc.path === file || `docs/${doc.path}` === file),
    )
  ) {
    reasons.add('phase-specific doc changed outside actualization cycle');
  }

  return [...reasons];
}

export function computeImpactedTruthPaths(taskMeta: TaskMeta, gitFacts: GitFacts): string[] {
  return gitFacts.changedFiles.filter((file) =>
    taskMeta.truth.source_of_truth_paths.includes(file),
  );
}

function mergeAdditionalDocs(
  currentDocs: AdditionalDocRecord[],
  nextDocs: ActualizationApplyInput['additionalDocs'],
  timestamp: string,
): AdditionalDocRecord[] {
  if (!nextDocs || nextDocs.length === 0) {
    return currentDocs;
  }

  const currentById = new Map(currentDocs.map((doc) => [doc.id, doc]));
  for (const doc of nextDocs) {
    currentById.set(doc.id, {
      id: doc.id,
      path: doc.path,
      doc_type: doc.docType,
      phase: doc.phase,
      status: doc.status,
      title: doc.title,
      created_at: currentById.get(doc.id)?.created_at ?? timestamp,
      updated_at: timestamp,
    });
  }

  return [...currentById.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export async function prepareActualization(
  projectRoot: string,
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  taskId: string,
  options: {
    fromCommit?: string | null;
    includeRelatedTasks?: boolean;
  } = {},
): Promise<ActualizationReport> {
  const taskMeta = await readTaskMeta(paths, taskId);
  const gitFacts = await buildGitFacts(projectRoot, {
    config,
    taskMeta,
    fromRef:
      options.fromCommit ??
      taskMeta.branch.last_actualized_commit ??
      taskMeta.branch.last_verified_commit,
  });
  const reasons = computeStalenessReasons(taskMeta, gitFacts, config);
  const changedTruthPaths = computeImpactedTruthPaths(taskMeta, gitFacts);
  const changedRelatedDocs = gitFacts.changedFiles.filter((file) =>
    taskMeta.related.docs.includes(file),
  );
  const relatedTasks = options.includeRelatedTasks
    ? await findRelatedTasks(paths, {
        query: `${taskMeta.title} ${taskMeta.related.tags.join(' ')}`.trim(),
        paths: [...taskMeta.truth.source_of_truth_paths, ...gitFacts.changedFiles],
        limit: config.taskBundles.relatedTaskLimit,
        includeArchived: true,
        excludeSelfTaskId: taskId,
      })
    : [];

  return {
    taskId,
    bundlePath: taskMeta.bundle.path,
    needsActualization: reasons.length > 0,
    reasons,
    git: {
      branch: gitFacts.branch,
      baseBranch: gitFacts.baseBranch,
      head: gitFacts.head,
      lastActualizedCommit: taskMeta.branch.last_actualized_commit,
      changedFiles: gitFacts.changedFiles,
      stagedFiles: gitFacts.stagedFiles,
      untrackedFiles: gitFacts.untrackedFiles,
    },
    impacts: {
      changedTruthPaths,
      changedRelatedDocs,
      suggestUpdateTaskSpec: changedRelatedDocs.some((file) => file.endsWith('task.md')),
      suggestUpdateContext: reasons.length > 0,
      suggestAppendChangelog: gitFacts.changedFiles.length > 0,
      suggestPhaseDoc: null,
      suggestTruthReview:
        changedTruthPaths.length > 0 || gitFacts.branch !== taskMeta.branch.current,
    },
    suggestions: {
      sourceOfTruthCandidates: [...new Set([...changedTruthPaths, ...gitFacts.changedFiles])].slice(
        0,
        10,
      ),
      readFirst: [
        'task.md',
        'context.md',
        ...changedTruthPaths,
        ...gitFacts.changedFiles.slice(0, 5),
      ].filter((value, index, array) => array.indexOf(value) === index),
      relatedTasks,
    },
  };
}

export async function applyActualizationState(
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  taskId: string,
  input: ActualizationApplyInput,
): Promise<TaskMeta> {
  const timestamp = new Date().toISOString();
  const meta = await updateTaskMeta(paths, taskId, (current) => ({
    ...current,
    phase: input.phase ?? current.phase,
    status: input.status ?? current.status,
    branch: {
      ...current.branch,
      last_actualized_commit: input.lastActualizedCommit,
    },
    truth: {
      ...current.truth,
      source_of_truth_paths: input.sourceOfTruthPaths ?? current.truth.source_of_truth_paths,
      current_truth_note:
        input.truthNote === undefined ? current.truth.current_truth_note : input.truthNote,
    },
    related: {
      ...current.related,
      docs: input.relatedDocs ?? current.related.docs,
    },
    docs: {
      ...current.docs,
      additional: mergeAdditionalDocs(current.docs.additional, input.additionalDocs, timestamp),
    },
    staleness: {
      needs_actualization: input.clearStaleness ? false : current.staleness.needs_actualization,
      reasons: input.clearStaleness ? [] : current.staleness.reasons,
      last_checked_at: timestamp,
    },
  }));

  await syncRegistryFromMeta(paths, meta, {
    skipBranches: [...protectedBaseBranches(config)],
  });
  return meta;
}
