import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { ensureDir, fileExists, normalizeRelativePath } from '../../utils/fs.js';
import type {
  DoctorCheck,
  LlmDocsConfigV2,
  TaskCloseInput,
  TaskClosePlan,
  TaskCloseReport,
  TaskMeta,
  TaskPublishConflict,
  TaskPublishReport,
  WorkspacePaths,
} from '../types.js';
import { resolveTaskBundlePath } from '../workspace/paths.js';
import { readActiveTaskFile } from './active.js';
import { shouldAutoLinkBranch } from './branches.js';
import { normalizeTaskId } from './id.js';
import { readTaskMeta } from './meta.js';
import { applyTaskPublish, prepareTaskPublish } from './publish.js';
import { readTaskRegistry, removeRegistryEntry, resolveTaskByBranch } from './registry.js';

function toRelative(root: string, absolutePath: string): string {
  return normalizeRelativePath(path.relative(root, absolutePath));
}

function makeCheck(
  id: string,
  ok: boolean,
  severity: DoctorCheck['severity'],
  message: string,
): DoctorCheck {
  return { id, ok, severity, message };
}

function archiveTargetPath(paths: WorkspacePaths, taskId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(paths.workspaceRoot, '.llm-docs/archive/tasks', `${taskId}-${timestamp}`);
}

async function currentBranch(projectRoot: string): Promise<string | null> {
  try {
    const branch = await simpleGit(projectRoot).revparse(['--abbrev-ref', 'HEAD']);
    const trimmed = branch.trim();
    return trimmed && trimmed !== 'HEAD' ? trimmed : null;
  } catch {
    return null;
  }
}

async function resolveTaskToClose(
  projectRoot: string,
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  taskId: string | null | undefined,
): Promise<{ taskId: string; meta: TaskMeta }> {
  async function byTaskId(candidate: string): Promise<{ taskId: string; meta: TaskMeta } | null> {
    try {
      const meta = await readTaskMeta(paths, candidate);
      return { taskId: meta.task_id, meta };
    } catch {
      return null;
    }
  }

  if (taskId) {
    const normalized = normalizeTaskId(taskId);
    const resolved = await byTaskId(normalized);
    if (resolved) {
      return resolved;
    }
    throw new Error(`Task bundle not found: ${normalized}`);
  }

  const activeFileTaskId = await readActiveTaskFile(paths);
  if (activeFileTaskId) {
    const resolved = await byTaskId(activeFileTaskId);
    if (resolved) {
      return resolved;
    }
  }

  const registry = await readTaskRegistry(paths);
  if (registry.activeTaskId) {
    const resolved = await byTaskId(registry.activeTaskId);
    if (resolved) {
      return resolved;
    }
  }

  const branch = await currentBranch(projectRoot);
  if (shouldAutoLinkBranch(branch, config)) {
    const branchEntry = await resolveTaskByBranch(paths, branch);
    if (branchEntry) {
      const resolved = await byTaskId(branchEntry.taskId);
      if (resolved) {
        return resolved;
      }
    }
  }

  throw new Error('Cannot resolve task to close. Pass a task id explicitly.');
}

export async function prepareTaskClose(
  projectRoot: string,
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  input: TaskCloseInput = {},
): Promise<TaskClosePlan> {
  const publish = input.publish !== false;
  const task = await resolveTaskToClose(projectRoot, config, paths, input.taskId);
  const sourceBundlePath = resolveTaskBundlePath(paths, task.taskId);
  const sourceExists = await fileExists(sourceBundlePath);
  const archivePath = input.deleteActive ? null : archiveTargetPath(paths, task.taskId);
  const archiveExists = archivePath ? await fileExists(archivePath) : false;
  const publishPlan = publish
    ? await prepareTaskPublish(projectRoot, config, paths, {
        ...input,
        taskId: task.taskId,
        dryRun: true,
        deleteWorktree: false,
      })
    : null;
  const conflicts: TaskPublishConflict[] = [];
  const warnings: string[] = [];

  if (!sourceExists) {
    conflicts.push({
      path: toRelative(projectRoot, sourceBundlePath),
      kind: 'destination-unsafe',
      message: `Active task bundle is missing: ${toRelative(projectRoot, sourceBundlePath)}`,
    });
  }

  if (archiveExists && archivePath) {
    conflicts.push({
      path: toRelative(projectRoot, archivePath),
      kind: 'destination-unsafe',
      message: `Active task archive target already exists: ${toRelative(projectRoot, archivePath)}`,
    });
  }

  if (publishPlan?.conflicts.length) {
    conflicts.push(...publishPlan.conflicts);
  }

  if (!publish) {
    warnings.push('Task will be closed without publishing into long-lived docs.');
  }

  const operations: TaskClosePlan['operations'] = [];
  if (publish) {
    operations.push({ op: 'publish-task', path: publishPlan?.destination.targetPath });
  }
  operations.push(
    input.deleteActive
      ? {
          op: 'delete-active-bundle',
          path: toRelative(projectRoot, sourceBundlePath),
        }
      : {
          op: 'archive-active-bundle',
          from: toRelative(projectRoot, sourceBundlePath),
          to: archivePath ? toRelative(projectRoot, archivePath) : undefined,
        },
  );
  operations.push({ op: 'remove-active-registry-entry', path: paths.relative.registryPath });

  return {
    schemaVersion: 1,
    action: 'task-close',
    dryRun: input.dryRun ?? true,
    taskId: task.taskId,
    publish,
    sourceBundlePath: toRelative(projectRoot, sourceBundlePath),
    archivePath: archivePath ? toRelative(projectRoot, archivePath) : null,
    publishPlan,
    checks: [
      makeCheck(
        'source:bundle',
        sourceExists,
        sourceExists ? 'info' : 'error',
        sourceExists ? 'Active task bundle exists.' : 'Active task bundle is missing.',
      ),
      makeCheck(
        'close:archive-target',
        !archiveExists,
        archiveExists ? 'error' : 'info',
        archiveExists ? 'Active task archive target already exists.' : 'Archive target is free.',
      ),
    ],
    operations,
    conflicts,
    warnings,
  };
}

export async function applyTaskClose(
  projectRoot: string,
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  input: TaskCloseInput = {},
): Promise<TaskCloseReport> {
  const plan = await prepareTaskClose(projectRoot, config, paths, { ...input, dryRun: false });

  if (plan.conflicts.length > 0) {
    throw new Error(
      `Cannot close ${plan.taskId}: ${plan.conflicts
        .map((conflict) => conflict.message)
        .join('; ')}`,
    );
  }

  let publishReport: TaskPublishReport | null = null;
  if (plan.publish) {
    publishReport = await applyTaskPublish(projectRoot, config, paths, {
      ...input,
      taskId: plan.taskId,
      dryRun: false,
      deleteWorktree: false,
    });
  }

  const sourceBundlePath = path.join(projectRoot, plan.sourceBundlePath);
  if (input.deleteActive) {
    await fs.rm(sourceBundlePath, { recursive: true, force: true });
  } else if (plan.archivePath) {
    const targetPath = path.join(projectRoot, plan.archivePath);
    await ensureDir(path.dirname(targetPath));
    await fs.rename(sourceBundlePath, targetPath);
  }

  await removeRegistryEntry(paths, plan.taskId);

  return {
    ...plan,
    dryRun: false,
    applied: true,
    publishReport,
  };
}
