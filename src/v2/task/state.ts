import path from 'node:path';
import {
  fileExists,
  normalizeRelativePath,
  readFileSafe,
  writeJsonAtomic,
} from '../../utils/fs.js';
import { simpleTaskStateSchema } from '../config/schema.js';
import { TaskMetaError } from '../errors.js';
import type { SimpleTaskState, TaskBundleCreateInput, TaskMeta, WorkspacePaths } from '../types.js';
import { resolveTaskBundlePath } from '../workspace/paths.js';

export const SIMPLE_CONTEXT_PATH = 'context.md';
export const SIMPLE_STATE_PATH = 'state.json';
export const SIMPLE_ARTIFACT_INDEX_PATH = 'artifacts/index.json';

export function resolveTaskStatePath(paths: WorkspacePaths, taskId: string): string {
  return path.join(resolveTaskBundlePath(paths, taskId), SIMPLE_STATE_PATH);
}

export function resolveTaskContextPath(paths: WorkspacePaths, taskId: string): string {
  return path.join(resolveTaskBundlePath(paths, taskId), SIMPLE_CONTEXT_PATH);
}

export async function taskHasSimpleState(paths: WorkspacePaths, taskId: string): Promise<boolean> {
  return fileExists(resolveTaskStatePath(paths, taskId));
}

export function buildInitialSimpleTaskState(args: {
  projectRoot: string;
  paths: WorkspacePaths;
  taskId: string;
  input: TaskBundleCreateInput;
  now: string;
  branch: string | null;
  baseBranch: string;
  head: string | null;
}): SimpleTaskState {
  const bundlePath = normalizeRelativePath(
    path.relative(args.projectRoot, resolveTaskBundlePath(args.paths, args.taskId)),
  );
  const tags = [...new Set((args.input.tags ?? []).map((tag) => tag.toLowerCase()))];

  return {
    schemaVersion: 1,
    taskId: args.taskId,
    title: args.input.title,
    status: 'active',
    phase: 'implementation',
    source: {
      type: args.input.source.type,
      ref: args.input.source.ref,
      url: args.input.source.url,
    },
    bundle: {
      path: bundlePath,
      createdAt: args.now,
      updatedAt: args.now,
      createdBy: 'llm-docs',
      layout: 'simple',
    },
    branch: {
      current: args.branch,
      base: args.baseBranch,
      linkedBranches: args.branch ? [args.branch] : [],
      lastVerifiedCommit: args.head,
      lastActualizedCommit: args.head,
    },
    staleness: {
      needsActualization: false,
      reasons: [],
      lastCheckedAt: args.now,
    },
    related: {
      docs: [...new Set(args.input.relatedDocs ?? [])],
      tasks: [],
      tags,
    },
    truth: {
      sourceOfTruthPaths: [],
      sourceOfTruthDocs: [SIMPLE_CONTEXT_PATH, 'raw.md', 'changelog.md'],
      currentTruthNote: args.branch ? 'Implementation branch is current truth until merge.' : null,
    },
    docs: {
      context: SIMPLE_CONTEXT_PATH,
      additional: [],
    },
    artifacts: {
      indexPath: SIMPLE_ARTIFACT_INDEX_PATH,
      count: 0,
    },
    qualityProfile: 'normal',
    checkpoint: {
      lastCheckpointAt: null,
      lastCheckpointHead: null,
      lastAutosaveAt: null,
      lastTranscriptOffset: null,
      estimatedTranscriptTokens: null,
      promptCountSinceCheckpoint: 0,
      needsQualityCheckpoint: true,
      lastContextWarningKey: null,
      lastContextWarningAt: null,
    },
    history: {
      archived: false,
      archived_at: null,
      archive_reason: null,
    },
  };
}

export function simpleStateToTaskMeta(state: SimpleTaskState): TaskMeta {
  return {
    schema_version: 1,
    task_id: state.taskId,
    title: state.title,
    status: state.status,
    phase: state.phase,
    source: state.source,
    bundle: {
      path: state.bundle.path,
      created_at: state.bundle.createdAt,
      updated_at: state.bundle.updatedAt,
      created_by: 'llm-docs',
      version: 1,
    },
    branch: {
      current: state.branch.current,
      base: state.branch.base,
      linked_branches: state.branch.linkedBranches,
      last_verified_commit: state.branch.lastVerifiedCommit,
      last_actualized_commit: state.branch.lastActualizedCommit,
    },
    truth: {
      source_of_truth_paths: state.truth.sourceOfTruthPaths,
      source_of_truth_docs: state.truth.sourceOfTruthDocs,
      current_truth_note: state.truth.currentTruthNote,
    },
    staleness: {
      needs_actualization: state.staleness.needsActualization,
      reasons: state.staleness.reasons,
      last_checked_at: state.staleness.lastCheckedAt,
    },
    related: state.related,
    docs: {
      primary: {
        raw: 'raw.md',
        task: 'task.md',
        context: state.docs.context,
        changelog: 'changelog.md',
      },
      additional: state.docs.additional,
    },
    artifacts: {
      index_path: state.artifacts.indexPath,
      count: state.artifacts.count,
    },
    history: state.history,
  };
}

