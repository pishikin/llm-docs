import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectConfig, Target } from '../../types/index.js';
import { normalizeRelativePath } from '../../utils/fs.js';
import { DEFAULT_CONTEXT_BUDGET, type LlmDocsConfigV2 } from '../types.js';

const KNOWN_V1_CONFIG_KEYS = new Set(['name', 'targets', 'provider', 'excludeDirs', 'docsDir']);
export const DEFAULT_ACTIVE_TASKS_DIR = '.llm-docs/tasks';

export function buildDefaultRegistryPath(rootDir: string): string {
  return normalizeRelativePath(path.posix.join(rootDir, DEFAULT_ACTIVE_TASKS_DIR, 'index.json'));
}

function inferProjectName(projectRoot: string, fallback?: string): string {
  if (fallback?.trim()) {
    return fallback.trim();
  }

  return path.basename(projectRoot);
}

function buildWorkspaceDefaults(rootDir: string, docsDir: string): LlmDocsConfigV2['workspace'] {
  return {
    rootDir,
    docsDir,
    tasksDir: DEFAULT_ACTIVE_TASKS_DIR,
    archiveDir: `${docsDir}/archive`,
    researchDir: `${docsDir}/research`,
    promptsDir: `${docsDir}/prompts`,
    skillsDir: 'skills',
  };
}

function buildDefaultTaskBundleConfig(rootDir: string): LlmDocsConfigV2['taskBundles'] {
  return {
    registryPath: buildDefaultRegistryPath(rootDir),
    layout: 'simple',
    defaultBaseBranch: 'main',
    artifactStorageMode: 'copy',
    markStaleOnPostCommit: true,
    markStaleOnPostMerge: true,
    requireExplicitRebaseline: true,
    relatedTaskLimit: 10,
    qualityProfile: 'normal',
  };
}

export function inferWorkspaceRootFromLegacyDocsDir(docsDir: string): string {
  const normalized = normalizeRelativePath(docsDir);
  const directory = path.posix.dirname(normalized);

  if (directory === '.' && path.posix.basename(normalized) === 'docs') {
    return '.';
  }

  if (directory === '.' || directory === '') {
    return '.claude';
  }

  return normalizeRelativePath(directory);
}

export function inferDefaultHosts(_projectRoot: string): LlmDocsConfigV2['hosts'] {
  return {
    claude: {
      enabled: true,
      installHooks: true,
      installSkills: true,
    },
    codex: {
      enabled: true,
      installHooks: true,
      installSkills: true,
    },
    cursor: {
      enabled: false,
      installRules: true,
    },
  };
}

export function isLikelyV1Config(value: unknown): value is ProjectConfig {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ProjectConfig>;

  return (
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.targets) &&
    !!candidate.provider &&
    typeof candidate.docsDir === 'string'
  );
}

async function readPackageName(projectRoot: string): Promise<string | undefined> {
  try {
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const content = await fs.readFile(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(content) as { name?: string };
    return parsed.name?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function normalizeTargets(targets: unknown): Target[] {
  if (!Array.isArray(targets)) {
    return ['claude'];
  }

  return targets.filter(
    (target): target is Target => target === 'claude' || target === 'codex' || target === 'cursor',
  );
}

export async function migrateV1ConfigToV2(
  v1: ProjectConfig & Record<string, unknown>,
  projectRoot: string,
): Promise<LlmDocsConfigV2> {
  const docsDir = normalizeRelativePath(v1.docsDir || '.claude/docs');
  const workspaceRoot = inferWorkspaceRootFromLegacyDocsDir(docsDir);
  const docsDirRelativeToWorkspace = normalizeRelativePath(
    path.posix.relative(workspaceRoot, docsDir),
  );
  const projectName = inferProjectName(
    projectRoot,
    v1.name || (await readPackageName(projectRoot)),
  );
  const extraEntries = Object.fromEntries(
    Object.entries(v1).filter(([key]) => !KNOWN_V1_CONFIG_KEYS.has(key)),
  );

  return {
    schemaVersion: 2,
    projectName,
    mode: 'context-ops',
    contextBudget: { ...DEFAULT_CONTEXT_BUDGET },
    workspace: buildWorkspaceDefaults(
      workspaceRoot,
      docsDirRelativeToWorkspace === '.' ? 'docs' : docsDirRelativeToWorkspace,
    ),
    taskBundles: buildDefaultTaskBundleConfig(workspaceRoot),
    hosts: inferDefaultHosts(projectRoot),
    integrations: {
      jira: {
        enabled: false,
        baseUrl: null,
        tokenEnvVar: 'JIRA_TOKEN',
        projectKeys: [],
      },
      github: {
        enabled: false,
      },
    },
    legacyAgentDocs: {
      enabled: true,
      targets: normalizeTargets(v1.targets),
      provider: v1.provider,
      docsDir,
      excludeDirs: Array.isArray(v1.excludeDirs) ? v1.excludeDirs.filter(Boolean) : [],
      ...(Object.keys(extraEntries).length > 0 ? { extra: extraEntries } : {}),
    },
  };
}

export async function createDefaultConfigV2(projectRoot: string): Promise<LlmDocsConfigV2> {
  const projectName = inferProjectName(projectRoot, await readPackageName(projectRoot));

  return {
    schemaVersion: 2,
    projectName,
    mode: 'context-ops',
    contextBudget: { ...DEFAULT_CONTEXT_BUDGET },
    workspace: buildWorkspaceDefaults('.claude', 'docs'),
    taskBundles: buildDefaultTaskBundleConfig('.claude'),
    hosts: inferDefaultHosts(projectRoot),
    integrations: {
      jira: {
        enabled: false,
        baseUrl: null,
        tokenEnvVar: 'JIRA_TOKEN',
        projectKeys: [],
      },
      github: {
        enabled: false,
      },
    },
  };
}
