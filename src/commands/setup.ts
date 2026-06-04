import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { getProjectRoot, normalizeRelativePath } from '../utils/fs.js';
import { loadOrMigrateConfig, writeConfigV2 } from '../v2/config/load.js';
import { buildDefaultRegistryPath } from '../v2/config/migrate.js';
import type {
  LlmDocsConfigV2,
  WorkspaceBootstrapReport,
  WorkspaceLegacyAliasHit,
} from '../v2/types.js';
import {
  resolveArchiveDirCandidates,
  resolvePromptsDirCandidates,
} from '../v2/workspace/aliases.js';
import { bootstrapWorkspace } from '../v2/workspace/bootstrap.js';
import { resolveWorkspacePaths } from '../v2/workspace/paths.js';

type HostName = 'claude' | 'codex' | 'cursor';

export interface SetupCommandOptions {
  hosts?: string;
  workspaceRoot?: string;
  enableGitHooks?: boolean;
  migrateConfig?: boolean;
  migrateSpellingFixes?: boolean;
  withLegacy?: boolean;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
  preflight?: boolean;
  writePolicy?: 'safe' | 'candidate' | 'managed-block';
}

interface AliasMigration {
  kind: WorkspaceLegacyAliasHit['kind'];
  from: string;
  to: string;
  status: 'migrated' | 'would-migrate' | 'skipped';
  reason?: string;
}

export interface SetupCommandResult {
  projectRoot: string;
  configPath: string;
  configStatus: 'loaded' | 'migrated' | 'created';
  wroteConfig: boolean;
  migrationSummary: string[];
  bootstrapReport: WorkspaceBootstrapReport;
  aliasMigrations: AliasMigration[];
  config: LlmDocsConfigV2;
}

function parseHostsOption(value: string | undefined): HostName[] | undefined {
  if (!value) {
    return undefined;
  }

  const items = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const hosts = [...new Set(items)];
  const invalidHosts = hosts.filter(
    (item): item is string => item !== 'claude' && item !== 'codex' && item !== 'cursor',
  );

  if (invalidHosts.length > 0) {
    throw new Error(
      `Unsupported host list: ${invalidHosts.join(', ')}. Expected claude, codex, cursor.`,
    );
  }

  return hosts as HostName[];
}

function applyWorkspaceRootOverride(
  config: LlmDocsConfigV2,
  workspaceRoot: string | undefined,
): LlmDocsConfigV2 {
  if (!workspaceRoot) {
    return config;
  }

  const rootDir = normalizeRelativePath(workspaceRoot);

  return {
    ...config,
    workspace: {
      ...config.workspace,
      rootDir,
    },
    taskBundles: {
      ...config.taskBundles,
      registryPath: buildDefaultRegistryPath(rootDir),
    },
  };
}

function applyHostSelection(
  config: LlmDocsConfigV2,
  selectedHosts: HostName[] | undefined,
): LlmDocsConfigV2 {
  if (!selectedHosts) {
    return config;
  }

  const selected = new Set(selectedHosts);

  return {
    ...config,
    hosts: {
      claude: {
        ...config.hosts.claude,
        enabled: selected.has('claude'),
      },
      codex: {
        ...config.hosts.codex,
        enabled: selected.has('codex'),
      },
      cursor: {
        ...config.hosts.cursor,
        enabled: selected.has('cursor'),
      },
    },
  };
}

async function maybeWriteConfig(
  projectRoot: string,
  nextConfig: LlmDocsConfigV2,
  options: SetupCommandOptions,
  alreadyWroteConfig: boolean,
  initialConfig: LlmDocsConfigV2,
): Promise<boolean> {
  const initialJson = JSON.stringify(initialConfig);
  const nextJson = JSON.stringify(nextConfig);
  const changed = initialJson !== nextJson;

  if (changed && !options.dryRun) {
    await writeConfigV2(projectRoot, nextConfig);
  }

  return alreadyWroteConfig || (changed && !options.dryRun);
}

async function migrateAliasPath(
  projectRoot: string,
  canonicalPath: string,
  aliasPath: string,
  kind: AliasMigration['kind'],
  dryRun: boolean,
): Promise<AliasMigration | null> {
  try {
    await fs.access(aliasPath);
  } catch {
    return null;
  }

  try {
    await fs.access(canonicalPath);
    return {
      kind,
      from: normalizeRelativePath(path.relative(projectRoot, aliasPath)),
      to: normalizeRelativePath(path.relative(projectRoot, canonicalPath)),
      status: 'skipped',
      reason: 'Canonical path already exists.',
    };
  } catch {
    // canonical path missing, continue
  }

  if (!dryRun) {
    await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
    await fs.rename(aliasPath, canonicalPath);
  }

  return {
    kind,
    from: normalizeRelativePath(path.relative(projectRoot, aliasPath)),
    to: normalizeRelativePath(path.relative(projectRoot, canonicalPath)),
    status: dryRun ? 'would-migrate' : 'migrated',
  };
}

async function migrateLegacyAliases(
  projectRoot: string,
  config: LlmDocsConfigV2,
  options: SetupCommandOptions,
): Promise<AliasMigration[]> {
  if (!options.migrateSpellingFixes) {
    return [];
  }

  const paths = resolveWorkspacePaths(projectRoot, config);
  const archiveCandidates = resolveArchiveDirCandidates(paths);
  const promptsCandidates = resolvePromptsDirCandidates(paths);
  const migrations = await Promise.all([
    migrateAliasPath(
      projectRoot,
      archiveCandidates[0],
      archiveCandidates[1],
      'archive',
      !!options.dryRun,
    ),
    migrateAliasPath(
      projectRoot,
      promptsCandidates[0],
      promptsCandidates[1],
      'prompts',
      !!options.dryRun,
    ),
  ]);

  return migrations.filter((item): item is AliasMigration => item !== null);
}

