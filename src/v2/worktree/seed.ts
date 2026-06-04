import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  copyFileSafe,
  ensureDir,
  normalizeRelativePath,
  readFileSafe,
  readJsonSafe,
} from '../../utils/fs.js';
import type {
  WorktreeSeedConflictPolicy,
  WorktreeSeedFileOperation,
  WorktreeSeedInput,
  WorktreeSeedManifest,
  WorktreeSeedReport,
} from '../types.js';

const SEED_MANIFEST_RELATIVE_PATH = '.claude/docs/seed.manifest.json';
const SEED_RESULT_RELATIVE_PATH = '.claude/llm-docs.seed-manifest.json';

const LLM_DOCS_SKILL_DIRS = ['llm-docs'];
const SAFETY_EXCLUDE_PATTERNS = [
  '.claude/docs/archive/**',
  '.claude/docs/archieve/**',
  '.claude/docs/research/legacy/**',
  '.claude/docs/tasks/**',
  '.claude/tasks/**',
  '.claude/.llm-docs/**',
  '**/*.har',
  '**/*.log',
  '**/.DS_Store',
];

export const DEFAULT_WORKTREE_SEED_MANIFEST: WorktreeSeedManifest = {
  schemaVersion: 1,
  profiles: {
    minimal: {
      include: [
        'AGENTS.md',
        'CLAUDE.md',
        'llmdocs.config.json',
        '.mcp.json',
        '.codex/**',
        '.claude/bin/llm-docs.mjs',
      ],
      exclude: [],
    },
    default: {
      include: [
        'AGENTS.md',
        'CLAUDE.md',
        'llmdocs.config.json',
        '.mcp.json',
        '.codex/**',
        '.claude/bin/llm-docs.mjs',
        '.claude/settings.json',
        '.claude/MAINTENANCE.md',
        '.claude/docs/INDEX.md',
        '.claude/docs/AGENT_MAP.md',
        '.claude/docs/DECISION_TREE.md',
        '.claude/docs/quick-reference.md',
        '.claude/docs/architecture/**',
        '.claude/docs/guides/**',
        '.claude/rules/**',
        ...LLM_DOCS_SKILL_DIRS.map((dir) => `.agents/skills/${dir}/**`),
        ...LLM_DOCS_SKILL_DIRS.map((dir) => `.claude/skills/${dir}/**`),
      ],
      exclude: SAFETY_EXCLUDE_PATTERNS,
    },
  },
};

interface PreviousSeedManifest {
  files?: WorktreeSeedFileOperation[];
}

function normalizeRoot(value: string): string {
  return path.resolve(value);
}

function manifestPath(sourceRoot: string): string {
  return path.join(sourceRoot, SEED_MANIFEST_RELATIVE_PATH);
}

function resultManifestPath(destinationRoot: string): string {
  return path.join(destinationRoot, SEED_RESULT_RELATIVE_PATH);
}

function normalizePattern(value: string): string {
  return normalizeRelativePath(value).replace(/\/\*\*\*$/, '/**');
}

function patternToRegex(pattern: string): RegExp {
  let index = 0;
  let source = '^';

  while (index < pattern.length) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === '*' && next === '*') {
      const after = pattern[index + 2];
      if (after === '/') {
        source += '(?:.*/)?';
        index += 3;
      } else {
        source += '.*';
        index += 2;
      }
      continue;
    }

    if (char === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }

    source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    index += 1;
  }

  return new RegExp(`${source}$`);
}

function matchesPattern(relativePath: string, rawPattern: string): boolean {
  const pattern = normalizePattern(rawPattern);

  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
  }

  if (!pattern.includes('*')) {
    return relativePath === pattern || relativePath.startsWith(`${pattern}/`);
  }

  return patternToRegex(pattern).test(relativePath);
}

function isExcluded(relativePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(relativePath, pattern));
}

async function pathStats(
  filePath: string,
): Promise<{ isFile: boolean; isDirectory: boolean } | null> {
  try {
    const stats = await fs.stat(filePath);
    return { isFile: stats.isFile(), isDirectory: stats.isDirectory() };
  } catch {
    return null;
  }
}

