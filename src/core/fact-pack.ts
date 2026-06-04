import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import type { DetectedTools, FactPack, RawScanData } from '../types/index.js';
import { fileExists, readFileSafe, readJsonSafe } from '../utils/fs.js';
import { collectProjectFacts } from './project-facts.js';

const LOCK_FILE_MAP: Record<string, string> = {
  'package-lock.json': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
};

const MAX_RISK_SCAN_FILES = 320;
const MAX_RISK_SCAN_DEPTH = 7;
const SOURCE_SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']);
const IGNORED_SCAN_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.claude',
  '.cursor',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'tmp',
  '.turbo',
]);

function normalizeEndpoint(raw: string): string {
  return raw.trim().replace(/\/+$/, '').toLowerCase();
}

function extractPackageName(importPath: string): string {
  if (importPath.startsWith('@')) {
    const [scope, name] = importPath.split('/');
    return scope && name ? `${scope}/${name}` : importPath;
  }
  return importPath.split('/')[0] ?? importPath;
}

function isBuiltinModule(importPath: string): boolean {
  const normalized = importPath.replace(/^node:/, '');
  return builtinModules.includes(normalized);
}

function detectLanguage(tree: string[]): string {
  const extCounts: Record<string, number> = {};
  for (const f of tree) {
    const ext = path.extname(f).toLowerCase();
    if (ext) extCounts[ext] = (extCounts[ext] ?? 0) + 1;
  }

  const langMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
  };

  let best = 'unknown';
  let bestCount = 0;
  for (const [ext, lang] of Object.entries(langMap)) {
    if ((extCounts[ext] ?? 0) > bestCount) {
      bestCount = extCounts[ext] ?? 0;
      best = lang;
    }
  }
  return best;
}

function detectTools(configFiles: string[], pkg: Record<string, unknown> | null): DetectedTools {
  const configs = new Set(configFiles.map((f) => path.basename(f)));
  const devDeps = (pkg?.devDependencies as Record<string, string>) ?? {};

  return {
    linter: configs.has('biome.json')
      ? 'biome'
      : configs.has('.eslintrc.json') || devDeps.eslint
        ? 'eslint'
        : null,
    formatter: configs.has('biome.json')
      ? 'biome'
      : configs.has('.prettierrc') || devDeps.prettier
        ? 'prettier'
        : null,
    bundler: findFirst(configs, devDeps, [
      ['tsup.config.ts', 'tsup'],
      ['vite.config.ts', 'vite'],
      ['webpack.config.js', 'webpack'],
      ['rollup.config.js', 'rollup'],
    ]),
    testRunner: findFirst(configs, devDeps, [
      ['vitest.config.ts', 'vitest'],
      ['jest.config.js', 'jest'],
      ['jest.config.ts', 'jest'],
    ]),
    typeChecker: configs.has('tsconfig.json') ? 'typescript' : null,
  };
}

function findFirst(
  configs: Set<string>,
  deps: Record<string, string>,
  candidates: [string, string][],
): string | null {
  for (const [file, name] of candidates) {
    if (configs.has(file) || deps[name]) return name;
  }
  return null;
}

async function detectPackageManager(rootDir: string): Promise<string> {
  for (const [file, pm] of Object.entries(LOCK_FILE_MAP)) {
    if (await fileExists(path.join(rootDir, file))) return pm;
  }
  return 'npm';
}

