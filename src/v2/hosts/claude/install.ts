import path from 'node:path';
import { ensureDir, writeTextAtomic } from '../../../utils/fs.js';
import {
  renderClaudeSettingsManagedBlock,
  renderClaudeSkillFiles,
  renderMcpJsonManagedBlock,
} from '../../templates/claude-pack.js';
import { renderClaudeRootDoc, renderLegacyClaudeRootDoc } from '../../templates/root-docs.js';
import type {
  HostInstallOptions,
  HostInstallReport,
  LlmDocsConfigV2,
  WorkspacePaths,
} from '../../types.js';
import { buildLauncherCommand } from '../../workspace/launcher.js';
import {
  writeCandidateOrThrow,
  writeIfChanged,
  writeJsonMergedFile,
  writeManagedMarkdownFile,
} from '../shared.js';

export function mergeClaudeSettings(
  existing: Record<string, unknown>,
  managedBlock: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...existing,
    hooks: {
      ...((existing.hooks as Record<string, unknown> | undefined) ?? {}),
      ...((managedBlock.hooks as Record<string, unknown> | undefined) ?? {}),
    },
  };
}

export async function ensureClaudeSkills(
  paths: WorkspacePaths,
  options: HostInstallOptions,
): Promise<HostInstallReport['filesWritten']> {
  const skillFiles = renderClaudeSkillFiles();
  const written: string[] = [];

  if (!options.dryRun) {
    await ensureDir(paths.claudeSkillsDir);
  }
  for (const [relativePath, content] of Object.entries(skillFiles)) {
    const fullPath = path.join(paths.claudeSkillsDir, relativePath);
    const status = await writeIfChanged(fullPath, content, options, 'skill');
    if (status !== 'unchanged') {
      written.push(path.relative(paths.projectRoot, fullPath));
    }
  }

  return written;
}

export async function ensureClaudeRootDoc(
  projectRoot: string,
  options: HostInstallOptions,
): Promise<string | null> {
  const targetPath = path.join(projectRoot, 'CLAUDE.md');
  const candidatePath = path.join(projectRoot, 'CLAUDE.llmdocs.generated.md');
  const status = await writeManagedMarkdownFile(
    targetPath,
    candidatePath,
    renderClaudeRootDoc(),
    options,
    (existing) => existing.trim() === renderLegacyClaudeRootDoc().trim(),
  );

  if (status === 'unchanged') {
    return null;
  }

  return status === 'candidate' ? 'CLAUDE.llmdocs.generated.md' : 'CLAUDE.md';
}

export async function installClaudePack(
  projectRoot: string,
  _config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  options: HostInstallOptions = {},
): Promise<HostInstallReport> {
  const filesWritten: string[] = [];
  const filesCreated: string[] = [];
  const warnings: string[] = [];

  const mcpStatus = await writeJsonMergedFile(
    paths.mcpConfigPath,
    renderMcpJsonManagedBlock(paths.cliLauncherPath),
    options,
    async (candidateContent) =>
      writeCandidateOrThrow(
        paths.mcpConfigPath,
        path.join(projectRoot, '.mcp.generated.json'),
        candidateContent,
        'Invalid existing .mcp.json; cannot merge safely.',
        options,
      ),
  );
  if (mcpStatus !== 'unchanged') {
    filesWritten.push(paths.relative.mcpConfigPath);
    if (mcpStatus === 'created') filesCreated.push(paths.relative.mcpConfigPath);
  }

  const settingsContent = renderClaudeSettingsManagedBlock((...args) =>
    buildLauncherCommand(paths, args),
  );
  const settingsStatus = await writeJsonMergedFile(
    paths.claudeSettingsPath,
    settingsContent,
    options,
    async (candidateContent) =>
      writeCandidateOrThrow(
        paths.claudeSettingsPath,
        path.join(paths.workspaceRoot, 'settings.generated.json'),
        candidateContent,
        'Invalid existing .claude/settings.json; cannot merge safely.',
        options,
      ),
  );
  if (settingsStatus !== 'unchanged') {
    filesWritten.push(paths.relative.claudeSettingsPath);
    if (settingsStatus === 'created') filesCreated.push(paths.relative.claudeSettingsPath);
  }

  filesWritten.push(...(await ensureClaudeSkills(paths, options)));
  const rootDoc = await ensureClaudeRootDoc(projectRoot, options);
  if (rootDoc) {
    filesWritten.push(rootDoc);
    filesCreated.push(rootDoc);
  }

  return {
    host: 'claude',
    filesWritten,
    filesCreated,
    warnings,
  };
}
