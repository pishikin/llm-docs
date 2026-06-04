import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, fileExists, normalizeRelativePath } from '../../utils/fs.js';
import { writeConfig } from '../config/load.js';
import { DEFAULT_ACTIVE_TASKS_DIR, buildDefaultRegistryPath } from '../config/migrate.js';
import { readActiveTaskFile, writeActiveTaskFile } from '../task/active.js';
import { readTaskMeta, writeTaskMeta } from '../task/meta.js';
import { readTaskRegistry, writeTaskRegistry } from '../task/registry.js';
import { readTaskStateOrNull, writeTaskState } from '../task/state.js';
import type {
  ActiveTasksMigrationInput,
  ActiveTasksMigrationReport,
  LlmDocsConfig,
  TaskPublishConflict,
  TaskRegistry,
  WorkspacePaths,
} from '../types.js';
import { resolveWorkspacePaths } from './paths.js';

function toRelative(root: string, absolutePath: string): string {
  return normalizeRelativePath(path.relative(root, absolutePath));
}

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function buildMigratedConfig(config: LlmDocsConfig): LlmDocsConfig {
  return {
    ...config,
    workspace: {
      ...config.workspace,
      tasksDir: DEFAULT_ACTIVE_TASKS_DIR,
    },
    taskBundles: {
      ...config.taskBundles,
      registryPath: buildDefaultRegistryPath(config.workspace.rootDir),
    },
  };
}

function rewriteRegistryForTarget(
  projectRoot: string,
  targetTasksDir: string,
  registry: TaskRegistry,
): TaskRegistry {
  const updatedAt = new Date().toISOString();
  const tasks = Object.fromEntries(
    Object.entries(registry.tasks).map(([taskId, entry]) => [
      taskId,
      {
        ...entry,
        bundlePath: toRelative(projectRoot, path.join(targetTasksDir, taskId)),
        updatedAt,
      },
    ]),
  );

  return {
    ...registry,
    updatedAt,
    tasks,
  };
}

async function removeDirIfEmpty(dirPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dirPath);
    if (entries.length > 0) {
      return false;
    }
    await fs.rmdir(dirPath);
    return true;
  } catch {
    return false;
  }
}

async function rewriteBundlePaths(
  projectRoot: string,
  newPaths: WorkspacePaths,
  taskId: string,
): Promise<void> {
  const nextBundlePath = toRelative(projectRoot, path.join(newPaths.tasksDir, taskId));
  const state = await readTaskStateOrNull(newPaths, taskId);
  if (state) {
    await writeTaskState(newPaths, taskId, {
      ...state,
      bundle: {
        ...state.bundle,
        path: nextBundlePath,
      },
    });
  }

  try {
    const meta = await readTaskMeta(newPaths, taskId);
    await writeTaskMeta(newPaths, taskId, {
      ...meta,
      bundle: {
        ...meta.bundle,
        path: nextBundlePath,
      },
    });
  } catch {
    // Simple bundles can be represented by state.json only.
  }
}