async function listFilesRecursive(root: string, relativeDir = '.'): Promise<string[]> {
  const absoluteDir = relativeDir === '.' ? root : path.join(root, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = normalizeRelativePath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

async function expandInclude(sourceRoot: string, includePattern: string): Promise<string[]> {
  const pattern = normalizePattern(includePattern);

  if (!pattern.includes('*')) {
    const absolutePath = path.join(sourceRoot, pattern);
    const stats = await pathStats(absolutePath);
    if (!stats) {
      return [];
    }
    if (stats.isFile) {
      return [pattern];
    }
    if (stats.isDirectory) {
      return listFilesRecursive(sourceRoot, pattern);
    }
    return [];
  }

  if (pattern.endsWith('/**')) {
    const directory = pattern.slice(0, -3);
    const stats = await pathStats(path.join(sourceRoot, directory));
    return stats?.isDirectory ? listFilesRecursive(sourceRoot, directory) : [];
  }

  const allFiles = await listFilesRecursive(sourceRoot);
  return allFiles.filter((relativePath) => matchesPattern(relativePath, pattern));
}

async function sha256File(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

async function readSeedManifest(sourceRoot: string): Promise<{
  manifest: WorktreeSeedManifest;
  path: string | null;
}> {
  const sourceManifestPath = manifestPath(sourceRoot);
  const content = await readFileSafe(sourceManifestPath);

  if (content === null) {
    return { manifest: DEFAULT_WORKTREE_SEED_MANIFEST, path: null };
  }

  let manifest: WorktreeSeedManifest;
  try {
    manifest = JSON.parse(content) as WorktreeSeedManifest;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Invalid worktree seed manifest JSON: ${error.message}`
        : 'Invalid worktree seed manifest JSON.',
    );
  }

  if (manifest?.schemaVersion === 1 && manifest.profiles) {
    return { manifest, path: sourceManifestPath };
  }

  throw new Error('Invalid worktree seed manifest shape. Expected schemaVersion 1 and profiles.');
}

async function collectSeedFiles(
  sourceRoot: string,
  profile: string,
  manifest: WorktreeSeedManifest,
): Promise<string[]> {
  const seedProfile = manifest.profiles[profile];
  if (!seedProfile) {
    throw new Error(`Unknown worktree seed profile: ${profile}`);
  }

  const files = new Set<string>();
  for (const includePattern of seedProfile.include) {
    for (const filePath of await expandInclude(sourceRoot, includePattern)) {
      files.add(filePath);
    }
  }

  const excludePatterns = [...SAFETY_EXCLUDE_PATTERNS, ...(seedProfile.exclude ?? [])];
  return [...files].filter((filePath) => !isExcluded(filePath, excludePatterns)).sort();
}

function candidatePathFor(destinationRoot: string, relativePath: string): string {
  const parsed = path.parse(relativePath);
  const filename = parsed.ext
    ? `${parsed.name}.llmdocs.seed.candidate${parsed.ext}`
    : `${parsed.base}.llmdocs.seed.candidate`;
  return path.join(destinationRoot, parsed.dir, filename);
}

async function isManagedByPreviousSeed(
  destinationRoot: string,
  relativePath: string,
): Promise<boolean> {
  const previous = await readJsonSafe<PreviousSeedManifest>(resultManifestPath(destinationRoot));
  return !!previous?.files?.some(
    (file) => file.path === relativePath && (file.action === 'copy' || file.action === 'skip'),
  );
}

async function buildOperation(
  sourceRoot: string,
  destinationRoot: string,
  relativePath: string,
  conflictPolicy: WorktreeSeedConflictPolicy,
): Promise<WorktreeSeedFileOperation> {
  const sourcePath = path.join(sourceRoot, relativePath);
  const destinationPath = path.join(destinationRoot, relativePath);
  const [sourceStats, destinationStats] = await Promise.all([
    fs.stat(sourcePath),
    pathStats(destinationPath),
  ]);
  const sourceHash = await sha256File(sourcePath);

  if (!destinationStats) {
    return { path: relativePath, action: 'copy', size: sourceStats.size, sha256: sourceHash };
  }

  if (destinationStats.isFile) {
    const destinationHash = await sha256File(destinationPath);
    if (destinationHash === sourceHash) {
      return { path: relativePath, action: 'skip', size: sourceStats.size, sha256: sourceHash };
    }
  }

  if (conflictPolicy === 'fail') {
    return {
      path: relativePath,
      action: 'conflict',
      size: sourceStats.size,
      sha256: sourceHash,
      message: `Destination already has a different file: ${relativePath}`,
    };
  }

  if (
    conflictPolicy === 'overwrite-managed' &&
    (await isManagedByPreviousSeed(destinationRoot, relativePath))
  ) {
    return { path: relativePath, action: 'copy', size: sourceStats.size, sha256: sourceHash };
  }

  const candidatePath = candidatePathFor(destinationRoot, relativePath);
  return {
    path: relativePath,
    action: 'candidate',
    size: sourceStats.size,
    sha256: sourceHash,
    candidatePath: normalizeRelativePath(path.relative(destinationRoot, candidatePath)),
    message: `Destination is user-owned; wrote a seed candidate for ${relativePath}.`,
  };
}

function summarize(files: WorktreeSeedFileOperation[]): WorktreeSeedReport['summary'] {
  return {
    copied: files.filter((file) => file.action === 'copy').length,
    skipped: files.filter((file) => file.action === 'skip').length,
    candidates: files.filter((file) => file.action === 'candidate').length,
    conflicts: files.filter((file) => file.action === 'conflict').length,
  };
}

async function applySeedOperation(
  sourceRoot: string,
  destinationRoot: string,
  operation: WorktreeSeedFileOperation,
): Promise<void> {
  if (operation.action === 'copy') {
    await copyFileSafe(
      path.join(sourceRoot, operation.path),
      path.join(destinationRoot, operation.path),
    );
  } else if (operation.action === 'candidate' && operation.candidatePath) {
    await copyFileSafe(
      path.join(sourceRoot, operation.path),
      path.join(destinationRoot, operation.candidatePath),
    );
  }
}

async function writeSeedResultManifest(report: WorktreeSeedReport): Promise<void> {
  await ensureDir(path.dirname(resultManifestPath(report.destinationRoot)));
  await fs.writeFile(
    resultManifestPath(report.destinationRoot),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        seededAt: new Date().toISOString(),
        sourceRoot: report.sourceRoot,
        profile: report.profile,
        conflictPolicy: report.conflictPolicy,
        files: report.files,
        summary: report.summary,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
}

export async function prepareWorktreeSeed(input: WorktreeSeedInput): Promise<WorktreeSeedReport> {
  const sourceRoot = normalizeRoot(input.sourceRoot);
  const destinationRoot = normalizeRoot(input.destinationRoot);
  const profile = input.profile ?? 'default';
  const conflictPolicy = input.conflictPolicy ?? 'candidate';
  const { manifest, path: sourceManifestPath } = await readSeedManifest(sourceRoot);
  const seedFiles = await collectSeedFiles(sourceRoot, profile, manifest);
  const files = await Promise.all(
    seedFiles.map((relativePath) =>
      buildOperation(sourceRoot, destinationRoot, relativePath, conflictPolicy),
    ),
  );

  return {
    schemaVersion: 1,
    action: 'worktree-seed',
    dryRun: !!input.dryRun,
    sourceRoot,
    destinationRoot,
    profile,
    conflictPolicy,
    manifestPath: sourceManifestPath,
    files,
    summary: summarize(files),
  };
}

export async function applyWorktreeSeed(input: WorktreeSeedInput): Promise<WorktreeSeedReport> {
  const report = await prepareWorktreeSeed({ ...input, dryRun: false });

  if (report.summary.conflicts > 0) {
    const firstConflict = report.files.find((file) => file.action === 'conflict');
    throw new Error(firstConflict?.message ?? 'Worktree seed has unresolved conflicts.');
  }

  for (const operation of report.files) {
    await applySeedOperation(report.sourceRoot, report.destinationRoot, operation);
  }

  await writeSeedResultManifest(report);
  return report;
}
