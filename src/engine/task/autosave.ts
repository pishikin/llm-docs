import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ensureDir, normalizeRelativePath, writeJsonAtomic } from '../../utils/fs.js';
import { buildGitFacts } from '../git/status.js';
import type { LlmDocsConfig, SimpleTaskState, TaskMeta, WorkspacePaths } from '../types.js';
import { readTaskMeta } from './meta.js';
import { bindCodexSessionToTask, readCodexSessionBinding } from './session-binding.js';
import {
  readTaskStateOrNull,
  resolveTaskStatePath,
  taskMetaToSimpleState,
  writeTaskState,
} from './state.js';

export interface CodexAutosaveInput {
  sessionId: string;
  transcriptPath: string;
  hookEventName?: string | null;
  lastAssistantMessage?: string | null;
}

export interface CodexAutosaveSnapshot {
  schemaVersion: 1;
  host: 'codex';
  taskId: string;
  sessionId: string;
  transcriptPath: string;
  updatedAt: string;
  transcriptOffset: number;
  estimatedTranscriptTokens: number;
  lastAssistantMessage: string | null;
  hookEventName: string | null;
}

export interface CodexWatchInput extends CodexAutosaveInput {
  once?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface ContextCheckpointRequirement {
  required: boolean;
  blockingReasons: string[];
  advisoryReasons: string[];
  reasons: string[];
  warningKey: string | null;
}

const CHECKPOINT_REASON_NO_CHECKPOINT =
  'workspace has material changes but no context checkpoint is saved';
const CHECKPOINT_REASON_STALE_CHECKPOINT =
  'workspace has material changes and the context checkpoint is stale';
const CHECKPOINT_REASON_PROMPT_COUNT =
  'three or more user prompts happened after the last checkpoint';
const CHECKPOINT_REASON_TRANSCRIPT_RISK =
  'Codex transcript is near a conservative compaction risk threshold';

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
}

function estimateTokensFromBytes(byteLength: number): number {
  return Math.ceil(byteLength / 4);
}

function runtimeSnapshotPath(paths: WorkspacePaths, sessionId: string): string {
  return path.join(
    paths.workspaceRoot,
    '.llm-docs/runtime/codex',
    `${safeFileName(sessionId)}.json`,
  );
}

async function acquireWatcherLock(lockPath: string): Promise<fs.FileHandle | null> {
  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(`${process.pid}\n`, 'utf-8');
    return handle;
  } catch {
    const existingPid = Number.parseInt((await readLockPid(lockPath)) ?? '', 10);
    if (Number.isFinite(existingPid) && isProcessAlive(existingPid)) {
      return null;
    }

    await fs.rm(lockPath, { force: true });
    const handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(`${process.pid}\n`, 'utf-8');
    return handle;
  }
}