export async function prepareActiveTasksMigration(
  projectRoot: string,
  config: LlmDocsConfig,
  paths: WorkspacePaths,
  input: ActiveTasksMigrationInput = {},
): Promise<ActiveTasksMigrationReport> {
  const migratedConfig = buildMigratedConfig(config);
  const targetPaths = resolveWorkspacePaths(projectRoot, migratedConfig);
  const registry = await readTaskRegistry(paths);
  const taskIds = Object.keys(registry.tasks).sort((left, right) => left.localeCompare(right));
  const alreadyMigrated =
    isSamePath(paths.tasksDir, targetPaths.tasksDir) &&
    isSamePath(paths.registryPath, targetPaths.registryPath);
  const conflicts: TaskPublishConflict[] = [];
  const warnings: string[] = [];
  const operations: ActiveTasksMigrationReport['operations'] = [];

  if (alreadyMigrated) {
    operations.push({
      op: 'noop',
      message: 'Active task storage already uses the hidden .llm-docs location.',
    });
  }

  for (const taskId of taskIds) {
    const sourcePath = path.join(paths.projectRoot, registry.tasks[taskId].bundlePath);
    const targetPath = path.join(targetPaths.tasksDir, taskId);

    if (!(await fileExists(sourcePath))) {
      conflicts.push({
        path: toRelative(projectRoot, sourcePath),
        kind: 'destination-unsafe',
        message: `Registered task bundle is missing: ${toRelative(projectRoot, sourcePath)}`,
      });
      continue;
    }

    if (!alreadyMigrated && (await fileExists(targetPath))) {
      conflicts.push({
        path: toRelative(projectRoot, targetPath),
        kind: 'destination-unsafe',
        message: `Target task bundle already exists: ${toRelative(projectRoot, targetPath)}`,
      });
      continue;
    }

    if (!alreadyMigrated) {
      operations.push({
        op: 'move-task-bundle',
        taskId,
        from: toRelative(projectRoot, sourcePath),
        to: toRelative(projectRoot, targetPath),
      });
    }
  }

  if (!alreadyMigrated) {
    operations.push({
      op: 'write-registry',
      path: toRelative(projectRoot, targetPaths.registryPath),
    });

    if (await readActiveTaskFile(paths)) {
      operations.push({
        op: 'write-active-file',
        path: toRelative(projectRoot, path.join(targetPaths.tasksDir, 'ACTIVE')),
      });
    }

    operations.push({
      op: 'write-config',
      path: toRelative(projectRoot, paths.configPath),
    });

    if (await fileExists(paths.registryPath)) {
      operations.push({
        op: 'remove-legacy-file',
        path: toRelative(projectRoot, paths.registryPath),
      });
    }

    const sourceActivePath = path.join(paths.tasksDir, 'ACTIVE');
    if (await fileExists(sourceActivePath)) {
      operations.push({
        op: 'remove-legacy-file',
        path: toRelative(projectRoot, sourceActivePath),
      });
    }

    operations.push({
      op: 'remove-empty-legacy-dir',
      path: toRelative(projectRoot, paths.tasksDir),
    });
  }

  if (taskIds.length === 0 && !alreadyMigrated) {
    warnings.push(
      'No registered active task bundles found; only config and registry path will move.',
    );
  }

  return {
    schemaVersion: 1,
    action: 'migrate-active-tasks',
    dryRun: input.dryRun ?? true,
    sourceTasksDir: toRelative(projectRoot, paths.tasksDir),
    targetTasksDir: toRelative(projectRoot, targetPaths.tasksDir),
    sourceRegistryPath: toRelative(projectRoot, paths.registryPath),
    targetRegistryPath: toRelative(projectRoot, targetPaths.registryPath),
    alreadyMigrated,
    tasks: taskIds,
    operations,
    conflicts,
    warnings,
  };
}

export async function applyActiveTasksMigration(
  projectRoot: string,
  config: LlmDocsConfig,
  paths: WorkspacePaths,
  input: ActiveTasksMigrationInput = {},
): Promise<ActiveTasksMigrationReport> {
  const plan = await prepareActiveTasksMigration(projectRoot, config, paths, {
    ...input,
    dryRun: false,
  });

  if (plan.conflicts.length > 0) {
    throw new Error(
      `Cannot migrate active tasks: ${plan.conflicts
        .map((conflict) => conflict.message)
        .join('; ')}`,
    );
  }

  if (plan.alreadyMigrated) {
    return { ...plan, dryRun: false };
  }

  const migratedConfig = buildMigratedConfig(config);
  const targetPaths = resolveWorkspacePaths(projectRoot, migratedConfig);
  const registry = await readTaskRegistry(paths);
  const migratedRegistry = rewriteRegistryForTarget(projectRoot, targetPaths.tasksDir, registry);
  const activeTaskId = await readActiveTaskFile(paths);

  await ensureDir(targetPaths.tasksDir);
  for (const taskId of Object.keys(registry.tasks)) {
    const sourcePath = path.join(paths.projectRoot, registry.tasks[taskId].bundlePath);
    const targetPath = path.join(targetPaths.tasksDir, taskId);
    await ensureDir(path.dirname(targetPath));
    await fs.rename(sourcePath, targetPath);
    await rewriteBundlePaths(projectRoot, targetPaths, taskId);
  }

  await writeTaskRegistry(targetPaths, migratedRegistry);
  if (activeTaskId) {
    await writeActiveTaskFile(targetPaths, activeTaskId);
  }

  await writeConfig(projectRoot, migratedConfig);

  await fs.rm(paths.registryPath, { force: true });
  await fs.rm(path.join(paths.tasksDir, 'ACTIVE'), { force: true });
  await removeDirIfEmpty(paths.tasksDir);

  return {
    ...plan,
    dryRun: false,
  };
}
