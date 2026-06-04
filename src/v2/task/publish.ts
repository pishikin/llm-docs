import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import {
  ensureDir,
  fileExists,
  normalizeRelativePath,
  readFileSafe,
  writeJsonAtomic,
  writeTextAtomic,
} from '../../utils/fs.js';
import { loadOrMigrateConfig } from '../config/load.js';
import { buildGitFacts } from '../git/status.js';
import {
  getConfiguredMainBranch,
  getGitCommonDir,
  getGitRootInfo,
  isGitWorktree,
  listGitWorktrees,
} from '../git/worktrees.js';
import type {
  DoctorCheck,
  LlmDocsConfigV2,
  PublishedTaskIndex,
  PublishedTaskIndexEntry,
  TaskMeta,
  TaskPublishArtifactPolicy,
  TaskPublishConflict,
  TaskPublishConflictPolicy,
  TaskPublishDestinationInfo,
  TaskPublishFileEntry,
  TaskPublishManifest,
  TaskPublishMode,
  TaskPublishOperation,
  TaskPublishPlan,
  TaskPublishPrepareInput,
  TaskPublishReport,
  TaskPublishSourceInfo,
  WorkspacePaths,
} from '../types.js';
import { resolveWorkspacePaths } from '../workspace/paths.js';
import { readActiveTaskFile } from './active.js';
import { prepareActualization } from './actualization.js';
import { shouldAutoLinkBranch } from './branches.js';
import { normalizeTaskId } from './id.js';
import { readTaskMeta } from './meta.js';
import { readTaskRegistry, resolveTaskByBranch } from './registry.js';
import {
  PUBLISH_SUMMARY_PATH,
  buildPublishQualityWarnings,
  buildTaskSummaryMarkdown,
} from './summary.js';

const PACKAGE_VERSION = '0.1.0';

interface DestinationResolution {
  config: LlmDocsConfigV2;
  paths: WorkspacePaths;
  info: Omit<TaskPublishDestinationInfo, 'targetPath' | 'clean'>;
}

interface DestinationState {
  kind: 'absent' | 'manifest-compatible' | 'manifest-different' | 'exists-without-manifest';
  manifest?: TaskPublishManifest;
}

function toRelative(root: string, absolutePath: string): string {
  return normalizeRelativePath(path.relative(root, absolutePath));
}

function assertInside(root: string, target: string, label: string): void {
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }

  throw new Error(`${label} escapes allowed root: ${target}`);
}

function assertSafeRelativePath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    path.isAbsolute(normalized) ||
    Array.from(normalized).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error(`Unsafe bundle path: ${relativePath}`);
  }

  return normalized;
}