async function readLockPid(lockPath: string): Promise<string | null> {
  try {
    return await fs.readFile(lockPath, 'utf-8');
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readTranscriptSize(transcriptPath: string): Promise<number | null> {
  try {
    return (await fs.stat(transcriptPath)).size;
  } catch {
    return null;
  }
}

function truncate(value: string | null | undefined, limit = 4000): string | null {
  if (!value) {
    return null;
  }

  return value.length > limit ? value.slice(-limit) : value;
}

async function loadStateForAutosave(
  paths: WorkspacePaths,
  taskId: string,
  meta: TaskMeta,
): Promise<SimpleTaskState> {
  return (await readTaskStateOrNull(paths, taskId)) ?? taskMetaToSimpleState(meta);
}

function updateStateFromSnapshot(
  state: SimpleTaskState,
  snapshot: CodexAutosaveSnapshot,
): SimpleTaskState {
  return {
    ...state,
    checkpoint: {
      ...state.checkpoint,
      lastAutosaveAt: snapshot.updatedAt,
      lastTranscriptOffset: snapshot.transcriptOffset,
      estimatedTranscriptTokens: snapshot.estimatedTranscriptTokens,
    },
  };
}

export async function saveCodexAutosaveSnapshot(
  paths: WorkspacePaths,
  taskId: string,
  input: CodexAutosaveInput,
): Promise<CodexAutosaveSnapshot | null> {
  const transcriptSize = await readTranscriptSize(input.transcriptPath);
  if (transcriptSize === null) {
    return null;
  }

  const meta = await readTaskMeta(paths, taskId);
  const updatedAt = new Date().toISOString();
  const snapshot: CodexAutosaveSnapshot = {
    schemaVersion: 1,
    host: 'codex',
    taskId,
    sessionId: input.sessionId,
    transcriptPath: input.transcriptPath,
    updatedAt,
    transcriptOffset: transcriptSize,
    estimatedTranscriptTokens: estimateTokensFromBytes(transcriptSize),
    lastAssistantMessage: truncate(input.lastAssistantMessage),
    hookEventName: input.hookEventName ?? null,
  };
  const state = await loadStateForAutosave(paths, taskId, meta);

  await writeJsonAtomic(runtimeSnapshotPath(paths, input.sessionId), snapshot);
  await bindCodexSessionToTask(paths, {
    sessionId: input.sessionId,
    taskId,
    source: 'autosave',
    bundlePath: meta.bundle.path,
    transcriptPath: snapshot.transcriptPath,
    transcriptOffset: snapshot.transcriptOffset,
    estimatedTranscriptTokens: snapshot.estimatedTranscriptTokens,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    hookEventName: snapshot.hookEventName,
  });
  await writeTaskState(paths, taskId, updateStateFromSnapshot(state, snapshot));

  return snapshot;
}

export async function markPromptSeen(
  paths: WorkspacePaths,
  taskId: string,
  isMaterialPrompt: boolean,
): Promise<void> {
  const meta = await readTaskMeta(paths, taskId);
  const state = await loadStateForAutosave(paths, taskId, meta);

  await writeTaskState(paths, taskId, {
    ...state,
    checkpoint: {
      ...state.checkpoint,
      promptCountSinceCheckpoint: state.checkpoint.promptCountSinceCheckpoint + 1,
      needsQualityCheckpoint: state.checkpoint.needsQualityCheckpoint || isMaterialPrompt,
    },
  });
}

function buildContextWarningKey(reasons: string[], state: SimpleTaskState): string {
  const tokenBucket =
    state.checkpoint.estimatedTranscriptTokens === null
      ? 'no-transcript'
      : Math.floor(state.checkpoint.estimatedTranscriptTokens / 5000) * 5000;
  const promptBucket = Math.floor(state.checkpoint.promptCountSinceCheckpoint / 3) * 3;

  return `${reasons.join('|')}:tokens=${tokenBucket}:prompts=${promptBucket}`;
}

export async function markContextWarningSeen(
  paths: WorkspacePaths,
  taskId: string,
  warningKey: string,
): Promise<boolean> {
  const meta = await readTaskMeta(paths, taskId);
  const state = await loadStateForAutosave(paths, taskId, meta);

  if (state.checkpoint.lastContextWarningKey === warningKey) {
    return false;
  }

  await writeTaskState(paths, taskId, {
    ...state,
    checkpoint: {
      ...state.checkpoint,
      lastContextWarningKey: warningKey,
      lastContextWarningAt: new Date().toISOString(),
    },
  });

  return true;
}

function fileMatchesTaskScope(file: string, meta: TaskMeta): boolean {
  const humanBundleFiles = [
    path.posix.join(meta.bundle.path, meta.docs.primary.context),
    path.posix.join(meta.bundle.path, meta.docs.primary.changelog),
    path.posix.join(meta.bundle.path, meta.docs.primary.raw),
    path.posix.join(meta.bundle.path, meta.docs.primary.task),
  ];

  return (
    humanBundleFiles.includes(file) ||
    meta.truth.source_of_truth_paths.includes(file) ||
    meta.related.docs.includes(file) ||
    meta.docs.additional.some((doc) => doc.path === file)
  );
}

function hasScopedTaskPaths(meta: TaskMeta): boolean {
  return (
    meta.truth.source_of_truth_paths.length > 0 ||
    meta.related.docs.length > 0 ||
    meta.docs.additional.length > 0
  );
}

function hasTaskRelevantChanges(
  meta: TaskMeta,
  gitFacts: {
    changedFiles: string[];
    stagedFiles: string[];
    untrackedFiles: string[];
  },
): boolean {
  const allChangedFiles = [
    ...gitFacts.changedFiles,
    ...gitFacts.stagedFiles,
    ...gitFacts.untrackedFiles,
  ];

  if (allChangedFiles.some((file) => fileMatchesTaskScope(file, meta))) {
    return true;
  }

  return !hasScopedTaskPaths(meta) && allChangedFiles.length > 0;
}

function isOlderThan(timestamp: string | null, minutes: number): boolean {
  if (!timestamp) {
    return true;
  }

  return Date.now() - new Date(timestamp).getTime() > minutes * 60 * 1000;
}

export async function shouldRequireContextCheckpoint(
  projectRoot: string,
  config: LlmDocsConfig,
  paths: WorkspacePaths,
  taskId: string,
): Promise<ContextCheckpointRequirement> {
  const meta = await readTaskMeta(paths, taskId);
  const state = await loadStateForAutosave(paths, taskId, meta);
  const gitFacts = await buildGitFacts(projectRoot, { config, taskMeta: meta });
  const taskRelevantChanges = hasTaskRelevantChanges(meta, gitFacts);
  const blockingReasons: string[] = [];
  const advisoryReasons: string[] = [];

  if (taskRelevantChanges && !state.checkpoint.lastCheckpointAt) {
    blockingReasons.push(CHECKPOINT_REASON_NO_CHECKPOINT);
  }

  if (
    taskRelevantChanges &&
    state.checkpoint.needsQualityCheckpoint &&
    isOlderThan(state.checkpoint.lastCheckpointAt, 15)
  ) {
    blockingReasons.push(CHECKPOINT_REASON_STALE_CHECKPOINT);
  }

  if (state.checkpoint.promptCountSinceCheckpoint >= 3) {
    advisoryReasons.push(CHECKPOINT_REASON_PROMPT_COUNT);
  }

  if (
    state.checkpoint.estimatedTranscriptTokens !== null &&
    state.checkpoint.estimatedTranscriptTokens >= config.contextBudget.transcriptRiskTokens &&
    isOlderThan(state.checkpoint.lastCheckpointAt, 5)
  ) {
    advisoryReasons.push(CHECKPOINT_REASON_TRANSCRIPT_RISK);
  }

  const reasons = [...blockingReasons, ...advisoryReasons];

  return {
    required: blockingReasons.length > 0,
    blockingReasons,
    advisoryReasons,
    reasons,
    warningKey: reasons.length > 0 ? buildContextWarningKey(reasons, state) : null,
  };
}

export async function watchCodexTranscript(
  paths: WorkspacePaths,
  taskId: string | null,
  input: CodexWatchInput,
): Promise<void> {
  const intervalMs = input.intervalMs ?? 1000;
  const timeoutMs = input.timeoutMs ?? 6 * 60 * 60 * 1000;
  const startedAt = Date.now();
  let lastOffset: number | null = null;
  const snapshotPath = runtimeSnapshotPath(paths, input.sessionId);
  const lockPath = `${snapshotPath}.lock`;

  await ensureDir(path.dirname(snapshotPath));
  const lock = input.once ? null : await acquireWatcherLock(lockPath);
  if (!input.once && !lock) {
    return;
  }

  try {
    while (Date.now() - startedAt <= timeoutMs) {
      const binding = await readCodexSessionBinding(paths, input.sessionId);
      if (binding?.paused) {
        return;
      }
      const activeTaskId = binding?.taskId ?? taskId;
      if (!activeTaskId) {
        return;
      }

      let snapshot: CodexAutosaveSnapshot | null = null;
      try {
        snapshot = await saveCodexAutosaveSnapshot(paths, activeTaskId, input);
      } catch {
        return;
      }
      if (snapshot && snapshot.transcriptOffset !== lastOffset) {
        lastOffset = snapshot.transcriptOffset;
      }

      if (input.once) {
        return;
      }

      await sleep(intervalMs);
    }
  } finally {
    if (lock) {
      await lock.close();
      await fs.rm(lockPath, { force: true });
    }
  }
}

export function autosaveRuntimeRelativePath(paths: WorkspacePaths, sessionId: string): string {
  return normalizeRelativePath(
    path.relative(paths.projectRoot, runtimeSnapshotPath(paths, sessionId)),
  );
}

export function taskStateRelativePath(paths: WorkspacePaths, taskId: string): string {
  return normalizeRelativePath(
    path.relative(paths.projectRoot, resolveTaskStatePath(paths, taskId)),
  );
}
