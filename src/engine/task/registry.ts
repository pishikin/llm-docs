import { readFileSafe, writeJsonAtomic } from '../../utils/fs.js';
import { taskRegistrySchema } from '../config/schema.js';
import { TaskRegistryError } from '../errors.js';
import type { TaskMeta, TaskRegistry, TaskRegistryEntry, WorkspacePaths } from '../types.js';
import { readActiveTaskFile, writeActiveTaskFile } from './active.js';
import { shouldAutoLinkBranch } from './branches.js';

function createEmptyRegistry(now: string): TaskRegistry {
  return {
    schemaVersion: 1,
    updatedAt: now,
    activeTaskId: null,
    tasks: {},
    branchToTask: {},
  };
}

function sortObjectEntries<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function validateRegistry(registry: TaskRegistry): TaskRegistry {
  const result = taskRegistrySchema.safeParse(registry);
  if (!result.success) {
    throw new TaskRegistryError('Task registry schema validation failed', result.error);
  }

  return result.data;
}

export async function readTaskRegistry(paths: WorkspacePaths): Promise<TaskRegistry> {
  const content = await readFileSafe(paths.registryPath);
  if (content === null) {
    return createEmptyRegistry(new Date().toISOString());
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new TaskRegistryError('Task registry JSON parse failed', error);
  }

  return validateRegistry(parsed as TaskRegistry);
}

export async function writeTaskRegistry(
  paths: WorkspacePaths,
  registry: TaskRegistry,
): Promise<TaskRegistry> {
  const normalized = validateRegistry({
    ...registry,
    tasks: sortObjectEntries(registry.tasks),
    branchToTask: sortObjectEntries(registry.branchToTask),
  });

  await writeJsonAtomic(paths.registryPath, normalized);
  return normalized;
}

export async function upsertRegistryEntry(
  paths: WorkspacePaths,
  entry: TaskRegistryEntry,
): Promise<TaskRegistry> {
  const registry = await readTaskRegistry(paths);
  const updatedAt = new Date().toISOString();

  registry.tasks[entry.taskId] = {
    ...entry,
    linkedBranches: [...new Set(entry.linkedBranches)],
    updatedAt,
  };
  registry.updatedAt = updatedAt;

  return writeTaskRegistry(paths, registry);
}

export function buildRegistryEntryFromMeta(meta: TaskMeta): TaskRegistryEntry {
  return {
    taskId: meta.task_id,
    title: meta.title,
    status: meta.status,
    phase: meta.phase,
    bundlePath: meta.bundle.path,
    sourceType: meta.source.type,
    sourceRef: meta.source.ref,
    currentBranch: meta.branch.current,
    linkedBranches: meta.branch.linked_branches,
    lastVerifiedCommit: meta.branch.last_verified_commit,
    lastActualizedCommit: meta.branch.last_actualized_commit,
    needsActualization: meta.staleness.needs_actualization,
    archived: meta.history.archived,
    updatedAt: meta.bundle.updated_at,
  };
}

export async function syncRegistryFromMeta(
  paths: WorkspacePaths,
  meta: TaskMeta,
  options: {
    linkBranches?: boolean;
    skipBranches?: string[];
  } = {},
): Promise<TaskRegistry> {
  const registry = await upsertRegistryEntry(paths, buildRegistryEntryFromMeta(meta));

  const currentBranch = meta.branch.current;
  const skipBranches = new Set(options.skipBranches ?? ['main', 'master']);
  const shouldLink =
    options.linkBranches !== false &&
    shouldAutoLinkBranch(currentBranch) &&
    !skipBranches.has(currentBranch);

  if (shouldLink) {
    return linkBranchToTask(paths, currentBranch, meta.task_id);
  }

  return registry;
}

