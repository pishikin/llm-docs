import path from 'node:path';
import { simpleGit } from 'simple-git';
import { ensureDir, fileExists } from '../../utils/fs.js';
import { WorkspaceBootstrapError } from '../errors.js';
import { installClaudePack } from '../hosts/claude/install.js';
import { installCodexPack } from '../hosts/codex/install.js';
import { installCursorPack } from '../hosts/cursor/install.js';
import { ensureExecutable, writeIfChanged } from '../hosts/shared.js';
import type {
  LlmDocsConfig,
  WorkspaceBootstrapOperation,
  WorkspaceBootstrapOptions,
  WorkspaceBootstrapReport,
} from '../types.js';
import { installManagedGitHooks } from './git-hooks.js';
import {
  buildLauncherCommand,
  buildWorktreeLauncherCommand,
  renderCliLauncher,
  resolveSetupCliEntrypoint,
  smokeTestCliLauncher,
} from './launcher.js';
import { resolveWorkspaceManifestPath, writeWorkspaceManifest } from './manifest.js';
import { resolveWorkspacePaths } from './paths.js';

export async function ensureWorkspaceDirs(
  paths: ReturnType<typeof resolveWorkspacePaths>,
  options: WorkspaceBootstrapOptions = {},
): Promise<Pick<WorkspaceBootstrapReport, 'createdDirs' | 'existingDirs'>> {
  const createdDirs: string[] = [];
  const existingDirs: string[] = [];
  const directories = [
    paths.workspaceRoot,
    paths.workspaceBinDir,
    paths.tasksDir,
    paths.docsDir,
    paths.archiveDir,
    paths.researchDir,
    paths.promptsDir,
    paths.claudeSkillsDir,
  ];

  for (const dirPath of directories) {
    if (await fileExists(dirPath)) {
      existingDirs.push(dirPath);
      options.collectOperation?.({
        path: dirPath,
        kind: 'directory',
        action: 'skip',
        safe: true,
        message: `Directory already exists: ${path.basename(dirPath)}.`,
      });
      continue;
    }

    if (!options.dryRun) {
      await ensureDir(dirPath);
    }

    createdDirs.push(dirPath);
    options.collectOperation?.({
      path: dirPath,
      kind: 'directory',
      action: 'create',
      ownership: 'absent',
      safe: true,
      message: `Created workspace directory ${path.basename(dirPath)}.`,
    });
  }

  const registryParent = path.dirname(paths.registryPath);

  if (await fileExists(registryParent)) {
    existingDirs.push(registryParent);
    options.collectOperation?.({
      path: registryParent,
      kind: 'directory',
      action: 'skip',
      safe: true,
      message: `Registry directory already exists: ${path.basename(registryParent)}.`,
    });
  } else {
    if (!options.dryRun) {
      await ensureDir(registryParent);
    }
    createdDirs.push(registryParent);
    options.collectOperation?.({
      path: registryParent,
      kind: 'directory',
      action: 'create',
      ownership: 'absent',
      safe: true,
      message: `Created registry directory ${path.basename(registryParent)}.`,
    });
  }

  return { createdDirs, existingDirs };
}

export async function ensureCliLauncher(
  projectRoot: string,
  paths: ReturnType<typeof resolveWorkspacePaths>,
  options: WorkspaceBootstrapOptions = {},
): Promise<string | null> {
  const setupCliEntrypoint = await resolveSetupCliEntrypoint();
  const nextLauncherContent = renderCliLauncher(paths, { setupCliEntrypoint });
  const status = await writeIfChanged(
    paths.cliLauncherPath,
    nextLauncherContent,
    options,
    'launcher',
  );

  if (!options.dryRun) {
    await ensureExecutable(paths.cliLauncherPath);
  }

  if (options.dryRun && status === 'unchanged') {
    const smoke = await smokeTestCliLauncher(paths, { timeoutMs: 3000 });
    if (!smoke.ok) {
      options.collectOperation?.({
        path: paths.cliLauncherPath,
        kind: 'launcher',
        action: 'update',
        ownership: 'llm-docs-managed-file',
        safe: true,
        message: `Would repair unchanged launcher because smoke test failed: ${smoke.error ?? smoke.stderr.trim() ?? 'unknown launcher error'}.`,
      });
      return path.relative(projectRoot, paths.cliLauncherPath);
    }
  }

  if (status === 'unchanged') {
    return null;
  }

  return path.relative(projectRoot, paths.cliLauncherPath);
}