export function taskMetaToSimpleState(meta: TaskMeta): SimpleTaskState {
  return {
    schemaVersion: 1,
    taskId: meta.task_id,
    title: meta.title,
    status: meta.status,
    phase: meta.phase,
    source: meta.source,
    bundle: {
      path: meta.bundle.path,
      createdAt: meta.bundle.created_at,
      updatedAt: meta.bundle.updated_at,
      createdBy: 'llm-docs',
      layout: 'simple',
    },
    branch: {
      current: meta.branch.current,
      base: meta.branch.base,
      linkedBranches: meta.branch.linked_branches,
      lastVerifiedCommit: meta.branch.last_verified_commit,
      lastActualizedCommit: meta.branch.last_actualized_commit,
    },
    staleness: {
      needsActualization: meta.staleness.needs_actualization,
      reasons: meta.staleness.reasons,
      lastCheckedAt: meta.staleness.last_checked_at,
    },
    related: meta.related,
    truth: {
      sourceOfTruthPaths: meta.truth.source_of_truth_paths,
      sourceOfTruthDocs: meta.truth.source_of_truth_docs.length
        ? meta.truth.source_of_truth_docs
        : [SIMPLE_CONTEXT_PATH],
      currentTruthNote: meta.truth.current_truth_note,
    },
    docs: {
      context: meta.docs.primary.context || SIMPLE_CONTEXT_PATH,
      additional: meta.docs.additional,
    },
    artifacts: {
      indexPath: meta.artifacts.index_path || SIMPLE_ARTIFACT_INDEX_PATH,
      count: meta.artifacts.count,
    },
    qualityProfile: 'normal',
    checkpoint: {
      lastCheckpointAt: null,
      lastCheckpointHead: null,
      lastAutosaveAt: null,
      lastTranscriptOffset: null,
      estimatedTranscriptTokens: null,
      promptCountSinceCheckpoint: 0,
      needsQualityCheckpoint: true,
      lastContextWarningKey: null,
      lastContextWarningAt: null,
    },
    history: meta.history,
  };
}

export async function readTaskState(
  paths: WorkspacePaths,
  taskId: string,
): Promise<SimpleTaskState> {
  const statePath = resolveTaskStatePath(paths, taskId);
  const content = await readFileSafe(statePath);

  if (content === null) {
    throw new TaskMetaError(
      `Task state not found or invalid JSON: ${path.relative(paths.projectRoot, statePath)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new TaskMetaError(`Task state JSON parse failed for ${taskId}`, error);
  }

  const result = simpleTaskStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new TaskMetaError(`Task state schema validation failed for ${taskId}`, result.error);
  }

  if (result.data.taskId !== taskId) {
    throw new TaskMetaError(
      `Task state id mismatch: expected ${taskId}, got ${result.data.taskId}`,
    );
  }

  return result.data;
}

export async function readTaskStateOrNull(
  paths: WorkspacePaths,
  taskId: string,
): Promise<SimpleTaskState | null> {
  try {
    return await readTaskState(paths, taskId);
  } catch {
    return null;
  }
}

export async function writeTaskState(
  paths: WorkspacePaths,
  taskId: string,
  state: SimpleTaskState,
): Promise<SimpleTaskState> {
  const result = simpleTaskStateSchema.safeParse(state);
  if (!result.success) {
    throw new TaskMetaError(`Refusing to write invalid task state for ${taskId}`, result.error);
  }

  if (result.data.taskId !== taskId) {
    throw new TaskMetaError(
      `Task state id mismatch: expected ${taskId}, got ${result.data.taskId}`,
    );
  }

  await writeJsonAtomic(resolveTaskStatePath(paths, taskId), result.data);
  return result.data;
}

export async function updateTaskState(
  paths: WorkspacePaths,
  taskId: string,
  updater: (state: SimpleTaskState) => SimpleTaskState | Promise<SimpleTaskState>,
): Promise<SimpleTaskState> {
  const current = await readTaskState(paths, taskId);
  const timestamp = new Date().toISOString();
  const next = await updater(current);
  return writeTaskState(paths, taskId, {
    ...next,
    bundle: {
      ...next.bundle,
      updatedAt: timestamp,
    },
  });
}