function formatConfigStatus(result: SetupCommandResult): string {
  const statusLabel =
    result.configStatus === 'created'
      ? 'Created new v2 config'
      : result.configStatus === 'migrated'
        ? 'Migrated legacy config to v2'
        : 'Loaded existing v2 config';

  return `${statusLabel}: ${normalizeRelativePath(path.relative(result.projectRoot, result.configPath))}`;
}

function printSetupSummary(result: SetupCommandResult): void {
  console.log(`Workspace root: ${result.projectRoot}`);
  console.log(formatConfigStatus(result));

  for (const line of result.migrationSummary) {
    console.log(`- ${line}`);
  }

  if (result.aliasMigrations.length > 0) {
    console.log('Legacy spelling migrations:');
    for (const migration of result.aliasMigrations) {
      const reason = migration.reason ? ` (${migration.reason})` : '';
      console.log(`- ${migration.status}: ${migration.from} -> ${migration.to}${reason}`);
    }
  }

  const dirLabel = result.bootstrapReport.dryRun ? 'Directories planned' : 'Directories created';
  if (result.bootstrapReport.createdDirs.length > 0) {
    console.log(`${dirLabel}:`);
    for (const dirPath of result.bootstrapReport.createdDirs) {
      console.log(`- ${normalizeRelativePath(path.relative(result.projectRoot, dirPath))}`);
    }
  }

  if (result.bootstrapReport.generatedFiles && result.bootstrapReport.generatedFiles.length > 0) {
    const filesLabel = result.bootstrapReport.dryRun
      ? 'Generated files planned'
      : 'Generated files';
    console.log(`${filesLabel}:`);
    for (const filePath of result.bootstrapReport.generatedFiles) {
      console.log(`- ${filePath}`);
    }
  }

  const operations = result.bootstrapReport.operations ?? [];
  const candidates = operations.filter((operation) => operation.action === 'write-candidate');
  const errors = operations.filter((operation) => operation.action === 'error');

  if (candidates.length > 0) {
    console.log('Candidates:');
    for (const operation of candidates) {
      const candidate = operation.candidatePath ? ` -> ${operation.candidatePath}` : '';
      console.log(`- ${operation.path}${candidate}`);
    }
  }

  if (errors.length > 0) {
    console.log('Setup warnings/errors:');
    for (const operation of errors) {
      console.log(`- ${operation.path}: ${operation.message}`);
    }
  }

  console.log(`Host packs: ${result.bootstrapReport.hostPackStatus}`);
  console.log(`Git hooks: ${result.bootstrapReport.gitHookStatus}`);
}

export async function runSetup(
  options: SetupCommandOptions,
  startDir?: string,
): Promise<SetupCommandResult> {
  const effectiveOptions: SetupCommandOptions = {
    ...options,
    dryRun: options.preflight ? true : options.dryRun,
    writePolicy: options.writePolicy ?? 'safe',
  };
  const projectRoot = await getProjectRoot(startDir);
  const selectedHosts = parseHostsOption(effectiveOptions.hosts);
  const configResult = await loadOrMigrateConfig(projectRoot, {
    createIfMissing: true,
    dryRun: effectiveOptions.dryRun,
  });

  let config = configResult.config;
  config = applyWorkspaceRootOverride(config, effectiveOptions.workspaceRoot);
  config = applyHostSelection(config, selectedHosts);

  const wroteConfig = await maybeWriteConfig(
    projectRoot,
    config,
    effectiveOptions,
    configResult.wroteConfig,
    configResult.config,
  );
  const aliasMigrations = await migrateLegacyAliases(projectRoot, config, effectiveOptions);
  const bootstrapReport = await bootstrapWorkspace(projectRoot, config, {
    dryRun: effectiveOptions.dryRun,
    installHosts: selectedHosts,
    enableGitHooks: effectiveOptions.enableGitHooks,
    force: effectiveOptions.force,
    writePolicy: effectiveOptions.writePolicy,
  });

  return {
    projectRoot,
    configPath: configResult.configPath,
    configStatus: configResult.status,
    wroteConfig,
    migrationSummary: configResult.migrationSummary,
    bootstrapReport,
    aliasMigrations,
    config,
  };
}

const command = new Command('setup')
  .description('Bootstrap llm-docs v2 workspace, host packs, and optional git hooks')
  .option('--hosts <hosts>', 'hosts to install (claude,codex,cursor)')
  .option('--workspace-root <path>', 'override the workspace root directory')
  .option('--enable-git-hooks', 'install project-local git hooks')
  .option(
    '--migrate-config',
    'accepted for protocol compatibility; setup already migrates config when needed',
  )
  .option(
    '--migrate-spelling-fixes',
    'rename legacy archieve/promts directories to canonical names',
  )
  .option('--with-legacy', 'preserve legacy compatibility settings when present')
  .option('--dry-run', 'show the bootstrap plan without writing files')
  .option('--preflight', 'alias for dry-run setup planning')
  .option('--json', 'print setup result as JSON')
  .option('--write-policy <policy>', 'safe, candidate, or managed-block', 'safe')
  .option('--force', 'overwrite managed config blocks when safe merge is not possible')
  .action(async (options: SetupCommandOptions) => {
    if (
      options.writePolicy &&
      !['safe', 'candidate', 'managed-block'].includes(options.writePolicy)
    ) {
      throw new Error('Unsupported write policy. Expected safe, candidate, or managed-block.');
    }
    const result = await runSetup(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printSetupSummary(result);
    }
  });

export default command;