export async function installHostPacks(
  projectRoot: string,
  config: LlmDocsConfig,
  paths: ReturnType<typeof resolveWorkspacePaths>,
  options: WorkspaceBootstrapOptions = {},
): Promise<{ status: WorkspaceBootstrapReport['hostPackStatus']; files: string[] }> {
  const selectedHosts =
    options.installHosts ??
    [
      config.hosts.claude.enabled ? 'claude' : null,
      config.hosts.codex.enabled ? 'codex' : null,
      config.hosts.cursor.enabled ? 'cursor' : null,
    ].filter((host): host is 'claude' | 'codex' | 'cursor' => host !== null);

  if (selectedHosts.length === 0) {
    return { status: 'skipped', files: [] };
  }

  const reports = await Promise.all(
    selectedHosts.map(async (host) => {
      if (host === 'claude') {
        return installClaudePack(projectRoot, config, paths, options);
      }

      if (host === 'codex') {
        return installCodexPack(projectRoot, config, paths, options);
      }

      return installCursorPack(projectRoot, config, paths, options);
    }),
  );

  return {
    status: 'installed',
    files: reports.flatMap((report) => report.filesWritten),
  };
}

async function resolveGitHooksDir(projectRoot: string): Promise<string> {
  try {
    const git = simpleGit(projectRoot);
    const rawHooksPath = (await git.raw(['rev-parse', '--git-path', 'hooks'])).trim();
    const hooksDir = path.resolve(projectRoot, rawHooksPath);

    await ensureDir(hooksDir);
    return hooksDir;
  } catch (error) {
    throw new WorkspaceBootstrapError('Cannot install git hooks outside a git repository', error);
  }
}

export async function installGitHooks(
  projectRoot: string,
  _config: LlmDocsConfig,
  _paths: ReturnType<typeof resolveWorkspacePaths>,
  options: WorkspaceBootstrapOptions = {},
): Promise<{ status: WorkspaceBootstrapReport['gitHookStatus']; files: string[] }> {
  if (!options.enableGitHooks) {
    return { status: 'skipped', files: [] };
  }

  const hooksDir = await resolveGitHooksDir(projectRoot);

  const hookSpecs = [
    {
      hookName: 'prepare-commit-msg',
      command: buildWorktreeLauncherCommand(_paths, ['internal', 'git-prepare-commit-msg']),
    },
    {
      hookName: 'post-commit',
      command: buildWorktreeLauncherCommand(_paths, ['internal', 'git-post-commit']),
    },
    {
      hookName: 'post-merge',
      command: buildWorktreeLauncherCommand(_paths, ['internal', 'git-post-merge']),
    },
    {
      hookName: 'pre-push',
      command: buildWorktreeLauncherCommand(_paths, ['internal', 'git-pre-push']),
    },
  ] as const;
  const operations = await installManagedGitHooks(projectRoot, hooksDir, hookSpecs, options);

  for (const operation of operations) {
    options.collectOperation?.(operation);
  }

  return {
    status: 'installed',
    files: operations.flatMap((operation) =>
      operation.candidatePath ? [operation.path, operation.candidatePath] : [operation.path],
    ),
  };
}

function toProjectRelative(projectRoot: string, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const absolute = path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
  return path.relative(projectRoot, absolute);
}