async function sha256File(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function sha256Text(content: string): string {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function shouldIncludeFile(relativePath: string, policy: TaskPublishArtifactPolicy): boolean {
  if (policy === 'copy') {
    return true;
  }

  if (!relativePath.startsWith('artifacts/')) {
    return true;
  }

  return policy === 'manifest-only' && relativePath === 'artifacts/index.json';
}

async function listBundleFiles(
  bundlePath: string,
  includeArtifacts: TaskPublishArtifactPolicy,
  currentDir = bundlePath,
): Promise<TaskPublishFileEntry[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files: TaskPublishFileEntry[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = assertSafeRelativePath(path.relative(bundlePath, absolutePath));

    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to publish symlink in task bundle: ${relativePath}`);
    }

    if (entry.isDirectory()) {
      files.push(...(await listBundleFiles(bundlePath, includeArtifacts, absolutePath)));
      continue;
    }

    if (!entry.isFile() || !shouldIncludeFile(relativePath, includeArtifacts)) {
      continue;
    }

    const stat = await fs.stat(absolutePath);
    files.push({
      path: relativePath,
      size: stat.size,
      sha256: await sha256File(absolutePath),
    });
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function computeBundleHash(files: TaskPublishFileEntry[]): string {
  const content = files.map((file) => `${file.path}\0${file.size}\0${file.sha256}`).join('\n');
  return sha256Text(`${content}\n`);
}

function buildGeneratedSummaryEntry(summaryContent: string): TaskPublishFileEntry {
  return {
    path: PUBLISH_SUMMARY_PATH,
    size: Buffer.byteLength(summaryContent, 'utf-8'),
    sha256: sha256Text(summaryContent),
    generated: true,
  };
}

function upsertGeneratedSummaryEntry(
  files: TaskPublishFileEntry[],
  summaryContent: string,
): TaskPublishFileEntry[] {
  const summaryEntry = buildGeneratedSummaryEntry(summaryContent);
  return [...files.filter((file) => file.path !== PUBLISH_SUMMARY_PATH), summaryEntry].sort(
    (left, right) => left.path.localeCompare(right.path),
  );
}

async function resolveTaskForPublish(
  projectRoot: string,
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  input: TaskPublishPrepareInput,
): Promise<{ taskId: string; meta: TaskMeta; bundlePath: string }> {
  async function resolveByTaskId(taskId: string): Promise<{
    taskId: string;
    meta: TaskMeta;
    bundlePath: string;
  } | null> {
    try {
      const meta = await readTaskMeta(paths, taskId);
      return { taskId: meta.task_id, meta, bundlePath: path.join(projectRoot, meta.bundle.path) };
    } catch {
      return null;
    }
  }

  if (input.taskId) {
    const taskId = normalizeTaskId(input.taskId);
    const resolved = await resolveByTaskId(taskId);
    if (resolved) {
      return resolved;
    }

    throw new Error(`Task bundle not found: ${taskId}`);
  }

  if (process.env.LLMDOCS_ACTIVE_TASK) {
    const resolved = await resolveByTaskId(normalizeTaskId(process.env.LLMDOCS_ACTIVE_TASK));
    if (resolved) {
      return resolved;
    }
  }

  const activeFileTaskId = await readActiveTaskFile(paths);
  if (activeFileTaskId) {
    const resolved = await resolveByTaskId(activeFileTaskId);
    if (resolved) {
      return resolved;
    }
  }

  const gitFacts = await buildGitFacts(projectRoot, { config });
  const branch = gitFacts.branch;
  const canInferFromBranch = shouldAutoLinkBranch(branch, config);

  if (canInferFromBranch) {
    const resolved = await resolveByTaskId(branch);
    if (resolved) {
      return resolved;
    }
  }

  if (canInferFromBranch) {
    const branchEntry = await resolveTaskByBranch(paths, branch);
    if (branchEntry) {
      const meta = await readTaskMeta(paths, branchEntry.taskId);
      return {
        taskId: branchEntry.taskId,
        meta,
        bundlePath: path.join(projectRoot, meta.bundle.path),
      };
    }
  }

  const registry = await readTaskRegistry(paths);
  if (registry.activeTaskId && registry.tasks[registry.activeTaskId]) {
    const meta = await readTaskMeta(paths, registry.activeTaskId);
    return {
      taskId: registry.activeTaskId,
      meta,
      bundlePath: path.join(projectRoot, meta.bundle.path),
    };
  }

  const cwd = process.cwd();
  const tasksRoot = `${paths.tasksDir}${path.sep}`;
  if (cwd.startsWith(tasksRoot)) {
    const taskId = cwd.slice(tasksRoot.length).split(path.sep)[0];
    if (taskId) {
      const meta = await readTaskMeta(paths, taskId);
      return { taskId, meta, bundlePath: path.join(projectRoot, meta.bundle.path) };
    }
  }

  if (canInferFromBranch) {
    try {
      const taskDirs = await fs.readdir(paths.tasksDir, { withFileTypes: true });
      for (const entry of taskDirs) {
        if (!entry.isDirectory()) {
          continue;
        }
        try {
          const meta = await readTaskMeta(paths, entry.name);
          if (meta.branch.current === branch) {
            return {
              taskId: meta.task_id,
              meta,
              bundlePath: path.join(projectRoot, meta.bundle.path),
            };
          }
        } catch {
          // Ignore invalid task folders during fallback scan.
        }
      }
    } catch {
      // No task directory, fall through to explicit error.
    }
  }

  throw new Error('Cannot resolve task to publish. Pass a task id explicitly.');
}

function resolveConfiguredPath(sourceRoot: string, configuredPath: string): string {
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(sourceRoot, configuredPath);
}

async function loadDestination(
  sourceRoot: string,
  sourceConfig: LlmDocsConfigV2,
  input: TaskPublishPrepareInput,
): Promise<DestinationResolution> {
  const mainBranch = getConfiguredMainBranch(sourceConfig);
  const candidates: Array<{
    projectRoot: string;
    resolvedBy: DestinationResolution['info']['resolvedBy'];
  }> = [];

  if (input.dest) {
    candidates.push({
      projectRoot: resolveConfiguredPath(sourceRoot, input.dest),
      resolvedBy: 'flag',
    });
  } else if (sourceConfig.worktrees?.mainWorktreePath) {
    candidates.push({
      projectRoot: resolveConfiguredPath(sourceRoot, sourceConfig.worktrees.mainWorktreePath),
      resolvedBy: 'config',
    });
  } else if (process.env.LLM_DOCS_MAIN_WORKTREE) {
    candidates.push({
      projectRoot: resolveConfiguredPath(sourceRoot, process.env.LLM_DOCS_MAIN_WORKTREE),
      resolvedBy: 'env',
    });
  } else {
    const worktrees = await listGitWorktrees(sourceRoot);
    const mainWorktrees = worktrees.filter(
      (worktree) => !worktree.bare && !worktree.detached && worktree.branch === mainBranch,
    );

    if (mainWorktrees.length === 1) {
      candidates.push({ projectRoot: mainWorktrees[0].path, resolvedBy: 'git-worktree' });
    } else if (mainWorktrees.length > 1) {
      throw new Error(
        `Multiple ${mainBranch} worktrees found. Pass --dest explicitly: ${mainWorktrees
          .map((worktree) => worktree.path)
          .join(', ')}`,
      );
    } else {
      const sourceBranch = await simpleGit(sourceRoot)
        .revparse(['--abbrev-ref', 'HEAD'])
        .catch(() => null);
      if (sourceBranch === mainBranch) {
        candidates.push({ projectRoot: sourceRoot, resolvedBy: 'current-root' });
      }
    }
  }

  const candidate = candidates[0];
  if (!candidate) {
    throw new Error('Cannot resolve main worktree. Pass --dest or set LLM_DOCS_MAIN_WORKTREE.');
  }

  const projectRoot = path.resolve(candidate.projectRoot);
  if (!(await isGitWorktree(projectRoot))) {
    throw new Error(`Publish destination is not a git worktree: ${projectRoot}`);
  }

  const sourceCommonDir = await getGitCommonDir(sourceRoot);
  const destinationInfo = await getGitRootInfo(projectRoot);

  if (
    sourceCommonDir &&
    destinationInfo.commonDir &&
    sourceCommonDir !== destinationInfo.commonDir &&
    !input.force
  ) {
    throw new Error(
      `Publish destination belongs to a different git repository: ${projectRoot}. Use --force only if this is intentional.`,
    );
  }

  const configResult = await loadOrMigrateConfig(projectRoot, { createIfMissing: false });
  const paths = resolveWorkspacePaths(projectRoot, configResult.config);

  return {
    config: configResult.config,
    paths,
    info: {
      projectRoot,
      resolvedBy: candidate.resolvedBy,
      branch: destinationInfo.branch,
      commitBefore: destinationInfo.head,
      gitCommonDir: destinationInfo.commonDir,
    },
  };
}

function resolveDestinationTasksDir(
  paths: WorkspacePaths,
  config: LlmDocsConfigV2,
  mode: TaskPublishMode,
): string {
  const configured =
    mode === 'archive'
      ? config.worktrees?.publish?.archiveTasksDir
      : config.worktrees?.publish?.docsTasksDir;

  if (configured) {
    return path.resolve(paths.workspaceRoot, normalizeRelativePath(configured));
  }

  return mode === 'archive'
    ? path.join(paths.archiveDir, 'tasks')
    : path.join(paths.docsDir, 'tasks');
}

async function readManifest(manifestPath: string): Promise<TaskPublishManifest | null> {
  const content = await readFileSafe(manifestPath);
  if (content === null) {
    return null;
  }

  try {
    return JSON.parse(content) as TaskPublishManifest;
  } catch {
    return null;
  }
}

async function classifyDestination(
  targetPath: string,
  sourceBundleHash: string,
): Promise<DestinationState> {
  if (!(await fileExists(targetPath))) {
    return { kind: 'absent' };
  }

  const manifest = await readManifest(path.join(targetPath, 'publish.manifest.json'));
  if (!manifest) {
    return { kind: 'exists-without-manifest' };
  }

  return manifest.source.bundleHash === sourceBundleHash ||
    manifest.destination.bundleHash === sourceBundleHash
    ? { kind: 'manifest-compatible', manifest }
    : { kind: 'manifest-different', manifest };
}

function buildDestinationConflict(
  targetPath: string,
  state: DestinationState,
): TaskPublishConflict | null {
  if (state.kind === 'exists-without-manifest') {
    return {
      path: targetPath,
      kind: 'exists-without-manifest',
      message: 'Destination already exists without publish.manifest.json.',
    };
  }

  if (state.kind === 'manifest-different') {
    return {
      path: targetPath,
      kind: 'manifest-different',
      message: 'Destination already has a publish manifest for different source content.',
    };
  }

  return null;
}

function chooseConflictTarget(
  targetPath: string,
  taskId: string,
  sourceCommit: string | null,
): string {
  const suffix = sourceCommit?.slice(0, 8) || Date.now().toString(36);
  return path.join(path.dirname(targetPath), `${taskId}-${suffix}`);
}

function isClean(gitFacts: {
  changedFiles: string[];
  stagedFiles: string[];
  untrackedFiles: string[];
}): boolean {
  return (
    gitFacts.changedFiles.length === 0 &&
    gitFacts.stagedFiles.length === 0 &&
    gitFacts.untrackedFiles.length === 0
  );
}

function makeCheck(
  id: string,
  ok: boolean,
  severity: DoctorCheck['severity'],
  message: string,
): DoctorCheck {
  return { id, ok, severity, message };
}

export async function prepareTaskPublish(
  projectRoot: string,
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  input: TaskPublishPrepareInput = {},
): Promise<TaskPublishPlan> {
  const includeArtifacts =
    input.includeArtifacts ?? config.worktrees?.publish?.includeArtifacts ?? 'copy';
  const conflictPolicy =
    input.conflictPolicy ?? config.worktrees?.publish?.conflictPolicy ?? 'fail';
  const mode: TaskPublishMode = input.archive ? 'archive' : 'docs';
  const task = await resolveTaskForPublish(projectRoot, config, paths, input);
  const actualization = await prepareActualization(projectRoot, config, paths, task.taskId);
  const sourceGit = await buildGitFacts(projectRoot, { config, taskMeta: task.meta });
  const sourceCommonDir = await getGitCommonDir(projectRoot);
  const sourceFiles = await listBundleFiles(task.bundlePath, includeArtifacts);
  const summaryContent = await buildTaskSummaryMarkdown({
    projectRoot,
    bundlePath: task.bundlePath,
    meta: task.meta,
  });
  const files = upsertGeneratedSummaryEntry(sourceFiles, summaryContent);
  const bundleHash = computeBundleHash(files);
  const destination = await loadDestination(projectRoot, config, input);
  const destinationGit = await buildGitFacts(destination.info.projectRoot, {
    config: destination.config,
  });
  const destinationTasksDir = resolveDestinationTasksDir(
    destination.paths,
    destination.config,
    mode,
  );
  const intendedTargetPath = path.join(destinationTasksDir, task.taskId);

  assertInside(task.bundlePath, task.bundlePath, 'Source bundle');
  assertInside(destination.paths.workspaceRoot, destinationTasksDir, 'Destination task directory');

  let targetPath = intendedTargetPath;
  const conflicts: TaskPublishConflict[] = [];
  const warnings: string[] = await buildPublishQualityWarnings({
    bundlePath: task.bundlePath,
    meta: task.meta,
    summaryContent,
  });
  const operations: TaskPublishOperation[] = [
    {
      op: 'copy-tree',
      from: toRelative(projectRoot, task.bundlePath),
      to: toRelative(destination.info.projectRoot, targetPath),
      files: files.length,
    },
    {
      op: 'write-summary',
      path: toRelative(destination.info.projectRoot, path.join(targetPath, PUBLISH_SUMMARY_PATH)),
    },
    {
      op: 'write-manifest',
      path: toRelative(
        destination.info.projectRoot,
        path.join(targetPath, 'publish.manifest.json'),
      ),
    },
    {
      op: 'upsert-published-index',
      path: toRelative(destination.info.projectRoot, path.join(destinationTasksDir, 'index.json')),
    },
  ];

  if (input.deleteWorktree) {
    operations.push({ op: 'delete-worktree', path: projectRoot });
  }

  const checks: DoctorCheck[] = [
    makeCheck('source:bundle', true, 'info', 'Source task bundle exists.'),
    makeCheck(
      'source:clean',
      isClean(sourceGit),
      isClean(sourceGit) ? 'info' : 'warning',
      isClean(sourceGit) ? 'Source worktree is clean.' : 'Source worktree has local changes.',
    ),
    makeCheck(
      'task:stale',
      !actualization.needsActualization,
      actualization.needsActualization ? 'error' : 'info',
      actualization.needsActualization
        ? `Task is stale: ${actualization.reasons.join('; ')}.`
        : 'Task is not stale.',
    ),
    makeCheck(
      'destination:clean',
      isClean(destinationGit),
      isClean(destinationGit) ? 'info' : 'warning',
      isClean(destinationGit)
        ? 'Destination worktree is clean.'
        : 'Destination worktree has local changes.',
    ),
  ];

  if (actualization.needsActualization && !input.allowStale) {
    conflicts.push({
      path: task.meta.bundle.path,
      kind: 'stale-task',
      message: `Task bundle is stale: ${actualization.reasons.join('; ')}`,
    });
  } else if (actualization.needsActualization) {
    warnings.push('Task bundle is stale and will be published because --allow-stale is set.');
  }

  const destinationState = await classifyDestination(targetPath, bundleHash);
  const conflict = buildDestinationConflict(targetPath, destinationState);

  if (conflict) {
    if (conflictPolicy === 'rename') {
      targetPath = chooseConflictTarget(targetPath, task.taskId, sourceGit.head);
      operations.unshift({
        op: 'rename-target',
        from: toRelative(destination.info.projectRoot, intendedTargetPath),
        to: toRelative(destination.info.projectRoot, targetPath),
      });
      warnings.push(
        `Destination conflict will publish to ${toRelative(destination.info.projectRoot, targetPath)}.`,
      );
    } else if (conflictPolicy === 'overwrite' && input.force) {
      operations.unshift({
        op: 'backup-existing',
        path: toRelative(destination.info.projectRoot, intendedTargetPath),
      });
      warnings.push('Destination conflict will be overwritten after creating a backup.');
    } else {
      conflicts.push(conflict);
    }
  }

  if (destinationState.kind === 'manifest-compatible') {
    operations.unshift({
      op: 'idempotent-skip',
      path: toRelative(destination.info.projectRoot, targetPath),
    });
  }

  if (input.deleteWorktree) {
    const sourceMergedIntoBase =
      sourceGit.branch && sourceGit.branch !== sourceGit.baseBranch ? sourceGit.ahead === 0 : true;
    const worktrees = await listGitWorktrees(destination.info.projectRoot);
    const currentWorktree = worktrees.find(
      (worktree) => path.resolve(worktree.path) === projectRoot,
    );

    if (!isClean(sourceGit)) {
      conflicts.push({
        path: projectRoot,
        kind: 'delete-worktree-unsafe',
        message: 'Cannot delete source worktree because it has local changes.',
      });
    }

    if (!sourceMergedIntoBase && !input.force) {
      conflicts.push({
        path: projectRoot,
        kind: 'delete-worktree-unsafe',
        message: 'Cannot delete source worktree because its branch is not merged into base.',
      });
    }

    if (currentWorktree?.locked && !input.force) {
      conflicts.push({
        path: projectRoot,
        kind: 'delete-worktree-unsafe',
        message: 'Cannot delete source worktree because it is locked.',
      });
    }
  }

  const destinationInfo: TaskPublishDestinationInfo = {
    ...destination.info,
    targetPath: toRelative(destination.info.projectRoot, targetPath),
    clean: isClean(destinationGit),
  };
  const sourceInfo: TaskPublishSourceInfo = {
    projectRoot,
    bundlePath: toRelative(projectRoot, task.bundlePath),
    branch: sourceGit.branch,
    baseBranch: sourceGit.baseBranch,
    commit: sourceGit.head,
    gitCommonDir: sourceCommonDir,
    clean: isClean(sourceGit),
    bundleHash,
  };

  return {
    schemaVersion: 1,
    action: 'task-publish',
    dryRun: input.dryRun ?? true,
    taskId: task.taskId,
    mode,
    source: sourceInfo,
    destination: destinationInfo,
    checks,
    operations: operations.map((operation) => {
      if (operation.to === toRelative(destination.info.projectRoot, intendedTargetPath)) {
        return { ...operation, to: toRelative(destination.info.projectRoot, targetPath) };
      }
      if (
        operation.path ===
        toRelative(
          destination.info.projectRoot,
          path.join(intendedTargetPath, PUBLISH_SUMMARY_PATH),
        )
      ) {
        return {
          ...operation,
          path: toRelative(
            destination.info.projectRoot,
            path.join(targetPath, PUBLISH_SUMMARY_PATH),
          ),
        };
      }
      if (
        operation.path ===
        toRelative(
          destination.info.projectRoot,
          path.join(intendedTargetPath, 'publish.manifest.json'),
        )
      ) {
        return {
          ...operation,
          path: toRelative(
            destination.info.projectRoot,
            path.join(targetPath, 'publish.manifest.json'),
          ),
        };
      }
      return operation;
    }),
    conflicts,
    warnings,
    files,
  };
}

async function copyBundleFiles(
  sourceBundlePath: string,
  destinationPath: string,
  files: TaskPublishFileEntry[],
): Promise<void> {
  for (const file of files) {
    if (file.generated) {
      continue;
    }
    const relativePath = assertSafeRelativePath(file.path);
    const sourcePath = path.join(sourceBundlePath, relativePath);
    const destinationFilePath = path.join(destinationPath, relativePath);
    assertInside(sourceBundlePath, sourcePath, 'Source file');
    assertInside(destinationPath, destinationFilePath, 'Destination file');
    await ensureDir(path.dirname(destinationFilePath));
    await fs.copyFile(sourcePath, destinationFilePath);
  }
}

async function readPublishedTaskIndex(indexPath: string): Promise<PublishedTaskIndex> {
  const content = await readFileSafe(indexPath);
  if (content === null) {
    return { schemaVersion: 1, updatedAt: new Date().toISOString(), tasks: {} };
  }

  try {
    const parsed = JSON.parse(content) as PublishedTaskIndex;
    return {
      schemaVersion: 1,
      updatedAt: parsed.updatedAt,
      tasks: parsed.tasks ?? {},
    };
  } catch {
    throw new Error(`Published task index is not valid JSON: ${indexPath}`);
  }
}

async function upsertPublishedTaskIndex(
  indexPath: string,
  entry: PublishedTaskIndexEntry,
): Promise<void> {
  const index = await readPublishedTaskIndex(indexPath);
  const updatedAt = new Date().toISOString();
  index.updatedAt = updatedAt;
  index.tasks[entry.taskId] = entry;
  index.tasks = Object.fromEntries(
    Object.entries(index.tasks).sort(([left], [right]) => left.localeCompare(right)),
  );
  await writeJsonAtomic(indexPath, index);
}

async function buildManifest(
  plan: TaskPublishPlan,
  sourceBundlePath: string,
  destinationRoot: string,
  targetPath: string,
  conflictPolicy: TaskPublishConflictPolicy,
  includeArtifacts: TaskPublishArtifactPolicy,
): Promise<TaskPublishManifest> {
  const taskMetaPath = path.join(sourceBundlePath, 'task.meta.yaml');
  const artifactIndexPath = path.join(sourceBundlePath, 'artifacts/index.json');
  const stale = plan.checks.some((check) => check.id === 'task:stale' && !check.ok);
  const sourceMergedIntoBase =
    plan.source.branch && plan.source.branch !== plan.source.baseBranch
      ? plan.checks.every((check) => check.id !== 'source:not-merged')
      : true;

  return {
    schemaVersion: 1,
    taskId: plan.taskId,
    mode: plan.mode,
    publishedAt: new Date().toISOString(),
    publishedBy: {
      tool: 'llm-docs',
      version: PACKAGE_VERSION,
    },
    source: {
      ...plan.source,
      taskMetaHash: (await fileExists(taskMetaPath)) ? await sha256File(taskMetaPath) : null,
      artifactIndexHash: (await fileExists(artifactIndexPath))
        ? await sha256File(artifactIndexPath)
        : null,
    },
    destination: {
      ...plan.destination,
      projectRoot: destinationRoot,
      targetPath: toRelative(destinationRoot, targetPath),
      commitAfter: null,
      bundleHash: plan.source.bundleHash,
    },
    files: plan.files,
    checks: {
      stale,
      publishedWithStaleTask: stale,
      sourceClean: plan.source.clean,
      destinationCleanBefore: plan.destination.clean,
      sourceMergedIntoBase,
    },
    conflictPolicy,
    includeArtifacts,
  };
}

async function backupExistingDestination(targetPath: string, taskId: string): Promise<string> {
  const backupPath = path.join(
    path.dirname(targetPath),
    '.conflicts',
    taskId,
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
  await ensureDir(path.dirname(backupPath));
  await fs.rename(targetPath, backupPath);
  return backupPath;
}

async function removeSourceWorktree(sourceRoot: string, destinationRoot: string): Promise<void> {
  if (path.resolve(sourceRoot) === path.resolve(destinationRoot)) {
    throw new Error('Refusing to remove source worktree because source and destination are equal.');
  }

  await simpleGit(destinationRoot).raw(['worktree', 'remove', sourceRoot]);
}

export async function applyTaskPublish(
  projectRoot: string,
  config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  input: TaskPublishPrepareInput = {},
): Promise<TaskPublishReport> {
  const conflictPolicy =
    input.conflictPolicy ?? config.worktrees?.publish?.conflictPolicy ?? 'fail';
  const includeArtifacts =
    input.includeArtifacts ?? config.worktrees?.publish?.includeArtifacts ?? 'copy';
  const plan = await prepareTaskPublish(projectRoot, config, paths, { ...input, dryRun: false });

  if (plan.conflicts.length > 0) {
    throw new Error(
      `Cannot publish ${plan.taskId}: ${plan.conflicts.map((conflict) => conflict.message).join('; ')}`,
    );
  }

  const destinationResolution = await loadDestination(projectRoot, config, input);
  const destinationTasksDir = resolveDestinationTasksDir(
    destinationResolution.paths,
    destinationResolution.config,
    plan.mode,
  );
  const targetPath = path.resolve(
    destinationResolution.info.projectRoot,
    plan.destination.targetPath,
  );
  const sourceBundlePath = path.resolve(projectRoot, plan.source.bundlePath);
  const manifestPath = path.join(targetPath, 'publish.manifest.json');
  const indexPath = path.join(destinationTasksDir, 'index.json');
  const destinationState = await classifyDestination(targetPath, plan.source.bundleHash ?? '');
  const meta = await readTaskMeta(paths, plan.taskId);

  if (destinationState.kind === 'manifest-compatible') {
    await upsertPublishedTaskIndex(indexPath, {
      taskId: plan.taskId,
      title: meta.title,
      status: meta.status,
      phase: meta.phase,
      publishedAt: destinationState.manifest?.publishedAt ?? new Date().toISOString(),
      path: plan.destination.targetPath,
      sourceBranch: plan.source.branch,
      sourceCommit: plan.source.commit,
      destinationCommit: plan.destination.commitBefore,
      bundleHash: plan.source.bundleHash,
      manifestPath: toRelative(destinationResolution.info.projectRoot, manifestPath),
    });

    return {
      ...plan,
      applied: true,
      manifestPath: toRelative(destinationResolution.info.projectRoot, manifestPath),
      indexPath: toRelative(destinationResolution.info.projectRoot, indexPath),
      deletedWorktree: false,
    };
  }

  if (destinationState.kind !== 'absent') {
    if (conflictPolicy === 'overwrite' && input.force) {
      await backupExistingDestination(targetPath, plan.taskId);
    } else if (conflictPolicy !== 'rename') {
      throw new Error(`Destination conflict at ${plan.destination.targetPath}.`);
    }
  }

  const tempPath = path.join(
    destinationTasksDir,
    '.tmp',
    `${plan.taskId}.${process.pid}.${Date.now()}`,
  );

  try {
    await copyBundleFiles(sourceBundlePath, tempPath, plan.files);
    const summaryContent = await buildTaskSummaryMarkdown({
      projectRoot,
      bundlePath: sourceBundlePath,
      meta,
    });
    await writeTextAtomic(path.join(tempPath, PUBLISH_SUMMARY_PATH), summaryContent);
    const manifest = await buildManifest(
      plan,
      sourceBundlePath,
      destinationResolution.info.projectRoot,
      targetPath,
      conflictPolicy,
      includeArtifacts,
    );
    await writeJsonAtomic(path.join(tempPath, 'publish.manifest.json'), manifest);
    await ensureDir(path.dirname(targetPath));
    await fs.rename(tempPath, targetPath);

    await upsertPublishedTaskIndex(indexPath, {
      taskId: plan.taskId,
      title: meta.title,
      status: meta.status,
      phase: meta.phase,
      publishedAt: manifest.publishedAt,
      path: plan.destination.targetPath,
      sourceBranch: plan.source.branch,
      sourceCommit: plan.source.commit,
      destinationCommit: plan.destination.commitBefore,
      bundleHash: plan.source.bundleHash,
      manifestPath: toRelative(destinationResolution.info.projectRoot, manifestPath),
    });

    if (input.deleteWorktree) {
      await removeSourceWorktree(projectRoot, destinationResolution.info.projectRoot);
    }

    return {
      ...plan,
      applied: true,
      manifestPath: toRelative(destinationResolution.info.projectRoot, manifestPath),
      indexPath: toRelative(destinationResolution.info.projectRoot, indexPath),
      deletedWorktree: !!input.deleteWorktree,
    };
  } catch (error) {
    await fs.rm(tempPath, { recursive: true, force: true });
    throw error;
  }
}