export async function setActiveTask(
  paths: WorkspacePaths,
  taskId: string | null,
): Promise<TaskRegistry> {
  const registry = await readTaskRegistry(paths);

  if (taskId !== null && !registry.tasks[taskId]) {
    throw new TaskRegistryError(`Cannot set active task to missing task ${taskId}`);
  }

  registry.activeTaskId = taskId;
  registry.updatedAt = new Date().toISOString();

  const next = await writeTaskRegistry(paths, registry);
  await writeActiveTaskFile(paths, taskId);
  return next;
}

export async function linkBranchToTask(
  paths: WorkspacePaths,
  branch: string,
  taskId: string,
): Promise<TaskRegistry> {
  const registry = await readTaskRegistry(paths);
  const entry = registry.tasks[taskId];

  if (!entry) {
    throw new TaskRegistryError(`Cannot link branch ${branch} to missing task ${taskId}`);
  }

  const linkedBranches = [...new Set([...entry.linkedBranches, branch])];
  registry.tasks[taskId] = {
    ...entry,
    currentBranch: branch,
    linkedBranches,
    updatedAt: new Date().toISOString(),
  };
  registry.branchToTask[branch] = taskId;
  registry.updatedAt = new Date().toISOString();

  return writeTaskRegistry(paths, registry);
}

export async function resolveTaskByBranch(
  paths: WorkspacePaths,
  branch: string,
): Promise<TaskRegistryEntry | null> {
  const registry = await readTaskRegistry(paths);
  const taskId = registry.branchToTask[branch];
  return taskId ? (registry.tasks[taskId] ?? null) : null;
}

export async function listTasks(
  paths: WorkspacePaths,
  filters: {
    status?: TaskRegistryEntry['status'];
    limit?: number;
    includeArchived?: boolean;
  } = {},
): Promise<TaskRegistryEntry[]> {
  const registry = await readTaskRegistry(paths);
  const limit = filters.limit ?? Number.POSITIVE_INFINITY;

  return Object.values(registry.tasks)
    .filter((entry) => (filters.status ? entry.status === filters.status : true))
    .filter((entry) => (filters.includeArchived ? true : !entry.archived))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

export async function archiveRegistryEntry(
  paths: WorkspacePaths,
  taskId: string,
): Promise<TaskRegistry> {
  const registry = await readTaskRegistry(paths);
  const entry = registry.tasks[taskId];

  if (!entry) {
    throw new TaskRegistryError(`Cannot archive missing task ${taskId}`);
  }

  registry.tasks[taskId] = {
    ...entry,
    status: 'archived',
    archived: true,
    updatedAt: new Date().toISOString(),
  };

  registry.branchToTask = Object.fromEntries(
    Object.entries(registry.branchToTask).filter(([, mappedTaskId]) => mappedTaskId !== taskId),
  );

  const clearActiveTask = registry.activeTaskId === taskId;
  if (clearActiveTask) {
    registry.activeTaskId = null;
  }

  registry.updatedAt = new Date().toISOString();
  const next = await writeTaskRegistry(paths, registry);
  if (clearActiveTask) {
    await writeActiveTaskFile(paths, null);
  }
  return next;
}

export async function removeRegistryEntry(
  paths: WorkspacePaths,
  taskId: string,
): Promise<TaskRegistry> {
  const registry = await readTaskRegistry(paths);
  const hadTask = !!registry.tasks[taskId];
  delete registry.tasks[taskId];
  registry.branchToTask = Object.fromEntries(
    Object.entries(registry.branchToTask).filter(([, mappedTaskId]) => mappedTaskId !== taskId),
  );

  const activeFileTaskId = await readActiveTaskFile(paths);
  const clearActiveTask = registry.activeTaskId === taskId || activeFileTaskId === taskId;
  if (clearActiveTask) {
    registry.activeTaskId = null;
  }

  if (hadTask || clearActiveTask) {
    registry.updatedAt = new Date().toISOString();
  }

  const next = await writeTaskRegistry(paths, registry);
  if (clearActiveTask) {
    await writeActiveTaskFile(paths, null);
  }
  return next;
}
