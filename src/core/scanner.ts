import fs from 'node:fs/promises';
import path from 'node:path';
import type { RawScanData } from '../types/index.js';
import { readJsonSafe } from '../utils/fs.js';

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.claude',
  '.cursor',
  'tmp',
  '.next',
  '.nuxt',
  'build',
  '__pycache__',
]);

export interface ScanProjectOptions {
  depth?: number;
  excludeDirs?: string[];
}

function normalizeExcludeDirs(excludeDirs?: string[]): Set<string> {
  const normalized = new Set(DEFAULT_IGNORE_DIRS);
  for (const dir of excludeDirs ?? []) {
    const value = dir.trim();
    if (value) {
      normalized.add(value);
    }
  }
  return normalized;
}

async function getDirectoryTree(
  rootDir: string,
  ignoreDirs: Set<string>,
  depth = 2,
  prefix = '',
): Promise<string[]> {
  if (depth < 0) return [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (ignoreDirs.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    results.push(rel);
    if (entry.isDirectory() && depth > 0) {
      results.push(
        ...(await getDirectoryTree(path.join(rootDir, entry.name), ignoreDirs, depth - 1, rel)),
      );
    }
  }
  return results;
}

function findConfigFiles(tree: string[]): string[] {
  const patterns = [
    /^\.eslintrc/,
    /^biome\.json$/,
    /^\.prettierrc/,
    /^prettier\.config/,
    /^webpack\.config/,
    /^vite\.config/,
    /^tsup\.config/,
    /^rollup\.config/,
    /^tsconfig\.json$/,
    /^vitest\.config/,
    /^jest\.config/,
    /^package\.json$/,
    /^Cargo\.toml$/,
    /^go\.mod$/,
    /^pyproject\.toml$/,
    /^Makefile$/,
    /^Dockerfile/,
    /^docker-compose/,
    /^\.env/,
    /^\.github/,
    /^\.gitlab-ci/,
  ];
  return tree.filter((f) => patterns.some((p) => p.test(path.basename(f))));
}

function findEntryPoints(tree: string[]): string[] {
  const patterns = [/^src\/(index|main|app)\.\w+$/, /^index\.\w+$/, /^main\.\w+$/];
  return tree.filter((f) => patterns.some((p) => p.test(f)));
}

function findTestFiles(tree: string[]): string[] {
  return tree.filter(
    (f) =>
      f.includes('test') ||
      f.includes('spec') ||
      f.startsWith('tests/') ||
      f.startsWith('__tests__/'),
  );
}

function findCIFiles(tree: string[]): string[] {
  return tree.filter((f) => f.startsWith('.github/workflows') || f === '.gitlab-ci.yml');
}

export async function scanProject(
  rootDir: string,
  options: ScanProjectOptions = {},
): Promise<RawScanData> {
  const packageJson = await readJsonSafe<Record<string, unknown>>(
    path.join(rootDir, 'package.json'),
  );
  const ignoreDirs = normalizeExcludeDirs(options.excludeDirs);
  const scanDepth = options.depth ?? 2;
  const directoryTree = await getDirectoryTree(rootDir, ignoreDirs, scanDepth);
  const configFiles = findConfigFiles(directoryTree);
  const entryPoints = findEntryPoints(directoryTree);
  const testFiles = findTestFiles(directoryTree);
  const ciFiles = findCIFiles(directoryTree);

  const projectName = (packageJson?.name as string) ?? path.basename(rootDir);

  return {
    projectName,
    rootDir,
    packageJson,
    directoryTree,
    configFiles,
    entryPoints,
    hasTests: testFiles.length > 0,
    testFiles,
    hasCI: ciFiles.length > 0,
    ciFiles,
  };
}
