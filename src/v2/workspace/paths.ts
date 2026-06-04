import path from 'node:path';
import { normalizeRelativePath } from '../../utils/fs.js';
import type { LlmDocsConfigV2, WorkspacePaths } from '../types.js';

function resolveUnder(root: string, relativePath: string): string {
  return path.resolve(root, normalizeRelativePath(relativePath));
}

function toRelative(projectRoot: string, absolutePath: string): string {
  return normalizeRelativePath(path.relative(projectRoot, absolutePath));
}

export function resolveWorkspacePaths(
  projectRoot: string,
  config: LlmDocsConfigV2,
): WorkspacePaths {
  const normalizedProjectRoot = path.resolve(projectRoot);
  const configPath = path.join(normalizedProjectRoot, 'llmdocs.config.json');
  const workspaceRoot = resolveUnder(normalizedProjectRoot, config.workspace.rootDir);
  const workspaceBinDir = path.join(workspaceRoot, 'bin');
  const tasksDir = resolveUnder(workspaceRoot, config.workspace.tasksDir);
  const registryPath = resolveUnder(normalizedProjectRoot, config.taskBundles.registryPath);
  const docsDir = resolveUnder(workspaceRoot, config.workspace.docsDir);
  const archiveDir = resolveUnder(workspaceRoot, config.workspace.archiveDir);
  const researchDir = resolveUnder(workspaceRoot, config.workspace.researchDir);
  const promptsDir = resolveUnder(workspaceRoot, config.workspace.promptsDir);
  const cliLauncherPath = path.join(workspaceBinDir, 'llm-docs.mjs');
  const claudeSkillsDir = resolveUnder(workspaceRoot, config.workspace.skillsDir);
  const codexSkillsDir = path.resolve(normalizedProjectRoot, '.agents/skills');
  const cursorRulesDir = path.resolve(normalizedProjectRoot, '.cursor/rules');
  const mcpConfigPath = path.resolve(normalizedProjectRoot, '.mcp.json');
  const claudeSettingsPath = path.resolve(workspaceRoot, 'settings.json');
  const codexConfigPath = path.resolve(normalizedProjectRoot, '.codex/config.toml');
  const codexHooksPath = path.resolve(normalizedProjectRoot, '.codex/hooks.json');

  return {
    projectRoot: normalizedProjectRoot,
    configPath,
    workspaceRoot,
    workspaceBinDir,
    tasksDir,
    registryPath,
    docsDir,
    archiveDir,
    researchDir,
    promptsDir,
    cliLauncherPath,
    claudeSkillsDir,
    codexSkillsDir,
    cursorRulesDir,
    mcpConfigPath,
    claudeSettingsPath,
    codexConfigPath,
    codexHooksPath,
    relative: {
      configPath: toRelative(normalizedProjectRoot, configPath),
      workspaceRoot: toRelative(normalizedProjectRoot, workspaceRoot),
      workspaceBinDir: toRelative(normalizedProjectRoot, workspaceBinDir),
      tasksDir: toRelative(normalizedProjectRoot, tasksDir),
      registryPath: toRelative(normalizedProjectRoot, registryPath),
      docsDir: toRelative(normalizedProjectRoot, docsDir),
      archiveDir: toRelative(normalizedProjectRoot, archiveDir),
      researchDir: toRelative(normalizedProjectRoot, researchDir),
      promptsDir: toRelative(normalizedProjectRoot, promptsDir),
      cliLauncherPath: toRelative(normalizedProjectRoot, cliLauncherPath),
      claudeSkillsDir: toRelative(normalizedProjectRoot, claudeSkillsDir),
      codexSkillsDir: toRelative(normalizedProjectRoot, codexSkillsDir),
      cursorRulesDir: toRelative(normalizedProjectRoot, cursorRulesDir),
      mcpConfigPath: toRelative(normalizedProjectRoot, mcpConfigPath),
      claudeSettingsPath: toRelative(normalizedProjectRoot, claudeSettingsPath),
      codexConfigPath: toRelative(normalizedProjectRoot, codexConfigPath),
      codexHooksPath: toRelative(normalizedProjectRoot, codexHooksPath),
    },
  };
}

export function resolveTaskBundlePath(paths: WorkspacePaths, taskId: string): string {
  return path.join(paths.tasksDir, taskId);
}

export function resolveTaskMetaPath(paths: WorkspacePaths, taskId: string): string {
  return path.join(resolveTaskBundlePath(paths, taskId), 'task.meta.yaml');
}

export function resolveTaskArtifactsDir(paths: WorkspacePaths, taskId: string): string {
  return path.join(resolveTaskBundlePath(paths, taskId), 'artifacts');
}

export function resolveTaskAdditionalDocsDir(paths: WorkspacePaths, taskId: string): string {
  return path.join(resolveTaskBundlePath(paths, taskId), 'docs');
}