function normalizeOperation(
  projectRoot: string,
  operation: WorkspaceBootstrapOperation,
): WorkspaceBootstrapOperation {
  return {
    ...operation,
    path: toProjectRelative(projectRoot, operation.path) ?? operation.path,
    candidatePath: toProjectRelative(projectRoot, operation.candidatePath),
  };
}

function summarizeOperations(
  operations: WorkspaceBootstrapOperation[],
): WorkspaceBootstrapReport['summary'] {
  return {
    creates: operations.filter((operation) => operation.action === 'create').length,
    updates: operations.filter(
      (operation) => operation.action === 'update' || operation.action === 'replace-managed-block',
    ).length,
    candidates: operations.filter((operation) => operation.action === 'write-candidate').length,
    conflicts: operations.filter((operation) => !operation.safe && operation.action !== 'error')
      .length,
    errors: operations.filter((operation) => operation.action === 'error').length,
  };
}

export async function bootstrapWorkspace(
  projectRoot: string,
  config: LlmDocsConfig,
  options: WorkspaceBootstrapOptions = {},
): Promise<WorkspaceBootstrapReport> {
  try {
    const paths = resolveWorkspacePaths(projectRoot, config);
    const operations: WorkspaceBootstrapOperation[] = [];
    const collectOperation = (operation: WorkspaceBootstrapOperation) => {
      operations.push(normalizeOperation(paths.projectRoot, operation));
      options.collectOperation?.(operation);
    };
    const operationOptions = { ...options, collectOperation };
    const dirReport = await ensureWorkspaceDirs(paths, operationOptions);
    const launcherFile = await ensureCliLauncher(projectRoot, paths, operationOptions);
    const hostPackReport = await installHostPacks(projectRoot, config, paths, operationOptions);
    const gitHookReport = await installGitHooks(projectRoot, config, paths, operationOptions);
    let manifestFile: string | null = null;

    if (!options.dryRun) {
      const manifestStatus = await writeWorkspaceManifest(paths, operations);
      const manifestPath = resolveWorkspaceManifestPath(paths);
      const manifestOperation: WorkspaceBootstrapOperation = {
        path: path.relative(paths.projectRoot, manifestPath),
        kind: 'manifest',
        action: manifestStatus === 'created' ? 'create' : 'update',
        ownership: 'llm-docs-managed-file',
        safe: true,
        message: `${manifestStatus === 'created' ? 'Created' : 'Updated'} llm-docs workspace manifest.`,
      };
      operations.push(manifestOperation);
      manifestFile = manifestOperation.path;
    } else {
      const manifestPath = resolveWorkspaceManifestPath(paths);
      const manifestOperation: WorkspaceBootstrapOperation = {
        path: path.relative(paths.projectRoot, manifestPath),
        kind: 'manifest',
        action: (await fileExists(manifestPath)) ? 'update' : 'create',
        ownership: 'llm-docs-managed-file',
        safe: true,
        message: 'Would write llm-docs workspace manifest.',
      };
      operations.push(manifestOperation);
      manifestFile = manifestOperation.path;
    }

    return {
      projectRoot: paths.projectRoot,
      dryRun: !!options.dryRun,
      createdDirs: dirReport.createdDirs,
      existingDirs: dirReport.existingDirs,
      hostPackStatus: hostPackReport.status,
      gitHookStatus: gitHookReport.status,
      generatedFiles: [
        ...(launcherFile ? [launcherFile] : []),
        ...hostPackReport.files,
        ...gitHookReport.files,
        ...(manifestFile ? [manifestFile] : []),
      ],
      operations,
      summary: summarizeOperations(operations),
    };
  } catch (error) {
    if (error instanceof WorkspaceBootstrapError) {
      throw error;
    }

    throw new WorkspaceBootstrapError(
      error instanceof Error ? error.message : 'Failed to bootstrap workspace directories',
      error,
    );
  }
}
