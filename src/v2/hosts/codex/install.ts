import path from 'node:path';
import TOML from '@iarna/toml';
import { ensureDir, readFileSafe } from '../../../utils/fs.js';
import {
  renderCodexConfigManagedBlock,
  renderCodexHooksManagedBlock,
  renderCodexSkillFiles,
} from '../../templates/codex-pack.js';
import { renderAgentsRootDoc, renderLegacyAgentsRootDoc } from '../../templates/root-docs.js';
import type {
  HostInstallOptions,
  HostInstallReport,
  LlmDocsConfigV2,
  WorkspacePaths,
} from '../../types.js';
import { buildLauncherCommand } from '../../workspace/launcher.js';
import {
  deepMerge,
  writeCandidateOrThrow,
  writeIfChanged,
  writeJsonMergedFile,
  writeManagedMarkdownFile,
} from '../shared.js';

export function mergeCodexConfig(
  existingToml: Record<string, unknown>,
  managedConfig: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedExisting = { ...existingToml };
  const existingFeatures = normalizedExisting.features;
  const managedFeatures = managedConfig.features;

  if (
    existingFeatures &&
    managedFeatures &&
    typeof existingFeatures === 'object' &&
    typeof managedFeatures === 'object' &&
    !Array.isArray(existingFeatures) &&
    !Array.isArray(managedFeatures) &&
    'hooks' in managedFeatures &&
    'codex_hooks' in existingFeatures
  ) {
    normalizedExisting.features = Object.fromEntries(
      Object.entries(existingFeatures as Record<string, unknown>).filter(
        ([key]) => key !== 'codex_hooks',
      ),
    );
  }

  return deepMerge(normalizedExisting, managedConfig);
}

export function mergeCodexHooks(
  existingJson: Record<string, unknown>,
  managedHooks: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...existingJson,
    hooks: {
      ...((existingJson.hooks as Record<string, unknown> | undefined) ?? {}),
      ...((managedHooks.hooks as Record<string, unknown> | undefined) ?? {}),
    },
  };
}

export async function ensureCodexSkills(
  paths: WorkspacePaths,
  options: HostInstallOptions,
): Promise<HostInstallReport['filesWritten']> {
  const skillFiles = renderCodexSkillFiles();
  const written: string[] = [];

  if (!options.dryRun) {
    await ensureDir(paths.codexSkillsDir);
  }
  for (const [relativePath, content] of Object.entries(skillFiles)) {
    const fullPath = path.join(paths.codexSkillsDir, relativePath);
    const status = await writeIfChanged(fullPath, content, options, 'skill');
    if (status !== 'unchanged') {
      written.push(path.relative(paths.projectRoot, fullPath));
    }
  }

  return written;
}

export async function ensureAgentsRootDoc(
  projectRoot: string,
  options: HostInstallOptions,
): Promise<string | null> {
  const targetPath = path.join(projectRoot, 'AGENTS.md');
  const candidatePath = path.join(projectRoot, 'AGENTS.llmdocs.generated.md');
  const status = await writeManagedMarkdownFile(
    targetPath,
    candidatePath,
    renderAgentsRootDoc(),
    options,
    (existing) => existing.trim() === renderLegacyAgentsRootDoc().trim(),
  );

  if (status === 'unchanged') {
    return null;
  }

  return status === 'candidate' ? 'AGENTS.llmdocs.generated.md' : 'AGENTS.md';
}

export async function installCodexPack(
  projectRoot: string,
  _config: LlmDocsConfigV2,
  paths: WorkspacePaths,
  options: HostInstallOptions = {},
): Promise<HostInstallReport> {
  const filesWritten: string[] = [];
  const filesCreated: string[] = [];
  const warnings: string[] = [];
  const configPath = paths.codexConfigPath;
  const hooksPath = paths.codexHooksPath;
  const existingToml = await readFileSafe(configPath);
  const managedConfig = renderCodexConfigManagedBlock(paths.cliLauncherPath);
  let mergedConfig = managedConfig;

  if (existingToml !== null) {
    try {
      mergedConfig = mergeCodexConfig(
        TOML.parse(existingToml) as Record<string, unknown>,
        managedConfig,
      );
    } catch {
      if (options.force) {
        mergedConfig = managedConfig;
      } else {
        await writeCandidateOrThrow(
          configPath,
          path.join(projectRoot, '.codex/config.generated.toml'),
          TOML.stringify(managedConfig as Parameters<typeof TOML.stringify>[0]),
          'Invalid existing .codex/config.toml; cannot merge safely.',
          options,
        );
      }
    }
  }

  const configStatus = await writeIfChanged(
    configPath,
    TOML.stringify(mergedConfig as Parameters<typeof TOML.stringify>[0]),
    options,
    'host-config',
  );
  if (configStatus !== 'unchanged') {
    filesWritten.push(paths.relative.codexConfigPath);
    if (configStatus === 'created') filesCreated.push(paths.relative.codexConfigPath);
  }

  const hooksStatus = await writeJsonMergedFile(
    hooksPath,
    renderCodexHooksManagedBlock((...args) => buildLauncherCommand(paths, args)),
    options,
    async (candidateContent) =>
      writeCandidateOrThrow(
        hooksPath,
        path.join(projectRoot, '.codex/hooks.generated.json'),
        candidateContent,
        'Invalid existing .codex/hooks.json; cannot merge safely.',
        options,
      ),
  );
  if (hooksStatus !== 'unchanged') {
    filesWritten.push(paths.relative.codexHooksPath);
    if (hooksStatus === 'created') filesCreated.push(paths.relative.codexHooksPath);
  }

  filesWritten.push(...(await ensureCodexSkills(paths, options)));
  const rootDoc = await ensureAgentsRootDoc(projectRoot, options);
  if (rootDoc) {
    filesWritten.push(rootDoc);
    filesCreated.push(rootDoc);
  }

  return {
    host: 'codex',
    filesWritten,
    filesCreated,
    warnings,
  };
}