async function collectFilesUnderDirs(
  rootDir: string,
  directories: string[],
  maxFiles = MAX_RISK_SCAN_FILES,
  maxDepth = MAX_RISK_SCAN_DEPTH,
): Promise<string[]> {
  const queue: Array<{ dir: string; depth: number }> = [];
  for (const dir of directories) {
    queue.push({ dir: path.join(rootDir, dir), depth: 0 });
  }

  const files: string[] = [];
  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift();
    if (!current) break;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth >= maxDepth || IGNORED_SCAN_DIRS.has(entry.name)) {
          continue;
        }
        queue.push({ dir: fullPath, depth: current.depth + 1 });
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (SOURCE_SCAN_EXTENSIONS.has(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function extractEndpoints(content: string): string[] {
  const endpoints = new Set<string>();

  const quotedPathRegex = /['"`](\/[a-zA-Z0-9/_:-]+)['"`]/g;
  for (const match of content.matchAll(quotedPathRegex)) {
    const endpoint = normalizeEndpoint(match[1] ?? '');
    if (endpoint.startsWith('/auth') || endpoint.startsWith('/api')) {
      endpoints.add(endpoint);
    }
  }

  const inlinePathRegex = /\/(auth|api)\/[a-zA-Z0-9/_:-]+/g;
  for (const match of content.matchAll(inlinePathRegex)) {
    const endpoint = normalizeEndpoint(match[0] ?? '');
    if (endpoint) {
      endpoints.add(endpoint);
    }
  }

  return Array.from(endpoints);
}

async function detectApiMockCoverageGaps(rootDir: string): Promise<string[]> {
  const apiFiles = await collectFilesUnderDirs(rootDir, ['src/api', 'api']);
  const mockFiles = await collectFilesUnderDirs(rootDir, ['src/mocks', 'mocks']);

  if (apiFiles.length === 0 || mockFiles.length === 0) {
    return [];
  }

  const apiEndpoints = new Set<string>();
  for (const filePath of apiFiles) {
    const content = await readFileSafe(filePath);
    if (!content) continue;
    for (const endpoint of extractEndpoints(content)) {
      apiEndpoints.add(endpoint);
    }
  }

  const mockEndpoints = new Set<string>();
  for (const filePath of mockFiles) {
    const content = await readFileSafe(filePath);
    if (!content) continue;
    for (const endpoint of extractEndpoints(content)) {
      mockEndpoints.add(endpoint);
    }
  }

  return Array.from(apiEndpoints)
    .filter((endpoint) => !mockEndpoints.has(endpoint))
    .slice(0, 8);
}

async function detectToolingDependencyGaps(
  rootDir: string,
  pkg: Record<string, unknown> | null,
): Promise<string[]> {
  const deps = new Set([
    ...Object.keys((pkg?.dependencies as Record<string, string>) ?? {}),
    ...Object.keys((pkg?.devDependencies as Record<string, string>) ?? {}),
  ]);
  const configCandidates = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'];
  const missing = new Set<string>();

  for (const fileName of configCandidates) {
    const fullPath = path.join(rootDir, fileName);
    if (!(await fileExists(fullPath))) continue;
    const content = await readFileSafe(fullPath);
    if (!content) continue;

    const importRegex = /from\s+['"]([^'"]+)['"]/g;
    const requireRegex = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

    const imports = new Set<string>();
    for (const match of content.matchAll(importRegex)) {
      if (match[1]) imports.add(match[1]);
    }
    for (const match of content.matchAll(requireRegex)) {
      if (match[1]) imports.add(match[1]);
    }

    for (const importPath of imports) {
      if (
        importPath.startsWith('.') ||
        importPath.startsWith('/') ||
        importPath.startsWith('node:')
      ) {
        continue;
      }
      if (isBuiltinModule(importPath)) {
        continue;
      }

      const packageName = extractPackageName(importPath);
      if (!deps.has(packageName)) {
        missing.add(packageName);
      }
    }
  }

  return Array.from(missing).slice(0, 12);
}

async function detectStrictTypeScriptFlags(rootDir: string): Promise<string[]> {
  const candidates = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json'];
  const strictFlags = new Set<string>();
  const watchedFlags = [
    'strict',
    'noUnusedLocals',
    'noUnusedParameters',
    'noImplicitAny',
    'exactOptionalPropertyTypes',
    'noUncheckedIndexedAccess',
  ] as const;

  for (const fileName of candidates) {
    const fullPath = path.join(rootDir, fileName);
    const config = await readJsonSafe<Record<string, unknown>>(fullPath);
    if (!config) continue;

    const compilerOptions = (config.compilerOptions as Record<string, unknown>) ?? {};
    for (const flag of watchedFlags) {
      if (compilerOptions[flag] === true) {
        strictFlags.add(flag);
      }
    }
  }

  return Array.from(strictFlags);
}

async function detectRiskSignals(scanData: RawScanData, tokenStorageLocalStorage: boolean) {
  const apiMockCoverageGaps = await detectApiMockCoverageGaps(scanData.rootDir);
  const toolingDependencyGaps = await detectToolingDependencyGaps(
    scanData.rootDir,
    scanData.packageJson,
  );
  const strictTypeScriptFlags = await detectStrictTypeScriptFlags(scanData.rootDir);

  const notes: string[] = [];
  if (tokenStorageLocalStorage) {
    notes.push('Auth/session token appears to be persisted in localStorage.');
  }
  if (apiMockCoverageGaps.length > 0) {
    notes.push(`Detected API endpoints without mock coverage: ${apiMockCoverageGaps.join(', ')}`);
  }
  if (toolingDependencyGaps.length > 0) {
    notes.push(
      `Tooling config imports packages missing in package manifests: ${toolingDependencyGaps.join(', ')}`,
    );
  }
  if (strictTypeScriptFlags.length > 0) {
    notes.push(`Strict TypeScript compiler gates enabled: ${strictTypeScriptFlags.join(', ')}`);
  }

  return {
    tokenStorageLocalStorage,
    apiMockCoverageGaps,
    toolingDependencyGaps,
    strictTypeScriptFlags,
    notes,
  };
}

export async function buildFactPack(scanData: RawScanData): Promise<FactPack> {
  const pkg = scanData.packageJson;
  const scripts = (pkg?.scripts as Record<string, string>) ?? {};
  const deps = Object.keys((pkg?.dependencies as Record<string, string>) ?? {});
  const devDeps = Object.keys((pkg?.devDependencies as Record<string, string>) ?? {});
  const packageManager = await detectPackageManager(scanData.rootDir);
  const detectedTools = detectTools(scanData.configFiles, pkg);
  const projectFacts = await collectProjectFacts(scanData.rootDir, pkg);
  const riskSignals = await detectRiskSignals(
    scanData,
    projectFacts.tokenStorageWriteFiles.length > 0,
  );

  return {
    projectName: scanData.projectName,
    language: detectLanguage(scanData.directoryTree),
    packageManager,
    scripts,
    dependencies: deps.slice(0, 30),
    devDependencies: devDeps.slice(0, 20),
    directoryTree: scanData.directoryTree,
    detectedTools,
    entryPoints: scanData.entryPoints,
    configFiles: scanData.configFiles,
    hasTests: scanData.hasTests,
    testFramework: detectedTools.testRunner,
    hasCI: scanData.hasCI,
    ciPlatform:
      scanData.ciFiles.length > 0
        ? scanData.ciFiles[0].includes('github')
          ? 'github-actions'
          : 'gitlab-ci'
        : null,
    riskSignals,
    projectFacts,
  };
}
